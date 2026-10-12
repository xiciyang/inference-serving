/**
 * MCP server 入口（`inference-serving-mcp` / `node mcp/server.mjs`）。
 *
 * 定位（见 RISK_CLASSIFICATION_DRAFT.md §7 第 3 项，已确认选项 ③）：
 *   DSH 在 MCP 上扮演的是 **client**，不会消费自家插件的 MCP server。因此本文件的作用是
 *   **对第三方 MCP 客户端**暴露同一套工具，而不是给 DSH 自己用。DSH 侧走 index.mjs 的
 *   `ctx.tools.register()`。两条通道共用 src/tools.mjs 的同一份规格与 src/api.mjs 的实现，
 *   **不存在行为分叉**。
 *
 * 传输：
 *   - stdio（默认）：按行分隔的 JSON-RPC 2.0，符合 MCP stdio 传输约定
 *   - streamable-http：`--http --port N`，POST /mcp 单请求单响应
 *
 * 环境变量：INFERENCE_SERVING_ROOT 可指定共享状态根目录。
 */
import readline from 'node:readline'
import http from 'node:http'
import { ALL_TOOL_SPECS, findToolSpec } from '../src/tools.mjs'
import { PACKAGE_VERSION, MCP_INTERFACE_VERSION } from '../src/version.mjs'
import { toErrorPayload } from '../src/errors.mjs'

const SERVER_INFO = { name: 'inference-serving', version: PACKAGE_VERSION }
const DEFAULT_PROTOCOL = '2024-11-05'
const SUPPORTED_PROTOCOLS = new Set(['2024-11-05', '2024-10-07', '2025-03-26', '2025-06-18'])

function rpcResult(id, result) { return { jsonrpc: '2.0', id, result } }
function rpcError(id, code, message, data) { return { jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } } }

function toolsList() {
  return ALL_TOOL_SPECS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.parameters ?? { type: 'object', properties: {} },
  }))
}

async function callTool(name, args) {
  const spec = findToolSpec(name)
  if (!spec) {
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, code: 'E_UNKNOWN_TOOL', message: `未知工具：${name}`, remediation: `可用工具：${ALL_TOOL_SPECS.map((t) => t.name).join(', ')}` }, null, 2) }] }
  }
  try {
    const value = await spec.handler(args ?? {}, {})
    const isError = value && value.ok === false
    return {
      isError,
      content: [{ type: 'text', text: JSON.stringify(value ?? null, null, 2) }],
      structuredContent: value ?? null,
    }
  } catch (err) {
    const payload = toErrorPayload(err)
    return { isError: true, content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] }
  }
}

/** 处理一条 JSON-RPC 消息，返回响应对象；通知返回 null。 */
export async function handleMessage(msg) {
  if (!msg || typeof msg !== 'object') return rpcError(null, -32600, 'Invalid Request')
  const { id = null, method, params } = msg
  const isNotification = id === undefined || id === null

  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion
      const protocolVersion = SUPPORTED_PROTOCOLS.has(requested) ? requested : DEFAULT_PROTOCOL
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { ...SERVER_INFO, interfaceVersion: MCP_INTERFACE_VERSION },
        instructions:
          'inference-serving：把模型 checkpoint 部署为可访问的推理端点。部署失败会自动沿降级链重试；所有调用写入哈希链审计。破坏性操作为幂等设计，重复调用安全。',
      })
    }
    case 'notifications/initialized':
    case 'initialized':
      return null
    case 'ping':
      return rpcResult(id, {})
    case 'tools/list':
      return rpcResult(id, { tools: toolsList() })
    case 'tools/call': {
      const name = params?.name
      const args = params?.arguments ?? {}
      const out = await callTool(name, args)
      return rpcResult(id, out)
    }
    case 'resources/list':
      return rpcResult(id, { resources: [] })
    case 'prompts/list':
      return rpcResult(id, { prompts: [] })
    default:
      if (isNotification) return null
      return rpcError(id, -32601, `Method not found: ${method}`)
  }
}

/* ------------------------------------------------------------------ stdio */

export function serveStdio({ input = process.stdin, output = process.stdout } = {}) {
  const rl = readline.createInterface({ input, crlfDelay: Infinity })
  let chain = Promise.resolve()

  rl.on('line', (line) => {
    const text = line.trim()
    if (text === '') return
    chain = chain.then(async () => {
      let msg
      try {
        msg = JSON.parse(text)
      } catch {
        output.write(`${JSON.stringify(rpcError(null, -32700, 'Parse error'))}\n`)
        return
      }
      try {
        const res = await handleMessage(msg)
        if (res) output.write(`${JSON.stringify(res)}\n`)
      } catch (err) {
        output.write(`${JSON.stringify(rpcError(msg?.id ?? null, -32603, String(err?.message ?? err)))}\n`)
      }
    })
  })

  return new Promise((resolvePromise) => {
    rl.on('close', () => chain.finally(() => resolvePromise()))
  })
}

/* --------------------------------------------------------- streamable-http */

export function serveHttp({ port = 8790, host = '127.0.0.1' } = {}) {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, server: SERVER_INFO }))
      return
    }
    if (req.method !== 'POST' || (req.url !== '/mcp' && req.url !== '/')) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'POST /mcp only' }))
      return
    }
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', async () => {
      let msg
      try {
        msg = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify(rpcError(null, -32700, 'Parse error')))
        return
      }
      const body = Array.isArray(msg) ? await Promise.all(msg.map((m) => handleMessage(m))) : await handleMessage(msg)
      if (body === null || (Array.isArray(body) && body.every((b) => b === null))) {
        res.writeHead(202).end()
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    })
  })
  server.listen(port, host)
  return server
}

/* -------------------------------------------------------------------- main */

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  const args = process.argv.slice(2)
  if (args.includes('--http')) {
    const i = args.indexOf('--port')
    const port = i >= 0 ? Number(args[i + 1]) : 8790
    serveHttp({ port })
    process.stderr.write(`[inference-serving-mcp] streamable-http listening on 127.0.0.1:${port} (POST /mcp)\n`)
  } else if (args.includes('--help')) {
    process.stdout.write('inference-serving MCP server\n  (no args)       stdio transport\n  --http [--port N]  streamable-http transport\n')
  } else {
    process.stderr.write('[inference-serving-mcp] stdio transport ready\n')
    await serveStdio()
  }
}

export { toolsList, callTool, SERVER_INFO, DEFAULT_PROTOCOL }
