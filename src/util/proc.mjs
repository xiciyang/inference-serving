import { spawn } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import { delimiter, join } from 'node:path'

/**
 * 子进程执行器 —— 每个操作都有明确超时和取消信号（题目原则 3.4.2）。
 *
 * 约定：
 *   - 非零退出码**不抛异常**，而是作为结果返回。调用方需要区分"命令跑了但失败"
 *     与"命令根本没起来"，前者是业务降级信号，后者是环境问题。
 *   - `spawnError`（如 ENOENT）单独返回，便于给出"未安装 X"这类可操作提示。
 *   - 超时/取消时先 SIGTERM，宽限期内不退再 SIGKILL，避免留下孤儿进程。
 *   - 绝不 `shell: true`（除显式要求），避免注入面。
 */
export async function run(cmd, args = [], opts = {}) {
  const {
    timeoutMs = 30_000,
    signal,
    cwd,
    env,
    input,
    maxBuffer = 8 * 1024 * 1024,
    killGraceMs = 3_000,
    shell = false,
  } = opts

  const startedAt = Date.now()
  return new Promise((resolvePromise) => {
    let child
    try {
      child = spawn(cmd, args, {
        cwd,
        env: env ?? process.env,
        shell,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (err) {
      resolvePromise({
        cmd, args, code: null, signal: null, stdout: '', stderr: '',
        spawnError: err, timedOut: false, aborted: false, durationMs: Date.now() - startedAt,
      })
      return
    }

    let stdout = ''
    let stderr = ''
    let truncated = false
    let timedOut = false
    let aborted = false
    let settled = false

    const append = (cur, chunk) => {
      if (cur.length >= maxBuffer) { truncated = true; return cur }
      return cur + chunk.toString('utf8')
    }

    child.stdout.on('data', (c) => { stdout = append(stdout, c) })
    child.stderr.on('data', (c) => { stderr = append(stderr, c) })

    const killTree = () => {
      try { child.kill('SIGTERM') } catch { /* already gone */ }
      const t = setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* already gone */ }
      }, killGraceMs)
      t.unref?.()
    }

    // 不 unref：虽然子进程本身已持有事件循环，但 unref 会让"超时"语义依赖于
    // 别处还有没有 handle —— 语义应当自洽，不该依赖外部巧合。
    const timer = timeoutMs > 0
      ? setTimeout(() => { timedOut = true; killTree() }, timeoutMs)
      : null

    const onAbort = () => { aborted = true; killTree() }
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }

    const finish = (code, sig, spawnError) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
      resolvePromise({
        cmd, args, code, signal: sig, stdout, stderr,
        spawnError: spawnError ?? null, timedOut, aborted, truncated,
        durationMs: Date.now() - startedAt,
      })
    }

    child.on('error', (err) => finish(null, null, err))
    child.on('close', (code, sig) => finish(code, sig, null))

    if (input !== undefined && input !== null) {
      child.stdin.end(input)
    } else {
      child.stdin.end()
    }
  })
}

/** 命令是否在 PATH 上（用 which，不猜路径）。 */
export async function which(bin) {
  const r = await run('which', [bin], { timeoutMs: 5_000 })
  return r.code === 0 ? r.stdout.trim().split('\n')[0] : null
}

/** 文件是否可执行。 */
export async function isExecutable(p) {
  try {
    await access(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** 在 PATH 中枚举候选，返回第一个可执行的绝对路径。 */
export async function findBinary(candidates) {
  const paths = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  for (const name of candidates) {
    if (name.includes('/')) {
      if (await isExecutable(name)) return name
      continue
    }
    for (const dir of paths) {
      const p = join(dir, name)
      if (await isExecutable(p)) return p
    }
  }
  return null
}
