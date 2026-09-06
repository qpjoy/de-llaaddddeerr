# 14 · CI、执行机与技术栈选型

> 本文承接 [13](13-platform-review-and-redesign.md)，把它列为"必须现在拍板"的三个问题
> 落成决定，并记录 2026-08-31 这一轮上机前修复。
> 13 号文档的分层结论不变；变的是 L2/L3 用什么、放在哪。

---

## 0 · 这一轮定下来的

| # | 问题 | 决定 |
| --- | --- | --- |
| 1 | 执行编排选什么 | **Jenkins**。不装 GitLab |
| 2 | Jenkins 放哪 | **新建 `electron-dock/mx-base`**，不放 MXT，不放 mx-common |
| 3 | 有没有常驻 Windows | **没有**。改做**自助临时执行机**（[§3](#3-临时执行机)） |
| 4 | 是否预构建镜像 | **保留运行期 clone**，但必须是"指定 ref 的 clone"（[§2](#2-为什么保留-clone)） |
| 5 | 数据库 | **MXT 自带独立 PostgreSQL 实例**，不与 mx-insight-hub 共实例（[§1](#1-数据库红线)） |
| 6 | 主语言 | **UI/E2E 全程 Node；LLM eval 谁的服务谁的语言**。统一的是契约不是语言（[§5](#5-语言分轴)） |

---

## 1 · 数据库红线

### 现状核查结论

MXT **没有**使用 mx-common 的存储。核查结果：

| 项 | 事实 |
| --- | --- |
| 代码耦合 | 只 `import { runMigrations } from '@qpjoy/mx-common/postgres'` —— 一个函数，纯代码复用 |
| 表 | 全部 `mxt_` 前缀，独立 `mx_test` 库，无共享表 |
| 任务队列 | 明确不使用 mx-common 的 job queue（`server/migrate.mjs` 有注释） |
| 连接 | `MXT_DATABASE_URL` 完全外部注入 |

**但 ADR-0004 只做到"独立库"，那不够。** 独立库仍然共享实例，而实例级共享的是
连接数、page cache、autovacuum 工作线程和一次重启。MXT 的写入模式是
"每次 run 写几百行 → 保留期到了批量 DELETE"，产生的 dead tuple 和 vacuum 压力
由这个实例上的每个库共同承担，包括 insight-hub 的。

### 决定

**MXT 自带 PostgreSQL 实例**，在自己的 namespace、自己的磁盘上：
`deploy/k8s/internal/15-postgres.yaml`。

- `manage.sh deploy` 在 `MXT_DATABASE_URL` 未设置时自动拉起它，密码自动生成并留在
  Secret 里，重复 deploy 会从 Secret 读回而不是轮换。
- 设了 `MXT_DATABASE_URL` 就跳过自建，指向外部实例——这是将来接管理实例的路径。
- NetworkPolicy 限制这个库只接受 MXT 自己的 pod。
- `.env.internal` 现在**只有 `MXT_ADMIN_TOKEN` 是必填的**。

代价：一个 pod、20Gi 磁盘。按 23 用例 × 24 次/天的量级，`mxt_run_cases` 一年不到 1GB，
20Gi 是给 5 年 + 索引留的余量。

**外部测试仍可调用 mx-common 里的数据**——那是被测对象走它自己的接口，与 MXT 存自己的
结果是两件事，不冲突。

---

## 2 · 为什么保留 clone

13 号文档主张预构建镜像替代运行期 `git clone + install`。**这一轮决定先不做**，理由是
运维现实压过了理论收益：

- 只有一台服务器。预构建镜像意味着每个分支一个 tag，镜像层很快吃掉几十上百 GB，
  而 500GB 盘还要装别的东西。
- **按分支测不同环境**是当前的核心用法。clone 指定 ref 天然支持它；镜像方案要为每个
  分支跑一次构建，反馈链变长。
- 平台还没上线，被测面还要扩到 web / app / electron / agent 四类。这个阶段锁死
  "每个应用一个 e2e 镜像"的形态太早。

**但 13 号文档指出的问题是真的，只是修法不同**。保留 clone 的前提是把它修对：

| 原来 | 现在 |
| --- | --- |
| `git clone --depth 1` 只能拿默认分支 HEAD | `git init` + `fetch --depth 1 origin <ref>` + `checkout FETCH_HEAD`，ref 来自 `run.sourceRef.ref` → `app.defaultBranch` → `HEAD` |
| `source_ref` 字段声明了但从不写入 | `git rev-parse HEAD` 读回真实 sha，随 summary 一起回平台 |
| `pnpm install \|\| npm install` 静默降级 | 按 lockfile 选包管理器，**不互相兜底**，失败即 `blocked` |
| `\|\| true` 吞掉安装失败 | 删除。装挂了就是 `blocked`，附原因 |
| 私有仓库无凭据 | `MXT_GIT_TOKEN` 经 credential helper 注入，**不进 URL、不进 `.git/config`、不进进程表** |
| 产物无处清理 | `/work` 改为 emptyDir，随 Pod 消失；`sizeLimit` 默认 10Gi 防单次跑飞撑爆节点 |

**镜像方案没有被否决，只是延后。** 触发条件写在这里，到了就做：单次 run 的
install 时间超过测试时间本身，或者定时任务频率高到每天在装依赖上花掉一小时以上。

### 硬盘上真正要盯的

不是 Jenkins，是这三样。**现在就要有规则，不要等盘满**：

| 项 | 规则 |
| --- | --- |
| 基础镜像（`cypress/included` ~5GB、`playwright` ~3GB） | 固定版本，不跟 latest。每个引擎只留 2 个版本 |
| 录像 / trace | **只留失败用例的**。通过的用例录像没人看，却占 90% 空间 |
| emptyDir 工作区 | 随 Pod 消失，无需清理（已做） |
| `mxt_run_cases` | 永久保留。它是趋势的唯一来源，且一年不到 1GB |

备份到 OSS 的只有三样，其余全部可重建：`pg_dump mx_test`（每晚）、
JUnit + summary.json（写入即传，KB 级）、**发布节点**的镜像（不是每次 CI 的）。
录像和 HTML 报告不进 OSS，它们有生命周期就够了。

---

## 3 · 临时执行机

没有常驻 Windows 机器。11 号文档的降级语义（`pending-runner` 排队 → 12 小时无人认领
标 `expired`，不算失败）在这个前提下正好是对的答案，保留。

在它之上补**自助接入**，让"需要的时候上来跑一遍"成本足够低：

```
平台页面「接入我的电脑」
  → 生成一次性注册码（15 分钟有效，绑定用户身份 + 授权的 app 范围）
  → 页面按 User-Agent 给对应的一行安装命令
  → runner 注册，上报能力 {os, arch, engines, surfaces}
  → mxt-runner watch --ttl 4h    临时机：到期自动注销，不留僵尸条目
```

与常驻机的区别只在 `ephemeral` 标记：临时 runner 离线后直接从列表移除，
而不是标灰等它回来。

### macOS 支不支持

分三层回答，因为"支持"在这里有三个不同的含义：

| 层 | Windows | macOS | Linux |
| --- | --- | --- | --- |
| **runner CLI 本身**（claim / 执行 / 上传） | ✅ | ✅ | ✅ |
| **有被测产物可跑** | ✅ `.exe` | ✅ `.dmg` | ❌ compass 不出 Linux 桌面包 |
| **`_electron.launch()` 能拉起打包产物** | 大概率可以 | **未知，必须先 spike** | — |

macOS 的具体障碍：Playwright 的 `_electron.launch()` 实现是给进程加 `--inspect=0`
再从 stderr 解析 DevTools 端口。**签名 + hardened runtime 的 `.app` 可能拒绝
`--inspect`**，导致连不上。绕法是加 `com.apple.security.cs.allow-jit` /
`disable-library-validation` entitlement，或专门产出一个未强化的 e2e 构建。

所以结论是：**Linux 临时机不开放**（没有桌面产物可测，Web 本来就由服务端 Job 跑）；
Windows 与 macOS 都开放，但 macOS 要在第 1 周的 spike 里一起验证，
否则会落到"Windows 能跑、Mac 跑不了"的半截状态而没人知道是为什么。

### 临时机的安全边界

临时 runner 跑在别人的私人电脑上，且会拿到被测应用的测试账号凭据。因此：

- 注册码绑定 app 作用域，一台临时机只能领它被授权的 app 的任务
- run token 单 run 作用域，run 终结即失效（[ADR-0005](adr/0005-federated-identity-and-runner-tokens.md) 已定）
- **新增规则：临时机不派 `real` profile 的任务。** `real` 碰真实测试环境和真实测试账号，
  只派给显式标记为可信的常驻机。临时机只跑 mock

---

## 4 · Jenkins 放哪

### 决定：新建 `electron-dock/mx-base`

三个候选各自的问题：

| 候选 | 判断 |
| --- | --- |
| 放 `mx-common` | ❌ **类别错误**。mx-common 是 npm 包，靠链接复用代码；Jenkins 是部署出来的服务。往库里塞一个服务，两边的版本语义都会坏掉 |
| 放 `mx-test-framework` | ❌ **循环依赖**。Jenkins 要构建 launcher、insight-hub、MXT 自己。把它装在 MXT 里，`manage.sh down` 就能把所有项目的 CI 一起关掉，而 MXT 又是 Jenkins 构建的对象之一 |
| 新建 `mx-base` | ✅ 共享平台设施的正确归属：Jenkins，将来的镜像仓库、MinIO、Argo |

`mx-base` 只有一个 Jenkins 时也成立——边界对了，东西会自己长进来。

**硬约束（与 MXT 自己那条同构）**：`mx-base` 不可用时，MXT 必须仍能部署和跑任务。
Jenkins 负责的是"构建被测产物"和"定时触发"，不是 MXT 的运行时依赖。

### Jenkins 怎么装才不吃盘

关键是**别让它持有工作区**：

- controller 跑在 k8s，用 **kubernetes-plugin**，每个构建起一个临时 agent Pod，
  workspace 随 Pod 消失 → `JENKINS_HOME` 稳定在 ~20GB 而不是无限增长
- **JCasC + job-dsl**：配置写成 git 里的 yaml，Jenkins 变成可重建的无状态组件，
  **不需要备份**。重装 20 分钟
- `buildDiscarder` 定死构建历史保留数

对比 GitLab CE：安装包 3GB，但完整 forge（仓库 + registry + artifacts + Postgres +
Redis + Gitaly）稳态 100–200GB 起，还要 8GB RAM。代码已经在 GitHub 上，为了 CI 引入
一整套 forge 是全场最差的性价比。**不装。**

> 服务器能出网访问 github.com（走代理）。所以 GitHub Actions self-hosted runner
> 也是可行的，且更省（runner 是个 200MB 二进制，无服务端）。选 Jenkins 是明确的决定，
> 不是被迫——但如果将来嫌 Jenkins 维护成本高，这是那条退路。

---

## 5 · 语言分轴

**不统一语言，统一契约。** 契约是：

> 容器镜像进 → **JUnit XML** 出 → 退出码 0 / 1 / 2

这是"与技术栈无关"的唯一技术定义。守住它，Cypress、Playwright、pytest、k6、go test
全都能接，换 CI 也只是换触发器。Jenkins 并不比 Argo 或 GitHub Actions 更"栈无关"。

| 轴 | 语言 | 理由 |
| --- | --- | --- |
| **UI / E2E** | **必须 Node** | ① Playwright 的 `_electron` 只有 Node 绑定，选 pytest 等于放弃 Electron 主进程能力；② [ADR-0003](adr/0003-git-owned-case-source-of-truth.md) 定了用例住在被测仓库里，compass 是 Quasar + Electron，塞第二套工具链是纯负担；③ 选择器和 `data-test` 的知识和前端是同一批人 |
| **LLM eval** | 谁的服务谁的语言 | langgraph.js 的编排用 TS（promptfoo）能共享 fixture；同事的 Python agent 用 pytest + DeepEval。**平台一行不用改** |

---

## 6 · LLM 评测的位置

13 号文档没覆盖这一块，补在这里。

**核心原则：LLM 评测的输出是分数，不是布尔值。绝不能让它进 e2e 的 pass/fail 判定。**
一旦让 judge 决定红绿，会得到一个每天随机变红的看板，三个月内团队学会无视它——
和 flaky 的死法完全一样（[13 §4.3](13-platform-review-and-redesign.md#43-flaky-治理)）。

形态：`suite.kind = 'eval'`，判定规则是**阈值 + 相对基线的回归幅度**，
分数写进 `mxt_run_cases` 的 metrics。判红条件是"均分较基线下降超过 X%"，
不是"这条低于 0.8"。

| 需求 | 工具 |
| --- | --- |
| eval-as-CI（数据集 + judge + 断言 + 出 JUnit） | **promptfoo**：OSS、YAML 配置、TS 原生、直接出 JUnit XML |
| 追踪 / 数据集 / 人工标注 | **Langfuse 自托管**：OSS、可完全内网、有 Node SDK |
| LangSmith | ⚠️ SaaS，数据要出内网；自托管需企业授权。Internal 环境基本不可行 |

---

## 7 · mx-insight-hub 的 agent 编排

这里有一个必须先拆开的歧义，两种读法导向完全相反的架构：

| 读法 | 归属 |
| --- | --- |
| **测试** insight-hub 的 agent 编排（DAG 结果对不对、text2sql 生成的 SQL 对不对） | ✅ **走 MXT**，作为 §6 的 `eval` suite |
| insight-hub **在生产里**用 MXT 调度它的 agent 作业 | ❌ **不行** |

第二条不行的理由和 [ADR-0001](adr/0001-standalone-platform.md) 把 MXT 挡在 mx-launcher
之外是同一条：**测试平台是变更最频繁的组件之一**（新 runner、新引擎、新报告格式）。
让数据平台的生产调度依赖它，等于把 QA 的变更节奏绑到数据服务的可用性上。

两者确实有共同需求——"跑一个容器、收一个结果、留一份历史"。但那个共享件是
**`mx-base` 里的编排器（Jenkins / 将来的 Argo）**，不是 MXT。MXT 在它之上加的是
用例目录、drift 和用例级历史，那是测试语义，数据平台的作业调度用不上。

---

## 8 · 这一轮的代码改动

上机前修复，全部有测试覆盖（`tests/dispatcher.test.mjs`，新增 15 条；套件 97/97 绿）。

| # | 问题 | 严重度 | 改动 |
| --- | --- | --- | --- |
| 1 | `suite.command` 是 API 可写的任意命令 → 集群内 RCE，且容器带着平台签发的 run token | **高** | 白名单：只允许 `pnpm/npm/yarn/make` 调用**被测仓库里的具名入口**（package.json script 或 make target）。命令经 `MXT_COMMAND_JSON` 以 argv 传递，容器内用 `spawnSync(..., {shell:false})` 执行，**从不经过 shell** |
| 2 | summary.json 损坏时退出码仍为 0 → 平台按"以退出码为准"判成**绿色** | **高** | 解析失败时把退出码一并改成 2，容器以生效后的码退出 |
| 3 | `pnpm install \|\| npm install` 静默降级 | 中 | 按 lockfile 选包管理器，不互相兜底，失败即 `blocked` |
| 4 | `\|\| true` 吞掉安装失败 | 中 | 删除 |
| 5 | 无法 checkout 指定 ref，`source_ref` 从不写入 | 中 | fetch 指定 ref + `rev-parse` 读回真实 sha |
| 6 | 上报失败只 `echo` 一句，`exit 0` 让 k8s 永远看到成功 | 中 | 重试 3 次；仍失败则 `exit 75`，Job 显示失败 |
| 7 | 私有仓库无凭据 | 中 | credential helper 注入，token 不落盘不进 URL |
| 8 | 工作区无清理，与产物同卷 | 中 | `/work` 改 emptyDir + sizeLimit |
| 9 | 容器无 securityContext | 中 | `allowPrivilegeEscalation: false` + `seccompProfile: RuntimeDefault` |
| 10 | 与 insight-hub 共 PostgreSQL 实例 | 中 | 自带独立实例（§1） |
| 11 | dispatcher **零测试覆盖** | 中 | 新增 18 条 |
| 12 | `docker build` 上下文是 `electron-dock/` 且**无 `.dockerignore`**，实测 **2.4GB**（mx-launcher 的 4 个 node_modules） | 中 | 新增 `electron-dock/.dockerignore`，降到几 MB |
| 13 | `deploy` 每次重建 `:latest`，旧镜像变 `<none>` 悬空堆积 | 中 | `manage.sh clean` 增加 `docker image prune` + `builder prune`，并打印 `docker system df` |
| 14 | **无法接入 monorepo**：po-frontend 的 `package.json` / `pnpm-lock.yaml` / `cypress/` 都在 `po-frontend/` 子目录，而 runner 只在检出根工作 | 高 | 新增 `suite.workingDir`（迁移 004），服务端容器与本地 runner 都按它切目录 |
| 15 | 上一轮加的 `app.defaultBranch` **两个 store 都没落库**，postgres 与内存态都会静默丢弃 → `sourceRefFor` 永远退回 `HEAD` | 高 | 迁移 004 加列，两个 store 补映射；已用真实 API 往返验证 |

**没有做 `runAsNonRoot` / `readOnlyRootFilesystem`**：官方 Cypress / Playwright 镜像的
entrypoint 假定 root 且需要可写根文件系统，改了要在真机上确认浏览器还能起。
留作上机后的跟进项，而不是把一个没验证过的猜测当默认值发出去。

---

## 9 · 仍需拍板

| # | 问题 | 卡住什么 |
| --- | --- | --- |
| 1 | `real` profile 打哪个测试环境、用哪个只读账号 | 09 号文档开放项 #1，至今未定。只做 mock 轨也能上线，但 real 什么时候接要明确 |
| 2 | macOS 的 `_electron.launch()` spike 谁来做、在哪台机器上 | 决定 Mac 临时机是"能跑 Electron"还是"只能跑 Web" |
| 3 | `mx-base` 现在就建，还是等 Web 闭环跑通再建 | 建议：Web 闭环先用 MXT 自己的调度器跑通，`mx-base` 在第 4 周做定时与通知时一起上 |
