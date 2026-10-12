/**
 * 部署主流程（题目 §4.2 的完整闭环）。
 *
 *   模型 + 目标环境 → 环境探测 → 后端选择 → 迁移适配（如需）→ 部署
 *     → 健康检查 → 注册端点 → 写共享状态
 *     → 失败 → 降级链 → 中止时回滚
 *     → 输出端点 + 部署报告
 *
 * 状态迁移与不变量已由 logicprobe 穷举验证（serving-step0-verification/RESULTS.md）：
 * 有界、无死锁、守卫完备、**健康检查通过前不注册端点**、单模型单端点。
 *
 * 与状态机的一条对应关系：状态机里 78 个"silently ignores"警告在本实现里被显式化 ——
 * 所有非法状态组合都返回结构化错误码，不静默吞掉（见 §8.3 的约束表）。
 */
import { run } from './util/proc.mjs'
import { shortId, idempotencyKey, canonicalJson, sha256 } from './util/hash.mjs'
import { fail, warn, ERROR_CODES, WARNING_CODES, isServingError } from './errors.mjs'
import { runInputPipeline } from './input/pipeline.mjs'
import { getBackend } from './backends/index.mjs'
import { getDriver } from './drivers/index.mjs'
import { planNextDegradation, applyDegrade, isDegradable } from './degrade.mjs'
import { waitForHealthy, collectFailureEvidence } from './health.mjs'
import { newOwnerToken, makeLease, checkDeployAllowed, publicLease, DEFAULT_LEASE_MS } from './state/lease.mjs'
import { resolveImagePin } from './state/image-pin.mjs'
import { cleanupRevision, containerNameFor, registerCleanup } from './cleanup.mjs'
import { withRegistry, findEndpoint, currentRevision, addRevision, pushHistory, summarize } from './state/registry.mjs'
import { recordDeployTiming, recordResource, bump } from './metrics.mjs'
import { assertSandbox } from './sandbox.mjs'

/** 部署请求的幂等键：同一 (模型, 后端) 只应有一个端点。 */
export function deployKeyFor(standard) {
  return idempotencyKey({ model: standard.model.path ?? standard.model.display, backend: standard.backend })
}

/** 请求配置指纹：用来判断"同模型但参数变了"。 */
export function configFingerprint(standard) {
  return sha256(canonicalJson({
    config: standard.config,
    servedModelName: standard.servedModelName,
    image: standard.image,
    containerRuntime: standard.containerRuntime,
  })).slice(0, 16)
}

/**
 * license 确认令牌：**绑定到具体模型路径**。
 *
 * 早期实现只校验前缀 `lic_`，那等于"任何以 lic_ 开头的字符串都能为任何模型背书" —— 是
 * 一个真实的越权口子（A 模型确认一次即可放行 B 模型）。现在令牌由模型解析路径哈希派生，
 * 必须精确匹配。
 */
export function licenseTokenFor(modelRef) {
  return `lic_${sha256(String(modelRef ?? '')).slice(0, 16)}`
}

/** License 门禁（题目原则 3.2.10）。 */
export function normalizeTokens(input) {
  if (Array.isArray(input)) return input.filter((t) => typeof t === 'string' && t.length > 0)
  if (typeof input === 'string' && input.length > 0) return [input]
  return []
}

