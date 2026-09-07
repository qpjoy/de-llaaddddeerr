# 06 · 低流量与运维

> 状态：提议。默认值需要通过首轮真实 Run 测量后调整；本文给出可检查的预算和降级方向。

## 目标

MX Autotest 采用 Electron，是为了让需要桌面、文件系统、工具安装和本机网络的测试可以在受控客户端执行，不是为了把浏览器页面变成持续下载大文件的通道。

低流量设计遵循：

1. 控制消息小而可恢复；
2. 大文件在完成后分片传输，不直播；
3. 相同源码、工具和 artifact 按 digest 复用；
4. 空闲状态接近零流量；
5. server、runner 和被测系统各自有配额；
6. 测试流量不能争抢 MX-H2I 身份和联网控制面的资源。

## 流量分层

| 层 | 数据 | 策略 |
| --- | --- | --- |
| 配置 | Project、Suite、Task、Catalog | ETag / version，按需增量读取 |
| 调度 | claim、lease、heartbeat、cancel | 小 JSON、游标、抖动与退避 |
| 进度 | step、状态、少量结构化日志 | 批量、限速、可丢失提示 |
| 结果 | JUnit、sidecar、manifest | 完成时上传，体积小 |
| 证据 | video、trace、screenshot、HTML | digest、分片、断点、保留策略 |
| 工具 | browser、Node、Python、adapter | 首次下载、校验、内容寻址缓存 |
| 源码 | Git 和依赖 | 本地 mirror / package store，按 commit 复用 |

## UI 通信

### 普通页面

- Project、Task、历史 Run 使用普通 REST；
- 支持 ETag / If-None-Match 和分页；
- 页面不可见时停止自动刷新；
- 搜索和筛选做 debounce；
- artifact 列表只读 manifest，不预取视频或 trace；
- 用户点击播放 / 打开时才拉取大文件，并支持 HTTP Range。

### 进行中 Run

只在用户打开进行中 Run 页面时建立一个 Server-Sent Events 连接：

- 单向事件符合“server 告诉 UI 进度”的需求；
- 通过 cursor / Last-Event-ID 恢复；
- 15 秒左右的注释 heartbeat 用于代理保活，不携带业务 payload；
- Run 终态、页面隐藏或离开页面后立即关闭；
- SSE 不可用时退化为带游标的低频 REST，不丢最终结果；
- 不为列表页上的每个 Run 建一条连接。

长连接本身不等于大流量，但网络中断和代理兼容性可能有问题，所以它必须是可替换的展示优化，而不是任务正确性的唯一通道。

## Runner 调度

Desktop Runner 的网络循环运行在受控 native / main 侧，不依赖 renderer 页面常开。

建议默认：

- 首次上线立即 register / heartbeat；
- 空闲 claim 使用 15 秒起步并带随机抖动，长期无任务时逐步退避到 60 秒；
- 有活跃租约时约 60 秒 heartbeat；
- server 可在响应中下发 nextPollAfter，不让所有 runner 同时敲服务；
- 网络失败使用指数退避和上限；
- run token 终结立即失效；
- claim 响应只包含当前任务必要配置。

未来可以用 20–30 秒 bounded long-poll 降低空请求，但必须保留普通 polling fallback。WebSocket 不是首版要求。

K8s server runner 由 mx-auto-server 创建 Job，不需要每个 Pod 长期 polling。Job 状态由 server reconcile，进程回调只是增强信号，不能是唯一完成依据。

## 事件与日志

- adapter 在内存中批量事件；
- 最多每秒提交一次；
- 单批建议不超过 200 个事件和限定字节数；
- server 为每个 Run 设置事件总量上限；
- 重复 step 用计数或采样合并；
- error、URL 和 console 在 runner 与 server 两次脱敏；
- 原始大日志按块写 artifact，不塞进事件表；
- UI 实时展示只保留尾部窗口，并明确“完整日志在 Run 完成后可用”；
- 事件队列满时可丢低优先级 debug，但不得丢状态转换和最终 JUnit。

日志压缩适合文本；MP4、ZIP trace、PNG 等已经压缩的格式不要重复压缩浪费 CPU。

## 不直播视频

Cypress / Playwright 的视频在本地或 Job 内完成录制：

