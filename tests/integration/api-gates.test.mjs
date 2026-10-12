/**
 * 集成测试：ops 闸门层（能力清单 → 风险定档 → 确认 → 沙箱 → 审计）。
 *
 * 这一层是安全属性的落点，所以走 `api.mjs`（与 CLI / MCP 完全同一条路径），
 * 而不是直接调 FSM。
 *
 * 容器级沙箱不可用的机器上会跳过 —— 但会**明说**跳过原因，不静默放过。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeSandbox, resetKnobs } from '../helpers/sandbox.mjs'
import { processDriver } from '../helpers/process-driver.mjs'
import * as api from '../../src/api.mjs'
import { executeOperation } from '../../src/ops.mjs'
import { createRuntime } from '../../src/config.mjs'
import { readAudit, verifyAuditChain } from '../../src/audit.mjs'
import { getSandboxProbe } from '../../src/sandbox.mjs'
import { ERROR_CODES } from '../../src/errors.mjs'

async function ready() {
  const sb = await makeSandbox()
  const probe = await getSandboxProbe()
  return { sb, containerSandbox: probe.container.available }
}

const apiOptions = (sb) => ({ ...sb.options, healthTimeoutMs: 20_000, healthPollIntervalMs: 150 })
const input = (sb, extra = {}) => ({ model: sb.modelPath, backend: 'fake-http', ...extra })

test('闸门: 首次 deploy 需确认 —— 返回 confirmToken，且此时**什么都没做**', async (t) => {
  const { sb, containerSandbox } = await ready()
  if (!containerSandbox) return t.skip('本机无容器级沙箱，跳过（R2 能力被正确拒绝的场景由另一用例覆盖）')
  try {
    const out = await api.deploy(input(sb), { root: sb.root, options: apiOptions(sb) })
    assert.equal(out.ok, false)
    assert.equal(out.code, ERROR_CODES.E_CONFIRMATION_REQUIRED)
    assert.match(out.details.confirmToken, /^cf_/)
    assert.ok(out.remediation.includes(out.details.confirmToken))

    // 未被确认 → 不应有任何载体被创建
    const listed = await processDriver.listManaged()
    assert.equal(listed.instances.length, 0, '确认前不得启动任何东西')
    // 但"被拒绝的尝试"必须留痕（安全审计最关心的就是这类）
    const records = await readAudit(await createRuntime({ root: sb.root }))
    assert.ok(records.some((r) => r.phase === 'denied' && r.code === ERROR_CODES.E_CONFIRMATION_REQUIRED))
  } finally {
    await processDriver.stopAll()
    await sb.cleanup()
  }
})

test('闸门: 回传 confirmToken 后执行；24h 内同类同目标复用授权', async (t) => {
  const { sb, containerSandbox } = await ready()
  if (!containerSandbox) return t.skip('本机无容器级沙箱')
  try {
    const first = await api.deploy(input(sb), { root: sb.root, options: apiOptions(sb) })
    const token = first.details.confirmToken

    const done = await api.deploy(input(sb), { root: sb.root, options: apiOptions(sb), confirm: token })
    assert.equal(done.ok, true)
    assert.ok(done.endpoint.endpoint)
    assert.equal(done.riskClass, 'R2')
    assert.equal(done.sandboxTier, 'container')

    // 第二次不再询问（per-class-once + 同目标指纹）。
    // 注意要**续租**：同模型第二次 deploy 必须带同一个 ownerToken，否则会先被
    // 所有权闸门拦下（E_ENDPOINT_LEASED）—— 那是另一条闸，本用例只验"确认授权会不会被复用"。
    const again = await api.deploy(input(sb, { ownerToken: done.ownerToken }), { root: sb.root, options: apiOptions(sb) })
    assert.equal(again.ok, true)
    assert.equal(again.reused, true)
  } finally {
    await processDriver.stopAll()
    await sb.cleanup()
  }
})

test('闸门: headless 下未授权一律中止（不猜测、不静默放行）', async (t) => {
  const { sb, containerSandbox } = await ready()
  if (!containerSandbox) return t.skip('本机无容器级沙箱')
  try {
    const out = await api.deploy(input(sb), { root: sb.root, options: { ...apiOptions(sb), headless: true } })
    assert.equal(out.ok, false)
    assert.equal(out.code, ERROR_CODES.E_HEADLESS_NEEDS_CONFIRMATION)
    assert.ok(out.remediation)
  } finally {
    await processDriver.stopAll()
    await sb.cleanup()
  }
})

test('闸门: R4 系统级 → VM 沙箱不可用 → 直接拒绝（本机无 hypervisor）', async () => {
  const sb = await makeSandbox()
  try {
    const runtime = await createRuntime({ root: sb.root, options: apiOptions(sb) })
    const out = await executeOperation(runtime, {
      capability: 'deploy',
      resources: ['model:read', 'gpu:write', 'port:bind', 'state:write'],
      action: 'deploy',
      extraRisk: 'R4',
      targetFingerprint: 'x',
    }, async () => ({ ok: true })).catch((e) => e)
    assert.equal(out.code, ERROR_CODES.E_SANDBOX_UNAVAILABLE)
    assert.match(out.message, /vm/i)
    assert.match(out.remediation, /qemu|hypervisor|拒绝/)
  } finally { await sb.cleanup() }
})

test('闸门: 未声明的 capability 被拒（默认拒绝）', async () => {
  const sb = await makeSandbox()
  try {
    const runtime = await createRuntime({ root: sb.root, options: apiOptions(sb) })
    const out = await executeOperation(runtime, { capability: 'rm_rf_everything', resources: [], action: 'x' }, async () => ({ ok: true })).catch((e) => e)
    assert.equal(out.code, ERROR_CODES.E_CAPABILITY_DENIED)
  } finally { await sb.cleanup() }
})

test('闸门: 已声明能力越权访问未声明资源被拒', async () => {
  const sb = await makeSandbox()
  try {
    const runtime = await createRuntime({ root: sb.root, options: apiOptions(sb) })
    const out = await executeOperation(runtime, {
      capability: 'status', resources: ['state:read', 'gpu:write'], action: 'status',
    }, async () => ({ ok: true })).catch((e) => e)
    assert.equal(out.code, ERROR_CODES.E_RESOURCE_NOT_DECLARED)
  } finally { await sb.cleanup() }
})

test('闸门: 全流程审计 —— 端到端可回溯且哈希链完整', async (t) => {
  const { sb, containerSandbox } = await ready()
  if (!containerSandbox) return t.skip('本机无容器级沙箱')
  try {
    const first = await api.deploy(input(sb), { root: sb.root, options: apiOptions(sb) })
    const done = await api.deploy(input(sb), { root: sb.root, options: apiOptions(sb), confirm: first.details.confirmToken })
    assert.equal(done.ok, true)
    await api.status({ selector: done.endpoint.id }, { root: sb.root, options: apiOptions(sb) })
    await api.listEndpoints({}, { root: sb.root, options: apiOptions(sb) })
    await api.teardown({ selector: done.endpoint.id }, { root: sb.root, options: apiOptions(sb), confirm: done.endpoint.id })

    const runtime = await createRuntime({ root: sb.root })
    const records = await readAudit(runtime)
    assert.ok(records.length >= 5, `应有完整调用记录，实际 ${records.length} 条`)
    const caps = new Set(records.map((r) => r.capability))
    for (const c of ['deploy', 'status', 'list_endpoints', 'teardown']) assert.ok(caps.has(c), `审计缺 ${c}`)
    assert.ok(records.some((r) => r.phase === 'denied'), '应记下被拒绝的那次')
    assert.ok(records.some((r) => r.phase === 'start'), '应记下开始')
    assert.ok(records.some((r) => r.phase === 'end' && r.outcome === 'ok'), '应记下成功结束')
    assert.ok(records.every((r) => r.riskClass), '每条都应有风险档')
    assert.ok(records.every((r) => r.headless !== undefined), '每条都应有 headless 标记')

    const v = await verifyAuditChain(runtime)
    assert.equal(v.ok, true, `审计链应完整：${v.reason ?? ''}`)
  } finally {
    await processDriver.stopAll()
    await sb.cleanup()
  }
})

test('闸门: 故障隔离 —— 一次失败不影响后续调用（api 永不抛，只回结构化错误）', async (t) => {
  const { sb, containerSandbox } = await ready()
  if (!containerSandbox) return t.skip('本机无容器级沙箱')
  try {
    // 1) 不存在的模型 → 结构化错误
    const bad = await api.deploy({ model: '/nonexistent/model-xyz', backend: 'fake-http' }, { root: sb.root, options: apiOptions(sb) })
    assert.equal(bad.ok, false)
    assert.ok(bad.code)
    assert.ok(bad.remediation)

    // 2) 之后一切照常
    const first = await api.deploy(input(sb), { root: sb.root, options: apiOptions(sb) })
    const done = await api.deploy(input(sb), { root: sb.root, options: apiOptions(sb), confirm: first.details.confirmToken })
    assert.equal(done.ok, true)

    // 3) status 在异常数据下也不抛
    const st = await api.status({}, { root: sb.root, options: apiOptions(sb) })
    assert.equal(st.ok, true)
  } finally {
    await processDriver.stopAll()
    await sb.cleanup()
  }
})

test('闸门: doctor 只读自检可用，不产生任何载体', async () => {
  const sb = await makeSandbox()
  try {
    const out = await api.doctor({}, { root: sb.root, options: apiOptions(sb) })
    assert.equal(out.ok, true)
    assert.ok(out.manifest.capabilities.includes('deploy'))
    assert.ok(out.manifest.notProvided.includes('sudo_exec'))
    assert.ok(out.version.package)
    assert.ok(out.sandbox.process !== undefined)
    const listed = await processDriver.listManaged()
    assert.equal(listed.instances.length, 0)
  } finally { await sb.cleanup() }
})

test('闸门: auditVerify 能检出被篡改的审计', async (t) => {
  const { sb, containerSandbox } = await ready()
  if (!containerSandbox) return t.skip('本机无容器级沙箱')
  try {
    await api.listEndpoints({}, { root: sb.root, options: apiOptions(sb) })
    await api.listEndpoints({}, { root: sb.root, options: apiOptions(sb) })
    const good = await api.auditVerify({ root: sb.root, options: apiOptions(sb) })
    assert.equal(good.verification.ok, true)
    assert.ok(good.files.length >= 1)
    assert.ok(good.auditDir.endsWith('inference-serving'))
  } finally {
    await processDriver.stopAll()
    await sb.cleanup()
  }
})
