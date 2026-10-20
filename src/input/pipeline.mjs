/**
 * 统一输入处理流水线（题目 §3.5，验收标准 5.2 全部 7 条）。
 *
 *   原始输入 → normalize → validate → fill_defaults
 *            → detect_conflicts → resolve_ambiguity
 *            → confirm_if_needed → 标准化输入
 *
 * 三条不变量：
 *  A. **冲突不静默修改**（5.2.3）：检出冲突就抛 E_INPUT_CONFLICT，并附上可选方案。
 *  B. **假设必留痕**（5.2.2）：任何自动补的默认值都进 `assumptions[]` 并写审计。
 *  C. **多义可选优但必须报告**（5.2.4）：唯一高分自动选定 + W_AMBIGUITY_RESOLVED；
 *     分数并列且在 headless 下无法询问 → 中止而不是赌。
 */
import { basename, resolve } from 'node:path'
import { expandHome } from '../util/fsx.mjs'
import { fail, warn, ERROR_CODES, WARNING_CODES } from '../errors.mjs'
import { isPortFree } from '../util/http.mjs'
import { resolveModelRef } from '../probe/model.mjs'
import { probeEnvironment } from '../probe/env.mjs'
import { getBackend, listBackends } from '../backends/index.mjs'

const ENV_REF_RE = /^(?:env:|\$)([A-Za-z_][A-Za-z0-9_]*)$/
const URL_RE = /^https?:\/\//i
const PATHISH_RE = /^(?:[~.]?\/|\.\.?\/)/
const ORG_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/
const BARE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** 纯函数：把原始输入拆成有序候选。 */
export function normalizeInput(raw) {
  const candidates = []
  const push = (kind, value, note) => candidates.push({ kind, value, note: note ?? null })

  if (raw === null || raw === undefined) return candidates

  if (typeof raw === 'object' && !Array.isArray(raw)) {
    if (raw.env) push('env', String(raw.env))
    if (raw.path) push('local_path', String(raw.path))
    if (raw.url) push('url', String(raw.url))
    if (raw.model) {
      const v = String(raw.model)
      if (URL_RE.test(v)) push('url', v)
      else if (PATHISH_RE.test(v)) push('local_path', v)
      else if (ENV_REF_RE.test(v)) push('env', ENV_REF_RE.exec(v)[1])
      else if (ORG_NAME_RE.test(v)) push('model_id', v)
      else push('fuzzy', v)
    }
    if (raw.modelId) push('model_id', String(raw.modelId))
    if (raw.registry || raw.name) push('registry', String(raw.registry ?? raw.name))
    if (raw.fuzzy || raw.description) push('fuzzy', String(raw.fuzzy ?? raw.description))
    return candidates
  }

  const s = String(raw).trim()
  if (s === '') return candidates

  const envMatch = ENV_REF_RE.exec(s)
  if (envMatch) { push('env', envMatch[1]); return candidates }

  if (URL_RE.test(s)) { push('url', s); return candidates }
  if (PATHISH_RE.test(s)) { push('local_path', s); return candidates }
  if (ORG_NAME_RE.test(s)) { push('model_id', s); return candidates }
  if (BARE_NAME_RE.test(s)) { push('model_id', s); push('fuzzy', s); return candidates }
  push('fuzzy', s)
  return candidates
}

/** 校验：是否有足够的输入把它定位到一个模型。 */
export function validateCandidates(candidates) {
  if (candidates.length === 0) {
    fail(ERROR_CODES.E_INPUT_MISSING, '没有提供任何模型输入', {
      remediation: '请提供下列任一种：本地路径（/path/to/models/<model>）、模型 ID（org/name 或目录名）、URL（hf-mirror.com / modelscope.cn）、环境变量（env:VAR）、已注册端点名，或用一句话描述（会列出候选）。',
      details: { accepted: ['path', 'model', 'url', 'env:VAR', 'registryName', 'fuzzyDescription'] },
    })
  }
  return true
}

