import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stringify, parse, YamlError } from '../../src/util/yaml.mjs'

test('yaml: 发射-解析 往返（含中文、嵌套、数组、特殊字符）', () => {
  const value = {
    version: 1,
    updatedAt: '2026-09-23T12:00:00.000Z',
    note: '中文说明：含冒号 的 值',
    nested: { a: 1, b: '2', c: true, d: false, e: null, f: 3.5 },
    endpoints: [
      { id: 'ep_1', model: '/data/models/带空格 的模型', port: 8100, tags: ['a', 'b'], config: { x: 1 } },
      { id: 'ep_2', model: 'x', port: 8101, tags: [], config: {} },
    ],
    emptyArray: [],
    emptyMap: {},
  }
  const round = parse(stringify(value))
  assert.deepEqual(round, value)
})

test('yaml: 字符串一律双引号，避免歧义', () => {
  const text = stringify({ a: 'true', b: '123', c: 'null', d: 'yes' })
  assert.match(text, /a: "true"/)
  assert.match(text, /b: "123"/)
  const back = parse(text)
  assert.equal(back.a, 'true')
  assert.equal(back.b, '123')
  assert.equal(back.c, 'null')
})

test('yaml: 解析流式序列与映射（manifest.yaml 里人工写的风格）', () => {
  const doc = parse([
    'name: inference-serving',
    'capabilities:',
    '  - id: deploy',
    '    risk: write',
    '    resources: [model:read, gpu:write, port:bind]',
    '    extra: {a: 1, b: "x"}',
  ].join('\n'))
  assert.equal(doc.name, 'inference-serving')
  assert.deepEqual(doc.capabilities[0].resources, ['model:read', 'gpu:write', 'port:bind'])
  assert.deepEqual(doc.capabilities[0].extra, { a: 1, b: 'x' })
})

test('yaml: 真实 manifest.yaml 可解析且结构正确', async () => {
  const { readManifestText } = await import('../../src/version.mjs')
  const doc = parse(readManifestText())
  assert.equal(doc.name, '@xiciyang/inference-serving')
  const ids = doc.capabilities.map((c) => c.id)
  assert.deepEqual(ids, ['deploy', 'status', 'rollback', 'teardown', 'list_endpoints', 'migrate'])
  assert.deepEqual(doc.capabilities[0].resources, ['model:read', 'gpu:write', 'port:bind', 'state:write', 'network:egress'])
  assert.ok(doc.not_provided.length >= 3)
})

test('yaml: 空文本 → null；注释与空行被忽略', () => {
  assert.equal(parse(''), null)
  assert.equal(parse('\n\n# only comments\n'), null)
  assert.deepEqual(parse('# c\na: 1\n\nb: 2\n'), { a: 1, b: 2 })
})

test('yaml: 非法输入响亮报错（不猜、不静默）', () => {
  assert.throws(() => parse('a: [1, 2'), YamlError, '未闭合的流式序列应报错')
  assert.throws(() => parse('a:\n  b: 1\n c: 2'), YamlError, '缩进不一致应报错')
  assert.throws(() => parse('a: b: c'), YamlError, '含 ": " 的普通标量应报错（提示加引号）')
  assert.throws(() => parse('a: "unterminated'), YamlError)
})

test('yaml: tab 缩进被拒绝（YAML 规范禁止）', () => {
  assert.throws(() => parse('a:\n\tb: 1'), YamlError)
})

test('yaml: 数组元素为对象时，首个键提到 "- " 同行且往返一致', () => {
  const text = stringify({ list: [{ k: 1, j: { x: 2 } }, { k: 2 }] })
  assert.match(text, /- k: 1/)
  assert.deepEqual(parse(text).list, [{ k: 1, j: { x: 2 } }, { k: 2 }])
})

test('yaml: 非有限数字降级为字符串而非产出非法 YAML', () => {
  const text = stringify({ a: Number.POSITIVE_INFINITY })
  assert.match(text, /a: "Infinity"/)
  assert.equal(parse(text).a, 'Infinity')
})
