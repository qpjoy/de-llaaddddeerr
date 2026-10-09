# MX Device · 独立设备实验中心

首版定位：**设备调度与可视化实验系统，不是 Hub 插件，也不是机架生产 HA 平台。**

`mx-device` 表示设备中心；Rack 是内部资源层级，不把产品限定为某一种机架。可以先独立部署、演示，未来 Hub / Launcher 只增加入口或调用 API，mx-rig 作为测试客户端。

## 不改变现有系统

- 不依赖 Hub、mx-common、Launcher、MX-H2I 或 mx-rig 启动；使用独立 PostgreSQL、独立凭证、独立容器项目。
- 不修改、不重建、不重启 `mobile-agent`，不安装 APK，不操作 ADB、VPN、USB、手机应用或现有业务数据库。
- 当前适配目标仍为宿主机 `http://127.0.0.1:18081` → 现有容器 `18082`。不要改成宿主机 18082，也不需要重新执行 adb forward。
- 已知镜像 `mobile-agent:latest` / `sha256:ca24a84d4e3093fbe80c732ae4580c6ffecc693923ea9a5c9b2968ca62ac532d` 仅作人工核对记录；本项目不拉取、替换或运行该镜像。
- 真实设备默认暂停。列表、刷新、健康检查不访问手机。只有显式「检查连接」和已确认的真实任务会调用接口。
- 外设关闭时，设备中心仍可登录、查历史与登记设备；Hub 不依赖本项目。共用服务器仍有 CPU、内存、磁盘竞争，部署前须确认余量，不能把进程隔离说成资源零影响。

## 已实现

- 机架 / 宿主机分组、设备登记、执行器心跳、只读连接检查、暂停领取、人工隔离恢复。
- 一机一个执行槽，多设备独立执行；持久任务池、Job / Attempt 分离、幂等提交、优先级与等待提升、搜索→详情依赖。
- 搜索限定 1–3 页，完整搜索会话独占设备；翻页不能被另一搜索或详情插入。
- 手机状态投影、已确认页码与列表、事件回放、完整尝试证据；**不是实时镜像，不推断开机/登录状态**。
- 五任务串行、短任务优先级、双模拟设备断线接管，全部使用合成数据，不请求真机。
- 旧 PoC 的只读状态 / 搜索 / 翻页 / 详情兼容适配。真机异常归为结果未知、隔离设备，不自动重试、不自动跨机迁移。

首版限制：每模式最多 64 个登记设备、200 个活动任务；每个 Worker 进程最多 4 个在途工作。实际容量未做压测，数字是保护上限，不是吞吐承诺。无多租户 RBAC、自动发现、批量删除、端点编辑、实时画面、自动保留期清理或真机安全抢占。

## Linux 服务器独立部署

需要已安装并运行的本机 Docker Engine、Buildx、支持 `up --wait-timeout` 的 Compose v2，以及 Linux `flock`（util-linux）。不需要宿主机安装 Node/npm。**这里只部署新中心，不迁移旧容器、不安装或重启 Docker。** 首次部署前检查本机 `18891`、`18894` 未占用，确认资源余量、磁盘监控与独立卷备份。不要运行仓库根目录或其他项目的整体重启命令。

在本目录执行：

```bash
TMPDIR=/data/tmp \
MX_DEVICE_BUILD_PROXY=http://127.0.0.1:7789 \
bash scripts/manage.sh deploy

bash scripts/manage.sh status
bash scripts/manage.sh token
```

不需要代理时直接执行 `bash scripts/manage.sh deploy`。代码更新后**重复执行同一命令重新部署**；旧入口 `bash manage.sh up` / `bash manage.sh deploy` 也会转到这个流程。没有 `down -v`、清库、镜像全局清理或 Docker 重启操作。

命令按顺序完成：

