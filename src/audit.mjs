/**
 * 审计日志（题目原则 3.4.5 / 验收标准 5.3.7）。
 *
 * 三重保证"只追加、不可删改"：
 *  1. 文件以 `'a'`（O_APPEND）打开，程序里**不存在**删除/改写审计的 API；
 *  2. 目录 0700 / 文件 0600；
 *  3. 每条记录带 `prevHash`，用 sha256 串成哈希链 —— 任何删改都会在链上留下断点，
 *     由 `verifyAuditChain()` 检出。
 *
 * 审计写失败时的行为由 `options.continueOnAuditFailure` 决定，默认 **false**：
 * 审计是安全属性，写不下去就不该假装操作成功。
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { appendLine, readText, listDir, mkdirp } from './util/fsx.mjs'
import { sha256, canonicalJson, shortId } from './util/hash.mjs'
import { AUDIT_FORMAT_VERSION, PACKAGE_VERSION } from './version.mjs'
import { fail, ERROR_CODES } from './errors.mjs'

const GENESIS = '0'.repeat(64)

function dateKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
}

export function auditFileFor(runtime, date = new Date()) {
  return join(runtime.paths.auditDir, `${dateKey(date)}.jsonl`)
}

async function readTail(file) {
  const raw = await readText(file, '')
  if (!raw) return { seq: 0, hash: GENESIS }
  const lines = raw.split('\n').filter((l) => l.trim() !== '')
  if (lines.length === 0) return { seq: 0, hash: GENESIS }
  try {
    const last = JSON.parse(lines[lines.length - 1])
    return { seq: last.seq ?? lines.length, hash: last.hash ?? GENESIS }
  } catch {
    // 最后一行损坏（进程被杀在写一半）—— 不猜，退回上一行重算
    if (lines.length >= 2) {
      const prev = JSON.parse(lines[lines.length - 2])
      return { seq: prev.seq ?? lines.length - 1, hash: prev.hash ?? GENESIS }
    }
    return { seq: 0, hash: GENESIS }
  }
}

function computeHash(record) {
  const { hash, ...rest } = record
  return sha256(`${rest.prevHash}\n${canonicalJson(rest)}`)
}

/**
 * 追加一条审计记录。返回落盘后的记录（含 hash）。
 * @param {object} runtime
 * @param {object} entry 业务字段：capability/action/outcome/code/... 
 */
export async function appendAudit(runtime, entry) {
  const file = auditFileFor(runtime)
  let record = null
  try {
    await mkdirp(runtime.paths.auditDir)
    const { seq, hash: prevHash } = await readTail(file)
    record = {
      v: AUDIT_FORMAT_VERSION,
      seq: seq + 1,
      ts: new Date().toISOString(),
      auditId: entry.auditId ?? `aud_${shortId(`${Date.now()}-${seq + 1}-${Math.random()}`, 12)}`,
      pkg: PACKAGE_VERSION,
      pid: process.pid,
      host: runtime.env.HOSTNAME ?? null,
      // headless 是审计的全局事实：每条记录都带上，便于事后区分"人确认过"与"自动放行"
      headless: entry.headless ?? runtime.headless,
      ...entry,
      prevHash,
    }
    delete record.hash
    record.hash = computeHash(record)
    await appendLine(file, JSON.stringify(record))
  } catch (err) {
    if (runtime.options.continueOnAuditFailure) {
      runtime.warnings.push({ code: 'W_AUDIT_WRITE_FAILED', message: String(err.message), details: { file } })
      return record ?? { v: AUDIT_FORMAT_VERSION, ts: new Date().toISOString(), ...entry, hash: null, unsaved: true }
    }
    fail(ERROR_CODES.E_INTERNAL, `审计日志写入失败：${file}`, {
      remediation: `审计是强制项。请确认 ${runtime.paths.auditDir} 是一个可写目录（不是文件、权限正确），或显式设置 options.continueOnAuditFailure=true 以在审计失败时继续（不推荐）。`,
      details: { file, error: String(err.message), code: err.code ?? null },
      cause: err,
    })
  }
  return record
}

/** 读取某天的全部审计记录。 */
export async function readAudit(runtime, date = new Date()) {
  const file = auditFileFor(runtime, date)
  const raw = await readText(file, '')
  return raw.split('\n').filter((l) => l.trim() !== '').map((l) => {
    try { return JSON.parse(l) } catch { return { corrupt: true, raw: l } }
  })
}

/** 校验某天审计链的完整性。返回 {ok, count, brokenAt, reason}。 */
export async function verifyAuditChain(runtime, date = new Date()) {
  const records = await readAudit(runtime, date)
  let prev = GENESIS
  for (let i = 0; i < records.length; i += 1) {
    const r = records[i]
    if (r.corrupt) return { ok: false, count: records.length, brokenAt: i, reason: 'JSON 解析失败（记录被改写或截断）' }
    if (r.prevHash !== prev) {
      return { ok: false, count: records.length, brokenAt: i, reason: `prevHash 不匹配：期望 ${prev.slice(0, 12)}…，实到 ${String(r.prevHash).slice(0, 12)}…（中间有记录被删除或改写）` }
    }
    const expected = computeHash({ ...r, hash: undefined })
    if (r.hash !== expected) {
      return { ok: false, count: records.length, brokenAt: i, reason: '记录自哈希不匹配（内容被改写）' }
    }
    prev = r.hash
  }
  return { ok: true, count: records.length, brokenAt: null, reason: null, head: prev.slice(0, 12) }
}

/** 列出已有审计文件。 */
export async function listAuditFiles(runtime) {
  const names = await listDir(runtime.paths.auditDir)
  return names.filter((n) => n.endsWith('.jsonl')).sort()
}

export { dateKey, GENESIS, computeHash }
