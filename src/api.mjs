/**
 * 编程接口（`exports["./api"]`）。CLI 与 MCP server 都只走这一层，避免两份语义。
 *
 * 每个函数：
 *   - 自己 `createRuntime()`（路径/策略/headless 判定），
 *   - 过 `executeOperation()` 的闸门，
 *   - 返回结构化结果（错误也结构化，见 errors.mjs）。
 *
 * 幂等性（题目原则 3.3.4 / 验收 5.1.3）：所有接口可重复调用；
 * deploy 幂等由「同 (模型,后端) 一个端点 + 配置指纹比对」实现。
 */
import { createRuntime, materializePolicies } from './config.mjs'
import { executeOperation, drain, inFlightCount } from './ops.mjs'
import { deployOperation, deployKeyFor } from './deploy.mjs'
import {
  statusOperation, listEndpointsOperation, rollbackOperation, teardownOperation, reconcileOperation,
} from './lifecycle.mjs'
import { readMetrics } from './metrics.mjs'
import { verifyAuditChain, listAuditFiles } from './audit.mjs'
import { shortId, sha256 } from './util/hash.mjs'
import { getManifest } from './capability.mjs'
import { getSandboxProbe } from './sandbox.mjs'
import { probeProxy } from './netpolicy.mjs'
import { toErrorPayload } from './errors.mjs'
import { MCP_INTERFACE_VERSION, CLI_INTERFACE_VERSION, PACKAGE_VERSION } from './version.mjs'

/** 统一的运行时构造 + 一次性启动副作用（策略落盘、代理探活）。 */
async function bootstrap({ root, options = {}, env = process.env, probeNetwork = false } = {}) {
  const runtime = await createRuntime({ root, options, env })
  if (options.materializePolicies !== false) {
    runtime.materializedPolicies = await materializePolicies(runtime.paths)
  }
  if (probeNetwork) {
    runtime.proxyProbe = await probeProxy(runtime)
  }
  return runtime
}

/**
 * 确认令牌解析：`confirm` 既可以写在第一参数里，也可以写在第二参数 `options.confirm` 里。
 *
 * 踩过的坑：早期只有 deploy 读 options.confirm，rollback/teardown 只读第一参数，
 * 于是"第二次带令牌重试"的调用被静默忽略、又抛一次一模一样的 E_CONFIRMATION_REQUIRED ——
 * 调用方无从判断是令牌错了，还是令牌根本没被读到。
 * 现在所有破坏性接口统一走这里。
 */
function resolveTokens(...sources) {
  const out = []
  for (const s of sources) {
    if (typeof s === 'string' && s.length > 0) out.push(s)
    else if (Array.isArray(s)) out.push(...s.filter((t) => typeof t === 'string' && t.length > 0))
  }
  return [...new Set(out)]
}

/** 结果包装：永不抛给调用方（故障隔离，验收标准 5.1.7 / 5.4.2）。 */
function safe(fn) {
  return async (...args) => {
    try {
      return await fn(...args)
    } catch (err) {
      const payload = toErrorPayload(err)
      return { ...payload, ok: false }
    }
  }
}

/* ------------------------------------------------------------------- deploy */

export const deploy = safe(async (input, { root, options = {}, confirm = null, deepProbe = false, signal = null, onPhase = null } = {}) => {
  const runtime = await bootstrap({ root, options, probeNetwork: false })
  // 一次调用可能同时需要多道门的令牌（风险确认 + license 确认），
  // 因此 confirm 支持字符串或字符串数组，并覆盖 input.options.confirm。
  const tokens = resolveTokens(options.confirm, input?.options?.confirm, confirm)
  const raw = typeof input === 'object' && input !== null && !Array.isArray(input)
    ? { ...input, options: { ...(input.options ?? {}), confirm: tokens } }
    : { model: input, options: { confirm: tokens } }

  return executeOperation(runtime, {
    capability: 'deploy',
    resources: ['model:read', 'gpu:write', 'port:bind', 'state:write'],
    action: 'deploy',
    targetFingerprint: fingerprintOfInput(input),
    confirmTokens: tokens,
    confirmSummary: `部署 ${describeInput(input)} 为可访问的推理端点（会 bind 端口并占用 GPU）`,
  }, async ({ log }) => {
    const out = await deployOperation(runtime, { raw, log, signal, deepProbe, onPhase })
    return {
      ok: true,
      reused: out.reused === true,
      // 端点所有权凭证（F-3）：必须是**透传**，不能被 API 层投影掉。
      // （这里漏过一次：FSM 返回了 ownerToken，API 层重新拼对象时把它丢了，
      //   于是调用方拿不到凭证、下一次 teardown 被判 E_ENDPOINT_NOT_OWNED。）
      ownerToken: out.ownerToken ?? null,
      lease: out.lease ?? null,
      endpoint: out.endpoint,
      report: out.report,
      warnings: out.report.warnings,
    }
  })
})

