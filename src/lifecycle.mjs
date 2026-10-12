/**
 * 生命周期操作：status / list_endpoints / rollback / teardown。
 *
 * 状态冲突一律**显式报错**（对应状态机验证里 78 个 "silently ignores" 警告转成的约束，
 * 见 serving-step0-verification/RESULTS.md §1.4）：
 *   - rollback 无历史 → E_NO_ROLLBACK_TARGET（不是安静地什么都不做）
 *   - teardown 找不到 → E_ENDPOINT_NOT_FOUND
 *   - status / list 在任何状态都可用（只读，不进状态机）
 */
import { run } from './util/proc.mjs'
import { fail, warn, ERROR_CODES, WARNING_CODES } from './errors.mjs'
import { isPortFree } from './util/http.mjs'
import {
  withRegistry, findEndpoint, currentRevision, previousVerifiedRevision,
  addRevision, pushHistory, summarize, liveEndpoints,
} from './state/registry.mjs'
import { cleanupRevision, listManagedInstances, findOrphans, containerNameFor } from './cleanup.mjs'
import { probeOnce } from './health.mjs'
import { getBackend } from './backends/index.mjs'
import { checkOwner } from './state/lease.mjs'
import { getDriver } from './drivers/index.mjs'
import { bump } from './metrics.mjs'
import { deployOperation, buildReport, summarizeEnv } from './deploy.mjs'
import { probeEnvironment } from './probe/env.mjs'

/* ------------------------------------------------------------------ status */

async function containerState(backend, name) {
  if (!name) return { exists: false, running: false }
  try {
    const driver = getDriver(backend?.driver ?? 'docker')
    const st = await driver.inspect(name)
    return st
  } catch (err) {
    return { exists: false, running: false, detail: String(err.message) }
  }
}

/**
 * status：注册表视图 + **实机核对**。二者的差异本身就是最有价值的信息
 * （"注册表说在跑但容器没了"必须被看见，不能只回注册表内容）。
 */
export async function statusOperation(runtime, { selector = null, verify = true, deep = false } = {}) {
  const reg = await withRegistry(runtime, (r) => JSON.parse(JSON.stringify(r)), { backup: false })
  const endpoints = selector ? [findEndpoint(reg, selector)].filter(Boolean) : reg.endpoints
  if (selector && endpoints.length === 0) {
    fail(ERROR_CODES.E_ENDPOINT_NOT_FOUND, `找不到端点：${selector}`, {
      remediation: `可用选择器：端点 id、幂等键、模型路径、served-model-name、端点 URL、容器名。当前注册了 ${reg.endpoints.length} 个端点，可先执行 list_endpoints 查看。`,
      details: { selector, known: reg.endpoints.map((e) => ({ id: e.id, model: e.model, status: e.status })) },
    })
  }

  const views = []
  for (const e of endpoints) {
    const cur = currentRevision(e)
    const view = { ...summarize(e), consistency: null, liveProbe: null, revisionHistory: (e.revisions ?? []).map((r) => ({ rev: r.rev, status: r.status, port: r.port, degradeStep: r.degradeStep, verifiedAt: r.verifiedAt, containerName: r.containerName })) }
    if (verify && cur?.containerName) {
      // eslint-disable-next-line no-await-in-loop
      const st = await containerState(getBackend(e.backend), cur.containerName)
      view.container = st
      const declaredLive = ['serving', 'degraded'].includes(e.status)
      if (declaredLive && !st.running) {
        view.consistency = { ok: false, code: 'E_STATE_CONFLICT', message: `注册表标记 ${e.status}，但容器 ${cur.containerName} ${st.exists ? `未运行（status=${st.status}）` : '不存在'}` }
      } else if (!declaredLive && st.running) {
        view.consistency = { ok: false, code: 'E_STATE_CONFLICT', message: `注册表标记 ${e.status}，但容器仍在运行` }
      } else {
        view.consistency = { ok: true, message: '注册表与实机一致' }
      }
      if (st.running && deep) {
        const backend = getBackend(e.backend)
        // eslint-disable-next-line no-await-in-loop
        view.liveProbe = await probeOnce(runtime, {
          bindHost: cur.bindHost, port: cur.port, containerName: cur.containerName,
          servedModelName: cur.servedModelName, health: { forward: false, usability: false },
        }, backend)
      }
    }
    views.push(view)
  }

  const listed = await listManagedInstances({ includeStopped: true })
  const orphanCheck = await findOrphans(runtime)
  const environment = deep ? summarizeEnv(await probeEnvironment(runtime, { deep: false })) : null

  return {
    ok: true,
    registry: {
      file: runtime.paths.registryFile,
      version: reg.version,
      updatedAt: reg.updatedAt,
      endpointCount: reg.endpoints.length,
      liveCount: liveEndpoints(reg).length,
    },
    endpoints: views,
    machine: {
      managedContainers: listed.containers ?? [],
      orphans: orphanCheck.orphans ?? [],
      orphanCheckOk: orphanCheck.ok === true,
    },
    environment,
    policySources: runtime.policy.sources,
    warnings: runtime.warnings.map((w) => (typeof w.toJSON === 'function' ? w.toJSON() : w)),
  }
}

