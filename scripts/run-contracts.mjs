#!/usr/bin/env node
/**
 * 跨包契约套件（内部闸门）的可选入口。
 *
 * 公开仓库只包含本包；契约检查来自兄弟仓库 inference-contracts，需要
 * `<repo>/../inference-contracts/checks/run-all.mjs` 一起存在（本机 monorepo 布局）。
 * 单仓库安装时明确跳过，不伪装成通过。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const runner = path.resolve(import.meta.dirname, '..', '..', 'inference-contracts', 'checks', 'run-all.mjs')
if (!fs.existsSync(runner)) {
  console.log('[contracts] skipped: sibling inference-contracts not present (standalone checkout)')
  process.exit(0)
}
const r = spawnSync(process.execPath, [runner], { stdio: 'inherit' })
process.exit(r.status ?? 1)
