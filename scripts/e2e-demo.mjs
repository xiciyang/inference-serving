#!/usr/bin/env node
/**
 * 真机端到端验收演示（`npm run demo`）。
 *
 * 用真实 Docker + NVIDIA GPU 跑完整闭环，并把过程写成机器可读的 JSON + 人类可读的 markdown，
 * 供 DEPLOYMENT_REPORT.md 引用。
 *
 * 覆盖验收标准：
 *   5.1.1 正常部署   5.1.2 自动降级（≥3 种配置）   5.1.3 幂等
 *   5.1.4 回退       5.1.5 清理                   5.1.6 审计
 *   5.1.7 故障隔离   5.1.9 独立自闭环
 *
 * 用法：
 *   node scripts/e2e-demo.mjs [--model PATH] [--quick] [--out DIR]
 *     --quick  跳过"第二次部署 + 回退"（少起两次容器，约省 3 分钟）
 */
import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'
import * as api from '../src/api.mjs'
import { getSandboxProbe } from '../src/sandbox.mjs'

const argv = process.argv.slice(2)
const getArg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d }
const has = (k) => argv.includes(k)

const MODEL = getArg('--model', process.env.DSH_DEMO_MODEL || '')
if (!MODEL) { console.error('缺少 --model：请给出本地模型路径，例如 --model /path/to/models/<model>'); process.exit(2) }
const QUICK = has('--quick')
const OUT = resolve(getArg('--out', join(process.cwd(), 'demo-out')))
const PORT = Number(getArg('--port', '8120'))

const t0 = Date.now()
const steps = []
const notes = []

function log(msg) {
  process.stdout.write(`${msg}\n`)
}

function record(name, data) {
  steps.push({ name, atMs: Date.now() - t0, ...data })
}

async function timed(name, fn) {
  const s = Date.now()
  log(`\n\u001b[1m▶ ${name}\u001b[0m`)
  try {
    const out = await fn()
    record(name, { ok: true, ms: Date.now() - s, detail: summarize(out) })
    return out
  } catch (err) {
    record(name, { ok: false, ms: Date.now() - s, error: String(err?.message ?? err) })
    throw err
  }
}

function summarize(o) {
  if (!o || typeof o !== 'object') return o ?? null
  const { report, warnings, ...rest } = o
  return {
    ...rest,
    ...(report
      ? {
          durationMs: report.durationMs,
          outcome: report.outcome,
          attempts: report.attempts?.length,
          tiers: report.attempts?.map((a) => `${a.tier}${a.failureCode ? `(${a.failureCode})` : ''}`),
          degradeSteps: report.degrade?.steps,
          lossy: report.degrade?.lossy,
        }
      : {}),
    warnings: warnings?.length ?? 0,
  }
}

/**
 * 带确认令牌的多段式调用：演示**真实的确认流程**，而不是绕过它。
 *
 * 本插件有多道会要求确认的门（R2 风险确认、license 确认、rollback/teardown 各自的 R2 确认），
 * 它们都用同一个 `details.confirmToken` 字段，令牌互不相同（风险令牌绑定目标指纹，
 * license 令牌绑定模型）。调用方要做的就是把已获得的令牌**累积起来**一起带上，直到成功、
 * 或拿到一个再也推不动的错误。
 *
 * 注意 rollback 也走这里：它内部是同一条部署路径，因此同样受这些门约束 —— 这是刻意的
 * （回退会真的重启一个实例，理应过同样的闸门）。
 */
async function callWithConfirm(invoke, opts = {}) {
  const tokens = [...[].concat(opts.confirm ?? [])]
  for (let round = 0; round < 6; round += 1) {
    const out = await invoke(tokens)
    if (out.ok) return out
    const token = out.details?.confirmToken
    if (!token || tokens.includes(token)) return out
    log(`  \u001b[33m需确认\u001b[0m ${out.code} → confirmToken=${token}`)
    tokens.push(token)
  }
  return invoke(tokens)
}

const deployWithConfirm = (input, opts) =>
  callWithConfirm((tokens) => api.deploy(input, { ...opts, confirm: tokens }), opts)

