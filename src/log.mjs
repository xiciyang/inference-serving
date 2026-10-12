/**
 * 结构化日志（验收标准 5.4.5）。
 *
 * 每条一行 JSONL，落到 `~/.ai-infra/logs/inference-serving/{date}.log`。
 * 与审计的分工：**审计 = 安全事实**（谁在什么风险档下做了什么、结果如何，哈希链保护）；
 * **日志 = 运行细节**（阶段、耗时、原始命令、stderr 片段）。两者都不进模型上下文，
 * 需要时由报告或 CLI 读取。
 *
 * 写入是"尽力而为"的：日志失败不阻断业务（它不是安全属性）。
 */
import { appendLine, mkdirp } from './util/fsx.mjs'
import { join } from 'node:path'

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }

function dateKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
}

export function createLogger(runtime, { capability = null, auditId = null, level = null } = {}) {
  const minLevel = LEVELS[level ?? runtime.env.INFERENCE_SERVING_LOG_LEVEL ?? 'info'] ?? 20
  const file = join(runtime.paths.appLogDir, `${dateKey()}.log`)
  const buffer = []
  const inMemory = []
  const startedAt = Date.now()

  const flush = async () => {
    if (buffer.length === 0) return
    const batch = buffer.splice(0, buffer.length).join('')
    try {
      await mkdirp(runtime.paths.appLogDir)
      await appendLine(file, batch.replace(/\n$/, ''))
    } catch {
      // 日志是尽力而为
    }
  }

  const emit = (levelName, message, data) => {
    if ((LEVELS[levelName] ?? 20) < minLevel) return
    const rec = {
      ts: new Date().toISOString(),
      level: levelName,
      capability,
      auditId,
      msg: message,
      ...(data ? { data } : {}),
    }
    inMemory.push(rec)
    if (inMemory.length > 500) inMemory.shift()
    buffer.push(`${JSON.stringify(rec)}\n`)
    if (buffer.length >= 25) void flush()
    return rec
  }

  return {
    file,
    startedAt,
    debug: (m, d) => emit('debug', m, d),
    info: (m, d) => emit('info', m, d),
    warn: (m, d) => emit('warn', m, d),
    error: (m, d) => emit('error', m, d),
    /** 阶段事件：带耗时，便于报告与性能分析。 */
    phase: (name, data) => emit('info', `phase:${name}`, data),
    records: () => [...inMemory],
    flush,
    /** 把 in-memory 记录摘要成报告用的一段文本。 */
    summary: () => inMemory.filter((r) => r.level !== 'debug').map((r) => `[${r.level}] ${r.msg}`),
  }
}
