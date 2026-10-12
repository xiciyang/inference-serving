/**
 * 关 4（模型可用性）的单元测试。
 *
 * 判据的价值全在**能不能把真机事故那种模型认出来**，所以这里的夹具不模拟"返回值"，
 * 而是模拟**对方的语义模型**：
 *   - 健康模型 → 不同 token 的意外程度不同（逐 token NLL 极差大），top1−top2 有间隔
 *   - 残缺模型（`model.norm.weight` 整块为零）→ logits 恒为 0 → softmax 均匀
 *     → 每个 token 的 logprob 都等于 `-ln(V)`，极差为 0，top1−top2 间隔为 0
 * 后者不是编出来的：真机上量到的就是 `meanNll = 11.93121445743442 = ln(151936)`。
 *
 * ⚠️ 夹具的两个关键点（第一版都写错了，是它们掩盖了判据本身的缺陷）：
 *   1. `echo: true` 时，`tokens` 里主要是**提示词自己的 token** —— 提示词固定，
 *      所以"不同 token 个数"与模型好坏无关。夹具必须让它**看起来就像真的 echo**，
 *      否则会误导判据设计。这里是照实模拟的。
 *   2. 均匀模型的 `top_logprobs` 各项**相等**（都等于 ln(1/V)），不是"只有一个候选"。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  scoreModelUsability, judgeUsability, readVocabSize,
  UNIFORM_TOL_NATS, DEFAULT_USABILITY_PROMPT,
} from '../../src/probe/usability.mjs'

const VOCAB = 151936
const UNIFORM_LOGPROB = -Math.log(VOCAB) // ≈ -11.931214658529285

/** 起一个假的 OpenAI 兼容端点。`mode` 决定它模拟哪种模型。 */
async function fakeEndpoint(mode, { tokens = 12 } = {}) {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const req_ = (() => { try { return JSON.parse(body) } catch { return {} } })()
      const wantEcho = req_.echo === true
      // echo=true 时返回的 tokens 主要是**提示词自己的 token** —— 与模型好坏无关。
      // 夹具照实模拟这一点，免得再被"不同 token 个数"那种伪判据骗一次。
      const promptTokens = ['The', 'quick', 'brown', 'fox', 'jumps', 'over', 'the', 'lazy', 'dog', '.', 'In', 'a']
      let tokenLogprobs
      let topLogprobs
      const tok = promptTokens.slice(0, Math.max(4, tokens))
      if (mode === 'healthy') {
        // 不同 token 的意外程度不同 → 极差大；top1−top2 有正间隔
        tokenLogprobs = [null, ...tok.slice(1).map((_, i) => -(1.5 + i * 0.37))]
        topLogprobs = tokenLogprobs.map((v, i) => (i === 0 || v === null ? null : {
          [tok[i]]: v, ' alt': v - (0.8 + i * 0.05), ' other': v - 1.9,
        }))
      } else if (mode === 'uniform') {
        // 残缺模型：logits 恒为 0 → softmax 均匀 → 每个 token 都是 -ln(V)，
        // 且 top-k 之间**彼此相等**（这才是均匀分布的样子）
        tokenLogprobs = [null, ...tok.slice(1).map(() => UNIFORM_LOGPROB)]
        topLogprobs = tokenLogprobs.map((v, i) => (i === 0 || v === null ? null : {
          the: v, a: v, of: v, to: v, and: v,
        }))
      } else if (mode === 'no-logprobs') {
        tokenLogprobs = []
        topLogprobs = null
      } else {
        tokenLogprobs = null
        topLogprobs = null
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        choices: [{
          text: 'x'.repeat(20),
          finish_reason: 'length',
          logprobs: wantEcho
            ? { tokens: tok, token_logprobs: tokenLogprobs, top_logprobs: topLogprobs }
            : null,
        }],
      }))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { endpoint: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) }
}

async function modelDir(config) {
  const dir = await mkdtemp(join(tmpdir(), 'usability-'))
  if (config !== null) await writeFile(join(dir, 'config.json'), JSON.stringify(config))
  return dir
}

test('usability: 健康模型 → 四条否证全过，判 usable', async () => {
  const ep = await fakeEndpoint('healthy')
  const dir = await modelDir({ vocab_size: VOCAB })
  try {
    const scored = await scoreModelUsability({}, { endpoint: ep.endpoint, model: 'm', modelPath: dir })
    assert.equal(scored.probed, true)
    assert.equal(scored.ok, true, JSON.stringify(scored.checks, null, 1))
    assert.equal(scored.verdict, 'model-participates-in-forward')
    // 判据 2 的关键量：|meanNll - ln(V)| 必须显著大于容差
    assert.ok(scored.metrics.uniformGap > UNIFORM_TOL_NATS)
    assert.ok(scored.metrics.itemRange > 0)
    assert.ok(scored.metrics.topMargin > 0)
    assert.deepEqual(scored.skippedChecks, [], '健康路径上不应有判据缺席')
    assert.equal(judgeUsability(scored).ok, true)
  } finally { await ep.close(); await rm(dir, { recursive: true, force: true }) }
})