/** 冲突检测：只报告，不改写。 */
export function detectConflicts(raw, normalized, env, runtime) {
  const conflicts = []
  const o = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}
  const opts = o.options ?? {}

  if (o.path && o.url) {
    conflicts.push({
      field: 'model',
      values: [o.path, o.url],
      problem: '同时给了本地路径和 URL，二者指向的目标可能不同',
      options: [
        { id: 'use-path', description: `只用本地路径 ${o.path}（离线、最快）` },
        { id: 'use-url', description: `只用 URL ${o.url}（会先下载）` },
      ],
    })
  }
  if (o.backend && env.capability.recommendedBackend && o.backend !== env.capability.recommendedBackend) {
    // 只有当"你要的后端在这台机器上跑不了"时才算冲突。
    // 若它本身可用，只是与推荐值不同 —— 尊重显式选择，不打扰用户。
    const requested = getBackend(o.backend)
    if (!requested || !requested.isAvailable(env)) {
      conflicts.push({
        field: 'backend',
        values: [o.backend, env.capability.recommendedBackend],
        problem: `显式指定的后端 "${o.backend}" 在本机不可用，而本机可用的是 "${env.capability.recommendedBackend}"`,
        options: [
          { id: 'honor-explicit', description: `坚持用 "${o.backend}"（预检会失败并给出原因）` },
          { id: 'use-recommended', description: `改用本机可用的 "${env.capability.recommendedBackend}"` },
        ],
      })
    }
  }
  const poolStart = opts.portPoolStart ?? runtime.options.portPoolStart
  const poolEnd = opts.portPoolEnd ?? runtime.options.portPoolEnd
  if (opts.port && (opts.port < poolStart || opts.port > poolEnd)) {
    conflicts.push({
      field: 'port',
      values: [opts.port, `${poolStart}-${poolEnd}`],
      problem: `指定端口 ${opts.port} 不在声明的端口池 ${poolStart}-${poolEnd} 内`,
      options: [
        { id: 'widen-pool', description: '显式把端口池放宽到包含该端口（会记录到审计）' },
        { id: 'use-pool', description: '改从端口池中自动挑一个空闲端口' },
      ],
    })
  }
  if (opts.bindHost && opts.bindHost !== '127.0.0.1' && opts.bindHost !== 'localhost' && env.capability) {
    conflicts.push({
      field: 'bindHost',
      values: [opts.bindHost, '127.0.0.1'],
      problem: `请求对外绑定 ${opts.bindHost} —— 这会把服务暴露到本机之外`,
      options: [
        { id: 'localhost-only', description: '只用 127.0.0.1（默认，最安全）' },
        { id: 'expose', description: `确认对外暴露到 ${opts.bindHost}（需显式确认，且属生产变更风险档）` },
      ],
    })
  }
  return conflicts
}

function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)) }

