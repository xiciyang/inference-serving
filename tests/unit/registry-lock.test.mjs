import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeSandbox } from '../helpers/sandbox.mjs'
import { createRuntime } from '../../src/config.mjs'
import {
  emptyRegistry, parseRegistry, serializeRegistry, loadRegistry, saveRegistry, withRegistry,
  findEndpoint, currentRevision, previousVerifiedRevision, addRevision, pushHistory, summarize, liveEndpoints,
} from '../../src/state/registry.mjs'
import { withLock } from '../../src/util/lock.mjs'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

async function rt() {
  const sb = await makeSandbox()
  const runtime = await createRuntime({ root: sb.root, options: sb.options })
  return { sb, runtime }
}

test('registry: 往返序列化（含中文、软链路径、嵌套 config）', () => {
  const reg = emptyRegistry()
  reg.endpoints.push({
    key: 'k1', id: 'ep_1', model: '/data/models/中文 模型', backend: 'nvidia-vllm',
    servedModelName: 'm', status: 'serving', currentRevision: 1,
    revisions: [{ rev: 1, endpoint: 'http://127.0.0.1:8100', port: 8100, bindHost: '127.0.0.1', containerName: 'c1', config: { gpuMemoryUtilization: 0.2, maxModelLen: 4096, nested: { a: [1, 2] } }, verifiedAt: '2026-09-23T00:00:00Z' }],
    history: [{ at: 't', event: 'deployed', detail: { attempts: 3 } }],
  })
  const back = parseRegistry(serializeRegistry(reg))
  assert.equal(back.version, 1)
  assert.equal(back.endpoints.length, 1)
  assert.equal(back.endpoints[0].model, '/data/models/中文 模型')
  assert.equal(back.endpoints[0].revisions[0].config.nested.a[1], 2)
  assert.equal(back.endpoints[0].history[0].detail.attempts, 3)
})

test('registry: 空文件/不存在都退化为空注册表', async () => {
  assert.deepEqual(parseRegistry(''), emptyRegistry())
  assert.deepEqual(parseRegistry(null), emptyRegistry())
  const { sb, runtime } = await rt()
  try {
    const reg = await loadRegistry(runtime)
    assert.deepEqual(reg.endpoints, [])
  } finally { await sb.cleanup() }
})

test('registry: 拒绝以旧格式覆盖新格式（防止写坏）', () => {
  assert.throws(() => parseRegistry('version: 99\nendpoints: []\n'), (err) => {
    assert.match(err.message, /高于本插件支持/)
    return true
  })
})

test('registry: withRegistry 事务 + 原子写（读者永远看到完整文件）', async () => {
  const { sb, runtime } = await rt()
  try {
    await withRegistry(runtime, (reg) => {
      reg.endpoints.push({ key: 'k', id: 'ep_x', model: 'm', status: 'serving', revisions: [] })
      return null
    })
    let reg = await loadRegistry(runtime)
    assert.equal(reg.endpoints.length, 1)
    assert.equal(await fs.readdir(runtime.paths.historyDir).then((d) => d.length), 0, '首次写入前没有旧内容，不应有快照')

    // 第二次事务前文件已存在 → 应留下快照
    await withRegistry(runtime, (reg2) => {
      reg2.endpoints[0].status = 'degraded'
      return null
    })
    const snaps = await fs.readdir(runtime.paths.historyDir)
    assert.equal(snaps.length, 1, '第二次写入前应留下可回滚的快照')
    reg = await loadRegistry(runtime)
    assert.equal(reg.endpoints[0].status, 'degraded')

    // 原子性：不存在残留的 .tmp 文件
    const leftovers = (await fs.readdir(runtime.paths.stateDir)).filter((f) => f.endsWith('.tmp'))
    assert.deepEqual(leftovers, [])
  } finally { await sb.cleanup() }
})

test('registry: findEndpoint 支持多种选择器', async () => {
  const reg = emptyRegistry()
  reg.endpoints.push({
    key: 'key-1', id: 'ep_1', model: '/data/models/m', servedModelName: 'm-served', backend: 'nvidia-vllm',
    status: 'serving', currentRevision: 1,
    revisions: [{ rev: 1, endpoint: 'http://127.0.0.1:8100/', port: 8100, containerName: 'inference-serving-1' }],
  })
  assert.equal(findEndpoint(reg, 'ep_1')?.id, 'ep_1')
  assert.equal(findEndpoint(reg, 'key-1')?.id, 'ep_1')
  assert.equal(findEndpoint(reg, '/data/models/m')?.id, 'ep_1')
  assert.equal(findEndpoint(reg, 'm-served')?.id, 'ep_1')
  assert.equal(findEndpoint(reg, 'http://127.0.0.1:8100')?.id, 'ep_1', '端点 URL（尾斜杠归一）')
  assert.equal(findEndpoint(reg, 'inference-serving-1')?.id, 'ep_1')
  assert.equal(findEndpoint(reg, '/data/models/m'), findEndpoint(reg, 'm'), '路径末段也能命中')
  assert.equal(findEndpoint(reg, 'nope'), null)
})

