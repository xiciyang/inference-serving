/**
 * 三层沙箱的调度与拒绝（题目原则 3.2.3 / 3.2.8）。
 *
 * 实测前提（PROJECT_CONTEXT.md §7）：
 *   process   → bwrap 0.9.0 + Landlock LSM    可用
 *   container → Docker 29.1.3 + nvidia runtime 可用
 *   vm        → 无 qemu/firecracker/cloud-hypervisor/libvirt/kata/gVisor → **不可用**
 *
 * 因此 R3–R5 在本机一律 `E_SANDBOX_UNAVAILABLE` —— 这是**设计上正确**的行为，
 * 不是缺陷（RISK_CLASSIFICATION_DRAFT.md §3.2 选项 A，已获用户确认）。
 *
 * 另注：`ctx.sandbox`（DSH 服务）只管文件效果策略，官方文档明确容器/microVM 不是它的
 * provider。所以容器级沙箱由本模块自己驱动 Docker。
 */
import { fail, warn, ERROR_CODES, WARNING_CODES } from './errors.mjs'
import { run, which } from './util/proc.mjs'

export const TIERS = ['none', 'process', 'container', 'vm']
const TIER_RANK = Object.fromEntries(TIERS.map((t, i) => [t, i]))

export function maxTier(a, b) {
  return TIER_RANK[a] >= TIER_RANK[b] ? a : b
}

export function requiredTier(runtime, riskClass) {
  return runtime.policy.risk.sandbox?.[riskClass] ?? 'container'
}

const VM_BINARIES = [
  'qemu-system-x86_64', 'qemu-system-aarch64', 'firecracker',
  'cloud-hypervisor', 'virsh', 'kata-runtime', 'runsc', 'systemd-nspawn',
]

/**
 * 探测沙箱可用性。全部是**行为验证**而非"二进制是否存在"——
 * bwrap 要真能跑一次空操作才算可用。
 */
export async function probeSandbox({ timeoutMs = 10_000 } = {}) {
  const result = { process: { available: false, detail: null }, container: { available: false, detail: null }, vm: { available: false, detail: null, missing: [] } }

  // --- process: bwrap 真跑一次 ---
  const bwrapPath = await which('bwrap')
  if (!bwrapPath) {
    result.process.detail = 'bwrap 未安装'
  } else {
    const probe = await run(bwrapPath, [
      '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc',
      '--tmpfs', '/tmp', '--unshare-pid', '--unshare-ipc', '--unshare-uts',
      '--die-with-parent', '--', '/bin/sh', '-c', 'echo bwrap-ok',
    ], { timeoutMs })
    result.process.available = probe.code === 0 && probe.stdout.includes('bwrap-ok')
    result.process.detail = result.process.available ? `bwrap ${bwrapPath}` : `bwrap 探测失败: ${probe.stderr.trim() || probe.spawnError?.message || 'unknown'}`
  }
  // Landlock 是 process 级的加固项，缺失只是降级不是不可用
  try {
    const { readFile } = await import('node:fs/promises')
    const lsm = await readFile('/sys/kernel/security/lsm', 'utf8')
    result.process.landlock = lsm.includes('landlock')
  } catch {
    result.process.landlock = false
  }

  // --- container: docker daemon 真应答 ---
  const dockerPath = await which('docker')
  if (!dockerPath) {
    result.container.detail = 'docker 未安装'
  } else {
    // 只取运行时**名字**。`{{.Runtimes}}` 会把整个 Go map（含 OCI features 全量 JSON）倒出来，
    // 单次输出可达成百上千行 —— 那是日志污染，不是可观测性。
    const probe = await run(dockerPath, ['info', '--format', '{{.ServerVersion}}|{{range $k,$v := .Runtimes}}{{$k}} {{end}}'], { timeoutMs })
    if (probe.code === 0) {
      const [serverVersion, runtimes] = probe.stdout.trim().split('|')
      result.container.available = Boolean(serverVersion)
      result.container.runtimes = (runtimes ?? '').split(/\s+/).filter(Boolean)
      result.container.detail = `docker ${serverVersion}, runtimes=[${result.container.runtimes.join(', ')}]`
      result.container.nvidiaRuntime = (result.container.runtimes ?? []).includes('nvidia')
    } else {
      result.container.detail = `docker info 失败: ${probe.stderr.trim() || probe.spawnError?.message || 'daemon 未运行'}`
    }
  }

  // --- vm: 缺什么就列什么 ---
  for (const b of VM_BINARIES) {
    // eslint-disable-next-line no-await-in-loop
    const p = await which(b)
    if (p) result.vm.found = [...(result.vm.found ?? []), `${b}@${p}`]
    else result.vm.missing.push(b)
  }
  const { promises: fsPromises } = await import('node:fs')
  try {
    await fsPromises.access('/dev/kvm')
    result.vm.kvmDevice = true
  } catch {
    result.vm.kvmDevice = false
  }
  result.vm.available = (result.vm.found ?? []).length > 0
  result.vm.detail = result.vm.available
    ? `可用 hypervisor: ${result.vm.found.join(', ')}`
    : `无 VM 级沙箱可用（缺失：${result.vm.missing.join(', ')}；/dev/kvm=${result.vm.kvmDevice ? '存在但无消费者' : '不存在'}）`

  return result
}