export async function enforceLicense(runtime, license, { confirmToken = null, confirmTokens = null, log = null, modelRef = null } = {}) {
  const provided = new Set([...normalizeTokens(confirmTokens), ...normalizeTokens(confirmToken)])
  if (!license) return { decision: 'allow', reason: 'no license metadata' }
  const token = licenseTokenFor(modelRef ?? license.modelRef ?? '')
  if (license.decision === 'allow') {
    log?.info('license 通过', { license: license.license, class: license.class, source: license.source })
    return { ...license, confirmToken: null }
  }

  // 已确认过且还在 TTL 内 → 复用（与 R1/R2 的"每类一次 24h"保持一致）。
  // 不做这层缓存的话，deploy 确认过的同一个模型，rollback 时会被再问一遍，
  // 而 rollback 内部走的就是同一条部署路径 —— 用户会看到"刚点过又要点"。
  const { findValidGrant, grant } = await import('./risk.mjs')
  const existing = await findValidGrant(runtime, token)
  if (existing) {
    log?.info('license 确认在有效期内，复用', { license: license.license, token, grantedAt: existing.grantedAt })
    return { ...license, decision: 'allow', confirmed: true, reused: true, confirmToken: token }
  }

  // ── 溯源继承（F-4）──────────────────────────────────────────────────
  //
  // 产物没有自己的确认记录时，先看它的**基座**是否已被人工确认过。
  // 派生模型的 license 义务随权重继承，所以基座的确认对派生产物同样成立 ——
  // 这正是"每个量化产物都要再点一次"这个坑的正解。
  //
  // 顺序刻意放在"自带令牌"之前：继承不需要调用方再出示任何东西。
  {
    const { provenanceChain } = await import('./state/provenance.mjs')
    for (const ancestor of provenanceChain(license)) {
      const ancestorToken = licenseTokenFor(ancestor)
      // eslint-disable-next-line no-await-in-loop
      const inherited = await findValidGrant(runtime, ancestorToken)
      if (inherited) {
        log?.info('license 沿溯源链继承：基座已确认', {
          license: license.license, class: license.class, ancestor, ancestorToken,
        })
        return {
          ...license,
          decision: 'allow',
          confirmed: true,
          reused: true,
          inheritedFrom: ancestor,
          inheritedFromGrantedAt: inherited.grantedAt ?? null,
          confirmToken: null,
        }
      }
    }
  }

  // restricted / unknown → 停下确认
  if (provided.has(token)) {
    await grant(runtime, {
      key: token, capabilityId: 'license', riskClass: 'R2',
      targetFingerprint: modelRef ?? null, grantedBy: 'explicit-license-confirm', persist: true,
    })
    log?.info('license 已由调用方显式确认', { license: license.license, class: license.class, token })
    return { ...license, decision: 'allow', confirmed: true, confirmToken: token }
  }
  const details = {
    license: license.license ?? null,
    licenseClass: license.class,
    source: license.source ?? null,
    model: modelRef ?? null,
    confirmToken: token,          // 与确认闸门用同一字段名：调用方只需一种续跑方式
    headless: runtime.headless,
  }
  if (runtime.headless) {
    fail(ERROR_CODES.E_LICENSE_UNRESOLVED,
      `模型 license 需要人工确认，headless 模式下中止：${license.license ?? '(未能识别)'}（判定：${license.class}）`, {
        remediation: `把该 license 加入 ${runtime.paths.networkFile} 的 license.permissive 列表，或改用 license 明确的模型；也可在交互模式下带 options.confirm="${token}" 继续。`,
        details,
      })
  }
  fail(ERROR_CODES.E_LICENSE_UNRESOLVED,
    `模型 license 需要确认：${license.license ?? '(未能识别)'}（判定：${license.class}，来源：${license.source ?? '未找到 LICENSE 文件'}）`, {
      remediation: `确认你确实有权使用该模型后，带 options.confirm = "${token}" 重新调用（该令牌与模型路径绑定，不能用于其它模型）；这次确认会写入审计。`,
      details,
    })
}

/** 续跑用的降级上下文（提供"下一个空闲端口"等能力）。 */
function makeDegradeCtx(runtime, standard, { exclude = new Set(), preflightDetails = null } = {}) {
  return {
    // 把预检算出的物理量交给降级链 —— 让档位决策是"证据驱动"而不是拍系数
    preflightDetails,
    totalBytes: preflightDetails?.totalBytes ?? null,
    availableBytes: preflightDetails?.availableBytes ?? null,
    nextFreePort: async () => {
      const { isPortFree } = await import('./util/http.mjs')
      const start = runtime.options.portPoolStart
      const end = runtime.options.portPoolEnd
      for (let p = start; p <= end; p += 1) {
        if (exclude.has(p) || p === standard.port) continue
        // eslint-disable-next-line no-await-in-loop
        if (await isPortFree(standard.bindHost, p)) return p
      }
      return null
    },
  }
}

