/**
 * 工具定义（MCP 工具 + DSH 原生工具**共用同一份规格**）。
 *
 * 这是"两条通道共享实现"的落点（RISK_CLASSIFICATION_DRAFT.md §7 第 3 项，已确认选项 ③）：
 *   - DSH 侧：index.mjs 把每个 spec 的 parameters/output 直接交给 ctx.tools.register()
 *   - MCP 侧：mcp/server.mjs 把同一份 parameters 作为 inputSchema 暴露
 * 语义只有一份，不存在"原生工具和 MCP 工具行为不一致"。
 *
 * 参数 schema 只用 DSH 强制 JSON Schema 子集允许的关键字
 * （type/properties/required/additionalProperties/items/enum/const/oneOf）。
 */
import * as api from './api.mjs'

const CONFIRM_PARAM = {
  type: 'string',
  description: '确认令牌。首次调用若需确认会返回 E_CONFIRMATION_REQUIRED 并在 details.confirmToken 给出该值；把原值回传即可执行。24h 内同类操作（同 capability + 同目标）不再询问；高风险档（R3–R5）每次都需确认。',
}

const ROOT_PARAM = {
  type: 'string',
  description: '共享状态根目录。默认 ~/.ai-infra，也可用环境变量 INFERENCE_SERVING_ROOT 覆盖。',
}

function passthroughOutput() {
  return {
    schema: { type: 'object', additionalProperties: true },
    render(_args, value) {
      return [{ type: 'text', text: JSON.stringify(value ?? null, null, 2) }]
    },
  }
}

