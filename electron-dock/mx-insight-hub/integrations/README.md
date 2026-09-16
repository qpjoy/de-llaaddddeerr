# Hub 接入描述

此目录保存经过审核的内部规范化 manifest。它不是动态代码加载器。

- [整体方案与 195 复核](../docs/architecture/integration-slots.md)
- [Night-All-A：远程 HTTP 异步采集](night-all-a/manifest.json)
- [195：独立进程候选，尚未接入运行](market-195/manifest.json)
- [可交换的 JSON Schema](integration-slot.schema.json)（跨字段语义约束另由校验器检查）
- [Night-All-A 离线验证记录与未验收项](night-all-a/ADAPTER_VERIFICATION.json)

校验：`node scripts/check-integration-slots.mjs`。该命令不联网、不安装、不执行 adapter。
供应方原有 `manifest.yaml / adapter / ADAPTER_VERIFICATION.json / README` 保留；
Hub 的 JSON manifest 描述经收窄的能力和部署引用，必须与原声明差异一起审核。

新增平台按整体方案的登记、离线、部署、联网、映射、启用六阶段验收。
不能仅把 `activation` 改为 implemented_optional 就获得执行能力；真正运行绑定由代码和部署配置管理。
