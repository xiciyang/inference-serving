/**
 * 环境探测（题目 §4.2 第一步）。
 *
 * **统一内存是本机的一等特征，不是异常**（PROJECT_CONTEXT.md §4.2）：
 * GB10 上 `nvidia-smi` 的 memory 字段恒为 `N/A`，所以任何"读 nvidia-smi 显存"的实现
 * 都会拿到空值。本模块按 nvidia-smi → /proc/meminfo（统一内存）→ 可选 torch 校准
 * 三级降级取值，并把"这是估算"这件事显式标注出来。
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { run, which } from '../util/proc.mjs'
import { getSandboxProbe } from '../sandbox.mjs'
import { isPortFree } from '../util/http.mjs'

const GiB = 1024 ** 3

async function readMemInfo() {
  try {
    const raw = await fs.readFile('/proc/meminfo', 'utf8')
    const get = (k) => {
      const m = new RegExp(`^${k}:\\s+(\\d+)\\s+kB`, 'm').exec(raw)
      return m ? Number(m[1]) * 1024 : null
    }
    return { totalBytes: get('MemTotal'), availableBytes: get('MemAvailable'), freeBytes: get('MemFree') }
  } catch {
    return { totalBytes: os.totalmem(), availableBytes: os.freemem(), freeBytes: os.freemem() }
  }
}

async function probeNvidiaSmi({ timeoutMs = 15_000 } = {}) {
  const bin = await which('nvidia-smi')
  if (!bin) return { present: false, reason: 'nvidia-smi 不在 PATH' }
  const q = await run(bin, [
    '--query-gpu=name,driver_version,compute_cap,memory.total,memory.used,memory.free,utilization.gpu',
    '--format=csv,noheader,nounits',
  ], { timeoutMs })
  if (q.code !== 0) return { present: true, ok: false, reason: q.stderr.trim() || q.spawnError?.message || 'nvidia-smi 执行失败' }

  const rows = q.stdout.trim().split('\n').filter(Boolean).map((line) => line.split(',').map((s) => s.trim()))
  const gpus = rows.map((r) => ({
    name: r[0],
    driverVersion: r[1],
    computeCapability: r[2],
    memoryTotalMiB: numericOrNull(r[3]),
    memoryUsedMiB: numericOrNull(r[4]),
    memoryFreeMiB: numericOrNull(r[5]),
    utilizationPercent: numericOrNull(r[6]),
  }))
  const memoryReported = gpus.length > 0 && gpus[0].memoryTotalMiB !== null
  return { present: true, ok: true, gpus, memoryReported }
}

function numericOrNull(s) {
  if (s === undefined || s === null) return null
  const t = String(s).trim()
  if (t === '' || /^n\/?a$/i.test(t) || t === '[Not Supported]' || t === 'Not Supported') return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

/** 可选：用 torch 校准统一内存视图（较慢，deep 模式才做）。 */
async function probeTorch({ timeoutMs = 90_000, python = 'python3' } = {}) {
  const script = `
import json,sys
try:
    import torch
    if not torch.cuda.is_available():
        print(json.dumps({"ok": False, "reason": "cuda unavailable"})); sys.exit(0)
    p = torch.cuda.get_device_properties(0)
    free, total = torch.cuda.mem_get_info()
    print(json.dumps({"ok": True, "name": p.name, "totalBytes": int(p.total_memory),
      "freeBytes": int(free), "integrated": bool(getattr(p, "is_integrated", False)),
      "multiProcessorCount": int(p.multi_processor_count),
      "computeCapability": f"{p.major}.{p.minor}", "torchVersion": torch.__version__}))
except Exception as e:
    print(json.dumps({"ok": False, "reason": str(e)}))
`
  const r = await run(python, ['-c', script], { timeoutMs })
  if (r.code !== 0) return { ok: false, reason: r.stderr.trim() || r.spawnError?.message || 'python3 执行失败' }
  try {
    return JSON.parse(r.stdout.trim().split('\n').pop())
  } catch {
    return { ok: false, reason: '输出解析失败' }
  }
}

