/**
 * 降级链（题目 §4.2，验收标准 5.1.2「自动尝试至少 3 种配置」）。
 *
 * 档位次序采用 Step 0 实测后调整、并经用户确认的版本：
 *
 *   档 0 baseline        原精度 + 原并行度 + 默认端口
 *   档 1 memory-quota    降 gpu-memory-utilization / max-model-len（**无损**）
 *   档 2 parallelism     降 max-num-seqs / tensor-parallel（**无损**）
 *   档 3 precision       降 dtype / 量化档（**有损**，故排在无损手段之后）
 *   档 4 port            换端口（与前几档正交）
 *   → 中止               回滚 + 完整报告
 *
 * 与题面给的"精度 → 并行 → 端口"的差异：把无损档插到有损档之前。理由写在
 * RISK_CLASSIFICATION_DRAFT.md §8.1，已获确认。
 *
 * 第二个设计要点：**按失败原因匹配档位**，而不是无脑顺序推进。
 *   - 端口冲突就换端口，不该白白牺牲精度；
 *   - 环境/输入类失败（无 GPU、无 nvidia runtime、模型解析不了）**不可降级**，
 *     立刻中止而不是浪费 4 次尝试 —— 那是"假装在努力"。
 */
import { recordDegrade } from './metrics.mjs'

const GiB = 1024 ** 3

/**
 * 内存配额的余量系数。
 *
 * 取 1.35 而不是 1.15：预检里的 KV 估算是**上界近似**（未知 head_dim / sliding window 等
 * 细节时按保守值算），而 vLLM 真正需要的是它自己算出来的 KV 池。余量太小会导致
 * "降到 0.08 仍然装不下" → 白白多走一轮降级。宁可一次降到位。
 */
const MEMORY_HEADROOM = 1.35

export const DEGRADE_TIERS = [
  {
    id: 'memory-quota',
    label: '内存配额',
    lossy: false,
    // 只应对"申请额度超过宿主可给"这一种失败。装不下需求的失败下调额度只会更糟。
    reasonCodes: ['E_INSUFFICIENT_MEMORY'],
    describe: '把 gpu-memory-utilization 下调到"刚好够用"（依据预检给出的实际需求量，而非固定系数）',
    apply: (standard, ctx) => {
      const d = ctx?.preflightDetails ?? null
      let target
      let basis
      if (d?.requiredBytes && d?.totalBytes) {
        // 证据驱动：按"预检算出的真实需求 × 1.15 余量"反推额度，再取不超过当前的 90%
        const feasible = (d.requiredBytes * MEMORY_HEADROOM) / d.totalBytes
        const cap = standard.config.gpuMemoryUtilization * 0.9
        target = round2(clamp(feasible, 0.05, cap))
        basis = `依据预检 required=${(d.requiredBytes / GiB).toFixed(2)}GiB / total=${(d.totalBytes / GiB).toFixed(2)}GiB 反推（×${MEMORY_HEADROOM} 余量，且不超过当前的 90%）`
      } else {
        target = round2(Math.max(0.08, standard.config.gpuMemoryUtilization * 0.6))
        basis = '无预检数据，按 0.6 系数保守下调'
      }
      return {
        config: {
          ...standard.config,
          gpuMemoryUtilization: target,
          swapSpaceGb: Math.max(standard.config.swapSpaceGb ?? 4, 8),
        },
        value: target,
        reason: basis,
      }
    },
  },
  {
    id: 'parallelism',
    label: '并行度',
    lossy: false,
    // 装不下需求时，先把并发与上下文降下来（降需求），而不是降额度
    reasonCodes: ['E_MEMORY_CONFIG_INFEASIBLE', 'E_INSUFFICIENT_MEMORY', 'E_DEPLOY_TIMEOUT'],
    describe: '下调 max-num-seqs / max-model-len 与 tensor-parallel-size（降低需求）',
    apply: (standard) => ({
      config: {
        ...standard.config,
        maxNumSeqs: Math.max(1, Math.floor(standard.config.maxNumSeqs / 2)),
        maxModelLen: Math.max(2048, Math.floor(standard.config.maxModelLen / 2)),
        tensorParallelSize: 1,
      },
    }),
  },
  {
    id: 'precision',
    label: '精度',
    lossy: true,
    reasonCodes: ['E_INSUFFICIENT_MEMORY', 'E_MEMORY_CONFIG_INFEASIBLE'],
    describe: '下调 dtype（bf16/fp16 → half）并在未量化时启用 fp8',
    apply: (standard) => ({
      config: {
        ...standard.config,
        dtype: standard.config.dtype === 'auto' || standard.config.dtype === 'bfloat16' ? 'half' : standard.config.dtype,
        quantization: standard.config.quantization ?? 'fp8',
      },
      warning: '精度档是有损降级：会影响输出质量，报告中已显式标注',
    }),
  },
  {
    id: 'port',
    label: '端口',
    lossy: false,
    orthogonal: true,
    reasonCodes: ['E_PORT_UNAVAILABLE', 'E_DEPLOY_FAILED', 'E_DEPLOY_TIMEOUT'],
    describe: '在端口池内换一个空闲端口重试',
    apply: async (standard, ctx) => {
      const port = await ctx.nextFreePort()
      if (!port) return null
      return { port, portSource: 'degrade:port' }
    },
  },
]

