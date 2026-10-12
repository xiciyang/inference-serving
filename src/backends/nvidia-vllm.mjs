/**
 * 默认后端：NVIDIA + vLLM（题目 §4.2「选择后端（默认 NVIDIA + vLLM）」）。
 *
 * 通过 Docker 驱动，因此**容器级沙箱 = 执行方式本身**（R2 档）。
 *
 * 本机实测得到的三条硬约束（PROJECT_CONTEXT.md §4.2/§4.4，全部有命令证据）：
 *  1. `--runtime nvidia --gpus all` 可用（nvidia-container-toolkit 1.17.8 + Docker 29.1.3）。
 *     vLLM 0.23.1rc1 容器实测 85 秒就绪，`/v1/models` 返回 200，前向可用。
 *  2. **挂载必须是"同路径"**：宿主 `/data/models` 挂到容器 `/data/models`。
 *     若挂到 `/models`，宿主侧指向 `/data/models/...` 的软链会在容器内断掉，
 *     vLLM 报 `Repo id must be in the form 'repo_name'`（实测踩过）。
 *  3. 统一内存机型上 `nvidia-smi` 不报显存；内存判据走宿主 MemAvailable 估算。
 */
import { basename, dirname } from 'node:path'
import { promises as fs } from 'node:fs'
import { register } from './registry.mjs'
import { run } from '../util/proc.mjs'
import '../drivers/docker.mjs' // 自注册 docker 驱动（核心不认识 docker，只认驱动 id）

const GiB = 1024 ** 3

/** 估算权重占用：优先读磁盘实际大小（比从 config 推参数量更可靠）。 */
async function estimateWeightsBytes(modelDir) {
  try {
    const names = await fs.readdir(modelDir)
    let total = 0
    for (const n of names) {
      if (!/\.(safetensors|bin|gguf|pt|pth)$/.test(n)) continue
      const st = await fs.stat(`${modelDir}/${n}`)
      total += st.size
    }
    return total
  } catch {
    return null
  }
}

/**
 * KV cache 估算（保守上界）：
 *   bytes = 2(K,V) × layers × kvHeads × headDim × dtypeBytes × maxModelLen × maxNumSeqs
 * 缺 config 字段时回退到一个按 maxModelLen 线性放大的保守基线，宁可高估触发降级，
 * 也不低估到让 vLLM 在启动 5 分钟后 OOM。
 */
export function estimateKvBytes(facts, { maxModelLen, maxNumSeqs, weightBytes }) {
  const layers = facts?.numHiddenLayers ?? null
  const hidden = facts?.hiddenSize ?? null
  if (layers && hidden) {
    const headDim = facts?.headDim ?? 128
    // GQA 优先用 num_key_value_heads；退而求其次用 num_attention_heads。
    // **绝不能用 hidden/headDim 反推**：那是"假设 MHA"的算法，对 GQA 模型会高估数倍
    // （实测 Qwen2.5-1.5B：12 头 vs 2 个 KV 头 → 高估 6 倍，进而误触发降级）。
    const kvHeads = facts?.numKeyValueHeads ?? facts?.numAttentionHeads ?? Math.max(1, Math.round(hidden / headDim))
    const dtypeBytes = 2
    const effectiveLen = facts?.slidingWindow ? Math.min(maxModelLen, facts.slidingWindow) : maxModelLen
    return 2 * layers * kvHeads * headDim * dtypeBytes * effectiveLen * maxNumSeqs
  }
  // 退化估算：按权重规模比例。经验上 4k 上下文 × 32 并发约等于权重的一半量级。
  const base = weightBytes ?? 2 * GiB
  return Math.round(base * 0.5 * (maxModelLen / 4096) * (maxNumSeqs / 32) + 0.25 * GiB)
}

