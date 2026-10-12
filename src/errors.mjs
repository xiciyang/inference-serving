/**
 * 稳定错误码表 + 结构化错误类型。
 *
 * 设计要点（对应验收标准 5.2.5「错误信息可操作，指出具体问题和修正方式」）：
 *   每个错误码都必须带 remediation —— 不是"出了错"，而是"出了什么错、怎么修"。
 *   错误码是接口的一部分：一旦发布即冻结，破坏性变更升 MCP major（题目原则 3.1.5）。
 */

export const ERROR_CODES = Object.freeze({
  // --- 输入处理（7 类输入场景）---
  E_INPUT_INVALID: 'E_INPUT_INVALID',
  E_INPUT_CONFLICT: 'E_INPUT_CONFLICT',
  E_INPUT_AMBIGUOUS: 'E_INPUT_AMBIGUOUS',
  E_INPUT_MISSING: 'E_INPUT_MISSING',
  E_MODEL_UNRESOLVED: 'E_MODEL_UNRESOLVED',
  E_LICENSE_UNRESOLVED: 'E_LICENSE_UNRESOLVED',

  // --- 权限与能力清单 ---
  E_CAPABILITY_DENIED: 'E_CAPABILITY_DENIED',
  E_RESOURCE_NOT_DECLARED: 'E_RESOURCE_NOT_DECLARED',

  // --- 沙箱 ---
  E_SANDBOX_UNAVAILABLE: 'E_SANDBOX_UNAVAILABLE',
  E_SANDBOX_PROBE_FAILED: 'E_SANDBOX_PROBE_FAILED',
  E_HOST_SANDBOX_MISMATCH: 'E_HOST_SANDBOX_MISMATCH',

  // --- 确认与交互 ---
  E_CONFIRMATION_REQUIRED: 'E_CONFIRMATION_REQUIRED',
  E_HEADLESS_NEEDS_CONFIRMATION: 'E_HEADLESS_NEEDS_CONFIRMATION',

  // --- 网络出口 ---
  E_EGRESS_DENIED: 'E_EGRESS_DENIED',

  // --- 部署与降级 ---
  E_BACKEND_UNKNOWN: 'E_BACKEND_UNKNOWN',
  E_BACKEND_UNAVAILABLE: 'E_BACKEND_UNAVAILABLE',
  E_PORT_UNAVAILABLE: 'E_PORT_UNAVAILABLE',
  E_INSUFFICIENT_MEMORY: 'E_INSUFFICIENT_MEMORY',
  E_MEMORY_CONFIG_INFEASIBLE: 'E_MEMORY_CONFIG_INFEASIBLE',
  E_DEPLOY_FAILED: 'E_DEPLOY_FAILED',
  E_DEPLOY_TIMEOUT: 'E_DEPLOY_TIMEOUT',
  E_DEGRADE_EXHAUSTED: 'E_DEGRADE_EXHAUSTED',
  E_HEALTH_FAILED: 'E_HEALTH_FAILED',
  /**
   * 端点的 HTTP 层起来了，但**模型没有真正参与前向**（输出为均匀分布）。
   *
   * 为什么单独一个码：`E_HEALTH_FAILED` 是"没起来"，这个码是"起来了但不可用"。
   * 二者对调用方的含义完全不同 —— 后者会让调用方拿着 `ok: true` 去跑一整套
   * 量化/调优，几百秒后才发现模型是坏的（本项目真实事故：436 s 白跑）。
   * 换配置解决不了，因此**不可降级**（见 degrade.mjs 的 TERMINAL_FAILURES）。
   */
  E_MODEL_NOT_READY: 'E_MODEL_NOT_READY',
  E_CANCELLED: 'E_CANCELLED',

  // --- 状态与生命周期 ---
  /**
   * 端点所有权（F-3 租用制）。二者必须分开：
   *   E_ENDPOINT_LEASED      —— deploy 时发现同模型端点被**别人**租着（在起容器之前就拒）
   *   E_ENDPOINT_NOT_OWNED   —— teardown/rollback 时拿不出匹配的 ownerToken
   * 集成测试之前，`E_ENDPOINT_NOT_OWNED` 在 tuning 里只有常量与注释、**没有抛出点**；
   * 现在 serving 侧真正实现了它。
   */
  E_ENDPOINT_LEASED: 'E_ENDPOINT_LEASED',
  E_ENDPOINT_NOT_OWNED: 'E_ENDPOINT_NOT_OWNED',
  E_STATE_CONFLICT: 'E_STATE_CONFLICT',
  E_ENDPOINT_NOT_FOUND: 'E_ENDPOINT_NOT_FOUND',
  E_NO_ROLLBACK_TARGET: 'E_NO_ROLLBACK_TARGET',
  E_TEARDOWN_FAILED: 'E_TEARDOWN_FAILED',
  E_CLEANUP_INCOMPLETE: 'E_CLEANUP_INCOMPLETE',

  // --- 内部 ---
  E_INTERNAL: 'E_INTERNAL',
})

