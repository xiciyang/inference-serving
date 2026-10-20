---
name: model-migration
description: 当需要把模型 checkpoint 跨平台或跨格式迁移到目标推理后端时使用（例如量化格式不被目标后端支持、张量命名不一致、需要转换后再部署）。给出探测、转换、验证、登记的标准流程与排错路径。
---

# 模型迁移适配（inference-serving 内置能力）

> 本 Skill 随 `inference-serving` 包分发，是**渐进式披露**的正文部分：frontmatter 常驻，
> 正文只在真的要迁移时加载。
>
> 机器的判定与计划产出由 `src/migrate.mjs` 负责（`inference-serving migrate <model>`），
> 本文件负责**人/agent 要执行的步骤与判断**。

## 什么时候需要迁移

`inference-serving migrate` 会输出 `needed: true|false`。判定依据是
`config.json` 里的 `quantization_config` / `architectures` 与目标后端支持格式的交集。

不需要迁移（直接部署即可）的常见情形：

| 源格式 | vLLM 可直接加载 |
|---|---|
| HF safetensors（dense） | ✅ |
| `compressed-tensors`（含 NVFP4/FP8） | ✅ |
| `gptq` / `awq` | ✅ |
| `bitsandbytes` | ⚠️ 部分，通常需在容器内装 `bitsandbytes` |

需要迁移的典型情形：私有量化方案、自研 attention 算子、非 HF 目录结构、张量命名与
目标后端不匹配。

## 标准流程

### 1. 探测（只读）

```bash
inference-serving migrate <MODELS_DIR>/<model>
```

产出 `migration-plan@1`：源格式、目标要求、步骤、磁盘估算、风险清单。
**这一步不改任何东西**，先看计划再决定。

同时确认目标盘空间：转换产出通常与源同量级。

```bash
df -h /data
du -sh <MODELS_DIR>/<model>
```

### 2. 转换（容器内，R2 沙箱）

原则：**绝不在宿主 Python 环境里装转换器**，一律用容器；源目录**只读挂载**，
产出写到新目录（不覆盖源）。

```bash
docker run --rm --runtime nvidia --gpus all \
  -v <MODELS_DIR>/<model>:<MODELS_DIR>/<model>:ro \
  -v <MODELS_DIR>/<model>-converted:<MODELS_DIR>/<model>-converted \
  vllm/vllm-openai:nightly \
  python3 -m <converter> --input <MODELS_DIR>/<model> --output <MODELS_DIR>/<model>-converted
```

**挂载必须是同路径**（`:ro` 与目标路径字面一致）。实测：把宿主 `<MODELS_DIR>` 挂到
容器另一个路径会让指向绝对路径的软链在容器内断掉，vLLM 报
`Repo id must be in the form 'repo_name'`。`inference-serving` 的部署路径已内置这条约束。

### 3. 验证

- 产出目录含 `config.json` 与权重文件；
- 用同尺寸的对照模型各跑一次前向，确认不是"能加载但输出是垃圾"；
- **精度对比不在本插件的职责内** —— 那属于 `@ai-infra/testing-core`（后续插件）。
  本步骤只做"能否加载 + 能否前向"的功能验证。

### 4. 登记

把产出目录作为新模型走正常部署：

```bash
inference-serving deploy <MODELS_DIR>/<model>-converted
```

部署成功后它会在 `~/.ai-infra/state/serving-registry.yaml` 里成为独立端点，
与源模型互不影响，可分别回退与拆解。

## 排错

| 现象 | 原因 | 处置 |
|---|---|---|
| `Repo id must be in the form 'repo_name'` | 容器内路径与宿主路径不一致，软链断裂 | 用**同路径**挂载；或 `readlink -f` 取真实路径后直接挂真实目录 |
| `No available memory for the cache blocks` | 统一内存被宿主/既有服务占满 | 降 `--gpu-memory-utilization` / `--max-model-len`；`inference-serving` 的降级链会自动做 |
| 转换后精度明显下降 | 量化有损 | 换更低损格式；本插件会把"用了有损档位"写进部署报告 |
| 转换中途失败留下半个目录 | — | 产出目录独立于源，直接删掉重来，源不受影响 |

## 安全边界

- 转换属 **R2（中风险）**：需容器级沙箱，走 `inference-serving migrate` 时会过
  能力清单与确认闸门；
- 源目录**只读**；不删除、不覆盖任何既有模型；
- 不做系统级变更（不装驱动、不改内核参数）；这类操作在本插件中被显式声明为"不提供"。