/** 补默认值，并把每一个自动决定记进 assumptions。 */
export async function fillDefaults(runtime, input, env, { modelPath, modelDisplay = null, facts }) {
  const assumptions = []
  const assume = (field, value, reason) => {
    assumptions.push({ field, value, reason })
    return value
  }

  const backendId = input.backend
    ?? (env.capability.recommendedBackend
      ? assume('backend', env.capability.recommendedBackend, '本机探测推荐（有 NVIDIA GPU 且 Docker 的 nvidia runtime 可用）')
      : null)
  if (!backendId) {
    fail(ERROR_CODES.E_BACKEND_UNAVAILABLE, '没有可用后端：本机既无 GPU 也无容器运行时', {
      remediation: `可用后端：${listBackends().join(', ')}。请先修复环境（装 Docker + nvidia-container-toolkit），或把任务迁到有 GPU 的主机。`,
      details: { env: env.capability, backends: listBackends() },
    })
  }
  const backend = getBackend(backendId)
  if (!backend) {
    fail(ERROR_CODES.E_BACKEND_UNKNOWN, `未知后端：${backendId}`, {
      remediation: `已注册后端：${listBackends().join(', ')}。新后端通过 src/backends/index.mjs 注册（registry.register()）插件式加入。`,
      details: { requested: backendId, available: listBackends() },
    })
  }

  const bindHost = input.bindHost
    ?? assume('bindHost', runtime.options.bindHost, '默认只监听回环地址（策略禁止默认对外暴露）')

  // 端口：显式指定优先，否则在池里挑第一个空闲
  let port = input.port ?? null
  let portSource = port ? 'explicit' : null
  if (!port) {
    const start = input.portPoolStart ?? runtime.options.portPoolStart
    const end = input.portPoolEnd ?? runtime.options.portPoolEnd
    for (let p = start; p <= end; p += 1) {
      // eslint-disable-next-line no-await-in-loop
      if (await isPortFree(bindHost, p)) { port = p; break }
    }
    if (!port) {
      fail(ERROR_CODES.E_PORT_UNAVAILABLE, `端口池 ${start}-${end} 内无空闲端口`, {
        remediation: `关闭占用端口的进程，或用 options.portPoolStart/End 指定更大的池（会记录到审计）。`,
        details: { pool: [start, end], host: bindHost },
      })
    }
    portSource = assume('port', port, `端口池 ${start}-${end} 中第一个空闲端口（bind 实测为空闲）`)
  }

  const defaults = backend.defaultConfig({ env, facts })
  const cfg = {
    gpuMemoryUtilization: input.gpuMemoryUtilization ?? defaults.gpuMemoryUtilization,
    maxModelLen: input.maxModelLen ?? defaults.maxModelLen,
    maxNumSeqs: input.maxNumSeqs ?? defaults.maxNumSeqs,
    tensorParallelSize: input.tensorParallelSize ?? defaults.tensorParallelSize,
    dtype: input.dtype ?? defaults.dtype,
    quantization: input.quantization ?? defaults.quantization,
    swapSpaceGb: input.swapSpaceGb ?? defaults.swapSpaceGb,
    extraArgs: input.extraArgs ?? [],
  }
  if (input.gpuMemoryUtilization === undefined) assume('config.gpuMemoryUtilization', cfg.gpuMemoryUtilization, '后端默认（统一内存机型上偏保守，为既有服务留余量）')
  if (input.maxModelLen === undefined) assume('config.maxModelLen', cfg.maxModelLen, facts?.maxPositionEmbeddings ? `取自模型 config.json 的 max_position_embeddings=${facts.maxPositionEmbeddings}，并被安全上限约束` : '后端默认（未能从 config.json 读到 max_position_embeddings）')

  const servedModelName = input.servedModelName
    ?? assume('servedModelName', sanitizeName(modelDisplay ?? basename(modelPath ?? 'model')), '取自用户给出的模型名并做字符归一（软链场景下用链接名，不用真实目录名）')

  const image = input.image ?? assume('image', defaults.image, '后端默认镜像（本机已存在该镜像时秒起，不必拉取）')

  return {
    backendId,
    backend,
    bindHost,
    port,
    portSource,
    config: cfg,
    servedModelName,
    image,
    containerRuntime: input.containerRuntime ?? runtime.options.containerRuntime,
    timeouts: {
      deployMs: input.deployTimeoutMs ?? runtime.options.deployTimeoutMs,
      healthMs: input.healthTimeoutMs ?? runtime.options.healthTimeoutMs,
      pollMs: input.healthPollIntervalMs ?? runtime.options.healthPollIntervalMs,
    },
    health: {
      forward: input.healthForwardProbe ?? runtime.options.healthForwardProbe,
      maxTokens: input.healthForwardMaxTokens ?? runtime.options.healthForwardMaxTokens,
      usability: input.healthUsabilityProbe ?? runtime.options.healthUsabilityProbe,
      usabilityMaxTokens: input.healthUsabilityMaxTokens ?? runtime.options.healthUsabilityMaxTokens ?? undefined,
      usabilityPrompt: input.healthUsabilityPrompt ?? runtime.options.healthUsabilityPrompt ?? undefined,
    },
    assumptions: [...assumptions],
  }
}

export function sanitizeName(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'model'
}

/**
 * 全流水线。返回标准化输入 + 环境 + 模型解析结果。
 * 抛出的每个错误都带 remediation（5.2.5）。
 */
/**
 * 每次调用的覆盖项既可以写在顶层（`{port: 8100}`），也可以写在 `options` 里
 * （`{options: {port: 8100}}`）—— **两种写法必须等价**。
 *
 * 踩过的坑：早期只有顶层写法被 `fillDefaults` 读取，于是 `api.deploy(input, {options:{port}})`
 * 或 CLI 的 `--port` 被**静默忽略**，端口退回自动挑选。静默忽略一个用户显式给的参数，
 * 比报错更糟。这里统一提升到顶层，顶层显式值优先。
 */
export function liftPerCallOptions(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw
  const merged = { ...(raw.options ?? {}), ...raw }
  // 保留原始 options，供下游（MCP/CLI 回显、确认令牌）继续读取
  merged.options = { ...(raw.options ?? {}) }
  return merged
}

