import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sha256, canonicalJson, idempotencyKey, shortId } from '../../src/util/hash.mjs'
import { ERROR_CODES, ServingError, fail, isServingError, toErrorPayload, warn } from '../../src/errors.mjs'
import { PACKAGE_ROOT, PACKAGE_VERSION } from '../../src/version.mjs'
import { parseArgv } from '../../src/cli.mjs'

test('hash: canonicalJson 键序不敏感（幂等键必须稳定）', () => {
  const a = canonicalJson({ b: 1, a: [2, { d: 4, c: 3 }] })
  const b = canonicalJson({ a: [2, { c: 3, d: 4 }], b: 1 })
  assert.equal(a, b)
  assert.equal(idempotencyKey({ x: 1, y: 2 }), idempotencyKey({ y: 2, x: 1 }))
  assert.notEqual(idempotencyKey({ x: 1 }), idempotencyKey({ x: 2 }))
})

test('hash: canonicalJson 丢弃 undefined，保留 null', () => {
  assert.equal(canonicalJson({ a: undefined, b: null }), '{"b":null}')
})

test('hash: sha256/shortId 确定性', () => {
  assert.equal(sha256('x'), sha256('x'))
  assert.equal(sha256('x').length, 64)
  assert.equal(shortId('seed', 10).length, 10)
  assert.equal(shortId('seed', 10), shortId('seed', 10))
})

test('errors: 每个错误码都有稳定字符串值，且无重复', () => {
  const values = Object.values(ERROR_CODES)
  assert.equal(new Set(values).size, values.length)
  for (const v of values) assert.match(v, /^E_[A-Z_]+$/)
})

test('errors: ServingError 序列化保留 remediation（可操作性）', () => {
  const e = new ServingError(ERROR_CODES.E_PORT_UNAVAILABLE, '端口被占', {
    remediation: '换端口或释放占用', details: { port: 8100 },
  })
  const j = e.toJSON()
  assert.equal(j.ok, false)
  assert.equal(j.code, 'E_PORT_UNAVAILABLE')
  assert.equal(j.remediation, '换端口或释放占用')
  assert.deepEqual(j.details, { port: 8100 })
})

test('errors: toErrorPayload 把未知异常规范化为 E_INTERNAL（故障隔离）', () => {
  const p = toErrorPayload(new TypeError('boom'), { capability: 'deploy' })
  assert.equal(p.ok, false)
  assert.equal(p.code, 'E_INTERNAL')
  assert.equal(p.capability, 'deploy')
  assert.ok(p.remediation)
})

test('errors: fail() 抛出的是 ServingError 且带 code', () => {
  assert.throws(() => fail(ERROR_CODES.E_INPUT_INVALID, 'x', { remediation: 'y' }), (err) => {
    assert.ok(isServingError(err))
    assert.equal(err.code, 'E_INPUT_INVALID')
    return true
  })
})

test('errors: warn() 产出可序列化警告', () => {
  const w = warn('W_TEST', 'msg', { a: 1 })
  assert.deepEqual(w.toJSON(), { code: 'W_TEST', message: 'msg', details: { a: 1 } })
})

test('version: package.json / src/version.mjs / manifest.yaml 三处版本一致', async () => {
  const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'))
  assert.equal(pkg.version, PACKAGE_VERSION)
  assert.equal(pkg.name, '@xiciyang/inference-serving')
  const { parse } = await import('../../src/util/yaml.mjs')
  const manifest = parse(readFileSync(join(PACKAGE_ROOT, 'manifest.yaml'), 'utf8'))
  assert.equal(manifest.version, PACKAGE_VERSION)
  assert.equal(manifest.interface.mcp, '1.0.0')
})

test('version: 声明 engines/os/cpu，且零运行时依赖', () => {
  const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'))
  assert.ok(pkg.engines?.node)
  assert.ok(pkg.os?.length)
  assert.ok(pkg.cpu?.length)
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), [])
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
})

test('cli: parseArgv 处理 --k v / --k=v / --flag / 位置参数', () => {
  const r = parseArgv(['deploy', '/m', '--port', '8100', '--json', '--root=/tmp/x', '--deep'])
  assert.deepEqual(r.positional, ['deploy', '/m'])
  assert.equal(r.options.port, '8100')
  assert.equal(r.options.root, '/tmp/x')
  assert.ok(r.flags.has('json'))
  assert.ok(r.flags.has('deep'))
})

test('cli: parseArgv 后面跟 -- 时原样收尾', () => {
  const r = parseArgv(['deploy', '--', '--weird', 'x'])
  assert.deepEqual(r.positional, ['deploy', '--weird', 'x'])
})

test('cli: parseArgv 不把负数误判为 flag', () => {
  const r = parseArgv(['x', '-1'])
  assert.deepEqual(r.positional, ['x', '-1'])
})
