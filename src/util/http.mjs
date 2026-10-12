import http from 'node:http'
import https from 'node:https'
import net from 'node:net'

/**
 * 直连 HTTP 客户端。
 *
 * 为什么不用全局 `fetch`：Node 24 在本机 `NODE_USE_ENV_PROXY=1`（实测），fetch/undici
 * 会自动继承 `HTTPS_PROXY`。而本机那个代理（127.0.0.1:7897）**上游已坏**：CONNECT 返回
 * 200 但 TLS 必失败，每次白等 10s（PROJECT_CONTEXT.md §8.1）。
 *
 * `node:http` / `node:https` 的 request **不读取** HTTP(S)_PROXY 环境变量 —— 这正好是
 * NETWORK_POLICY_DRAFT.md 规则 1 要的"显式直连"。所以这里用它们，而不是 fetch。
 */

export function request(url, {
  method = 'GET',
  headers = {},
  body = null,
  timeoutMs = 10_000,
  signal,
  maxBytes = 4 * 1024 * 1024,
} = {}) {
  const u = new URL(url)
  const mod = u.protocol === 'https:' ? https : http
  const startedAt = Date.now()

  return new Promise((resolve) => {
    const req = mod.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        method,
        headers: { 'user-agent': 'inference-serving/0.1.0', ...headers },
      },
      (res) => {
        const chunks = []
        let size = 0
        res.on('data', (c) => {
          size += c.length
          if (size <= maxBytes) chunks.push(c)
        })
        res.on('end', () => {
          resolve({
            ok: true,
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
            truncated: size > maxBytes,
            durationMs: Date.now() - startedAt,
          })
        })
      },
    )

    let settled = false
    const done = (payload) => { if (!settled) { settled = true; resolve(payload) } }

    const timer = timeoutMs > 0
      ? setTimeout(() => { req.destroy(new Error('ETIMEDOUT')); }, timeoutMs)
      : null
    timer?.unref?.()

    const onAbort = () => req.destroy(new Error('EABORTED'))
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }

    req.on('error', (err) => {
      if (timer) clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
      done({ ok: false, error: err.code ?? err.message, message: err.message, durationMs: Date.now() - startedAt })
    })
    req.on('close', () => { if (timer) clearTimeout(timer) })

    if (body !== null && body !== undefined) req.write(body)
    req.end()
  })
}

export async function getJson(url, opts = {}) {
  const r = await request(url, opts)
  if (!r.ok) return { ...r, json: null }
  try {
    return { ...r, json: JSON.parse(r.body) }
  } catch {
    return { ...r, json: null, parseError: true }
  }
}

export async function postJson(url, payload, opts = {}) {
  const body = JSON.stringify(payload)
  return getJson(url, {
    ...opts,
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...(opts.headers ?? {}) },
    body,
  })
}

/** TCP 连通性探测（用于"端口是否已被占用/服务是否在听"）。 */
export function probeTcp(host, port, timeoutMs = 1_000) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    const sock = new net.Socket()
    let settled = false
    const done = (open) => {
      if (settled) return
      settled = true
      sock.destroy()
      resolve({ open, durationMs: Date.now() - startedAt })
    }
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => done(true))
    sock.once('timeout', () => done(false))
    sock.once('error', () => done(false))
    sock.connect(port, host)
  })
}

/** 端口是否空闲 —— 真 bind 一次再释放，不靠"扫描已监听列表"推断。 */
export function isPortFree(host, port) {
  return new Promise((resolve) => {
    const srv = net.createServer()
    let settled = false
    const done = (free) => {
      if (settled) return
      settled = true
      try { srv.close() } catch { /* not listening */ }
      resolve(free)
    }
    srv.once('error', () => done(false))
    srv.once('listening', () => done(true))
    srv.listen({ host, port, exclusive: true })
  })
}

/** 在端口池中找第一个空闲端口。 */
export async function findFreePort(host, portPool, exclude = new Set()) {
  for (const p of portPool) {
    if (exclude.has(p)) continue
    // eslint-disable-next-line no-await-in-loop
    if (await isPortFree(host, p)) return p
  }
  return null
}
