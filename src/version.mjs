/**
 * 版本常量。
 *
 * 刻意不走 `import pkg from '../package.json'`：JSON import attributes 在不同 Node
 * 小版本上的告警/支持面不一致，而这里只需要两个字符串。一致性由
 * tests/unit/version.test.mjs 断言（比对 package.json 与 manifest.yaml），
 * 不靠运行时读取。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

export const PACKAGE_NAME = 'inference-serving'
export const PACKAGE_VERSION = '0.1.7'

/** MCP 工具接口语义化版本。破坏性变更升 major（题目原则 3.1.5）。 */
export const MCP_INTERFACE_VERSION = '1.0.0'

/** CLI 接口语义化版本。 */
export const CLI_INTERFACE_VERSION = '1.0.0'

/** 注册表文件格式版本；读到时若高于本值则拒绝写入（防止降级写坏新格式）。 */
export const REGISTRY_FORMAT_VERSION = 1

/** 审计记录格式版本。 */
export const AUDIT_FORMAT_VERSION = 1

export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 读取包内附带的 manifest.yaml 原文（能力清单）。 */
export function readManifestText() {
  return readFileSync(join(PACKAGE_ROOT, 'manifest.yaml'), 'utf8')
}
