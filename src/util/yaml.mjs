/**
 * 受限 YAML 子集 —— 零依赖。
 *
 * 为什么不用第三方 YAML：题目第七节「不得引入未声明依赖」，而本插件所有运行时
 * 依赖都应为零（`npm install` 要能在镜像上秒过）。因此这里实现**只覆盖本包自己
 * 发射的格式**的读写器：
 *   - 字符串一律用 JSON.stringify 输出（合法的 YAML 双引号标量），不做花式转义推断
 *   - 只支持：嵌套映射、映射数组、标量（string/number/boolean/null）
 *   - 不支持：锚点、别名、多文档、流式集合、块标量、复杂键
 *
 * 关键约定：**解析器只接受发射器会产出的形状**。遇到任何不在子集内的写法一律抛
 * YamlError（带行号），而不是猜。这保证了「读写闭环」可以被单元测试穷举验证，
 * 也避免了一个半吊子 YAML 库静默曲解用户的配置。
 */

export class YamlError extends Error {
  constructor(message, line) {
    super(line ? `${message} (line ${line})` : message)
    this.name = 'YamlError'
    this.line = line
  }
}

/**
 * 键的两种合法写法，**都要认**：
 *   裸词     `version: 1`
 *   双引号   `"version": 1`
 *
 * 为什么必须兼容双引号：`inference-tuning` 的 emitter 选择给键加引号
 * （`emitKey` 一律包 `"`），而另两个包的 writer 用裸词。集成测试实测：
 * 本文件原有的正则只认裸词，于是 `tuning-registry.yaml` 对 serving 与
 * quantization **完全不可读** —— `~/.ai-infra` 名义上是三个包共享的状态根，
 * 实际是单向门。共享状态根上不允许"我写得出、你读不了"。
 */
const KEY_RE = /^(?:"((?:[^"\\]|\\.)*)"|([A-Za-z0-9_.\-/]+)):(?:[ ](.*))?$/
const MAP_START_RE = /^(?:"(?:[^"\\]|\\.)*"|[A-Za-z0-9_.\-/]+):(?:[ ]|$)/

/** 把双引号键里的转义还原（与 emitter 的 `.replace(/"/g, '\\"')` 对应）。 */
function unquoteKey(raw) {
  if (raw === undefined) return undefined
  return raw.replace(/\\(.)/g, '$1')
}

/* ------------------------------------------------------------------ emit */

function scalar(v) {
  if (v === null) return 'null'
  if (typeof v === 'string') return JSON.stringify(v)
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return JSON.stringify(String(v))
    return String(v)
  }
  if (typeof v === 'bigint') return JSON.stringify(String(v))
  throw new YamlError(`unsupported scalar type: ${typeof v}`)
}

function emitObject(obj, indent, out) {
  const pad = ' '.repeat(indent)
  for (const [k, val] of Object.entries(obj)) {
    if (val === undefined) continue
    if (!/^[A-Za-z0-9_.\-/]+$/.test(k)) throw new YamlError(`unsupported key: ${JSON.stringify(k)}`)
    if (val !== null && typeof val === 'object') {
      if (Array.isArray(val)) {
        if (val.length === 0) { out.push(`${pad}${k}: []`); continue }
        out.push(`${pad}${k}:`)
        emitArray(val, indent + 2, out)
      } else {
        const keys = Object.keys(val).filter((x) => val[x] !== undefined)
        if (keys.length === 0) { out.push(`${pad}${k}: {}`); continue }
        out.push(`${pad}${k}:`)
        emitObject(val, indent + 2, out)
      }
    } else {
      out.push(`${pad}${k}: ${scalar(val)}`)
    }
  }
}

function emitArray(arr, indent, out) {
  const pad = ' '.repeat(indent)
  for (const item of arr) {
    if (item !== null && typeof item === 'object') {
      if (Array.isArray(item)) {
        if (item.length === 0) { out.push(`${pad}- []`); continue }
        out.push(`${pad}-`)
        emitArray(item, indent + 2, out)
      } else {
        const keys = Object.keys(item).filter((x) => item[x] !== undefined)
        if (keys.length === 0) { out.push(`${pad}- {}`); continue }
        const tmp = []
        emitObject(item, indent + 2, tmp)
        // 把对象第一个键提到 "- " 同一行（标准 YAML 块序列写法）
        tmp[0] = `${pad}- ${tmp[0].slice(indent + 2)}`
        out.push(...tmp)
      }
    } else {
      out.push(`${pad}- ${scalar(item)}`)
    }
  }
}

