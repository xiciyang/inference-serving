import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildServeArgs } from '../../src/backends/nvidia-vllm.mjs'

const standard = {
  model: { path: '/data/models/m' },
  servedModelName: 'm-served',
  config: {
    gpuMemoryUtilization: 0.1, maxModelLen: 4096, maxNumSeqs: 32,
    tensorParallelSize: 1, dtype: 'auto', quantization: null, swapSpaceGb: 4,
  },
}

test('vllm 参数: 本机镜像（0.23.1rc1）不支持 swap-space / disable-log-requests → 自动跳过并留痕', () => {
  // 依据：在这些镜像里 grep 不到这两个参数（README 引用的实测）
  const caps = {
    ok: true,
    flags: {
      model: true, 'served-model-name': true, host: true, port: true,
      'gpu-memory-utilization': true, 'max-model-len': true, 'max-num-seqs': true,
      'tensor-parallel-size': true, 'swap-space': false, 'disable-log-requests': false,
    },
  }
  const { args, skipped } = buildServeArgs({ standard, imageCapabilities: caps })
  assert.ok(!args.includes('--swap-space'), '不该发出不被支持的参数')
  assert.ok(!args.includes('--disable-log-requests'))
  assert.deepEqual(skipped.sort(), ['disable-log-requests', 'swap-space'], '被跳过的参数必须留痕')
  // 公共子集应在
  for (const f of ['--model', '--served-model-name', '--host', '--port', '--gpu-memory-utilization', '--max-model-len', '--max-num-seqs', '--tensor-parallel-size']) {
    assert.ok(args.includes(f), `应包含 ${f}`)
  }
})

test('vllm 参数: 老镜像支持这两个参数时照常发出', () => {
  const caps = { ok: true, flags: { 'swap-space': true, 'disable-log-requests': true, model: true } }
  const { args, skipped } = buildServeArgs({ standard, imageCapabilities: caps })
  assert.ok(args.includes('--swap-space'))
  assert.ok(args.includes('--disable-log-requests'))
  assert.deepEqual(skipped, [])
})

test('vllm 参数: 未探测到能力（null）时只发公共子集，不赌有争议的参数', () => {
  const { args, skipped } = buildServeArgs({ standard, imageCapabilities: null })
  assert.ok(args.includes('--model'))
  assert.ok(!args.includes('--disable-log-requests'), '无能力信息时不应发有争议的参数')
  assert.deepEqual(skipped, [])
})

test('vllm 参数: --model 不可用时退化为位置参数', () => {
  const caps = { ok: true, flags: { model: false, 'served-model-name': true } }
  const { args } = buildServeArgs({ standard, imageCapabilities: caps })
  assert.ok(!args.includes('--model'))
  assert.equal(args[0], '/data/models/m', '模型应作为位置参数给出')
})

test('vllm 参数: dtype/quantization/extraArgs 按需追加', () => {
  const s2 = { ...standard, config: { ...standard.config, dtype: 'half', quantization: 'fp8', extraArgs: ['--enforce-eager'] } }
  const { args } = buildServeArgs({ standard: s2, imageCapabilities: { ok: true, flags: {} } })
  assert.deepEqual(args.slice(args.indexOf('--dtype'), args.indexOf('--dtype') + 2), ['--dtype', 'half'])
  assert.deepEqual(args.slice(args.indexOf('--quantization'), args.indexOf('--quantization') + 2), ['--quantization', 'fp8'])
  assert.ok(args.includes('--enforce-eager'))
})

test('vllm 参数: 探测失败退回保守集时，不会发出任何有争议的参数', async () => {
  const mod = await import('../../src/backends/nvidia-vllm.mjs')
  const backend = mod.default
  // 用一个不存在的镜像探测 → 失败 → 保守集
  const runtime = { options: { commandTimeoutMs: 5000 } }
  const caps = await backend.probeImage(runtime, { image: 'definitely-not-a-real-image:0' })
  assert.equal(caps.ok, false)
  assert.equal(caps.conservative, true)
  assert.ok(caps.reason)
  const { args } = buildServeArgs({ standard, imageCapabilities: caps })
  assert.ok(!args.includes('--swap-space'))
  assert.ok(!args.includes('--disable-log-requests'))
  assert.ok(args.includes('--model'))
})

