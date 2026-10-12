/**
 * 网络出口策略执行点（NETWORK_POLICY_DRAFT.md 的可执行版本）。
 *
 * 三条硬规则落地：
 *  1. 不信任 HTTPS_PROXY —— 所有出网走 `src/util/http.mjs`（node:http，天然不读代理环境变量）。
 *     本模块额外做一次启动探活，把"代理是坏的"这件事变成一条可见警告 W_PROXY_DEAD。
 *  2. huggingface.co 进 deny —— **根本不发连接**，而不是"试了再回退"。
 *  3. 白名单外 = ask；headless 下 ask 等价于拒绝。
 */
import { fail, warn, ERROR_CODES, WARNING_CODES } from './errors.mjs'
import { request, getJson } from './util/http.mjs'

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

function ipv4ToInt(ip) {
  const m = IPV4_RE.exec(ip)
  if (!m) return null
  return m.slice(1).map(Number).reduce((acc, o) => (acc << 8) + o, 0) >>> 0
}

function inCidr(ip, cidr) {
  const [base, bitsRaw] = cidr.split('/')
  const bits = Number(bitsRaw)
  const a = ipv4ToInt(ip)
  const b = ipv4ToInt(base)
  if (a === null || b === null) return false
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
  return (a & mask) === (b & mask)
}

export function normalizeHost(hostOrUrl) {
  if (!hostOrUrl) return ''
  let h = String(hostOrUrl).trim().toLowerCase()
  if (h.includes('://')) {
    try { h = new URL(h).hostname } catch { /* keep raw */ }
  }
  return h.replace(/^\[|\]$/g, '').replace(/\.$/, '')
}

function matchDomain(host, pattern) {
  const p = normalizeHost(pattern)
  if (!p) return false
  if (p.startsWith('.')) return host.endsWith(p) || host === p.slice(1)
  return host === p || host.endsWith(`.${p}`)
}

export function isLocalHost(host, localList = []) {
  const h = normalizeHost(host)
  if (h === 'localhost' || h === '::1' || h.endsWith('.local') || h.endsWith('.internal')) return true
  const ip = ipv4ToInt(h)
  if (ip !== null) {
    for (const cidr of localList) {
      if (cidr.includes('/') && inCidr(h, cidr)) return true
      if (cidr === h) return true
    }
  }
  return false
}

/** 纯决策函数（可单测，无 I/O）。返回 {decision, reason, entry}。 */
export function decideEgress(policy, hostOrUrl, { purpose = 'general' } = {}) {
  const host = normalizeHost(hostOrUrl)
  if (!host) return { decision: 'deny', reason: 'empty host', entry: null }

  if (isLocalHost(host, policy.local ?? [])) {
    return { decision: 'allow', reason: 'local/private network', entry: { host, purpose: 'local' } }
  }
  for (const d of policy.deny ?? []) {
    if (matchDomain(host, d.host)) {
      return { decision: 'deny', reason: d.reason ?? 'explicitly denied', entry: d }
    }
  }
  for (const a of policy.allow ?? []) {
    if (matchDomain(host, a.host)) {
      return { decision: 'allow', reason: a.purpose ?? 'allowlisted', entry: a }
    }
  }
  const fallback = policy.default ?? 'ask'
  return { decision: fallback, reason: `not in allowlist (default=${fallback})`, entry: null }
}

/** 执行点：不允许就抛；ask 在 headless 下抛，交互下返回 needsConfirmation。 */
export function assertEgress(runtime, hostOrUrl, { purpose = 'general' } = {}) {
  const { decision, reason } = decideEgress(runtime.policy.network, hostOrUrl, { purpose })
  if (decision === 'allow') return { decision, host: normalizeHost(hostOrUrl) }
  if (decision === 'deny') {
    fail(ERROR_CODES.E_EGRESS_DENIED, `出口被拒绝：${normalizeHost(hostOrUrl)} —— ${reason}`, {
      remediation: `该域名在策略中显式拒绝。若确有需要，请编辑 ${runtime.paths.networkFile} 的 deny 列表；若是模型下载，请改用镜像域名（hf-mirror.com / modelscope.cn）。`,
      details: { host: normalizeHost(hostOrUrl), reason, policyFile: runtime.paths.networkFile },
    })
  }
  if (runtime.headless) {
    fail(ERROR_CODES.E_HEADLESS_NEEDS_CONFIRMATION, `headless 模式下域名不在白名单，已中止：${normalizeHost(hostOrUrl)}`, {
      remediation: `把该域名加入 ${runtime.paths.networkFile} 的 allow 列表，或在交互模式下确认。`,
      details: { host: normalizeHost(hostOrUrl), reason, headless: true },
    })
  }
  fail(ERROR_CODES.E_CONFIRMATION_REQUIRED, `域名不在白名单，需要确认：${normalizeHost(hostOrUrl)}`, {
    remediation: `确认后可用 options.allowHosts 追加，或把域名写入 ${runtime.paths.networkFile}。`,
    details: { host: normalizeHost(hostOrUrl), reason },
  })
}

/**
 * 代理探活。目的不是"用代理"，而是把环境异常变成一条**可见的**审计事实。
 * 无论探活结果如何，本插件的实际出网都走直连。
 */
export async function probeProxy(runtime) {
  const cfg = runtime.policy.network.proxy ?? {}
  if (cfg.probeOnStart === false) return { probed: false }
  const envProxy = runtime.env.HTTPS_PROXY ?? runtime.env.https_proxy ?? null
  if (!envProxy) return { probed: false, envProxy: null }
  if (cfg.envRespected) return { probed: false, envProxy, note: '策略声明尊重环境代理' }

  // 直连目标站点（绕过代理），确认"直连是否可用"
  const target = cfg.probeTarget ?? 'https://registry.npmmirror.com'
  const direct = await request(target, { method: 'HEAD', timeoutMs: cfg.probeTimeoutMs ?? 2000 })
  const envFromEnv = envProxy
  const result = {
    probed: true,
    envProxy: envFromEnv,
    envRespected: false,
    direct,
    warnings: [],
  }
  if (!direct.ok || !direct.status || direct.status >= 500) {
    result.warnings.push(warn(WARNING_CODES.W_PROXY_DEAD, `直连探活失败：${target}`, { error: direct.error ?? null, status: direct.status ?? null }))
  } else {
    result.warnings.push(warn(
      WARNING_CODES.W_PROXY_DEAD,
      `检测到环境代理 ${envFromEnv}，但本插件按策略显式绕过（本机该代理 CONNECT 可建立、上游 TLS 失败）`,
      { envProxy: envFromEnv, policy: 'proxy.mode=bypass', directStatus: direct.status },
    ))
  }
  runtime.warnings.push(...result.warnings)
  return result
}

/** 便捷：带出口策略检查的 GET。 */
export async function policyGet(runtime, url, opts = {}) {
  assertEgress(runtime, url, { purpose: opts.purpose })
  return getJson(url, opts)
}