async function main() {
  await fs.mkdir(OUT, { recursive: true })
  const opts = { options: { headless: false, bindHost: '127.0.0.1', portPoolStart: 8100, portPoolEnd: 8199 } }

  // --reset：先拆掉此前遗留的端点并回收孤儿载体，让本次演示从干净状态开始
  if (has('--reset')) {
    await timed('reset（清理此前遗留的端点与孤儿载体）', async () => {
      const existing = await api.listEndpoints({}, opts)
      const torn = []
      for (const e of existing.endpoints ?? []) {
        if (e.status === 'torn_down') continue
        // eslint-disable-next-line no-await-in-loop
        const r = await callWithConfirm((tokens) => api.teardown({ selector: e.id, confirm: tokens }, opts), opts)
        torn.push({ id: e.id, ok: r.ok === true, code: r.code ?? null })
      }
      const rec = await callWithConfirm((tokens) => api.reconcile({ reap: true }, { ...opts, confirm: tokens }), opts)
      // 把注册表归档，让本次演示从"零端点、零 revision"开始（历史仍保留在备份里）
      const { promises: fsp } = await import('node:fs')
      const { join: pjoin } = await import('node:path')
      const { homedir } = await import('node:os')
      const regFile = pjoin(homedir(), '.ai-infra', 'state', 'serving-registry.yaml')
      let archived = null
      try {
        const st = await fsp.stat(regFile)
        if (st.isFile()) {
          archived = `${regFile}.bak-demo-${Date.now()}`
          await fsp.rename(regFile, archived)
        }
      } catch { /* 不存在则无需归档 */ }
      log(`  已拆解 ${torn.length} 个端点；回收孤儿载体 ${rec.reaped?.length ?? 0} 个${archived ? '；注册表已归档' : ''}`)
      return { torn, reaped: rec.reaped?.length ?? 0, archived }
    })
  }

  log('\u001b[1m══ inference-serving 端到端验收演示 ══\u001b[0m')
  log(`模型：${MODEL}`)
  log(`端口池：127.0.0.1:8100-8199    快速模式：${QUICK}`)

  // ---------- 0. 环境自检 ----------
  const doc = await timed('doctor：环境与能力自检', () => api.doctor({ deep: false }))
  const caps = doc.environment.capabilities
  log(`  GPU        ${doc.environment.gpu?.[0]?.name}${caps.unifiedMemory ? ' [统一内存]' : ''}`)
  log(`  可用内存   ${(caps.availableMemoryBytes / 1024 ** 3).toFixed(1)} GiB ${caps.memoryIsEstimate ? '(估算)' : ''}`)
  log(`  Docker     ${doc.environment.container.available ? '✓' : '✗'} ${doc.environment.container.detail ?? ''}`)
  log(`  沙箱       进程=${doc.sandbox.process.available ? '✓' : '✗'} 容器=${doc.sandbox.container.available ? '✓' : '✗'} VM=${doc.sandbox.vm.available ? '✓' : '✗'}`)
  notes.push(`沙箱三层实测：进程级 ${doc.sandbox.process.available ? '可用' : '不可用'}（${doc.sandbox.process.detail}）；容器级 ${doc.sandbox.container.available ? '可用' : '不可用'}；VM 级 ${doc.sandbox.vm.available ? '可用' : '不可用'}（${doc.sandbox.vm.detail}）。`)

  if (!doc.environment.container.available || !doc.environment.container.nvidiaRuntime) {
    throw new Error('本机不具备容器级 + nvidia runtime，无法做真机部署演示')
  }

  // ---------- 1. 部署（含自动降级） ----------
  // 故意把 gpu-memory-utilization 设到 0.95：vLLM 会申请 113 GiB，
  // 而宿主实际可给约 95 GiB → 预检判定 E_INSUFFICIENT_MEMORY → 降级链介入。
  const deployInput = { model: MODEL, options: { port: PORT, gpuMemoryUtilization: 0.95 } }
  const d1 = await timed('deploy（故意把内存额度设为 0.95，触发自动降级）', () => deployWithConfirm(deployInput, opts))
  if (!d1.ok) throw new Error(`部署失败：${d1.code} ${d1.message}`)
  const ep1 = d1.endpoint
  log(`  \u001b[32m✓ 端点就绪\u001b[0m ${ep1.endpoint}`)
  log(`  耗时 ${(d1.report.durationMs / 1000).toFixed(1)}s    尝试 ${d1.report.attempts.length} 次    降级 ${d1.report.degrade.steps} 步`)
  for (const a of d1.report.attempts) {
    log(`    · 第 ${a.attempt} 次 [${a.tier}] preflight=${a.preflightOk === null ? '-' : a.preflightOk} launched=${a.launched} ${a.failureCode ? `失败=${a.failureCode}` : '成功'}`)
  }
  if (d1.report.degrade.lossy) notes.push('本次演示用到了**有损**精度档。')
  notes.push(`降级链实测：从 gpuMemoryUtilization=0.95 自动降到 ${d1.report.finalConfig.gpuMemoryUtilization}，`
    + `共 ${d1.report.attempts.length} 次尝试（${d1.report.attempts.map((a) => a.tier).join(' → ')}）。`)

  // ---------- 2. 幂等 ----------
  // 幂等的前提是"同一模型 + **同一配置**"：必须原样重放第一次的输入，
  // 否则（按设计）会被当成新 revision 重新部署 —— 那是更新，不是幂等。
  const d2 = await timed('deploy 第二次（原样重放，幂等验证）', () => deployWithConfirm(deployInput, opts))
  log(`  reused=${d2.reused}  端点=${d2.endpoint?.endpoint}`)
  if (!d2.ok) throw new Error(`第二次部署失败：${d2.code} ${d2.message}`)
  if (d2.reused !== true) throw new Error(`幂等性未满足：原样重放应复用同一端点，实际 reused=${d2.reused}`)
  if (d2.endpoint.id !== ep1.id) throw new Error('幂等性未满足：端点 id 不一致')

  // ---------- 3. 外部可访问性（前向推理） ----------
  await timed('端点外部可达性 + 真实前向推理', async () => {
    const { postJson, request } = await import('../src/util/http.mjs')
    const models = await request(`${ep1.endpoint}/v1/models`, { timeoutMs: 10_000 })
    const fwd = await postJson(`${ep1.endpoint}/v1/completions`, {
      model: ep1.servedModelName, prompt: 'The capital of France is', max_tokens: 5, temperature: 0,
    }, { timeoutMs: 60_000 })
    const text = fwd.json?.choices?.[0]?.text ?? null
    log(`  /v1/models → HTTP ${models.status}    /v1/completions → HTTP ${fwd.status}  生成=${JSON.stringify(text)}`)
    if (models.status !== 200 || fwd.status !== 200 || text === null) throw new Error('端点不可用或前向失败')
    return { modelsStatus: models.status, forwardStatus: fwd.status, generated: text }
  })

  // ---------- 4. 故障隔离（server 活着） ----------
  const iso = await timed('故障隔离：一次失败不影响后续调用', async () => {
    const bad = await callWithConfirm(
      (tokens) => api.deploy({ model: '/definitely/not/a/model' }, { ...opts, confirm: tokens }), opts)
    log(`  故意失败的部署 → ${bad.code}`)
    const still = await api.listEndpoints({}, opts)
    if (!still.ok || still.count < 1) throw new Error('失败之后端点列表不可用')
    return { failedCode: bad.code, endpointsStillListed: still.count }
  })
  if (iso.failedCode !== 'E_MODEL_UNRESOLVED') notes.push(`故障隔离演示中的失败码为 ${iso.failedCode}。`)

  // ---------- 5. 回退 ----------
  let rollbackInfo = null
  if (!QUICK) {
    const d3 = await timed('deploy 用不同配置（产生 revision 2，为回退做准备）', () => deployWithConfirm({ model: MODEL, options: { ...deployInput.options, maxModelLen: 2048 } }, opts))
    if (!d3.ok) throw new Error(`第二次部署失败：${d3.code}`)
    log(`  revision=${d3.endpoint.revision}  端口=${d3.endpoint.port}  maxModelLen=${d3.endpoint.config?.maxModelLen}`)

    const rb = await timed('rollback（回退到上一个已验证版本）', () =>
      callWithConfirm((tokens) => api.rollback({ selector: ep1.id, confirm: tokens }, opts), opts))
    if (!rb.ok) throw new Error(`回退失败：${rb.code} ${rb.message}`)
    log(`  \u001b[32m✓ 已回退\u001b[0m 到 revision ${rb.rolledBackTo}，新端点 ${rb.endpoint?.endpoint}`)
    rollbackInfo = rb
    notes.push(`回退实测：从 revision ${rollbackInfo.rolledBackTo + 1} 回退到 revision ${rollbackInfo.rolledBackTo}。`)
  }

  // ---------- 6. 状态（实机核对） ----------
  const st = await timed('status（含实机核对）', () => api.status({ selector: ep1.id, deep: true }, opts))
  const view = Array.isArray(st.endpoints) ? st.endpoints[0] : st.endpoints
  log(`  一致性 ${view?.consistency?.ok ? '✓' : '✗'} ${view?.consistency?.message ?? ''}`)
  if (view && view.consistency && view.consistency.ok === false) throw new Error(`注册表与实机不一致：${view.consistency.message}`)

  // ---------- 7. 清理 ----------
  const td1 = await timed('teardown（拆解 + 逐项验证无残留）', () =>
    callWithConfirm((tokens) => api.teardown({ selector: ep1.id, confirm: tokens }, opts), opts))
  if (!td1.ok) throw new Error(`teardown 失败：${td1.code} ${td1.message}`)
  for (const c of td1.verification.checks) log(`  ${c.ok ? '\u001b[32m✓\u001b[0m' : '\u001b[31m✗\u001b[0m'} ${c.name}: ${c.detail}`)
  if (!td1.verification.clean) throw new Error('teardown 后仍有残留')
  notes.push(`清理验证：${td1.verification.checks.map((c) => `${c.name}=${c.ok ? 'pass' : 'fail'}`).join('，')}。`)

  // ---------- 8. 审计 ----------
  const av = await timed('audit-verify（哈希链完整性）', () => api.auditVerify({}, opts))
  log(`  审计文件 ${av.files.join(', ')}    链校验 ${av.verification.ok ? '✓' : '✗'}（${av.verification.count} 条）`)
  if (!av.verification.ok) throw new Error(`审计链不完整：${av.verification.reason}`)

  // ---------- 9. 指标 ----------
  const mt = await timed('metrics（耗时 / 资源 / 降级次数）', () => api.metrics({}, opts))
  log(`  部署次数 ${mt.metrics.counters.deploy_attempts}    降级步数 ${mt.metrics.counters.degrade_steps}    最长部署 ${mt.metrics.timings.deploy_ms_max}ms`)

  // ---------- 10. 孤儿对账 ----------
  const rec = await timed('reconcile（孤儿载体对账，只读）', () => api.reconcile({ reap: false }, opts))
  if (!rec.ok) throw new Error(`对账失败：${rec.code} ${rec.message}`)
  log(`  孤儿载体 ${rec.orphans.length} 个；本插件管理的载体 ${rec.managed?.length ?? 0} 个`)
  if (rec.orphans.length !== 0) notes.push(`对账发现 ${rec.orphans.length} 个孤儿载体（正常收尾应为 0）。`)

  // ---------- 收尾 ----------
  const summary = {
    schema: 'inference-serving/e2e-demo@1',
    ranAt: new Date().toISOString(),
    model: MODEL,
    quick: QUICK,
    totalMs: Date.now() - t0,
    steps,
    notes,
    endpoint: ep1,
    finalRegistry: (await api.listEndpoints({}, opts)).endpoints,
    sandbox: await getSandboxProbe(),
  }
  await fs.writeFile(join(OUT, 'e2e-demo.json'), `${JSON.stringify(summary, null, 2)}\n`)
  await fs.writeFile(join(OUT, 'e2e-demo.md'), renderMarkdown(summary))

  log(`\n\u001b[32m\u001b[1m══ 演示完成 ══\u001b[0m  总耗时 ${(summary.totalMs / 1000).toFixed(1)}s`)
  log(`产物：${join(OUT, 'e2e-demo.json')}`)
  log(`      ${join(OUT, 'e2e-demo.md')}`)
}