export const WARNING_CODES = Object.freeze({
  W_PROXY_DEAD: 'W_PROXY_DEAD',
  W_ASSUMPTION_FILLED: 'W_ASSUMPTION_FILLED',
  W_POLICY_DEFAULTED: 'W_POLICY_DEFAULTED',
  W_AMBIGUITY_RESOLVED: 'W_AMBIGUITY_RESOLVED',
  W_SYMLINK_MODEL_ROOT: 'W_SYMLINK_MODEL_ROOT',
  W_VM_SANDBOX_ABSENT: 'W_VM_SANDBOX_ABSENT',
  W_RESIDUAL_CLEANUP: 'W_RESIDUAL_CLEANUP',
  W_HIGH_MEMORY_REQUEST_ON_UNIFIED: 'W_HIGH_MEMORY_REQUEST_ON_UNIFIED',
  W_IMAGE_PROBE_FALLBACK: 'W_IMAGE_PROBE_FALLBACK',
  W_ENDPOINT_LEASE_TAKEOVER: 'W_ENDPOINT_LEASE_TAKEOVER',
})

/** 结构化错误。`code` 取自 ERROR_CODES，`remediation` 必须可操作。 */
export class ServingError extends Error {
  constructor(code, message, { remediation, details, cause, retriable = false, capability } = {}) {
    super(message, cause ? { cause } : undefined)
    this.name = 'ServingError'
    this.code = code
    this.remediation = remediation ?? null
    this.details = details ?? null
    this.retriable = retriable
    this.capability = capability ?? null
  }

  toJSON() {
    return {
      ok: false,
      code: this.code,
      message: this.message,
      remediation: this.remediation,
      details: this.details,
      retriable: this.retriable,
    }
  }
}

/** 构造并抛出。`fail(code, msg, opts)`。 */
export function fail(code, message, opts) {
  throw new ServingError(code, message, opts)
}

export function isServingError(e) {
  return e instanceof ServingError
}

/** 把任意异常规范化为可序列化载荷 —— 保证故障隔离：调用方永远拿到结构化结果。 */
export function toErrorPayload(err, { capability } = {}) {
  if (isServingError(err)) {
    const p = err.toJSON()
    if (capability && !p.capability) p.capability = capability
    return p
  }
  return {
    ok: false,
    code: ERROR_CODES.E_INTERNAL,
    message: err && err.message ? String(err.message) : String(err),
    remediation: '这是未预期的内部错误；请附上 code 与本次调用的 auditId 提交问题。',
    details: err && err.stack ? { stack: String(err.stack).split('\n').slice(0, 8) } : null,
    retriable: false,
    capability: capability ?? null,
  }
}

/** 带 code 的警告（非致命），用于把自动决策记录进报告。 */
export class ServingWarning {
  constructor(code, message, details) {
    this.code = code
    this.message = message
    this.details = details ?? null
  }

  toJSON() {
    return { code: this.code, message: this.message, details: this.details }
  }
}

export function warn(code, message, details) {
  return new ServingWarning(code, message, details)
}