/* ------------------------------------------------------------ list_endpoints */

export async function listEndpointsOperation(runtime, { status = null } = {}) {
  const reg = await withRegistry(runtime, (r) => JSON.parse(JSON.stringify(r)), { backup: false })
  let eps = reg.endpoints
  if (status) eps = eps.filter((e) => e.status === status)
  return {
    ok: true,
    count: eps.length,
    registryFile: runtime.paths.registryFile,
    endpoints: eps.map(summarize),
    byStatus: reg.endpoints.reduce((acc, e) => { acc[e.status] = (acc[e.status] ?? 0) + 1; return acc }, {}),
  }
}

/* ------------------------------------------------------------------ teardown */

/** 拆解并**验证**没有残留（验收标准 5.1.5）。 */
export async function teardownOperation(runtime, { selector, log = null, ownerToken = null } = {}) {
  const reg = await withRegistry(runtime, (r) => JSON.parse(JSON.stringify(r)), { backup: false })
  const ep = findEndpoint(reg, selector)
  if (!ep) {
    fail(ERROR_CODES.E_ENDPOINT_NOT_FOUND, `找不到要拆解的端点：${selector}`, {
      remediation: `先执行 list_endpoints 查看当前注册的端点（id / 模型路径 / 端点 URL 都可作为选择器）。`,
      details: { selector, known: reg.endpoints.map((e) => e.id) },
    })
  }
  if (ep.status === 'torn_down') {
    // 幂等：重复 teardown 返回同一结果，不报错。
    // 但**顺手清掉可能残留的租约** —— 老版本拆解时不释放租约，
    // 那些历史残留会挡住后续部署（真机踩到过）。
    if (ep.lease) {
      await withRegistry(runtime, (r) => {
        const e = findEndpoint(r, ep.id)
        if (e?.lease) { pushHistory(e, 'lease-released', { owner: e.lease.owner ?? null, reason: 'idempotent-teardown' }); e.lease = null }
        return null
      })
    }
    return { ok: true, alreadyTornDown: true, endpoint: summarize(ep), verification: { clean: true, checks: [{ name: 'already-torn-down', ok: true }] } }
  }

  /**
   * 所有权闸（F-3）：**只拆本租约持有的端点**。
   *
   * 这条检查以前不存在 —— 而 serving 按 model 做键，于是量化收尾时会把
   * 调优正在用的端点一起拆掉（真机集成测试实测）。`E_ENDPOINT_NOT_OWNED`
   * 在此之前只是个从未抛出的常量。
   *
   * 位置刻意放在"已经是 torn_down"的幂等分支**之后**：那一步什么都不销毁，
   * 不构成破坏性操作，因此不该要求凭证（而且它还要负责清掉历史残留的租约）。
   */
  {
    const own = checkOwner({ lease: ep.lease, ownerToken })
    if (!own.ok) {
      fail(ERROR_CODES.E_ENDPOINT_NOT_OWNED, own.message, {
        remediation: own.remediation,
        details: { ...own.details, endpointId: ep.id, selector },
      })
    }
    if (own.mode === 'expired-takeover') {
      log?.warn?.('端点租约已过期，按接管处理', { endpointId: ep.id, owner: ep.lease?.owner ?? null })
    }
  }

  const cleanupResults = []
  for (const rev of ep.revisions ?? []) {
    // eslint-disable-next-line no-await-in-loop
    const r = await cleanupRevision(runtime, { backend: ep.backend, ...rev })
    cleanupResults.push({ rev: rev.rev, containerName: rev.containerName, ...r })
    log?.info('清理 revision', { rev: rev.rev, containerName: rev.containerName, ok: r.ok })
  }

  // 验证：注册表里出现过的容器名都不该再存在
  const names = (ep.revisions ?? []).map((r) => r.containerName).filter(Boolean)
  const residualContainers = []
  for (const n of names) {
    // eslint-disable-next-line no-await-in-loop
    const st = await containerState(getBackend(ep.backend), n)
    if (st.exists) residualContainers.push({ name: n, status: st.status })
  }
  const cur = currentRevision(ep)
  const portFree = cur ? await isPortFree(cur.bindHost, cur.port) : true
  const listed = await listManagedInstances({ includeStopped: true })
  const residualManaged = (listed.containers ?? []).filter((c) => names.includes(c.name))

  const checks = [
    { name: 'containers-removed', ok: residualContainers.length === 0, detail: residualContainers.length === 0 ? `${names.length} 个容器均已删除` : `残留：${residualContainers.map((c) => c.name).join(', ')}` },
    { name: 'port-released', ok: portFree, detail: portFree ? `端口 ${cur?.bindHost}:${cur?.port} 已释放` : `端口 ${cur?.bindHost}:${cur?.port} 仍被占用` },
    { name: 'no-managed-residual', ok: residualManaged.length === 0, detail: residualManaged.length === 0 ? 'docker ps 中无本插件残留' : `残留：${residualManaged.map((c) => c.name).join(', ')}` },
  ]
  const clean = checks.every((c) => c.ok)

  await withRegistry(runtime, (r) => {
    const e = findEndpoint(r, ep.id)
    if (!e) return null
    e.status = 'torn_down'
    e.tornDownAt = new Date().toISOString()
    for (const rev of e.revisions ?? []) rev.status = 'torn_down'
    // **释放租约**：租约说的是"谁现在在用"，端点已经拆了，就没人用了。
    // 不释放的后果（真机照出来的）：下一个 owner 想重新部署同一模型时，
    // 会被一条属于"早已不存在的端点"的租约挡住 —— E_ENDPOINT_LEASED，
    // 而且要等满 1 小时 TTL 才自解。
    if (e.lease) {
      pushHistory(e, 'lease-released', { owner: e.lease.owner ?? null, reason: 'teardown' })
      e.lease = null
    }
    pushHistory(e, 'torn-down', { clean, checks })
    return null
  })
  await bump(runtime, 'teardown')

  if (!clean) {
    runtime.warnings.push(warn(WARNING_CODES.W_RESIDUAL_CLEANUP, `teardown 后仍有残留：${checks.filter((c) => !c.ok).map((c) => c.detail).join('; ')}`, { checks }))
  }

  return {
    ok: true,
    endpoint: { id: ep.id, model: ep.model, status: 'torn_down' },
    cleanupResults,
    verification: { clean, checks },
  }
}

