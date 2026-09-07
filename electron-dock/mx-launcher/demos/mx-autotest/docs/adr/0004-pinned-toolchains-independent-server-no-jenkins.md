# ADR-0004：固定工具链、独立服务，初期不依赖 Jenkins

状态：提议  
日期：2026-09-07

## 背景

Electron 桌面可以解决浏览器应用无法可靠下载工具、访问本地制品和控制桌面环境的问题，但若把 Cypress、Playwright 浏览器、Python、k6 全部打入安装包，发布体积和流量会失控。若每次 Run 从官方重新下载，又会受网络抖动影响且无法复现。

同时，mx-base 已为未来共享设施保留位置，但目前的需求只是 manual / once / cron、能力匹配、运行受控入口和收集结果。Jenkins 对首轮闭环没有不可替代能力。

## 决策

1. Desktop Runner 使用官方固定版本 Toolchain Manifest。
2. manifest 包含具体版本、OS、arch、官方 URL、sha256 / signature 和兼容范围；禁止 latest。
3. 首次使用下载并校验，随后放入内容寻址缓存。
4. mx-auto-server 只分发小型 manifest；内网镜像是 digest 相同的可选兜底，不是默认大文件热路径。
5. K8s runner 使用固定 image digest 和预装浏览器；不在每个 Run 重复下载安装。
6. mx-auto-server 使用独立 K8s workload、PostgreSQL 和 artifact store，不嵌入 mx-launcher。
7. 初期由 Node / TypeScript 实现有限 Task 调度与 K8s Job 派发，不依赖 Jenkins。
8. 不在 mx-auto-server 内实现通用多阶段流水线 DSL。

## 理由

- Electron 主包保持可接受体积；
- 相同 digest 只下载一次；
- 历史 Run 可还原工具链；
- 官方来源和摘要降低定制二进制供应链责任；
- K8s 镜像让 server runner 启动稳定；
- 不为简单任务承担 Jenkins controller、插件、凭据和运维成本；
- 独立服务避免测试负载进入 MX-H2I 登录故障域。

## 后果

- 需要工具批准、缓存锁、容量和清理机制；
- 首次运行仍可能下载较大内容，UI 必须预估大小并允许预热；
- 离线环境要维护受控 mirror 和 digest 对账；
- Playwright 与 Electron 兼容性需要版本矩阵和 spike；
- Node / TypeScript 调度器必须刻意限制范围；
- 当规模或工作流复杂度超过边界时，需要接入成熟 provider。

## 重新评估 Jenkins / Workflow Engine 的条件

满足任一条件时重新评估：

1. 需要跨阶段 fan-out / fan-in 和汇聚逻辑；
2. 需要人工审批门；
3. 超过三个团队独立维护复杂构建流程；
4. 需要 Windows、macOS、Linux 多平台并行构建与制品晋升；
5. 企业已有成熟 CI，希望 MX Autotest 只负责 quality evidence。

引入后，外部系统是 execution provider；Project、Catalog、Suite、Task、Run 和报告仍由 MX Autotest 定义。

## 被否决方案

### 所有工具塞进 Electron

体积、更新、签名、许可和漏洞响应成本过高。

### 每个 Run 临时下载最新版

高流量、不可复现、上游波动会产生 blocked 噪声。

### 所有 runner 都从 mx-auto-server 下载大包

把控制面变成高带宽文件站，扩大单点压力。

### 为首轮启用 Jenkins

增加系统和插件面，但没有解决首轮 Cypress / Playwright 闭环中不可替代的问题。

### 自研完整 CI

偏离测试领域产品，最终得到能力更弱的 Jenkins / Argo。

## 验证要求

- 首次下载校验错误会阻断安装；
- 第二次 Run 的工具下载字节接近零；
- manifest 固定版本可回滚；
- 并发下载同一 digest 不产生重复缓存；
- K8s Job 实际 image digest 与 Run 一致；
- mx-auto-server deploy 不滚动 launcher；
- bounded scheduler 不重复触发同一 idempotency key；
- 达到重新评估条件前，Jenkins 保持非依赖状态。
