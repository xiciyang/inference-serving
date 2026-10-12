/**
 * 内置策略默认值。
 *
 * 来源：Step 0 经用户确认的 `RISK_CLASSIFICATION_DRAFT.md` 与 `NETWORK_POLICY_DRAFT.md`。
 * 它们既是"配置文件缺失时的兜底"，也是生成 `~/.ai-infra/config/*.yaml` 的**唯一真源** ——
 * 避免"代码里一套、文档里一套、配置文件里第三套"。
 *
 * 使用兜底时必须产生 W_POLICY_DEFAULTED 警告并写审计（不静默）。
 */
import { WARNING_CODES } from './errors.mjs'

/** 风险档位（与 RISK_CLASSIFICATION_DRAFT.md §1 一致）。 */
export const RISK = Object.freeze({
  R0_READ: 'R0',
  R1_LOW: 'R1',
  R2_MEDIUM: 'R2',
  R3_HIGH: 'R3',
  R4_SYSTEM: 'R4',
  R5_PRODUCTION: 'R5',
  R6_FORBIDDEN: 'R6',
})

export const RISK_ORDER = [RISK.R0_READ, RISK.R1_LOW, RISK.R2_MEDIUM, RISK.R3_HIGH, RISK.R4_SYSTEM, RISK.R5_PRODUCTION, RISK.R6_FORBIDDEN]

export function maxRisk(a, b) {
  return RISK_ORDER.indexOf(a) >= RISK_ORDER.indexOf(b) ? a : b
}

export const DEFAULT_RISK_CLASSIFICATION = {
  version: 1,
  generated: 'builtin',
  note: '由 inference-serving 内置默认值生成；修改后请勿删除 version 字段',
  sandbox: {
    // 每个风险档要求的最低沙箱层级
    R0: 'none',
    R1: 'process',
    R2: 'container',
    R3: 'vm',
    R4: 'vm',
    R5: 'vm',
    R6: 'none',
  },
  confirmation: {
    // 确认策略：per-class-once（每类一次，TTL 内复用）/ always（每次）/ never
    R0: 'never',
    R1: 'per-class-once',
    R2: 'per-class-once',
    R3: 'always',
    R4: 'always',
    R5: 'always',
    R6: 'never',
    ttlHours: 24,
    // 确认键必须包含目标指纹 —— 同一 capability 对不同模型/环境不复用确认
    keyIncludesTarget: true,
  },
  sandbox_fallback: {
    // VM 级沙箱不存在时的行为：refuse（拒绝）/ degrade（降级到容器级）
    onUnavailable: 'refuse',
    allowDegradeWithExplicitGrant: true,
  },
  assets: {
    // 八类系统资产：写白名单。空数组 = 该资产不可写。
    filesystem: { writable: ['~/.ai-infra', '{modelRoot}'], foreignWrite: 'deny' },
    process: { ownOnly: true, protected: [], protectedContainers: ['qwen3-embedding', 'xagentlab-'], note: '只允许操作本插件登记的进程/容器；既有服务一律保护' },
    network: { policy: 'network-policy.yaml' },
    device: { writable: [], via: 'docker --gpus' },
    kernel: { writable: [] },
    account: { writable: [] },
    service: { writable: [] },
    audit: { appendOnly: true, dir: '~/.ai-infra/logs/audit', forbidDelete: true },
  },
}

export const DEFAULT_NETWORK_POLICY = {
  version: 1,
  generated: 'builtin',
  default: 'ask',
  proxy: {
    mode: 'bypass',
    envRespected: false,
    probeOnStart: true,
    probeTimeoutMs: 2000,
    probeTarget: 'https://registry.npmmirror.com',
  },
  allow: [
    { host: 'hf-mirror.com', purpose: 'HF 模型镜像', cache: true },
    { host: 'cdn-lfs.hf-mirror.com', purpose: 'HF 大文件 CDN', cache: true },
    { host: 'www.modelscope.cn', purpose: 'ModelScope 模型源', cache: true },
    { host: 'modelscope.cn', purpose: 'ModelScope 模型源', cache: true },
    { host: 'registry.npmmirror.com', purpose: 'npm registry', cache: false },
    { host: 'pypi.org', purpose: 'pip 官方源', cache: false },
    { host: 'files.pythonhosted.org', purpose: 'pip 包体', cache: false },
    { host: 'mirrors.aliyun.com', purpose: 'pip/apt 镜像', cache: false },
    { host: 'mirrors.tuna.tsinghua.edu.cn', purpose: 'apt 镜像', cache: false },
    { host: 'archive.ubuntu.com', purpose: 'apt 源', cache: false },
    { host: 'github.com', purpose: '代码与 Release', cache: false },
    { host: 'codeload.github.com', purpose: '代码归档', cache: false },
    { host: 'raw.githubusercontent.com', purpose: '原始文件', cache: false },
    { host: 'objects.githubusercontent.com', purpose: 'Release 资源', cache: false },
  ],
  deny: [
    { host: 'huggingface.co', reason: 'DNS 投毒，直连与代理均不可达（实测）；请改用 hf-mirror.com' },
    { host: 'registry.npmjs.org', reason: '直连与代理均不可达（实测）；请改用 registry.npmmirror.com' },
    { host: 'openai.com', reason: '本任务不需要，收敛出口面' },
    { host: 'anthropic.com', reason: '本任务不需要，收敛出口面' },
  ],
  local: ['127.0.0.0/8', '::1', '192.168.0.0/16', '10.0.0.0/8', '172.16.0.0/12', '.local', '.internal'],
  license: {
    permissive: ['apache-2.0', 'mit', 'bsd-2-clause', 'bsd-3-clause', 'isc', 'cc0-1.0', 'unlicense'],
    restricted: ['llama', 'cc-by-nc', 'cc-by-nc-sa', 'research-only', 'non-commercial'],
    onMissing: 'ask',
    onRestricted: 'ask',
    onPermissive: 'allow',
  },
  ports: {
    host: '127.0.0.1',
    poolStart: 8100,
    poolEnd: 8199,
    allowPublicBind: false,
    denyPrivileged: true,
  },
}

export const DEFAULT_HEADLESS_POLICY = {
  version: 1,
  generated: 'builtin',
  mode: 'abort',
  overrides: {
    fillDefaults: 'allow',
    ambiguityResolved: 'allow-with-report',
    perClassConfirmation: 'require-grant',
    alwaysConfirmation: 'abort',
    probeMismatch: 'abort',
    degradeExhausted: 'abort',
    egressAsk: 'abort',
    licenseAsk: 'abort',
  },
}

export const DEFAULT_WARNINGS = [
  { code: WARNING_CODES.W_POLICY_DEFAULTED, message: '策略文件缺失，已使用内置默认值' },
  { code: WARNING_CODES.W_VM_SANDBOX_ABSENT, message: '本机无 VM 级沙箱，R3–R5 操作一律拒绝' },
]