/* ------------------------------------------------------------------- status */

export const status = safe(async ({ selector = null, verify = true, deep = false } = {}, { root, options = {} } = {}) => {
  const runtime = await bootstrap({ root, options })
  return executeOperation(runtime, {
    capability: 'status', resources: ['state:read'], action: 'status',
  }, async () => statusOperation(runtime, { selector, verify, deep }))
})

/* ------------------------------------------------------------ list_endpoints */

export const listEndpoints = safe(async ({ status: statusFilter = null } = {}, { root, options = {} } = {}) => {
  const runtime = await bootstrap({ root, options })
  return executeOperation(runtime, {
    capability: 'list_endpoints', resources: ['state:read'], action: 'list_endpoints',
  }, async () => listEndpointsOperation(runtime, { status: statusFilter }))
})

/* ----------------------------------------------------------------- rollback */

export const rollback = safe(async ({ selector, confirm = null, ownerToken = null } = {}, { root, options = {}, signal = null } = {}) => {
  const runtime = await bootstrap({ root, options })
  const tokens = resolveTokens(confirm, options.confirm)
  return executeOperation(runtime, {
    capability: 'rollback',
    resources: ['state:write', 'gpu:write', 'port:bind'],
    action: 'rollback',
    targetFingerprint: `rollback:${selector}`,
    confirmTokens: tokens,
    confirmSummary: `把端点 ${selector} 回退到上一个已验证版本（会停掉当前实例并重新起一个）`,
  }, async ({ log }) => rollbackOperation(runtime, { selector, log, signal, ownerToken }))
})

/* ----------------------------------------------------------------- teardown */

export const teardown = safe(async ({ selector, confirm = null, ownerToken = null } = {}, { root, options = {} } = {}) => {
  const runtime = await bootstrap({ root, options })
  const tokens = resolveTokens(confirm, options.confirm)
  return executeOperation(runtime, {
    capability: 'teardown',
    resources: ['gpu:write', 'port:unbind', 'state:write'],
    action: 'teardown',
    targetFingerprint: `teardown:${selector}`,
    confirmTokens: tokens,
    confirmSummary: `拆解端点 ${selector}：停止并删除容器、释放端口与显存`,
  }, async ({ log }) => teardownOperation(runtime, { selector, log, ownerToken }))
})

/* ------------------------------------------------------------------ migrate */

/**
 * 迁移适配（题目原则 3.1.7：内置在 serving 内，作为 Skill）。
 * 本机场景下"迁移"= 把 checkpoint 转换为目标后端可加载的形态。
 * 这里实现**能力探测 + 计划产出**；真正的转换由 skills/model-migration 描述，
 * 并在容器内执行（R2）。
 */
export const migrate = safe(async ({ model, target = 'nvidia-vllm' } = {}, { root, options = {}, confirm = null } = {}) => {
  const runtime = await bootstrap({ root, options })
  const tokens = resolveTokens(confirm, options.confirm)
  return executeOperation(runtime, {
    capability: 'migrate',
    resources: ['model:read', 'gpu:write', 'state:write'],
    action: 'migrate',
    targetFingerprint: `migrate:${model}:${target}`,
    confirmTokens: tokens,
    confirmSummary: `为把 ${model} 迁到 ${target} 做适配（可能写出转换后的 checkpoint）`,
  }, async ({ log }) => {
    const { planMigration } = await import('./migrate.mjs')
    return planMigration(runtime, { model, target, log })
  })
})

/* ------------------------------------------------------------------ 辅助面 */

export const metrics = safe(async ({ root, options = {} } = {}) => {
  const runtime = await bootstrap({ root, options })
  return executeOperation(runtime, {
    capability: 'status', resources: ['state:read'], action: 'metrics',
  }, async () => ({ ok: true, metrics: await readMetrics(runtime), file: runtime.paths.metricsFile }))
})

export const auditVerify = safe(async ({ date = null, root, options = {} } = {}) => {
  const runtime = await bootstrap({ root, options })
  return executeOperation(runtime, {
    capability: 'status', resources: ['state:read'], action: 'audit_verify',
  }, async () => ({
    ok: true,
    files: await listAuditFiles(runtime),
    verification: await verifyAuditChain(runtime, date ? new Date(date) : new Date()),
    auditDir: runtime.paths.auditDir,
  }))
})

