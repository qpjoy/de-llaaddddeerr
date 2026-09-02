# 15 · 服务端第一次跑通

> 目标：在 Internal 上部署平台，从浏览器打开它，让罗盘（po-frontend）的 Cypress
> 用例在服务器上自动跑一遍，并在界面上看到报告和录像。
>
> **这一步不需要 Jenkins。** 为什么见 [§5](#5-jenkins-的边界)。

---

## 0 · 前提

| 项 | 要求 |
| --- | --- |
| 服务器 | 能跑 `docker` 和 `kubectl`，kubectl 指向 Internal 集群 |
| 出网 | 容器要能 `git clone` GitHub 和装 npm 依赖（走代理也行，配 `HTTP_PROXY` 到镜像环境） |
| 磁盘 | 首次会拉 `cypress/included`（~5GB），另留 50GB 给产物 |
| 必填配置 | **只有 `MXT_ADMIN_TOKEN`** |

```bash
cd electron-dock/mx-test-framework
printf 'MXT_ADMIN_TOKEN=%s\n' "$(openssl rand -hex 24)" > .env.internal
chmod 600 .env.internal
```

数据库不用配：`deploy` 会在同 namespace 拉起 MXT 自己的 PostgreSQL
（[ADR-0004](adr/0004-independent-database.md)），密码自动生成。

---

## 1 · 部署

```bash
bash scripts/manage.sh deploy
```

按顺序做八件事，任何一步失败都会停下并打印原因：

| # | 动作 | 失败时通常是什么 |
| --- | --- | --- |
| 1 | 建 namespace，解析/生成数据库密码 | — |
| 2 | `docker build` 镜像 | 上下文现在只有几 MB（`electron-dock/.dockerignore`）。慢说明 dockerignore 没生效 |
| 3 | 写 Secret（stdin 传入，不进 argv） | — |
| 4 | 拉起 PostgreSQL，等 `pg_isready` | PVC 绑不上：检查 `/var/lib/mx-test-framework/postgres` 目录权限 |
| 5 | 跑迁移 Job | advisory lock 冲突会等待，不会交错 DDL |
| 6 | apply 全部清单（含 NodePort） | — |
| 7 | 等 Deployment ready | — |
| 8 | 自动冒烟 `verify.mjs` 的 16 项断言 | 这一步绿了，说明控制面整条链路通了 |

结束时会打印界面地址：

```
[mx-test-framework] 界面： http://<服务器内网 IP>:30879  （账号随便填，密码用 MXT_ADMIN_TOKEN）
```

### 从自己的电脑访问

NodePort 而不是 Ingress：Ingress 需要控制器和域名，而这是内网工具。
连上内网后直接开 `http://<服务器内网 IP>:30879`。

登录不需要 mx-launcher —— 账号随便填，密码填 `MXT_ADMIN_TOKEN`。
首次登录自动开通，admin token 对应 admin 角色。
（`MXT_LAUNCHER_URL` 配了才走 launcher 联邦登录，内网自用不必。）

> 录像和报告是同源加载的：登录时会种一个 session cookie，
> 所以 `<video>` 标签不用带 header 也能拉到产物，支持 Range 拖动进度条。

---

## 2 · 接入罗盘

```bash
MXT_BASE_URL=http://<服务器内网 IP>:30879 \
MXT_ADMIN_TOKEN=<你的 token> \
  node scripts/onboard-luopan.mjs
```

幂等，可以反复跑。它登记的东西里有三个不显然的点，都是实际查仓库得出的：

**① 分支是 `public`，不是 `main`。**
Cypress 套件只存在于 `origin/public`；`main` 上 `test` 还是 `echo "No test specified"`。
所以 app 的 `defaultBranch` 填 `public`。

**② 是 monorepo，项目根在 `po-frontend/`。**
仓库根（`mingxiinfo/po-frontend`）下面是 `po-frontend/`、`po-admin/`、`po-backend/`。
`package.json`、`pnpm-lock.yaml`、`cypress/` 全在 `po-frontend/` 里。
suite 的 `workingDir` 必须填 `po-frontend`，否则装依赖时找不到 lockfile，
判 `blocked`，而仓库本身完全正常。

**③ 用 `pnpm e2e:local`，不是 `e2e:run:mock`。**

| 命令 | 需要什么 |
| --- | --- |
| `pnpm e2e:local` | **什么都不需要**。自己跑 `quasar build`，把 `dist/spa` 起在 127.0.0.1:55955，再让 Cypress 打它 |
| `pnpm e2e:run:mock` | 需要外部 `E2E_BASE_URL`，即一个已经部署好的实例 |

第一次跑通要的是**不依赖任何其他东西**。所以 suite 声明
`targetMode: 'self'`，任务就不再强制填目标地址——否则平台会要一个没人读的 URL。

跑绿之后再加第二个 suite 用 `e2e:run:mock` 打真实环境，那时 `targetMode` 保持
默认的 `external`。

---

## 3 · 跑第一次

界面 →「测试任务」→「罗盘 Web mock · 手动」→ 点「立即执行」。

容器里依次发生：

```
git init + fetch --depth 1 origin public + checkout FETCH_HEAD
  → 记下真实 gitSha（进 summary.sourceRef，这样"上周三那次失败在哪个 commit"有答案）
cd po-frontend
pnpm install --frozen-lockfile        装不上就 blocked，不会退化成 npm
pnpm e2e:local
  → quasar build（生产构建）
  → 起静态服务器 127.0.0.1:55955
  → cypress run
写 summary.json → 校验能解析 → 重试 3 次 POST 回平台 → 按真实退出码退出
```

**第一次会慢：8–15 分钟**，大头是 `pnpm install` 和 `quasar build`。
之后每次一样慢——这是保留运行期 clone 的代价，也是将来改预构建镜像的触发条件
（[14 §2](14-ci-runners-and-stack.md#2-为什么保留-clone)）。

### 看结果

「执行记录」点进去：

- 通过 / 失败 / **未执行** 三个分开的数——目录里登记了但这次没跑到的用例单独计数，
  删掉一条失败用例不会让结果变绿
- 失败用例展开有错误首行和堆栈
- 步骤时间轴带毫秒偏移，点某一步跳到录像对应位置
- 右上「对外版（脱敏）」生成可以发给客户的副本

---

## 4 · 变成定时

跑绿之后，把任务的 schedule 从 `manual` 改成 `cron`：

```bash
curl -X PATCH "$MXT_BASE_URL/api/v1/tasks/<taskId>" \
  -H "authorization: Bearer $MXT_ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"schedule":{"kind":"cron","cronExpr":"0 2 * * *","timezone":"Asia/Shanghai"}}'
```

调度器每分钟一跳，每跳做两件事：

1. **回收**：列出平台自己建的 Job，凡是 Job 已失败而 run 还停在 `running` 的，
   判 `blocked` 并附 k8s 给的原因（`DeadlineExceeded` / `BackoffLimitExceeded`）。
   没有这一步，Pod 被 OOMKill 或驱逐时 run 会挂在"执行中"直到租约过期（默认 30 分钟），
   看起来像还在跑，其实早死了。
2. **派发**：把 `queued` 的 run 变成 k8s Job。

> **定时跑起来之后最缺的一件事是通知。** 现在完全没有。
> 没有通知的定时任务等于没跑——每天早上没人会主动去开看板。
> 规则见 [13 §4.4](13-platform-review-and-redesign.md#44-通知策略)：只在状态跃迁时通知。

---

## 5 · Jenkins 的边界

**现在不要接 Jenkins。** MXT 自带调度器和 k8s 派发器，服务端 Web 闭环不需要外部 CI。
过早接进来只会多一层要维护的东西，而它这个阶段一件事也没多做。

Jenkins 该进来的时机是**出现"构建"这个动作**的时候：

| 需求 | 谁做 |
| --- | --- |
| 定时跑 Web e2e | **MXT**（已具备） |
| 手动点一次 | **MXT**（已具备） |
| 出 Electron 安装包（`.exe` / `.dmg`）给桌面 runner 测 | **Jenkins**。服务器上跑不了 Windows 构建，要专门的构建机 |
| 合并到主干就触发 | **Jenkins**（或 GitHub Actions），它调 MXT 的 API 建 run |
| 预构建 e2e 镜像（如果将来改这个形态） | **Jenkins** |

### 界面在哪一边

**测试同学和管理员不进 Jenkins。** 分工是：

```
Jenkins  = 构建 + 触发        基础设施，只有运维打开
   │
   │ 调 POST /api/v1/tasks/:id:run
   ▼
MXT      = 界面 + 用例语义 + 报告 + 历史       所有人打开这里
```

理由不是偏好，是 Jenkins 装不下这些东西：它的"构建历史"没有用例概念，
所以做不了 drift（登记了但没跑到）、flaky 计分、单条用例的趋势；
它的报告是构建日志不是用例结果；它的权限模型和"谁能看哪个应用的测试"无关。

反过来，MXT 也不该去做构建调度——那是 Jenkins 十年前就解决的问题
（[14 §4](14-ci-runners-and-stack.md#4-jenkins-放哪)：Jenkins 放 `mx-base`，
不放 MXT，避免"CI 构建 MXT，而 MXT 装着 CI"的循环）。

---

## 6 · 这一步之后还差什么

| 缺口 | 影响 |
| --- | --- |
| **失败通知** | 定时跑起来后最要紧的一件事 |
| 产物定时清理 | 现在靠人跑 `manage.sh clean`（已含 docker 悬空镜像与构建缓存回收） |
| 分片 | 一个 Job 串行跑完整个 suite；用例变多后墙钟时间线性增长 |
| flaky 计分与 quarantine | 只在文档里 |
| `real` profile 的环境与只读账号 | 09 号文档开放项 #1，至今未定 |
| 本地 runner 不会 clone / 不下载安装包 | Electron 的无人值守做不了，见 [14 §3](14-ci-runners-and-stack.md#3-临时执行机) |