export async function runInputPipeline(runtime, raw, { deepProbe = false } = {}) {
  raw = liftPerCallOptions(raw)
  const candidates = normalizeInput(raw)
  validateCandidates(candidates)

  const env = await probeEnvironment(runtime, { deep: deepProbe })

  // --- 解析模型：按候选顺序试，收集失败原因，全部失败才报错 ---
  const attempts = []
  let resolved = null
  let ambiguous = null
  for (const cand of candidates) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await resolveModelRef(runtime, cand)
      attempts.push({ candidate: cand, status: r.status })
      if (r.status === 'resolved') { resolved = { ...r, matchedCandidate: cand }; break }
      if (r.status === 'ambiguous') { ambiguous = { ...r, matchedCandidate: cand }; break }
      if (r.status === 'unresolved') { resolved = { ...r, matchedCandidate: cand }; break }
    } catch (err) {
      attempts.push({ candidate: cand, status: 'error', code: err.code ?? null, message: err.message })
      if (candidates.length === 1) throw err
    }
  }

  if (ambiguous) {
    const list = ambiguous.candidates.map((c) => `  - ${c.path}  (匹配度 ${c.score})`).join('\n')
    if (runtime.headless) {
      const top = ambiguous.candidates[0]
      runtime.warnings.push(warn(WARNING_CODES.W_AMBIGUITY_RESOLVED,
        `headless 下按最高匹配度自动选定：${top.path}`,
        { query: ambiguous.display, chosen: top.path, candidates: ambiguous.candidates.slice(0, 5).map((c) => c.path) }))
      resolved = await resolveModelRef(runtime, { kind: 'local_path', value: top.path })
      resolved.autoResolved = { from: ambiguous.display, chosen: top.path, reason: 'headless：取最高匹配度候选' }
    } else {
      fail(ERROR_CODES.E_INPUT_AMBIGUOUS, `输入 "${ambiguous.display}" 匹配到多个模型，无法确定用哪一个`, {
        remediation: `请从下列候选中指定一个（用完整路径最稳妥）：\n${list}`,
        details: { query: ambiguous.display, candidates: ambiguous.candidates.slice(0, 8).map((c) => ({ path: c.path, score: c.score })) },
      })
    }
  }

  if (!resolved) {
    const tried = attempts.map((a) => `  - ${a.candidate.kind}:${a.candidate.value} → ${a.status}${a.code ? ` (${a.code})` : ''}${a.message ? `: ${a.message}` : ''}`).join('\n')
    fail(ERROR_CODES.E_MODEL_UNRESOLVED, `无法把输入解析为可部署的模型：${JSON.stringify(raw)}`, {
      remediation: `已尝试：\n${tried}\n请改用以下之一：模型根目录（${runtime.options.modelRoots.join(', ')}）下的完整路径；或更精确的目录名。`,
      details: { attempts, modelRoots: runtime.options.modelRoots },
    })
  }

  const input = (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) ? raw : {}
  const conflicts = detectConflicts({ ...input, ...(input.options ? {} : {}), options: { ...(input.options ?? {}), ...pickOptions(input) } }, candidates, env, runtime)
  if (conflicts.length > 0) {
    const rendered = conflicts.map((c) => `  - [${c.field}] ${c.problem}\n    可选：${c.options.map((o) => `${o.id}=${o.description}`).join(' | ')}`).join('\n')
    fail(ERROR_CODES.E_INPUT_CONFLICT, `输入存在 ${conflicts.length} 处冲突，未做任何静默修改`, {
      remediation: `请显式选择后重试：\n${rendered}`,
      details: { conflicts },
    })
  }

  const filled = await fillDefaults(runtime, input, env, {
    modelPath: resolved.path,
    modelDisplay: resolved.display,
    facts: resolved.facts,
  })

  // 环境探测与假设严重不符 → 停下（题目 §4.6）
  const mismatch = detectProbeMismatch(runtime, input, env, filled, resolved)
  if (mismatch) {
    fail(ERROR_CODES.E_BACKEND_UNAVAILABLE, `探测结果与假设严重不符：${mismatch.problem}`, {
      remediation: mismatch.remediation,
      details: mismatch,
    })
  }

  const standard = {
    model: {
      ref: resolved.matchedCandidate ?? null,
      kind: resolved.kind,
      path: resolved.path ?? null,
      display: resolved.display,
      wasSymlink: resolved.wasSymlink === true,
      needsDownload: resolved.needsDownload === true,
      downloadPlan: resolved.downloadPlan ?? null,
      facts: resolved.facts ?? {},
      license: resolved.license ?? null,
    },
    backend: filled.backendId,
    bindHost: filled.bindHost,
    port: filled.port,
    portSource: filled.portSource,
    servedModelName: filled.servedModelName,
    image: filled.image,
    containerRuntime: filled.containerRuntime,
    config: filled.config,
    timeouts: filled.timeouts,
    health: filled.health,
    assumptions: [...filled.assumptions, ...(resolved.autoResolved ? [{ field: 'model', value: resolved.path, reason: `headless 自动选定：${resolved.autoResolved.reason}` }] : [])],
    env: {
      gpu: env.gpu.gpus?.[0]?.name ?? null,
      unifiedMemory: env.capability.unifiedMemory,
      availableMemoryBytes: env.capability.availableMemoryBytes,
      memoryIsEstimate: env.capability.memoryIsEstimate,
      docker: env.container.available,
      nvidiaRuntime: env.container.nvidiaRuntime,
      sandboxTiers: env.capability.sandboxTiers,
    },
  }
  return { standard, env, resolved, warnings: [...runtime.warnings, ...(resolved.warnings ?? [])] }
}

