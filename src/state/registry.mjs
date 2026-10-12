/**
 * 端点注册表 `~/.ai-infra/state/serving-registry.yaml`（题目 §4.4）。
 *
 * 并发方案（题目 §3.7 授权 DSH 自决）：**文件锁 + 原子写**。
 *   - 读-改-写全程持 `withLock()`，避免两个并发 deploy 互相覆盖；
 *   - 落地用同目录 temp + rename，读者永远看到完整文件；
 *   - 超时/陈旧锁由 util/lock.mjs 处理（按 pid 存活 + mtime 双判据）。
 * 不引入第三方锁库：`fs.open(path,'wx')` 已足够表达临界区。
 *
 * 结构设计要点：一个"模型+后端"= 一条 endpoint 记录（幂等），它下面有**多个 revision**。
 * 这样 rollback 天然就是"把 currentRevision 退回上一个已验证 revision 并按其配置重启"，
 * 而不需要第二份历史文件。
 */
import { publicLease } from './lease.mjs'
import { promises as fs } from 'node:fs'
import { stringify, parse } from '../util/yaml.mjs'
import { atomicWrite, readText, mkdirp, listDir } from '../util/fsx.mjs'
import { withLock } from '../util/lock.mjs'
import { REGISTRY_FORMAT_VERSION, PACKAGE_VERSION } from '../version.mjs'
import { fail, ERROR_CODES } from '../errors.mjs'

export function emptyRegistry() {
  return { version: REGISTRY_FORMAT_VERSION, updatedAt: new Date().toISOString(), pkg: PACKAGE_VERSION, endpoints: [] }
}

export function parseRegistry(text) {
  if (!text || text.trim() === '') return emptyRegistry()
  let doc
  try {
    doc = parse(text)
  } catch (err) {
    fail(ERROR_CODES.E_INTERNAL, `注册表解析失败：${err.message}`, {
      remediation: '注册表已损坏。可先用 `inference-serving status --raw` 查看原文，人工修复或从 state/history/ 取备份。',
      details: { parseError: String(err.message) },
      cause: err,
    })
  }
  if (!doc) return emptyRegistry()
  const version = doc.version ?? 1
  if (version > REGISTRY_FORMAT_VERSION) {
    fail(ERROR_CODES.E_INTERNAL, `注册表格式版本 ${version} 高于本插件支持的 ${REGISTRY_FORMAT_VERSION}`, {
      remediation: '请升级 inference-serving，或使用较新的副本；本插件拒绝以旧格式覆盖新格式（防止写坏）。',
      details: { found: version, supported: REGISTRY_FORMAT_VERSION },
    })
  }
  return {
    version,
    updatedAt: doc.updatedAt ?? null,
    pkg: doc.pkg ?? null,
    endpoints: Array.isArray(doc.endpoints) ? doc.endpoints : [],
  }
}

export function serializeRegistry(reg) {
  return stringify(
    { ...reg, updatedAt: new Date().toISOString(), pkg: PACKAGE_VERSION },
    { header: 'inference-serving 端点注册表 —— 由插件维护，手工编辑请保持受限 YAML 子集（字符串需双引号）' },
  )
}

export async function loadRegistry(runtime) {
  const text = await readText(runtime.paths.registryFile, null)
  return parseRegistry(text)
}

export async function saveRegistry(runtime, reg) {
  await mkdirp(runtime.paths.stateDir)
  await atomicWrite(runtime.paths.registryFile, serializeRegistry(reg))
  return reg
}

/** 读-改-写事务。fn 收到可变 registry，返回值即本次事务结果。 */
export async function withRegistry(runtime, fn, { backup = true } = {}) {
  return withLock(runtime.paths.lockDir, 'registry', async () => {
    const before = await readText(runtime.paths.registryFile, null)
    const reg = parseRegistry(before)
    if (backup && before) await snapshot(runtime, before)
    const result = await fn(reg)
    await saveRegistry(runtime, reg)
    return result
  })
}

/** 每次写前留一份快照，便于人工回滚注册表本身。最多保留 20 份。 */
async function snapshot(runtime, text) {
  try {
    await mkdirp(runtime.paths.historyDir)
    const name = `${new Date().toISOString().replace(/[:.]/g, '-')}.yaml`
    await atomicWrite(`${runtime.paths.historyDir}/${name}`, text)
    const names = (await listDir(runtime.paths.historyDir)).filter((n) => n.endsWith('.yaml')).sort()
    for (const old of names.slice(0, Math.max(0, names.length - 20))) {
      await fs.rm(`${runtime.paths.historyDir}/${old}`, { force: true })
    }
  } catch {
    // 快照失败不应阻断主流程（它是便利设施，不是安全属性 —— 安全属性是审计链）
  }
}

