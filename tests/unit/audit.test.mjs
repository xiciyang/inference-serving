import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeSandbox } from '../helpers/sandbox.mjs'
import { createRuntime } from '../../src/config.mjs'
import { appendAudit, readAudit, verifyAuditChain, auditFileFor, GENESIS, computeHash, listAuditFiles } from '../../src/audit.mjs'
import { promises as fs } from 'node:fs'

async function rt() {
  const sb = await makeSandbox()
  const runtime = await createRuntime({ root: sb.root, options: sb.options })
  return { sb, runtime }
}

test('audit: 哈希链 —— 每条记录串起前一条', async () => {
  const { sb, runtime } = await rt()
  try {
    const a = await appendAudit(runtime, { capability: 'status', action: 'status', phase: 'end', outcome: 'ok' })
    const b = await appendAudit(runtime, { capability: 'deploy', action: 'deploy', phase: 'start' })
    const c = await appendAudit(runtime, { capability: 'deploy', action: 'deploy', phase: 'end', outcome: 'ok' })
    assert.equal(a.seq, 1)
    assert.equal(a.prevHash, GENESIS)
    assert.equal(b.prevHash, a.hash)
    assert.equal(c.prevHash, b.hash)
    const v = await verifyAuditChain(runtime)
    assert.equal(v.ok, true)
    assert.equal(v.count, 3)
  } finally { await sb.cleanup() }
})

test('audit: 删掉中间一条 → 链断裂被检出（不可篡改）', async () => {
  const { sb, runtime } = await rt()
  try {
    for (let i = 0; i < 4; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await appendAudit(runtime, { capability: 'status', action: 'x', seq_note: i })
    }
    assert.equal((await verifyAuditChain(runtime)).ok, true)

    const file = auditFileFor(runtime)
    const lines = (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean)
    lines.splice(1, 1) // 删第 2 条
    await fs.writeFile(file, `${lines.join('\n')}\n`)

    const v = await verifyAuditChain(runtime)
    assert.equal(v.ok, false)
    assert.match(v.reason, /prevHash 不匹配|链/)
  } finally { await sb.cleanup() }
})

test('audit: 改写记录内容 → 自哈希不匹配被检出', async () => {
  const { sb, runtime } = await rt()
  try {
    await appendAudit(runtime, { capability: 'deploy', action: 'deploy', outcome: 'ok' })
    await appendAudit(runtime, { capability: 'deploy', action: 'deploy', outcome: 'denied' })
    const file = auditFileFor(runtime)
    const lines = (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean)
    const rec = JSON.parse(lines[1])
    rec.outcome = 'ok' // 把"被拒绝"改成"成功"
    lines[1] = JSON.stringify(rec)
    await fs.writeFile(file, `${lines.join('\n')}\n`)
    const v = await verifyAuditChain(runtime)
    assert.equal(v.ok, false)
  } finally { await sb.cleanup() }
})

test('audit: 只追加 —— 文件以 a 模式打开，模块不导出任何删除/改写 API', async () => {
  const mod = await import('../../src/audit.mjs')
  const names = Object.keys(mod)
  assert.ok(!names.some((n) => /delete|remove|truncate|rewrite|edit/i.test(n)), `审计模块不应暴露删除/改写 API，实际：${names.join(', ')}`)
  const { sb, runtime } = await rt()
  try {
    await appendAudit(runtime, { capability: 'status', action: 'a' })
    const size1 = (await fs.stat(auditFileFor(runtime))).size
    await appendAudit(runtime, { capability: 'status', action: 'b' })
    const size2 = (await fs.stat(auditFileFor(runtime))).size
    assert.ok(size2 > size1, '追加后文件应增长（不是原地覆盖）')
  } finally { await sb.cleanup() }
})

test('audit: 审计写失败默认让操作失败（审计是安全属性，不静默降级）', async () => {
  const { sb, runtime } = await rt()
  try {
    // 把审计目录替换成一个文件，制造写入失败
    await fs.rm(runtime.paths.auditDir, { recursive: true, force: true })
    await fs.writeFile(runtime.paths.auditDir, 'not a dir')
    await assert.rejects(
      () => appendAudit(runtime, { capability: 'deploy', action: 'deploy' }),
      (err) => {
        assert.match(err.message, /审计日志写入失败/)
        assert.ok(err.remediation)
        return true
      },
    )
  } finally { await sb.cleanup() }
})

test('audit: continueOnAuditFailure=true 时降级为警告（显式选择才这样）', async () => {
  const { sb, runtime } = await rt()
  try {
    runtime.options.continueOnAuditFailure = true
    await fs.rm(runtime.paths.auditDir, { recursive: true, force: true })
    await fs.writeFile(runtime.paths.auditDir, 'not a dir')
    const rec = await appendAudit(runtime, { capability: 'deploy', action: 'deploy' })
    assert.equal(rec.unsaved, true, '降级模式下返回的记录应显式标注未被持久化')
    assert.equal(rec.hash, null)
    assert.ok(runtime.warnings.some((w) => w.code === 'W_AUDIT_WRITE_FAILED'), '应有显式警告（不静默）')
  } finally { await sb.cleanup() }
})

test('audit: computeHash 对内容敏感', () => {
  const base = { seq: 1, prevHash: GENESIS, v: 1, ts: 't', capability: 'x' }
  assert.notEqual(computeHash(base), computeHash({ ...base, capability: 'y' }))
  assert.equal(computeHash(base), computeHash({ ...base }))
})

test('audit: 按日期分文件', async () => {
  const { sb, runtime } = await rt()
  try {
    await appendAudit(runtime, { capability: 'status', action: 'a' })
    const files = await listAuditFiles(runtime)
    assert.equal(files.length, 1)
    assert.match(files[0], /^\d{4}-\d{2}-\d{2}\.jsonl$/)
    assert.equal((await readAudit(runtime)).length, 1)
  } finally { await sb.cleanup() }
})
