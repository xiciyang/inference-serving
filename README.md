# inference-serving

**Deploy a model checkpoint as a reachable inference endpoint — and treat failure as a first-class outcome.**
Probe → backend select → (migrate) → deploy → three-stage health check → register → write shared state;
on failure auto-degrade (memory quota → concurrency → precision → port), and only then roll back.
Every step lands in a hash-chained audit log. Zero runtime dependencies (Node built-ins only).

- **One command**: `inference-serving deploy /data/models/Qwen2.5-1.5B-Instruct`
- **Idempotent**: same model + same config returns the same endpoint
- **Reversible**: `rollback` to the last verified version; `teardown` proves no process, VRAM or port is left
- **Auditable**: `~/.ai-infra/logs/audit/`, hash-chained — tampering is detectable

**Not a fit if** you want a managed cloud endpoint, or you only need `vllm serve` for a demo — this is the
operational layer around it (degrade, rollback, audit, reconcile), not a replacement for vLLM.

### 60-second check, no GPU

```bash
npm test                  # 154 tests pass on this machine (unit + integration + contract, ~5s)
inference-serving doctor  # environment probe only, read-only
```

A real `deploy` needs a GPU and a confirmation token (risk class R2); without one you can
still run the full test suite and read the plan from `deploy --help`.

把模型 checkpoint 部署成**可访问的推理端点**，并把失败当作一等公民处理：

```
输入 → 环境探测 → 后端选择 →（迁移适配）→ 部署 → 健康检查三关
     → 注册端点 → 写共享状态
     → 失败自动降级（内存配额 → 并行度 → 精度 → 端口）→ 仍失败则回滚中止
     → 全程哈希链审计
```

- **一条命令**：`inference-serving deploy /data/models/Qwen2.5-1.5B-Instruct`
- **幂等**：同一模型 + 同一配置重复调用返回同一端点，不重复创建
- **可回退**：`rollback` 回到上一个已验证版本
- **可清理**：`teardown` 后验证无残留进程、无残留显存、端口已释放
- **可审计**：所有调用写入 `~/.ai-infra/logs/audit/`，哈希链保护，删改可检出
- **零运行时依赖**：只用 Node 内建模块

---

## 安装

```bash
npm install -g inference-serving          # CLI，已发布到 npm
```

```bash
dsh plugin --profile <name> add inference-serving   # 作为 DSH 插件（bundle）
```

作为 **DSH 插件**（bundle）：

```bash
dsh plugin --profile web add /path/to/inference-serving-0.1.0.tgz
# 重启 DSH 后生效；也可用 dsh-super-injector 运行时热注入
```

运行时要求：**Node ≥ 20.11**，Linux/macOS，x64/arm64。

---

## 快速上手

```bash
inference-serving doctor                                   # 环境自检（只读）
inference-serving deploy /data/models/Qwen2.5-1.5B-Instruct
inference-serving status                                   # 含实机核对
inference-serving list
inference-serving teardown <endpoint-id> --confirm <token>
```

部署成功后会打印端点 URL、耗时、降级步数、自动补全的假设，以及审计 id。

---

## 命令

| 命令 | 说明 |
|---|---|
| `deploy <model>` | 部署为端点（幂等）。支持本地路径 / 模型 ID / URL / `env:VAR` / 已注册名 / 模糊描述 |
| `status [selector]` | 端点状态 + **实机核对**（注册表与真实载体不一致会显式报出） |
| `list [--status S]` | 列出端点 |
| `rollback <selector>` | 回退到上一个已验证版本 |
| `teardown <selector>` | 拆解并**逐项验证**无残留 |
| `migrate <model>` | 产出跨平台/跨格式迁移适配计划（只分析，不改东西） |
| `metrics` | 部署耗时、资源消耗、降级次数 |
| `audit-verify` | 校验审计哈希链完整性 |
| `reconcile [--reap]` | 孤儿载体对账（SIGKILL / 掉电后的残留；`--reap` 才真删） |
| `doctor [--deep]` | GPU / 统一内存 / Docker / 三层沙箱 / 端口池 / 策略来源 / 代理状态 |
| `install-skills [--dir]` | 把随包 SKILL.md 装到 `~/.dsh/skills/` |
| `tools` | 列出对外工具与参数 schema |