/** 把一个 JSON 值序列化为受限 YAML 文本。 */
export function stringify(value, { header } = {}) {
  const out = []
  if (header) for (const line of String(header).split('\n')) out.push(`# ${line}`)
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    emitObject(value, 0, out)
  } else if (Array.isArray(value)) {
    emitArray(value, 0, out)
  } else {
    out.push(scalar(value))
  }
  return `${out.join('\n')}\n`
}

/* ----------------------------------------------------------------- parse */

function coercePlain(raw, line) {
  const t = raw.trim()
  if (t === '' ) return null
  if (t === 'null' || t === '~') return null
  if (t === 'true') return true
  if (t === 'false') return false
  if (/^-?\d+$/.test(t)) return Number(t)
  if (/^-?\d*\.\d+(?:[eE][-+]?\d+)?$/.test(t)) return Number(t)
  return t
}

/**
 * 块上下文的普通标量。
 *
 * 允许任意内容（**含中文**）—— 只拒绝三类会被误读成结构、或本来就是非法 YAML 的写法。
 * 早期版本用 ASCII 白名单，结果把 `reason: 修改宿主驱动…` 这类中文说明判为非法，
 * 对一个中文注释为主的 manifest 是不可接受的。
 */
function plainScalarInBlock(t, line) {
  if (/^[[\]{}"'|>&*!%@`]/.test(t)) {
    throw new YamlError(`标量以 YAML 指示符开头，需加双引号：${JSON.stringify(t)}`, line)
  }
  if (t.includes(': ')) {
    throw new YamlError(`标量含 ": "，会被误读为映射，需加双引号：${JSON.stringify(t)}`, line)
  }
  if (/\s#/.test(t)) {
    throw new YamlError(`标量含 " #"，会被误读为注释，需加双引号：${JSON.stringify(t)}`, line)
  }
  return t
}

/**
 * 流式集合 `[...]` / `{...}`。
 *
 * 为什么需要：`manifest.yaml` 是**人工编写**的文件，`resources: [a, b, c]` 这种写法
 * 自然且常见。受限子集若只认块式，会逼着人工文件写成难读的竖排。
 * 这里实现一个递归下降的小解析器，只覆盖标量、序列、映射三种节点，
 * 不支持锚点/别名/多行 —— 超出范围仍然响亮报错，不猜。
 */
function parseFlow(text, line) {
  const s = text
  let i = 0
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i += 1 }

  function parseQuoted() {
    const st = i
    i += 1
    while (i < s.length) {
      if (s[i] === '\\') { i += 2; continue }
      if (s[i] === '"') { i += 1; break }
      i += 1
    }
    try {
      return JSON.parse(s.slice(st, i))
    } catch {
      throw new YamlError('flow 集合中的字符串转义非法', line)
    }
  }

  function parseValue() {
    ws()
    if (s[i] === '[') return parseSeq()
    if (s[i] === '{') return parseMap()
    if (s[i] === '"') return parseQuoted()
    const st = i
    while (i < s.length && !',]}'.includes(s[i])) i += 1
    return coercePlain(s.slice(st, i), line)
  }

  function parseSeq() {
    i += 1 // [
    const out = []
    ws()
    if (s[i] === ']') { i += 1; return out }
    for (;;) {
      out.push(parseValue())
      ws()
      if (s[i] === ',') { i += 1; ws(); if (s[i] === ']') { i += 1; return out } continue }
      if (s[i] === ']') { i += 1; return out }
      throw new YamlError('flow 序列语法错误（期望 "," 或 "]"）', line)
    }
  }

  function parseMap() {
    i += 1 // {
    const out = {}
    ws()
    if (s[i] === '}') { i += 1; return out }
    for (;;) {
      ws()
      let key
      if (s[i] === '"') key = parseQuoted()
      else {
        const st = i
        while (i < s.length && !':,}'.includes(s[i])) i += 1
        key = s.slice(st, i).trim()
      }
      ws()
      let val = null
      if (s[i] === ':') { i += 1; val = parseValue() }
      out[key] = val
      ws()
      if (s[i] === ',') { i += 1; continue }
      if (s[i] === '}') { i += 1; return out }
      throw new YamlError('flow 映射语法错误（期望 "," 或 "}"）', line)
    }
  }

  const value = parseValue()
  ws()
  if (i < s.length) throw new YamlError(`flow 集合之后有多余内容：${JSON.stringify(s.slice(i))}`, line)
  return value
}