test('内存估算: GQA 模型按 num_key_value_heads 计，不按 MHA 反推（否则高估数倍）', async () => {
  const { estimateKvBytes } = await import('../../src/backends/nvidia-vllm.mjs')
  const GiB = 1024 ** 3
  // Qwen2.5-1.5B 的真实形状
  const facts = {
    numHiddenLayers: 28, hiddenSize: 1536,
    numAttentionHeads: 12, numKeyValueHeads: 2, headDim: 128,
  }
  const kv = estimateKvBytes(facts, { maxModelLen: 4096, maxNumSeqs: 32, weightBytes: 3 * GiB })
  // 2 * 28 * 2 * 128 * 2 * 4096 * 32 = 3.76e9 ≈ 3.5 GiB
  assert.ok(kv / GiB > 3.2 && kv / GiB < 3.9, `KV 估算应约 3.5GiB，实际 ${(kv / GiB).toFixed(2)}GiB`)

  // 若误按 12 个 KV 头算会得到 6 倍 —— 这正是修复前的行为
  const mha = estimateKvBytes({ ...facts, numKeyValueHeads: 12 }, { maxModelLen: 4096, maxNumSeqs: 32, weightBytes: 3 * GiB })
  assert.ok(mha / kv > 5.5, 'MHA 反推应显著高估（用于防止回归到旧算法）')
})

test('内存估算: 缺失 kv 头信息时退回 attention 头数，而不是 hidden/headDim 反推', async () => {
  const { estimateKvBytes } = await import('../../src/backends/nvidia-vllm.mjs')
  const a = estimateKvBytes({ numHiddenLayers: 28, hiddenSize: 1536, numAttentionHeads: 12, headDim: 128 }, { maxModelLen: 1024, maxNumSeqs: 1 })
  const b = estimateKvBytes({ numHiddenLayers: 28, hiddenSize: 1536, numKeyValueHeads: 12, headDim: 128 }, { maxModelLen: 1024, maxNumSeqs: 1 })
  assert.equal(a, b, '无 num_key_value_heads 时应等价于 num_attention_heads')
})

test('内存估算: sliding_window 会限制有效上下文长度', async () => {
  const { estimateKvBytes } = await import('../../src/backends/nvidia-vllm.mjs')
  const base = { numHiddenLayers: 28, hiddenSize: 1536, numKeyValueHeads: 2, headDim: 128 }
  const full = estimateKvBytes(base, { maxModelLen: 32768, maxNumSeqs: 1 })
  const win = estimateKvBytes({ ...base, slidingWindow: 4096 }, { maxModelLen: 32768, maxNumSeqs: 1 })
  assert.ok(win < full / 7, '滑窗应把有效长度压到窗口大小')
})

test('facts: extractModelFacts 读出 GQA 相关字段', async () => {
  const { extractModelFacts } = await import('../../src/probe/model.mjs')
  const f = extractModelFacts({
    hidden_size: 1536, num_attention_heads: 12, num_key_value_heads: 2,
    num_hidden_layers: 28, max_position_embeddings: 32768, sliding_window: 32768,
  })
  assert.equal(f.numAttentionHeads, 12)
  assert.equal(f.numKeyValueHeads, 2)
  assert.equal(f.headDim, 128)
  assert.equal(f.numHiddenLayers, 28)
  // 没有 num_key_value_heads 时退回 attention 头数
  assert.equal(extractModelFacts({ hidden_size: 64, num_attention_heads: 4 }).numKeyValueHeads, 4)
})

test('per-call 选项: 顶层与 options.* 两种写法等价（不能被静默忽略）', async () => {
  const { liftPerCallOptions } = await import('../../src/input/pipeline.mjs')
  const a = liftPerCallOptions({ model: '/m', port: 8100, gpuMemoryUtilization: 0.3 })
  assert.equal(a.port, 8100)
  assert.equal(a.gpuMemoryUtilization, 0.3)

  const b = liftPerCallOptions({ model: '/m', options: { port: 8100, gpuMemoryUtilization: 0.3 } })
  assert.equal(b.port, 8100, 'options.port 必须被提升到顶层，否则 fillDefaults 看不到它')
  assert.equal(b.gpuMemoryUtilization, 0.3)

  // 顶层显式值优先于 options 里的同名字段
  const c = liftPerCallOptions({ model: '/m', port: 9000, options: { port: 8100 } })
  assert.equal(c.port, 9000)
  assert.deepEqual(c.options, { port: 8100 }, '原始 options 保留，供下游回显')

  // 非对象输入原样返回
  assert.equal(liftPerCallOptions('/m'), '/m')
})
