/**
 * 风险分级与用户确认（RISK_CLASSIFICATION_DRAFT.md 的可执行版本）。
 *
 * 核心不变量（来自实测验证，见 serving-step0-verification/RESULTS.md）：
 *   - 确认键必须包含**目标指纹**：同一 capability 对不同模型/环境不复用授权。
 *   - R3–R5 永不进缓存：每次都要确认。
 *   - headless 下：能拿到有效授权才做，否则**中止**（默认策略）。
 *   - 确认是显式回传的：首次调用抛 E_CONFIRMATION_REQUIRED 并给出 confirmToken，
 *     调用方带同一个 token 重试才生效。这使"确认"在审计里是一条可追溯的事实。
 */
import { promises as fs } from 'node:fs'
import { fail, ERROR_CODES } from './errors.mjs'
import { RISK, maxRisk, RISK_ORDER } from './policy-defaults.mjs'
import { withLock } from './util/lock.mjs'
import { atomicWriteJson, readText } from './util/fsx.mjs'
import { sha256, canonicalJson } from './util/hash.mjs'

/** capability 声明的 risk 字符串 → 风险档。 */
const CAP_RISK_MAP = { read: RISK.R0_READ, write: RISK.R2_MEDIUM, system: RISK.R4_SYSTEM }

export function classifyCapability(cap) {
  return CAP_RISK_MAP[cap.risk] ?? RISK.R2_MEDIUM
}

/**
 * 定档：capability 基础档 与 运行期加成档 取更严者。
 * `extraRisk` 用于生产环境标记、对外 bind 等把操作推到更高档的情形。
 */
export function classifyOperation({ cap, extraRisk = null, production = false }) {
  let risk = classifyCapability(cap)
  if (extraRisk) risk = maxRisk(risk, extraRisk)
  if (production) risk = maxRisk(risk, RISK.R5_PRODUCTION)
  return risk
}

export function confirmationMode(runtime, riskClass) {
  const c = runtime.policy.risk.confirmation ?? {}
  return c[riskClass] ?? 'always'
}

export function confirmationTtlMs(runtime) {
  const hours = runtime.policy.risk.confirmation?.ttlHours ?? 24
  return hours * 3600 * 1000
}

export function confirmationKey({ capabilityId, riskClass, targetFingerprint }) {
  const raw = `${capabilityId}|${riskClass}|${targetFingerprint ?? '*'}`
  return `cf_${sha256(raw).slice(0, 24)}`
}

async function readStore(runtime) {
  const raw = await readText(runtime.paths.confirmationsFile, null)
  if (!raw) return { version: 1, grants: {} }
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return { version: 1, grants: {} }
    return { version: parsed.version ?? 1, grants: parsed.grants ?? {} }
  } catch {
    // 损坏的确认库不能静默当作"没授权过"以外的行为 —— 当作空库并覆盖写。
    return { version: 1, grants: {}, corrupt: true }
  }
}

export async function listGrants(runtime) {
  const store = await readStore(runtime)
  return Object.entries(store.grants).map(([key, g]) => ({ key, ...g }))
}

export async function findValidGrant(runtime, key) {
  const store = await readStore(runtime)
  const g = store.grants[key]
  if (!g) return null
  if (g.expiresAt && g.expiresAt < Date.now()) return null
  return g
}

export async function grant(runtime, { key, capabilityId, riskClass, targetFingerprint, grantedBy = 'caller', persist = true }) {
  const entry = {
    capability: capabilityId,
    riskClass,
    target: targetFingerprint ?? null,
    grantedAt: Date.now(),
    expiresAt: persist ? Date.now() + confirmationTtlMs(runtime) : 0,
    grantedBy,
  }
  if (!persist) return { key, ...entry, persisted: false }
  await withLock(runtime.paths.lockDir, 'confirmations', async () => {
    const store = await readStore(runtime)
    store.grants[key] = entry
    // 清理过期项，避免文件无限增长
    const now = Date.now()
    for (const [k, v] of Object.entries(store.grants)) {
      if (v.expiresAt && v.expiresAt < now) delete store.grants[k]
    }
    await atomicWriteJson(runtime.paths.confirmationsFile, { version: 1, grants: store.grants })
  })
  return { key, ...entry, persisted: true }
}

export async function revokeGrant(runtime, key) {
  return withLock(runtime.paths.lockDir, 'confirmations', async () => {
    const store = await readStore(runtime)
    const existed = Boolean(store.grants[key])
    delete store.grants[key]
    await atomicWriteJson(runtime.paths.confirmationsFile, { version: 1, grants: store.grants })
    return existed
  })
}

/**
 * 确认闸门。通过则返回 {required, granted, reused, mode}；不通过直接抛。
 *
 * @param {object} params
 * @param {string} params.confirmToken 调用方回传的确认令牌（首次调用不传）
 */
export async function requireConfirmation(runtime, {
  capabilityId,
  riskClass,
  targetFingerprint,
  confirmToken = null,
  confirmTokens = null,
  summary = null,
}) {
  // 一次调用可能同时需要多道门（例如 R2 风险确认 + license 确认），
  // 因此令牌可以是一个数组；这里只挑属于本闸门的那一个。
  const provided = new Set(
    (Array.isArray(confirmTokens) ? confirmTokens : [confirmTokens, confirmToken])
      .filter((t) => typeof t === 'string' && t.length > 0),
  )
  const mode = confirmationMode(runtime, riskClass)
  const key = confirmationKey({ capabilityId, riskClass, targetFingerprint })

  if (mode === 'never') return { required: false, granted: false, reused: false, mode, key }

  // R3–R5：永不复用，必须每次显式确认（且不落盘持久授权以外的语义）
  const cacheable = mode === 'per-class-once'

  if (cacheable) {
    const existing = await findValidGrant(runtime, key)
    if (existing) return { required: true, granted: true, reused: true, mode, key, grant: existing }
  }

  if (provided.has(key)) {
    const g = await grant(runtime, {
      key, capabilityId, riskClass, targetFingerprint,
      grantedBy: 'explicit-confirm-token',
      persist: cacheable,
    })
    return { required: true, granted: true, reused: false, mode, key, grant: g }
  }

  if (runtime.headless) {
    fail(ERROR_CODES.E_HEADLESS_NEEDS_CONFIRMATION,
      `headless 模式下该操作需要确认而尚未授权：${capabilityId}（${riskClass}${mode === 'always' ? '，每次均需确认' : ''}）`, {
        remediation: cacheable
          ? `在交互模式下运行一次并回传 confirmToken=${key} 以在 ${runtime.policy.risk.confirmation?.ttlHours ?? 24}h 内复用，或把该操作的风险档下调（需你本人确认）。`
          : `该风险档（${riskClass}）每次都需确认，headless 下不会自动放行；请在交互模式下用 confirmToken=${key} 重试。`,
        details: { capability: capabilityId, riskClass, mode, confirmToken: key, headless: true, summary },
        capability: capabilityId,
      })
  }

  fail(ERROR_CODES.E_CONFIRMATION_REQUIRED,
    `操作需要确认：${capabilityId}（风险档 ${riskClass}，策略 ${mode}）`, {
      remediation: `确认影响后，带 options.confirm = "${key}" 重新调用即可执行${cacheable ? `（${runtime.policy.risk.confirmation?.ttlHours ?? 24}h 内同类操作不再询问）` : '（该档每次均需确认）'}。`,
      details: { capability: capabilityId, riskClass, mode, confirmToken: key, summary, targetFingerprint },
      capability: capabilityId,
    })
}

export function riskRank(riskClass) {
  return RISK_ORDER.indexOf(riskClass)
}

export { RISK }
