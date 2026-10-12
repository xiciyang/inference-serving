/**
 * 健康检查（题目 §4.2「健康检查（加载 / 前向 / 端点响应）」，验收标准 5.1.1）。
 *
 * 四关全过才算健康 —— **端点响应 200 不等于模型能用，返回了 choices 也不等于**：
 *   关 1 加载     容器运行中（docker inspect State.Running）
 *   关 2 端点响应 GET /v1/models 返回 200 且列出了请求的 served-model-name
 *   关 3 前向     真发一次最小推理请求并拿到 choices
 *   关 4 可用性   输出的**分布**不是退化的（复用本项目已固化的均匀输出签名）
 *
 * 关 3 是本插件区别于"只 curl 一下 /health"的地方；但真机事故证明它**还不够**：
 * 一个 `model.norm.weight` 整块为零的残缺模型，关 1/2/3 全过、deploy 返回 ok:true，
 * 下游白跑 436 s。因此补了关 4（见 probe/usability.mjs 顶部的事故记录）。
 */
import { request, postJson, probeTcp } from './util/http.mjs'
import { recordHealth } from './metrics.mjs'
import { getDriver } from './drivers/index.mjs'
import { scoreModelUsability, judgeUsability } from './probe/usability.mjs'

function driverOf(backend) {
  return getDriver(backend?.driver ?? 'docker')
}

// 注意：这个定时器**不能 unref**。健康检查轮询期间事件循环上可能只剩它，
// unref 会让 Node 静默退出（本项目实测踩过，见 cleanup.mjs 顶部的说明）。
const sleep = (ms, signal) => new Promise((resolvePromise, reject) => {
  const t = setTimeout(resolvePromise, ms)
  if (signal) {
    const onAbort = () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })) }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
})

/** 单次健康探测（不重试）。 */
export async function probeOnce(runtime, standard, backend, { endpointOverride = null } = {}) {
  const plan = backend.healthProbe({ standard })
  const base = endpointOverride ?? `http://${standard.bindHost}:${standard.port}`
  const checks = []

  // --- 关 1：载体运行中（走驱动接缝，核心不认识 docker） ---
  const driver = driverOf(backend)
  const t0 = Date.now()
  const st = await driver.inspect(standard.containerName)
  const running = st.exists && st.running
  checks.push({
    name: 'container-running',
    ok: running,
    detail: running ? `status=${st.status}` : (st.exists ? `status=${st.status} exitCode=${st.exitCode ?? '?'}` : `载体不存在：${standard.containerName}`),
    ms: Date.now() - t0,
  })
  if (!running) return { ok: false, checks, ms: checks.reduce((a, c) => a + c.ms, 0), failedAt: 'container-running' }

  // --- 关 2：端点响应 ---
  const t1 = Date.now()
  const models = await request(`${base}${plan.endpointPath}`, { timeoutMs: 10_000 })
  let modelListed = false
  if (models.ok && models.status === 200) {
    try {
      const body = JSON.parse(models.body)
      modelListed = (body.data ?? []).some((d) => d.id === plan.expectsModel)
    } catch { modelListed = false }
  }
  checks.push({
    name: 'endpoint-responding',
    ok: Boolean(models.ok && models.status === 200 && modelListed),
    detail: models.ok
      ? `HTTP ${models.status}${modelListed ? `，已列出 ${plan.expectsModel}` : `，但未列出 ${plan.expectsModel}`}`
      : `连接失败：${models.error ?? 'unknown'}`,
    ms: Date.now() - t1,
  })
  if (!checks[checks.length - 1].ok) return { ok: false, checks, ms: checks.reduce((a, c) => a + c.ms, 0), failedAt: 'endpoint-responding' }

  // --- 关 3：前向 ---
  if (standard.health.forward) {
    const t2 = Date.now()
    const fwd = await postJson(`${base}${plan.forwardPath}`, plan.forwardBody, { timeoutMs: 60_000 })
    const produced = Boolean(fwd.ok && fwd.status === 200 && Array.isArray(fwd.json?.choices) && fwd.json.choices.length > 0)
    checks.push({
      name: 'forward-inference',
      ok: produced,
      detail: produced
        ? `生成 ${fwd.json.choices[0]?.text?.length ?? 0} 字符，finish_reason=${fwd.json.choices[0]?.finish_reason ?? 'n/a'}`
        : (fwd.ok ? `HTTP ${fwd.status}，响应无 choices` : `请求失败：${fwd.error ?? 'unknown'}`),
      ms: Date.now() - t2,
    })
  }
  const forwardFailed = checks.some((c) => c.name === 'forward-inference' && !c.ok)

  // --- 关 4：模型可用性 ---
  //
  // 关 3 只问"有没有 choices"，**这一关问"输出分布是不是退化的"**。
  // 真机事故：残缺模型的容器照常启动、/v1/models 200、choices 结构完好，
  // 于是 deploy 返回 ok:true，下游白跑 436 s。详见 probe/usability.mjs 顶部。
  if (!forwardFailed && standard.health.usability !== false) {
    const t3 = Date.now()
    const scored = await scoreModelUsability(runtime, {
      endpoint: base,
      model: plan.expectsModel,
      modelPath: standard.model?.path ?? null,
      prompt: plan.usabilityPrompt,
      maxTokens: plan.usabilityMaxTokens,
    })
    const judged = judgeUsability(scored)
    checks.push({
      name: 'model-usable',
      ok: judged.ok,
      detail: scored.probed
        ? `${judged.reason}：${judged.detail}`
        : `探针不可用（这属于"测不了"，不是"模型坏"）：${judged.detail}`,
      ms: Date.now() - t3,
      evidence: scored.probed ? scored.metrics : null,
      checks: scored.probed ? scored.checks : null,
    })
  }

  const ok = checks.every((c) => c.ok)
  return { ok, checks, ms: checks.reduce((a, c) => a + c.ms, 0), failedAt: ok ? null : checks.find((c) => !c.ok)?.name }
}