1. 检查本机 Docker、部署锁和原数据库凭证；先构建镜像，构建失败不停止现有 API / Worker。
2. 首次自动生成 `.runtime/` 下的独立数据库密码、管理凭证和仅模拟测试凭证；再次部署只校验、不覆盖。残缺配置或保留数据卷缺少原密码时拒绝继续，必须恢复原配置。
3. 启动并等待本项目 PostgreSQL 健康；不重建已有 PostgreSQL 容器，保留 `mx-device_data` 数据卷。
4. 只停止本中心 Worker 领取新任务，等待在途操作收尾，最长 140 秒；不关机、不调用 ADB，不停止 `mobile-agent`。旧 Worker 非正常退出时中止发布，先人工核查在途任务。
5. 运行一次性 `migrate` 容器：事务锁串行保护迁移，记录版本/校验和，重复执行无重复迁移；已应用文件变更或旧代码回退时拒绝执行。已有首版无迁移账本数据库可以原地纳管，任务记录不删除。
6. 更新 API / Worker，等待 API 数据库就绪和**本次 Worker 实例**的新鲜心跳，再报告成功。迁移失败不会发布新版；更新失败退出非零，不自动回滚数据库或重发真实任务。

这是单机实验部署，有短暂不可用窗口，**不是零停机滚动发布，也没有自动数据库备份**。升级前保留 `.runtime/` 和独立数据库备份；保留卷不等于备份。失败后使用 `status` / `logs` 定位；若 Worker 非正常退出，要先核查任务、处理失败容器后再部署，不能反复直接重发真机任务。

`.runtime/` 目录仅创建者可进入，不纳入 Git；配置文件单独只读挂载给容器。业务连接与设备配置在登录后的界面保存，无需日常设置 env。端口和数据库为本实验项目固定约定；不要将配置指向 Hub 或 mx-common 的数据库。

### 7789 代理和 TMPDIR 的范围

- `MX_DEVICE_BUILD_PROXY` 只传给镜像构建期的 npm 依赖安装；启用时使用本机默认 Docker builder 和 `host` 构建网络，让 `127.0.0.1:7789` 指向宿主机。不会保存到运行配置或 Dockerfile `ENV`，不改变手机请求出口。
- 不支持远程 Docker context / TCP 或 SSH Docker endpoint；本项目必须访问当前宿主机的 PoC 与配置文件。
- **基础镜像 `node:22-alpine`、`postgres:17-alpine` 的拉取不由这个参数代理。** 需要现有 Docker 网络可拉取，或提前准备好镜像。脚本不会修改 daemon 的代理设置，更不会重启 Docker。
- `TMPDIR=/data/tmp` 用于本次部署临时目录（自动创建，要求可写）；不迁移 Docker data-root、BuildKit 缓存或数据库数据。省略时使用 `/tmp`。