const nvidiaVllm = {
  id: 'nvidia-vllm',
  displayName: 'NVIDIA GPU + vLLM (Docker)',
  driver: 'docker',
  requires: { gpu: true, container: true, vendor: 'nvidia' },

  isAvailable(env) {
    return Boolean(env?.gpu?.present && env?.container?.available && env?.container?.nvidiaRuntime)
  },

  describe(env) {
    const g = env?.gpu?.gpus?.[0]
    return {
      id: 'nvidia-vllm',
      gpu: g?.name ?? null,
      driver: g?.driverVersion ?? null,
      computeCapability: g?.computeCapability ?? null,
      unifiedMemory: g?.unifiedMemory === true,
      docker: env?.container?.detail ?? null,
      image: 'vllm/vllm-openai:nightly',
    }
  },

  defaultConfig({ env, facts }) {
    const unified = env?.capability?.unifiedMemory === true
    const maxPos = facts?.maxPositionEmbeddings ?? 8192
    return {
      // 统一内存机型上必须保守：宿主/桌面/既有推理服务都在同一池子里
      gpuMemoryUtilization: unified ? 0.20 : 0.85,
      maxModelLen: Math.min(maxPos, 8192),
      maxNumSeqs: 32,
      tensorParallelSize: 1,
      dtype: 'auto',
      quantization: null,
      swapSpaceGb: 4,
      image: 'vllm/vllm-openai:nightly',
    }
  },

  /**
   * 预检：**在起容器之前**判定会不会因内存不足失败。
   * 这一步是降级链能被快速驱动的关键 —— 失败只需几十毫秒，而不是等 2 分钟容器超时。
   */
  async preflight({ env, standard }) {
    const g = env?.gpu?.gpus?.[0]
    const totalBytes = g?.totalBytes ?? env?.memory?.totalBytes ?? null
    const availableBytes = g?.availableBytes ?? env?.memory?.availableBytes ?? null
    const weights = await estimateWeightsBytes(standard.model.path)
    const kv = estimateKvBytes(standard.model.facts, {
      maxModelLen: standard.config.maxModelLen,
      maxNumSeqs: standard.config.maxNumSeqs,
      weightBytes: weights,
    })
    const activationReserve = 2 * GiB
    // claim = vLLM 打算向显存/统一内存申请的额度（--gpu-memory-utilization × 总量）
    const claimBytes = totalBytes ? Math.round(totalBytes * standard.config.gpuMemoryUtilization) : null
    // required = 真正必须装下的东西（权重 + KV cache + 激活预留）
    const requiredBytes = (weights ?? 0) + kv + activationReserve

    const detail = {
      totalBytes, availableBytes, claimBytes, budgetBytes: claimBytes, requiredBytes,
      weightsBytes: weights, kvBytes: kv, activationReserve,
      gpuMemoryUtilization: standard.config.gpuMemoryUtilization,
      maxModelLen: standard.config.maxModelLen, maxNumSeqs: standard.config.maxNumSeqs,
      unifiedMemory: env?.capability?.unifiedMemory === true,
      estimateSource: weights === null ? 'config-heuristic' : 'on-disk weights + kv model',
      // 这两个比值是降级链做"证据驱动"决策的输入（而不是拍脑袋乘个系数）
      claimOverAvailable: claimBytes && availableBytes ? claimBytes / availableBytes : null,
      requiredOverClaim: claimBytes ? requiredBytes / claimBytes : null,
    }

    if (!env?.container?.available) {
      return {
        ok: false, code: 'E_SANDBOX_UNAVAILABLE',
        message: `Docker 不可用，无法以容器级沙箱部署：${env?.container?.detail ?? 'unknown'}`,
        remediation: '启动 Docker daemon 后重试；本后端要求容器级沙箱（R2）。',
        details: detail,
      }
    }
    if (!env?.container?.nvidiaRuntime) {
      return {
        ok: false, code: 'E_BACKEND_UNAVAILABLE',
        message: 'Docker 未注册 nvidia runtime，容器拿不到 GPU',
        remediation: '安装 nvidia-container-toolkit 并重启 docker（系统级变更，需先报告再执行）。',
        details: { runtimes: env?.container?.runtimes ?? [], ...detail },
      }
    }
    if (!g) {
      return {
        ok: false, code: 'E_BACKEND_UNAVAILABLE',
        message: '探测不到 NVIDIA GPU',
        remediation: '确认驱动与 GPU 可见性（nvidia-smi）。',
        details: detail,
      }
    }
    // 约束一（宿主侧）：vLLM 要申请的额度超过宿主真实可给的内存。
    //   → 修法是**下调额度**（gpu-memory-utilization），降级链的「内存配额」档负责。
    if (claimBytes !== null && availableBytes !== null && claimBytes > availableBytes) {
      return {
        ok: false, code: 'E_INSUFFICIENT_MEMORY',
        message: `申请额度超过宿主可给内存：gpu-memory-utilization=${standard.config.gpuMemoryUtilization} 想申请 ${fmt(claimBytes)}（总量 ${fmt(totalBytes)}），但宿主当前只有 ${fmt(availableBytes)} 可用`,
        remediation: `下调 gpuMemoryUtilization 到 ≤ ${((availableBytes / (totalBytes || 1)) * 0.9).toFixed(2)}，或释放占用内存的进程。本插件会按降级链自动重试。`,
        details: detail,
      }
    }
    // 约束二（vLLM 内部侧）：额度本身够宿主给，但装不下权重 + KV。
    //   → 修法是**降低需求**（maxModelLen / maxNumSeqs / 精度），下调额度只会更糟。
    if (claimBytes !== null && requiredBytes > claimBytes) {
      return {
        ok: false, code: 'E_MEMORY_CONFIG_INFEASIBLE',
        message: `配额装不下需求：需要 ${fmt(requiredBytes)}（权重 ${fmt(weights ?? 0)} + KV ${fmt(kv)} + 预留 ${fmt(activationReserve)}），而 gpu-memory-utilization=${standard.config.gpuMemoryUtilization} 只给到 ${fmt(claimBytes)}`,
        remediation: `下调 maxModelLen / maxNumSeqs，或上调 gpuMemoryUtilization（宿主尚余 ${fmt(availableBytes)}）。本插件会按降级链自动改小需求后重试。`,
        details: detail,
      }
    }
    return { ok: true, details: detail }
  },

  /**
   * 探测镜像：这个镜像的 `vllm serve` 究竟接受哪些参数？
   *
   * **为什么不硬编码**：实测本机镜像 `vllm/vllm-openai:nightly`（vLLM 0.23.1rc1）
   * 已经不接受 `--swap-space` 与 `--disable-log-requests`（旧版 api_server 入口的参数）。
   * 写死任何一版的 CLI，换个镜像就会 `unrecognized arguments` 直接起不来。
   * 正确做法是问镜像自己 —— 探测结果缓存到进程内，一次部署只探一次。
   */
  async probeImage(runtime, { image }) {
    if (imageCache.has(image)) return imageCache.get(image)
    const script = [
      'set -e',
      'for d in /usr/local/lib/python3*/dist-packages/vllm /usr/local/lib/python3*/site-packages/vllm /usr/lib/python3*/dist-packages/vllm; do',
      '  [ -d "$d" ] && cd "$d" && break',
      'done',
      '[ -d "$(pwd)/engine" ] || { echo "VLLM_PKG_NOT_FOUND"; exit 3; }',
      `for f in ${CANDIDATE_FLAGS.map((f) => `'${f}'`).join(' ')}; do`,
      '  if grep -rq -e "--$f" engine config entrypoints 2>/dev/null; then echo "$f=1"; else echo "$f=0"; fi',
      'done',
    ].join('\n')
    const r = await run('docker', ['run', '--rm', '--entrypoint', 'bash', image, '-lc', script], {
      timeoutMs: Math.min(runtime.options.commandTimeoutMs, 120_000),
    })
    let caps
    if (r.code !== 0 || r.stdout.includes('VLLM_PKG_NOT_FOUND')) {
      caps = {
        ok: false,
        image,
        reason: (r.stderr.trim() || r.spawnError?.message || '镜像内未找到 vllm 包').slice(0, 500),
        // 探测失败 → 退回"只发最保守的一组参数"，宁可少给能力也不要起不来
        flags: Object.fromEntries(CONSERVATIVE_FLAGS.map((f) => [f, true])),
        conservative: true,
      }
    } else {
      const flags = {}
      for (const line of r.stdout.trim().split('\n')) {
        const m = /^([a-z0-9-]+)=([01])$/.exec(line.trim())
        if (m) flags[m[1]] = m[2] === '1'
      }
      caps = { ok: true, image, flags, conservative: false }
    }
    imageCache.set(image, caps)
    return caps
  },

  /** 构造 `docker run` 参数表。返回结构化 spec，由调用方交给执行器。 */
  buildLaunchSpec({ runtime, standard, endpointId, containerName, imageCapabilities = null }) {
    const { model, config, bindHost, port, servedModelName, image, containerRuntime } = standard
    const hostModelDir = model.path
    if (!hostModelDir) {
      throw new Error('buildLaunchSpec: standard.model.path 为空（远端模型需先下载到本地）')
    }

    // **同路径挂载**：容器内与宿主路径完全一致，软链才不会断（实测结论，见文件头）
    const mountSource = hostModelDir
    const mountTarget = hostModelDir

    const args = [
      'run', '-d',
      '--name', containerName,
      // 打标签，teardown 只按标签精确删除，绝不按镜像名批量清理（会误伤既有服务）
      '--label', 'inference-serving.managed=true',
      '--label', `inference-serving.endpoint=${endpointId}`,
      '--label', `inference-serving.package=inference-serving`,
      '--restart', 'no',
      '--runtime', containerRuntime,
      '--gpus', 'all',
      '--ipc', 'host',
      '--shm-size', '8g',
      '-v', `${mountSource}:${mountTarget}:ro`,
      '-p', `${bindHost}:${port}:8000`,
    ]

    const { args: inner, skipped } = buildServeArgs({ standard, imageCapabilities })

    return {
      cmd: 'docker',
      args: [...args, image, ...inner],
      containerName,
      endpointId,
      driver: 'docker',
      mount: { source: mountSource, target: mountTarget, mode: 'ro' },
      portMapping: `${bindHost}:${port}->8000`,
      image,
      innerArgs: inner,
      // 因镜像不支持而**被跳过**的参数：这是可观测性的一部分，不能悄悄丢掉
      skippedFlags: skipped,
      imageCapabilities: imageCapabilities ? { ok: imageCapabilities.ok, conservative: imageCapabilities.conservative === true, reason: imageCapabilities.reason ?? null } : null,
      // 供日志/报告复原"到底跑了什么"
      commandLine: ['docker', ...args, image, ...inner].map(quoteIfNeeded).join(' '),
    }
  },

  /** 后端自己的健康判据：vLLM 暴露 OpenAI 兼容接口。 */
  healthProbe({ standard }) {
    return {
      endpointPath: '/v1/models',
      forwardPath: '/v1/completions',
      forwardBody: {
        model: standard.servedModelName,
        prompt: 'The capital of France is',
        max_tokens: standard.health.maxTokens,
        temperature: 0,
      },
      // 关 4（模型可用性）用同一个 OpenAI 兼容端点，但**打分**而不是只看有没有 choices。
      // 用 echo+logprobs 拿提示词本身的逐 token 对数似然 —— 均匀输出时每个 token 都是 ln(1/V)。
      usabilityPrompt: standard.health.usabilityPrompt,
      usabilityMaxTokens: standard.health.usabilityMaxTokens,
      // vLLM 就绪的判据：/v1/models 返回 200 且列出请求的模型名
      expectsModel: standard.servedModelName,
    }
  },

  /** 从容器日志里识别失败原因（用于降级链决策）。 */
  classifyFailure({ stderr = '', stdout = '', exitCode = null, preflightCode = null }) {
    if (preflightCode) return preflightCode
    const text = `${stderr}\n${stdout}`
    if (/No available memory for the cache blocks|CUDA out of memory|OutOfMemoryError|torch\.cuda\.OutOfMemoryError/i.test(text)) return 'E_INSUFFICIENT_MEMORY'
    if (/port is already allocated|address already in use|bind: address already in use/i.test(text)) return 'E_PORT_UNAVAILABLE'
    if (/driver does not support|no CUDA-capable device|failed to initialize NVML|unknown runtime specified nvidia/i.test(text)) return 'E_BACKEND_UNAVAILABLE'
    if (/Cannot find model|Repo id must be in the form|does not appear to have a file named/i.test(text)) return 'E_MODEL_UNRESOLVED'
    if (/CUDA graphs capture failed|Engine core initialization failed|EngineCore failed to start/i.test(text)) return 'E_DEPLOY_FAILED'
    if (exitCode !== null && exitCode !== 0) return 'E_DEPLOY_FAILED'
    return 'E_DEPLOY_FAILED'
  },
}