export async function probeEnvironment(runtime, { deep = false, portSample = 5 } = {}) {
  const warnings = []
  const mem = await readMemInfo()
  const smi = await probeNvidiaSmi({ timeoutMs: Math.min(runtime.options.commandTimeoutMs, 20_000) })
  const torch = deep ? await probeTorch({ timeoutMs: 90_000 }) : null
  const sandbox = await getSandboxProbe()

  const gpus = []
  if (smi.ok && Array.isArray(smi.gpus)) {
    for (const g of smi.gpus) {
      const unified = !smi.memoryReported
      let availableBytes = null
      let availableSource = null
      if (g.memoryFreeMiB !== null) {
        availableBytes = g.memoryFreeMiB * 1024 * 1024
        availableSource = 'nvidia-smi'
      } else if (unified) {
        // 统一内存：GPU 可用内存 ≈ 宿主 MemAvailable − 驱动/桌面保留量
        const reserve = 8 * GiB
        availableBytes = Math.max(0, (mem.availableBytes ?? 0) - reserve)
        availableSource = 'meminfo-minus-reserve(estimate)'
      }
      gpus.push({
        ...g,
        unifiedMemory: unified,
        totalBytes: g.memoryTotalMiB !== null ? g.memoryTotalMiB * 1024 * 1024 : (unified ? mem.totalBytes : null),
        availableBytes,
        availableSource,
        torchCalibrated: torch?.ok ? { freeBytes: torch.freeBytes, totalBytes: torch.totalBytes, integrated: torch.integrated } : null,
      })
    }
  }

  if (gpus.some((g) => g.unifiedMemory)) {
    warnings.push({
      code: 'W_UNIFIED_MEMORY',
      message: '检测到统一内存 GPU：nvidia-smi 不报告显存，可用显存由宿主 MemAvailable 估算',
      details: { availableSource: gpus[0].availableSource, totalBytes: gpus[0].totalBytes, availableBytes: gpus[0].availableBytes },
    })
  }

  // 端口池采样：只测前 N 个，避免 100 次 bind 拖慢探测
  const host = runtime.options.bindHost
  const pool = []
  for (let p = runtime.options.portPoolStart; p <= Math.min(runtime.options.portPoolEnd, runtime.options.portPoolStart + portSample - 1); p += 1) {
    // eslint-disable-next-line no-await-in-loop
    pool.push({ port: p, free: await isPortFree(host, p) })
  }

  const dockerPath = await which('docker')

  const env = {
    probedAt: new Date().toISOString(),
    host: {
      hostname: os.hostname(),
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      cpuModel: os.cpus()?.[0]?.model ?? null,
      cpuCount: os.cpus()?.length ?? null,
      loadavg: os.loadavg(),
    },
    node: { version: process.version, execPath: process.execPath },
    memory: { ...mem, totalBytes: mem.totalBytes ?? os.totalmem() },
    gpu: {
      present: smi.present && smi.ok && gpus.length > 0,
      tool: smi.present ? 'nvidia-smi' : null,
      memoryReported: smi.memoryReported === true,
      gpus,
      torch: torch ?? { ok: false, reason: deep ? 'not probed' : 'deep=false' },
    },
    container: {
      dockerPath: dockerPath ?? null,
      available: sandbox.container.available,
      detail: sandbox.container.detail,
      nvidiaRuntime: sandbox.container.nvidiaRuntime === true,
      runtimes: sandbox.container.runtimes ?? [],
    },
    sandbox,
    ports: { host, poolSample: pool, pool: [runtime.options.portPoolStart, runtime.options.portPoolEnd] },
    filesystem: await probeFilesystem(runtime),
    warnings,
  }

  env.capability = deriveCapabilities(env)
  return env
}

async function probeFilesystem(runtime) {
  const out = { modelRoots: [] }
  for (const root of runtime.options.modelRoots) {
    try {
      const st = await fs.stat(root)
      out.modelRoots.push({ path: root, exists: true, readable: true, fileCount: (await fs.readdir(root)).length, isDirectory: st.isDirectory(), mtime: st.mtime.toISOString() })
    } catch (err) {
      out.modelRoots.push({ path: root, exists: false, error: err.code ?? String(err.message) })
    }
  }
  out.aiInfraRoot = { path: runtime.paths.root, writable: true }
  return out
}

/** 从探测结果推导"这台机器能做什么" —— 供后端选择与降级链使用。 */
export function deriveCapabilities(env) {
  const caps = {
    canDeployContainer: env.container.available === true,
    canUseGpu: env.gpu.present === true,
    gpuVendor: env.gpu.present ? 'nvidia' : 'none',
    unifiedMemory: env.gpu.gpus?.some((g) => g.unifiedMemory) ?? false,
    availableMemoryBytes: env.gpu.gpus?.[0]?.availableBytes ?? env.memory.availableBytes,
    memoryIsEstimate: env.gpu.gpus?.[0]?.availableSource?.includes('estimate') ?? false,
    sandboxTiers: {
      process: env.sandbox.process.available,
      container: env.sandbox.container.available,
      vm: env.sandbox.vm.available,
    },
  }
  caps.recommendedBackend = caps.canUseGpu && caps.canDeployContainer ? 'nvidia-vllm' : null
  return caps
}

export { GiB }