1. Run 期间只发送阶段、case 和 step 元数据；
2. 录制结束后关闭文件；
3. 计算 sha256 和大小；
4. 根据 artifact policy 判断是否上传；
5. 用分片 / 断点协议传输；
6. 报告在对象完成校验后才展示播放入口。

review-video 必须人工触发。高频 cron 默认不运行慢速完整视频轨。

## 大文件上传

建议协议：

1. Runner 先提交 artifact manifest；
2. server 根据 digest 返回 already-present 或 upload session；
3. Runner 按固定块大小上传并携带 chunk digest；
4. 中断后查询已确认块；
5. 完成时 server 校验总长度与总 digest；
6. 原子发布 artifact；
7. 临时块在短 TTL 后清理。

服务端可以在初期把对象落到独立 PVC，接口仍按对象 / digest 设计，以便未来切换 MinIO / S3 而不修改 runner 合同。

首版如果只有整文件 PUT，必须：

- 配单文件大小上限；
- 上传前告诉用户预计流量；
- 中断明确标记可重试；
- 不自动无限重传；
- review-video 大于上限时保留本地路径并提示手工导入。

## 下载与缓存

### 工具链

- server 只下发小型 Toolchain Manifest；
- Desktop Runner 优先从批准的官方 URL 获取一次；
- Internal mirror 只做离线兜底；
- digest 命中即复用；
- 定时任务可以在低峰期预热；
- 不因每次 Task 修改而重新下载同一浏览器。

### Git

- runner 维护按规范化 repo URL 隔离的只读 mirror；
- 每次 Run 从 mirror 创建临时 worktree 并 checkout 冻结 commit；
- fetch 只拉缺失对象；
- 私有凭据不写 remote URL；
- Run 完成删除 worktree，保留只读对象缓存；
- 不可信仓库之间不共享可写工作目录。

### 包依赖

- pnpm store、npm cache、pip wheel cache 可以按用户 / runner 共享；
- install 必须使用 lockfile 和冻结模式；
- 缓存未命中是性能变化，不得改变依赖解析结果；
- 不允许 pnpm 失败后切换 npm；
- K8s 热路径优先使用预构建固定 digest 镜像。

## 调度与资源预算

V0 已落实的全局硬默认值是：K8s server Run 并发 1、Runner CPU 上限 2 核、memory
上限 8Gi、ephemeral-storage 上限 14Gi；workspace 与 artifact staging 分别是 10Gi
和 2Gi 的 per-Run emptyDir。Runner 不挂持久化 artifact PVC，只通过受 run token
约束的 API 上传。服务端再执行单文件 512Mi、单 Run 2Gi/1000 文件、全平台 20Gi /
100000 个文件或目录条目，以及宿主文件系统保留 5Gi / 10000 inode 的限制；零字节
文件、深层空目录与失败 staging 都不能绕过预算。`hostPath` PV 声明的 50Gi 不是实际
磁盘配额；部署到生产前仍须换 CSI/独立分区并监控字节和 inode 水位。

每个 Project / Suite 至少配置：

- 最大并发 Run；
- 最大 shard 数；
- 单 Run timeout；
- CPU / memory request 和 limit；
- ephemeral storage limit；
- 每日视频字节预算；
- artifact retention；
- 外网下载预算；
- target rate limit。

全局还需要：

- namespace ResourceQuota；
- runner Job LimitRange；
- server 与 PostgreSQL 的保留资源；
- artifact soft / hard watermark；
- 每个 target host 的并发上限；
- review-video 的人工触发权限；
- k6 等压力任务的审批与独立网络窗口。

压力测试默认不能指向未批准的生产目标。tshark 等抓包工具未来若接入，必须使用专用 runner、最小 capability、时间和大小上限，并通过安全评审；不向普通 Job 授予 NET_ADMIN 或 hostNetwork。

## K8s 故障域

mx-auto-server 使用独立 namespace、PostgreSQL、PVC、Secret、ServiceAccount 和 NetworkPolicy。

要求：