/**
 * 执行部署。
 * @returns {{ok:true, endpoint:object, report:object}}
 */
/**
 * 把关 4 的健康检查项规范成**唯一一种形状**。
 *
 * 报告与 error.details 都必须用它 —— 同一份证据出现两种字段名（metrics / evidence）
 * 是真机上真实踩到的坑：验证脚本按报告的形状去读 details，读到 null，
 * 于是"证据齐全"被误判成"没有证据"。
 */
export function normalizeUsability(checks) {
  const c = (checks ?? []).find((x) => x.name === 'model-usable')
  if (!c) return null
  return { ok: c.ok, detail: c.detail ?? null, metrics: c.evidence ?? null, checks: c.checks ?? null }
}

export async function deployOperation(runtime, { raw, log = null, signal = null, deepProbe = false, onPhase = null } = {}) {
  const startedAt = Date.now()
  const attempts = []
  const phase = (name, data) => { log?.phase?.(name, data); onPhase?.({ name, ...(data ?? {}), at: Date.now() - startedAt }) }

  phase('probe')
  const { standard, env, resolved } = await runInputPipeline(runtime, raw, { deepProbe })
  const backend = getBackend(standard.backend)
  if (!backend) {
    fail(ERROR_CODES.E_BACKEND_UNKNOWN, `后端 ${standard.backend} 未注册`, {
      remediation: '这通常意味着后端模块未加载；请检查 src/backends/ 是否被正确 import。',
      details: { backend: standard.backend },
    })
  }

  const driver = getDriver(backend.driver ?? 'docker')

  // 问镜像自己支持哪些 CLI 参数（不硬编码某个 vLLM 版本的参数表）
  let imageCapabilities = null
  if (typeof backend.probeImage === 'function') {
    try {
      imageCapabilities = await backend.probeImage(runtime, { image: standard.image })
      if (imageCapabilities?.ok === false) {
        runtime.warnings.push(warn(WARNING_CODES.W_IMAGE_PROBE_FALLBACK,
          `无法探测镜像 ${standard.image} 的参数支持面，已退回保守参数集：${imageCapabilities.reason}`,
          { image: standard.image, reason: imageCapabilities.reason }))
      }
      log?.info('镜像参数支持面已探测', { image: standard.image, ok: imageCapabilities?.ok, flags: imageCapabilities?.flags ?? null })
    } catch (err) {
      runtime.warnings.push(warn(WARNING_CODES.W_IMAGE_PROBE_FALLBACK, `镜像参数探测异常，已退回保守参数集：${err.message}`, null))
    }
  }

  // R2：容器级沙箱
  phase('sandbox')
  const sandbox = await assertSandbox(runtime, runtime.policy.risk.sandbox?.R2 ?? 'container')

  // 令牌集合：一次调用可能同时需要"风险确认"与"license 确认"两道门的令牌
  const confirmTokens = normalizeTokens(raw?.options?.confirm)

  // license
  phase('license')
  await enforceLicense(runtime, resolved.license, { confirmTokens, log, modelRef: resolved.path ?? resolved.display })

  // 幂等
  const key = deployKeyFor(standard)
  const endpointId = `ep_${shortId(key, 10)}`
  const containerName = containerNameFor(endpointId)
  standard.containerName = containerName
  const desiredFp = configFingerprint(standard)

  const existing = await withRegistry(runtime, (reg) => findEndpoint(reg, key), { backup: false })

  // ---------------- 端点租约（F-3 租用制） ----------------
  //
  // 判定必须放在**起容器之前**：否则先白起一个容器再拒，等于用一次真机部署换一条错误信息。
  // 背景见 state/lease.mjs 顶部 —— serving 按 model 做键，两个插件会拿到同一个端点却
  // 各自以为独占，收尾时互相拆。
  const leaseOwner = raw.owner ?? 'anonymous'
  const leaseMs = Number.isFinite(Number(raw.leaseMs)) && Number(raw.leaseMs) > 0 ? Number(raw.leaseMs) : DEFAULT_LEASE_MS
  // 允许调用方自带 token（同一次运行内多次 deploy 要复用同一个身份）
  const ownerToken = typeof raw.ownerToken === 'string' && raw.ownerToken.length > 0 ? raw.ownerToken : newOwnerToken()
  // 只有**存活**的端点才谈得上"被租用"。torn_down 的端点上留着的历史租约必须忽略 ——
  // 否则"拆了之后想重新部署"会被一条属于幽灵端点的租约挡住（真机踩到过）。
  const liveEndpoint = existing && existing.status !== 'torn_down'
  const leaseCheck = checkDeployAllowed({ lease: liveEndpoint ? existing.lease : null, ownerToken })
  if (!leaseCheck.ok) {
    fail(ERROR_CODES.E_ENDPOINT_LEASED, leaseCheck.message, {
      remediation: leaseCheck.remediation,
      details: { ...leaseCheck.details, endpointId: existing?.id ?? null, model: standard.model.path ?? standard.model.display },
    })
  }
  if (leaseCheck.takeover) {
    runtime.warnings.push(warn(WARNING_CODES.W_ENDPOINT_LEASE_TAKEOVER,
      `端点 ${existing.id} 的租约已过期（原 owner=${existing.lease?.owner}），本次调用接管它`,
      { endpointId: existing.id, previousOwner: existing.lease?.owner ?? null, expiredAt: existing.lease?.expiresAt ?? null }))
  }

  if (existing && existing.status === 'serving') {
    const cur = currentRevision(existing)
    const sameConfig = existing.requestedFingerprint === desiredFp
    const alive = await isContainerAlive(backend, cur?.containerName)
    if (sameConfig && alive) {
      phase('idempotent-hit', { endpointId: existing.id })
      log?.info('幂等命中：同一模型 + 同一配置 + 容器存活，直接返回既有端点', { endpointId: existing.id })
      // 幂等命中路径**也要处理接管**：否则"接管了一个过期租约"只是嘴上说说 ——
      // 注册表里留的还是过期的旧租约和旧 ownerToken（真机测试照出来的）。
      let leaseNow = existing.lease
      if (leaseCheck.takeover) {
        leaseNow = makeLease({ owner: leaseOwner, ownerToken, purpose: raw.purpose ?? null, leaseMs })
        await withRegistry(runtime, (reg) => {
          const ep = findEndpoint(reg, key)
          if (ep) ep.lease = leaseNow
          return null
        })
      }
      return {
        ok: true,
        reused: true,
        ownerToken,
        lease: publicLease(leaseNow),
        endpoint: summarize(existing),
        // 这条路径以前**丢掉了 warnings**（buildReport 的默认参数是空数组），
        // 于是"接管了过期租约"这类事实在报告里看不到。
        report: buildReport({
          runtime, standard, env, backend, reused: true, outcome: 'idempotent',
          attempts: [], degradeHistory: [], startedAt, sandbox, warnings: [...runtime.warnings],
        }),
      }
    }
    if (!alive) {
      log?.warn('注册表标记 serving 但容器已不存在，将重新部署', { endpointId: existing.id, containerName: cur?.containerName })
      runtime.warnings.push(warn(WARNING_CODES.W_RESIDUAL_CLEANUP, '注册表与实机不一致：容器已消失，执行重新部署', { endpointId: existing.id }))
    } else {
      log?.info('同模型但配置指纹变化，将作为新 revision 重新部署', { endpointId: existing.id })
    }
  }

  // ---------------- 降级链 ----------------
  phase('deploy')
  let current = {
    ...standard,
    degrade: { step: 0, tier: 'baseline', label: '基线', lossy: false, history: [] },
  }
  const triedTiers = []
  const usedPorts = new Set([standard.port])
  let outcome = null
  let lastFailure = null
  let lastRevision = null
  let lastPreflightDetails = null
  const maxSteps = runtime.options.maxDegradeSteps

  for (let attempt = 0; attempt <= maxSteps; attempt += 1) {
    if (signal?.aborted) {
      await cleanupRevision(runtime, { containerName: containerNameFor(endpointId), bindHost: current.bindHost, port: current.port, backend: backend.id, driver: backend.driver }, { driver })
      fail(ERROR_CODES.E_CANCELLED, '部署被取消', { remediation: '重新发起部署即可；已创建的容器已被清理。' })
    }

    const attemptStart = Date.now()
    const attemptRecord = {
      attempt: attempt + 1,
      degradeStep: current.degrade.step,
      tier: current.degrade.tier,
      port: current.port,
      config: { ...current.config },
      preflight: null,
      launched: false,
      health: null,
      failureCode: null,
      ms: 0,
    }

    // 先把可能残留的同名容器清掉（上一次尝试失败后清理失败的兜底）
    await cleanupRevision(runtime, { containerName: containerNameFor(endpointId), bindHost: current.bindHost, port: current.port, backend: backend.id, driver: backend.driver }, { driver })

    // 1) 预检（在起容器之前，快）
    const pre = await backend.preflight({ env, standard: current, imageCapabilities })
    attemptRecord.preflight = { ok: pre.ok, code: pre.code ?? null, message: pre.message ?? null, details: pre.details ?? null }
    if (pre.details) lastPreflightDetails = pre.details
    let failureCode = pre.ok ? null : pre.code

    // 2) 起容器 + 3) 健康检查
    if (pre.ok) {
      const spec = backend.buildLaunchSpec({ runtime, standard: current, endpointId, containerName: containerNameFor(endpointId), imageCapabilities })
      attemptRecord.command = spec.commandLine
      attemptRecord.image = spec.image
      if (spec.skippedFlags?.length) attemptRecord.skippedFlags = spec.skippedFlags
      log?.info('启动容器', { attempt: attempt + 1, tier: current.degrade.tier, command: spec.commandLine })

      const launch = await driver.launch(spec, { timeoutMs: 120_000, signal })
      attemptRecord.launched = launch.code === 0
      if (launch.code !== 0) {
        const msg = `${launch.stderr ?? ''}\n${launch.stdout ?? ''}`
        failureCode = backend.classifyFailure({ stderr: msg, stdout: '', exitCode: launch.code })
        attemptRecord.failureCode = failureCode
        attemptRecord.launchError = msg.trim().slice(0, 1200)
      } else {
        const health = await waitForHealthy(runtime, current, backend, { log, signal })
        attemptRecord.health = { ok: health.ok, attempts: health.attempts, failedAt: health.failedAt, checks: health.checks, ms: health.ms }
        // 关 4 的证据在**这里**规范一次，报告与 error.details 用的是同一个对象。
        // （之前两处各投影一次，形状还不同：报告里叫 metrics，details 里叫 evidence ——
        //   结果真机验证脚本按报告的形状去读 details，读到 null。同一份证据不允许有两种形状。）
        attemptRecord.modelUsability = normalizeUsability(health.checks)
        if (health.ok) {
          outcome = 'success'
        } else {
          const ev = await collectFailureEvidence(backend, containerNameFor(endpointId))
          failureCode = backend.classifyFailure(ev)
          attemptRecord.failureCode = failureCode
          attemptRecord.containerLogTail = ev.combined.slice(-2000)
          attemptRecord.healthFailureCode = health.failedAt === 'endpoint-responding' ? 'E_HEALTH_FAILED' : failureCode
          if (health.failedAt === 'model-usable') {
            // 容器活着、HTTP 也通，但模型没参与前向（均匀输出）。
            // 这条**必须与 E_HEALTH_FAILED 分开**：它不可降级，且调用方必须能区分
            // "起来了但不可用" 与 "没起来"。真机事故见 probe/usability.mjs 顶部。
            failureCode = ERROR_CODES.E_MODEL_NOT_READY
            attemptRecord.failureCode = failureCode
          } else if (health.failedAt === 'endpoint-responding' || health.failedAt === 'forward-inference') {
            // 容器活着但模型没起来：日志里往往仍能看出是 OOM
            failureCode = backend.classifyFailure(ev) === 'E_INSUFFICIENT_MEMORY' ? 'E_INSUFFICIENT_MEMORY' : 'E_HEALTH_FAILED'
            attemptRecord.failureCode = failureCode
          }
        }
      }
    } else {
      attemptRecord.failureCode = failureCode
      attemptRecord.launched = false
      log?.warn('预检未通过，未启动容器', { attempt: attempt + 1, tier: current.degrade.tier, code: failureCode, message: pre.message })
    }

    attemptRecord.ms = Date.now() - attemptStart
    attempts.push(attemptRecord)
    await recordDeployTiming(runtime, attemptRecord.ms, { success: outcome === 'success' })
    await recordResource(runtime, {
      gpuMemoryUtilization: current.config.gpuMemoryUtilization,
      maxModelLen: current.config.maxModelLen,
      image: current.image,
    })

    if (outcome === 'success') {
      phase('healthy', { attempt: attempt + 1, tier: current.degrade.tier })
      lastRevision = {
        endpoint: `http://${current.bindHost}:${current.port}`,
        port: current.port,
        bindHost: current.bindHost,
        containerName: containerNameFor(endpointId),
        backend: backend.id,
        driver: backend.driver ?? 'docker',
        image: current.image,
        servedModelName: current.servedModelName,
        config: { ...current.config },
        degradeStep: current.degrade.step,
        degradeTier: current.degrade.tier,
        status: 'serving',
        verifiedAt: new Date().toISOString(),
        attempt: attempt + 1,
      }
      break
    }

    // 失败 → 清理 → 决策
    lastFailure = failureCode
    phase('attempt-failed', { attempt: attempt + 1, tier: current.degrade.tier, code: failureCode })
    const cleaned = await cleanupRevision(runtime, { containerName: containerNameFor(endpointId), bindHost: current.bindHost, port: current.port, backend: backend.id, driver: backend.driver }, { driver })
    attemptRecord.cleanup = { ok: cleaned.ok, portReleased: cleaned.portReleased, residual: cleaned.residual }
    if (!cleaned.ok) {
      runtime.warnings.push(warn(WARNING_CODES.W_RESIDUAL_CLEANUP, `清理未完全成功：${cleaned.residual.join('; ')}`, { attempt: attempt + 1 }))
    }

    const plan = await planNextDegradation({
      failureCode,
      triedTiers,
      standard: current,
      ctx: makeDegradeCtx(runtime, current, {
        exclude: usedPorts,
        preflightDetails: attemptRecord.preflight?.details ?? lastPreflightDetails,
      }),
      maxSteps,
    })
    if (plan.exhausted || plan.terminal) {
      outcome = plan.terminal ? 'aborted-terminal' : 'exhausted'
      lastFailure = failureCode
      attempts[attempts.length - 1].degradeDecision = { exhausted: true, terminal: plan.terminal === true, reason: plan.reason }
      phase('aborted', { code: failureCode, reason: plan.reason })
      break
    }
    triedTiers.push(plan.tier.id)
    if (plan.patch?.port) usedPorts.add(plan.patch.port)
    attempts[attempts.length - 1].degradeDecision = { tier: plan.tier.id, label: plan.tier.label, lossy: plan.tier.lossy === true, reason: plan.reason }
    current = applyDegrade(current, { tier: plan.tier, patch: plan.patch })
    if (plan.warning) runtime.warnings.push(warn(WARNING_CODES.W_ASSUMPTION_FILLED, plan.warning, { tier: plan.tier.id }))
    await bump(runtime, 'degrade_steps')
    phase('degrade', { to: plan.tier.id, step: current.degrade.step })
  }

  if (outcome !== 'success') {
    // 中止：确保无残留，并记录失败的端点状态（不留半死记录）
    await cleanupRevision(runtime, { containerName: containerNameFor(endpointId), bindHost: standard.bindHost, port: standard.port, backend: backend.id, driver: backend.driver }, { driver })
    const code = outcome === 'aborted-terminal' ? (lastFailure ?? ERROR_CODES.E_DEPLOY_FAILED) : ERROR_CODES.E_DEGRADE_EXHAUSTED
    const triedText = triedTiers.length ? triedTiers.join(' → ') : '(未进入降级)'
    await withRegistry(runtime, (reg) => {
      const ep = findEndpoint(reg, key)
      if (ep) pushHistory(ep, 'deploy-aborted', { code, tried: triedTiers, attempts: attempts.length })
      return null
    }, { backup: false })
    fail(code,
      outcome === 'aborted-terminal'
        ? `部署中止：${lastFailure}（该失败无法通过更换配置解决）`
        : `降级链耗尽（共尝试 ${attempts.length} 种配置：baseline → ${triedText}），未得到可用端点`, {
        remediation: outcome === 'aborted-terminal'
          ? '这是环境/输入类失败，换配置无用。请按 details 中的 remediation 修复后重试。'
          : '请检查：模型是否过大（改用更小模型或更低精度格式）、内存是否被既有服务占满、端口池是否耗尽、镜像是否可用。完整尝试记录见 details.attempts。',
        details: { attempts, triedTiers, lastFailure, env: summarizeEnv(env) },
      })
  }

  // ---------------- 注册端点（健康检查通过之后） ----------------
  phase('register')
  // 解析一次即可：同一次部署里镜像不随降级档位变化
  const imagePin = await resolveImagePin(current.image).catch(() => null)
  const registered = await withRegistry(runtime, (reg) => {
    let ep = findEndpoint(reg, key)
    if (!ep) {
      ep = {
        key,
        id: endpointId,
        model: standard.model.path ?? standard.model.display,
        modelRef: { kind: standard.model.kind, value: standard.model.path ?? standard.model.display, display: standard.model.display },
        backend: standard.backend,
        servedModelName: standard.servedModelName,
        status: 'serving',
        createdAt: new Date().toISOString(),
        revisions: [],
        history: [],
      }
      reg.endpoints.push(ep)
    }
    ep.status = 'serving'
    ep.requestedFingerprint = desiredFp
    ep.backend = standard.backend
    ep.servedModelName = standard.servedModelName
    // 租约：owner 是给人看的用途标签，ownerToken 是校验用的凭证（只有调用方持有）
    ep.lease = makeLease({ owner: leaseOwner, ownerToken, purpose: raw.purpose ?? null, leaseMs })
    ep.license = standard.model.license ? { class: standard.model.license.class, license: standard.model.license.license } : null
    // 旧 revision 标记为被取代（保留，供 rollback 使用）
    for (const r of ep.revisions ?? []) {
      if (r.status === 'serving') r.status = 'superseded'
    }
    // 镜像 digest 固定（用户验收标准第 6 条）。
    // 集测试取证：本机**取得到** digest（vllm 有 RepoDigest、本地工具链镜像有内容寻址 ID），
    // 之前记 null 不是因为取不到，而是只读了配置里的 tag 字符串 —— 而 tag 会漂。
    if (imagePin) {
      lastRevision.imageDigest = imagePin.ref
      lastRevision.imageDigestKind = imagePin.kind
      lastRevision.imageTag = imagePin.image ?? lastRevision.image ?? null
    }
    addRevision(ep, lastRevision)
    pushHistory(ep, 'deployed', {
      tier: current.degrade.tier,
      degradeStep: current.degrade.step,
      attempts: attempts.length,
      lossy: current.degrade.history?.some((h) => h.lossy) ?? false,
    })
    return JSON.parse(JSON.stringify(ep))
  })

  return {
    ok: true,
    reused: false,
    // ownerToken 是**凭证**：只回给调用方，不进注册表的对外视图、不进报告
    ownerToken,
    lease: publicLease(registered.lease),
    endpoint: summarize(registered),
    report: buildReport({
      runtime, standard, finalStandard: current, env, backend, reused: false, outcome, attempts,
      degradeHistory: current.degrade.history, startedAt, sandbox, warnings: [...runtime.warnings],
    }),
  }
}

