# 运行、部署与验收

## 本地

一键体验：`bash scripts/manage.sh local init`（macOS、Linux、Windows 的 Git Bash）。它会装依赖、生成或询问配置（写进 `.runtime/local/local.env`，权限 0600）、准备测试浏览器，然后在后台启动服务。之后用 `local up | desktop | status | logs | token | down | reset`，见 [docs/18](18-out-of-the-box-delivery.md)。

也可以手动启动：`npm install` 安装依赖，`npm run dev` 启动 localhost:8791。随机开发口令保存在 `.runtime/dev-token`，仅用于本地。`npm run desktop` 打开 Electron，登录相同服务。工作台不自动为项目创建测试账号或运行目标测试。

`dev` / `desktop` / `package` 会先跑 `scripts/design-assets.mjs`，把已安装的 `@qpjoy/ui-design-neon-void` 同步到 `apps/web/vendor/`（生成物，不入库）。该包缺失时同步跳过并沿用已有副本，服务照常启动——打包后的桌面自带这份副本。

`npm run browser:install` 安装与锁定 Playwright 对应的 Chromium：先从官方 CDN 下载，不通时改用 npmmirror，`MX_RIG_BROWSER_MIRROR` 可以指向自己的镜像。若系统盘空间不足，安装和启动桌面时设置同一个 `PLAYWRIGHT_BROWSERS_PATH` 到工作盘目录。桌面端、终端和工位找不到浏览器时会用本机的 Chrome / Edge，或者自动下载一次；打包的桌面端自带 Chromium。

## 服务配置

支持 Node `--env-file=.env`，或者直接注入 MX_RIG_*。服务凭据、数据库和状态目录必须独立。端口默认 8791，未占用 MX-H2I 端口。

桌面端连接非本机服务默认只接受 HTTPS。内网测试服务器没有 TLS 时，在登录页勾选「内网测试服务器」（或设置 `MX_RIG_ALLOW_PRIVATE_HTTP=1`）：只放行私有网段的 IP 地址（10/8、172.16/12、192.168/16、100.64/10、IPv6 ULA），主机名不放行，登录后会提示连接未加密。只在可信内网或 WireGuard 隧道里这样用；对外服务仍然通过反向代理提供 TLS。

账号默认由 Rig 自己管理：管理员在 `/test-center/` 的「成员」页新建账号并发放一次性密码（见 [docs/12](12-self-contained-rig-and-flight-model.md) §6.1）。`MX_RIG_LAUNCHER_URL` 是可选的 Launcher 身份公开接口地址，不是 Rig 自身地址；配置后 Launcher 账号也可以登录，不配置时 Rig 照常可用，不尝试修改 Launcher。

模型连接配置在 Internal 页面保存：Provider 列表顺序即调用顺序，密钥只通过各 Provider 指定的服务端环境变量注入。改完环境变量需要重启服务。没有真实模型时，Agent 明确受阻而不是伪造回答；使用测试工作流可独立验证任务执行链。

每个 Provider 有一个**流式输出**开关（默认开）。网关不支持 SSE 时有两种表现：回一个普通 JSON body（服务端按 `content-type` 识别，当普通响应读完，不会谎称流式），或者直接拒绝带 `stream: true` 的请求（这时把该 Provider 的开关关掉，行为回到 0.6）。流式只影响呈现，结论与工具调用的校验两条路径完全相同。

结构化结论（`finding_submit`）是一个普通工具，**新部署默认在允许列表里**。从 0.6 升级上来的部署保留原有列表，需要管理员在「Internal 配置 → 工具允许列表」里勾上它，Agent 才能提交结论卡；没勾上时 Agent 只能给文本，不会静默失败（工具页会显示它未被允许）。

「Agent 中心 → 出网与通道」分两半。上半是只读观测：本进程看到的代理变量，凭据隐藏但如实标注是否存在。注意 Node 22 的 `fetch` **不读**代理环境变量——环境里配了代理不等于服务走代理，页面因此分别标注"已配置"与"是否生效"。

