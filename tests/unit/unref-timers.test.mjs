/**
 * 回归测试：**被 await 的定时器绝不能 unref**。
 *
 * 这是一个真实踩过的坑：端到端演示在健康检查轮询期间整进程**静默消失**（exit code 0），
 * 而容器还在后台跑着，日志里没有任何错误。根因是
 *   `const t = setTimeout(resolve, ms); t.unref()`
 * —— 那一刻事件循环上可能只剩这一个定时器，unref 之后 Node 认为无事可做，直接退出。
 *
 * 测试方法：在**子进程**里 await 一个 sleep 再打印，父进程断言子进程确实打印了、
 * 且退出码为 0。若 sleep 被 unref，子进程会提前退出、看不到打印。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')

function runInChild(code) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: root, encoding: 'utf8', timeout: 20_000,
  })
}

test('unref: health 的轮询 sleep 会把事件循环留住（不能 unref）', () => {
  const r = runInChild(`
    import { sleep } from '${join(root, 'src/health.mjs')}'
    await sleep(300)
    console.log('SURVIVED')
  `)
  assert.equal(r.status, 0, `子进程异常退出：${r.stderr}`)
  assert.match(r.stdout, /SURVIVED/, '子进程应在 sleep 之后继续执行 —— 若 sleep 被 unref 就会静默退出')
})

test('unref: lock 的等待 sleep 会把事件循环留住（不能 unref）', () => {
  const r = runInChild(`
    import { withLock } from '${join(root, 'src/util/lock.mjs')}'
    import { mkdtemp } from 'node:fs/promises'
    import { tmpdir } from 'node:os'
    import { join } from 'node:path'
    const dir = await mkdtemp(join(tmpdir(), 'is-lock-'))
    // 先占住锁，逼第二个持锁者进入 sleep 等待分支
    let released = false
    const holder = withLock(dir, 'k', async () => {
      await new Promise((r) => setTimeout(r, 400))
      released = true
    })
    const waiter = withLock(dir, 'k', async () => { /* 等前面释放 */ })
    await Promise.all([holder, waiter])
    console.log('SURVIVED', released)
  `)
  assert.equal(r.status, 0, `子进程异常退出：${r.stderr}`)
  assert.match(r.stdout, /SURVIVED true/)
})

test('unref: ops.drain 在有在途操作时真的等待，而不是立刻返回', () => {
  const r = runInChild(`
    import { drain, executeOperation, inFlightCount } from '${join(root, 'src/ops.mjs')}'
    import { createRuntime } from '${join(root, 'src/config.mjs')}'
    import { mkdtemp } from 'node:fs/promises'
    import { tmpdir } from 'node:os'
    import { join } from 'node:path'

    const root = await mkdtemp(join(tmpdir(), 'is-drain-'))
    const runtime = await createRuntime({ root, options: {} })
    // 借 status 能力起一个"慢操作"，让 inFlight>0，从而真正走到 drain 的等待分支
    const slow = executeOperation(runtime, { capability: 'status', resources: ['state:read'], action: 'slow' },
      async () => { await new Promise((r) => setTimeout(r, 600)); return { ok: true } })
    await new Promise((r) => setTimeout(r, 50))
    const t0 = Date.now()
    const res = await drain({ timeoutMs: 3000 })
    const waited = Date.now() - t0
    await slow
    console.log('SURVIVED', res.drained === true && waited >= 400, 'waited=' + waited)
  `)
  assert.equal(r.status, 0, `子进程异常退出：${r.stderr}`)
  assert.match(r.stdout, /SURVIVED true/, '有在途操作时 drain 必须等到它结束')
})

test('unref: 端到端 —— 一个"部署 + 轮询"循环在子进程里不会中途消失', () => {
  // 复现当初的事故形状：spawn 一个后台进程 + 轮询等待它就绪
  const r = runInChild(`
    import { run } from '${join(root, 'src/util/proc.mjs')}'
    import { sleep } from '${join(root, 'src/health.mjs')}'
    const child = run(process.execPath, ['-e', 'setTimeout(()=>{}, 1500)'], { timeoutMs: 5000 })
    let ticks = 0
    for (let i = 0; i < 6; i += 1) { await sleep(100); ticks += 1 }
    console.log('SURVIVED ticks=' + ticks)
    await child
  `)
  assert.equal(r.status, 0, `子进程异常退出：${r.stderr}`)
  assert.match(r.stdout, /SURVIVED ticks=6/, '轮询循环必须跑满 6 次，不能中途整进程消失')
})
