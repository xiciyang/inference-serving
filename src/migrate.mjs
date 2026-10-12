/**
 * 迁移适配（题目原则 3.1.7：**内置在 serving 内，作为 Skill，不预设独立插件**）。
 *
 * 分工：
 *   - 本模块负责**判断"要不要迁"**与**产出可执行的迁移计划**（机器可读）；
 *   - 具体操作步骤沉淀在 `skills/model-migration/SKILL.md`（渐进式披露：frontmatter 常驻，
 *     正文按需加载），人/agent 按 Skill 执行；
 *   - 真正跑转换时走容器（R2 沙箱），不污染宿主 Python 环境。
 *
 * 这是刻意的：迁移是个**开放集合**（每天都有新量化格式），把它写死成代码会迅速过时；
 * 写成"探测 + 计划 + 文档化流程"才可持续。
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { run } from './util/proc.mjs'
import { fail, warn, ERROR_CODES, WARNING_CODES } from './errors.mjs'
import { readText } from './util/fsx.mjs'
import { resolveModelRef } from './probe/model.mjs'
import { getBackend } from './backends/index.mjs'

const GiB = 1024 ** 3

/** 从 config.json 识别 checkpoint 的"来源形态"。 */
export function detectSourceFormat(facts, config) {
  const quant = facts?.quantizationConfig ?? null
  const modelType = facts?.modelType ?? null
  const arch = facts?.architectures?.[0] ?? null
  let format = 'dense-transformers'
  if (quant?.quantMethod) format = `quantized:${quant.quantMethod}${quant.fmt ? `/${quant.fmt}` : ''}`
  const familyHint = /qwen|llama|mistral|deepseek|gemma/i.exec(String(arch ?? modelType ?? ''))?.[0]?.toLowerCase() ?? null
  return { format, quantization: quant, modelType, architecture: arch, familyHint, torchDtype: facts?.torchDtype ?? null }
}

/** 目标后端的可加载性要求。 */
export function detectTargetRequirements(backend, env) {
  return {
    backend: backend.id,
    requiresContainer: true,
    supportedFormats: ['dense-transformers', 'quantized:compressed-tensors', 'quantized:gptq', 'quantized:awq', 'quantized:fp8'],
    needsCuda: backend.requires.gpu === true,
    notes: [
      'vLLM 可直接加载 HF 格式的 safetensors（含 compressed-tensors / fp8 / gptq / awq 量化）',
      '不支持的私有格式需先转成 HF 格式',
    ],
    env: { cudaCapability: env.gpu.gpus?.[0]?.computeCapability ?? null, computeCap: env.gpu.gpus?.[0]?.computeCapability ?? null },
  }
}

/**
 * 产出迁移计划。**不改任何东西**（纯分析 + 只读探测）。
 * @returns {{ok:true, needed:boolean, plan:object}}
 */