test('usability: 均匀输出（真机事故形态）→ 判 degenerate，且给出算术证据', async () => {
  const ep = await fakeEndpoint('uniform')
  const dir = await modelDir({ vocab_size: VOCAB })
  try {
    const scored = await scoreModelUsability({}, { endpoint: ep.endpoint, model: 'm', modelPath: dir })
    assert.equal(scored.ok, false)
    assert.equal(scored.verdict, 'degenerate-uniform-output')
    // 复刻真机量到的数字：meanNll == ln(151936)
    assert.ok(Math.abs(scored.metrics.meanNll - Math.log(VOCAB)) < 1e-9,
      `meanNll=${scored.metrics.meanNll} 应等于 ln(${VOCAB})=${Math.log(VOCAB)}`)
    assert.equal(scored.metrics.itemRange, 0, '均匀输出时逐条极差必须为 0')
    assert.equal(scored.metrics.topMargin, 0, '均匀输出时 top1−top2 间隔必须为 0')
    const failed = scored.failedChecks
    assert.ok(failed.includes('not-uniform'))
    assert.ok(failed.includes('item-variance'))
    assert.ok(failed.includes('top-margin'))
    const judged = judgeUsability(scored)
    assert.equal(judged.ok, false)
    assert.equal(judged.reason, 'degenerate-uniform-output')
  } finally { await ep.close(); await rm(dir, { recursive: true, force: true }) }
})

test('usability: 无 config.json（vocab 未知）→ not-uniform 缺席，但 mustRun 判据仍能独立下结论', async () => {
  const ep = await fakeEndpoint('healthy')
  const dir = await modelDir(null)
  try {
    const scored = await scoreModelUsability({}, { endpoint: ep.endpoint, model: 'm', modelPath: dir })
    const notUniform = scored.checks.find((c) => c.name === 'not-uniform')
    assert.equal(notUniform.skipped, true)
    assert.equal(notUniform.ok, null, '缺席的判据不表态，既不是通过也不是失败')
    assert.match(notUniform.detail, /缺席/)
    // 主力判据（不需要 vocab）成立 → 仍然可以判"模型参与了前向"，但要写明少了一条否证
    assert.equal(scored.ok, true)
    assert.deepEqual(scored.skippedChecks, ['not-uniform'])
  } finally { await ep.close(); await rm(dir, { recursive: true, force: true }) }
})

test('usability: **不缺 vocab 时**均匀模型照样被认出来（不能靠"缺字段"蒙混）', async () => {
  const ep = await fakeEndpoint('uniform')
  const dir = await modelDir({ vocab_size: VOCAB })
  try {
    const scored = await scoreModelUsability({}, { endpoint: ep.endpoint, model: 'm', modelPath: dir })
    assert.equal(scored.ok, false)
    assert.equal(scored.verdict, 'degenerate-uniform-output')
    // 三条独立否证同时成立，且都能给出算术证据
    assert.deepEqual(scored.failedChecks.sort(), ['item-variance', 'not-uniform', 'top-margin'])
  } finally { await ep.close(); await rm(dir, { recursive: true, force: true }) }
})

test('usability: 响应里没有 logprobs → 判 probe 无结论，不与"模型坏"混淆', async () => {
  const ep = await fakeEndpoint('no-logprobs')
  const dir = await modelDir({ vocab_size: VOCAB })
  try {
    const scored = await scoreModelUsability({}, { endpoint: ep.endpoint, model: 'm', modelPath: dir })
    assert.equal(scored.probed, true)
    assert.equal(scored.ok, false)
    // 拿到 0 个打分 token 属于"测不了"
    assert.equal(scored.verdict, 'probe-inconclusive')
  } finally { await ep.close(); await rm(dir, { recursive: true, force: true }) }
})

test('usability: 端点连不上 → probed=false（属于 E_HEALTH_FAILED 的范畴）', async () => {
  const scored = await scoreModelUsability({}, { endpoint: 'http://127.0.0.1:1', model: 'm', timeoutMs: 2_000 })
  assert.equal(scored.probed, false)
  const judged = judgeUsability(scored)
  assert.equal(judged.ok, false)
  assert.equal(judged.reason, 'probe-unavailable')
})

test('usability: readVocabSize 只认真的数字，不猜', async () => {
  const withV = await modelDir({ vocab_size: VOCAB })
  const nested = await modelDir({ text_config: { vocab_size: 32000 } })
  const none = await modelDir({ hidden_size: 1536 })
  const broken = await modelDir(null)
  try {
    assert.equal(await readVocabSize(withV), VOCAB)
    assert.equal(await readVocabSize(nested), 32000)
    assert.equal(await readVocabSize(none), null)
    assert.equal(await readVocabSize(broken), null)
    assert.equal(await readVocabSize(null), null)
  } finally {
    for (const d of [withV, nested, none, broken]) await rm(d, { recursive: true, force: true })
  }
})

test('usability: 默认探针文本非空且够长（要能产生多 token 的分布）', () => {
  assert.ok(typeof DEFAULT_USABILITY_PROMPT === 'string')
  assert.ok(DEFAULT_USABILITY_PROMPT.split(/\s+/).length >= 10)
})
