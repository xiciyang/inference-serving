import { createHash } from 'node:crypto'

/** sha256 十六进制摘要。 */
export function sha256(input) {
  return createHash('sha256').update(input).digest('hex')
}

/**
 * 稳定序列化：对象键排序后序列化，保证同一逻辑值产出同一字符串。
 * 用于审计哈希链与幂等键 —— 键序不稳定会让同一次调用算出两个不同的键。
 */
export function canonicalJson(value) {
  return JSON.stringify(sortDeep(value))
}

function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep)
  if (v && typeof v === 'object') {
    const out = {}
    for (const k of Object.keys(v).sort()) {
      if (v[k] === undefined) continue
      out[k] = sortDeep(v[k])
    }
    return out
  }
  return v
}

/** 计算幂等键：同一次逻辑部署必须得到同一个 key。 */
export function idempotencyKey(parts) {
  return sha256(canonicalJson(parts)).slice(0, 16)
}

/** 短 id，用于容器名/端点 id。 */
export function shortId(seed, len = 10) {
  return sha256(String(seed)).slice(0, len)
}
