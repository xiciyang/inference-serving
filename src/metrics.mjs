/**
 * 指标（验收标准 5.4.5：部署耗时、资源消耗、降级次数）。
 *
 * 落盘在 `~/.ai-infra/state/metrics.json`；读-改-写走注册表同一把锁，避免并发覆盖。
 * 指标**不是**安全属性：写失败只记警告，不阻断业务。
 */
import { withLock } from './util/lock.mjs'
import { atomicWriteJson, readText } from './util/fsx.mjs'

const EMPTY = {
  version: 1,
  counters: {
    deploy_attempts: 0,
    deploy_success: 0,
    deploy_failed: 0,
    degrade_steps: 0,
    rollback: 0,
    teardown: 0,
    health_checks: 0,
    health_failures: 0,
    confirmations_granted: 0,
    sandbox_refusals: 0,
    egress_denied: 0,
    tool_calls: 0,
    tool_errors: 0,
  },
  timings: {
    deploy_ms_total: 0,
    deploy_ms_max: 0,
    health_ms_total: 0,
  },
  resources: {
    last_gpu_memory_utilization: null,
    last_max_model_len: null,
    last_container_image: null,
  },
  degrade: {
    by_step: {},
    by_reason: {},
  },
  updatedAt: null,
}

async function read(runtime) {
  const raw = await readText(runtime.paths.metricsFile, null)
  if (!raw) return structuredClone(EMPTY)
  try {
    const parsed = JSON.parse(raw)
    return {
      ...structuredClone(EMPTY),
      ...parsed,
      counters: { ...EMPTY.counters, ...(parsed.counters ?? {}) },
      timings: { ...EMPTY.timings, ...(parsed.timings ?? {}) },
      resources: { ...EMPTY.resources, ...(parsed.resources ?? {}) },
      degrade: { ...EMPTY.degrade, ...(parsed.degrade ?? {}) },
    }
  } catch {
    return structuredClone(EMPTY)
  }
}

export async function readMetrics(runtime) {
  return read(runtime)
}

/** 以一次事务更新指标。mutator(m) 直接改对象。 */
export async function updateMetrics(runtime, mutator) {
  try {
    return await withLock(runtime.paths.lockDir, 'metrics', async () => {
      const m = await read(runtime)
      mutator(m)
      m.updatedAt = new Date().toISOString()
      await atomicWriteJson(runtime.paths.metricsFile, m)
      return m
    })
  } catch (err) {
    runtime.warnings.push({ code: 'W_METRICS_WRITE_FAILED', message: String(err.message), details: null })
    return null
  }
}

export function bump(runtime, name, by = 1) {
  return updateMetrics(runtime, (m) => { m.counters[name] = (m.counters[name] ?? 0) + by })
}

export function recordDeployTiming(runtime, ms, { success }) {
  return updateMetrics(runtime, (m) => {
    m.counters.deploy_attempts += 1
    m.timings.deploy_ms_total += ms
    m.timings.deploy_ms_max = Math.max(m.timings.deploy_ms_max, ms)
    if (success) m.counters.deploy_success += 1
    else m.counters.deploy_failed += 1
  })
}

export function recordDegrade(runtime, { step, reason }) {
  return updateMetrics(runtime, (m) => {
    m.counters.degrade_steps += 1
    m.degrade.by_step[String(step)] = (m.degrade.by_step[String(step)] ?? 0) + 1
    const r = reason ?? 'unknown'
    m.degrade.by_reason[r] = (m.degrade.by_reason[r] ?? 0) + 1
  })
}

export function recordHealth(runtime, ms, { ok }) {
  return updateMetrics(runtime, (m) => {
    m.counters.health_checks += 1
    m.timings.health_ms_total += ms
    if (!ok) m.counters.health_failures += 1
  })
}

export function recordResource(runtime, { gpuMemoryUtilization, maxModelLen, image }) {
  return updateMetrics(runtime, (m) => {
    if (gpuMemoryUtilization !== undefined) m.resources.last_gpu_memory_utilization = gpuMemoryUtilization
    if (maxModelLen !== undefined) m.resources.last_max_model_len = maxModelLen
    if (image !== undefined) m.resources.last_container_image = image
  })
}

export function avgDeployMs(m) {
  const n = m.counters.deploy_attempts || 1
  return Math.round(m.timings.deploy_ms_total / n)
}

export { EMPTY as EMPTY_METRICS }