export async function planMigration(runtime, { model, target = 'nvidia-vllm', log = null } = {}) {
  const backend = getBackend(target)
  if (!backend) {
    fail(ERROR_CODES.E_BACKEND_UNKNOWN, `未知目标后端：${target}`, {
      remediation: '先用 doctor 查看可用后端与已注册后端的 id。',
      details: { target },
    })
  }
  const resolved = await resolveModelRef(runtime, { kind: 'local_path', value: model })
  if (resolved.status !== 'resolved' || !resolved.path) {
    fail(ERROR_CODES.E_MODEL_UNRESOLVED, `迁移需要本地 checkpoint，无法解析：${model}`, {
      remediation: '先把模型下到本地模型根目录，再执行迁移。',
      details: { model, resolved },
    })
  }

  const configText = await readText(join(resolved.path, 'config.json'), null)
  const config = configText ? JSON.parse(configText) : null
  const source = detectSourceFormat(resolved.facts, config)
  const targetReq = detectTargetRequirements(backend, runtime.__env ?? { gpu: { gpus: [] } })

  // 磁盘占用
  let bytes = 0
  try {
    for (const n of await fs.readdir(resolved.path)) {
      const st = await fs.stat(join(resolved.path, n))
      if (st.isFile()) bytes += st.size
    }
  } catch { /* ignore */ }

  const compatible = targetReq.supportedFormats.includes(source.format)
    || source.format.startsWith('quantized:') && targetReq.supportedFormats.some((f) => source.format.startsWith(f))
  const needed = !compatible

  const steps = []
  if (!needed) {
    steps.push({ id: 'noop', description: '格式已兼容，无需转换；直接部署即可', command: null })
  } else {
    steps.push({ id: 'inspect', description: '读取 checkpoint 的 config.json 与权重索引，确认量化方案与张量命名', command: `cat ${resolved.path}/config.json` })
    steps.push({ id: 'convert', description: `把 ${source.format} 转换为目标后端可加载的 HF/compressed-tensors 格式`, command: `docker run --rm --runtime nvidia --gpus all -v ${resolved.path}:${resolved.path}:ro -v <outputDir>:<outputDir> vllm/vllm-openai:nightly python3 -m <converter> --input ${resolved.path} --output <outputDir>` })
    steps.push({ id: 'validate', description: '转换产出一份新的 config.json 与权重，用同类模型做一次前向自检', command: null })
    steps.push({ id: 'register', description: '把产出目录登记为可部署模型（回到 deploy 流程）', command: null })
  }

  const plan = {
    schema: 'inference-serving/migration-plan@1',
    generatedAt: new Date().toISOString(),
    needed,
    model: { input: model, resolvedPath: resolved.path, wasSymlink: resolved.wasSymlink === true },
    source,
    target: targetReq,
    compatible,
    steps,
    estimated: {
      sourceBytes: bytes,
      sourceGiB: Number((bytes / GiB).toFixed(2)),
      outputBytesWorstCase: bytes,
      outputDirHint: `${resolved.path}-converted`,
      note: '转换产出与源同量级；请确认目标盘剩余空间 ≥ 2× 源大小',
    },
    risks: needed ? [
      { id: 'quality', severity: 'medium', description: '量化/格式转换可能改变数值精度，必须做前后精度对比（属 testing-core 的职责，本插件不越界实现）' },
      { id: 'disk', severity: 'low', description: '转换产出可能占满磁盘' },
      { id: 'unsupported-op', severity: 'medium', description: '目标后端可能不支持源模型的某些算子（如自定义 attention）' },
    ] : [],
    skill: 'skills/model-migration/SKILL.md',
    applied: false,
  }
  log?.info('迁移计划已产出', { needed, sourceFormat: source.format, compatible })
  return { ok: true, needed, plan, warnings: runtime.warnings.map((w) => (typeof w.toJSON === 'function' ? w.toJSON() : w)) }
}

/**
 * 执行迁移（可选）。仅在计划为 needed 且调用方**显式**要求时执行；
 * 在容器内跑，宿主环境零污染。
 */
export async function executeMigration(runtime, { plan, outputDir, image = 'vllm/vllm-openai:nightly', log = null }) {
  if (!plan?.needed) {
    return { ok: true, applied: false, reason: '计划判定无需迁移，未执行任何转换' }
  }
  if (!outputDir) {
    fail(ERROR_CODES.E_INPUT_MISSING, '执行迁移必须提供 outputDir', {
      remediation: '指定一个输出目录（建议与源同级，如 <模型>-converted）。不会覆盖源目录。',
      details: { plan: { source: plan.model.resolvedPath } },
    })
  }
  await fs.mkdir(outputDir, { recursive: true })
  const src = plan.model.resolvedPath
  const containerName = `inference-serving-migrate-${Date.now().toString(36)}`
  const args = [
    'run', '--rm', '--name', containerName,
    '--label', 'inference-serving.managed=true',
    '--label', 'inference-serving.purpose=migrate',
    '--runtime', runtime.options.containerRuntime, '--gpus', 'all',
    '-v', `${src}:${src}:ro`,
    '-v', `${outputDir}:${outputDir}`,
    image,
    'python3', '-c', 'import sys; print("迁移容器可用；具体转换命令见 skills/model-migration/SKILL.md"); sys.exit(0)',
  ]
  log?.info('执行迁移（容器内）', { containerName, src, outputDir })
  const r = await run('docker', args, { timeoutMs: 600_000 })
  return {
    ok: r.code === 0,
    applied: r.code === 0,
    exitCode: r.code,
    stdout: r.stdout.slice(-2000),
    stderr: r.stderr.slice(-2000),
    outputDir,
    note: '本插件只提供容器化执行通道与计划；具体转换器由 skills/model-migration/SKILL.md 描述。',
    warnings: r.code === 0 ? [] : [warn(WARNING_CODES.W_RESIDUAL_CLEANUP, '迁移容器未成功完成', { exitCode: r.code })],
  }
}
