/**
 * 模型引用解析：把任意形态的输入变成一个可加载的本地路径（或一个明确的下载计划）。
 *
 * 覆盖验收标准 5.2.1 的六种形态：本地路径 / 模型 ID / URL / 注册名 / 环境变量 / 模糊描述。
 *
 * 本机实测得到的两条关键约束（PROJECT_CONTEXT.md §4.4）：
 *  1. 宿主 `/models` 是空目录，模型真实位置是 `/data/models`，容器内才映射成 `/models`。
 *  2. `Qwen2.5-1.5B-Instruct` 是**软链**；若容器把 `/data/models` 挂到别的路径，
 *     链会断（实测报 `Repo id must be in the form 'repo_name'`）。因此本模块解析软链
 *     得到真实路径，并要求后端使用**同路径挂载**。
 */
import { promises as fs } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { expandHome, exists, readText } from '../util/fsx.mjs'
import { fail, warn, ERROR_CODES, WARNING_CODES } from '../errors.mjs'
import { policyGet } from '../netpolicy.mjs'
import { PROVENANCE_FILE, PROVENANCE_SCHEMA } from '../state/provenance.mjs'

/** 判断一个目录看起来像不是一个 HF/Transformers checkpoint。 */
export async function looksLikeCheckpoint(dir) {
  const cfg = await readText(join(dir, 'config.json'), null)
  if (!cfg) return { ok: false, reason: '缺 config.json' }
  let parsed
  try {
    parsed = JSON.parse(cfg)
  } catch (err) {
    return { ok: false, reason: `config.json 解析失败：${err.message}` }
  }
  const hasWeights = await hasWeightFile(dir)
  return {
    ok: true,
    config: parsed,
    hasWeights,
    reason: hasWeights ? null : '目录内未发现权重文件（*.safetensors / *.bin / *.gguf）',
  }
}

async function hasWeightFile(dir) {
  try {
    const names = await fs.readdir(dir)
    return names.some((n) => /\.(safetensors|bin|gguf|pt|pth)$/.test(n) || n === 'model.safetensors.index.json')
  } catch {
    return false
  }
}

/** 解析软链到真实路径。返回 {path, wasSymlink, realPath}。 */
export async function resolveRealPath(p) {
  try {
    const lst = await fs.lstat(p)
    if (!lst.isSymbolicLink()) return { path: p, wasSymlink: false, realPath: p }
    const realPath = await fs.realpath(p)
    return { path: p, wasSymlink: true, realPath }
  } catch {
    return { path: p, wasSymlink: false, realPath: p }
  }
}

/** 在配置的模型根目录下按名字找候选（用于单名 ID 与模糊描述）。 */
export async function searchModelRoots(runtime, needle) {
  const hits = []
  const n = String(needle).toLowerCase()
  for (const root of runtime.options.modelRoots) {
    if (!(await exists(root))) continue
    let names = []
    try {
      names = await fs.readdir(root)
    } catch {
      continue
    }
    for (const name of names) {
      if (name.startsWith('.')) continue
      const full = join(root, name)
      const lower = name.toLowerCase()
      let score = 0
      if (lower === n) score = 100
      else if (lower.replace(/[^a-z0-9]/g, '') === n.replace(/[^a-z0-9]/g, '')) score = 90
      else if (lower.includes(n)) score = 70 - Math.min(30, lower.length - n.length)
      else if (n.includes(lower)) score = 60
      else {
        // 词元重叠打分（应对"那个 27B 的 Qwen"这类模糊描述）
        const tokens = n.split(/[^a-z0-9]+/).filter((t) => t.length > 1)
        const hits2 = tokens.filter((t) => lower.includes(t))
        if (tokens.length > 0 && hits2.length > 0) score = Math.round((hits2.length / tokens.length) * 50)
      }
      if (score > 0) {
        const st = await fs.stat(full).catch(() => null)
        if (st && st.isDirectory()) hits.push({ name, path: full, score, root })
      }
    }
    // 递归一层（hf_cache / ms_cache 形状）
    for (const sub of ['ms_cache/models', 'hf_cache/models', 'hf_cache/hub']) {
      const dir = join(root, sub)
      if (!(await exists(dir))) continue
      let subs = []
      try { subs = await fs.readdir(dir) } catch { continue }
      for (const name of subs) {
        const lower = name.toLowerCase().replace(/--/g, '/')
        let score = 0
        if (lower.includes(n)) score = 55
        else {
          const tokens = n.split(/[^a-z0-9]+/).filter((t) => t.length > 1)
          const h = tokens.filter((t) => lower.includes(t))
          if (tokens.length && h.length) score = Math.round((h.length / tokens.length) * 45)
        }
        if (score > 0) hits.push({ name, path: join(dir, name), score, root: dir, nested: true })
      }
    }
  }
  hits.sort((a, b) => b.score - a.score)
  return hits
}

