/**
 * Docker 驱动。
 *
 * 安全阀（对应 RISK_CLASSIFICATION_DRAFT.md §5 第 2 项）：
 *   `stop()` 先读容器标签，**只有带 inference-serving.managed=true 的才允许删除**。
 *   本机跑着 `qwen3-embedding`（vLLM）与一批 `xagentlab-*` 服务，按镜像名批量清理会误伤。
 *   这条不是"防御性编程"，是针对本机实际情况的硬约束。
 */
import { run } from '../util/proc.mjs'
import { mkdirp } from '../util/fsx.mjs'
import { join } from 'node:path'
import { promises as fs } from 'node:fs'
import { registerDriver } from './index.mjs'

export const MANAGED_LABEL_KEY = 'inference-serving.managed'
export const MANAGED_LABEL = `${MANAGED_LABEL_KEY}=true`

export const dockerDriver = {
  id: 'docker',
  displayName: 'Docker',

  async available() {
    const r = await run('docker', ['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 15_000 })
    return { available: r.code === 0, detail: r.code === 0 ? `docker ${r.stdout.trim()}` : (r.stderr.trim() || r.spawnError?.message || 'daemon 不可用') }
  },

  /** 启动。spec.cmd/spec.args 由后端构造（见 backends/nvidia-vllm.mjs）。 */
  async launch(spec, { timeoutMs = 120_000, signal } = {}) {
    const r = await run(spec.cmd, spec.args, { timeoutMs, signal })
    return {
      ok: r.code === 0,
      id: r.code === 0 ? r.stdout.trim().slice(0, 12) : null,
      code: r.code,
      stdout: r.stdout.trim(),
      stderr: r.stderr.trim(),
      spawnError: r.spawnError?.message ?? null,
      timedOut: r.timedOut,
      ms: r.durationMs,
    }
  },

  async inspect(name) {
    if (!name) return { exists: false, running: false }
    const r = await run('docker', ['inspect', '--format', '{{.State.Running}}|{{.State.Status}}|{{.State.ExitCode}}|{{.State.StartedAt}}', name], { timeoutMs: 15_000 })
    if (r.code !== 0) return { exists: false, running: false, detail: r.stderr.trim() || 'inspect 失败' }
    const [running, status, exitCode, startedAt] = r.stdout.trim().split('|')
    return { exists: true, running: running === 'true', status, exitCode: Number(exitCode), startedAt }
  },

  async logs(name, { tail = 80 } = {}) {
    const r = await run('docker', ['logs', '--tail', String(tail), name], { timeoutMs: 20_000 })
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', combined: `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim() }
  },

  /**
   * 停止并删除。安全阀：标签不是 true 一律拒绝。
   * 容器不存在视为**成功**（幂等），不算失败。
   */
  async stop(name, { timeoutMs = 60_000 } = {}) {
    if (!name) return { removed: false, absent: true, reason: 'no name' }
    const label = await run('docker', ['inspect', '--format', `{{index .Config.Labels "${MANAGED_LABEL_KEY}"}}`, name], { timeoutMs: 15_000 })
    if (label.code !== 0) return { removed: false, absent: true, reason: '容器不存在（幂等处理为已清理）' }
    if (label.stdout.trim() !== 'true') {
      return { removed: false, refused: true, reason: `容器 ${name} 没有 ${MANAGED_LABEL} 标签，拒绝删除（保护既有服务）` }
    }
    const r = await run('docker', ['rm', '-f', name], { timeoutMs })
    return { removed: r.code === 0, reason: r.code === 0 ? null : (r.stderr.trim() || r.spawnError?.message || 'docker rm 失败'), stdout: r.stdout.trim() }
  },

  async listManaged({ includeStopped = true } = {}) {
    const args = ['ps', '--filter', `label=${MANAGED_LABEL}`, '--format', '{{.Names}}|{{.Status}}|{{.Image}}|{{.Ports}}']
    if (includeStopped) args.splice(1, 0, '-a')
    const r = await run('docker', args, { timeoutMs: 20_000 })
    if (r.code !== 0) return { ok: false, error: r.stderr.trim() || r.spawnError?.message, instances: [] }
    const instances = r.stdout.trim().split('\n').filter(Boolean).map((line) => {
      const [name, status, image, ports] = line.split('|')
      return { name, status, image, ports }
    })
    return { ok: true, instances }
  },

  /** 清空本驱动管理的全部工作负载（仅测试/演示的收尾使用）。 */
  async stopAllManaged() {
    const listed = await this.listManaged({ includeStopped: true })
    const results = []
    for (const i of listed.instances ?? []) {
      // eslint-disable-next-line no-await-in-loop
      results.push({ name: i.name, ...(await this.stop(i.name)) })
    }
    return results
  },
}

export { run, mkdirp, join, fs }

// 自注册：任何 import 本模块的地方即完成注册（单向依赖，无环）。
registerDriver(dockerDriver)

export default dockerDriver