**退出码**：`0` 成功 · `1` 业务失败 · `2` 用法错误 · `3` 需要确认。

---

## MCP

本包同时提供 MCP server（stdio / streamable-http），暴露与 DSH 原生工具**完全相同**的 5 个工具：

```bash
node mcp/server.mjs                  # stdio
node mcp/server.mjs --http --port 8790   # streamable-http，POST /mcp
```

工具：`inference_serving_deploy` / `status` / `rollback` / `teardown` / `list_endpoints`
（另有运维用 `metrics` / `audit_verify` / `reconcile` / `doctor` / `migrate`）。

> DSH 在 MCP 上扮演 **client**，不会消费自家插件的 MCP server。因此 DSH 侧走原生工具注册
> （`ctx.tools.register`），MCP 侧服务**第三方客户端**；两条通道共用 `src/tools.mjs` 的同一份
> 规格与 `src/api.mjs` 的实现，不存在行为分叉。

---

## 降级链

次序：**内存配额 → 并行度 → 精度 → 端口 → 中止**。设计要点：

1. **无损在前**：配额与并行度调整不影响输出质量；精度是有损的，因此排在后面，且一旦用到，
   部署报告会显式标注 `degrade.lossy = true`。
2. **端口档正交**：端口冲突只换端口，不会白白牺牲精度。
3. **按失败原因匹配**，不是无脑顺序推进。物理上区分两类内存失败：
   - `E_INSUFFICIENT_MEMORY` —— vLLM 想申请的额度**超过宿主可给**（统一内存机型上很常见）。
     修法是**下调额度**，由「内存配额」档负责。
   - `E_MEMORY_CONFIG_INFEASIBLE` —— 额度够宿主给，但**装不下**权重 + KV。
     修法是**降低需求**（并发 / 上下文 / 精度），下调额度只会更糟。
4. **档位决策是证据驱动的**：内存配额档不是乘一个固定系数，而是拿预检算出的
   `requiredBytes / totalBytes` 反推"刚好够用"的额度（×1.35 余量）。
5. **不可降级的失败立即中止**：无 GPU、无 nvidia runtime、模型解析不了、License 待确认 ——
   重试它们只是假装在努力。

---

## 健康检查三关

`HTTP 200` 不等于模型能用。三关全过才注册端点：

| 关 | 检查 | 失败含义 |
|---|---|---|
| 1 | 载体存活（驱动 `inspect`） | 容器/进程已退出 |
| 2 | `GET /v1/models` 200 且列出请求的模型名 | 进程活着但引擎没起来 |
| 3 | **真实前向**：发一次最小推理请求并拿到 `choices` | 加载了但算不出东西 |

---

## 配置

### 策略文件（`~/.ai-infra/config/`）

首次运行自动生成，可直接编辑（受限 YAML 子集：字符串用双引号）：

| 文件 | 内容 |
|---|---|
| `risk-classification.yaml` | 风险档 R0–R6、各档所需沙箱、确认策略与 TTL、八类系统资产写白名单 |
| `network-policy.yaml` | 出口分级与域名白名单/黑名单、代理策略、License 判定规则、端口池 |
| `headless-policy.yaml` | 无人交互时的逐项降级策略（默认全部中止） |

### 插件配置（DSH 行内 `config`）

```yaml
- insert:
    - id: inference-serving
      name: 'inference-serving'
      inject: [tools]
      config:
        root: '~/.ai-infra'
        portPoolStart: 8100
        portPoolEnd: 8199
        modelRoots: ['/data/models']
        maxDegradeSteps: 4
        headless: false
```