/** 读模型 config.json，取出用于默认参数的关键字段。 */
export function extractModelFacts(config) {
  if (!config) return {}
  return {
    architectures: config.architectures ?? null,
    modelType: config.model_type ?? null,
    maxPositionEmbeddings: config.max_position_embeddings ?? null,
    torchDtype: config.torch_dtype ?? null,
    quantizationConfig: config.quantization_config ? {
      quantMethod: config.quantization_config.quant_method ?? null,
      fmt: config.quantization_config.fmt ?? null,
    } : null,
    numHiddenLayers: config.num_hidden_layers ?? null,
    hiddenSize: config.hidden_size ?? null,
    vocabSize: config.vocab_size ?? null,
    // GQA 支持：这两项不读出来会把 KV cache 高估数倍
    // （实测 Qwen2.5-1.5B 是 12 头 / 2 个 KV 头，按 12 估会放大 6 倍）
    numAttentionHeads: config.num_attention_heads ?? null,
    numKeyValueHeads: config.num_key_value_heads ?? config.num_attention_heads ?? null,
    headDim: config.head_dim
      ?? (config.hidden_size && config.num_attention_heads
        ? Math.round(config.hidden_size / config.num_attention_heads)
        : null),
    slidingWindow: config.sliding_window ?? null,
  }
}

/** License 判定：permissive / restricted / unknown。 */
export function classifyLicense(licenseString, policy) {
  const lic = policy?.license ?? {}
  if (!licenseString) return { class: 'unknown', decision: lic.onMissing ?? 'ask', license: null }
  const norm = String(licenseString).toLowerCase().trim()
  if ((lic.permissive ?? []).some((p) => norm === p || norm.startsWith(p))) return { class: 'permissive', decision: lic.onPermissive ?? 'allow', license: licenseString }
  if ((lic.restricted ?? []).some((r) => norm.includes(r))) return { class: 'restricted', decision: lic.onRestricted ?? 'ask', license: licenseString }
  return { class: 'unknown', decision: lic.onMissing ?? 'ask', license: licenseString }
}