/* ------------------------------------------------------------- 查询辅助 */

export function findEndpoint(reg, selector) {
  if (!selector) return null
  const s = String(selector).trim()
  const norm = s.replace(/\/+$/, '')
  return reg.endpoints.find((e) => e.id === s)
    ?? reg.endpoints.find((e) => e.key === s)
    ?? reg.endpoints.find((e) => e.model === s)
    ?? reg.endpoints.find((e) => e.modelRef && e.modelRef.value === s)
    ?? reg.endpoints.find((e) => e.servedModelName === s)
    ?? reg.endpoints.find((e) => currentRevision(e)?.endpoint?.replace(/\/+$/, '') === norm)
    ?? reg.endpoints.find((e) => currentRevision(e)?.containerName === s)
    ?? reg.endpoints.find((e) => e.model && e.model.endsWith(`/${s}`))
    ?? null
}

export function currentRevision(endpoint) {
  if (!endpoint || !Array.isArray(endpoint.revisions) || endpoint.revisions.length === 0) return null
  const idx = endpoint.currentRevision ?? endpoint.revisions.length
  return endpoint.revisions.find((r) => r.rev === idx) ?? endpoint.revisions[endpoint.revisions.length - 1]
}

export function previousVerifiedRevision(endpoint, { excludeRev = null } = {}) {
  const revs = [...(endpoint?.revisions ?? [])]
    .filter((r) => r.verifiedAt && r.rev !== excludeRev)
    .sort((a, b) => b.rev - a.rev)
  const cur = excludeRev ?? endpoint?.currentRevision
  return revs.find((r) => r.rev < cur) ?? null
}

export function pushHistory(endpoint, event, detail = null) {
  if (!Array.isArray(endpoint.history)) endpoint.history = []
  endpoint.history.push({ at: new Date().toISOString(), event, detail })
  if (endpoint.history.length > 100) endpoint.history = endpoint.history.slice(-100)
  return endpoint
}

export function addRevision(endpoint, revision) {
  if (!Array.isArray(endpoint.revisions)) endpoint.revisions = []
  const nextRev = endpoint.revisions.reduce((m, r) => Math.max(m, r.rev ?? 0), 0) + 1
  const rec = { rev: nextRev, status: 'pending', createdAt: new Date().toISOString(), ...revision }
  endpoint.revisions.push(rec)
  endpoint.currentRevision = nextRev
  return rec
}

/** 列出所有仍视为"活着"的端点（serving / degraded）。 */
export function liveEndpoints(reg) {
  return reg.endpoints.filter((e) => ['serving', 'degraded'].includes(e.status))
}

/** 摘要视图：给 status / list_endpoints 用，不回传整个 revisions 历史。 */
export function summarize(endpoint) {
  const cur = currentRevision(endpoint)
  return {
    id: endpoint.id,
    key: endpoint.key,
    model: endpoint.model,
    backend: endpoint.backend,
    status: endpoint.status,
    endpoint: cur?.endpoint ?? null,
    port: cur?.port ?? null,
    bindHost: cur?.bindHost ?? null,
    containerName: cur?.containerName ?? null,
    servedModelName: cur?.servedModelName ?? null,
    degradeStep: cur?.degradeStep ?? null,
    revision: endpoint.currentRevision ?? null,
    revisionsVerified: (endpoint.revisions ?? []).filter((r) => r.verifiedAt).length,
    createdAt: endpoint.createdAt ?? null,
    healthyAt: cur?.verifiedAt ?? null,
    config: cur?.config ?? null,
    /** 镜像的**内容寻址**固定引用（tag 会漂；这里给的是 RepoDigest 或镜像 ID） */
    image: cur?.image ?? null,
    imageDigest: cur?.imageDigest ?? null,
    imageDigestKind: cur?.imageDigestKind ?? null,
    /**
     * 租约的**公开视图** —— owner/到期时间可见（便于排查"谁占着"），
     * 但**绝不包含 ownerToken**：那是凭证，只回给 deploy 的调用方。
     */
    lease: publicLease(endpoint.lease),
  }
}
