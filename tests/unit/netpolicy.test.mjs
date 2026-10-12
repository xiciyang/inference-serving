import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideEgress, normalizeHost, isLocalHost } from '../../src/netpolicy.mjs'
import { DEFAULT_NETWORK_POLICY } from '../../src/policy-defaults.mjs'

const P = DEFAULT_NETWORK_POLICY

test('netpolicy: huggingface.co 显式 deny（本机实测不可达）', () => {
  const d = decideEgress(P, 'https://huggingface.co/org/model')
  assert.equal(d.decision, 'deny')
  assert.match(d.reason, /DNS|不可达/)
})

test('netpolicy: 镜像域名 allow，含子域与 URL 两种写法', () => {
  assert.equal(decideEgress(P, 'hf-mirror.com').decision, 'allow')
  assert.equal(decideEgress(P, 'https://hf-mirror.com/org/model/resolve/main/x').decision, 'allow')
  assert.equal(decideEgress(P, 'https://cdn-lfs.hf-mirror.com/x').decision, 'allow')
  assert.equal(decideEgress(P, 'www.modelscope.cn').decision, 'allow')
  assert.equal(decideEgress(P, 'registry.npmmirror.com').decision, 'allow')
})

test('netpolicy: npm 官方 registry 显式 deny', () => {
  assert.equal(decideEgress(P, 'https://registry.npmjs.org/x').decision, 'deny')
})

test('netpolicy: 本地与私网一律 allow（沿用本机 no_proxy 约定）', () => {
  assert.equal(decideEgress(P, 'http://127.0.0.1:8001/v1/models').decision, 'allow')
  assert.equal(decideEgress(P, 'http://localhost:9/x').decision, 'allow')
  assert.equal(decideEgress(P, 'http://192.168.8.4/x').decision, 'allow')
  assert.equal(decideEgress(P, 'http://10.1.2.3/x').decision, 'allow')
  assert.equal(decideEgress(P, 'http://172.20.0.5/x').decision, 'allow')
  assert.ok(isLocalHost('::1', P.local))
})

test('netpolicy: 白名单外 → ask（默认档，headless 下等价拒绝）', () => {
  const d = decideEgress(P, 'https://example.com/x')
  assert.equal(d.decision, 'ask')
  assert.match(d.reason, /not in allowlist/)
})

test('netpolicy: 子域匹配不会误放行相似域名', () => {
  // "nothf-mirror.com" 不应匹配 "hf-mirror.com"
  assert.equal(decideEgress(P, 'https://nothf-mirror.com').decision, 'ask')
  assert.equal(decideEgress(P, 'https://evil-hf-mirror.com').decision, 'ask')
})

test('netpolicy: deny 优先于 allow（顺序无关）', () => {
  const policy = {
    ...P,
    allow: [{ host: 'blocked.example' }, ...P.allow],
    deny: [{ host: 'blocked.example', reason: 'test' }],
  }
  assert.equal(decideEgress(policy, 'blocked.example').decision, 'deny')
})

test('netpolicy: normalizeHost 处理 URL / 大小写 / 尾点 / IPv6 括号', () => {
  assert.equal(normalizeHost('https://Example.COM/path'), 'example.com')
  assert.equal(normalizeHost('example.com.'), 'example.com')
  assert.equal(normalizeHost('[::1]'), '::1')
  assert.equal(normalizeHost('  HOST  '), 'host')
})

test('netpolicy: 出口策略里没有境外代理依赖（proxy.mode=bypass）', () => {
  assert.equal(P.proxy.mode, 'bypass')
  assert.equal(P.proxy.envRespected, false)
})