function renderMarkdown(s) {
  const L = []
  L.push('# inference-serving 端到端演示（真机）')
  L.push('')
  L.push(`- 时间：${s.ranAt}`)
  L.push(`- 模型：\`${s.model}\``)
  L.push(`- 总耗时：${(s.totalMs / 1000).toFixed(1)}s`)
  L.push(`- 快速模式：${s.quick}`)
  L.push('')
  L.push('## 步骤')
  L.push('')
  L.push('| 步骤 | 结果 | 耗时 | 摘要 |')
  L.push('|---|---|---:|---|')
  for (const st of s.steps) {
    const d = st.detail && typeof st.detail === 'object' ? JSON.stringify(st.detail) : String(st.detail ?? '')
    L.push(`| ${st.name} | ${st.ok ? '✅' : '❌'} | ${(st.ms / 1000).toFixed(1)}s | \`${d.slice(0, 220)}\` |`)
  }
  L.push('')
  L.push('## 结论要点')
  L.push('')
  for (const n of s.notes) L.push(`- ${n}`)
  L.push('')
  return `${L.join('\n')}\n`
}

main().catch((err) => {
  process.stderr.write(`\n\u001b[31m演示失败：${err?.message ?? err}\u001b[0m\n`)
  if (err?.stack) process.stderr.write(`${err.stack}\n`)
  fs.mkdir(OUT, { recursive: true })
    .then(() => fs.writeFile(join(OUT, 'e2e-demo-error.json'), `${JSON.stringify({ error: String(err?.message ?? err), steps }, null, 2)}\n`))
    .finally(() => process.exit(1))
})
