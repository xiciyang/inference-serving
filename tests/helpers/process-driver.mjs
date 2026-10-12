/**
 * 测试用 spawn 驱动：把"工作负载"当普通子进程管理。
 *
 * 存在的意义：让**整个部署闭环**（预检 → 启动 → 三关健康检查 → 降级 → 注册 →
 * 幂等 → 回退 → 拆解 → 审计）能在**没有 GPU、没有 Docker** 的机器上被真跑一遍。
 * 它同时证明核心逻辑确实只依赖驱动接缝，不认识 docker（验收标准 5.5.2）。
 *
 * 生产环境中它不被注册（registry 只由 src/backends/index.mjs 加载内置后端）。
 */
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { registerDriver } from '../../src/drivers/index.mjs'

const registry = new Map() // name -> { pid, pidFile, logFile }

function alive(pid) {
  try { process.kill(pid, 0); return true } catch (err) { return err.code === 'EPERM' }
}

export const processDriver = {
  id: 'process',
  displayName: 'Test process driver (spawn)',

  async launch(spec) {
    const { cmd, args, containerName, pidFile, logFile } = spec
    await fs.mkdir(join(pidFile, '..'), { recursive: true }).catch(() => {})
    const out = await fs.open(logFile, 'a')
    const child = spawn(cmd, args, { detached: true, stdio: ['ignore', out.fd, out.fd] })
    child.unref()
    await out.close()
    await fs.writeFile(pidFile, String(child.pid), 'utf8')
    registry.set(containerName, { pid: child.pid, pidFile, logFile })
    return { ok: true, id: String(child.pid), code: 0, stdout: String(child.pid), stderr: '', ms: 0 }
  },

  async inspect(name) {
    const rec = registry.get(name)
    if (!rec) return { exists: false, running: false }
    const running = alive(rec.pid)
    return { exists: true, running, status: running ? 'running' : 'exited', exitCode: running ? 0 : 1, pid: rec.pid }
  },

  async logs(name, { tail = 80 } = {}) {
    const rec = registry.get(name)
    if (!rec) return { stdout: '', stderr: '', combined: '' }
    try {
      const raw = await fs.readFile(rec.logFile, 'utf8')
      const lines = raw.split('\n').slice(-tail).join('\n')
      return { stdout: lines, stderr: '', combined: lines }
    } catch {
      return { stdout: '', stderr: '', combined: '' }
    }
  },

  async stop(name) {
    const rec = registry.get(name)
    if (!rec) return { removed: false, absent: true, reason: '未登记（幂等处理为已清理）' }
    if (alive(rec.pid)) {
      try { process.kill(rec.pid, 'SIGKILL') } catch { /* 已退出 */ }
      for (let i = 0; i < 40 && alive(rec.pid); i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 25))
      }
    }
    registry.delete(name)
    await fs.rm(rec.pidFile, { force: true })
    return { removed: !alive(rec.pid), reason: null }
  },

  async listManaged() {
    const instances = []
    for (const [name, rec] of registry) {
      instances.push({ name, status: alive(rec.pid) ? 'running' : 'exited', image: 'fake', ports: '' })
    }
    return { ok: true, instances }
  },

  /** 测试收尾：杀掉所有登记进程。 */
  async stopAll() {
    for (const name of [...registry.keys()]) {
      // eslint-disable-next-line no-await-in-loop
      await this.stop(name)
    }
  },

  __registry: registry,
}

registerDriver(processDriver)
export default processDriver
