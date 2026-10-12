import { promises as fs } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'

/** 展开 `~` 与 `~/x`。 */
export function expandHome(p) {
  if (typeof p !== 'string') return p
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p
}

export async function mkdirp(dir) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  return dir
}

export async function exists(p) {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

export async function statOrNull(p) {
  try {
    return await fs.stat(p)
  } catch {
    return null
  }
}

export async function readText(p, fallback = null) {
  try {
    return await fs.readFile(p, 'utf8')
  } catch (err) {
    if (err && err.code === 'ENOENT') return fallback
    throw err
  }
}

/**
 * 原子写：同目录临时文件 + rename。
 * 同目录是必须的 —— 跨设备 rename 会退化并失去原子性。
 */
export async function atomicWrite(p, content, { mode = 0o600 } = {}) {
  const dir = dirname(p)
  await mkdirp(dir)
  const tmp = join(dir, `.${randomBytes(6).toString('hex')}.tmp`)
  await fs.writeFile(tmp, content, { mode })
  try {
    await fs.rename(tmp, p)
  } catch (err) {
    await fs.rm(tmp, { force: true })
    throw err
  }
  return p
}

/** 原子写 JSON（带缩进，便于人工复核）。 */
export async function atomicWriteJson(p, value, opts) {
  return atomicWrite(p, `${JSON.stringify(value, null, 2)}\n`, opts)
}

/**
 * 只追加写。审计日志专用 —— 返回写入的字节数。
 * 用 'a' 打开（O_APPEND），配合 0600，是"只追加不可改"在 POSIX 下的直接表达。
 */
export async function appendLine(p, line) {
  await mkdirp(dirname(p))
  const fh = await fs.open(p, 'a', 0o600)
  try {
    const buf = Buffer.from(line.endsWith('\n') ? line : `${line}\n`, 'utf8')
    await fh.write(buf)
    return buf.length
  } finally {
    await fh.close()
  }
}

/** 目录可写性实测 —— 不靠权限位推断，直接试写。 */
export async function isWritableDir(dir) {
  try {
    await mkdirp(dir)
    const probe = join(resolve(dir), `.wprobe-${randomBytes(4).toString('hex')}`)
    await fs.writeFile(probe, 'x')
    await fs.rm(probe, { force: true })
    return true
  } catch {
    return false
  }
}

export async function listDir(p) {
  try {
    return await fs.readdir(p)
  } catch (err) {
    if (err && err.code === 'ENOENT') return []
    throw err
  }
}

export { fs }