/** 这些失败换配置也没用 —— 直接中止（避免虚假重试）。 */
export const TERMINAL_FAILURES = new Set([
  'E_BACKEND_UNAVAILABLE',
  'E_SANDBOX_UNAVAILABLE',
  'E_SANDBOX_PROBE_FAILED',
  'E_MODEL_UNRESOLVED',
  'E_LICENSE_UNRESOLVED',
  'E_CAPABILITY_DENIED',
  'E_RESOURCE_NOT_DECLARED',
  'E_EGRESS_DENIED',
  'E_INPUT_INVALID',
  'E_INPUT_CONFLICT',
  'E_INPUT_AMBIGUOUS',
  'E_HEADLESS_NEEDS_CONFIRMATION',
  'E_CONFIRMATION_REQUIRED',
  // 模型起来了但前向不可用（均匀输出）—— 降显存/降上下文都改变不了权重本身是坏的
  'E_MODEL_NOT_READY',
  'E_CANCELLED',
])

function round2(n) { return Math.round(n * 100) / 100 }
function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)) }

export function isDegradable(failureCode) {
  return !TERMINAL_FAILURES.has(failureCode)
}

/**
 * 选下一档。
 * @returns {{tier:object, config:object, port:number|null, warning?:string}|null}
 *          null = 降级链耗尽
 */
export async function planNextDegradation({
  failureCode,
  triedTiers = [],
  standard,
  ctx,
  maxSteps,
}) {
  if (!isDegradable(failureCode)) return { exhausted: true, terminal: true, reason: `失败原因 ${failureCode} 不可通过换配置解决` }
  if (triedTiers.length >= maxSteps) return { exhausted: true, terminal: false, reason: `已达到最大降级步数 ${maxSteps}` }

  const tried = new Set(triedTiers)
  // 1) 优先挑与失败原因匹配、且尚未试过的档
  const matched = DEGRADE_TIERS.filter((t) => !tried.has(t.id) && t.reasonCodes.includes(failureCode))
  // 2) 兜底：按声明顺序挑下一个未试过的档
  const fallback = DEGRADE_TIERS.filter((t) => !tried.has(t.id))

  for (const tier of [...matched, ...fallback]) {
    // eslint-disable-next-line no-await-in-loop
    const patch = await tier.apply(standard, ctx)
    if (patch === null) continue // 该档此刻不可用（例如端口池已满），试下一档
    return {
      tier,
      patch,
      warning: patch.warning ?? null,
      reason: tier.reasonCodes.includes(failureCode) ? `与失败原因 ${failureCode} 匹配` : `按声明顺序兜底（失败原因 ${failureCode}）`,
    }
  }
  return { exhausted: true, terminal: false, reason: '所有档位均已尝试' }
}

/** 把一次降级落到 standard 上（不可变更新，便于对比）。 */
export function applyDegrade(standard, { tier, patch }) {
  const next = {
    ...standard,
    config: patch.config ? { ...patch.config } : { ...standard.config },
    port: patch.port ?? standard.port,
    portSource: patch.portSource ?? standard.portSource,
    degrade: {
      step: (standard.degrade?.step ?? 0) + 1,
      tier: tier.id,
      label: tier.label,
      lossy: tier.lossy === true,
      history: [...(standard.degrade?.history ?? []), { at: new Date().toISOString(), tier: tier.id, lossy: tier.lossy === true, describe: tier.describe }],
    },
  }
  next.assumptions = [
    ...(standard.assumptions ?? []),
    { field: `degrade.${tier.id}`, value: patch.value ?? null, reason: `${tier.describe}（档位 ${tier.id}${tier.lossy ? '，有损' : '，无损'}）` },
  ]
  return next
}

export async function recordDegradeStep(runtime, { step, tier, reason, failureCode }) {
  await recordDegrade(runtime, { step, reason: `${failureCode}→${tier}` })
  void reason
}

export { GiB }
