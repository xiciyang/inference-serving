/**
 * CLI（`inference-serving <command>`）。
 *
 * 零依赖参数解析。与 MCP 工具走**同一层 api.mjs**，因此行为一致。
 *
 * 退出码约定（便于脚本与 CI 判断）：
 *   0 成功
 *   1 业务失败（错误已结构化打印）
 *   2 用法错误
 *   3 需要确认（错误码 E_CONFIRMATION_REQUIRED / E_HEADLESS_NEEDS_CONFIRMATION）
 */
import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import * as api from './api.mjs'
import { ALL_TOOL_SPECS, TOOL_SPECS } from './tools.mjs'
import { ERROR_CODES } from './errors.mjs'

const COMMANDS = {
  deploy: 'deploy <model|path|url|env:VAR> [options]  —— 部署模型为可访问端点（幂等）',
  status: 'status [selector] [--deep] [--json]        —— 端点状态 + 实机核对',
  list: 'list [--status S] [--json]                  —— 列出端点',
  rollback: 'rollback <selector> [--confirm TOKEN]      —— 回退到上一个已验证版本',
  teardown: 'teardown <selector> [--confirm TOKEN]      —— 拆解并验证无残留',
  migrate: 'migrate <model> [--target BACKEND]         —— 产出迁移适配计划',
  metrics: 'metrics [--json]                           —— 指标（耗时/资源/降级次数）',
  'audit-verify': 'audit-verify [--json]                —— 校验审计哈希链完整性',
  reconcile: 'reconcile [--reap] [--confirm TOKEN]       —— 孤儿容器对账（危险操作需确认）',
  doctor: 'doctor [--deep] [--json]                   —— 环境与能力自检',
  'install-skills': 'install-skills [--dir PATH]          —— 把随包 SKILL.md 复制到 skills 目录',
  tools: 'tools [--json]                             —— 列出对外工具与参数 schema',
  version: 'version                                    —— 版本',
  help: 'help                                       —— 本帮助',
}

const FLAGS = new Set(['json', 'deep', 'reap', 'headless', 'help', 'yes', 'verbose', 'verify', 'dry-run'])

export function parseArgv(argv) {
  const positional = []
  const options = {}
  const flags = new Set()
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--') { positional.push(...argv.slice(i + 1)); break }
    if (a.startsWith('--')) {
      const body = a.slice(2)
      const eq = body.indexOf('=')
      if (eq >= 0) {
        options[body.slice(0, eq)] = body.slice(eq + 1)
      } else if (FLAGS.has(body)) {
        flags.add(body)
      } else {
        const next = argv[i + 1]
        if (next === undefined || next.startsWith('--')) { flags.add(body) } else { options[body] = next; i += 1 }
      }
    } else if (a.startsWith('-') && a.length > 1 && !/^-\d/.test(a)) {
      const body = a.slice(1)
      if (body === 'h') flags.add('help')
      else flags.add(body)
    } else {
      positional.push(a)
    }
  }
  return { positional, options, flags }
}