function parseScalar(text, line) {
  const t = text.trim()
  if (t === '') return null
  if (t.startsWith('[') || t.startsWith('{')) return parseFlow(t, line)
  if (t.startsWith('"')) {
    try {
      return JSON.parse(t)
    } catch {
      throw new YamlError(`invalid double-quoted scalar: ${t}`, line)
    }
  }
  if (t === 'null' || t === '~') return null
  if (t === 'true') return true
  if (t === 'false') return false
  if (/^-?\d+$/.test(t)) return Number(t)
  if (/^-?\d*\.\d+(?:[eE][-+]?\d+)?$/.test(t)) return Number(t)
  return plainScalarInBlock(t, line)
}

function parseObject(lines, i, indent) {
  const obj = {}
  while (i < lines.length && lines[i].indent === indent) {
    const cur = lines[i]
    const m = KEY_RE.exec(cur.content)
    if (!m) throw new YamlError(`expected "key: value", got ${JSON.stringify(cur.content)}`, cur.no)
    // m[1] = 双引号键的内容；m[2] = 裸键；m[3] = 值
    const key = unquoteKey(m[1]) ?? m[2]
    const rest = m[3]
    i += 1
    if (rest === undefined || rest === '') {
      if (i < lines.length && lines[i].indent > indent) {
        const [v, ni] = parseBlock(lines, i, lines[i].indent)
        obj[key] = v
        i = ni
      } else {
        obj[key] = null
      }
    } else {
      obj[key] = parseScalar(rest, cur.no)
    }
  }
  return [obj, i]
}

function parseArray(lines, i, indent) {
  const arr = []
  const itemIndent = indent + 2
  while (i < lines.length && lines[i].indent === indent) {
    const cur = lines[i]
    const isDash = cur.content === '-' || cur.content.startsWith('- ')
    if (!isDash) break
    const rest = cur.content === '-' ? '' : cur.content.slice(2)
    if (rest === '') {
      if (i + 1 < lines.length && lines[i + 1].indent > indent) {
        const [v, ni] = parseBlock(lines, i + 1, lines[i + 1].indent)
        arr.push(v)
        i = ni
      } else {
        arr.push(null)
        i += 1
      }
      continue
    }
    if (MAP_START_RE.test(rest)) {
      const itemLines = [{ indent: itemIndent, content: rest, no: cur.no }]
      let j = i + 1
      while (j < lines.length && lines[j].indent >= itemIndent) {
        itemLines.push(lines[j])
        j += 1
      }
      const [v] = parseObject(itemLines, 0, itemIndent)
      arr.push(v)
      i = j
      continue
    }
    arr.push(parseScalar(rest, cur.no))
    i += 1
  }
  return [arr, i]
}

function parseBlock(lines, i, indent) {
  const cur = lines[i]
  const isArr = cur.content === '-' || cur.content.startsWith('- ')
  return isArr ? parseArray(lines, i, indent) : parseObject(lines, i, indent)
}

/** 解析受限 YAML 文本。空文本返回 null。 */
export function parse(text) {
  const lines = []
  const raw = String(text).split(/\r?\n/)
  for (let n = 0; n < raw.length; n += 1) {
    const l = raw[n]
    if (l.trim() === '') continue
    if (/^[ ]*#/.test(l)) continue
    if (/^\t/.test(l)) throw new YamlError('tab indentation is not supported', n + 1)
    const indent = l.length - l.replace(/^ +/, '').length
    lines.push({ indent, content: l.slice(indent).replace(/[ ]+$/, ''), no: n + 1 })
  }
  if (lines.length === 0) return null
  const [value, end] = parseBlock(lines, 0, lines[0].indent)
  if (end !== lines.length) {
    throw new YamlError('trailing content after document', lines[end].no)
  }
  return value
}

/** 便捷：读文件解析；文件不存在返回 fallback。 */
export async function parseFile(fs, path, fallback = null) {
  try {
    return parse(await fs.readFile(path, 'utf8'))
  } catch (err) {
    if (err && err.code === 'ENOENT') return fallback
    throw err
  }
}