/**
 * 孤儿载体对账。
 *
 * **能力随 reap 变**：只报告是只读（`status`，R0，不问）；真删是破坏性（`teardown`，R2，要确认）。
 * 早期实现无论 reap 与否都按 `teardown` 走 R2，然后用一个假的 'reconcile-report-only' 令牌
 * 想去绕过确认 —— 那个令牌永远匹配不上真实的确认键，于是"只报告"也被卡在确认上。
 * 正确的做法不是伪造令牌，而是让只读操作走只读能力。
 */
export const reconcile = safe(async ({ reap = false, root, options = {} } = {}) => {
  const runtime = await bootstrap({ root, options })
  if (!reap) {
    return executeOperation(runtime, {
      capability: 'status', resources: ['state:read'], action: 'reconcile_report',
    }, async () => reconcileOperation(runtime, { reap: false }))
  }
  return executeOperation(runtime, {
    capability: 'teardown', resources: ['gpu:write', 'port:unbind', 'state:write'], action: 'reconcile_reap',
    targetFingerprint: 'reconcile:reap',
    confirmTokens: resolveTokens(options.confirm),
    confirmSummary: '清理孤儿载体（会删除本插件管理、但注册表里没有记录的载体）',
  }, async () => reconcileOperation(runtime, { reap: true }))
})

/** 环境/能力自检（只读，无副作用，便于排障与演示）。 */
export const doctor = safe(async ({ deep = false, root, options = {} } = {}) => {
  const runtime = await bootstrap({ root, options, probeNetwork: true })
  return executeOperation(runtime, {
    capability: 'status', resources: ['state:read'], action: 'doctor',
  }, async () => {
    const { probeEnvironment } = await import('./probe/env.mjs')
    const env = await probeEnvironment(runtime, { deep })
    const sandbox = await getSandboxProbe()
    const manifest = getManifest()
    return {
      ok: true,
      version: { package: PACKAGE_VERSION, mcp: MCP_INTERFACE_VERSION, cli: CLI_INTERFACE_VERSION },
      manifest: { name: manifest.name, capabilities: [...manifest.capabilities.keys()], notProvided: [...manifest.notProvided.keys()] },
      headless: runtime.headless,
      policySources: runtime.policy.sources,
      proxyProbe: runtime.proxyProbe ?? null,
      sandbox,
      environment: {
        gpu: env.gpu.gpus,
        memory: env.memory,
        container: env.container,
        ports: env.ports,
        modelRoots: env.filesystem.modelRoots,
        capabilities: env.capability,
      },
      paths: runtime.paths,
      warnings: runtime.warnings.map((w) => (typeof w.toJSON === 'function' ? w.toJSON() : w)),
    }
  })
})

/* --------------------------------------------------------------- 内部工具 */

/**
 * 确认目标指纹 —— **必须排除记账字段**。
 *
 * 踩过的坑（集成测试真机复现）：把 `ownerToken` 加进 deploy 参数之后忘了在这里排除，
 * 于是"同一次运行内第二次 deploy 同一模型"的目标指纹变了 → 24h 内 per-class-once 的
 * 授权**复用不上** → 直接被要求重新确认（`E_CONFIRMATION_REQUIRED`）。
 * 表现形式和"参数没变却被反复问"完全一样，很难往"指纹里混进了身份字段"上想。
 *
 * 同一类错误在兄弟包（inference-quantization）里也记过一次：
 * "确认指纹：必须排除记账字段（confirm / options）"。
 *
 * 判断标准很简单：**这个字段会改变"要做什么"吗？** 不会 → 排除。
 *   owner / ownerToken / purpose / leaseMs 都是"谁在做、租多久"，不是"做什么"。
 */
const FINGERPRINT_IGNORED_FIELDS = new Set(['owner', 'ownerToken', 'purpose', 'leaseMs', 'options', 'confirm'])

function fingerprintOfInput(input) {
  let s
  if (typeof input === 'string') s = input
  else if (input && typeof input === 'object') {
    const significant = Object.fromEntries(
      Object.entries(input).filter(([k]) => !FINGERPRINT_IGNORED_FIELDS.has(k)),
    )
    s = JSON.stringify(significant)
  } else s = JSON.stringify(input ?? null)
  return `deploy:${sha256(s).slice(0, 16)}`
}

function describeInput(input) {
  if (typeof input === 'string') return input
  if (input && typeof input === 'object') return String(input.model ?? input.path ?? input.url ?? input.registry ?? input.name ?? '(未命名输入)')
  return String(input)
}

export { drain, inFlightCount, deployKeyFor, shortId }
export const INTERFACE = { MCP: MCP_INTERFACE_VERSION, CLI: CLI_INTERFACE_VERSION, PACKAGE: PACKAGE_VERSION }