下半是 Rig 自己的通道，管理员可增删并实时切换，只作用于两处：服务端的模型调用（走 HTTP CONNECT 隧道）与桌面 Runtime 的隔离浏览器（Chromium 启动参数）。要点：

- 通道地址写 `scheme://host:port`，必须带端口，不能带凭据。需要代理凭据时在通道上登记**环境变量名**（例如 `MX_RIG_EGRESS_AUTH`），值形如 `user:password`，只在服务端进程读取；改完环境变量要重启服务。
- socks 通道只能作用于浏览器；带凭据的通道不能作用于浏览器（桌面是另一台机器上的另一个进程）。
- 切换通道会产生新的策略版本，**待确认的动作因此失效**，需要重新发起；隔离浏览器在下一次打开页面时重开。
- MX Rig 仍然不设置系统代理、路由、DNS、PAC 或 NRPT，也不接管其他应用的网络归属。详见[出网通道](09-egress-channels.md)。

控制面自己的状态（策略、任务、定时触发记录、教学进度）放在哪里取决于 `MX_RIG_STORE`：

| 模式 | 位置 | 副本数 |
| --- | --- | --- |
| `postgres`（部署） | 与测试领域同一个数据库：`rig_missions`、`rig_state`、`rig_schedule_fires`（迁移 `020_rig_control_state.sql`） | 可以多副本 |
| `memory`（本地开发与测试） | 状态目录 `MX_RIG_STATE_DIR` 里的 `settings.json`、`missions/`、`schedule.json`、`system-progress.json` | 只能单实例 |

从文件切换到 PostgreSQL 的部署，第一次启动时会把状态目录里已有的配置、任务、教学进度和定时记录导入数据库，一次性完成。数据库里已有的内容不会被覆盖，文件保持原样，日志里有一行导入摘要。导入时尚未结束的任务按受阻导入。

## 部署：compose 与 Kubernetes

两套配方用同一个镜像（`deploy/Dockerfile`，构建上下文为 electron-dock，只复制 mx-rig、mx-common 和 Neon Void 依赖），都由 `scripts/manage.sh` 管理。脚本只碰自己的东西：compose 项目 `mx-rig`，或 Kubernetes 命名空间 `mx-rig` 及它的两个 PersistentVolume；不读取、不修改其他产品的命名空间、Service、Secret、数据库或卷，也不去发现 Launcher。

怎么选：

- **一台机器、没有集群**（本机开发、单独的测试服务器）：用 compose，一条命令就能起来。
- **Internal 服务器**：已经跑着 Kubernetes，其他产品也用 `manage.sh deploy`。k8s 额外带来：服务端执行的 Run 由测试内核派成 K8s Job（有资源配额、网络隔离）、迁移 Job、Secret 管理。单机测试服务器上 k8s 并不比 compose 更好，只是和 Internal 的运维方式一致。

### Compose

```bash
scripts/manage.sh up                 # 只在本机 loopback 上提供服务
scripts/manage.sh up --lan --runner  # 局域网可访问，并带一台 Playwright 执行机
scripts/manage.sh up --station       # 再带一个重放试验规程回归的工位
scripts/manage.sh token              # 管理员令牌：账号 admin，密码就是它
scripts/manage.sh ps | logs [服务] | down [--purge --yes]
```

- 第一次运行时生成数据库密码、管理员令牌和加密密钥，写入 `.runtime/compose.env`（0600）。之后一直沿用这些值，**这个文件要保留**，数据库依赖它。
- 同一次命令里在 shell 或 `.env` 中给出的 `MX_RIG_MODEL_API_KEY`、`MX_RIG_PUBLIC_URL`、`MX_RIG_HTTP_PORT` 等会记进这个文件，下次继续生效。
- `--lan` 把端口绑定到 0.0.0.0，并把访问地址设为本机的内网 IP（找不到时设置 `MX_RIG_LAN_IP`）。访问地址是 `http://` 时，会话 cookie 自动去掉 Secure，浏览器登录才能生效。
- `--runner` 会构建 `deploy/runner.Dockerfile`（Playwright 官方镜像里的 `mxt-runner`），用管理员会话签发一次性接入码完成注册，之后执行机的 token 只存在它自己的卷里。
  - 它只声明 `playwright × web`，类型是 server。
  - 镜像里的浏览器对应 `MX_RIG_RUNNER_PLAYWRIGHT_VERSION`（默认 1.58.2），要和套件锁定的 `@playwright/test` 版本一致。
