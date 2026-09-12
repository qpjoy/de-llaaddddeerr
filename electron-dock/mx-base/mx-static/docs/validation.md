# 0.3.0 验证记录（2026-09-12）

- 静态服务、NAS 故障模拟和管理脚本：15 passed，0 failed。
- Hub 运行时接线已撤下；服务端回归：1661 passed，9 skipped，0 failed（总计 1670）。
- 最终 `mx-static:0.3.0` 镜像构建通过。
- 三容器隔离 Compose 验证通过：独立接入 archive、挂载标记缺失拒绝归档、离线期间本地读写、重新接入补传、校验后释放本机副本、reader 自动请求冷文件恢复。writer/reader 容器 ID 始终不变。
- 模拟无法退出的 NFS 子进程：触发 stalled 后只保留一个槽，不启动替代进程；主服务健康与本地上传仍可响应。
- 慢传输进度延长空闲超时，总任务时长仍受限；HTTP 首响应超时不会取消已持久接收的任务。
- NAS 副本损坏时不释放本机文件；卷 ID 缺失/不同不写入空挂载目录；离线冷文件返回 503 恢复中，不误报 404。

**边界：使用临时目录模拟 NFS 可见性和故障，并模拟内核不可终止子进程；没有访问真实 36 TB NAS，没有执行真实 NFS 断网、挂载或宿主重启演练。** 生产吞吐、实际 NFS fsync/root_squash、重连/D 状态恢复需要在目标 Linux 主机验收。

macOS Docker 共享目录出现过跨进程控制状态不可见；换为 Docker VM 本地 volume 后验证通过。现在控制库启动拒绝 virtiofs/9p。Linux 部署使用本机原生文件系统；这是控制盘校验，不能迁到 NAS。

复跑（仓库根目录）：

```sh
node --test electron-dock/mx-base/mx-static/tests/*.test.mjs electron-dock/mx-base/tests/manage.test.mjs
```

复跑容器故障演练（electron-dock 目录）：

```sh
docker build -f mx-base/mx-static/Dockerfile -t mx-static:0.3.0 .
node mx-base/mx-static/scripts/smoke-nas-compose.mjs
```

脚本使用独立项目名、临时目录和临时控制卷，结束后清理。模拟脚本设置 NAS_REQUIRE_NFS=false，仅用于本地演练；生产保持默认 true。

## 0.2.0 历史验证

下述记录保留此前验证语境；NAS 和 Hub 接入行为以 0.3.0 文档为准。

# 本地验证记录

2026-09-12，0.2.0。未部署生产；未修改 MX-H2I 用户登录、联网、DNS 或 WireGuard 路径。

| 验证 | 结果 |
| --- | --- |
| Hub 全部服务端回归（含既有认证/租户隔离测试） | 1670 passed，0 failed |
| mx-static 持久队列/服务测试 | 8 passed，0 failed |
| mx-base 管理脚本行为测试 | 1 passed，0 failed |
| Hub 运维脚本 / Sites 运行时测试 | 116 / 4 passed |
| Hub 前端生产构建 | 通过，保留既有大 chunk 提示 |
| Docker 镜像 | mx-static:0.2.0，Node v24.21.0 / SQLite 3.53.4，UID 1000 |
| 实际双容器 Compose | 对象盘/控制盘分别 bind，reader 只读，上传后重启，字节与任务记录一致 |
| 并发采集 | 16 个 URL 同时接收，无 429；限定 3 个测试 worker；重复请求合并；cache_only 在途返回 202 |
| 强制崩溃恢复 | 子进程 SIGKILL，重开控制库，过期租约恢复；旧 owner 不可完成新租约 |
| 内存缓存 | TTL/LRU/字节上限、淘汰后读磁盘、不重新回源、租户隔离通过 |
| 浏览器等待 | queued 转为可重试 pending，不重复直连上游；任务独立于浏览器存活 |

100 个同时缓存读取的本地冒烟样本全部成功，p50 约 155 ms、p95 约 197 ms。样本是 68 字节 PNG，包含 macOS Docker 文件共享/客户端开销，只证明并发路径正确，不代表真实图片、生产网络或 NAS 吞吐能力。

上轮已验证：浏览器签名 WebP 直接预览、Hub 默认开放 API/refresh 与原生文档导航；两层实际 Nginx 配置的本地 `nginx -t` 通过（测试副本剥离生产证书引用）。线上完整 TLS、真实闲鱼 error.code/回源、真实图片负载与 NAS 断链仍需上线环境验收。

## 复跑

在仓库根目录：

```sh
node --test electron-dock/mx-base/tests/manage.test.mjs
node --test electron-dock/mx-base/mx-static/tests/*.test.mjs
```

在 `electron-dock`：

```sh
docker build -f mx-base/mx-static/Dockerfile -t mx-static:0.2.0 .
node mx-base/mx-static/scripts/smoke-compose.mjs
```

Compose 验证脚本创建独立、带进程 ID 的临时项目和临时目录，使用随机端口，结束后清理。不会对默认部署项目运行 stop/down。macOS 测试凭据是固定无效样本并允许容器读取；生产凭据由 manage.sh 随机生成、0440 权限。

在 `electron-dock/mx-insight-hub`：`npm run test:server`、`npm run test:ops`、`npm run test:sites`、`npm run build`。
