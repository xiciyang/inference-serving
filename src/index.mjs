/**
 * DSH 插件入口（bundle 形态）。
 *
 * 契约（与官方 quick-reference 及本机 dsh-healthz 实测写法一致）：
 *   - 导出 `name` + `apply(ctx, config)`；服务依赖声明在 `inject`；
 *   - 一切注册走 `ctx.effect()`（返回 disposer），卸载即净；
 *   - 只硬依赖 `tools`；`webServer` 用 `ctx.get('webServer')` 可选取用，
 *     这样 headless profile 下也能正常挂载。
 *
 * 与 DSH 插件契约的一处刻意偏离（已在 README 说明）：
 *   官方要求配置用 Schemastery `Schema<Config>`。本包是**零运行时依赖**包，
 *   为不引入 `@deepseek-ai/schemastery` 的硬依赖，这里改为手写校验并在非法配置时
 *   **加载期直接抛错**（响亮失败），语义等价；可调参数则全部外置到
 *   `~/.ai-infra/config/*.yaml` 与每次调用的 options，不存在硬编码。
 */
import { ALL_TOOL_SPECS, TOOL_SPECS, toDshTool } from './tools.mjs'
import { drain, inFlightCount } from './ops.mjs'
import { createRuntime } from './config.mjs'
import { probeProxy } from './netpolicy.mjs'
import { getSandboxProbe } from './sandbox.mjs'
import { createLogger } from './log.mjs'
import { PACKAGE_VERSION, MCP_INTERFACE_VERSION } from './version.mjs'

export const name = 'inference-serving'

/** 只硬依赖 tools。webServer 可选。 */
export const inject = ['tools']

const ALLOWED_CONFIG_KEYS = new Set([
  'root', 'headless', 'bindHost', 'portPoolStart', 'portPoolEnd',
  'modelRoots', 'containerRuntime', 'defaultBackend', 'dockerImageDefault',
  'deployTimeoutMs', 'healthTimeoutMs', 'maxDegradeSteps', 'drainTimeoutMs',
  'exposeAdminTools', 'registerHttpRoute', 'logLevel',
])

/** 加载期校验：未知键一律抛错（不静默忽略配置是安全要求，不是风格偏好）。 */
export function validateConfig(config) {
  const cfg = config ?? {}
  if (typeof cfg !== 'object' || Array.isArray(cfg)) {
    throw new Error('[inference-serving] config 必须是对象')
  }
  const unknown = Object.keys(cfg).filter((k) => !ALLOWED_CONFIG_KEYS.has(k))
  if (unknown.length > 0) {
    throw new Error(`[inference-serving] 未知配置键：${unknown.join(', ')}。允许的键：${[...ALLOWED_CONFIG_KEYS].join(', ')}`)
  }
  if (cfg.portPoolStart !== undefined && cfg.portPoolEnd !== undefined && cfg.portPoolStart > cfg.portPoolEnd) {
    throw new Error(`[inference-serving] portPoolStart(${cfg.portPoolStart}) 不能大于 portPoolEnd(${cfg.portPoolEnd})`)
  }
  if (cfg.root !== undefined && typeof cfg.root !== 'string') {
    throw new Error('[inference-serving] root 必须是字符串路径')
  }
  if (cfg.headless !== undefined && typeof cfg.headless !== 'boolean') {
    throw new Error('[inference-serving] headless 必须是布尔值')
  }
  return cfg
}