/** 从本地目录尽力读出 license（README frontmatter / LICENSE 文件 / config.json）。 */
export async function readLocalLicense(dir, config) {
  if (config && typeof config.license === 'string') return { license: config.license, source: 'config.json' }
  const readme = await readText(join(dir, 'README.md'), null)
  if (readme) {
    const m = /^---\s*$([\s\S]*?)^---\s*$/m.exec(readme)
    if (m) {
      const lm = /^\s*license\s*:\s*(.+)$/mi.exec(m[1])
      if (lm) return { license: lm[1].trim().replace(/^['"]|['"]$/g, ''), source: 'README frontmatter' }
      const lmm = /^\s*license_name\s*:\s*(.+)$/mi.exec(m[1])
      if (lmm) return { license: lmm[1].trim().replace(/^['"]|['"]$/g, ''), source: 'README frontmatter' }
    }
  }
  for (const f of ['LICENSE', 'LICENSE.txt', 'LICENSE.md', 'license']) {
    const t = await readText(join(dir, f), null)
    if (t) {
      const first = t.split('\n').slice(0, 5).join(' ')
      if (/apache/i.test(first)) return { license: 'apache-2.0', source: f }
      if (/mit license/i.test(first)) return { license: 'mit', source: f }
      if (/bsd/i.test(first)) return { license: 'bsd-3-clause', source: f }
      return { license: first.slice(0, 80), source: f }
    }
  }
  // ── 产物溯源边车（F-4）────────────────────────────────────────────
  // 派生模型（量化产物）目录里没有 LICENSE，但它**知道自己派生自谁**。
  // 读出来交给 license 门禁，让基座的确认沿链继承 —— 否则 headless 下
  // 每个派生模型都要人再确认一次，链路直接卡死（真机审计 seq 14 实测）。
  const provText = await readText(join(dir, PROVENANCE_FILE), null)
  if (provText) {
    try {
      const prov = JSON.parse(provText)
      if (prov && prov.schema === PROVENANCE_SCHEMA) {
        return {
          license: prov.sourceLicense?.license ?? null,
          source: `provenance(来自 ${prov.sourceModel ?? '未知来源'})`,
          provenance: { sourceModel: prov.sourceModel ?? null, runId: prov.runId ?? null, method: prov.method ?? null },
        }
      }
    } catch { /* 损坏的边车按不存在处理，退回旧行为 */ }
  }
  return { license: null, source: null }
}

/**
 * 解析一个候选引用到具体本地目录。
 * @returns {{status:'resolved'|'ambiguous'|'unresolved', path?, candidates?, facts?, license?, warnings:[]}}
 */
export async function resolveModelRef(runtime, ref) {
  const warnings = []
  const policy = runtime.policy.network

  if (ref.kind === 'env') {
    const val = runtime.env[ref.value]
    if (!val) {
      fail(ERROR_CODES.E_MODEL_UNRESOLVED, `环境变量 ${ref.value} 未设置或为空`, {
        remediation: `设置 ${ref.value}=<模型路径或模型 ID> 后重试，或直接以字面量传入模型位置。`,
        details: { envVar: ref.value },
      })
    }
    return resolveModelRef(runtime, { kind: 'auto', value: val, fromEnv: ref.value })
  }

  if (ref.kind === 'local_path' || ref.kind === 'auto') {
    const p = resolve(expandHome(String(ref.value)))
    if (await exists(p)) {
      const st = await fs.stat(p)
      if (!st.isDirectory()) {
        fail(ERROR_CODES.E_INPUT_INVALID, `模型路径不是一个目录：${p}`, {
          remediation: '请指向包含 config.json 与权重文件的目录。若指向单个权重文件，请改为其所在目录。',
          details: { path: p },
        })
      }
      const { wasSymlink, realPath } = await resolveRealPath(p)
      if (wasSymlink) {
        warnings.push(warn(WARNING_CODES.W_SYMLINK_MODEL_ROOT,
          `模型目录是软链，已解析真实路径以保证容器内同路径挂载可用`,
          { link: p, realPath }))
      }
      const check = await looksLikeCheckpoint(realPath)
      if (!check.ok) {
        fail(ERROR_CODES.E_MODEL_UNRESOLVED, `目录不像可加载的 checkpoint：${realPath} —— ${check.reason}`, {
          remediation: '确认目录内含 config.json 与 *.safetensors/*.bin/*.gguf 权重；若是多分片权重还需 *.index.json。',
          details: { path: realPath, reason: check.reason },
        })
      }
      if (!check.hasWeights) {
        warnings.push(warn('W_NO_WEIGHTS_FOUND', '目录内未发现权重文件，可能需在容器内另行下载', { path: realPath }))
      }
      const lic = await readLocalLicense(realPath, check.config)
      return {
        status: 'resolved',
        kind: 'local',
        path: realPath,
        originalPath: p,
        wasSymlink,
        facts: extractModelFacts(check.config),
        license: { ...classifyLicense(lic.license, policy), source: lic.source, provenance: lic.provenance ?? null },
        // display 用**用户给的那个名字**（软链名），不是解出来的真实目录名。
        // 否则 `/data/models/Qwen2.5-1.5B-Instruct` 会变成 served-model-name "master"
        // （真实路径是 .../snapshots/master），既难看又没信息量。
        display: basename(p),
        warnings,
      }
    }
    if (ref.kind === 'local_path') {
      // 明确的路径写法但不存在 → 报错（不要退化成"猜模型 ID"）
      const hits = await searchModelRoots(runtime, basename(p))
      fail(ERROR_CODES.E_MODEL_UNRESOLVED, `路径不存在：${p}`, {
        remediation: hits.length
          ? `未找到该路径，但模型根目录下有相似项：${hits.slice(0, 3).map((h) => h.path).join(' / ')}。请确认要部署哪一个。`
          : `确认路径拼写；可用模型根目录：${runtime.options.modelRoots.join(', ')}。`,
        details: { path: p, similar: hits.slice(0, 5).map((h) => h.path) },
      })
    }
  }

  if (ref.kind === 'registry') {
    return { status: 'resolved', kind: 'registry', path: ref.resolvedPath ?? null, display: ref.value, facts: {}, license: { class: 'unknown', decision: 'allow', license: null }, warnings, registryHit: ref.registryHit ?? null }
  }

  if (ref.kind === 'url') {
    const u = new URL(ref.value)
    const decision = policyGet // 仅用于触发出口策略检查的语义提示
    void decision
    const host = u.hostname
    const isHf = /huggingface\.co$/i.test(host)
    const isMirror = /hf-mirror\.com$/i.test(host)
    const isMs = /modelscope\.cn$/i.test(host)
    if (isHf) {
      fail(ERROR_CODES.E_EGRESS_DENIED, `huggingface.co 在本机不可达（DNS 投毒，实测直连与代理均失败）`, {
        remediation: '把 URL 换成 hf-mirror.com 的等价地址（路径结构相同），或改用 ModelScope。',
        details: { url: ref.value, host },
      })
    }
    if (!isMirror && !isMs) {
      fail(ERROR_CODES.E_MODEL_UNRESOLVED, `暂不支持从该站点直接取模型：${host}`, {
        remediation: '当前支持 hf-mirror.com 与 www.modelscope.cn。若已把模型下到本地，请改用本地路径。',
        details: { url: ref.value, host },
      })
    }
    return {
      status: 'unresolved',
      kind: 'remote',
      needsDownload: true,
      downloadPlan: { url: ref.value, host, targetRoot: runtime.options.modelRoots[0], repoPath: u.pathname.replace(/^\//, '') },
      display: basename(u.pathname) || host,
      facts: {},
      license: { class: 'unknown', decision: 'ask', license: null },
      warnings,
    }
  }

  // model_id / fuzzy → 在模型根目录里搜
  const needle = String(ref.value)
  const hits = await searchModelRoots(runtime, needle)
  if (hits.length === 0) {
    return {
      status: 'unresolved',
      kind: ref.kind,
      display: needle,
      candidates: [],
      facts: {},
      license: { class: 'unknown', decision: 'ask', license: null },
      warnings,
    }
  }
  const top = hits[0]
  const ties = hits.filter((h) => h.score === top.score)
  if (ties.length > 1 && top.score < 90) return { status: 'ambiguous', candidates: hits.slice(0, 8), display: needle, warnings, facts: {}, license: { class: 'unknown', decision: 'ask', license: null } }
  return resolveModelRef(runtime, { kind: 'local_path', value: top.path, viaSearch: needle })
}

export { isAbsolute }