function asNumber(v) {
  if (v === undefined || v === null || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

function asBool(v) {
  if (v === undefined) return undefined
  if (typeof v === 'boolean') return v
  return !['false', '0', 'no', 'off'].includes(String(v).toLowerCase())
}

function buildCommonOptions(options, flags) {
  return {
    headless: flags.has('headless') ? true : asBool(options.headless),
    bindHost: options['bind-host'],
    portPoolStart: asNumber(options['port-pool-start']),
    portPoolEnd: asNumber(options['port-pool-end']),
    modelRoots: options['model-roots'] ? String(options['model-roots']).split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    containerRuntime: options['container-runtime'],
    maxDegradeSteps: asNumber(options['max-degrade-steps']),
    deployTimeoutMs: asNumber(options['deploy-timeout-ms']),
    healthTimeoutMs: asNumber(options['health-timeout-ms']),
  }
}

/* ------------------------------------------------------------------ output */

const NO_COLOR = Boolean(process.env.NO_COLOR) || process.stdout?.isTTY === false
const STYLES = ['dim', 'bold', 'green', 'red', 'yellow', 'cyan']
const C = NO_COLOR
  ? Object.fromEntries(STYLES.map((s) => [s, (x) => String(x)]))
  : {
      dim: (s) => `\u001b[2m${s}\u001b[0m`,
      bold: (s) => `\u001b[1m${s}\u001b[0m`,
      green: (s) => `\u001b[32m${s}\u001b[0m`,
      red: (s) => `\u001b[31m${s}\u001b[0m`,
      yellow: (s) => `\u001b[33m${s}\u001b[0m`,
      cyan: (s) => `\u001b[36m${s}\u001b[0m`,
    }

function print(out, { json }) {
  if (json) {
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
    return
  }
  if (out && out.ok === false) {
    process.stdout.write(`${C.red('✗')} ${out.code}: ${out.message}\n`)
    if (out.remediation) process.stdout.write(`  ${C.dim('修复：')}${out.remediation}\n`)
    if (out.details) process.stdout.write(`  ${C.dim('细节：')}\n${indent(JSON.stringify(out.details, null, 2))}\n`)
    return
  }
  process.stdout.write(`${formatHuman(out)}\n`)
}

function indent(s, n = 4) {
  return String(s).split('\n').map((l) => ' '.repeat(n) + l).join('\n')
}

function formatHuman(out) {
  if (!out || typeof out !== 'object') return String(out)
  const lines = []

  if (out.endpoint && out.endpoint.url) {
    lines.push(`${C.green('✓')} ${C.bold('端点就绪')}${out.reused ? C.dim('（幂等命中，复用既有实例）') : ''}`)
    lines.push(`  URL       ${C.cyan(out.endpoint.url)}`)
    lines.push(`  模型名    ${out.endpoint.servedModelName}`)
    lines.push(`  模型      ${out.endpoint.model ?? out.report?.model?.resolvedPath ?? ''}`)
    lines.push(`  后端      ${out.endpoint.backend ?? out.report?.backend?.id ?? ''}`)
    if (out.report) {
      lines.push(`  耗时      ${(out.report.durationMs / 1000).toFixed(1)}s`)
      lines.push(`  降级      步数=${out.report.degrade?.steps ?? 0}${out.report.degrade?.lossy ? C.yellow('（含损档：精度）') : ''}`)
      if (out.report.attempts?.length) {
        lines.push(`  尝试      共 ${out.report.attempts.length} 次：${out.report.attempts.map((a) => `${a.tier}${a.failureCode ? `(${a.failureCode})` : ''}`).join(' → ')}`)
      }
      if (out.report.assumptions?.length) {
        lines.push(`  ${C.dim(`自动补全假设 ${out.report.assumptions.length} 条：`)}`)
        for (const a of out.report.assumptions.slice(0, 8)) lines.push(C.dim(`    · ${a.field} = ${JSON.stringify(a.value)}  ← ${a.reason}`))
      }
    }
    if (out.auditId) lines.push(C.dim(`  审计      ${out.auditId}`))
  }

  if (Array.isArray(out.endpoints)) {
    if (out.endpoints.length === 0) lines.push(C.dim('（无已注册端点）'))
    else {
      lines.push(C.bold(`共 ${out.count ?? out.endpoints.length} 个端点`))
      for (const e of out.endpoints) {
        const mark = e.status === 'serving' ? C.green('●') : e.status === 'torn_down' ? C.dim('○') : C.yellow('●')
        lines.push(`  ${mark} ${e.id}  ${e.endpoint ?? '-'}  ${e.model}  [${e.status}]`)
        if (e.consistency && !e.consistency.ok) lines.push(C.yellow(`      ⚠ ${e.consistency.message}`))
      }
    }
  } else if (out.endpoints && typeof out.endpoints === 'object') {
    const v = out.endpoints
    lines.push(`${C.bold('注册表')}  ${out.registry?.file}`)
    lines.push(`  端点 ${out.registry?.endpointCount} 个（存活 ${out.registry?.liveCount}）`)
    const t = Array.isArray(v) ? v[0] : v
    if (t) {
      lines.push(`  ${t.id}  ${t.endpoint ?? '-'}  [${t.status}]`)
      if (t.consistency) lines.push(`  ${t.consistency.ok ? C.green('✓') : C.red('✗')} ${t.consistency.message}`)
    }
    if (out.machine?.orphans?.length) lines.push(C.yellow(`  ⚠ 孤儿容器 ${out.machine.orphans.length} 个：${out.machine.orphans.map((o) => o.name).join(', ')}`))
  }

  if (out.verification) {
    lines.push(`${out.verification.clean ? C.green('✓ 清理干净') : C.red('✗ 存在残留')}`)
    for (const c of out.verification.checks) lines.push(`  ${c.ok ? C.green('✓') : C.red('✗')} ${c.name}: ${c.detail}`)
  }

  if (out.metrics) {
    const m = out.metrics
    lines.push(C.bold('指标'))
    for (const [k, v] of Object.entries(m.counters)) lines.push(`  ${k.padEnd(24)} ${v}`)
    lines.push(`  ${'deploy_ms_max'.padEnd(24)} ${m.timings.deploy_ms_max}`)
  }

  if (out.plan) {
    const p = out.plan
    lines.push(`${C.bold('迁移计划')}  needed=${p.needed}`)
    lines.push(`  源格式    ${p.source.format}`)
    lines.push(`  目标      ${p.target.backend}`)
    for (const s of p.steps) lines.push(`  · [${s.id}] ${s.description}`)
    if (p.risks?.length) { lines.push(C.yellow('  风险：')); for (const r of p.risks) lines.push(`    · (${r.severity}) ${r.description}`) }
  }

  if (out.verification === undefined && out.environment && out.manifest) {
    const e = out.environment
    lines.push(`${C.bold('inference-serving doctor')}  v${out.version?.package}`)
    lines.push(`  manifest   ${out.manifest.name}  能力：${out.manifest.capabilities.join(', ')}`)
    lines.push(`  沙箱       进程=${e.capabilities?.sandboxTiers?.process ? C.green('✓') : C.red('✗')} 容器=${e.capabilities?.sandboxTiers?.container ? C.green('✓') : C.red('✗')} VM=${e.capabilities?.sandboxTiers?.vm ? C.green('✓') : C.red('✗')}`)
    lines.push(`  GPU        ${e.gpu?.[0]?.name ?? '(无)'}${e.capabilities?.unifiedMemory ? ' [统一内存]' : ''}`)
    lines.push(`  显存       total=${fmtBytes(e.gpu?.[0]?.totalBytes)} available=${fmtBytes(e.capabilities?.availableMemoryBytes)} ${e.capabilities?.memoryIsEstimate ? C.dim('(估算)') : ''}`)
    lines.push(`  Docker     ${e.container?.available ? C.green('✓') : C.red('✗')} ${C.dim(e.container?.detail ?? '')}`)
    lines.push(`  端口池     ${e.ports?.host}:${e.ports?.pool?.join('-')}`)
    lines.push(`  策略来源   risk=${out.policySources?.risk} network=${out.policySources?.network} headless=${out.policySources?.headless}`)
    lines.push(`  headless   ${out.headless}`)
    if (out.proxyProbe?.envProxy) lines.push(`  代理       ${C.dim(`${out.proxyProbe.envProxy} —— 已按策略直连（不使用）`)}`)
  }

  if (lines.length === 0) return JSON.stringify(out, null, 2)
  return lines.join('\n')
}

function fmtBytes(b) {
  if (b === null || b === undefined) return 'n/a'
  return `${(b / 1024 ** 3).toFixed(1)} GiB`
}

/* -------------------------------------------------------------------- run */

export async function run(argv = process.argv.slice(2)) {
  const { positional, options, flags } = parseArgv(argv)
  const cmd = positional[0]
  const args = positional.slice(1)
  const json = flags.has('json')

  if (!cmd || cmd === 'help' || flags.has('help')) {
    printHelp()
    return 0
  }
  if (cmd === 'version') {
    const out = await api.doctor({ deep: false })
    process.stdout.write(`${out.version?.package ?? '?'}\n`)
    return 0
  }

  const common = buildCommonOptions(options, flags)
  const root = options.root

  let out
  switch (cmd) {
    case 'deploy': {
      const target = args[0] ?? options.model ?? options.path ?? options.url
      if (!target) { usageError('deploy 需要一个模型参数（路径 / 模型 ID / URL / env:VAR）'); return 2 }
      const deepProbe = flags.has('deep')
      out = await api.deploy(
        options.path ? { path: options.path } : options.url ? { url: options.url } : { model: target },
        {
          root,
          options: {
            ...common,
            bindHost: options['bind-host'] ?? common.bindHost,
            gpuMemoryUtilization: asNumber(options['gpu-memory-utilization']),
            maxModelLen: asNumber(options['max-model-len']),
            maxNumSeqs: asNumber(options['max-num-seqs']),
            image: options.image,
            servedModelName: options['served-model-name'],
            backend: options.backend,
            port: asNumber(options.port),
          },
          confirm: options.confirm ?? null,
          deepProbe,
        },
      )
      break
    }
    case 'status':
      out = await api.status({ selector: args[0] ?? null, verify: true, deep: flags.has('deep') }, { root, options: common })
      break
    case 'list':
      out = await api.listEndpoints({ status: options.status ?? null }, { root, options: common })
      break
    case 'rollback':
      if (!args[0] && !options.selector) { usageError('rollback 需要 selector'); return 2 }
      out = await api.rollback({ selector: args[0] ?? options.selector }, { root, options: { ...common, confirm: options.confirm } })
      break
    case 'teardown':
      if (!args[0] && !options.selector) { usageError('teardown 需要 selector'); return 2 }
      out = await api.teardown({ selector: args[0] ?? options.selector }, { root, options: { ...common, confirm: options.confirm } })
      break
    case 'migrate':
      if (!args[0]) { usageError('migrate 需要模型参数'); return 2 }
      out = await api.migrate({ model: args[0], target: options.target ?? 'nvidia-vllm' }, { root, options: { ...common, confirm: options.confirm } })
      break
    case 'metrics':
      out = await api.metrics({ root, options: common })
      break
    case 'audit-verify':
      out = await api.auditVerify({ root, options: common })
      break
    case 'reconcile':
      out = await api.reconcile({ reap: flags.has('reap'), root, options: { ...common, confirm: options.confirm } })
      break
    case 'doctor':
      out = await api.doctor({ deep: flags.has('deep'), root })
      break
    case 'tools':
      out = { ok: true, tools: (ALL_TOOL_SPECS).map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })), count: ALL_TOOL_SPECS.length }
      break
    case 'install-skills':
      out = await installSkills({ dir: options.dir })
      break
    default:
      usageError(`未知命令：${cmd}`)
      return 2
  }

  print(out, { json })

  if (out && out.ok === false) {
    if (out.code === ERROR_CODES.E_CONFIRMATION_REQUIRED || out.code === ERROR_CODES.E_HEADLESS_NEEDS_CONFIRMATION) return 3
    return 1
  }
  return 0
}