/**
 * 带轮询与总超时的健康检查。
 * 超时同样要**清理**（由调用方负责，见 lifecycle/deploy 的 finally）。
 */
export async function waitForHealthy(runtime, standard, backend, { log = null, signal = null, onProgress = null } = {}) {
  const started = Date.now()
  const deadline = started + standard.timeouts.healthMs
  let last = null
  let attempts = 0

  while (Date.now() < deadline) {
    if (signal?.aborted) throw Object.assign(new Error('健康检查被取消'), { name: 'AbortError' })
    attempts += 1
    // eslint-disable-next-line no-await-in-loop
    last = await probeOnce(runtime, standard, backend)
    log?.phase?.('health', { attempt: attempts, ok: last.ok, failedAt: last.failedAt, ms: last.ms })
    if (onProgress) onProgress(last)
    if (last.ok) {
      await recordHealth(runtime, Date.now() - started, { ok: true })
      return { ...last, attempts, ms: Date.now() - started }
    }
    // 容器已经死了就不必再等
    const containerCheck = last.checks.find((c) => c.name === 'container-running')
    if (containerCheck && !containerCheck.ok) break
    // 关 4 失败是**确定性的**：权重是坏的，再等一万次输出还是均匀分布。
    // 继续轮询只是把"虚假重试"从降级链搬到了健康检查里。
    if (last.failedAt === 'model-usable') break
    // eslint-disable-next-line no-await-in-loop
    await sleep(standard.timeouts.pollMs, signal).catch(() => {})
  }

  await recordHealth(runtime, Date.now() - started, { ok: false })
  return {
    ok: false,
    attempts,
    ms: Date.now() - started,
    checks: last?.checks ?? [],
    failedAt: last?.failedAt ?? 'timeout',
    timedOut: Date.now() >= deadline,
  }
}

/** 收集载体失败证据，交给后端 classifyFailure 定因。 */
export async function collectFailureEvidence(backend, containerName, { tailLines = 80 } = {}) {
  const driver = driverOf(backend)
  const [logs, st] = await Promise.all([
    driver.logs(containerName, { tail: tailLines }),
    driver.inspect(containerName),
  ])
  return {
    stdout: logs.stdout ?? '',
    stderr: logs.stderr ?? '',
    exitCode: st?.exists ? (st.exitCode ?? null) : null,
    combined: logs.combined ?? `${logs.stdout ?? ''}\n${logs.stderr ?? ''}`.trim(),
  }
}

export { probeTcp, sleep }
