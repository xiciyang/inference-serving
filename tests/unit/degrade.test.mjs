import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planNextDegradation, applyDegrade, isDegradable, DEGRADE_TIERS, TERMINAL_FAILURES } from '../../src/degrade.mjs'

const baseStandard = {
  backend: 'nvidia-vllm',
  bindHost: '127.0.0.1',
  port: 8100,
  portSource: 'auto',
  servedModelName: 'm',
  image: 'img',
  config: { gpuMemoryUtilization: 0.5, maxModelLen: 8192, maxNumSeqs: 32, tensorParallelSize: 1, dtype: 'auto', quantization: null, swapSpaceGb: 4 },
  assumptions: [],
}

const ctx = { nextFreePort: async () => 8101 }

test('degrade: 档位次序为 内存配额 → 并行度 → 精度 → 端口（无损在前，有损在后）', () => {
  assert.deepEqual(DEGRADE_TIERS.map((t) => t.id), ['memory-quota', 'parallelism', 'precision', 'port'])
  assert.equal(DEGRADE_TIERS.find((t) => t.id === 'precision').lossy, true)
  assert.equal(DEGRADE_TIERS.find((t) => t.id === 'memory-quota').lossy, false)
  assert.equal(DEGRADE_TIERS.find((t) => t.id === 'parallelism').lossy, false)
})

test('degrade: 端口冲突优先匹配端口档（不白白牺牲精度）', async () => {
  const plan = await planNextDegradation({
    failureCode: 'E_PORT_UNAVAILABLE', triedTiers: [], standard: baseStandard, ctx, maxSteps: 4,
  })
  assert.equal(plan.tier.id, 'port')
  assert.equal(plan.patch.port, 8101)
})

test('degrade: 内存不足走内存配额档，且是**无损**的', async () => {
  const plan = await planNextDegradation({
    failureCode: 'E_INSUFFICIENT_MEMORY', triedTiers: [], standard: baseStandard, ctx, maxSteps: 4,
  })
  assert.equal(plan.tier.id, 'memory-quota')
  assert.equal(plan.tier.lossy, false)
  assert.ok(plan.patch.config.gpuMemoryUtilization < baseStandard.config.gpuMemoryUtilization)
  assert.ok(plan.patch.config.maxModelLen <= baseStandard.config.maxModelLen)
})

test('degrade: 内存档试过之后，内存不足才轮到并行度，再之后才是精度', async () => {
  const p1 = await planNextDegradation({ failureCode: 'E_INSUFFICIENT_MEMORY', triedTiers: ['memory-quota'], standard: baseStandard, ctx, maxSteps: 4 })
  assert.equal(p1.tier.id, 'parallelism')
  const p2 = await planNextDegradation({ failureCode: 'E_INSUFFICIENT_MEMORY', triedTiers: ['memory-quota', 'parallelism'], standard: baseStandard, ctx, maxSteps: 4 })
  assert.equal(p2.tier.id, 'precision')
})

test('degrade: 环境/输入类失败不可降级 —— 立即中止，不做虚假重试', async () => {
  for (const code of ['E_BACKEND_UNAVAILABLE', 'E_SANDBOX_UNAVAILABLE', 'E_MODEL_UNRESOLVED', 'E_LICENSE_UNRESOLVED', 'E_EGRESS_DENIED', 'E_CAPABILITY_DENIED']) {
    assert.equal(isDegradable(code), false, `${code} 应不可降级`)
    const plan = await planNextDegradation({ failureCode: code, triedTiers: [], standard: baseStandard, ctx, maxSteps: 4 })
    assert.equal(plan.exhausted, true)
    assert.equal(plan.terminal, true)
  }
  assert.ok(TERMINAL_FAILURES.has('E_HEADLESS_NEEDS_CONFIRMATION'))
})

test('degrade: 达到最大步数后耗尽（不会无限重试）', async () => {
  const plan = await planNextDegradation({
    failureCode: 'E_DEPLOY_FAILED', triedTiers: ['memory-quota', 'parallelism', 'precision', 'port'],
    standard: baseStandard, ctx, maxSteps: 4,
  })
  assert.equal(plan.exhausted, true)
  assert.equal(plan.terminal, false)
})

test('degrade: 端口池耗尽时跳过端口档，不返回空 patch', async () => {
  const plan = await planNextDegradation({
    failureCode: 'E_PORT_UNAVAILABLE', triedTiers: ['memory-quota', 'parallelism', 'precision'],
    standard: baseStandard, ctx: { nextFreePort: async () => null }, maxSteps: 4,
  })
  // port 档不可用 → 已试满 3 档，只剩 port，返回 exhausted
  assert.equal(plan.exhausted, true)
})

