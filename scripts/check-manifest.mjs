#!/usr/bin/env node
/**
 * 包规范自检（`npm run check`）。
 *
 * 为什么不放 `prepack`：题目要求「prepare / postinstall 不执行危险操作」。
 * 最安全的做法是**安装期零脚本**，把检查交给显式的 `npm run check`。
 *
 * 检查项：
 *   1. package.json 必需字段
 *   2. engines / os / cpu 已声明
 *   3. files 白名单覆盖所有运行期必需文件
 *   4. dependencies 为空（零运行时依赖是本包的硬约束）
 *   5. 版本号与 manifest.yaml / src/version.mjs 三处一致
 *   6. manifest.yaml 可被本包自己的受限 YAML 解析器解析
 *   7. 没有把 tests/scripts 打进包里
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from '../src/util/yaml.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const notes = []

function check(cond, message) {
  if (cond) notes.push(`  ok   ${message}`)
  else failures.push(`  FAIL ${message}`)
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

// 1
for (const f of ['name', 'version', 'description', 'license', 'type', 'main', 'bin', 'exports', 'files']) {
  check(pkg[f] !== undefined, `package.json 有字段 ${f}`)
}
check(pkg.type === 'module', 'package.json type=module（DSH 插件要求 ESM）')

// 2
check(pkg.engines?.node, `声明 engines.node（${pkg.engines?.node}）`)
check(Array.isArray(pkg.os) && pkg.os.length > 0, `声明 os（${JSON.stringify(pkg.os)}）`)
check(Array.isArray(pkg.cpu) && pkg.cpu.length > 0, `声明 cpu（${JSON.stringify(pkg.cpu)}）`)

// 3
const requiredInFiles = ['bin/', 'src/', 'mcp/', 'skills/', 'manifest.yaml', 'README.md', 'LICENSE', 'cordis.patch.yml']
for (const r of requiredInFiles) {
  check(pkg.files?.includes(r), `files 白名单包含 ${r}`)
}
const mustExist = ['README.md', 'LICENSE', 'manifest.yaml', 'cordis.patch.yml', 'bin/inference-serving.mjs', 'mcp/server.mjs', 'src/index.mjs', 'src/api.mjs']
for (const m of mustExist) {
  check(existsSync(join(root, m)), `文件存在：${m}`)
}

// 4 —— 零依赖是硬约束（题目第七节「不得引入未声明依赖」的更强形式）
const deps = Object.keys(pkg.dependencies ?? {})
check(deps.length === 0, `dependencies 为空（当前 ${deps.length} 个：${deps.join(', ') || '无'}）`)

// 5
const manifest = parse(readFileSync(join(root, 'manifest.yaml'), 'utf8'))
const versionSrc = readFileSync(join(root, 'src/version.mjs'), 'utf8')
const m = /PACKAGE_VERSION\s*=\s*'([^']+)'/.exec(versionSrc)
check(m && m[1] === pkg.version, `src/version.mjs 版本与 package.json 一致（${m?.[1]} vs ${pkg.version}）`)
check(manifest?.version === pkg.version, `manifest.yaml 版本与 package.json 一致（${manifest?.version} vs ${pkg.version}）`)
check(manifest?.name === pkg.name, `manifest.yaml name 与 package.json 一致（${manifest?.name} vs ${pkg.name}）`)

// 6 —— manifest.yaml 结构
check(Array.isArray(manifest?.capabilities) && manifest.capabilities.length > 0, `manifest.yaml 声明了 ${manifest?.capabilities?.length ?? 0} 个 capability`)
const declaredIds = (manifest?.capabilities ?? []).map((c) => c.id)
for (const expected of ['deploy', 'status', 'rollback', 'teardown', 'list_endpoints', 'migrate']) {
  check(declaredIds.includes(expected), `manifest 声明了 capability: ${expected}`)
}
// 每个 capability 必须声明 resources（最小权限）
for (const c of manifest?.capabilities ?? []) {
  check(Array.isArray(c.resources) && c.resources.length > 0, `capability ${c.id} 声明了 resources`)
  check(['read', 'write', 'system'].includes(c.risk), `capability ${c.id} 的 risk 合法（${c.risk}）`)
}

// 7
check(!pkg.files?.some((f) => f.startsWith('tests') || f.startsWith('scripts')), 'files 白名单不含 tests/ 或 scripts/')

// DSH bundle 清单
check(pkg.dsh?.bundle?.patch === './cordis.patch.yml', 'package.json 声明 dsh.bundle.patch')

process.stdout.write(`inference-serving 包规范自检\n${notes.join('\n')}\n`)
if (failures.length > 0) {
  process.stdout.write(`\n${failures.length} 项失败：\n${failures.join('\n')}\n`)
  process.exit(1)
}
process.stdout.write(`\n全部通过（${notes.length} 项）\n`)