function usageError(msg) {
  process.stderr.write(`${C.red('用法错误')}: ${msg}\n\n`)
  printHelp(process.stderr)
}

function printHelp(stream = process.stdout) {
  stream.write(`${C.bold('inference-serving')} —— 把模型 checkpoint 部署为可访问的推理端点\n\n`)
  stream.write(`${C.bold('用法')}  inference-serving <command> [args] [--options]\n\n`)
  for (const [k, v] of Object.entries(COMMANDS)) stream.write(`  ${k.padEnd(16)}${v}\n`)
  stream.write(`\n${C.bold('通用选项')}\n`)
  stream.write(`  --root PATH               共享状态根目录（默认 ~/.ai-infra）\n`)
  stream.write(`  --confirm TOKEN           确认令牌（首次调用会在错误里给出）\n`)
  stream.write(`  --headless                强制 headless：需确认的操作一律中止\n`)
  stream.write(`  --json                    机器可读输出\n`)
  stream.write(`  --port N --bind-host H    指定端口/监听地址\n`)
  stream.write(`  --gpu-memory-utilization F --max-model-len N --max-num-seqs N\n`)
  stream.write(`  --deep                    深度探测（doctor/status/deploy）\n`)
  stream.write(`\n${C.bold('示例')}\n`)
  stream.write(`  inference-serving doctor\n`)
  stream.write(`  inference-serving deploy /path/to/models/<model>\n`)
  stream.write(`  inference-serving deploy Qwen2.5 --gpu-memory-utilization 0.9   # 触发降级链演示\n`)
  stream.write(`  inference-serving list --json\n`)
  stream.write(`  inference-serving teardown <endpoint-id> --confirm <token>\n`)
}