- `--station` 会构建 `deploy/station.Dockerfile`：Playwright 官方镜像，里面只有 `mx-rig station` 和它用到的几个模块。
  - 登记方式和 `--runner` 相同，类型是 server，只声明 `rig-procedure × web`。
  - 它通过 compose 服务名 `http://server:8791` 访问服务。
  - 规程要访问的地址要能从工位容器里访问到。规程带着自己的站点（基础地址和打开过的页面），不需要另外列进允许列表；管理员选了「一律不打开没有列出的站点」时除外。生产禁区始终拒绝。
- 数据库先就绪，再执行迁移，再启动服务；服务容器只读、去掉全部 capability。
- `down` 保留卷；`down --purge --yes` 才会删除数据库、产物、执行机和工位卷。
- compose 里没有 Kubernetes API，服务端的 K8s Job 派发不可用：用 `--runner` 的执行机，或者注册其他执行机。

手工使用：`docker compose -f deploy/compose.yaml --env-file .runtime/compose.env up -d`。

### 工位（试验规程回归）

**分工**：服务端只排程和排队，工位执行，服务端镜像里没有浏览器。回归任务在「试验规程 → 定时回归」里新建：选应用，填 cron（留空就是手动），选「任意工位」或「团队工位」。

**桌面端**：「试验规程 → 本机工位值守」。
- 用当前登录登记；
- 值守进程和你的任务分开，使用无头浏览器；
- 停止值守时，当前这批跑完再停；
- 退出登录或关闭 MX Rig 时一并停止。

**测试机**（需要 Node 22 和 `npm run browser:install`）：

```bash
mx-rig station enroll --server https://rig.internal --code <接入码> [--name 名字] [--kind server|local]
mx-rig station watch        # 常驻；Ctrl-C 一次：这批跑完再停；两次：立即停，这次执行记为受阻
mx-rig station status
```

- 接入码由管理员在「执行机」页生成，只能用一次。
- 配置和执行机 token 在 `MX_RIG_STATION_DIR`（默认 `~/.mx-rig/station`，权限 0600）。
- 非本机服务必须用 HTTPS。内网测试服务器可以设置 `MX_RIG_ALLOW_PRIVATE_HTTP=1`，允许私有 IP 或单段主机名（如 compose 服务名）走 HTTP。
- `--kind server` 登记的工位也会领「团队工位」的批次。
- `MX_RIG_STATION_HEADED=1` 或 `--headed` 可以看着浏览器跑。
- 规程批次在没有工位时等待，默认 12 小时后过期，不会一直排队。

### Kubernetes（Internal）

在 Kubernetes 节点上执行（本地构建的镜像要导入这台机器的 containerd）：

```bash
scripts/manage.sh deploy        # 构建镜像 → 导入 containerd → 迁移 → 上线 → 验证
scripts/manage.sh verify | status | logs [server|migrate|postgres] | admin-token
scripts/manage.sh stop          # 服务缩到 0；数据库、Secret、数据目录保留
```

- **命名空间与入口**：命名空间 `mx-rig`，自带 PostgreSQL（StatefulSet），NodePort 30891。访问地址默认是 `http://<节点 InternalIP>:30891`，可以用 `MX_RIG_PUBLIC_URL` 覆盖。
- **镜像**：
  - kubeadm/containerd 节点：用 host 网络构建，按内容哈希打标签，再 `ctr -n k8s.io images import`（需要 root 或免密 sudo）。
  - docker-desktop 与 kind：自动处理。
  - 已有镜像仓库时：设置 `MX_RIG_IMAGE=repo@sha256:…`，跳过本地构建。
