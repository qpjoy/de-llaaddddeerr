# 代码归并与生产部署选择

2026-09-21。已比较两个仓库的 Git blob 与部署代码；未操作服务器或迁移线上数据。

## 同源关系

`de-llaaddddeerr/electron-dock/mx-base/mx-static` 的原始 25 个受版本控制文件，与 `knock-nas` 的 `6063eb4` 完全相同，包括所有源码、Compose、Dockerfile、测试与文档。

- `knock-nas/6063eb4`：2026-09-12 18:33:58 +0800，0.3.0。
- `de-llaaddddeerr/a3dc1477`：2026-09-12 18:46:33 +0800，包含同一份 0.3.0 快照。
- 本次移植来源为 `knock-nas/fdc2f16` 的 0.7.0，加上合入 mx-base 所需的兼容修复。

这能证明同源以及提交中的先后顺序，但不能只靠提交时间证明最初是谁复制了谁。此次比较时，较新的实现存在于 knock-nas，mx-base 中的 mx-static 并没有后续独立演进。后续建议以 **mx-base/mx-static** 作为本系统的维护入口，避免两份代码各自修改。

迁入的内容包括自足的媒体抓取模块、管理设置、容量/去重/归档改进，以及 NAS 诊断、迁移文档、忽略规则和管理脚本修复。保留 mx-base 的多应用分发及部署确认流程；不修改 OCR、Embedding、Jenkins 或 Hub 的接线。

旧镜像中的脚本路径是 `mx-base/mx-static/src/...`；新镜像只包含 `/app/src`，构建上下文缩为 mx-static 自身，不再依赖 Hub 源文件。父级管理脚本已同步路径并为新设置界面补建 admin-token（不轮换已有凭据）。旧 jobs/archive 数据库在写端启动时先补列、回填，再建立新索引；新增回归检查旧任务、租约、NAS 卷身份和冷对象记录保留。升级前仍需停写并备份 data/state/secrets；回退旧版本应恢复一致的备份，不能假定新对象路径和数据库能直接降级。

两份源码默认使用相同 Compose 名称、端口和 SSD 路径，**不要在同一主机并行部署成两个 writer**。本次归并不是启动第二套实例。

## 决策：保留 Docker，按需由宿主 Nginx 发文件

| 方式 | 收益 | 成本与适用条件 |
| --- | --- | --- |
| 宿主 Node + systemd + Nginx | 省去容器网络与生命周期层 | 需维护 Node/SQLite 版本、服务账户、systemd、权限、日志和升级回退；需实测证明值得切换 |
| 容器 Node + 宿主 Nginx 反向代理 | 保持现有部署和进程隔离，先上线更简单 | 字节仍经过 Node/容器网络；目前的默认方案 |
| 容器 Node 鉴权 + 宿主 Nginx X-Accel-Redirect | 保留容器维护便利，热点大文件字节由宿主直接发送 | 需共享本地对象路径、只读权限、Nginx 配置与端到端验收；可选优化 |

Linux Docker 使用宿主内核；本项目的 data/state 是 SSD bind mount，不把媒体和 SQLite 写入容器可写层。因此不能把 Docker 的写时复制开销直接套到这条数据路径上。Docker 官方也将持久卷与容器可写层的 I/O 开销区分开。[Docker storage](https://docs.docker.com/engine/storage/volumes/)、[bind mounts](https://docs.docker.com/engine/storage/bind-mounts/)

实际差异还包括 bridge/NAT、HTTP 拷贝、cgroup 限额、SQLite fsync 与应用本身。当前 writer/reader 各限制 2 CPU、2 GiB；宿主有很多核和内存不代表容器会自动使用全部资源。先观察 CPU throttling、事件循环延迟、SSD/NFS I/O 和网络吞吐，再调整限额；不预设“容器只慢某个百分比”。Mac Docker Desktop 的 VM/共享文件系统结果也不能代表 Linux 生产主机。

数据库目前是 Node 自带的 SQLite：jobs、archive、settings 三个本地库，**不需要额外部署 MySQL/PostgreSQL 服务**。镜像固定 Node 版本，state 持久化在 SSD；仍需备份、容量监测与升级验证，容器不会免除这些职责。

NAS 冷文件恢复、机械盘和链路速度不会因为把 Node 搬到宿主机就消失。HTTP 服务与归档进程的隔离仍应保留，NAS 不应进入核心 HTTP 挂载。按当前实现和维护成本，默认继续 Docker；只有相同 Linux 主机上的对照测试证明容器层是显著瓶颈，再考虑裸机部署。

## 可选 Nginx 数据路径

```text
客户端 → 宿主 Nginx → reader 容器：鉴权、元数据、检查本地文件
                 ← X-Accel-Redirect
       ← 宿主 Nginx：从 SSD objects 发送文件/Range

writer 容器 → SSD data/state ← archive 容器 → NFS/NAS
```

Nginx 官方支持通过上游 `X-Accel-Redirect` 做内部重定向；`internal` location 禁止客户端直接请求该目录。[proxy module](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)、[internal](https://nginx.org/en/docs/http/ngx_http_core_module.html#internal)

当前 Compose 已转发 `MX_STATIC_ACCEL_REDIRECT`，**默认空值，保持原来的 Node 读取行为**。准备启用时：

1. 将 `deploy/internal-upstreams.conf` 加入 Nginx 的 `http {}`；将 `deploy/internal-locations.conf` 加入对应 `server {}`。两者不能一起塞进 server，否则 upstream 所在上下文非法。
2. alias 对准 `MX_STATIC_DATA_PATH/objects/` 的真实本地 SSD 路径。给予 Nginx worker 对该树的只读和目录遍历权限；不开放 secrets/state，不用 chmod 777，也不提供可绕过鉴权的公开 alias。
3. 确认 `nginx -V` 的编译能力满足模板的 `aio threads`，运行 `nginx -t`。对象 location 关闭 `open_file_cache`，避免已 evict 的文件因缓存文件描述符继续占用 SSD；正在传输的打开文件仍可能暂时占空间。
4. 在 mx-static 的 `.env` 设置 `MX_STATIC_ACCEL_REDIRECT=/internal-objects`，通过正常部署流程更新容器。原有核心健康检查并不能代替 Nginx 路径验证。
5. 测试授权成功、未授权/过期签名拒绝、直接访问 internal 目录拒绝、完整读取、Range/206、HEAD、条件请求、缓存头、PDF 下载头、文件权限，以及冷对象 503→恢复→读取。通过后才启用业务流量。

X-Accel 模式下，Node 的视频流并发统计/限流只覆盖它自己发送的字节，不能用来推断 Nginx 侧的实际长连接数；必要时在 Nginx 配置限流和带宽监测。冷文件仍需完整恢复，原有应用不会自动变成 NAS 直放。当前没有 Nginx 二进制或运行中的 Docker daemon，模板尚未在本次执行 nginx -t 或端到端吞吐测试。

对照测试应固定同一 SSD、文件集、缓存冷热状态和授权逻辑，比较“Node 反代”“X-Accel”“必要时宿主 Node”三种路径的首字节/P95、吞吐、CPU/内存、错误率与 CPU throttling。不要使用 68 字节测试图片或 localhost 小文件结果宣称大视频并发能力。
