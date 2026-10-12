/**
 * 后端注册表 —— **软硬件解耦的接缝**（题目原则 3.1.2，验收标准 5.5.2）。
 *
 * 核心逻辑（deploy/health/registry/lifecycle）里**没有任何** `if (vendor === 'nvidia')`
 * 之类的硬件分支；它只调用本注册表给出的后端对象。新增硬件平台 = 新增一个后端模块并
 * `register()`，核心零改动。
 *
 * 三个角色不互相依赖（沿用 DSH 官方三层接缝约定）：
 *   Definition（本文件的后端形状）
 *     → Provider（src/backends/nvidia-vllm.mjs 等具体后端）
 *       → Consumer（src/deploy.mjs 等核心逻辑）
 */
const backends = new Map()

/** 后端必须实现的形状。register() 会逐项校验，缺项立刻响亮失败。 */
const REQUIRED_METHODS = ['defaultConfig', 'preflight', 'buildLaunchSpec', 'describe']

export function register(backend) {
  if (!backend || typeof backend.id !== 'string' || backend.id === '') {
    throw new Error('register(backend): backend.id 必须是非空字符串')
  }
  for (const m of REQUIRED_METHODS) {
    if (typeof backend[m] !== 'function') {
      throw new Error(`register(${backend.id}): 缺必需方法 ${m}()`)
    }
  }
  if (backends.has(backend.id)) {
    throw new Error(`register(${backend.id}): 该后端 id 已注册（重复注册会掩盖加载顺序问题，故直接拒绝）`)
  }
  backends.set(backend.id, backend)
  return backend
}

export function unregister(id) {
  return backends.delete(id)
}

export function getBackend(id) {
  return backends.get(id) ?? null
}

export function listBackends() {
  return [...backends.keys()].sort()
}

export function allBackends() {
  return [...backends.values()]
}

/** 供测试使用：清空注册表。 */
export function __resetBackends() {
  backends.clear()
}

/**
 * 按环境筛选可用后端（软硬件解耦点：这里只问后端自己"你能不能跑"）。
 */
export function selectableBackends(env) {
  return allBackends().filter((b) => b.isAvailable(env)).map((b) => b.id)
}
