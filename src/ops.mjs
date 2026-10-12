/**
 * 操作外壳：把「能力清单 → 风险定档 → 用户确认 → 沙箱断言 → 审计」这套前置闸门
 * 收敛到一处，避免每个操作各写一遍（写两遍就会走样）。
 *
 * 顺序是刻意的：
 *   能力 → 风险 → 沙箱可用性 → 确认 → 审计(start) → 业务 → 审计(end)
 *
 * 三条理由：
 *   1. 先查能力再问确认 —— 不该让用户为一个根本没声明的能力做确认；
 *   2. **沙箱可用性判定先于确认** —— 不该让用户确认一个本机根本执行不了的操作
 *      （例如 R3–R5 需要 VM 沙箱而本机没有）。可用性探测只跑只读诊断
 *      （docker info / which / bwrap 空跑），等价于 doctor，不产生任何副作用；
 *   3. 确认通过后才写审计并进入业务 —— 审计里"开始/结束"两行必定成对。
 */
import { assertCapability } from './capability.mjs'
import { classifyOperation, requireConfirmation, RISK } from './risk.mjs'
import { assertSandbox, requiredTier, maxTier } from './sandbox.mjs'
import { appendAudit } from './audit.mjs'
import { toErrorPayload, isServingError, fail, ERROR_CODES } from './errors.mjs'
import { updateMetrics } from './metrics.mjs'
import { shortId } from './util/hash.mjs'
import { createLogger } from './log.mjs'
import { DEFAULT_RISK_CLASSIFICATION } from './policy-defaults.mjs'

/** 在途操作计数 —— 优雅关闭时用它排空（验收标准 5.4.3）。 */
let inFlight = 0
export function inFlightCount() { return inFlight }

const drainWaiters = []
function notifyDrain() { for (const fn of drainWaiters.splice(0)) fn() }

export async function drain({ timeoutMs = 15_000 } = {}) {
  if (inFlight === 0) return { drained: true, waitedMs: 0 }
  const started = Date.now()
  // 不 unref：排空等待期间事件循环上可能只剩它（见 cleanup.mjs 顶部的说明）
  await new Promise((resolvePromise) => {
    const t = setTimeout(resolvePromise, timeoutMs)
    drainWaiters.push(() => { clearTimeout(t); resolvePromise() })
  })
  return { drained: inFlight === 0, waitedMs: Date.now() - started, remaining: inFlight }
}

/**
 * @param {object} spec
 * @param {string} spec.capability   manifest 中的 capability id
 * @param {string[]} spec.resources  本次会访问的资源（必须全部已声明）
 * @param {string} spec.action       审计里的动作名
 * @param {object} [spec.extraRisk]  运行期加成风险档
 * @param {string} [spec.targetFingerprint] 确认键的目标指纹
 */
