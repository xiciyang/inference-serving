/**
 * 清理与中断处理（题目原则 3.4.3/3.4.5，验收标准 5.1.5、5.4.4）。
 *
 * 全部动作走**驱动接缝**（`src/drivers/`），核心不认识 docker。
 *
 * 三条硬规则：
 *  1. **只删自己管理的载体**。安全阀在驱动层（docker 驱动校验 managed 标签）——
 *     本机跑着 `qwen3-embedding` 与一批 `xagentlab-*`，按镜像名批量清理会误伤。
 *  2. **删完要验证**：载体真的没了、端口真的释放了，才算清理成功。
 *  3. **崩溃也要能清**：进程退出钩子 + 重启后的孤儿对账（reconcile）。
 */
import { promises as fs } from 'node:fs'
import { isPortFree } from './util/http.mjs'
import { warn, WARNING_CODES } from './errors.mjs'
import { getDriver, listDrivers, listManagedAcrossDrivers, hasDriver } from './drivers/index.mjs'
import { allBackends } from './backends/index.mjs'

/* ------------------------------------------------------------------
 * 关于 unref()：**只有"不该拖住进程退出"的定时器才可以 unref**。
 *
 * 被 await 的延迟绝不能 unref：那一刻事件循环上可能只剩这一个定时器，
 * unref 之后 Node 会认为无事可做而**静默退出（exit code 0）**——
 * 本项目真实踩过：端到端演示在健康检查轮询期间整进程消失，
 * 而容器还在后台跑着，日志里没有任何错误。
 *
 * 这里保留 unref 的只有两类：
 *   1. killGraceMs 兜底 SIGKILL 定时器（子进程本身已持有事件循环）
 *   2. 发起型（request/exec）的超时定时器 —— 请求/子进程同样已持有事件循环，
 *      且它们会在 settle 时被 clearTimeout 清掉
 * ------------------------------------------------------------------ */

export const MANAGED_LABEL = 'inference-serving.managed=true'

const pending = new Set()
let hooksInstalled = false

export function registerCleanup(fn) {
  pending.add(fn)
  return () => pending.delete(fn)
}

export function installExitHooks(runtime, { logger = null } = {}) {
  if (hooksInstalled) return
  hooksInstalled = true

  const drain = async (reason) => {
    if (pending.size === 0) return
    if (logger) logger.warn(`收到 ${reason}，开始清理 ${pending.size} 项`, null)
    for (const fn of [...pending]) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await fn()
      } catch (err) {
        runtime.warnings.push(warn(WARNING_CODES.W_RESIDUAL_CLEANUP, `退出清理失败：${err.message}`, { reason }))
      }
      pending.delete(fn)
    }
  }

  process.on('exit', () => {
    for (const fn of [...pending]) {
      try { void fn() } catch { /* best effort */ }
    }
  })
  process.on('SIGINT', () => { void drain('SIGINT').finally(() => process.exit(130)) })
  process.on('SIGTERM', () => void drain('SIGTERM').finally(() => process.exit(143)))
  process.on('uncaughtException', (err) => {
    void drain('uncaughtException').finally(() => {
      // eslint-disable-next-line no-console
      console.error('[inference-serving] uncaughtException:', err)
      process.exit(1)
    })
  })
}

/** 解析某个 revision 该用哪个驱动。 */
export function driverForRevision(revision) {
  const id = revision?.driver ?? 'docker'
  if (hasDriver(id)) return getDriver(id)
  if (revision?.backend) {
    const b = allBackends().find((x) => x.id === revision.backend)
    if (b) return getDriver(b.driver ?? 'docker')
  }
  return getDriver('docker')
}

/** 清理一个 revision 占用的资源，并**验证**清理干净。 */
export async function cleanupRevision(runtime, revision, { timeoutMs = 60_000, driver = null } = {}) {
  const result = { container: null, portReleased: null, residual: [], ok: true, driver: null }
  if (!revision?.containerName) {
    result.ok = true
    return result
  }
  let d = driver
  try {
    d = d ?? driverForRevision(revision)
  } catch (err) {
    result.ok = false
    result.residual.push(`无法解析驱动：${err.message}`)
    return result
  }
  result.driver = d.id

  result.container = await d.stop(revision.containerName, { timeoutMs })
  if (result.container.refused) {
    result.ok = false
    result.residual.push(result.container.reason)
  }
  const still = await d.inspect(revision.containerName)
  if (still.exists) {
    result.ok = false
    result.residual.push(`载体 ${revision.containerName} 仍然存在（status=${still.status}）`)
  }

  if (revision.bindHost && revision.port) {
    let free = false
    for (let i = 0; i < 10; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      free = await isPortFree(revision.bindHost, revision.port)
      if (free) break
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => { setTimeout(r, 500) })
    }
    result.portReleased = free
    if (!free) {
      result.ok = false
      result.residual.push(`端口 ${revision.bindHost}:${revision.port} 仍被占用`)
    }
  }
  return result
}

/** 列出所有驱动管理的工作负载。 */
export async function listManagedInstances({ includeStopped = true } = {}) {
  const drivers = new Set(allBackends().map((b) => b.driver ?? 'docker'))
  for (const id of listDrivers()) drivers.add(id)
  const out = []
  const errors = []
  for (const id of drivers) {
    if (!hasDriver(id)) continue
    // eslint-disable-next-line no-await-in-loop
    const r = await getDriver(id).listManaged({ includeStopped })
    if (r.ok) out.push(...r.instances.map((i) => ({ ...i, driver: id })))
    else errors.push({ driver: id, error: r.error })
  }
  return { ok: errors.length === 0, containers: out, instances: out, errors }
}

/** 兼容旧名（内部仍在用）。 */
export const listManagedContainers = listManagedInstances

/**
 * 孤儿对账：本插件管理、但注册表里没有记录的工作负载。
 * 这是 SIGKILL / 宿主掉电后唯一能兜住残留的机制（验收标准 5.4.4）。
 */
export async function findOrphans(runtime) {
  const { loadRegistry } = await import('./state/registry.mjs')
  const reg = await loadRegistry(runtime)
  const known = new Set()
  for (const e of reg.endpoints) {
    for (const r of e.revisions ?? []) if (r.containerName) known.add(r.containerName)
  }
  const listed = await listManagedInstances({ includeStopped: true })
  if (!listed.ok) return { ok: false, error: listed.errors.map((e) => `${e.driver}: ${e.error}`).join('; '), orphans: [] }
  const orphans = listed.containers.filter((c) => !known.has(c.name))
  return { ok: true, orphans, managed: listed.containers, known: [...known] }
}

export async function reapOrphans(runtime, orphans) {
  const results = []
  for (const o of orphans) {
    // eslint-disable-next-line no-await-in-loop
    const driver = hasDriver(o.driver ?? 'docker') ? getDriver(o.driver ?? 'docker') : getDriver('docker')
    // eslint-disable-next-line no-await-in-loop
    const r = await driver.stop(o.name)
    results.push({ name: o.name, driver: driver.id, ...r })
  }
  return results
}

/** 生成容器/进程名（确定性：同一次逻辑部署得到同一个名字，便于对账）。 */
export function containerNameFor(endpointId) {
  return `inference-serving-${endpointId.replace(/^ep_/, '')}`
}

export async function resetTmpDir(runtime) {
  try {
    await fs.rm(runtime.paths.tmpDir, { recursive: true, force: true })
    await fs.mkdir(runtime.paths.tmpDir, { recursive: true, mode: 0o700 })
  } catch { /* 尽力而为 */ }
}

export { listManagedAcrossDrivers }