test('registry: revision 生命周期 —— addRevision 递增、currentRevision 跟随', () => {
  const ep = { revisions: [] }
  const r1 = addRevision(ep, { port: 8100, verifiedAt: 't1' })
  const r2 = addRevision(ep, { port: 8101, verifiedAt: 't2' })
  assert.equal(r1.rev, 1)
  assert.equal(r2.rev, 2)
  assert.equal(ep.currentRevision, 2)
  assert.equal(currentRevision(ep).port, 8101)
})

test('registry: previousVerifiedRevision 只认"已验证且更早"的版本', () => {
  const ep = {
    currentRevision: 3,
    revisions: [
      { rev: 1, verifiedAt: 't1' },
      { rev: 2, verifiedAt: null },      // 失败过，不应作为回退目标
      { rev: 3, verifiedAt: 't3' },
    ],
  }
  assert.equal(previousVerifiedRevision(ep).rev, 1)
  assert.equal(previousVerifiedRevision({ currentRevision: 1, revisions: [{ rev: 1, verifiedAt: 't' }] }), null)
})

test('registry: pushHistory 有上限，不会无限增长', () => {
  const ep = {}
  for (let i = 0; i < 150; i += 1) pushHistory(ep, `e${i}`)
  assert.equal(ep.history.length, 100)
  assert.equal(ep.history.at(-1).event, 'e149')
})

test('registry: summarize 不回传整个 revisions 历史', () => {
  const ep = {
    id: 'ep_1', key: 'k', model: 'm', backend: 'b', status: 'serving', currentRevision: 2,
    revisions: [
      { rev: 1, verifiedAt: 't1', containerName: 'c1', config: { a: 1 } },
      { rev: 2, verifiedAt: 't2', endpoint: 'http://h:1', port: 1, bindHost: '127.0.0.1', containerName: 'c2', servedModelName: 's', degradeStep: 1, config: { a: 2 } },
    ],
  }
  const s = summarize(ep)
  assert.equal(s.revision, 2)
  assert.equal(s.revisionsVerified, 2)
  assert.equal(s.endpoint, 'http://h:1')
  assert.equal(s.revisions, undefined)
  assert.deepEqual(s.config, { a: 2 })
})

test('registry: liveEndpoints 只算 serving/degraded', () => {
  const reg = emptyRegistry()
  reg.endpoints.push({ id: 'a', status: 'serving' }, { id: 'b', status: 'torn_down' }, { id: 'c', status: 'failed' })
  assert.deepEqual(liveEndpoints(reg).map((e) => e.id), ['a'])
})

test('lock: 互斥 —— 第二个持锁者必须等待，不能并发进入临界区', async () => {
  const { sb, runtime } = await rt()
  try {
    let concurrent = 0
    let maxConcurrent = 0
    const work = async () => withLock(runtime.paths.lockDir, 't', async () => {
      concurrent += 1
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await new Promise((r) => setTimeout(r, 40))
      concurrent -= 1
    })
    await Promise.all([work(), work(), work()])
    assert.equal(maxConcurrent, 1, '临界区不应被并发进入')
  } finally { await sb.cleanup() }
})

test('lock: 陈旧锁（持有者 pid 已死）会被回收，不会死锁', async () => {
  const { sb, runtime } = await rt()
  try {
    await fs.mkdir(runtime.paths.lockDir, { recursive: true })
    const lockPath = join(runtime.paths.lockDir, 'stale.lock')
    // 造一个不存在的 pid
    await fs.writeFile(lockPath, JSON.stringify({ pid: 999999999, at: Date.now() }))
    const started = Date.now()
    await withLock(runtime.paths.lockDir, 'stale', async () => { /* 应立即获得 */ }, { timeoutMs: 3000 })
    assert.ok(Date.now() - started < 2000, '陈旧锁应被快速回收')
  } finally { await sb.cleanup() }
})

test('lock: 获取超时会抛出（不死等）', async () => {
  const { sb, runtime } = await rt()
  try {
    await fs.mkdir(runtime.paths.lockDir, { recursive: true })
    // 一个"活着的"持有者：用自己的 pid，且 mtime 新鲜
    await fs.writeFile(join(runtime.paths.lockDir, 'held.lock'), JSON.stringify({ pid: process.pid, at: Date.now() }))
    await assert.rejects(
      () => withLock(runtime.paths.lockDir, 'held', async () => {}, { timeoutMs: 300, staleMs: 60000 }),
      (err) => { assert.equal(err.code, 'ELOCKTIMEOUT'); return true },
    )
  } finally { await sb.cleanup() }
})