- 不共用 launcher 数据库实例；
- 不挂 launcher / Domestic PVC；
- 不挂 Docker socket；
- 不使用 hostNetwork / hostPort；
- runner Job 不能读取 mx-auto-server Secret；
- server SA 只管理带指定 label 的本 namespace Job；
- 生产条件允许时把高 CPU / IO runner 调度到独立 node pool；
- 单节点环境至少用 quota 和优先级保护 launcher 控制面；
- artifact 水位高时先禁止新视频，不让磁盘写满扩散。

## 一命令运维

目标命令语义：

| 命令 | 作用 |
| --- | --- |
| plan / preflight | 只读检查配置、端口、容量、集群和身份依赖 |
| deploy | 构建 / 导入镜像、应用资源、迁移、rollout、verify |
| migrate | 单独运行 migration Job |
| verify | API、DB、artifact、runner、身份和非回归 smoke |
| status | workload、migration、queue、storage、runner 摘要 |
| logs | server / migration / runner 定向日志 |
| clean | 按 retention 回收 artifact 和临时对象，保留 Run 索引 |
| down | 停止计算 workload，默认保留 DB / PVC / Secret |

脚本必须：

- 可重复执行；
- 使用部署锁；
- 在 migration 失败时停止；
- 输出实际 image digest；
- 不调用 mx-launcher rollout；
- 不修改 MX-H2I 相关资源；
- 对 destructive data purge 使用独立命令与确认。

## Migration

- SQL migration 进入 Git；
- 已应用文件不可修改；
- 记录 checksum；
- 使用 advisory lock 防止并发迁移；
- 每个 migration 有明确事务边界；
- K8s 由一次性 migration Job 执行，成功后才滚动 API；
- 本地 compose 也优先使用显式 migrate service；
- migration 不连接 launcher、insight-hub 或 electron-server 数据库。

## 可观测性

平台自身最少暴露：

| 指标 | 用途 |
| --- | --- |
| API latency / errors | 控制面健康 |
| queue depth / age | 调度积压 |
| runner online / claim latency | 执行容量 |
| blocked reasons | 环境质量 |
| event and upload bytes | 流量预算 |
| cache hit ratio | 下载节省 |
| artifact bytes / watermark | 存储风险 |
| migration status | 部署安全 |
| OAuth/introspection calls / cache hit / dedupe / rate-limited | 登录依赖流量、错误凭据与 unique-token 洪泛 |

日志必须带 requestId、runId、projectId 等可检索上下文，但不带 token 和 Secret。

## MX-H2I 非回归保护

每次部署候选至少做：

1. 记录 launcher 相关 workload 的 UID、revision、ready replicas；
2. 执行部署前 MX-H2I 登录和基础联网 smoke；
3. 仅部署 mx-auto namespace；
4. 再次记录 workload 指纹；
5. 执行部署后相同 smoke；
6. 比较身份接口延迟与错误率；
7. 将摘要附到 mx-auto-server deploy evidence。

出现以下任一情况立即判 deploy verify 失败：

- launcher workload 被意外滚动；
- 登录 smoke 失败；
- mx-auto-server Secret 或 migration 指向 launcher 数据库；
- 测试 Job 抢占导致身份控制面不可用；
- DNS、路由或 WireGuard 配置被脚本写入。

失败后的动作是停止 mx-auto-server rollout、保留诊断和恢复自身 workload，不操作 launcher 数据库来“修复”。

## 备份与恢复

- PostgreSQL 定期备份并做恢复演练；
- artifact 依赖 manifest 和 digest，可分保留级别备份；
- runner 缓存不是权威数据，无需备份；
- Internal 配置是权威，本地配置缓存可重建；
- 恢复到新 namespace 时先迁移数据库，再验证只读报告，最后启用调度器；
- 恢复演练也要执行 MX-H2I 登录非回归。

## 何时引入额外基础设施

初期不依赖 Jenkins、Redis、Kafka 或通用 workflow engine。

重新评估触发条件：

- API 必须多副本且数据库锁无法满足 leader / queue 需求；
- runner 数量和事件量达到已测瓶颈；
- 需要多阶段 fan-out/fan-in、人工审批或跨环境制品晋升；
- artifact PVC 无法满足跨节点、容量或生命周期；
- 企业已经有成熟 CI，并希望 MX Autotest 只做质量控制面。

届时优先接入成熟能力并保持 Project / Catalog / Suite / Task / Run 合同，不在 mx-auto-server 内长出第二套 CI。