export async function executeOperation(runtime, spec, fn) {
  const {
    capability, resources = [], action = capability,
    extraRisk = null, production = false, targetFingerprint = null,
    confirmToken = null, confirmTokens = null, confirmSummary = null, logOptions = {},
  } = spec

  const tokens = (Array.isArray(confirmTokens) ? confirmTokens : [confirmTokens, confirmToken])
    .filter((t) => typeof t === 'string' && t.length > 0)

  inFlight += 1
  const log = createLogger(runtime, { capability })
  const startedAt = Date.now()
  let cap = null
  let riskClass = RISK.R0_READ

  try {
    // 1) 能力清单
    cap = assertCapability(capability, resources)

    // 2) 风险定档
    riskClass = classifyOperation({ cap, extraRisk, production })

    // 3) 沙箱可用性：取「能力声明」与「风险档要求」中更严的一级，先判能不能做
    const required = maxTier(cap.sandbox === 'none' ? 'none' : cap.sandbox, requiredTier(runtime, riskClass))
    const sandbox = await assertSandbox(runtime, required, { grant: spec.sandboxGrant ?? null })
    if (sandbox.tier === 'none' && required !== 'none') {
      await updateMetrics(runtime, (m) => { m.counters.sandbox_refusals += 1 })
    }

    // 4) 确认闸门（此时已知本机确实能做，问得有价值）
    const confirmation = await requireConfirmation(runtime, {
      capabilityId: capability, riskClass, targetFingerprint, confirmTokens: tokens,
      summary: confirmSummary,
    })
    if (confirmation.granted && !confirmation.reused) {
      await updateMetrics(runtime, (m) => { m.counters.confirmations_granted += 1 })
    }

    // 5) 审计开始
    const auditId = `aud_${shortId(`${capability}-${Date.now()}-${Math.random()}`, 12)}`
    log.auditId = auditId
    const auditStart = await appendAudit(runtime, {
      auditId, capability, action, phase: 'start',
      riskClass, sandboxTier: sandbox.tier, sandboxEnforced: sandbox.enforced,
      resources, targetFingerprint,
      confirmation: { required: confirmation.required, granted: confirmation.granted, reused: confirmation.reused, mode: confirmation.mode },
      headless: runtime.headless,
      policySources: runtime.policy.sources,
    })

    // 6) 业务
    let result
    try {
      result = await fn({ log, auditId, sandbox, riskClass, cap, runtime })
    } catch (err) {
      const payload = toErrorPayload(err, { capability })
      await appendAudit(runtime, {
        auditId, capability, action, phase: 'error',
        riskClass, sandboxTier: sandbox.tier,
        outcome: 'error', code: payload.code, message: payload.message,
        durationMs: Date.now() - startedAt,
        details: sanitizeDetails(payload.details),
      }).catch(() => {})
      await updateMetrics(runtime, (m) => { m.counters.tool_errors += 1 })
      await log.flush()
      throw err
    }

    await appendAudit(runtime, {
      auditId, capability, action, phase: 'end',
      riskClass, sandboxTier: sandbox.tier,
      outcome: 'ok', durationMs: Date.now() - startedAt,
      result: sanitizeResult(result),
    })
    await updateMetrics(runtime, (m) => { m.counters.tool_calls += 1 })
    await log.flush()

    return {
      ...result,
      auditId,
      auditSeq: auditStart.seq,
      riskClass,
      sandboxTier: sandbox.tier,
      warnings: dedupeWarnings([...(result?.warnings ?? []), ...runtime.warnings.map((w) => (typeof w.toJSON === 'function' ? w.toJSON() : w))]),
    }
  } catch (err) {
    // 闸门本身失败（能力/确认/沙箱）也要留痕 —— 这类"被拒绝的尝试"是安全审计最关心的
    if (!isServingError(err) || !err.__audited) {
      const payload = toErrorPayload(err, { capability })
      try {
        await appendAudit(runtime, {
          auditId: `aud_${shortId(`${capability}-gate-${Date.now()}`, 12)}`,
          capability, action, phase: 'denied',
          riskClass, outcome: 'denied', code: payload.code, message: payload.message,
          durationMs: Date.now() - startedAt,
          headless: runtime.headless,
        })
      } catch { /* 审计失败不应掩盖原始错误 */ }
    }
    await log.flush()
    throw err
  } finally {
    inFlight -= 1
    if (inFlight === 0) notifyDrain()
  }
}

function dedupeWarnings(list) {
  const seen = new Set()
  const out = []
  for (const w of list) {
    if (!w) continue
    const k = `${w.code}|${w.message}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push(w)
  }
  return out
}

/** 审计里的 details 必须可 JSON 序列化且不巨大。 */
function sanitizeDetails(details) {
  if (!details) return null
  try {
    const s = JSON.stringify(details)
    if (s.length <= 4000) return JSON.parse(s)
    return { truncated: true, preview: s.slice(0, 2000) }
  } catch {
    return { unserializable: true }
  }
}

function sanitizeResult(result) {
  if (!result || typeof result !== 'object') return null
  const pick = {}
  for (const k of ['ok', 'reused', 'count', 'endpoint', 'rolledBackTo', 'verification', 'clean']) {
    if (result[k] !== undefined) pick[k] = result[k]
  }
  return sanitizeDetails(pick)
}

export { RISK, DEFAULT_RISK_CLASSIFICATION, fail, ERROR_CODES }
