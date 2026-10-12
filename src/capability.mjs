/**
 * 最小权限闸门（题目原则 3.1.3 / 验收标准 5.3.6）。
 *
 * 语义：`manifest.yaml` 是**白名单**。未声明的 capability 拒绝；已声明的 capability
 * 去用未列出的 resource 也拒绝。两者错误码不同，便于定位是"没用这个能力"还是
 * "这个能力不该碰这个资源"。
 */
import { fail, ERROR_CODES } from './errors.mjs'
import { parse } from './util/yaml.mjs'
import { readManifestText } from './version.mjs'

let cached = null

export function loadManifest(text) {
  const raw = text ?? readManifestText()
  const doc = parse(raw)
  if (!doc || !Array.isArray(doc.capabilities)) {
    fail(ERROR_CODES.E_INTERNAL, 'manifest.yaml 结构非法：缺 capabilities 数组', {
      remediation: '恢复包内 manifest.yaml，或用 INFERENCE_SERVING_MANIFEST 指定正确的清单文件。',
    })
  }
  const byId = new Map()
  for (const cap of doc.capabilities) {
    if (!cap || typeof cap.id !== 'string') {
      fail(ERROR_CODES.E_INTERNAL, 'manifest.yaml 中存在缺少 id 的 capability', { remediation: '修正 manifest.yaml。' })
    }
    byId.set(cap.id, {
      id: cap.id,
      risk: cap.risk ?? 'write',
      sandbox: cap.sandbox ?? 'container',
      idempotent: cap.idempotent === true,
      resources: Array.isArray(cap.resources) ? cap.resources : [],
    })
  }
  const notProvided = new Map()
  for (const np of doc.not_provided ?? []) {
    if (np && np.id) notProvided.set(np.id, np)
  }
  return {
    name: doc.name,
    version: doc.version,
    interface: doc.interface ?? {},
    capabilities: byId,
    notProvided,
  }
}

export function getManifest({ refresh = false, text } = {}) {
  if (refresh || text !== undefined || cached === null) cached = loadManifest(text)
  return cached
}

export function listCapabilityIds() {
  return [...getManifest().capabilities.keys()]
}

/**
 * 断言某 capability 已声明，且本次要用的 resources 全在其声明范围内。
 * @returns {object} capability 定义
 */
export function assertCapability(id, usedResources = []) {
  const manifest = getManifest()
  if (manifest.notProvided.has(id)) {
    const np = manifest.notProvided.get(id)
    fail(ERROR_CODES.E_CAPABILITY_DENIED, `能力 "${id}" 在本插件中属于「设计上不提供」`, {
      remediation: `该能力被显式排除：${np.reason ?? '未说明'}。请改用本插件声明的能力，或由具备相应权限的外部流程执行。`,
      details: { capability: id, notProvided: true, risk: np.risk ?? 'system' },
      capability: id,
    })
  }
  const cap = manifest.capabilities.get(id)
  if (!cap) {
    fail(ERROR_CODES.E_CAPABILITY_DENIED, `能力 "${id}" 未在 manifest.yaml 中声明`, {
      remediation: `本插件只提供：${[...manifest.capabilities.keys()].join(', ')}。若确需该能力，请在 manifest.yaml 中新增并升 MCP major 版本。`,
      details: { capability: id, declared: [...manifest.capabilities.keys()] },
      capability: id,
    })
  }
  const undeclared = usedResources.filter((r) => !cap.resources.includes(r))
  if (undeclared.length > 0) {
    fail(ERROR_CODES.E_RESOURCE_NOT_DECLARED, `能力 "${id}" 试图访问未声明的资源：${undeclared.join(', ')}`, {
      remediation: `该能力已声明资源为 [${cap.resources.join(', ')}]。请只使用其中列出的资源；确需扩展请在 manifest.yaml 中补声明（属破坏性权限变更）。`,
      details: { capability: id, undeclared, declared: cap.resources },
      capability: id,
    })
  }
  return cap
}

/** 用于测试：清空缓存。 */
export function __resetManifestCache() {
  cached = null
}
