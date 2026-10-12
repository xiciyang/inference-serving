/**
 * 模型可用性探针 —— 「端点的 HTTP 层活着」与「模型真的参与了前向」是两件事。
 *
 * ## 为什么必须有这一关（真机事故）
 *
 * 本机实测：一个 `model.safetensors` 里 223/338 张量整块为零（含 `model.norm.weight`）
 * 的残缺模型，vLLM **照常启动**、`/v1/models` 返回 200、`/v1/completions` 也返回
 * 结构完好的 `choices`（文本长度正常）。原先的就绪判据只看"有没有 choices"，
 * 于是 `deploy` 返回 `ok: true`，耗时 100.5 s —— **与健康模型没有区别**。
 * 下游拿着这个 `ok: true` 跑了 436 s 量化，最后才发现模型是坏的。
 *
 * 所以判据必须落到**输出分布**上，而不是响应结构上。
 *
 * ## 判据（分两档，这个区分是刻意的）
 *
 * **mustRun（没跑到就等于"没验"，不能算通过）**
 *   1. `scored`        —— 真的拿到了足够多的打分 token（否则是"测不了"，不是"能用"）
 *   2. `item-variance` —— 逐条 NLL 的极差 > 0。**主力判据，且不需要 vocab**：
 *      健康模型对不同 token 的意外程度不同（真机实测极差 ≈ 3.36）；
 *      均匀输出时每个 token 都是 `ln(V)`，极差恒为 0。
 *
 * **confirmatory（依赖外部信息，缺席记为 skipped 而不判失败，但会在结论里写明）**
 *   3. `not-uniform`   —— `|meanNll − ln(vocab)| > 1e-4`（需要模型 `config.json` 的 `vocab_size`）
 *   4. `top-margin`    —— `top1 − top2` 的最大间隔 > 0（需要响应含 `top_logprobs`）
 *
 * 判据全过**只说明"权重确实参与了前向"**，不说明模型质量好 ——
 * 本模块不冒充质量评测（那是 quantization / tuning 的精度评测的职责）。
 *
 * ### 一个被自己夹具照出来的错误（留在这里防复发）
 *
 * 第一版的第三判据是"不同 token 的个数 ≥ 2"。它**看起来**合理，实际是错的：
 * `echo: true` 返回的 `tokens` 主要是**提示词自己的 token**，而提示词是固定的，
 * 于是无论模型好坏，这个数都差不多 —— 它测的是提示词的多样性，不是模型健康度。
 * 换成 `top-margin` 之后才真正独立。（单元测试的夹具当时也被写成"均匀模型返回
 * 同一个 token"，正好掩盖了这个错误；修正夹具后才暴露。）
 */
import { postJson } from '../util/http.mjs'
import { readText } from '../util/fsx.mjs'
import { join } from 'node:path'

/** 与 quantization / tuning 保持同一个容差口径（nats）。 */
export const UNIFORM_TOL_NATS = 1e-4

/** 默认探针文本：让模型必须做一次真实前向；内容不重要，重要的是要有多 token 的分布。 */
export const DEFAULT_USABILITY_PROMPT = 'The quick brown fox jumps over the lazy dog. In a distant country, the'
export const DEFAULT_MAX_TOKENS = 8

/** 从模型目录的 config.json 读 vocab_size。取不到返回 null（**不猜**）。 */
export async function readVocabSize(modelPath) {
  if (!modelPath) return null
  const raw = await readText(join(modelPath, 'config.json'), null)
  if (!raw) return null
  try {
    const cfg = JSON.parse(raw)
    const v = cfg?.vocab_size ?? cfg?.text_config?.vocab_size ?? null
    return Number.isFinite(v) && v > 0 ? Number(v) : null
  } catch {
    return null
  }
}

/**
 * 对端点做一次打分，收集"模型是否真的在算"的证据。**纯观测，不下结论。**
 *
 * 用 `echo: true` + `logprobs: 1`：这样返回的 `token_logprobs` 是**提示词本身**的
 * 逐 token 对数似然（首元素为 null，OpenAI 兼容约定）。相比只看生成文本，
 * 打分能直接给出分布 —— 均匀输出时每个 token 都是 ln(1/V)。
 */