async function isContainerAlive(backend, name) {
  if (!name) return false
  try {
    const st = await getDriver(backend?.driver ?? 'docker').inspect(name)
    return Boolean(st.exists && st.running)
  } catch {
    return false
  }
}

export function summarizeEnv(env) {
  return {
    gpu: env.gpu.gpus?.[0]?.name ?? null,
    unifiedMemory: env.capability.unifiedMemory,
    driver: env.gpu.gpus?.[0]?.driverVersion ?? null,
    computeCapability: env.gpu.gpus?.[0]?.computeCapability ?? null,
    totalBytes: env.gpu.gpus?.[0]?.totalBytes ?? env.memory.totalBytes,
    availableBytes: env.capability.availableMemoryBytes,
    memoryIsEstimate: env.capability.memoryIsEstimate,
    docker: env.container.detail,
    nvidiaRuntime: env.container.nvidiaRuntime,
    sandboxTiers: env.capability.sandboxTiers,
    node: env.node.version,
    platform: `${env.host.platform}/${env.host.arch}`,
  }
}

export function buildReport({ runtime, standard, finalStandard = null, env, backend, reused, outcome, attempts, degradeHistory, startedAt, sandbox, warnings = [] }) {
  // 报告必须描述**真正部署的那份配置**，不是最初请求的那份。
  // 踩过的坑：早期这里传的是基线 standard，于是在发生过降级的部署里，
  // 报告写着 gpu-memory-utilization=0.95，而实际跑起来的是 0.13 —— 报告撒谎比没报告更糟。
  const effective = finalStandard ?? standard
  const lossy = (degradeHistory ?? []).some((h) => h.lossy)
  return {
    schema: 'inference-serving/deploy-report@1',
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    outcome, // success | idempotent | exhausted | aborted-terminal
    reused: reused === true,
    endpoint: {
      url: `http://${effective.bindHost}:${effective.port}`,
      port: effective.port,
      bindHost: effective.bindHost,
      servedModelName: effective.servedModelName,
    },
    requestedConfig: standard.config,
    degradedFrom: standard.degrade?.tier ?? 'baseline',
    model: {
      input: standard.model.display,
      resolvedPath: standard.model.path,
      kind: standard.model.kind,
      wasSymlink: standard.model.wasSymlink,
      license: standard.model.license,
      facts: standard.model.facts,
    },
    backend: { id: backend.id, displayName: backend.displayName, describe: backend.describe(env) },
    sandbox: { tier: sandbox.tier, enforced: sandbox.enforced, detail: sandbox.detail ?? null },
    environment: summarizeEnv(env),
    finalConfig: effective.config,
    degrade: {
      steps: degradeHistory?.length ?? 0,
      lossy,
      lossyWarning: lossy ? '本次部署使用了有损降级档位（精度），输出质量可能受影响' : null,
      history: degradeHistory ?? [],
    },
    attempts: attempts.map((a) => ({
      attempt: a.attempt,
      tier: a.tier,
      port: a.port,
      preflightOk: a.preflight?.ok ?? null,
      launched: a.launched,
      failureCode: a.failureCode,
      healthFailedAt: a.health?.failedAt ?? null,
      /**
       * 关 4（模型可用性）的判定证据 —— **成功与失败都要留下**。
       *
       * 只留"成功了"是不够的：调用方需要能复核"凭什么说这个模型可用"。
       * 真机事故的教训就是 `ok: true` 背后没有任何可复核的证据。
       */
      modelUsability: a.modelUsability ?? null,
      ms: a.ms,
      degradeDecision: a.degradeDecision ?? null,
    })),
    assumptions: effective.assumptions ?? standard.assumptions ?? [],
    warnings: warnings.map((w) => (typeof w.toJSON === 'function' ? w.toJSON() : w)),
    policySources: runtime.policy.sources,
    auditFile: runtime.paths.registryFile ? undefined : undefined,
  }
}