未知配置键、类型不符、端口池倒挂都会**在加载期响亮失败**，不静默忽略。

### 每次调用的选项

`port` / `bindHost` / `gpuMemoryUtilization` / `maxModelLen` / `maxNumSeqs` /
`servedModelName` / `image` / `backend` / `confirm` / `headless` / `deepProbe`。

**可调参数不硬编码**：判据是"能否在不改代码的情况下改变它"—— 上面每一项都可以。

---

## 权限与安全

### 能力清单

`manifest.yaml` 是**白名单**：未声明的能力拒绝（`E_CAPABILITY_DENIED`），已声明能力访问
未声明的资源也拒绝（`E_RESOURCE_NOT_DECLARED`）。

| capability | risk | 声明的资源 |
|---|---|---|
| `deploy` | write | `model:read` `gpu:write` `port:bind` `state:write` `network:egress` |
| `status` | read | `state:read` |
| `rollback` | write | `state:write` `gpu:write` `port:bind` |
| `teardown` | write | `gpu:write` `port:unbind` `state:write` |
| `list_endpoints` | read | `state:read` |
| `migrate` | write | `model:read` `gpu:write` `state:write` |

`manifest.yaml` 里的 `not_provided` 显式列出**设计上不做**的事（装驱动、提权、动别人的进程），
让审计能区分"没声明所以拒绝"与"压根不做"。

### 三层沙箱

| 风险档 | 要求 | 说明 |
|---|---|---|
| R0 只读 | 无 | `status` / `list_endpoints` |
| R1 低 | 进程级 | 需要可用的 `bwrap` + 非受限用户命名空间 |
| R2 中 | **容器级** | 本插件的部署路径：由插件自己驱动容器运行时 |
| R3–R5 高 | VM 级 | 系统级变更 / 生产变更 / 高风险 |

**沙箱不可用一律拒绝**（`E_SANDBOX_UNAVAILABLE`），不静默降级到"没有沙箱"。
显式授权降级是可能的，但需要调用方主动传入，且会留痕警告。

> ⚠️ DSH 的 `ctx.sandbox` 服务**只管文件效果策略**，官方文档明确容器与 microVM
> 不是它的 provider。三层沙箱由本插件的驱动接缝自行实现（`src/drivers/`），
> 核心逻辑不认识 Docker。

### 系统资产保护

八类资产（文件系统 / 进程 / 网络 / 设备 / 内核 / 账户 / 服务 / 审计）逐项约束：

- **只操作自己创建的载体**：停止动作会校验 `inference-serving.managed=true` 标签，
  没有标签一律拒绝 —— 既有服务（如本机跑着的 `qwen3-embedding`）不可能被误删；
- 模型目录**只读挂载**，只允许新增，不覆盖不删除既有内容；
- 审计目录 `0700` / 文件 `0600`、只追加，模块里**不存在**删除或改写审计的 API。

### 确认机制

- R0 不问；R1/R2 **每类一次，24h 有效**；R3–R5 **每次都问**（且不进缓存）。
- 确认键包含**目标指纹**：同一 capability 对不同模型/环境不复用授权。
- 首次调用返回 `E_CONFIRMATION_REQUIRED` 与 `details.confirmToken`；带回该 token 才执行。
  这使"确认"成为审计里一条可追溯的事实，而不是界面上的一个弹窗。
- **顺序：能力 → 风险 → 沙箱可用性 → 确认。** 先判本机能不能做，再问用户 ——
  不该让人为一个根本执行不了的操作做确认。

### headless

无 TTY / CI 环境下默认 headless：需要确认而未获授权的操作**一律中止**
（`E_HEADLESS_NEEDS_CONFIRMATION`）。自动补全的默认值与自动选优的候选都会写进报告，
不静默。策略可通过 `headless-policy.yaml` 显式覆盖 —— 默认全 `abort`。

### 网络出口

- **不信任环境代理**：所有出网走 `node:http`（天然不读 `HTTP(S)_PROXY`）。
  本机那个代理 CONNECT 能建立但上游 TLS 必失败，信任它每次会白等 10 秒。
