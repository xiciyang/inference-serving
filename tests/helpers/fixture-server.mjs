/**
 * 测试替身服务：一个最小的 OpenAI 兼容端点。
 * 被测代码不认识它 —— 它只是"某个后端拉起来的服务"。
 *
 * ## 为什么它必须"像真的"
 *
 * 关 4（模型可用性）判的是**输出分布**，所以替身必须把分布的语义也模拟出来，
 * 而不只是把响应结构填对。三个模式对应三种真实的模型状态：
 *
 *   ok       健康模型：不同 token 的意外程度不同（逐 token NLL 极差 ≈ 3），
 *            `top_logprobs` 里 top1 与 top2 有正间隔
 *   uniform  **残缺模型**（`model.norm.weight` 整块为零）：logits 恒为 0 →
 *            softmax 均匀 → 每个 token 的 logprob 都是 `-ln(V)`，极差为 0，
 *            且 top-k 之间**彼此相等**（这才是均匀分布的样子，不是"只有一个候选"）
 *   broken   端点直接 500（关 2 的失败形态）
 *
 * `echo: true` 时返回的 `tokens` 主要是**提示词自己的 token** —— 提示词固定，
 * 所以"不同 token 的个数"与模型好坏无关。替身照实模拟这一点，
 * 免得判据设计再被那种伪信号骗一次（本项目已经栽过一次）。
 */
import http from 'node:http'

const argv = process.argv.slice(2)
const get = (k, d) => {
  const i = argv.indexOf(k)
  return i >= 0 ? argv[i + 1] : d
}

const port = Number(get('--port', '0'))
const name = get('--name', 'fake-model')
const mode = get('--mode', 'ok') // ok | uniform | slow | broken
const vocabSize = Number(get('--vocab', '32000'))
const UNIFORM_LOGPROB = -Math.log(vocabSize)

/** 极简"分词"：够用来造出与提示词绑定的 token 序列。 */
function tokenize(prompt) {
  const parts = String(prompt ?? '').trim().split(/\s+/).filter(Boolean)
  return parts.length ? parts : ['<empty>']
}

function buildLogprobs(tok, healthy) {
  const tokenLogprobs = [null, ...tok.slice(1).map((_, i) => (healthy ? -(1.5 + i * 0.37) : UNIFORM_LOGPROB))]
  const topLogprobs = tokenLogprobs.map((v, i) => {
    if (i === 0 || v === null) return null
    if (healthy) return { [tok[i]]: v, alt: v - (0.8 + i * 0.05), other: v - 1.9 }
    // 均匀：所有候选**相等**
    return { the: v, a: v, of: v, to: v, and: v }
  })
  return { tokens: tok, token_logprobs: tokenLogprobs, top_logprobs: topLogprobs }
}

const server = http.createServer((req, res) => {
  if (req.url === '/v1/models') {
    if (mode === 'broken') { res.writeHead(500).end('{}'); return }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data: [{ id: name, object: 'model', root: '/fake' }] }))
    return
  }
  if (req.url === '/v1/completions' && req.method === 'POST') {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      let body = {}
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { /* 保持空 */ }
      const tok = tokenize(body.prompt)
      const healthy = mode !== 'uniform'
      // 只有开了 echo 才回打分；这模仿真实端点：不打分就没有 logprobs 可用
      const logprobs = body.echo === true ? buildLogprobs(tok, healthy) : null
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        id: 'cmpl-fake',
        object: 'text_completion',
        model: name,
        choices: [{
          index: 0,
          text: healthy ? ' Paris' : ' the the the',
          finish_reason: 'length',
          logprobs,
        }],
      }))
    })
    return
  }
  res.writeHead(404).end('{}')
})

if (mode === 'slow') {
  setTimeout(() => server.listen(port, '127.0.0.1'), 60_000)
} else {
  server.listen(port, '127.0.0.1', () => {
    process.stdout.write(`fixture listening on ${port}\n`)
  })
}

process.on('SIGTERM', () => process.exit(0))
