/**
 * F-4 回归：派生模型的 license 沿溯源链继承。
 *
 * ## 真机事故
 *
 * `~/.ai-infra/logs/audit/inference-serving/2026-09-28.jsonl`：
 *
 *   seq 13  04:32:14.534  deploy start  target=deploy:e615af792f89aa94
 *   seq 14  04:32:14.568  deploy ERROR  code=E_LICENSE_UNRESOLVED   (38 ms)
 *            message: 模型 license 需要确认：(未能识别)（判定：unknown，来源：未找到 LICENSE 文件）
 *            details.confirmToken = lic_231e62b4935bd42a
 *   seq 15-17             带令牌重试 → 成功
 *
 * 即：**基座的 license 早已人工确认过**（`lic_109655b7c0c4cc00`），
 * 但量化产物目录里没有 LICENSE、也没有来源信息 → serving 又要求确认一次。
 * headless 下这一步会变成 `E_HEADLESS_NEEDS_CONFIRMATION`，链路卡死。
 *
 * ## 修法
 *
 * 量化在产物目录写 `ai-infra-provenance.json`（含 `sourceModel`）；
 * serving 解析 license 时读它，并检查**基座那条 license 确认是否仍在有效期内** ——
 * 在，就继承；不在，仍然要人确认（不放过真正的未知来源）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { makeSandbox } from '../helpers/sandbox.mjs'
import { createRuntime } from '../../src/config.mjs'
import { readLocalLicense } from '../../src/probe/model.mjs'
import { enforceLicense, licenseTokenFor } from '../../src/deploy.mjs'
import { grant } from '../../src/risk.mjs'
import { PROVENANCE_FILE, PROVENANCE_SCHEMA, provenanceChain } from '../../src/state/provenance.mjs'
import { ERROR_CODES } from '../../src/errors.mjs'

async function derivedDir(provenance) {
  const sb = await makeSandbox()
  const dir = join(sb.root, 'quantized-artifact')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(join(dir, 'config.json'), JSON.stringify({ architectures: ['LlamaForCausalLM'], vocab_size: 32000 }))
  if (provenance) await fs.writeFile(join(dir, PROVENANCE_FILE), JSON.stringify(provenance))
  return { sb, dir }
}

test('F-4: readLocalLicense 能识别溯源边车（并带出来源模型）', async () => {
  const { sb, dir } = await derivedDir({
    schema: PROVENANCE_SCHEMA, runId: 'qr_x', sourceModel: '/data/models/base', method: 'awq-w4a16',
  })
  try {
    const lic = await readLocalLicense(dir, { architectures: ['LlamaForCausalLM'] })
    assert.ok(lic.provenance, '必须读出溯源')
    assert.equal(lic.provenance.sourceModel, '/data/models/base')
    assert.equal(lic.provenance.runId, 'qr_x')
    assert.match(String(lic.source), /provenance/)
    assert.deepEqual(provenanceChain({ provenance: lic.provenance }), ['/data/models/base'])
  } finally { await sb.cleanup() }
})

test('F-4: 边车损坏/缺失 → 退回旧行为（不猜、不更糟）', async () => {
  const { sb, dir } = await derivedDir(null)
  try {
    const none = await readLocalLicense(dir, { architectures: ['LlamaForCausalLM'] })
    assert.equal(none.provenance, undefined)
    assert.equal(none.license, null)

    await fs.writeFile(join(dir, PROVENANCE_FILE), '{ 这不是 JSON')
    const broken = await readLocalLicense(dir, { architectures: ['LlamaForCausalLM'] })
    assert.equal(broken.provenance, undefined, '损坏的边车按不存在处理')
    assert.equal(broken.license, null)
  } finally { await sb.cleanup() }
})

test('F-4: 基座已确认 → 派生模型**不需再确认**（headless 也不卡死）', async () => {
  const sb = await makeSandbox()
  try {
    const runtime = await createRuntime({ root: sb.root, options: { headless: true } })
    const base = '/data/models/base-model'
    // 模拟"基座此前已由人工确认过"（与真机 lic_109655b7c0c4cc00 同形）
    await grant(runtime, {
      key: licenseTokenFor(base), capabilityId: 'license', riskClass: 'R2',
      targetFingerprint: base, grantedBy: 'explicit-license-confirm', persist: true,
    })

    const license = { license: null, class: 'unknown', source: 'provenance(来自 /data/models/base-model)', provenance: { sourceModel: base, runId: 'qr_x' } }
    const out = await enforceLicense(runtime, license, { modelRef: '/home/…/quantized/artifact', log: null })
    assert.equal(out.decision, 'allow', 'headless + 基座已确认 → 必须放行')
    assert.equal(out.inheritedFrom, base)
    assert.equal(out.reused, true)
  } finally { await sb.cleanup() }
})

test('F-4: 基座**没有**确认 → 仍然要人确认（继承不是万能通行证）', async () => {
  const sb = await makeSandbox()
  try {
    const runtime = await createRuntime({ root: sb.root, options: { headless: true } })
    const license = { license: null, class: 'unknown', source: 'provenance', provenance: { sourceModel: '/data/models/never-confirmed', runId: 'qr_y' } }
    const err = await enforceLicense(runtime, license, { modelRef: '/home/…/quantized/artifact2', log: null }).catch((e) => e)
    assert.ok(err instanceof Error, '未确认过的来源不得被继承放行')
    // 注意：serving 对"headless 下 license 需要确认"用的是 E_LICENSE_UNRESOLVED
    // （E_HEADLESS_NEEDS_CONFIRMATION 是风险确认闸门的码，两者不是一回事）
    assert.equal(err.code, ERROR_CODES.E_LICENSE_UNRESOLVED)
    assert.match(err.message, /headless/)
  } finally { await sb.cleanup() }
})

test('F-4: 没有溯源信息的未知 license 行为不变（不因新代码而放宽）', async () => {
  const sb = await makeSandbox()
  try {
    const runtime = await createRuntime({ root: sb.root, options: { headless: true } })
    const err = await enforceLicense(runtime, { license: null, class: 'unknown', source: null }, { modelRef: '/x', log: null }).catch((e) => e)
    assert.equal(err.code, ERROR_CODES.E_LICENSE_UNRESOLVED)
    assert.match(err.message, /headless/)
  } finally { await sb.cleanup() }
})