/* ------------------------------------------------------------------ rollback */

/**
 * 回退到**上一个已验证**的 revision，并按它的配置重新部署。
 * 找不到历史 → E_NO_ROLLBACK_TARGET（显式，不静默）。
 */
export async function rollbackOperation(runtime, { selector, log = null, signal = null, ownerToken = null } = {}) {
  const reg = await withRegistry(runtime, (r) => JSON.parse(JSON.stringify(r)), { backup: false })
  const ep = findEndpoint(reg, selector)
  if (!ep) {
    fail(ERROR_CODES.E_ENDPOINT_NOT_FOUND, `找不到要回退的端点：${selector}`, {
      remediation: '先执行 list_endpoints 查看可用端点。',
      details: { selector },
    })
  }
  // 回退同样是一次**就地变更**，所以走同一道所有权闸
  const own = checkOwner({ lease: ep.lease, ownerToken })
  if (!own.ok) {
    fail(ERROR_CODES.E_ENDPOINT_NOT_OWNED, own.message, {
      remediation: own.remediation,
      details: { ...own.details, endpointId: ep.id, selector },
    })
  }
  const target = previousVerifiedRevision(ep)
  if (!target) {
    fail(ERROR_CODES.E_NO_ROLLBACK_TARGET, `端点 ${ep.id} 没有可回退的历史版本`, {
      remediation: `回退需要至少一个更早的、已验证过的 revision。当前 endpoint 有 ${(ep.revisions ?? []).length} 个 revision，已验证的只有 ${(ep.revisions ?? []).filter((r) => r.verifiedAt).length} 个。若刚才是首次部署，没有可回退目标属正常。`,
      details: { endpointId: ep.id, revisions: (ep.revisions ?? []).map((r) => ({ rev: r.rev, verifiedAt: r.verifiedAt, status: r.status })) },
    })
  }
  const cur = currentRevision(ep)

  log?.info('回退', { from: cur?.rev, to: target.rev })
  // 先拆当前
  const cleaned = await cleanupRevision(runtime, { backend: ep.backend, ...(cur ?? {}) })
  await withRegistry(runtime, (r) => {
    const e = findEndpoint(r, ep.id)
    if (!e) return null
    for (const rev of e.revisions ?? []) if (rev.rev === cur?.rev) rev.status = 'rolled_back'
    pushHistory(e, 'rollback-started', { from: cur?.rev ?? null, to: target.rev, cleanupOk: cleaned.ok })
    return null
  })
  await bump(runtime, 'rollback')

  // 用目标 revision 的配置重新部署（走同一条闭环：预检 → 起容器 → 健康检查 → 降级）
  const modelPath = ep.modelRef?.value ?? ep.model
  const raw = {
    path: modelPath,
    backend: ep.backend,
    options: {
      port: target.port,
      // 把当前运行时的端口池一并带上：回退用的端口是**本插件先前选定**的，
      // 不该被输入流水线当成"用户指定了池外端口"的冲突（那条检查是给人工输入用的）。
      portPoolStart: runtime.options.portPoolStart,
      portPoolEnd: runtime.options.portPoolEnd,
      servedModelName: target.servedModelName,
      image: target.image,
      gpuMemoryUtilization: target.config?.gpuMemoryUtilization,
      maxModelLen: target.config?.maxModelLen,
      maxNumSeqs: target.config?.maxNumSeqs,
      tensorParallelSize: target.config?.tensorParallelSize,
      dtype: target.config?.dtype,
      quantization: target.config?.quantization,
      swapSpaceGb: target.config?.swapSpaceGb,
    },
  }
  // 回退 = "用目标 revision 的配置重走一次完整部署"，所以这次内部 deploy 必须
  // **带着同一个 ownerToken**（否则会被自己的租约闸门拦下 —— 真机上就是这么发现的）。
  const result = await deployOperation(runtime, { raw: { ...raw, ownerToken }, log, signal })
  await withRegistry(runtime, (r) => {
    const e = findEndpoint(r, ep.id)
    if (!e) return null
    pushHistory(e, 'rolled-back', { to: target.rev, newRev: e.currentRevision })
    return null
  })
  return {
    ok: true,
    rolledBackTo: target.rev,
    // 回退到哪个 revision 要**落到返回值里**（集成测试 F-10：报告写了
    // "rejected-rolled-back" 却不写退到哪，属于观测性缺口）
    ownerToken: result.ownerToken ?? ownerToken,
    endpoint: result.endpoint,
    report: result.report,
  }
}

/* ------------------------------------------------------------------ reconcile */

/** 清理孤儿容器（SIGKILL/掉电后兜底）。默认只报告，reap=true 才真删。 */
export async function reconcileOperation(runtime, { reap = false } = {}) {
  const found = await findOrphans(runtime)
  if (!found.ok) {
    fail(ERROR_CODES.E_INTERNAL, `无法枚举本插件管理的容器：${found.error}`, {
      remediation: '确认 Docker daemon 可用且当前用户有权访问。',
      details: found,
    })
  }
  let reaped = []
  if (reap && found.orphans.length > 0) {
    const { reapOrphans } = await import('./cleanup.mjs')
    reaped = await reapOrphans(runtime, found.orphans)
  }
  return { ok: true, orphans: found.orphans, reaped, managed: found.managed }
}

export { buildReport, containerNameFor, addRevision }