- **密钥**：管理员令牌、数据库密码、加密密钥在第一次部署时生成，存进 `mx-rig/mx-rig-secrets`，之后普通部署不会轮换。数据库卷存在而 Secret 丢失时，部署会拒绝继续。
  - 可选设置（部署时给了新值就更新，没给就沿用上次的值）：`MX_RIG_MODEL_API_KEY`、`MX_RIG_MODEL_API_KEY_2`、`MX_RIG_PUBLIC_URL`、`MX_RIG_GIT_TOKEN`、`MX_RIG_LAUNCHER_URL`、`MX_RIG_RUNNER_TARGET_CIDRS`。
  - Provider 的 `apiKeyEnv` 要填这两个模型密钥变量名之一。
- **数据目录**：hostPath，第一次部署时决定——`/data` 是单独挂载的磁盘时用 `/data/mx-rig`，否则用 `/var/lib/mx-rig`。也可以在第一次部署前用 `MX_RIG_DATA_ROOT` 指定。之后从 PV 读回，不能移动。所在文件系统用量达到 90% 时，部署会给出提醒。
- **执行机 Job**：服务账号只有在本命名空间创建、查看、删除 Job 和读取 Pod 日志的权限。每次最多同时跑 1 个服务端 Run，资源上限见 `08-resource-policy.yaml`。
  - 网络策略只允许 Job 访问 Rig 服务、DNS 和公网的 80/443；私有网段默认拒绝。
  - 要测内网环境，用 `MX_RIG_RUNNER_TARGET_CIDRS=10.20.0.0/16,192.168.8.0/24` 逐个放行网段。
- **服务出网**：DNS、自带数据库、Kubernetes API、80/443。模型网关在其他端口时，要在 `40-network-policy.yaml` 里加一行。
- **副本**：单副本、滚动更新（新 Pod 就绪后才停旧的；旧 Pod 退出前有 5 秒 preStop，让 Service 先摘掉它，发布不中断）。多副本在逻辑上是安全的（见下），单节点上没有必要。
- **Job 镜像**：服务端 Playwright Run 用的镜像写在 `08-resource-policy.yaml` 的 `MX_RIG_RUNNER_IMAGE_PLAYWRIGHT`（默认 1.58.2），要和套件锁定的版本一致。
- **本机试跑**：Docker Desktop 打开 Kubernetes 后，在本机运行 `scripts/manage.sh deploy` 即可，访问地址是 `http://127.0.0.1:30891`。
  - 删除：`kubectl delete namespace mx-rig`，再删除两个 PV：`mx-rig-postgres-pv`、`mx-rig-artifacts-pv`。
  - 数据目录在 Docker 的虚拟机里。

`MX_RIG_STORE=postgres` 时服务可以多副本运行，所有副本连同一个数据库：

- **执行中的任务**只由执行它的副本写入。在其他副本上点「停止」，会给该任务留一个取消请求；执行它的副本在下一次保存或下一次心跳（约 5 秒）时自己停下。
- **等待确认的任务**不占用任何进程，检查点在数据库里，任意副本都能确认。同一个确认在两个副本上同时点击，只会执行一次。滚动发布时，正在等待确认的任务会保留下来。
- **副本失联**：一个副本超过约 90 秒没有心跳时，它名下正在执行的任务会被其他副本标为受阻，并注明外部动作结果可能未知，不会自动重放。
- **策略配置**：保存时带版本号。在别人保存之后才提交的编辑会被拒绝，需要刷新后重做，不会悄悄覆盖。其他副本在一秒内读到新版本。
- **定时编排**：每个触发时刻只能被一个副本认领并执行。
- **钩子**：每次失败执行由一个副本认领（主键），只启动一个定级任务；检查间隔 `MX_RIG_HOOK_TICK_MS`（默认 20 秒）。
- **测试计划的定时**（测试内核的 cron / once）：每次触发先按"下一次触发时间仍是读到的那个值"认领，再创建 Run，所以同一次触发只产生一个 Run，不论有几个副本在检查。
- 每位成员在服务端同一时刻只能有一项未结束的任务，这条限制跨副本生效。

