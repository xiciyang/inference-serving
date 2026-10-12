/**
 * 驱动接缝（runtime driver seam）。
 *
 * 为什么需要它：核心逻辑（deploy / health / cleanup / lifecycle）如果直接调 `docker`，
 * 「软硬件解耦」（题目原则 3.1.2 / 验收 5.5.2）就只是口号 —— 换平台要改核心。
 * 把「怎么起一个工作负载、怎么查它、怎么停它」抽成驱动，后端只声明 `driver: 'docker'`。
 *
 * 驱动的接口（四个动作，足够覆盖容器与进程两类载体）：
 *   launch(spec)            → { id, raw }
 *   inspect(name)           → { exists, running, status, exitCode, startedAt }
 *   logs(name, {tail})      → { stdout, stderr }
 *   stop(name, {timeoutMs}) → { removed, absent, refused, reason }
 *   listManaged()           → { ok, instances: [{ name, status, image, ports }] }
 *
 * `stop` 必须自带安全阀：拒绝删除不属于本插件的载体（见 drivers/docker.mjs）。
 */
const drivers = new Map()

export function registerDriver(driver) {
  if (!driver || typeof driver.id !== 'string' || driver.id === '') {
    throw new Error('registerDriver: driver.id 必须是非空字符串')
  }
  for (const m of ['launch', 'inspect', 'logs', 'stop', 'listManaged']) {
    if (typeof driver[m] !== 'function') throw new Error(`registerDriver(${driver.id}): 缺必需方法 ${m}()`)
  }
  drivers.set(driver.id, driver)
  return driver
}

export function getDriver(id) {
  const d = drivers.get(id)
  if (!d) {
    const known = [...drivers.keys()].join(', ') || '(无)'
    throw new Error(`未知驱动 "${id}"；已注册：${known}`)
  }
  return d
}

export function hasDriver(id) {
  return drivers.has(id)
}

export function listDrivers() {
  return [...drivers.keys()].sort()
}

export function __resetDrivers() {
  drivers.clear()
}

/** 由后端对象解析出其驱动。 */
export function driverForBackend(backend) {
  const id = backend?.driver ?? 'docker'
  return getDriver(id)
}

/** 枚举所有已注册后端所用驱动管理的工作负载（去重）。 */
export async function listManagedAcrossDrivers(backends) {
  const seen = new Set()
  const instances = []
  const errors = []
  for (const b of backends) {
    const id = b.driver ?? 'docker'
    if (seen.has(id)) continue
    seen.add(id)
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await getDriver(id).listManaged()
      if (r.ok) instances.push(...r.instances.map((i) => ({ ...i, driver: id })))
      else errors.push({ driver: id, error: r.error })
    } catch (err) {
      errors.push({ driver: id, error: String(err.message) })
    }
  }
  return { ok: errors.length === 0, instances, errors }
}