/** 把随包 SKILL.md 安装到 skills 目录（显式动作，不在加载时偷偷写）。 */
export async function installSkills({ dir = null } = {}) {
  const here = dirname(fileURLToPath(import.meta.url))
  const srcRoot = resolve(join(here, '..', 'skills'))
  const targetRoot = resolve(dir ?? join(process.env.DSH_HOME ?? join(process.env.HOME ?? '.', '.dsh'), 'skills'))
  const installed = []
  try {
    const names = await fs.readdir(srcRoot)
    for (const n of names) {
      const src = join(srcRoot, n, 'SKILL.md')
      try {
        const content = await fs.readFile(src, 'utf8')
        const destDir = join(targetRoot, n)
        await fs.mkdir(destDir, { recursive: true })
        await fs.writeFile(join(destDir, 'SKILL.md'), content, 'utf8')
        installed.push(join(destDir, 'SKILL.md'))
      } catch (err) {
        if (err.code !== 'ENOENT') throw err
      }
    }
  } catch (err) {
    return { ok: false, code: ERROR_CODES.E_INTERNAL, message: `安装 skills 失败：${err.message}`, remediation: `确认源目录存在：${srcRoot}`, details: { srcRoot, targetRoot } }
  }
  return { ok: true, source: srcRoot, target: targetRoot, installed, count: installed.length }
}

export { printHelp, formatHuman }
