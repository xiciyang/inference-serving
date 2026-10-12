# inference-serving 端到端演示（真机）

- 时间：2026-09-23T14:39:04.834Z
- 模型：`/data/models/Qwen2.5-1.5B-Instruct`
- 总耗时：313.6s
- 快速模式：false

## 步骤

| 步骤 | 结果 | 耗时 | 摘要 |
|---|---|---:|---|
| reset（清理此前遗留的端点与孤儿载体） | ✅ | 0.1s | `{"torn":[],"reaped":0,"archived":"/home/xiciyang/.ai-infra/state/serving-registry.yaml.bak-demo-1790174031263","warnings":0}` |
| doctor：环境与能力自检 | ✅ | 0.3s | `{"ok":true,"version":{"package":"0.1.0","mcp":"1.0.0","cli":"1.0.0"},"manifest":{"name":"inference-serving","capabilities":["deploy","status","rollback","teardown","list_endpoints","migrate"],"notProvided":["install_driv` |
| deploy（故意把内存额度设为 0.95，触发自动降级） | ✅ | 103.5s | `{"ok":true,"reused":false,"endpoint":{"id":"ep_e9a06a8d72","key":"eb77ea9fe965f69b","model":"/data/models/ms_cache/models/Qwen--Qwen2.5-1.5B-Instruct/snapshots/master","backend":"nvidia-vllm","status":"serving","endpoint` |
| deploy 第二次（原样重放，幂等验证） | ✅ | 0.0s | `{"ok":true,"reused":true,"endpoint":{"id":"ep_e9a06a8d72","key":"eb77ea9fe965f69b","model":"/data/models/ms_cache/models/Qwen--Qwen2.5-1.5B-Instruct/snapshots/master","backend":"nvidia-vllm","status":"serving","endpoint"` |
| 端点外部可达性 + 真实前向推理 | ✅ | 0.1s | `{"modelsStatus":200,"forwardStatus":200,"generated":"!!!!!","warnings":0}` |
| 故障隔离：一次失败不影响后续调用 | ✅ | 0.0s | `{"failedCode":"E_MODEL_UNRESOLVED","endpointsStillListed":1,"warnings":0}` |
| deploy 用不同配置（产生 revision 2，为回退做准备） | ✅ | 104.6s | `{"ok":true,"reused":false,"endpoint":{"id":"ep_e9a06a8d72","key":"eb77ea9fe965f69b","model":"/data/models/ms_cache/models/Qwen--Qwen2.5-1.5B-Instruct/snapshots/master","backend":"nvidia-vllm","status":"serving","endpoint` |
| rollback（回退到上一个已验证版本） | ✅ | 103.9s | `{"ok":true,"rolledBackTo":1,"endpoint":{"id":"ep_e9a06a8d72","key":"eb77ea9fe965f69b","model":"/data/models/ms_cache/models/Qwen--Qwen2.5-1.5B-Instruct/snapshots/master","backend":"nvidia-vllm","status":"serving","endpoi` |
| status（含实机核对） | ✅ | 0.1s | `{"ok":true,"registry":{"file":"/home/xiciyang/.ai-infra/state/serving-registry.yaml","version":1,"updatedAt":"2026-09-23T14:39:03.738Z","endpointCount":1,"liveCount":1},"endpoints":[{"id":"ep_e9a06a8d72","key":"eb77ea9fe` |
| teardown（拆解 + 逐项验证无残留） | ✅ | 1.0s | `{"ok":true,"endpoint":{"id":"ep_e9a06a8d72","model":"/data/models/ms_cache/models/Qwen--Qwen2.5-1.5B-Instruct/snapshots/master","status":"torn_down"},"cleanupResults":[{"rev":1,"containerName":"inference-serving-e9a06a8d` |
| audit-verify（哈希链完整性） | ✅ | 0.0s | `{"ok":true,"files":["2026-09-23.jsonl"],"verification":{"ok":true,"count":233,"brokenAt":null,"reason":null,"head":"9527ed0c5682"},"auditDir":"/home/xiciyang/.ai-infra/logs/audit/inference-serving","auditId":"aud_41ef7fb` |
| metrics（耗时 / 资源 / 降级次数） | ✅ | 0.0s | `{"ok":true,"metrics":{"version":1,"counters":{"deploy_attempts":32,"deploy_success":17,"deploy_failed":15,"degrade_steps":15,"rollback":5,"teardown":4,"health_checks":17,"health_failures":0,"confirmations_granted":5,"san` |
| reconcile（孤儿载体对账，只读） | ✅ | 0.0s | `{"ok":true,"orphans":[],"reaped":[],"managed":[],"auditId":"aud_1008d5ad6701","auditSeq":237,"riskClass":"R0","sandboxTier":"none","warnings":0}` |

## 结论要点

- 沙箱三层实测：进程级 不可用（bwrap 探测失败: bwrap: setting up uid map: Permission denied）；容器级 可用；VM 级 不可用（无 VM 级沙箱可用（缺失：qemu-system-x86_64, qemu-system-aarch64, firecracker, cloud-hypervisor, virsh, kata-runtime, runsc, systemd-nspawn；/dev/kvm=存在但无消费者））。
- 降级链实测：从 gpuMemoryUtilization=0.95 自动降到 0.13，共 2 次尝试（baseline → memory-quota）。
- 回退实测：从 revision 2 回退到 revision 1。
- 清理验证：containers-removed=pass，port-released=pass，no-managed-residual=pass。

