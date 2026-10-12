/**
 * 测试脚手架：临时共享状态根 + 假模型目录 + 测试后端注册。
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { registerFakeBackend, resetKnobs, fakeBackend } from './fake-backend.mjs'
import './process-driver.mjs'

export { fakeBackend, resetKnobs }
export const FAKE_BACKEND_ID = 'fake-http'

/** 建一个隔离的临时环境，返回 { root, modelDir, modelPath, cleanup }。 */
export async function makeSandbox({ modelName = 'test-model', modelRootName = 'models' } = {}) {
  registerFakeBackend()
  resetKnobs()
  const base = await fs.mkdtemp(join(tmpdir(), 'is-test-'))
  const root = join(base, 'ai-infra')
  const modelRoot = join(base, modelRootName)
  const modelPath = join(modelRoot, modelName)
  await fs.mkdir(modelPath, { recursive: true })
  await fs.writeFile(join(modelPath, 'config.json'), JSON.stringify({
    architectures: ['LlamaForCausalLM'],
    model_type: 'llama',
    max_position_embeddings: 4096,
    num_hidden_layers: 2,
    hidden_size: 64,
    // vocab_size 必须给：关 4 的 `not-uniform` 判据靠它算 ln(V)。
    // 不给的话那条判据会记为 skipped —— 测试就少验一条，属于"夹具偷懒"。
    vocab_size: 32000,
    torch_dtype: 'bfloat16',
  }))
  await fs.writeFile(join(modelPath, 'model.safetensors'), Buffer.alloc(1024, 1))
  await fs.writeFile(join(modelPath, 'LICENSE'), 'Apache License 2.0\n')

  // 端口池按测试随机取一段：node --test 默认并行跑多个测试**文件**（各自独立进程），
  // 若共用同一段端口，两次 deploy 可能同时判定同一端口空闲而相撞。
  const poolStart = 18_000 + Math.floor(Math.random() * 600) * 20
  return {
    base,
    root,
    modelRoot,
    modelPath,
    modelName,
    options: { modelRoots: [modelRoot], bindHost: '127.0.0.1', portPoolStart: poolStart, portPoolEnd: poolStart + 19 },
    async cleanup() {
      await fs.rm(base, { recursive: true, force: true })
    },
    async readRegistryText() {
      try { return await fs.readFile(join(root, 'state', 'serving-registry.yaml'), 'utf8') } catch { return null }
    },
    async readRegistry() {
      const t = await this.readRegistryText()
      if (!t) return null
      const { parse } = await import('../../src/util/yaml.mjs')
      return parse(t)
    },
    async readAudit() {
      const { readAudit } = await import('../../src/audit.mjs')
      const { createRuntime } = await import('../../src/config.mjs')
      const runtime = await createRuntime({ root })
      return readAudit(runtime)
    },
  }
}

/** 生成一个可用的空闲端口（避免与真实服务冲突）。 */
export async function freePort() {
  const net = await import('node:net')
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port
      srv.close(() => resolve(p))
    })
  })
}

export function uniqueName(prefix = 'm') {
  return `${prefix}-${randomBytes(4).toString('hex')}`
}

export { fs, join, tmpdir }
