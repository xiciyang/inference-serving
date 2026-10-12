---
name: inference-serving
description: 当需要把模型 checkpoint 部署成可访问的推理端点、查询/回退/拆解端点、或排查"部署起不来"时使用。覆盖环境探测、后端选择、降级链、健康检查三关、共享状态与审计的完整闭环。
---

# inference-serving 使用与排障

把模型变成 `http://127.0.0.1:<port>` 上可访问的端点，并在失败时自动降级、可回退、可审计。

## 三步上手

```bash
inference-serving doctor                                  # 环境自检（只读）
inference-serving deploy /data/models/Qwen2.5-1.5B-Instruct
inference-serving list                                    # 看端点
```

## 闭环做了什么

```
输入 → 标准化 → 环境探测 → 后端选择（默认 NVIDIA+vLLM）
     → 迁移适配（仅当 checkpoint 与目标后端不兼容）
     → 容器化部署 → 三关健康检查 → 注册端点 → 写共享状态
     → 失败则降级重试 → 仍失败则回滚并中止
```

**三关健康检查**（缺一不可，`200 OK` 不算健康）：

1. 容器存活（`docker inspect`）
2. 端点响应（`GET /v1/models` 200 且列出了请求的模型名）
3. **真实前向**（发一次最小补全并拿到 `choices`）

## 降级链

次序：**内存配额 → 并行度 → 精度 → 端口 → 中止**。

- 前两档是**无损**的（调配额与并发），精度档**有损**所以排在其后；
- 端口档是**正交**的：端口冲突只换端口，不会白白牺牲精度；
- 决策是**按失败原因匹配**档位，不是无脑顺序推进；
- 环境/输入类失败（无 GPU、无 nvidia runtime、模型解析不了）**不可降级**，立即中止 ——
  重试它们只是假装在努力。

部署报告里会显式写出用了哪些档位、是否有损。

## 输入可以是什么

| 形态 | 例子 |
|---|---|
| 本地路径 | `/data/models/Qwen2.5-1.5B-Instruct` |
| 模型 ID | `org/name` 或目录名 `Qwen2.5` |
| URL | `https://hf-mirror.com/<org>/<repo>`（`huggingface.co` 在本机不可达，会被拒绝并提示换镜像） |
| 环境变量 | `env:MY_MODEL` |
| 已注册名 | 端点 id 或 served-model-name |
| 模糊描述 | `那个 1.5B 的 Qwen`（会列出候选让你选；headless 下取最高分并报告） |

**冲突不静默修改**：同时给了路径和 URL、指定了池外端口、要求对外绑定 —— 都会以
`E_INPUT_CONFLICT` 停下并给出可选方案。

## 常用命令

```bash
inference-serving deploy <model> --gpu-memory-utilization 0.9   # 故意制造内存不足，观察降级链
inference-serving status [selector] --deep                      # 实机核对 + 实时健康探测
inference-serving rollback <selector> --confirm <token>         # 回退到上一个已验证版本
inference-serving teardown <selector> --confirm <token>         # 拆解并验证无残留
inference-serving audit-verify                                  # 校验审计哈希链（能查出删改）
inference-serving reconcile                                     # 对账孤儿容器（--reap 才真删）
inference-serving metrics                                       # 耗时 / 资源 / 降级次数
```

## 共享状态在哪

```
~/.ai-infra/state/serving-registry.yaml    端点与版本历史（原子写 + 文件锁）
~/.ai-infra/state/confirmations.json       确认授权（TTL 24h）
~/.ai-infra/state/metrics.json             指标
~/.ai-infra/logs/audit/inference-serving/  审计，只追加 + 哈希链
~/.ai-infra/logs/inference-serving/        结构化运行日志
~/.ai-infra/config/*.yaml                  风险分级 / 网络策略 / headless 策略
```

## 需要确认的操作

| 档 | 例子 | 策略 |
|---|---|---|
| R0 只读 | `status` / `list` | 不问 |
| R1/R2 | `deploy` / `rollback` / `teardown` / `migrate` | 每类一次，24h 内同类同目标复用 |
| R3–R5 | 系统级变更、生产变更、VM 级操作 | **每次都问**；本机无 VM 沙箱，直接拒绝 |

首次调用若需确认，会返回 `E_CONFIRMATION_REQUIRED` 并在 `details.confirmToken` 给出令牌；
把令牌回传 `--confirm <token>` 即执行。

**headless 下不做任何猜测**：需要确认而未获授权 → 中止。

## 排障

| 症状 | 先看什么 |
|---|---|
| 部署起不来 | 报告里的 `attempts[]`：`preflight` 是否通过、失败码、容器日志尾部 |
| 一直降级到最后 | `E_DEGRADE_EXHAUSTED` 的 `details.attempts`，逐个尝试的失败原因 |
| 注册表说在跑但连不上 | `status` 的 `consistency` 字段（会指出容器不存在/未运行） |
| 端口被占 | `status` 与 `doctor` 的端口池；换 `--port-pool-start/end` |
| 内存不足 | 本机是**统一内存**机型，`nvidia-smi` 不报显存；用 `doctor --deep` 看 torch 校准值 |
| 容器残留 | `reconcile`（先只报告），确认后 `reconcile --reap --confirm <token>` |
| 怀疑审计被改 | `audit-verify` —— 哈希链会指出断点位置 |

## 安全边界（本插件不做的事）

- 不装驱动、不改内核参数/GRUB、不动宿主服务与账户（`manifest.yaml` 的 `not_provided` 显式列出）；
- 不提权；
- **不删非自己管理的容器**：只删带 `inference-serving.managed=true` 标签的；
  本机既有的 `qwen3-embedding`、`xagentlab-*` 一律在保护范围外不可触及；
- 不在宿主 Python 环境里装东西（转换一律容器内）。