test('degrade: applyDegrade 不可变更新且累计 history/assumptions', async () => {
  const plan = await planNextDegradation({ failureCode: 'E_INSUFFICIENT_MEMORY', triedTiers: [], standard: baseStandard, ctx, maxSteps: 4 })
  const next = applyDegrade(baseStandard, plan)
  assert.equal(baseStandard.config.gpuMemoryUtilization, 0.5, '原对象不应被修改')
  assert.notEqual(next.config.gpuMemoryUtilization, 0.5)
  assert.equal(next.degrade.step, 1)
  assert.equal(next.degrade.history.length, 1)
  assert.equal(next.degrade.lossy, false)
  assert.ok(next.assumptions.some((a) => a.field.startsWith('degrade.')))
})

test('degrade: 精度档会带上"有损"警告', async () => {
  const plan = await planNextDegradation({
    failureCode: 'E_INSUFFICIENT_MEMORY', triedTiers: ['memory-quota', 'parallelism'], standard: baseStandard, ctx, maxSteps: 4,
  })
  assert.equal(plan.tier.id, 'precision')
  assert.ok(plan.warning)
  const next = applyDegrade(baseStandard, plan)
  assert.equal(next.degrade.lossy, true)
  next.config.dtype === 'half' && assert.ok(next.config.quantization)
})

test('degrade: 档位声明了 reasonCodes（按失败原因匹配，而非无脑顺序）', () => {
  for (const t of DEGRADE_TIERS) {
    assert.ok(Array.isArray(t.reasonCodes) && t.reasonCodes.length > 0, `${t.id} 应声明 reasonCodes`)
    assert.equal(typeof t.describe, 'string')
    assert.equal(typeof t.apply, 'function')
  }
})

test('degrade: 内存配额档是**证据驱动**的 —— 依据预检的真实需求量反推，而不是拍系数', async () => {
  const GiB = 1024 ** 3
  const ctxWithEvidence = {
    nextFreePort: async () => 8101,
    preflightDetails: {
      totalBytes: 120 * GiB,
      availableBytes: 95 * GiB,
      requiredBytes: 9 * GiB, // 权重+KV+预留
      claimBytes: 114 * GiB,  // 0.95 × 120，超过可用 → 正是本次失败的原因
    },
  }
  const plan = await planNextDegradation({
    failureCode: 'E_INSUFFICIENT_MEMORY', triedTiers: [], standard: baseStandard, ctx: ctxWithEvidence, maxSteps: 4,
  })
  assert.equal(plan.tier.id, 'memory-quota')
  const target = plan.patch.config.gpuMemoryUtilization
  // 9GiB × 1.35 / 120GiB ≈ 0.101 → 落在 [0.05, 0.5×0.9]
  assert.ok(target < 0.12 && target >= 0.05, `目标额度应贴着实需求量，实际 ${target}`)
  // 关键：不该像旧实现那样一律乘 0.6 得到 0.3（那会申请 36GiB，远超实际需要）
  assert.notEqual(target, 0.3)
  assert.match(plan.patch.reason, /预检/)

  const next = applyDegrade(baseStandard, plan)
  assert.equal(next.config.gpuMemoryUtilization, target)
  assert.equal(next.degrade.lossy, false)
})

test('degrade: 无预检数据时退化为保守系数，且档位说明写明依据', async () => {
  const plan = await planNextDegradation({
    failureCode: 'E_INSUFFICIENT_MEMORY', triedTiers: [], standard: baseStandard,
    ctx: { nextFreePort: async () => 8101 }, maxSteps: 4,
  })
  assert.match(plan.patch.reason, /无预检数据/)
  assert.equal(plan.patch.config.gpuMemoryUtilization, 0.3) // 0.5 × 0.6
})

test('degrade: "配额装不下需求"走并行度档（降需求），不走内存配额档（降额度会更糟）', async () => {
  const plan = await planNextDegradation({
    failureCode: 'E_MEMORY_CONFIG_INFEASIBLE', triedTiers: [], standard: baseStandard, ctx, maxSteps: 4,
  })
  assert.equal(plan.tier.id, 'parallelism')
  assert.ok(plan.patch.config.maxNumSeqs < baseStandard.config.maxNumSeqs)
  assert.ok(plan.patch.config.maxModelLen <= baseStandard.config.maxModelLen, '应同时下调上下文长度以降低 KV 需求')
})

test('degrade: 配额不可行的失败最终也能走到精度档（仍装不下时降精度）', async () => {
  const plan = await planNextDegradation({
    failureCode: 'E_MEMORY_CONFIG_INFEASIBLE', triedTiers: ['parallelism'], standard: baseStandard, ctx, maxSteps: 4,
  })
  assert.equal(plan.tier.id, 'precision')
  assert.equal(plan.tier.lossy, true)
})