export async function scoreModelUsability(runtime, {
  endpoint,
  model,
  modelPath = null,
  prompt = DEFAULT_USABILITY_PROMPT,
  maxTokens = DEFAULT_MAX_TOKENS,
  timeoutMs = 60_000,
  signal = null,
} = {}) {
  const started = Date.now()
  const fwd = await postJson(`${endpoint}/v1/completions`, {
    model,
    prompt,
    max_tokens: maxTokens,
    temperature: 0,
    echo: true,
    // 取 5 条候选而不是 1 条：多出来的 top_logprobs 让"top1−top2 间隔"成为一个
    // **不需要 vocab_size 就能算**的独立否证。
    logprobs: 5,
  }, { timeoutMs, signal })

  if (!fwd.ok || fwd.status !== 200) {
    return {
      ok: false, probed: false, ms: Date.now() - started,
      error: fwd.ok ? `HTTP ${fwd.status}` : (fwd.error ?? 'unknown'),
      detail: fwd.ok ? String(fwd.body ?? '').slice(0, 300) : null,
    }
  }

  const choice = fwd.json?.choices?.[0] ?? null
  const lp = choice?.logprobs ?? null
  const rawLogprobs = lp?.token_logprobs ?? null
  // 首元素按约定是 null（没有上一个 token），其余是本题的真打分
  const scoredTokens = Array.isArray(rawLogprobs) ? rawLogprobs.filter((x) => typeof x === 'number' && Number.isFinite(x)) : []
  const nll = scoredTokens.map((x) => -x)

  const meanNll = nll.length ? nll.reduce((a, b) => a + b, 0) / nll.length : null
  const itemRange = nll.length ? Math.max(...nll) - Math.min(...nll) : null

  /**
   * top1 − top2 的最大间隔。**均匀输出时恒为 0**（所有候选都等于 1/V，取对数后仍相等）。
   *
   * 这里刻意**不用**「不同 token 的个数」当判据 —— 那是个陷阱：
   * `echo: true` 返回的 tokens 主要是**提示词自己的 token**，而提示词是固定的，
   * 所以无论模型好坏，那个"不同 token 数"都差不多。它测的是提示词的多样性，
   * 不是模型的健康度。（我第一版就写成了这个，被自己的夹具照出来了。）
   */
  const topLogprobs = Array.isArray(lp?.top_logprobs) ? lp.top_logprobs : null
  let topMargin = null
  if (topLogprobs) {
    const margins = []
    for (const entry of topLogprobs) {
      if (!entry) continue
      const vals = Object.values(entry).filter((x) => typeof x === 'number' && Number.isFinite(x))
      if (vals.length >= 2) {
        const sorted = [...vals].sort((a, b) => b - a)
        margins.push(sorted[0] - sorted[1])
      }
    }
    if (margins.length) topMargin = Math.max(...margins)
  }

  const vocabSize = await readVocabSize(modelPath)
  const uniformLoss = vocabSize ? Math.log(vocabSize) : null
  const uniformGap = (meanNll !== null && uniformLoss !== null) ? Math.abs(meanNll - uniformLoss) : null

  /**
   * 判据分两档，这个区分很重要：
   *   mustRun        —— 没跑到就等于"没验"，**不能算通过**
   *   confirmatory   —— 依赖外部信息（vocab / top_logprobs），缺席记为 skipped，
   *                     不因此判失败，但会在结论里写明"少了一条否证"
   */
  const checks = []
  checks.push({
    name: 'scored', tier: 'mustRun',
    ok: nll.length >= 4, skipped: false,
    detail: `拿到 ${nll.length} 个打分 token（需 ≥ 4）`,
  })
  checks.push({
    name: 'item-variance', tier: 'mustRun',
    // **主力判据，且不需要 vocab**：健康模型对不同 token 的意外程度不同，极差 ≈ 3；
    // 均匀输出时每个 token 都是 ln(V)，极差恒为 0（真机实测就是这么分的）。
    ok: itemRange === null ? false : itemRange > 0, skipped: itemRange === null,
    detail: itemRange === null ? '无打分 token' : `逐 token NLL 极差 = ${itemRange.toFixed(6)}（均匀输出时恒为 0）`,
  })
  checks.push({
    name: 'not-uniform', tier: 'confirmatory',
    ok: uniformGap === null ? null : uniformGap > UNIFORM_TOL_NATS,
    skipped: uniformGap === null,
    detail: uniformGap === null
      ? '未取到 vocab_size（缺 config.json 或无该字段）→ 该条否证缺席，不作判定'
      : `|meanNll − ln(V)| = ${uniformGap.toExponential(3)}（V=${vocabSize}，容差 ${UNIFORM_TOL_NATS}）`,
  })
  checks.push({
    name: 'top-margin', tier: 'confirmatory',
    ok: topMargin === null ? null : topMargin > 0, skipped: topMargin === null,
    detail: topMargin === null
      ? '响应未含 top_logprobs → 该条否证缺席，不作判定'
      : `top1−top2 最大间隔 = ${topMargin.toFixed(6)}（均匀输出时恒为 0）`,
  })

  const mustRunFailed = checks.filter((c) => c.tier === 'mustRun' && !c.ok)
  const confirmFailed = checks.filter((c) => c.tier === 'confirmatory' && c.skipped === false && c.ok === false)
  const skipped = checks.filter((c) => c.skipped).map((c) => c.name)
  const failed = [...mustRunFailed, ...confirmFailed]

  /**
   * 结论分三档，**不能混**：
   *   - `probe-inconclusive`：连 mustRun 都没跑成（"测不了"）。
   *     此时其它判据必然也全灭，但它们是被"没数据"带灭的，**不是模型退化的证据**；
   *     混为一谈会把"探针没法用"误报成"模型坏了"，那是另一种形式的假阳性。
   *   - `degenerate-uniform-output`：拿到了打分，但分布退化（真事故形态）
   *   - `model-participates-in-forward`：判据全过（**只说明权重参与了前向**，不是质量评测）
   */
  const mustRunOk = mustRunFailed.length === 0
  const scoredOk = checks.find((c) => c.name === 'scored').ok
  let verdict
  if (failed.length === 0) verdict = 'model-participates-in-forward'
  // 连打分都没拿到 → "测不了"，这不是模型退化的证据（其它判据是被"没数据"带灭的）
  else if (!scoredOk) verdict = 'probe-inconclusive'
  else verdict = 'degenerate-uniform-output'

  return {
    ok: failed.length === 0,
    probed: true,
    ms: Date.now() - started,
    metrics: {
      tokensScored: nll.length,
      meanNll, vocabSize, uniformLoss, uniformGap,
      itemRange, topMargin, skippedChecks: skipped,
      perplexity: meanNll === null ? null : Math.exp(meanNll),
      sample: String(choice?.text ?? '').slice(0, 120),
    },
    checks,
    failedChecks: failed.map((c) => c.name),
    skippedChecks: skipped,
    /** 命中"均匀输出"签名时给出**可直接引用的算术证据**，而不是一句"看起来不对" */
    verdict,
  }
}

/**
 * 就绪判据：把上面的观测折成一个布尔 + 一段人能读懂的理由。
 * **探测本身失败（连不上/超时）与"模型退化"要分开** —— 前者是 E_HEALTH_FAILED 的范畴。
 */
export function judgeUsability(scored) {
  if (!scored?.probed) {
    return { ok: false, reason: 'probe-unavailable', detail: scored?.error ?? '探针未能完成' }
  }
  if (scored.ok) return { ok: true, reason: 'usable', detail: '模型确实参与了前向（非均匀输出）' }
  return {
    ok: false,
    reason: scored.verdict,
    detail: scored.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join('；'),
  }
}