export function apply(ctx, config) {
  const cfg = validateConfig(config)
  const options = {
    ...(cfg.bindHost ? { bindHost: cfg.bindHost } : {}),
    ...(cfg.portPoolStart ? { portPoolStart: cfg.portPoolStart } : {}),
    ...(cfg.portPoolEnd ? { portPoolEnd: cfg.portPoolEnd } : {}),
    ...(cfg.modelRoots ? { modelRoots: cfg.modelRoots } : {}),
    ...(cfg.containerRuntime ? { containerRuntime: cfg.containerRuntime } : {}),
    ...(cfg.defaultBackend ? { defaultBackend: cfg.defaultBackend } : {}),
    ...(cfg.dockerImageDefault ? { dockerImageDefault: cfg.dockerImageDefault } : {}),
    ...(cfg.deployTimeoutMs ? { deployTimeoutMs: cfg.deployTimeoutMs } : {}),
    ...(cfg.healthTimeoutMs ? { healthTimeoutMs: cfg.healthTimeoutMs } : {}),
    ...(cfg.maxDegradeSteps ? { maxDegradeSteps: cfg.maxDegradeSteps } : {}),
    ...(cfg.drainTimeoutMs ? { drainTimeoutMs: cfg.drainTimeoutMs } : {}),
    ...(cfg.headless !== undefined ? { headless: cfg.headless } : {}),
  }

  // --- 工具注册：每个工具一个独立 effect，单个注册失败不影响其它（故障隔离） ---
  const specs = cfg.exposeAdminTools === false ? TOOL_SPECS : ALL_TOOL_SPECS
  const registered = []
  const failed = []
  for (const spec of specs) {
    ctx.effect(() => {
      try {
        ctx.tools.register(toDshTool(spec))
        registered.push(spec.name)
      } catch (err) {
        failed.push({ name: spec.name, error: String(err?.message ?? err) })
        ctx.logger?.('inference-serving')?.warn?.(`工具注册失败：${spec.name} — ${err?.message ?? err}`)
        return () => {}
      }
      return () => { /* tools.register 的 disposer 由 ctx.effect 接管；此处无需额外动作 */ }
    }, `inference-serving: register ${spec.name}`)
  }

  // --- 启动自检（只读）：把"代理是坏的""没有 VM 沙箱"等事实写进日志，不阻断挂载 ---
  ctx.effect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const runtime = await createRuntime({ root: cfg.root, options })
        const log = createLogger(runtime, { level: cfg.logLevel ?? null })
        if (cancelled) return
        const sandbox = await getSandboxProbe()
        const proxy = await probeProxy(runtime)
        log.info('inference-serving 已挂载', {
          packageVersion: PACKAGE_VERSION,
          mcpInterface: MCP_INTERFACE_VERSION,
          tools: registered.length,
          sandboxTiers: { process: sandbox.process.available, container: sandbox.container.available, vm: sandbox.vm.available },
          proxyEnv: proxy.envProxy ?? null,
          proxyRespected: false,
          policySources: runtime.policy.sources,
          headless: runtime.headless,
        })
        await log.flush()
        if (!sandbox.vm.available) {
          ctx.logger?.('inference-serving')?.info?.(
            '本机无 VM 级沙箱：R3–R5 高风险操作将一律返回 E_SANDBOX_UNAVAILABLE（符合已确认的风险分级草案）',
          )
        }
        if (proxy.envProxy && !proxy.envRespected) {
          ctx.logger?.('inference-serving')?.info?.(
            `检测到环境代理 ${proxy.envProxy}：本插件按策略显式直连，不使用该代理`,
          )
        }
      } catch (err) {
        ctx.logger?.('inference-serving')?.warn?.(`启动自检失败（不影响工具可用性）：${err?.message ?? err}`)
      }
    })()
    return () => { cancelled = true }
  }, 'inference-serving: startup self-check')

  // --- 可选 HTTP 面：便于人工与监控查看 ---
  const webServer = ctx.get?.('webServer')
  if (webServer && cfg.registerHttpRoute !== false) {
    ctx.effect(() => webServer.register({
      kind: 'http',
      path: '/api/inference-serving/status',
      handler: async (req, res) => {
        try {
          const { doctor } = await import('./api.mjs')
          const out = await doctor({ deep: false, root: cfg.root })
          const body = JSON.stringify({ package: PACKAGE_VERSION, inFlight: inFlightCount(), ...out })
          res.statusCode = out?.ok === false ? 503 : 200
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.setHeader('cache-control', 'no-store')
          res.end(body)
        } catch (err) {
          try {
            res.statusCode = 500
            res.end(JSON.stringify({ ok: false, message: String(err?.message ?? err) }))
          } catch { /* 连接可能已断 */ }
        }
      },
    }), 'inference-serving: register /api/inference-serving/status')
  }

  // --- 优雅关闭：先排空在途操作（验收标准 5.4.3） ---
  ctx.effect(() => () => {
    const timeout = options.drainTimeoutMs ?? 15_000
    // Cordis 的 disposer 可返回 Promise；这里同步触发排空并让调用方等待。
    return drain({ timeoutMs: timeout }).then((r) => {
      if (!r.drained) {
        ctx.logger?.('inference-serving')?.warn?.(`卸载时仍有 ${r.remaining} 个操作未完成（已等待 ${r.waitedMs}ms）`)
      }
    })
  }, 'inference-serving: drain on dispose')

  return {
    registered: () => [...registered],
    failed: () => [...failed],
  }
}

export { TOOL_SPECS, ALL_TOOL_SPECS, toDshTool }
export default { name, inject, apply, validateConfig }