/** 探测候选：这些是本插件可能用到的 vLLM CLI 参数。 */
const CANDIDATE_FLAGS = [
  'model', 'served-model-name', 'host', 'port', 'gpu-memory-utilization',
  'max-model-len', 'max-num-seqs', 'tensor-parallel-size', 'dtype', 'quantization',
  'swap-space', 'disable-log-requests', 'enable-log-requests',
  'cpu-offload-gb', 'kv-cache-dtype', 'enforce-eager', 'trust-remote-code',
]

/** 探测失败时只发这些 —— 是各版本 `vllm serve` 的公共子集。 */
const CONSERVATIVE_FLAGS = [
  'model', 'served-model-name', 'host', 'port', 'gpu-memory-utilization',
  'max-model-len', 'max-num-seqs', 'tensor-parallel-size', 'dtype', 'quantization',
]

const imageCache = new Map()

/**
 * 纯函数：按"镜像实际支持的参数"组装 vllm serve 参数。
 * 抽成纯函数是为了能单测 —— Docker 相关的部分留在 probeImage 里。
 *
 * @returns {{args:string[], skipped:string[]}}
 */
export function buildServeArgs({ standard, imageCapabilities = null }) {
  const { model, config, servedModelName } = standard
  const supported = imageCapabilities?.flags ?? null
  const skipped = []
  const args = []

  /**
   * 三种情况分得很清楚，不含糊：
   *   探测明确说支持（=== true）      → 发
   *   探测明确说不支持（=== false）   → 不发，且**记进 skipped**（可观测性）
   *   探测没提到（undefined）        → 只发公共子集里的；其余不发也不记（我们没问过）
   */
  const push = (flag, value) => {
    const known = supported ? supported[flag] : undefined
    if (known === false) { skipped.push(flag); return }
    if (known !== true && !CONSERVATIVE_FLAGS.includes(flag)) return
    args.push(`--${flag}`)
    if (value !== undefined && value !== null) args.push(String(value))
  }

  // 模型：现代 `vllm serve` 推荐位置参数，但 `--model` 仍受支持且兼容面更广。
  // 两者都支持时用 --model（有 deprecation 警告但不会错）；只支持位置参数时退化。
  if (supported && supported.model === false) {
    args.push(model.path)
  } else {
    push('model', model.path)
  }

  push('served-model-name', servedModelName)
  push('host', '0.0.0.0')
  push('port', '8000')
  push('gpu-memory-utilization', config.gpuMemoryUtilization)
  push('max-model-len', config.maxModelLen)
  push('max-num-seqs', config.maxNumSeqs)
  push('tensor-parallel-size', config.tensorParallelSize)

  // 以下三个只在镜像支持时才发（本机镜像已移除 swap-space / disable-log-requests）
  if (config.swapSpaceGb) push('swap-space', config.swapSpaceGb)
  push('disable-log-requests')
  if (config.dtype && config.dtype !== 'auto') push('dtype', config.dtype)
  if (config.quantization) push('quantization', config.quantization)
  if (Number(config.cpuOffloadGb) > 0) push('cpu-offload-gb', config.cpuOffloadGb)
  if (config.kvCacheDtype) push('kv-cache-dtype', config.kvCacheDtype)
  if (config.enforceEager) push('enforce-eager')
  if (Array.isArray(config.extraArgs)) args.push(...config.extraArgs.map(String))

  return { args, skipped }
}

function fmt(bytes) {
  if (bytes === null || bytes === undefined) return 'n/a'
  return `${(bytes / GiB).toFixed(2)} GiB`
}

function quoteIfNeeded(s) {
  const v = String(s)
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(v) ? v : JSON.stringify(v)
}

register(nvidiaVllm)

export default nvidiaVllm
export { estimateWeightsBytes, fmt as formatBytes }