let cachedProbe = null

export async function getSandboxProbe({ refresh = false, timeoutMs } = {}) {
  if (refresh || cachedProbe === null) cachedProbe = await probeSandbox({ timeoutMs })
  return cachedProbe
}

export function __resetSandboxCache() {
  cachedProbe = null
}

/**
 * 断言所需沙箱层级可用。不可用时的行为由策略 `sandbox_fallback.onUnavailable` 决定：
 *   'refuse'（默认，已确认）= 抛 E_SANDBOX_UNAVAILABLE
 *   'degrade' = 降一级，但**必须**显式授权（allowDegradeWithExplicitGrant）
 */
export async function assertSandbox(runtime, tier, { grant = null, probe = null } = {}) {
  if (tier === 'none') return { tier: 'none', enforced: 'n/a' }
  const p = probe ?? (await getSandboxProbe())
  const fallback = runtime.policy.risk.sandbox_fallback ?? {}
  const mode = fallback.onUnavailable ?? 'refuse'

  const ok = Boolean(p[tier]?.available)
  if (ok) return { tier, enforced: 'full', detail: p[tier].detail }

  if (mode === 'degrade' && fallback.allowDegradeWithExplicitGrant && grant === 'degrade-sandbox') {
    const lower = tier === 'vm' ? 'container' : tier === 'container' ? 'process' : 'none'
    if (lower !== 'none' && p[lower]?.available) {
      runtime.warnings.push(warn(WARNING_CODES.W_VM_SANDBOX_ABSENT,
        `所需沙箱层 ${tier} 不可用，已按显式授权降级到 ${lower}（该降级由调用方显式授予）`,
        { requested: tier, granted: lower }))
      return { tier: lower, enforced: 'degraded', detail: p[lower].detail, degradedFrom: tier }
    }
  }

  fail(ERROR_CODES.E_SANDBOX_UNAVAILABLE,
    `所需沙箱层级不可用：${tier} —— ${p[tier]?.detail ?? '未知'}`, {
      remediation: tier === 'vm'
        ? '本机无 VM 级沙箱（无 qemu/firecracker/cloud-hypervisor/libvirt/kata/gVisor）。高风险操作按策略一律拒绝。可选：(A) 接受拒绝并只用 R0–R2；(B) 先安装 hypervisor（系统级变更，需先报告再执行）；(C) 显式授权降级到容器级（不受推荐）。'
        : `请先修复该沙箱后端，或把该操作的运行环境迁到支持它的主机。当前探测：${JSON.stringify(p[tier] ?? {})}`,
      details: { requested: tier, probe: p[tier] ?? null, policy: mode },
    })
}

/**
 * 进程级沙箱包装：把一条宿主命令放进 bwrap。
 * 注意：**保留网络命名空间**（不 --unshare-net）—— 健康检查必须能访问 127.0.0.1 端点。
 */
export function wrapProcessCommand(argv, { writableDirs = [], roRoots = ['/'], timeoutHint } = {}) {
  const binds = []
  for (const r of roRoots) binds.push('--ro-bind', r, r)
  for (const w of writableDirs) binds.push('--bind', w, w)
  return {
    cmd: 'bwrap',
    args: [
      ...binds,
      '--dev', '/dev',
      '--proc', '/proc',
      '--tmpfs', '/tmp',
      '--unshare-pid', '--unshare-ipc', '--unshare-uts',
      '--die-with-parent',
      '--',
      ...argv,
    ],
    timeoutHint,
  }
}

/** 容器级沙箱：本插件的容器执行就是"沙箱本身"，这里只做运行时约束校验。 */
export function containerSandboxSpec(runtime, { network = 'host-local', readOnlyRoot = false } = {}) {
  const p = runtime.policy.risk.sandbox_fallback ?? {}
  return {
    runtime: runtime.options.containerRuntime,
    network,
    readOnlyRoot,
    policy: p,
  }
}

export { TIER_RANK }
