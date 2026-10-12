/**
 * 运行时配置：路径布局、默认参数、策略加载。
 *
 * 共享状态**外置**在 `~/.ai-infra/`（题目原则 3.1.4），不放在包内 —— 包目录在
 * npm 安装后是只读的，且升级会覆盖。
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import * as fs from 'node:fs/promises'
import { parseFile, parse, stringify } from './util/yaml.mjs'
import { atomicWrite, mkdirp, expandHome, exists } from './util/fsx.mjs'
import { fail, warn, WARNING_CODES, ERROR_CODES } from './errors.mjs'
import {
  DEFAULT_RISK_CLASSIFICATION,
  DEFAULT_NETWORK_POLICY,
  DEFAULT_HEADLESS_POLICY,
} from './policy-defaults.mjs'

export const AI_INFRA_ROOT = '~/.ai-infra'

export function resolvePaths(root = AI_INFRA_ROOT) {
  const base = resolve(expandHome(root))
  return {
    root: base,
    stateDir: join(base, 'state'),
    registryFile: join(base, 'state', 'serving-registry.yaml'),
    confirmationsFile: join(base, 'state', 'confirmations.json'),
    metricsFile: join(base, 'state', 'metrics.json'),
    historyDir: join(base, 'state', 'history'),
    logsDir: join(base, 'logs'),
    auditDir: join(base, 'logs', 'audit', 'inference-serving'),
    appLogDir: join(base, 'logs', 'inference-serving'),
    configDir: join(base, 'config'),
    riskFile: join(base, 'config', 'risk-classification.yaml'),
    networkFile: join(base, 'config', 'network-policy.yaml'),
    headlessFile: join(base, 'config', 'headless-policy.yaml'),
    runDir: join(base, 'run', 'inference-serving'),
    tmpDir: join(base, 'run', 'inference-serving', 'tmp'),
    lockDir: join(base, 'run', 'inference-serving', 'locks'),
    reportsDir: join(base, 'reports', 'inference-serving'),
  }
}

/** 默认参数。每一项都可通过 `deploy` 的 `options` 覆盖 —— 不硬编码可调参数。 */
export function defaultOptions() {
  return {
    // 端口
    bindHost: '127.0.0.1',
    portPoolStart: 8100,
    portPoolEnd: 8199,

    // 时间预算（**墙钟**，不是调用次数 —— 见 RESULTS.md §2.2 的 A12 反例）
    deployTimeoutMs: 900_000,
    healthTimeoutMs: 420_000,
    healthPollIntervalMs: 3_000,
    cleanupTimeoutMs: 60_000,
    drainTimeoutMs: 15_000,
    commandTimeoutMs: 60_000,

    // 降级
    maxDegradeSteps: 4,

    // 模型
    modelRoots: ['/data/models'],
    containerModelMount: 'identical',

    // 后端
    defaultBackend: 'nvidia-vllm',
    containerRuntime: 'nvidia',
    dockerImageDefault: 'vllm/vllm-openai:nightly',

    // 健康检查
    healthForwardProbe: true,
    healthForwardMaxTokens: 4,
    // 关 4：模型可用性（输出分布不得退化）。默认开 —— 关掉它等于放弃
    // "起来了但不可用" 与 "没起来" 的区分，真机事故就是栽在缺这一关上。
    healthUsabilityProbe: true,
    healthUsabilityMaxTokens: 8,
    healthUsabilityPrompt: null, // null → probe/usability.mjs 的 DEFAULT_USABILITY_PROMPT

    // 其它
    headless: null, // null = 自动探测
    continueOnAuditFailure: false,
    reportDir: null,
  }
}

export function isHeadless(opts, env = process.env) {
  if (opts.headless === true) return true
  if (opts.headless === false) return false
  if (env.DSH_HEADLESS === '1' || env.INFERENCE_SERVING_HEADLESS === '1') return true
  if (env.CI === 'true' || env.CI === '1') return true
  // 无 TTY 且未显式要求交互 → 视为 headless（保守：宁可中止，不静默放行）
  if (process.stdin && process.stdin.isTTY === false && process.stdout && process.stdout.isTTY === false) return true
  return false
}

async function loadPolicyFile(path, defaults, warnings) {
  if (!(await exists(path))) {
    warnings.push(warn(WARNING_CODES.W_POLICY_DEFAULTED, `策略文件不存在，使用内置默认值：${path}`, { path }))
    return { value: defaults, source: 'builtin', path }
  }
  const raw = await fs.readFile(path, 'utf8')
  let parsed
  try {
    parsed = parse(raw)
  } catch (err) {
    fail(ERROR_CODES.E_INPUT_INVALID, `策略文件解析失败：${path}`, {
      remediation: `修正该 YAML 语法（本包支持受限 YAML 子集，见 src/util/yaml.mjs），或删除该文件以回落到内置默认值。`,
      details: { path, parseError: String(err.message) },
      cause: err,
    })
  }
  return { value: parsed, source: 'file', path }
}

/** 确保 `~/.ai-infra/` 目录树存在。幂等。 */
export async function ensureLayout(paths) {
  for (const d of [paths.root, paths.stateDir, paths.historyDir, paths.logsDir, paths.auditDir, paths.appLogDir, paths.configDir, paths.runDir, paths.tmpDir, paths.lockDir, paths.reportsDir]) {
    await mkdirp(d)
  }
  return paths
}

/** 首次运行：把内置策略落盘成配置文件，便于人工复核与修改。幂等（不覆盖既有）。 */
export async function materializePolicies(paths) {
  const written = []
  const pairs = [
    [paths.riskFile, DEFAULT_RISK_CLASSIFICATION],
    [paths.networkFile, DEFAULT_NETWORK_POLICY],
    [paths.headlessFile, DEFAULT_HEADLESS_POLICY],
  ]
  for (const [file, value] of pairs) {
    if (await exists(file)) continue
    await atomicWrite(file, stringify(value, { header: `${value.note ?? 'inference-serving policy'} — 由 inference-serving 内置默认值生成` }))
    written.push(file)
  }
  return written
}

export async function loadPolicy(paths, which, warnings) {
  if (which === 'risk') return loadPolicyFile(paths.riskFile, DEFAULT_RISK_CLASSIFICATION, warnings)
  if (which === 'network') return loadPolicyFile(paths.networkFile, DEFAULT_NETWORK_POLICY, warnings)
  if (which === 'headless') return loadPolicyFile(paths.headlessFile, DEFAULT_HEADLESS_POLICY, warnings)
  throw new Error(`unknown policy: ${which}`)
}

/** 组装一次调用的完整运行时上下文。 */
export async function createRuntime({ root, options = {}, env = process.env } = {}) {
  const paths = resolvePaths(root ?? env.INFERENCE_SERVING_ROOT ?? AI_INFRA_ROOT)
  const opts = { ...defaultOptions(), ...options }
  const warnings = []
  await ensureLayout(paths)
  const [risk, network, headlessPolicy] = await Promise.all([
    loadPolicy(paths, 'risk', warnings),
    loadPolicy(paths, 'network', warnings),
    loadPolicy(paths, 'headless', warnings),
  ])
  return {
    paths,
    options: opts,
    env,
    headless: isHeadless(opts, env),
    policy: {
      risk: risk.value,
      network: network.value,
      headless: headlessPolicy.value,
      sources: { risk: risk.source, network: network.source, headless: headlessPolicy.source },
    },
    warnings,
  }
}

export { homedir }
