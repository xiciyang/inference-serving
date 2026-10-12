import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { mkdirp } from './fsx.mjs'

/**
 * 跨进程互斥锁 —— 零依赖。
 *
 * 用 `fs.open(path,'wx')`（O_CREAT|O_EXCL）取得原子性，这是 POSIX 下最短的
 * "测试并设置"原语。持锁者把 `{pid, at, host}` 写进锁文件，便于诊断"谁锁着"。
 *
 * 陈旧锁回收：两个条件任一成立即视为陈旧 ——
 *   (a) 锁内记录的 pid 已不存在；
 *   (b) 锁文件 mtime 超过 staleMs。
 * 必须同时校验 pid，因为"文件很旧"也可能是持锁者真的在跑一个慢部署。
 * 反过来只看 pid 也不行：pid 会被复用。
 */

function pidAlive(pid) {
  if (!pid || pid === process.pid) return pid === process.pid
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

async function tryAcquire(lockPath) {
  try {
    const fh = await fs.open(lockPath, 'wx', 0o600)
    const info = JSON.stringify({ pid: process.pid, at: Date.now(), host: process.env.HOSTNAME ?? '' })
    await fh.writeFile(info, 'utf8')
    await fh.close()
    return true
  } catch (err) {
    if (err.code === 'EEXIST') return false
    throw err
  }
}

async function isStale(lockPath, staleMs) {
  try {
    const [raw, st] = await Promise.all([fs.readFile(lockPath, 'utf8'), fs.stat(lockPath)])
    let holder = null
    try { holder = JSON.parse(raw) } catch { holder = null }
    if (holder && holder.pid && !pidAlive(holder.pid)) return { stale: true, reason: `holder pid ${holder.pid} 已退出` }
    if (Date.now() - st.mtimeMs > staleMs) return { stale: true, reason: `锁超过 ${staleMs}ms 未更新` }
    return { stale: false, holder }
  } catch (err) {
    if (err.code === 'ENOENT') return { stale: true, reason: '锁文件已消失' }
    throw err
  }
}

// 不能 unref：等待锁期间事件循环上可能只剩它（见 health.mjs 的同类说明）
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms) })

export async function withLock(lockDir, name, fn, { timeoutMs = 20_000, staleMs = 120_000 } = {}) {
  await mkdirp(lockDir)
  const lockPath = join(lockDir, `${name}.lock`)
  const deadline = Date.now() + timeoutMs
  let acquired = false
  let lastReason = null

  while (!acquired) {
    // eslint-disable-next-line no-await-in-loop
    acquired = await tryAcquire(lockPath)
    if (acquired) break
    // eslint-disable-next-line no-await-in-loop
    const s = await isStale(lockPath, staleMs)
    if (s.stale) {
      lastReason = s.reason
      // eslint-disable-next-line no-await-in-loop
      await fs.rm(lockPath, { force: true })
      continue
    }
    if (Date.now() >= deadline) {
      const e = new Error(`获取锁超时：${name}`)
      e.code = 'ELOCKTIMEOUT'
      e.holder = s.holder
      throw e
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(50 + randomBytes(1)[0] % 100)
  }

  try {
    return await fn()
  } finally {
    await fs.rm(lockPath, { force: true })
  }
}

/** 生成一个进程内唯一的临时目录名（用于资源隔离，题目原则 3.4.3）。 */
export function tempName(prefix) {
  return `${prefix}-${process.pid}-${randomBytes(4).toString('hex')}`
}
