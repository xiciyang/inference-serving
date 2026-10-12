#!/usr/bin/env node
/**
 * CLI 入口。全部逻辑在 src/cli.mjs，这里只负责把退出码传出去。
 */
import { run } from '../src/cli.mjs'

const code = await run(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`[inference-serving] 未捕获错误：${err?.stack ?? err}\n`)
  return 1
})

process.exitCode = typeof code === 'number' ? code : 0
