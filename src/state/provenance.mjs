/**
 * 产物溯源边车（F-4）—— **serving 侧的只读契约**。
 *
 * 完整说明见 `inference-quantization/src/state/provenance.mjs`；这里只定义
 * serving 需要读的那部分，避免把生产者与消费者焊死在一起。
 *
 * ## 一句话
 *
 * 量化产物目录里没有 LICENSE，但它知道自己派生自谁。serving 据此把基座的
 * license 确认沿链继承 —— 否则 headless 下每个派生模型都要人再确认一次。
 *
 * 真机证据（`~/.ai-infra/logs/audit/inference-serving/2026-09-28.jsonl`）：
 *   seq 13 deploy start  target=deploy:e615af792f89aa94
 *   seq 14 deploy ERROR  E_LICENSE_UNRESOLVED（未能识别 / 未找到 LICENSE 文件）
 *   seq 15 denied → seq 16 start(带令牌) → seq 17 end ✅
 * 即：基座的 license 早已确认过，派生产物却**又**要了一次。
 */

export const PROVENANCE_FILE = 'ai-infra-provenance.json'
export const PROVENANCE_SCHEMA = 'ai-infra/provenance@1'

/**
 * 一条溯源链上**可能携带 license 确认**的所有模型引用，从近到远。
 *
 * 现在是单层（产物 → 基座）；写成列表是为了将来支持多级派生
 * （量化产物再量化 / 量化产物再调优导出）时不必改调用方。
 */
export function provenanceChain(license) {
  const chain = []
  const src = license?.provenance?.sourceModel ?? null
  if (typeof src === 'string' && src.length > 0) chain.push(src)
  return chain
}
