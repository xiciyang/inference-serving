/**
 * 镜像 digest 固定（F-6 的姊妹项；用户验收标准第 6 条）。
 *
 * ## 为什么这是"可修"而不是"边界"
 *
 * 集成测试取证（S5-5/6/8）：
 *
 *   $ docker inspect -f '{{.RepoTags}}|{{.RepoDigests}}' vllm/vllm-openai:nightly
 *     RepoDigests=[vllm/vllm-openai@sha256:be5ff841eb156c3d1be3e318e33ae682eaaa0c967f05e96115bb39333bace392]  ← 有！
 *   $ docker inspect -f '{{.Id}}' inference-quantization/toolchain:0.1.0
 *     sha256:0c54b2b125edb866ba14ec91e8a1a321734811a8912ab2e7537bfe381d02e255        ← 内容寻址 ID
 *
 * 而 runSpec 记的是 `imageDigest: null` —— 说明**不是本机取不到**，而是只读了配置里的 tag 字符串。
 * tag 会漂（`nightly` 尤其会），所以"重放不出同一个端点"。
 *
 * ## 固定到什么
 *
 * 优先 `镜像名@sha256:…`（RepoDigest，可跨机重现）；本地构建、从未 push 过的镜像没有
 * RepoDigest，退回内容寻址的**镜像 ID**（`sha256:…`）。两者都是内容寻址的，
 * 都比 tag 强。取不到就是取不到 —— 返回 null，**不猜**。
 */
import { run } from '../util/proc.mjs'

/** 解析一个镜像的固定引用。返回 {ref, kind, digest} 或 null。 */
export async function resolveImagePin(image, { timeoutMs = 20_000 } = {}) {
  if (!image || typeof image !== 'string') return null
  const r = await run('docker', ['inspect', '-f', '{{.RepoDigests}}|{{.Id}}', image], { timeoutMs })
  if (r.code !== 0) return null
  const [repoDigests = '', id = ''] = String(r.stdout ?? '').trim().split('|')
  const digest = /sha256:[0-9a-f]{64}/.exec(repoDigests)?.[0] ?? null
  if (digest) {
    // 去掉 tag，写成 `name@sha256:…` 的规范形态
    const name = image.includes(':') && !image.includes('@') ? image.slice(0, image.lastIndexOf(':')) : image.split('@')[0]
    return { ref: `${name}@${digest}`, kind: 'repo-digest', digest, image }
  }
  const idMatch = /sha256:[0-9a-f]{64}/.exec(id)?.[0] ?? null
  if (idMatch) return { ref: idMatch, kind: 'image-id', digest: idMatch, image }
  return null
}

/**
 * 从**运行中的容器**反查镜像的固定引用。
 *
 * 这条比"按 name 查镜像"更可靠：serving 的端点只暴露 containerName，而
 * `docker inspect <container>` 能同时给出 `.Config.Image`（tag）与 `.Image`（内容 ID）。
 */
export async function resolveImagePinFromContainer(containerName, { timeoutMs = 20_000 } = {}) {
  if (!containerName) return null
  const r = await run('docker', ['inspect', '-f', '{{.Config.Image}}|{{.Image}}', containerName], { timeoutMs })
  if (r.code !== 0) return null
  const [tag = '', id = ''] = String(r.stdout ?? '').trim().split('|')
  const digest = /sha256:[0-9a-f]{64}/.exec(id)?.[0] ?? null
  if (!digest) return null
  return { ref: digest, kind: 'image-id', digest, image: tag || null, via: 'container-inspect', containerName }
}
