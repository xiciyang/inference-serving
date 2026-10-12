/**
 * 端点租约（ownership lease）—— 纯函数，便于单测。
 *
 * ## 为什么需要它（真机事故）
 *
 * `inference-serving` **按 model 给端点做键**：同一个模型路径，第二次 deploy 得到的是
 * **同一个端点对象**（新 revision、新端口），不是两个端点。而 quantization 与 tuning
 * 各自独立地从同一源路径推导 model，于是两边都以为自己"独占"这个端点。
 *
 * 集成测试在真机上把这层假设撞破了：
 *   - 我先 deploy 一个端点（自以为是 A），量化随后 deploy 同一模型 → 拿到**同一个** ep
 *   - 量化收尾时 teardown → **把我的端点拆了**
 *   - 三次 deploy 返回的 `reused` 全是 false（它说的是"revision 是否被复用"，
 *     不是"这个端点是否已有主人"）—— 调用方**拿不到任何被剥夺的信号**
 *
 * 更糟的是 `E_ENDPOINT_NOT_OWNED` 这个错误码在 tuning 里只有常量与注释，
 * **从来没有抛出点、没有测试** —— 一条宣称的硬约束，零实现。
 *
 * ## 模型：租用制（用户裁决）
 *
 * "推理侧三插件的使用模式是短期独占验证，不是长期共享。租用制最简单，冲突最容易检测。"
 *
 *   - deploy 时声明 `owner`（用途）与 `leaseMs`（租期），拿到 `ownerToken`
 *   - 租期内**同一模型只允许同一个 ownerToken 反复 deploy**（换参数 = 新 revision）
 *   - 别的 owner 想 deploy 同一模型 → `E_ENDPOINT_LEASED`（**在起容器之前**就拒）
 *   - teardown / rollback 必须出示匹配的 `ownerToken` → 否则 `E_ENDPOINT_NOT_OWNED`
 *   - 租约**过期**后允许被接管（并记一条 warning）—— 否则进程崩溃会永久锁死一个模型
 *
 * 为什么 token 与 owner 分开：`owner` 是给人看的用途标签（可重复、可猜测），
 * `ownerToken` 是不可猜测的凭证（`own_` + 128bit）。校验只认 token。
 */

import crypto from 'node:crypto'

const DEFAULT_LEASE_MS = 60 * 60 * 1000 // 1 小时：够跑完一轮量化或调优，又不至于永久占位

export { DEFAULT_LEASE_MS }

/** 生成一个不可猜测的 owner token。允许注入随机源，便于测试确定性。 */
export function newOwnerToken(randomBytes) {
  const buf = randomBytes ? Buffer.from(randomBytes) : crypto.randomBytes(16)
  return `own_${buf.toString('hex')}`
}

/** 建立一个租约记录（不写盘）。 */
export function makeLease({ owner = null, ownerToken, purpose = null, leaseMs = DEFAULT_LEASE_MS, now = Date.now() }, randomBytes) {
  const token = ownerToken ?? newOwnerToken(randomBytes)
  return {
    owner: owner ?? 'anonymous',
    ownerToken: token,
    purpose: purpose ?? owner ?? null,
    acquiredAt: new Date(now).toISOString(),
    expiresAt: new Date(now + leaseMs).toISOString(),
    expiresAtMs: now + leaseMs,
  }
}

/** 租约是否仍然有效（未过期）。 */
export function leaseActive(lease, now = Date.now()) {
  if (!lease) return false
  const t = lease.expiresAtMs ?? (lease.expiresAt ? Date.parse(lease.expiresAt) : NaN)
  if (!Number.isFinite(t)) return false
  return t > now
}

/** 对外暴露的租约视图 —— **绝不包含 ownerToken**（凭证不进 list/report）。 */
export function publicLease(lease, now = Date.now()) {
  if (!lease) return null
  return {
    owner: lease.owner ?? null,
    purpose: lease.purpose ?? null,
    acquiredAt: lease.acquiredAt ?? null,
    expiresAt: lease.expiresAt ?? null,
    active: leaseActive(lease, now),
  }
}

/**
 * 判断一个 owner 能否在**这个端点上**执行 deploy。
 * @returns {{ok:true, takeover:boolean}|{ok:false, code:string, message:string, remediation:string, details:object}}
 */
export function checkDeployAllowed({ lease, ownerToken, now = Date.now() } = {}) {
  if (!lease) return { ok: true, takeover: false }
  if (!leaseActive(lease, now)) return { ok: true, takeover: true }
  if (lease.ownerToken && ownerToken && lease.ownerToken === ownerToken) return { ok: true, takeover: false }
  return {
    ok: false,
    code: 'E_ENDPOINT_LEASED',
    message: `该模型的端点正被 "${lease.owner}" 租用中（到期 ${lease.expiresAt}），当前调用方没有匹配的 ownerToken`,
    remediation: '换一个模型路径；或等租约到期；或在同一次运行内复用同一个 ownerToken（deploy 的返回值里有）。'
      + '如果你是租用方本人，请把 deploy 返回的 ownerToken 原样回传。',
    details: { owner: lease.owner, purpose: lease.purpose ?? null, expiresAt: lease.expiresAt ?? null, active: true },
  }
}

/**
 * 判断一个调用方能否对这个端点执行 teardown / rollback。
 *
 * 规则：
 *   - 端点**没有**租约（本机制之前建的遗留端点）→ 放行，但记为 `legacy`（不假装有所有权）
 *   - 有租约 + token 匹配 → 放行
 *   - 有租约 + token 不匹配（含"根本没给"）→ `E_ENDPOINT_NOT_OWNED`
 *   - 租约已过期 → 放行并记为 `expired-takeover`（否则崩溃的进程会永久锁死模型）
 */
export function checkOwner({ lease, ownerToken, now = Date.now() } = {}) {
  if (!lease) return { ok: true, mode: 'legacy' }
  const active = leaseActive(lease, now)
  if (lease.ownerToken && ownerToken && lease.ownerToken === ownerToken) return { ok: true, mode: 'owner' }
  if (!active) return { ok: true, mode: 'expired-takeover' }
  return {
    ok: false,
    code: 'E_ENDPOINT_NOT_OWNED',
    message: `端点正被 "${lease.owner}" 租用中（到期 ${lease.expiresAt}），调用方未出示匹配的 ownerToken`,
    remediation: '只操作本次运行自己 deploy 出来的端点。若确需接管，请等租约到期，'
      + '或由该 owner 本人带着它的 ownerToken 来操作。',
    details: { owner: lease.owner, purpose: lease.purpose ?? null, expiresAt: lease.expiresAt ?? null },
  }
}
