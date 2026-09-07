# ADR-0001：Standalone、Internal 真相源与登录隔离

状态：提议  
日期：2026-09-07

## 背景

HDO V1 以 Domestic 为中心，用户和 DNS 等能力也在那里；MX-H2I V2 以 Internal 为操作面，配置由 Internal 管理。MX Autotest 是新的 standalone launcher 应用，需要复用 launcher 的通用账号与网络能力，但不能成为 MX-H2I 必须启动的附属页，也不能扩大其登录故障半径。

测试任务还会带来高频写入、浏览器 CPU、视频磁盘和工具下载。把这些工作负载放进 mx-launcher 服务或共享数据库，会让测试噪声进入用户登录关键路径。

## 决策

1. mx-autotest 注册为 standalone launcher 应用。MX-H2I 未运行时可独立启动；两者可同时运行。
2. Internal 是应用注册、身份、策略和组织配置的唯一操作面与真相源。Domestic 不成为 MX Autotest 配置权威，本地只允许带版本和期限的缓存。
3. 人员身份复用 mx-launcher 的稳定 token / introspection 合同，使用专用 audience mx-autotest。
4. mx-auto-server 维护 Project 级授权，不复制账号和口令。launcher 回答身份，mx-auto-server 回答本产品权限。
5. runner 使用 runner token 与单次 Run token，不复用人员 token。
6. mx-auto-server 在 electron-dock 下独立部署：独立 namespace、PostgreSQL、PVC / artifact store、Secret、ServiceAccount、migration Job 和生命周期脚本。
7. 可以使用同一 K8s 集群的通用 ingress、DNS 等基础能力，但不得共享 launcher 数据库、PVC、应用 Secret、hostNetwork、hostPort 或 Docker socket。
8. mx-auto-server 的 deploy、migrate、down 和 clean 不能写入或 rollout mx-launcher、Domestic、DNS、WireGuard 或 MX-H2I 工作负载。
9. 每次候选部署必须执行 MX-H2I 登录和基础联网的部署前后非回归，并核对 launcher workload 指纹。
10. Project、Suite、Task 等测试领域配置由 mx-auto-server 独立持久化，但组织级写入必须经过 Internal 授权的合同；独立持久化不等于建立第二个本地配置权威。
11. `mx-autotest` 的 enabled ProductNetwork service VIP 必须跨产品和 environment 全局唯一。Launcher 以应用层 upsert/builtin-save 预检加 PostgreSQL IPv4 CHECK、enabled-only partial unique index 闭合无效值与并发窗口；索引按 IPv4 四段数值比较，迁移发现等价别名、无效值或历史冲突时中止，不自动改写 owner。

## 理由

- 用户只维护一套组织身份；
- 测试平台可以独立安装和迭代；
- 测试 CPU、磁盘、迁移和数据库压力被隔离；
- launcher 暂不可用时，只阻止新登录和敏感操作，已认领 Run 可以继续；
- mx-auto-server 故障不会成为 MX-H2I 登录的同步依赖；
- V2 的配置方向保持一致，不重新引入 Domestic 双真相。

## 后果

- MX Autotest 登录依赖 Internal 身份合同，但业务执行不需要持续 introspection；
- 需要短 TTL 正向缓存、明确的身份不可达错误和本地授权表；
- standalone 注册、协议、端口、缓存和单例必须做共存测试；
- 运维需要独立备份、迁移、容量和告警；
- 同物理集群仍可能争抢节点，需要 ResourceQuota、优先级和必要时独立 node pool；
- “不影响 MX-H2I”必须由每次部署的证据证明，不能只靠架构声明。

## 被否决方案

### 把 mx-autotest 做成 MX-H2I 内页

会要求 MX-H2I 先启动，失去独立安装与多应用共存目标，并把发布节奏绑定在一起。

### mx-auto-server 部署进 mx-launcher server

测试调度、迁移和 artifact 会进入登录控制面的故障域。

### 复用 launcher 或 insight-hub 数据库

run / case 高频写入、retention delete、vacuum 和连接池压力会影响无业务关系的系统。

### 自建第二套账号

重复身份、离职回收和 MFA，且破坏 launcher 一致体验。

### 仅信任网关 header

网络准入不是项目授权，无法支持 app / Project 级角色。

## 验证要求

本 ADR 只有在以下证据齐全后可改为“已接受并验证”：

- standalone 独立启动与登录；
- MX-H2I 同时运行无冲突；
- mx-auto-server K8s 资源归属检查；
- launcher workload 部署前后指纹不变；
- MX-H2I 登录和联网 smoke 前后通过；
- token / Secret 泄漏扫描；
- 目标 Launcher 数据库已应用 service VIP 唯一性 migration，且历史冲突预检通过；
- mx-auto-server 故障和 Internal 身份不可达的降级演练。