实现使用 Docker 官方的[预定义构建代理参数](https://docs.docker.com/build/building/variables/#proxy-arguments)及[构建网络模式](https://docs.docker.com/reference/compose-file/build/#network)；代理参数与 Docker daemon 拉取代理是不同层级。

Compose 服务：

| 服务 | 网络与职责 |
| --- | --- |
| api | 独立 bridge 网络，宿主机仅 `127.0.0.1:18891`；处理管理界面与本中心数据库 |
| postgres | 独立命名卷、数据库与账号；宿主机仅 `127.0.0.1:18894`，供本机 Worker 连接 |
| worker | Linux host network，无监听端口；访问当前宿主机 18081 与本中心数据库 |
| migrate | `ops` profile 的一次性数据库迁移容器；发布前执行，不连接手机 |

Worker 没有 Docker socket、USB 挂载、特权权限或 ADB。容器设内存 / CPU 上限，API 与 Worker 使用非 root 用户、只读根文件系统。首次构建可能占用较多资源，应选维护窗口；运行上限不能约束镜像构建开销。

默认不公开管理端口。在自己的电脑上通过现有 SSH 通道打开：

```bash
ssh -N -L 18891:127.0.0.1:18891 root@mx-internal-server
```

然后访问 `http://127.0.0.1:18891`，使用 `bash scripts/manage.sh token` 的输出登录。若本机此端口已用于开发，换一个本地转发端口即可。正式反代部署另行配置 HTTPS、访问控制与 `secureCookies`；不要直接绑定公网 HTTP。

暂停整个实验中心：`bash scripts/manage.sh stop`。只停止这个 Compose 项目，保留数据卷。Worker 正常停止会等待当前执行结束（最长 140 秒）；强制杀进程可能产生未知任务，不应马上重新发送。恢复使用同一个 `deploy` 命令。

本地已做 Compose 语法检查；本机 Docker daemon 未运行，尚未执行容器构建或 Linux 服务器验收。

## 接入现在这一台手机

先完整跑模拟演示，再切换右上角为「真实设备」并添加：

| 字段 | 当前建议 |
| --- | --- |
| 名称 | 外设手机 01 |
| 机架 | 机架 01 |
| 宿主机 | mx-internal-server |
| 执行器 | mx-internal-server-worker（以连接设置中实际心跳为准） |
| 账号资源标识 | xhs-account-01（资源别名，不是密码） |
| ADB 序列号 | 不知道就留空；不能编造，也无需启动新的 ADB daemon |
| 服务入口 | http://127.0.0.1:18081 |

批准该本机入口并保存，设备仍暂停。点击「检查连接」，由指定宿主机 Worker 调用一次 `/api/state`。若 Worker 离线，只有待处理检查记录，不会由 API 容器绕路连接手机。

你提供的响应 `isBusy:true / page:1 / 正在加载第 2 页…` **不能作为可调度证据**；HTTP 200 只代表接口响应。首次检查可能显示相同内容，应继续保留暂停，不会自动重启控制端或清 busy。

启用前必须人工确认：旧 Hub 外设调度、脚本、其他调用方已停止领取，而且没有在途手机任务。取得 60 秒内明确 `isBusy:false` 的检查结果后，再确认独占并启用。旧 PoC 无法从协议层排除另一个绕过中心的调用者，此人工条件不可省略。

第一次只提交一个一页搜索；核对关键词、页码、数量与详情链接。再用返回链接提交一个详情。确认稳定后再测两页搜索与排队。真机示范**不会**自动发送五个任务，模拟按钮在真实模式不可用。

## 本地开发与验证

Node.js 22；独立 PostgreSQL 17+。先运行 `npm ci`、`npm run init`，为这个项目准备单独数据库，必要时仅在首次引导时编辑 `.runtime/config.json` 中的数据库地址。不要填入 Hub 数据库。

```bash
npm run build
npm start
# 另一个终端，本项目目录
npm run worker
```

前端开发可用 `npm run dev`（Vite 将 `/api` 转给 18891），生产入口为 `npm start`。页面与 API 同源，管理凭证不进入 URL 或 localStorage。

```bash
npm test
npm run check
npm run build
# 可选：仅限本地临时 PG，测试会创建并删除随机 mx_device_test_* 数据库
MX_DEVICE_TEST_DATABASE_URL=postgresql://test_user@127.0.0.1:5432/postgres npm test
# 正在运行的独立演示实例；使用模拟专用凭证，拒绝 admin 凭证
node tests/acceptance.mjs .runtime/config.json .runtime/acceptance-report.json
```

不提供测试数据库地址时，PostgreSQL 集成用例明确标为 skipped，不应把普通 `npm test` 说成数据库并发验收。验收脚本会创建模拟任务、注入模拟断线，需在空闲的专用演示实例运行。

- [演示脚本与通过标准](docs/demo.md)
- [调度模型、边界与扩展路线](docs/architecture.md)
- [API 与 mx-rig 接入边界](docs/api.md)
- [本轮验证记录](docs/verification.md)