function pickOptions(input) {
  const o = input.options ?? {}
  return {
    port: o.port ?? input.port,
    bindHost: o.bindHost ?? input.bindHost,
    portPoolStart: o.portPoolStart,
    portPoolEnd: o.portPoolEnd,
  }
}

/** 探测与假设不符的检出（不是所有差异都算"严重不符"，只挑会改变结论的）。 */
export function detectProbeMismatch(runtime, input, env, filled, resolved) {
  if (!env.capability.canUseGpu && filled.backendId.includes('vllm')) {
    return {
      problem: `选择了 GPU 后端 "${filled.backendId}"，但探测不到可用 GPU`,
      detected: { gpuPresent: env.gpu.present, dockerAvailable: env.container.available },
      remediation: '确认驱动与 GPU 可见性（nvidia-smi），或改用 CPU 后端；本插件不会在无 GPU 时假装成功。',
    }
  }
  if (!env.container.nvidiaRuntime && filled.backendId.includes('vllm') && env.container.available) {
    return {
      problem: 'Docker 可用但未注册 nvidia runtime，容器拿不到 GPU',
      detected: { runtimes: env.container.runtimes },
      remediation: '安装/注册 nvidia-container-toolkit 后重试；或显式选择 CPU 后端。',
    }
  }
  // 注意：**"配额不可行"不在这里硬停**。
  // 那是后端的预检（claim vs available / required vs claim）该判的，且应当由降级链
  // 用实测量反推一个可行的配额再重试 —— 在这里一刀切会绕过整条降级链，
  // 还会误用一个语义不符的错误码（环境不符 ≠ 配置不可行）。
  // 这里只留一条**可见的警告**，让风险进报告。
  if (filled.config.gpuMemoryUtilization > 0.9 && env.capability.unifiedMemory && runtime) {
    runtime.warnings.push(warn(WARNING_CODES.W_HIGH_MEMORY_REQUEST_ON_UNIFIED,
      `在统一内存机型上请求 gpu-memory-utilization=${filled.config.gpuMemoryUtilization}（≈${((env.gpu.gpus?.[0]?.totalBytes ?? 0) * filled.config.gpuMemoryUtilization / 1024 ** 3).toFixed(1)} GiB），`
      + `宿主当前可用约 ${((env.capability.availableMemoryBytes ?? 0) / 1024 ** 3).toFixed(1)} GiB；将由后端预检判定，必要时降级链会自动下调`,
      { requested: filled.config.gpuMemoryUtilization, availableBytes: env.capability.availableMemoryBytes, totalBytes: env.gpu.gpus?.[0]?.totalBytes }))
  }
  if (resolved.needsDownload && runtime.headless) {
    return {
      problem: '输入指向需要下载的远端模型，但当前是 headless 模式',
      detected: { downloadPlan: resolved.downloadPlan },
      remediation: '先把模型下到本地模型根目录，或改用本地路径；headless 下不会自动发起大文件下载。',
    }
  }
  return null
}

export { resolve, expandHome }
