/**
 * 测试用后端：跑测试替身服务，不碰 GPU / Docker。
 *
 * 通过 `knobs` 精确控制每一步的成败，从而**确定性地**驱动降级链：
 *   knobs.preflightFailAtMemoryUtilization  —— 高于该值预检即失败（E_INSUFFICIENT_MEMORY）
 *   knobs.failLaunchAttempts                —— 前 N 次启动失败（E_DEPLOY_FAILED）
 *   knobs.healthMode                        —— 'ok' | 'slow' | 'broken'
 *   knobs.logText                           —— 伪造的容器日志（用于 classifyFailure）
 */
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { register } from '../../src/backends/registry.mjs'
import { getDriver } from '../../src/drivers/index.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(here, 'fixture-server.mjs')

export const knobs = {
  preflightFailAboveMemoryUtilization: 1.0,
  preflightCode: 'E_INSUFFICIENT_MEMORY',
  failLaunchAttempts: 0,
  launchFailureCode: 'E_DEPLOY_FAILED',
  healthMode: 'ok',
  /** 关 4 用的模式：'ok'（健康模型）| 'uniform'（残缺模型的均匀输出形态） */
  usabilityMode: 'ok',
  logText: '',
  preflightCalls: 0,
  launchCalls: 0,
}

export function resetKnobs() {
  knobs.preflightFailAboveMemoryUtilization = 1.0
  knobs.preflightCode = 'E_INSUFFICIENT_MEMORY'
  knobs.failLaunchAttempts = 0
  knobs.launchFailureCode = 'E_DEPLOY_FAILED'
  knobs.healthMode = 'ok'
  knobs.usabilityMode = 'ok'
  knobs.logText = ''
  knobs.preflightCalls = 0
  knobs.launchCalls = 0
}

export const fakeBackend = {
  id: 'fake-http',
  displayName: 'Fake HTTP backend (tests)',
  driver: 'process',
  requires: { gpu: false, container: false },

  isAvailable() { return true },

  describe() { return { id: 'fake-http', note: 'test double' } },

  defaultConfig() {
    return {
      gpuMemoryUtilization: 0.5,
      maxModelLen: 4096,
      maxNumSeqs: 8,
      tensorParallelSize: 1,
      dtype: 'auto',
      quantization: null,
      swapSpaceGb: 0,
      image: 'fake:1',
    }
  },

  async preflight({ standard }) {
    knobs.preflightCalls += 1
    if (standard.config.gpuMemoryUtilization > knobs.preflightFailAboveMemoryUtilization) {
      return {
        ok: false,
        code: knobs.preflightCode,
        message: `fake preflight: gpuMemoryUtilization=${standard.config.gpuMemoryUtilization} 超过测试阈值 ${knobs.preflightFailAboveMemoryUtilization}`,
        remediation: '测试替身的人为失败；降级链应换档重试。',
        details: { testDouble: true, gpuMemoryUtilization: standard.config.gpuMemoryUtilization },
      }
    }
    return { ok: true, details: { testDouble: true } }
  },

  buildLaunchSpec({ runtime, standard, containerName }) {
    knobs.launchCalls += 1
    const runDir = runtime.paths.runDir
    const pidFile = join(runDir, `${containerName}.pid`)
    const logFile = join(runDir, `${containerName}.log`)
    return {
      cmd: process.execPath,
      args: [FIXTURE, '--port', String(standard.port), '--name', standard.servedModelName, '--mode', knobs.healthMode === 'ok' ? knobs.usabilityMode : knobs.healthMode, '--vocab', '32000'],
      containerName,
      driver: 'process',
      pidFile,
      logFile,
      image: standard.image,
      commandLine: `node fixture-server.mjs --port ${standard.port} --name ${standard.servedModelName}`,
    }
  },

  healthProbe({ standard }) {
    return {
      endpointPath: '/v1/models',
      forwardPath: '/v1/completions',
      forwardBody: { model: standard.servedModelName, prompt: 'hi', max_tokens: 2, temperature: 0 },
      expectsModel: standard.servedModelName,
    }
  },

  classifyFailure({ stderr = '', stdout = '', preflightCode = null }) {
    if (preflightCode) return preflightCode
    return knobs.launchFailureCode ?? 'E_DEPLOY_FAILED'
  },
}

/**
 * 让"前 N 次启动失败"生效：包一层 driver.launch。
 * 直接改驱动是刻意的 —— 被测代码路径保持原样，失败注入发生在最外层。
 */
export function installLaunchFailureInjection() {
  const driver = getDriver('process')
  if (driver.__patched) return
  const original = driver.launch.bind(driver)
  driver.launch = async (spec, opts) => {
    if (knobs.failLaunchAttempts > 0) {
      knobs.failLaunchAttempts -= 1
      return { ok: false, id: null, code: 1, stdout: '', stderr: `${knobs.logText}\nstartup failed (injected)`, spawnError: null, timedOut: false, ms: 5 }
    }
    return original(spec, opts)
  }
  driver.__patched = true
}

export function registerFakeBackend() {
  try {
    register(fakeBackend)
  } catch (err) {
    if (!/已注册/.test(String(err.message))) throw err
  }
  installLaunchFailureInjection()
  return fakeBackend
}

export { FIXTURE, spawnSync }