- 白名单直连（国内镜像）；白名单外 = `ask`（headless 下等价拒绝）；
  黑名单**根本不发连接**。
- License 判定：宽松自动继续；受限/缺失**停下确认**。

---

## 共享状态

```
~/.ai-infra/
  state/serving-registry.yaml     端点与版本历史（文件锁 + 原子写，写前留快照）
  state/confirmations.json        确认授权（TTL）
  state/metrics.json              指标
  state/history/                  注册表快照（最多 20 份）
  logs/audit/inference-serving/   审计，{date}.jsonl，哈希链
  logs/inference-serving/         结构化运行日志
  config/*.yaml                   策略
  run/inference-serving/          锁与临时文件
```

状态**不放在包内** —— npm 安装后的包目录是只读的，且升级会覆盖。

---

## 可观测性

- **结构化日志**：JSONL，阶段事件（`phase:probe` / `phase:deploy` / `phase:degrade` …）带耗时；
- **指标**：`deploy_ms_total` / `deploy_ms_max` / `degrade_steps` / `degrade.by_reason` /
  `last_gpu_memory_utilization` 等；
- **HTTP 端点**（挂载为 DSH 插件且 `webServer` 可用时）：
  `GET /api/inference-serving/status`。

---

## 健壮性

| 机制 | 做法 |
|---|---|
| 故障隔离 | `api.*` 永不抛异常，只回结构化错误；每个工具独立注册，单个失败不影响其它 |
| 超时 | 每个操作有明确超时；部署/健康检查用**墙钟**约束，不用调用次数 |
| 取消 | 全链路透传 `AbortSignal`，取消时清理已创建的资源 |
| 优雅关闭 | 卸载时排空在途操作（drain timeout），超时报告未完成数量 |
| 中断清理 | 退出钩子（exit/SIGINT/SIGTERM/uncaughtException）+ `reconcile` 兜住 SIGKILL |
| 可回退 | 每次写注册表前留快照；部署失败回收载体并验证端口释放 |

---

## 与 DSH 插件契约的一处刻意偏离

官方要求插件配置使用 Schemastery `Schema<Config>`。本包是**零运行时依赖**包，为不引入
`@deepseek-ai/schemastery` 硬依赖，改为手写校验并在非法配置时**加载期直接抛错**（语义等价：
非法配置响亮失败），可调参数则全部外置到策略文件与调用选项。

其余契约逐条遵守：`name` + `apply` + `inject`；一切注册走 `ctx.effect()`；
只硬依赖 `tools`，`webServer` 用 `ctx.get()` 可选取用（headless profile 也能挂载）。

---

## 开发

```bash
npm test              # 单元 + 集成（131 个用例，不需要 GPU/Docker）
npm run test:unit
npm run test:integration
npm run check         # 包规范自检
npm run demo          # 真机端到端演示（需要 Docker + NVIDIA GPU）
```

集成测试用 `tests/helpers/` 里的**测试后端 + spawn 驱动**跑完整闭环，
不依赖 GPU 与 Docker —— 这同时是"软硬件解耦"的验收证据。

## License

MIT

## 兼容性

| 项 | 范围 |
|---|---|
| Node.js | >= 20.11 |
| DSH | `engines.dsh: ">=0.2.0 <0.3.0"`，已在 **0.2.0-rc.2** 上验证 |
| 操作系统 | Linux / macOS（x64 / arm64）；Windows 未验证 |
| 运行时依赖 | 零（只用 Node 内建模块与外部容器运行时） |
| 容器后端 | Docker 或 Podman（部署真实端点时需要；单元测试不需要） |

跨包契约套件（`inference-contracts`）属于本机 monorepo 的内部闸门：单独 clone 本仓库时
`npm run test:contract` 会明确跳过，不会伪装成通过。

## 许可

MIT，见 [LICENSE](./LICENSE)。