部署新版本前先执行迁移（019 本地账号、020 控制面状态、021 试验规程、022 钩子），再更新服务；`manage.sh up` 和 `manage.sh deploy` 都会按这个顺序做。备份只需数据库和 artifact 卷（或 hostPath 目录）。仍在 memory 模式时只能单实例，恢复前要先停服务。

### 终端（mx-rig）

**分发**：在 mx-rig 目录运行 `npm run pack:cli`，把 `dist/qpjoy-mx-rig-cli-<版本>.tgz` 发给成员。
- 成员安装：`npm install -g <tgz>`，需要 Node 22；
- 要用浏览器时，再运行 `npx playwright install chromium`；
- 开发者也可以在 mx-rig 目录运行 `npm link`。

成员在自己的项目目录里：

```bash
mx-rig login --server https://rig.internal   # Rig 账号；会话存在 ~/.mx-rig/session.json（0600）
mx-rig init --app <应用>                      # 写 RIG.md
mx-rig                                       # 会话；mx-rig exec "<目标>" 为非交互
```

- **管理员**：在「工具与边界」里允许 `workspace_run`、`workspace_write`、`workspace_edit`。新部署默认只允许读项目的三个工具；存量部署连这三个也要手动勾选。
- **CI**：用 `MX_RIG_URL` 和 `MX_RIG_TOKEN` 代替 `login`；用 `--allow-command "<命令>"` 和 `--allow-edits` 事先允许写操作，其余一律不执行。
- **Agent 运行的命令**：
  - 拿不到像密钥的环境变量；需要时用 `MX_RIG_PASS_ENV=名字,…` 放行；
  - 默认在沙箱里跑，只能写项目、临时目录和工具缓存；`--sandbox off` 关闭，`MX_RIG_SANDBOX_WRITABLE` 追加可写目录。
- 细节见 [docs/14](14-terminal-agent.md)。

### 桌面端

在开发机上打包：`scripts/manage.sh desktop`（即 `npm run package`，产出在 `dist/`）。加 `--dir` 生成不签名的目录版，不下载安装器工具。mac 包在 mac 上打，Windows 包在 Windows 上打。桌面端登录时填服务地址；明文 HTTP 的内网服务器需要勾选「内网测试服务器」，见上文。

## 验证层级

- `npm run check`：源码语法和网络 owner 禁止耦合检查。
- `npm test`：迁入的测试领域回归，加上编排运行时、编排规格与编译、Agent 中心、出网观测、配置迁移与 API 边界测试，以及乘组评测集的脚本模式。
- `npm run eval`：乘组评测集。`--live` 用真实模型重复运行固定场景，统计成功率、人工介入、工具出错率与用量，见 [`evals/README.md`](../evals/README.md)。
- 多副本与 PostgreSQL：设置一个可建库、删库的 PostgreSQL 连接后再跑测试，例如 `MX_RIG_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npm test`。测试会新建随机名称的数据库，跑完删除；其中会在同一个库上启动两个服务，覆盖跨副本确认、停止、回收、定时认领、配置并发与旧状态导入。未设置时这些测试跳过。
- 浏览器 UI：本地登录、任务创建、确认与拒绝、Agent 中心各页、编排中心（打开已存编排、草稿预览、被拒绝的草稿）、系统层（两类证据、领取、常驻面板）、一句话解析（候选与"解析不执行"）、出网通道的新增与切换、配置保存、测试管理入口、刷新和证据展示。
- Electron：独立启动、IPC、子进程任务、取消、重登、浏览器隔离、关闭无残留。
- 发布：安装包签名与真实目标机器回归。
- 现网：隔离环境验证后再登记入口；必须另存 MX-H2I 登录和联网证据。

测试中模型替身验证协议和状态机，不代表已完成真实模型服务验收。模拟测试 Runner 验证调度/报告接口，不代表当前机器运行过真实 Compass 客户端。