export const TOOL_SPECS = [
  {
    name: 'inference_serving_deploy',
    description:
      '把模型 checkpoint 部署为可访问的推理端点：探测环境 → 选择后端（默认 NVIDIA+vLLM）→ 迁移适配（如需）→ 容器化部署 → 三关健康检查（容器存活 / 端点响应 / 真实前向）→ 注册端点 → 写共享状态。失败会自动沿降级链重试（内存配额 → 并行度 → 精度 → 端口），全程写入哈希链审计。幂等：同一模型 + 同一配置重复调用返回同一端点，不重复创建。**带租约**：返回的 ownerToken 是后续 teardown/rollback 的凭证，也是同模型后续 deploy 的续租凭证。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        model: { type: 'string', description: '模型。支持：本地路径（/data/models/xxx）、模型 ID（org/name 或目录名）、URL（hf-mirror.com / modelscope.cn）、环境变量（env:VAR）、已注册端点名、或一句话模糊描述（会列出候选让你选）。' },
        path: { type: 'string', description: '显式指定本地模型目录（与 model 二选一）。' },
        url: { type: 'string', description: '显式指定模型下载地址（仅支持 hf-mirror.com / modelscope.cn；huggingface.co 在本机不可达会被拒绝）。' },
        backend: { type: 'string', description: '后端 id，默认取环境探测推荐值（本机为 nvidia-vllm）。' },
        port: { type: 'integer', description: '端口。默认在端口池内自动挑第一个空闲端口（bind 实测）。' },
        bindHost: { type: 'string', description: '监听地址。默认 127.0.0.1；改为对外地址会触发输入冲突需显式选择。' },
        gpuMemoryUtilization: { type: 'number', description: 'vLLM --gpu-memory-utilization。统一内存机型（本机 GB10）上默认 0.20，需为既有推理服务留余量。' },
        maxModelLen: { type: 'integer', description: '最大上下文长度。默认取模型 config.json 的 max_position_embeddings 并被安全上限约束。' },
        maxNumSeqs: { type: 'integer', description: '最大并发序列数，默认 32。' },
        servedModelName: { type: 'string', description: '对外暴露的模型名，默认取模型目录名归一化。' },
        image: { type: 'string', description: '容器镜像，默认 vllm/vllm-openai:nightly（本机已存在，秒起）。' },
        owner: { type: 'string', description: '端点租用方（用途标签），例如 inference-quantization / inference-tuning。同一次运行内多次 deploy 同一模型必须带**同一个 ownerToken**，否则会被 E_ENDPOINT_LEASED 拒绝。' },
        ownerToken: { type: 'string', description: '续租用的凭证：首次 deploy 的返回值里给出。同一次运行内第二次 deploy 带上它才能落在同一端点的新 revision 上。' },
        purpose: { type: 'string', description: '租用用途的自由文本，写进租约便于排查"谁占着这个端点"。' },
        leaseMs: { type: 'integer', description: '租期（毫秒），默认 1 小时。租期内同一模型只有本 ownerToken 能 deploy；到期后可被接管。' },
        confirm: CONFIRM_PARAM,
        headless: { type: 'boolean', description: '强制 headless 语义（需确认的操作一律中止）。不传则自动探测（无 TTY / CI 视为 headless）。' },
        deepProbe: { type: 'boolean', description: '是否用 torch 深度校准内存视图（较慢，默认 false）。' },
        root: ROOT_PARAM,
      },
    },
    ...passthroughOutput(),
    async handler(args) {
      const { root, headless, deepProbe, confirm, ...rest } = args ?? {}
      return api.deploy(rest, { root, options: { headless }, confirm: confirm ?? null, deepProbe: deepProbe === true })
    },
  },

  {
    name: 'inference_serving_status',
    description:
      '查询端点状态。不只回注册表内容，还会用 docker inspect 做**实机核对**：注册表说在跑但容器没了（或反之）会显式报出不一致，而不是只复述注册表。deep=true 时额外跑一次实时健康探测。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        selector: { type: 'string', description: '要查的端点。可用：端点 id、幂等键、模型路径、served-model-name、端点 URL、容器名。省略则返回全部。' },
        verify: { type: 'boolean', description: '是否做实机核对，默认 true。' },
        deep: { type: 'boolean', description: '是否跑实时健康探测，默认 false。' },
        root: ROOT_PARAM,
      },
    },
    ...passthroughOutput(),
    async handler(args) {
      const { root, ...rest } = args ?? {}
      return api.status(rest, { root })
    },
  },

  {
    name: 'inference_serving_rollback',
    description:
      '把端点回退到**上一个已验证**的版本：停掉当前实例，按历史 revision 的配置重新走完整部署闭环。没有可回退的历史时返回 E_NO_ROLLBACK_TARGET（显式报错，不静默成功）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['selector'],
      properties: {
        selector: { type: 'string', description: '要回退的端点（id / 模型路径 / 端点 URL / served-model-name）。' },
        ownerToken: { type: 'string', description: '端点所有权凭证（deploy 的返回值）。回退同样是就地变更，所以要过同一道所有权闸。' },
        confirm: CONFIRM_PARAM,
        root: ROOT_PARAM,
      },
    },
    ...passthroughOutput(),
    async handler(args) {
      const { root, ...rest } = args ?? {}
      return api.rollback(rest, { root })
    },
  },

  {
    name: 'inference_serving_teardown',
    description:
      '拆解端点：停止并删除容器、释放端口与显存。只删除带 inference-serving.managed=true 标签的容器（保护本机既有服务）。完成后**验证**无残留并回报逐项检查结果。幂等：重复调用安全。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['selector'],
      properties: {
        selector: { type: 'string', description: '要拆解的端点（id / 模型路径 / 端点 URL / served-model-name）。' },
        ownerToken: { type: 'string', description: '端点所有权凭证（deploy 的返回值）。不带或对不上时，若该端点正被他人租用则返回 E_ENDPOINT_NOT_OWNED —— 这条闸防止一个插件拆掉另一个插件正在用的端点。' },
        confirm: CONFIRM_PARAM,
        root: ROOT_PARAM,
      },
    },
    ...passthroughOutput(),
    async handler(args) {
      const { root, ...rest } = args ?? {}
      return api.teardown(rest, { root })
    },
  },

  {
    name: 'inference_serving_list_endpoints',
    description: '列出已注册的推理端点（按状态过滤可选）。只读。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { type: 'string', enum: ['serving', 'degraded', 'stopped', 'failed', 'torn_down'], description: '只列出该状态的端点。' },
        root: ROOT_PARAM,
      },
    },
    ...passthroughOutput(),
    async handler(args) {
      const { root, ...rest } = args ?? {}
      return api.listEndpoints(rest, { root })
    },
  },
]

