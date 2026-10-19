/**
 * 集成测试：DSH 插件契约（不依赖真实 DSH 运行时）。
 *
 * 用 mock ctx 验证官方契约的每一条（参见 dsh-plugin-guide 的 Hard rules）：
 *   - 导出 `name` + `inject` + `apply`
 *   - 一切注册都走 `ctx.effect()`（返回 disposer，卸载即净）
 *   - 工具形状完整（name/description/parameters/output/execute）
 *   - 非法配置**加载期响亮失败**
 *   - 单个工具注册失败不影响其它工具（故障隔离）
 *   - 可选服务缺失（webServer）时仍能挂载
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { name, inject, apply, validateConfig } from '../../src/index.mjs'
import { TOOL_SPECS, ALL_TOOL_SPECS } from '../../src/tools.mjs'

function mockCtx({ withWebServer = true, failOn = null } = {}) {
  const registered = []
  const disposers = []
  const effects = []
  const logs = []
  const routes = []
  const ctx = {
    tools: {
      register(tool) {
        if (failOn && tool.name === failOn) throw new Error(`注入的注册失败：${tool.name}`)
        registered.push(tool)
      },
    },
    effect(fn, label) {
      effects.push(label)
      const d = fn()
      if (typeof d === 'function') disposers.push({ label, d })
      return d
    },
    on() {},
    get(key) {
      if (key === 'webServer') return withWebServer ? { register: (r) => { routes.push(r); return () => {} } } : undefined
      return undefined
    },
    logger() { return { info: (m) => logs.push(['info', m]), warn: (m) => logs.push(['warn', m]) } },
  }
  return { ctx, registered, disposers, effects, logs, routes }
}

test('契约: 导出 name / inject / apply，且只硬依赖 tools', () => {
  assert.equal(name, '@xiciyang/inference-serving')
  assert.deepEqual(inject, ['tools'], 'webServer 必须是可选服务（否则 headless profile 挂不上）')
  assert.equal(typeof apply, 'function')
})

test('契约: 每个工具一个独立的 ctx.effect，注册的工具有 label 便于诊断', () => {
  const { ctx, effects, registered } = mockCtx()
  apply(ctx, undefined)
  assert.equal(registered.length, ALL_TOOL_SPECS.length)
  for (const spec of ALL_TOOL_SPECS) {
    assert.ok(effects.some((l) => l.includes(spec.name)), `应有一个 effect 负责注册 ${spec.name}`)
  }
})

test('契约: exposeAdminTools=false 时只注册 5 个面向用户的工具', () => {
  const { ctx, registered } = mockCtx()
  apply(ctx, { exposeAdminTools: false })
  assert.equal(registered.length, TOOL_SPECS.length)
  assert.equal(registered.length, 5)
  for (const n of ['inference_serving_deploy', 'inference_serving_status', 'inference_serving_rollback', 'inference_serving_teardown', 'inference_serving_list_endpoints']) {
    assert.ok(registered.some((t) => t.name === n), `缺少 ${n}`)
  }
})

test('契约: 工具形状完整，且 parameters 只用 DSH 支持的 JSON Schema 子集', () => {
  const { ctx, registered } = mockCtx()
  apply(ctx, undefined)
  const ALLOWED = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'oneOf', 'description'])
  for (const t of registered) {
    assert.equal(typeof t.name, 'string')
    assert.equal(typeof t.description, 'string')
    assert.ok(t.parameters && t.parameters.type === 'object', `${t.name} 的 parameters 应是 object 根`)
    assert.ok(t.output && t.output.schema, `${t.name} 应有 output.schema`)
    assert.equal(typeof t.execute, 'function')
    const walk = (node, path) => {
      for (const [k, v] of Object.entries(node)) {
        assert.ok(ALLOWED.has(k), `${t.name}${path}.${k} 不在 DSH 支持的 schema 关键字内`)
        if (k === 'properties') for (const [pk, pv] of Object.entries(v)) walk(pv, `${path}.properties.${pk}`)
        if (k === 'items') walk(v, `${path}.items`)
      }
    }
    walk(t.parameters, '')
  }
})

test('契约: 卸载时所有 effect 都被清理（每个注册返回 disposer）', () => {
  const { ctx, disposers } = mockCtx()
  apply(ctx, undefined)
  assert.ok(disposers.length >= 1)
  for (const { d, label } of disposers) {
    assert.equal(typeof d, 'function', `${label} 的 effect 应返回 disposer`)
    assert.doesNotThrow(() => d(), `${label} 的 disposer 执行不应抛错`)
  }
})

test('契约: webServer 缺失（headless profile）时仍能挂载，且不注册路由', () => {
  const { ctx, registered, routes } = mockCtx({ withWebServer: false })
  assert.doesNotThrow(() => apply(ctx, undefined))
  assert.ok(registered.length > 0)
  assert.equal(routes.length, 0)
})

test('契约: webServer 可用时注册只读状态路由，且 handler 能返回 JSON', async () => {
  const { ctx, routes } = mockCtx({ withWebServer: true })
  apply(ctx, { root: '/tmp/is-contract-test' })
  assert.equal(routes.length, 1)
  assert.equal(routes[0].path, '/api/inference-serving/status')
  let body = null
  let status = null
  const res = {
    setHeader() {},
    set statusCode(v) { status = v },
    get statusCode() { return status },
    end(b) { body = b },
  }
  await routes[0].handler({}, res)
  const parsed = JSON.parse(body)
  assert.ok(parsed.package)
  assert.equal(typeof parsed.inFlight, 'number')
})

test('契约: 单个工具注册失败被隔离，其余工具照常注册', () => {
  const failing = ALL_TOOL_SPECS[2].name
  const { ctx, registered } = mockCtx({ failOn: failing })
  assert.doesNotThrow(() => apply(ctx, undefined))
  assert.equal(registered.length, ALL_TOOL_SPECS.length - 1)
  assert.ok(!registered.some((t) => t.name === failing))
})

test('契约: 非法配置在加载期响亮失败（不静默忽略）', () => {
  assert.throws(() => validateConfig({ unknownKey: 1 }), /未知配置键/)
  assert.throws(() => validateConfig({ portPoolStart: 9000, portPoolEnd: 8000 }), /不能大于/)
  assert.throws(() => validateConfig({ root: 123 }), /root 必须是字符串/)
  assert.throws(() => validateConfig({ headless: 'yes' }), /headless 必须是布尔值/)
  assert.doesNotThrow(() => validateConfig(undefined))
  assert.doesNotThrow(() => validateConfig({ root: '/tmp/x', portPoolStart: 8100, portPoolEnd: 8199 }))
})

test('契约: 工具的 execute 尊重 exec.signal（已取消时不做事）', async () => {
  const { ctx, registered } = mockCtx()
  apply(ctx, undefined)
  const deployTool = registered.find((t) => t.name === 'inference_serving_deploy')
  const ac = new AbortController()
  ac.abort()
  const out = await deployTool.execute({ model: '/nonexistent' }, { signal: ac.signal })
  assert.equal(out.ok, false)
  assert.equal(out.code, 'E_CANCELLED')
})
