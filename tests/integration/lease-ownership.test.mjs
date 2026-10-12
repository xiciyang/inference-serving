/**
 * 端点所有权（F-3 租用制）的集成测试 —— **必须有抛出点、必须有测试**。
 *
 * 背景（集成测试真机实测）：`E_ENDPOINT_NOT_OWNED` 此前只是 tuning 里的一个常量与
 * 注释，**从未被抛出过、从未被测试过** —— 一条宣称的硬约束，零实现。而 serving 按
 * `model` 给端点做键，于是量化收尾时把调优正在用的端点一起拆掉了。
 *
 * 本文件验四件事：
 *   1. 别的 owner 想 deploy 同一模型 → `E_ENDPOINT_LEASED`（**在起容器之前**就拒）
 *   2. 没有 token 的 teardown / rollback → `E_ENDPOINT_NOT_OWNED`
 *   3. 拿对 token 才能拆；租约过期可接管（否则崩溃的进程会永久锁死一个模型）
 *   4. 幂等续租：同一次运行内同 token 反复 deploy 落在同一端点的新 revision 上
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeSandbox } from '../helpers/sandbox.mjs'
import { processDriver } from '../helpers/process-driver.mjs'
import { createRuntime } from '../../src/config.mjs'
import { deployOperation } from '../../src/deploy.mjs'
import { teardownOperation, rollbackOperation, listEndpointsOperation } from '../../src/lifecycle.mjs'
import { withRegistry } from '../../src/state/registry.mjs'
import { ERROR_CODES } from '../../src/errors.mjs'

async function setup() {
  const sb = await makeSandbox()
  const runtime = await createRuntime({ root: sb.root, options: { ...sb.options, healthTimeoutMs: 20_000, healthPollIntervalMs: 150, deployTimeoutMs: 30_000 } })
  return { sb, runtime }
}

const raw = (sb, extra = {}) => ({ model: sb.modelPath, backend: 'fake-http', ...extra })
const deploy = (sb, runtime, extra = {}) => deployOperation(runtime, { raw: raw(sb, extra) })

test('租约: 别的 owner 部署同一模型 → E_ENDPOINT_LEASED，且**不起容器**', async () => {
  const { sb, runtime } = await setup()
  try {
    const a = await deploy(sb, runtime, { owner: 'inference-tuning' })
    assert.equal(a.ok, true)
    assert.match(a.ownerToken, /^own_/)

    const before = (await processDriver.listManaged()).instances.length

    const b = await deploy(sb, runtime, { owner: 'inference-quantization' }).catch((e) => e)
    assert.ok(b instanceof Error, '别的 owner 不该拿到端点')
    assert.equal(b.code, ERROR_CODES.E_ENDPOINT_LEASED)
    assert.equal(b.details.owner, 'inference-tuning')

    // **在起容器之前**就拒 —— 否则等于用一次真机部署换一条错误信息
    const after = (await processDriver.listManaged()).instances.length
    assert.equal(after, before, '被租约拒绝时不得新起任何载体')
  } finally {
    await processDriver.stopAll()
    await sb.cleanup()
  }
})

test('租约: 同 token 续租 → 落在同一端点的新 revision（不复用则拒绝）', async () => {
  const { sb, runtime } = await setup()
  try {
    const a = await deploy(sb, runtime, { owner: 'inference-tuning' })
    const b = await deploy(sb, runtime, { owner: 'inference-tuning', ownerToken: a.ownerToken, maxModelLen: 2048 })
    assert.equal(b.ok, true)
    assert.equal(b.endpoint.id, a.endpoint.id, '同一模型 + 同一 token → 同一端点')
    assert.ok(b.endpoint.revision > a.endpoint.revision, '应当是同一个端点的新 revision')

    // 不带 token 的第三次 → 被拒（它不再是"同一次运行"）
    const c = await deploy(sb, runtime, { owner: 'inference-tuning' }).catch((e) => e)
    assert.equal(c.code, ERROR_CODES.E_ENDPOINT_LEASED)
  } finally {
    await processDriver.stopAll()
    await sb.cleanup()
  }
})

test('租约: 没有 ownerToken 的 teardown → E_ENDPOINT_NOT_OWNED（这条闸以前不存在）', async () => {
  const { sb, runtime } = await setup()
  try {
    const a = await deploy(sb, runtime, { owner: 'inference-quantization' })

    const bad = await teardownOperation(runtime, { selector: a.endpoint.id }).catch((e) => e)
    assert.ok(bad instanceof Error, '不带凭证不该拆得掉别人的端点')
    assert.equal(bad.code, ERROR_CODES.E_ENDPOINT_NOT_OWNED)
    assert.equal(bad.details.owner, 'inference-quantization')

    // 拿错 token 同样拒
    const wrong = await teardownOperation(runtime, { selector: a.endpoint.id, ownerToken: 'own_deadbeef' }).catch((e) => e)
    assert.equal(wrong.code, ERROR_CODES.E_ENDPOINT_NOT_OWNED)

    // 端点必须还活着（被拒绝的拆解不能有副作用）
    const listed = await listEndpointsOperation(runtime, {})
    const ep = listed.endpoints.find((e) => e.id === a.endpoint.id)
    assert.equal(ep.status, 'serving', '被拒绝的 teardown 不得改变端点状态')

    // 带对 token → 拆得掉
    const ok = await teardownOperation(runtime, { selector: a.endpoint.id, ownerToken: a.ownerToken })
    assert.equal(ok.ok, true)
  } finally {
    await processDriver.stopAll()
    await sb.cleanup()
  }
})

test('租约: 没有 ownerToken 的 rollback → E_ENDPOINT_NOT_OWNED（回退也是就地变更）', async () => {
  const { sb, runtime } = await setup()
  try {
    const a = await deploy(sb, runtime, { owner: 'inference-tuning' })
    await deploy(sb, runtime, { owner: 'inference-tuning', ownerToken: a.ownerToken, maxModelLen: 2048 })

    const bad = await rollbackOperation(runtime, { selector: a.endpoint.id }).catch((e) => e)
    assert.equal(bad.code, ERROR_CODES.E_ENDPOINT_NOT_OWNED)

    const ok = await rollbackOperation(runtime, { selector: a.endpoint.id, ownerToken: a.ownerToken })
    assert.equal(ok.ok, true)
    assert.ok(ok.rolledBackTo >= 1, '回退目标 revision 必须落在返回值里（可追溯）')
  } finally {
    await processDriver.stopAll()
    await sb.cleanup()
  }
})

test('租约: 过期后可被接管（否则崩溃的进程会永久锁死一个模型）', async () => {
  const { sb, runtime } = await setup()
  try {
    const a = await deploy(sb, runtime, { owner: 'inference-tuning' })

    // 把租约改成已过期（模拟上一个进程崩溃后再没人来收）
    await withRegistry(runtime, (reg) => {
      const ep = reg.endpoints.find((e) => e.id === a.endpoint.id)
      ep.lease.expiresAtMs = Date.now() - 1000
      ep.lease.expiresAt = new Date(Date.now() - 1000).toISOString()
      return null
    })

    const b = await deploy(sb, runtime, { owner: 'inference-quantization' })
    assert.equal(b.ok, true, '过期租约必须允许接管')
    assert.equal(b.ownerToken === a.ownerToken, false, '接管方拿到的是新凭证')
    // 接管要留下可追溯的 warning
    assert.ok((b.report?.warnings ?? []).some((w) => w.code === 'W_ENDPOINT_LEASE_TAKEOVER'),
      '接管过期租约必须记 warning')
  } finally {
    await processDriver.stopAll()
    await sb.cleanup()
  }
})

test('租约: 对外视图里有 owner/到期时间，但**绝不泄漏 ownerToken**', async () => {
  const { sb, runtime } = await setup()
  try {
    const a = await deploy(sb, runtime, { owner: 'inference-quantization', purpose: 'phase-1-verify' })
    const listed = await listEndpointsOperation(runtime, {})
    const ep = listed.endpoints.find((e) => e.id === a.endpoint.id)
    assert.ok(ep.lease, 'list_endpoints 应暴露租约的公开视图')
    assert.equal(ep.lease.owner, 'inference-quantization')
    assert.equal(ep.lease.purpose, 'phase-1-verify')
    assert.equal(ep.lease.active, true)
    assert.ok(ep.lease.expiresAt)
    // 凭证不进任何对外视图
    assert.equal(Object.prototype.hasOwnProperty.call(ep.lease, 'ownerToken'), false)
    assert.equal(JSON.stringify(listed).includes(a.ownerToken), false, 'ownerToken 不得出现在 list 输出里')
  } finally {
    await processDriver.stopAll()
    await sb.cleanup()
  }
})

test('租约: teardown 必须**释放**租约（否则幽灵租约会挡住后续部署）', async () => {
  const { sb, runtime } = await setup()
  try {
    const a = await deploy(sb, runtime, { owner: 'inference-tuning' })
    await teardownOperation(runtime, { selector: a.endpoint.id, ownerToken: a.ownerToken })

    const listed = await listEndpointsOperation(runtime, {})
    const ep = listed.endpoints.find((e) => e.id === a.endpoint.id)
    assert.equal(ep.status, 'torn_down')
    assert.equal(ep.lease, null, '拆解后必须释放租约')

    // 关键回归：换一个 owner 重新部署同一模型必须**能成功**
    // （真机踩到的正是这条：拆完之后新的 owner 被一条属于幽灵端点的租约挡了 1 小时）
    const b = await deploy(sb, runtime, { owner: 'inference-quantization' })
    assert.equal(b.ok, true, '拆解后别的 owner 必须能重新租用同一模型')
  } finally {
    await processDriver.stopAll()
    await sb.cleanup()
  }
})

test('租约: 幂等 teardown 也会清掉历史残留的租约', async () => {
  const { sb, runtime } = await setup()
  try {
    const a = await deploy(sb, runtime, { owner: 'inference-tuning' })
    // 模拟"老版本拆解后留下的幽灵租约"：端点是 torn_down，但租约还在
    await withRegistry(runtime, (reg) => {
      const ep = reg.endpoints.find((e) => e.id === a.endpoint.id)
      ep.status = 'torn_down'
      for (const r of ep.revisions ?? []) r.status = 'torn_down'
      return null
    })
    const again = await teardownOperation(runtime, { selector: a.endpoint.id })
    assert.equal(again.alreadyTornDown, true)
    const listed = await listEndpointsOperation(runtime, {})
    assert.equal(listed.endpoints.find((e) => e.id === a.endpoint.id).lease, null, '幂等路径也要清掉残留租约')
  } finally {
    await processDriver.stopAll()
    await sb.cleanup()
  }
})