/** 非 MCP 面向的运维工具（CLI/内部使用，也可作为 DSH 工具注册）。 */
export const ADMIN_TOOL_SPECS = [
  { name: 'inference_serving_metrics', description: '读取指标（部署耗时、资源消耗、降级次数）。', parameters: { type: 'object', additionalProperties: false, properties: { root: ROOT_PARAM } }, ...passthroughOutput(), handler: (a) => api.metrics({ root: a?.root }) },
  { name: 'inference_serving_audit_verify', description: '校验审计日志哈希链完整性（检出任何删改）。', parameters: { type: 'object', additionalProperties: false, properties: { root: ROOT_PARAM } }, ...passthroughOutput(), handler: (a) => api.auditVerify({ root: a?.root }) },
  { name: 'inference_serving_reconcile', description: '对账并清理孤儿容器（SIGKILL/掉电后的残留）。默认只报告。', parameters: { type: 'object', additionalProperties: false, properties: { reap: { type: 'boolean' }, confirm: CONFIRM_PARAM, root: ROOT_PARAM } }, ...passthroughOutput(), handler: (a) => api.reconcile({ reap: a?.reap === true, root: a?.root, options: { confirm: a?.confirm } }) },
  { name: 'inference_serving_doctor', description: '环境与能力自检：GPU / 统一内存 / Docker / nvidia runtime / 沙箱三层 / 端口池 / 策略来源 / 代理状态。只读。', parameters: { type: 'object', additionalProperties: false, properties: { deep: { type: 'boolean' }, root: ROOT_PARAM } }, ...passthroughOutput(), handler: (a) => api.doctor({ deep: a?.deep === true, root: a?.root }) },
  { name: 'inference_serving_migrate', description: '为跨平台/跨格式部署产出迁移适配计划（只分析，不改东西）；execution 为容器内执行通道。', parameters: { type: 'object', additionalProperties: false, required: ['model'], properties: { model: { type: 'string' }, target: { type: 'string' }, confirm: CONFIRM_PARAM, root: ROOT_PARAM } }, ...passthroughOutput(), handler: (a) => api.migrate({ model: a?.model, target: a?.target }, { root: a?.root, options: { confirm: a?.confirm } }) },
]

export const ALL_TOOL_SPECS = [...TOOL_SPECS, ...ADMIN_TOOL_SPECS]

export function findToolSpec(name) {
  return ALL_TOOL_SPECS.find((t) => t.name === name) ?? null
}

/** DSH `ctx.tools.register()` 需要的形状（无 handler 字段，execute 单独给）。 */
/**
 * 把工具返回值规整成**无损 JSON**（树，不是 DAG）。
 *
 * ## 为什么适配层必须做这件事
 *
 * DSH 的工具契约要求返回值可被无损快照；它比 `JSON.stringify` **更严**：
 * 共享引用（同一个对象被两处引用）、数组里的 `undefined`、函数、非有限数
 * 都会被判为 `value is not lossless JSON`。
 *
 * 真机事故：`inference_serving_doctor` 的输出里 `environment.container.runtimes`
 * 与 `warnings[0].details` 是**共享引用** —— 于是工具一被调用就报
 * `tool "inference_serving_doctor" returned invalid output: value is not lossless JSON`。
 *
 * 这个缺陷**此前被另一个缺陷掩盖了**：那三个包的注册当时因为缺 `output.render`
 * 全部失败，工具**根本不存在**，自然没人调用、也没人发现输出不可序列化。
 * （"装了 ≠ 生效"的又一层：**注册成功 ≠ 调用成功**。）
 *
 * 修在适配层而不是逐个 doctor：这是**契约边界**的责任 —— 任何工具的返回值
 * 都必须过这一关，新增工具自动受保护。
 */
export function toLosslessJson(value) {
  if (value === undefined) return null
  try {
    // JSON 往返同时做了三件事：DAG → 树、丢掉 undefined、拒绝真循环/函数/BigInt
    return JSON.parse(JSON.stringify(value))
  } catch (e) {
    return {
      ok: false,
      code: 'E_OUTPUT_NOT_SERIALIZABLE',
      message: `工具返回值无法序列化为无损 JSON：${String(e?.message ?? e).slice(0, 200)}`,
      remediation: '这是本包输出构造的问题（常见于循环引用或 BigInt）；请报告该工具名与入参。',
    }
  }
}

export function toDshTool(spec) {
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    // DSH 的工具契约要求 output 同时给出 `schema` **与** `render`。
    // 只给 schema 会让 loader 抛 `must declare output { schema, render, … }`；
    // 而本包的注册被 try/catch 包着 → 失败被**吞掉** → 插件"挂上了"但工具一个都没有。
    // 真机实测：这条静默失败正是"装了 ≠ 生效"的典型（见 inference-contracts 的 C9）。
    output: spec.output ?? {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) { return [{ type: 'text', text: JSON.stringify(value ?? null, null, 2) }] },
    },
    async execute(args, exec) {
      if (exec?.signal?.aborted) {
        return { ok: false, code: 'E_CANCELLED', message: '调用已取消', remediation: '重新发起调用。' }
      }
      return toLosslessJson(await spec.handler(args ?? {}, exec))
    },
  }
}
