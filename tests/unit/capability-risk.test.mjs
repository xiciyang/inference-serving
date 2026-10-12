import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertCapability, getManifest, __resetManifestCache } from '../../src/capability.mjs'
import { ERROR_CODES } from '../../src/errors.mjs'
import { classifyOperation, confirmationKey, RISK } from '../../src/risk.mjs'
import { DEFAULT_RISK_CLASSIFICATION, maxRisk } from '../../src/policy-defaults.mjs'

test('capability: manifest 声明的能力可通过', () => {
  __resetManifestCache()
  const cap = assertCapability('deploy', ['model:read', 'gpu:write', 'port:bind', 'state:write'])
  assert.equal(cap.id, 'deploy')
  assert.equal(cap.risk, 'write')
})

test('capability: 未声明的能力被拒绝（默认拒绝，不是默认允许）', () => {
  __resetManifestCache()
  assert.throws(() => assertCapability('deploy_everything'), (err) => {
    assert.equal(err.code, ERROR_CODES.E_CAPABILITY_DENIED)
    assert.ok(err.remediation.includes('manifest.yaml'))
    return true
  })
})

test('capability: not_provided 的能力用不同措辞区分"不做"与"没声明"', () => {
  __resetManifestCache()
  assert.throws(() => assertCapability('sudo_exec'), (err) => {
    assert.equal(err.code, ERROR_CODES.E_CAPABILITY_DENIED)
    assert.match(err.message, /设计上不提供/)
    return true
  })
})

test('capability: 已声明能力访问未声明资源 → E_RESOURCE_NOT_DECLARED', () => {
  __resetManifestCache()
  assert.throws(() => assertCapability('status', ['state:read', 'gpu:write']), (err) => {
    assert.equal(err.code, ERROR_CODES.E_RESOURCE_NOT_DECLARED)
    assert.deepEqual(err.details.undeclared, ['gpu:write'])
    return true
  })
})

test('capability: 每个能力都声明了 resources 与合法 risk', () => {
  const m = getManifest()
  assert.ok(m.capabilities.size >= 6)
  for (const [id, cap] of m.capabilities) {
    assert.ok(cap.resources.length > 0, `${id} 应有 resources`)
    assert.ok(['read', 'write', 'system'].includes(cap.risk), `${id} 的 risk 不合法`)
  }
})

test('risk: capability 基础档映射正确', () => {
  assert.equal(classifyOperation({ cap: { risk: 'read' } }), RISK.R0_READ)
  assert.equal(classifyOperation({ cap: { risk: 'write' } }), RISK.R2_MEDIUM)
  assert.equal(classifyOperation({ cap: { risk: 'system' } }), RISK.R4_SYSTEM)
})

test('risk: 运行期加成只升不降（取更严者）', () => {
  assert.equal(classifyOperation({ cap: { risk: 'write' }, extraRisk: RISK.R0_READ }), RISK.R2_MEDIUM)
  assert.equal(classifyOperation({ cap: { risk: 'read' }, extraRisk: RISK.R3_HIGH }), RISK.R3_HIGH)
  assert.equal(classifyOperation({ cap: { risk: 'write' }, production: true }), RISK.R5_PRODUCTION)
  assert.equal(maxRisk(RISK.R2_MEDIUM, RISK.R4_SYSTEM), RISK.R4_SYSTEM)
})

test('risk: 确认策略 —— R0 不问，R1/R2 每类一次，R3-R5 每次都问', () => {
  const c = DEFAULT_RISK_CLASSIFICATION.confirmation
  assert.equal(c.R0, 'never')
  assert.equal(c.R1, 'per-class-once')
  assert.equal(c.R2, 'per-class-once')
  assert.equal(c.R3, 'always')
  assert.equal(c.R4, 'always')
  assert.equal(c.R5, 'always')
  assert.equal(c.ttlHours, 24)
  assert.equal(c.keyIncludesTarget, true)
})

test('risk: 沙箱映射 —— 高风险档要求 vm，而本机没有 vm', () => {
  const s = DEFAULT_RISK_CLASSIFICATION.sandbox
  assert.equal(s.R1, 'process')
  assert.equal(s.R2, 'container')
  assert.equal(s.R3, 'vm')
  assert.equal(s.R4, 'vm')
  assert.equal(DEFAULT_RISK_CLASSIFICATION.sandbox_fallback.onUnavailable, 'refuse')
})

test('risk: 确认键必须包含目标指纹（不同目标不复用授权）', () => {
  const a = confirmationKey({ capabilityId: 'deploy', riskClass: 'R2', targetFingerprint: 'model-A' })
  const b = confirmationKey({ capabilityId: 'deploy', riskClass: 'R2', targetFingerprint: 'model-B' })
  assert.notEqual(a, b)
  assert.match(a, /^cf_[0-9a-f]{24}$/)
  assert.equal(a, confirmationKey({ capabilityId: 'deploy', riskClass: 'R2', targetFingerprint: 'model-A' }))
})

test('license: 确认令牌与模型路径绑定，不能张冠李戴', async () => {
  const { licenseTokenFor } = await import('../../src/deploy.mjs')
  const a = licenseTokenFor('/data/models/model-A')
  const b = licenseTokenFor('/data/models/model-B')
  assert.notEqual(a, b)
  assert.match(a, /^lic_[0-9a-f]{16}$/)
  assert.equal(a, licenseTokenFor('/data/models/model-A'))
})

test('license: 宽松许可自动放行；受限/未知必须确认（headless 下中止）', async () => {
  const { enforceLicense, licenseTokenFor } = await import('../../src/deploy.mjs')
  const { createRuntime } = await import('../../src/config.mjs')
  const { makeSandbox } = await import('../helpers/sandbox.mjs')
  const sb = await makeSandbox()
  try {
    const runtime = await createRuntime({ root: sb.root, options: sb.options })
    const modelPath = '/data/models/x'

    // permissive → 直接放行
    const ok = await enforceLicense(runtime, { decision: 'allow', class: 'permissive', license: 'apache-2.0' }, { modelRef: modelPath })
    assert.equal(ok.decision, 'allow')

    // unknown → 抛错并给出与模型绑定的令牌
    const err = await enforceLicense(runtime, { decision: 'ask', class: 'unknown', license: null }, { modelRef: modelPath }).catch((e) => e)
    assert.equal(err.code, 'E_LICENSE_UNRESOLVED')
    assert.equal(err.details.confirmToken, licenseTokenFor(modelPath))

    // 用另一个模型的令牌 → 拒绝
    const wrong = await enforceLicense(runtime, { decision: 'ask', class: 'unknown', license: null }, { confirmToken: licenseTokenFor('/other'), modelRef: modelPath }).catch((e) => e)
    assert.equal(wrong.code, 'E_LICENSE_UNRESOLVED', '不匹配的令牌必须无效')

    // 正确令牌 → 放行
    const confirmed = await enforceLicense(runtime, { decision: 'ask', class: 'unknown', license: null }, { confirmToken: licenseTokenFor(modelPath), modelRef: modelPath })
    assert.equal(confirmed.confirmed, true)
  } finally { await sb.cleanup() }
})
