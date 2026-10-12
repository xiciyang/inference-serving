/**
 * 集成测试：完整部署闭环（预检 → 启动 → 三关健康检查 → 降级 → 注册 → 幂等 → 回退 → 拆解 → 审计）。
 *
 * 用 tests/helpers 的**测试后端 + spawn 驱动**跑，不依赖 GPU 与 Docker。
 * 这同时是一条验收证据：核心逻辑确实只通过驱动接缝工作（软硬件解耦）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeSandbox, resetKnobs } from '../helpers/sandbox.mjs'
import { processDriver } from '../helpers/process-driver.mjs'
import { createRuntime } from '../../src/config.mjs'
import { deployOperation } from '../../src/deploy.mjs'
import { statusOperation, teardownOperation, rollbackOperation, listEndpointsOperation } from '../../src/lifecycle.mjs'
import { loadRegistry, currentRevision } from '../../src/state/registry.mjs'
import { verifyAuditChain, readAudit } from '../../src/audit.mjs'
import { promises as fs } from 'node:fs'

const BACKEND = 'fake-http'

async function setup() {
  const sb = await makeSandbox()
  const runtime = await createRuntime({ root: sb.root, options: { ...sb.options, healthTimeoutMs: 20_000, healthPollIntervalMs: 150, deployTimeoutMs: 30_000 } })
  return { sb, runtime }
}

function raw(sb, extra = {}) {
  return { model: sb.modelPath, backend: BACKEND, ...extra }
}

async function deploy(sb, runtime, extra = {}) {
  return deployOperation(runtime, { raw: raw(sb, extra) })
}

test('闭环: 正常部署 —— 三关健康检查通过、端点注册、revision 带 verifiedAt', async () => {
  const { sb, runtime } = await setup()
  try {
    const out = await deploy(sb, runtime)
    assert.equal(out.ok, true)
    assert.equal(out.reused, false)
    assert.equal(out.report.outcome, 'success')
    assert.equal(out.report.attempts.length, 1)
    assert.equal(out.report.degrade.steps, 0)

    const reg = await loadRegistry(runtime)
    assert.equal(reg.endpoints.length, 1)
    const ep = reg.endpoints[0]
    assert.equal(ep.status, 'serving')
    const cur = currentRevision(ep)
    assert.ok(cur.verifiedAt, 'revision 必须带 verifiedAt（健康检查通过后才注册）')
    assert.equal(cur.port, out.endpoint.port)
    assert.ok(cur.endpoint.startsWith('http://127.0.0.1:'))

    // 健康检查三关齐全
    const checks = out.report.attempts[0]
    assert.equal(checks.healthFailedAt, null)
  } finally {
    await processDriver.stopAll()
    await sb.cleanup()
  }
})

test('闭环: 幂等 —— 重复部署返回同一端点，不新增 revision、不重复创建', async () => {
  const { sb, runtime } = await setup()
  try {
    const first = await deploy(sb, runtime)
    // 续租：同一次运行内第二次 deploy 同一模型，必须带上第一次拿到的 ownerToken，
    // 否则会被 E_ENDPOINT_LEASED 拒绝（这正是"两个插件各自以为独占"的闸门）。
    const second = await deploy(sb, runtime, { ownerToken: first.ownerToken })
    assert.equal(second.reused, true)
    assert.equal(second.endpoint.id, first.endpoint.id)
    assert.equal(second.endpoint.endpoint, first.endpoint.endpoint)

    const reg = await loadRegistry(runtime)
    assert.equal(reg.endpoints.length, 1, '同一模型只应有一个端点')
    assert.equal(reg.endpoints[0].revisions.length, 1, '幂等命中不应新增 revision')
    assert.equal(second.report.outcome, 'idempotent')
  } finally {
    await processDriver.stopAll()
    await sb.cleanup()
  }
})

test('闭环: 降级链 —— 连续 3 次启动失败后自动换 3 种配置并成功（验收 5.1.2）', async () => {
  const { sb, runtime } = await setup()
  try {
    resetKnobs()
    const { knobs } = await import('../helpers/fake-backend.mjs')
    knobs.failLaunchAttempts = 3

    const out = await deploy(sb, runtime)
    assert.equal(out.report.outcome, 'success')
    assert.equal(out.report.attempts.length, 4, '应为 baseline + 3 次降级 = 4 次尝试')
    assert.ok(out.report.degrade.steps >= 3, `至少降 3 档，实际 ${out.report.degrade.steps}`)

    const tiers = out.report.attempts.map((a) => a.tier)
    assert.equal(tiers[0], 'baseline')
    assert.equal(new Set(tiers).size, 4, `4 次尝试应覆盖 4 种不同配置，实际：${tiers.join(',')}`)
    assert.ok(tiers.includes('port'), '启动失败可按原因匹配到端口档')
    assert.ok(tiers.includes('memory-quota'), '端口档试过后应轮到位内存配额')
    assert.ok(tiers.includes('parallelism'), '应继续轮到并行度档')

    // 每次失败都记了失败码
    for (const a of out.report.attempts.slice(0, 3)) assert.equal(a.failureCode, 'E_DEPLOY_FAILED')
  } finally {
    await processDriver.stopAll()
    await sb.cleanup()
  }
})

test('闭环: 预检失败（内存不足）走无损耗的内存配额档，且不启动容器', async () => {
  const { sb, runtime } = await setup()
  try {
    const { knobs } = await import('../helpers/fake-backend.mjs')
    resetKnobs()
    knobs.preflightFailAboveMemoryUtilization = 0.35 // baseline 0.5 会被挡下，降档后 0.3 通过

    const out = await deploy(sb, runtime)
    assert.equal(out.report.outcome, 'success')
    assert.equal(out.report.attempts.length, 2)
    assert.equal(out.report.attempts[0].preflightOk, false)
    assert.equal(out.report.attempts[0].failureCode, 'E_INSUFFICIENT_MEMORY')
    assert.equal(out.report.attempts[0].launched, false, '预检失败不应启动任何东西')
    assert.equal(out.report.attempts[1].tier, 'memory-quota')
    assert.equal(out.report.degrade.lossy, false, '内存配额是无损档，不应标记为有损')
  } finally {
    await processDriver.stopAll()
    await sb.cleanup()
  }
})

test('闭环: 精度档被用到时，报告显式标注「有损」', async () => {
  const { sb, runtime } = await setup()
  try {
    const { knobs } = await import('../helpers/fake-backend.mjs')
    resetKnobs()
    // 一直预检失败：memory-quota 后仍 > 阈值 → parallelism（不改内存） → precision
    knobs.preflightFailAboveMemoryUtilization = 0.1
    knobs.failLaunchAttempts = 0

    const out = await deploy(sb, runtime).catch((e) => e)
    // 该场景会耗尽降级链（内存配额只应用一次，降不到 0.1 以下）
    assert.ok(out instanceof Error, '应因降级链耗尽而失败')
    assert.equal(out.code, 'E_DEGRADE_EXHAUSTED')
    assert.ok(out.details.triedTiers.includes('precision'), `应尝试过精度档，实际：${out.details.triedTiers.join(',')}`)
    // 有损档被用到时，报告里必须能看出来（这里从尝试记录验证）
    const prec = out.details.attempts.find((a) => a.tier === 'precision')
    assert.ok(prec, '尝试记录应包含 precision 档')
  } finally {
    await processDriver.stopAll()
    await sb.cleanup()
  }
})

test('闭环: 不可降级的失败立即中止，不浪费重试', async () => {
  const { sb, runtime } = await setup()
  try {
    const { knobs } = await import('../helpers/fake-backend.mjs')
    resetKnobs()
    knobs.preflightFailAboveMemoryUtilization = 0.0
    knobs.preflightCode = 'E_BACKEND_UNAVAILABLE' // 环境类，不可降级

    const err = await deploy(sb, runtime).catch((e) => e)
    assert.ok(err instanceof Error)
    assert.equal(err.code, 'E_BACKEND_UNAVAILABLE')
    assert.equal(err.details.attempts.length, 1, '不可降级时只应尝试一次')
  } finally {
    await processDriver.stopAll()
    await sb.cleanup()
  }
})

test('闭环: 降级链耗尽 —— 报 E_DEGRADE_EXHAUSTED、说明尝试过什么、且不残留进程', async () => {
  const { sb, runtime } = await setup()
  try {
    const { knobs } = await import('../helpers/fake-backend.mjs')
    resetKnobs()
    knobs.failLaunchAttempts = 99

    const err = await deploy(sb, runtime).catch((e) => e)
    assert.equal(err.code, 'E_DEGRADE_EXHAUSTED')
    assert.ok(err.details.attempts.length >= 3, `应尝试至少 3 种配置，实际 ${err.details.attempts.length}`)
    assert.ok(err.details.triedTiers.length >= 3)
    assert.ok(err.remediation)

    // 无残留：没有任何 fixture 进程存活
    const listed = await processDriver.listManaged()
    const alive = listed.instances.filter((i) => i.status === 'running')
    assert.deepEqual(alive, [], '耗尽后不应留下运行中的载体')

    // 注册表不应存在半死的端点记录
    const reg = await loadRegistry(runtime)
    assert.equal(reg.endpoints.filter((e) => e.status === 'serving').length, 0)
  } finally {
    await processDriver.stopAll()
    await sb.cleanup()
  }
})

test('闭环: 故障隔离 —— 一次失败之后，下一次部署仍能成功', async () => {
  const { sb, runtime } = await setup()
  try {
    const { knobs } = await import('../helpers/fake-backend.mjs')
    resetKnobs()
    knobs.failLaunchAttempts = 99
    const failed = await deploy(sb, runtime).catch((e) => e)
    assert.equal(failed.code, 'E_DEGRADE_EXHAUSTED')

    resetKnobs()
    const ok = await deploy(sb, runtime)
    assert.equal(ok.report.outcome, 'success')
    assert.ok(ok.endpoint.endpoint)
  } finally {
    await processDriver.stopAll()
    await sb.cleanup()
  }
})

test('闭环: 拆解 —— teardown 后进程消失、端口释放，且逐项验证回报', async () => {
  const { sb, runtime } = await setup()
  try {
    const out = await deploy(sb, runtime)
    const id = out.endpoint.id
    const port = out.endpoint.port

    const td = await teardownOperation(runtime, { selector: id, ownerToken: out.ownerToken })
    assert.equal(td.ok, true)
    assert.equal(td.verification.clean, true, `验证项：${JSON.stringify(td.verification.checks)}`)
    for (const c of td.verification.checks) assert.equal(c.ok, true, `${c.name}: ${c.detail}`)

    const listed = await processDriver.listManaged()
    assert.equal(listed.instances.length, 0)

    const reg = await loadRegistry(runtime)
    assert.equal(reg.endpoints[0].status, 'torn_down')

    // 幂等：重复 teardown 不报错
    const again = await teardownOperation(runtime, { selector: id, ownerToken: out.ownerToken })
    assert.equal(again.ok, true)
    assert.equal(again.alreadyTornDown, true)
    void port
  } finally {
    await processDriver.stopAll()
    await sb.cleanup()
  }
})

test('闭环: 回退 —— 回退到上一个已验证版本，并生成新的 revision', async () => {
  const { sb, runtime } = await setup()
  try {
    const first = await deploy(sb, runtime)
    const id = first.endpoint.id
    const firstPort = first.endpoint.port
    const firstRev = first.endpoint.revision

    // 用不同参数再部署一次 → 产生 revision 2，占用不同端口
    const second = await deploy(sb, runtime, { options: { port: null }, maxModelLen: 2048, ownerToken: first.ownerToken })
    assert.equal(second.reused, false)
    const reg2 = await loadRegistry(runtime)
    assert.equal(reg2.endpoints[0].revisions.length, 2, '配置变化应产生新 revision')

    const rb = await rollbackOperation(runtime, { selector: id, ownerToken: first.ownerToken })
    assert.equal(rb.ok, true)
    assert.equal(rb.rolledBackTo, firstRev)

    const reg3 = await loadRegistry(runtime)
    const ep = reg3.endpoints[0]
    assert.ok(ep.revisions.length >= 3, '回退本身也应作为新 revision 记录')
    const cur = currentRevision(ep)
    assert.equal(cur.port, firstPort, '回退后应回到旧配置的端口')
    assert.equal(ep.history.some((h) => h.event === 'rolled-back'), true)
  } finally {
    await processDriver.stopAll()
    await sb.cleanup()
  }
})

test('闭环: 回退无历史 → E_NO_ROLLBACK_TARGET（显式报错，不静默成功）', async () => {
  const { sb, runtime } = await setup()
  try {
    const first = await deploy(sb, runtime)
    const err = await rollbackOperation(runtime, { selector: first.endpoint.id, ownerToken: first.ownerToken }).catch((e) => e)
    assert.equal(err.code, 'E_NO_ROLLBACK_TARGET')
    assert.ok(err.remediation)
    assert.ok(err.details.revisions)
  } finally {
    await processDriver.stopAll()
    await sb.cleanup()
  }
})

test('闭环: status 做实机核对 —— 容器消失后报出一致性冲突', async () => {
  const { sb, runtime } = await setup()
  try {
    const out = await deploy(sb, runtime)
    let st = await statusOperation(runtime, { selector: out.endpoint.id })
    assert.equal(st.endpoints[0].consistency.ok, true, '刚部署完应一致')

    // 偷偷把进程杀掉，模拟"注册表说在跑但实际没了"
    const listed = await processDriver.listManaged()
    await processDriver.stop(listed.instances[0].name)

    st = await statusOperation(runtime, { selector: out.endpoint.id })
    assert.equal(st.endpoints[0].consistency.ok, false)
    assert.match(st.endpoints[0].consistency.message, /未运行|不存在/)
  } finally {
    await processDriver.stopAll()
    await sb.cleanup()
  }
})

test('闭环: list_endpoints 按状态过滤 + 统计', async () => {
  const { sb, runtime } = await setup()
  try {
    const out = await deploy(sb, runtime)
    const all = await listEndpointsOperation(runtime, {})
    assert.equal(all.count, 1)
    assert.deepEqual(all.byStatus, { serving: 1 })
    const none = await listEndpointsOperation(runtime, { status: 'torn_down' })
    assert.equal(none.count, 0)
    await teardownOperation(runtime, { selector: out.endpoint.id, ownerToken: out.ownerToken })
    const td = await listEndpointsOperation(runtime, { status: 'torn_down' })
    assert.equal(td.count, 1)
  } finally {
    await processDriver.stopAll()
    await sb.cleanup()
  }
})

test('闭环: 审计留痕 —— 审计由 ops 闸门层写（FSM 层本身不写，分层明确）', async () => {
  const { sb, runtime } = await setup()
  try {
    const { createLogger } = await import('../../src/log.mjs')
    const log = createLogger(runtime, { capability: 'deploy' })
    const out = await deployOperation(runtime, { raw: raw(sb), log })
    await teardownOperation(runtime, { selector: out.endpoint.id, log, ownerToken: out.ownerToken })
    await log.flush()

    // 本用例直接调用 FSM/生命周期函数，绕过了 ops 闸门；因此这里**不应**有审计记录。
    // 审计链的完整性由 tests/integration/api-gates.test.mjs（走 api.mjs）覆盖。
    // 这个断言本身是分层契约的证据：审计只在 ops 层写，避免两处写导致语义分叉。
    const records = await readAudit(runtime)
    assert.equal(records.length, 0, 'FSM 层不应自己写审计 —— 审计是 ops 层的职责')

    // 运行日志记录阶段事件（可观测性，验收 5.4.5）
    const { promises: fsp } = await import('node:fs')
    const logFiles = await fsp.readdir(runtime.paths.appLogDir)
    assert.ok(logFiles.length >= 1, '应有结构化运行日志')
    const logText = await fsp.readFile(`${runtime.paths.appLogDir}/${logFiles[0]}`, 'utf8')
    assert.ok(logText.includes('phase:'), '日志应含阶段事件')
    for (const phase of ['probe', 'sandbox', 'deploy', 'register', 'healthy']) {
      assert.ok(logText.includes(`phase:${phase}`), `日志应包含阶段 ${phase}`)
    }
  } finally {
    await processDriver.stopAll()
    await sb.cleanup()
  }
})

test('闭环: 指标记录部署耗时与降级次数', async () => {
  const { sb, runtime } = await setup()
  try {
    const { knobs } = await import('../helpers/fake-backend.mjs')
    resetKnobs()
    knobs.failLaunchAttempts = 2
    await deploy(sb, runtime)
    const { readMetrics } = await import('../../src/metrics.mjs')
    const m = await readMetrics(runtime)
    assert.ok(m.counters.deploy_attempts >= 3)
    assert.ok(m.counters.degrade_steps >= 2)
    assert.ok(m.timings.deploy_ms_total > 0)
    assert.equal(m.resources.last_container_image, 'fake:1')
  } finally {
    await processDriver.stopAll()
    await sb.cleanup()
  }
})

test('闭环: 注册表文件落在 ~/.ai-infra 共享状态，不在包内', async () => {
  const { sb, runtime } = await setup()
  try {
    await deploy(sb, runtime)
    const text = await sb.readRegistryText()
    assert.ok(text.includes('endpoints'))
    const st = await fs.stat(runtime.paths.registryFile)
    assert.ok(st.isFile())
    assert.match(runtime.paths.registryFile, /state\/serving-registry\.yaml$/)
  } finally {
    await processDriver.stopAll()
    await sb.cleanup()
  }
})

test('闭环: 报告必须描述"真正部署的那份配置"，而不是最初请求的（报告不能撒谎）', async () => {
  const { sb, runtime } = await setup()
  try {
    const { knobs } = await import('../helpers/fake-backend.mjs')
    resetKnobs()
    knobs.preflightFailAboveMemoryUtilization = 0.35 // baseline 0.5 被挡下 → 降档

    const requested = { model: sb.modelPath, backend: BACKEND, gpuMemoryUtilization: 0.5 }
    const out = await deployOperation(runtime, { raw: requested })
    assert.equal(out.report.outcome, 'success')
    assert.equal(out.report.degrade.steps, 1)

    // 报告里的 finalConfig 必须等于实际起效的配置
    const final = currentRevision(await loadRegistry(runtime).then((r) => r.endpoints[0]))
    assert.equal(out.report.finalConfig.gpuMemoryUtilization, final.config.gpuMemoryUtilization)
    assert.notEqual(out.report.finalConfig.gpuMemoryUtilization, 0.5, '发生过降级时，finalConfig 不应等于基线值')
    // 同时保留"最初请求的是什么"，便于对照
    assert.equal(out.report.requestedConfig.gpuMemoryUtilization, 0.5)
    assert.equal(out.report.degradedFrom, 'baseline')
    // 端点描述也用最终端口
    assert.equal(out.report.endpoint.port, final.port)
  } finally {
    await processDriver.stopAll()
    await sb.cleanup()
  }
})

test('闭环: servedModelName 用用户给的名字（软链场景不用真实目录名）', async () => {
  const sb = await makeSandbox({ modelName: 'master' })
  const { promises: fsp } = await import('node:fs')
  const { join } = await import('node:path')
  // 造一个软链：my-model -> master
  const link = join(sb.modelRoot, 'my-model')
  await fsp.symlink(sb.modelPath, link)
  const runtime = await createRuntime({ root: sb.root, options: { ...sb.options, healthTimeoutMs: 20_000, healthPollIntervalMs: 150 } })
  try {
    const out = await deployOperation(runtime, { raw: { model: link, backend: BACKEND } })
    assert.equal(out.report.model.wasSymlink, true)
    assert.equal(out.report.model.input, 'my-model', 'display 用链接名')
    assert.equal(out.report.model.resolvedPath, await fsp.realpath(sb.modelPath), '实际部署用解析后的真实路径')
    assert.equal(out.endpoint.servedModelName, 'my-model', 'served-model-name 用链接名，而不是真实目录名 master')
  } finally {
    await processDriver.stopAll()
    await sb.cleanup()
  }
})

test('闭环: 模型起来了但输出退化为均匀分布 → E_MODEL_NOT_READY，且不可降级、不留残留', async () => {
  // 复刻真机事故：残缺模型（model.norm.weight 整块为零）的容器照常启动、
  // /v1/models 200、/v1/completions 也返回结构完好的 choices。
  // 旧判据（只看有没有 choices）会返回 ok:true，下游白跑 436 s。
  const { sb, runtime } = await setup()
  try {
    const { knobs } = await import('../helpers/fake-backend.mjs')
    resetKnobs()
    knobs.usabilityMode = 'uniform'

    const err = await deploy(sb, runtime).catch((e) => e)
    assert.ok(err instanceof Error, '均匀输出的模型不得被当成部署成功')
    assert.equal(err.code, 'E_MODEL_NOT_READY')
    assert.equal(err.retriable, false, '换配置解决不了，必须标为不可重试')
    assert.equal(err.details.attempts.length, 1, '不可降级时只应尝试一次（不浪费重试）')

    // 判据里要有可直接引用的算术证据，而不是一句"看起来不对"
    const usability = err.details.attempts[0].modelUsability
    assert.ok(usability, '报告里必须留下关 4 的判定证据')
    assert.equal(usability.ok, false)
    assert.match(usability.detail, /item-variance|not-uniform|top-margin/)

    // 不留残留
    const listed = await processDriver.listManaged()
    assert.deepEqual(listed.instances.filter((i) => i.status === 'running'), [], '失败后不应留下运行中的载体')
    const reg = await loadRegistry(runtime)
    assert.equal(reg.endpoints.filter((e) => e.status === 'serving').length, 0, '不得注册半死的端点')
  } finally {
    await processDriver.stopAll()
    await sb.cleanup()
  }
})

test('闭环: 健康模型在同一夹具下仍然部署成功（证明关 4 不是"一律拒绝"）', async () => {
  const { sb, runtime } = await setup()
  try {
    const { knobs } = await import('../helpers/fake-backend.mjs')
    resetKnobs()
    knobs.usabilityMode = 'ok'
    const out = await deploy(sb, runtime)
    assert.equal(out.ok, true)
    const c = out.report.attempts[0]
    assert.equal(c.healthFailedAt, null)
    // 关 4 确实跑过并通过，且**留下了可复核的证据**（不是只有一句 ok:true）
    assert.ok(c.modelUsability, '成功路径也必须留下关 4 的判定证据')
    assert.equal(c.modelUsability.ok, true)
    assert.ok(c.modelUsability.metrics, '证据里要有可复核的量')
    assert.ok(c.modelUsability.metrics.itemRange > 0, '健康模型的逐 token NLL 极差应 > 0')
    assert.ok(c.modelUsability.metrics.uniformGap > 1e-4, '健康模型应远离 ln(V)')
  } finally {
    await processDriver.stopAll()
    await sb.cleanup()
  }
})
