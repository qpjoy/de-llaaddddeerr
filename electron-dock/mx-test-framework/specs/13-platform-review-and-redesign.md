# 13 · 平台复盘与重构方案

> 立场：运维（SRE / 平台工程）+ 测试开发（SDET）双视角。
> 对象：`electron-dock/mx-test-framework` 现有 specs 与代码，以及被测目标
> `mingxi/luopan/po-frontend`（compass · Quasar Vue3 + Electron）。
> 结论先行放在 [§0](#0-结论先行)，论证在后。

---

## 0 · 结论先行

### 0.1 现状判断

设计文档（specs 00–12）的**判断力是够的**：0/1/2 退出码、`blocked ≠ passed`、零用例即受阻、
catalog drift（notRun / unmapped / duplicate）、三个分母不合并成一个"覆盖率"、
拒绝把运行时 AI 浏览器当日常执行器——这几条都踩在业界正确答案上，不是新手设计。

**"像玩具"的地方不在设计，在执行层的自制程度**。当前实现自己写了：调度器、k8s 派发器、
产物存储、报告渲染器、Web UI、结果归一、密钥注入。这七件事里有**五件**是 CI 系统和测试报告
系统已经解决了十年的问题，自制的版本必然在并发、可重复性、可观测性上落后一个数量级。

一句话：**你把 CI 重写了一遍，但真正差异化的只有"用例目录 + 用例级历史"那一层。**

### 0.2 建议的目标架构

```
┌─────────────────────────────────────────────────────────────┐
│ L4 控制面  mx-test-framework（保留、并收窄到这一层）           │
│   app/suite/case 目录 · task 定义 · run 索引 · 用例级历史     │
│   flaky 计分与 quarantine · 权限 · 分享链接 · 趋势            │
├─────────────────────────────────────────────────────────────┤
│ L3 报告    Playwright HTML/Trace + Allure（不再自研渲染）      │
│   交换格式：JUnit XML（底线）+ 引擎原生 JSON（增强）           │
├─────────────────────────────────────────────────────────────┤
│ L2 执行编排 Argo Workflows（CronWorkflow / 分片扇出 / 产物）   │
│   替代自研 scheduler.mjs + dispatcher.mjs + PVC 产物层        │
├─────────────────────────────────────────────────────────────┤
│ L1 执行镜像 每应用预构建 mxt/compass-e2e:<gitSha>             │
│   依赖与 SPA 产物烘焙进镜像，运行期不 clone 不 install         │
├─────────────────────────────────────────────────────────────┤
│ L0 执行环境 k8s Pod（Web） / 自托管本地 runner（Electron）     │
└─────────────────────────────────────────────────────────────┘
```

### 0.3 引擎选型（直接回答你的问题）

| 目标 | 工具 | 理由摘要 |
| --- | --- | --- |
| **po-frontend Web e2e（存量 23 用例）** | **保留 Cypress** | 已写好、fixture 齐、迁移无收益。补分片与 JUnit 输出即可 |
| **po-frontend Web e2e（新增用例）** | **Playwright** | 原生分片 + blob 合并 + Trace Viewer + `test.step()`，与 Electron 同一套 |
| **compass Electron e2e** | **Playwright `_electron`（首选）/ WebdriverIO + wdio-electron-service（打包产物兜底）** | 见 [§5](#5-electron-自动化方案) |
| **pytest / Playwright Python** | **不推荐用于 Electron** | Playwright 的 `_electron` **只存在于 Node.js 绑定**，Python/Java/.NET 都没有。选 pytest 等于放弃 Electron 主进程能力 |
| Spectron | **禁止** | 2022 年归档，Electron 14 起 EOL |

---

## 1 · 现有设计逐项复盘

### 1.1 做对的（保留，不要动）

| 设计 | 为什么是对的 |
| --- | --- |
| 退出码 0/1/2，`blocked` 永不算通过 | 与 Google "no tests ran is a failure" 一致。假绿是自动化测试第一大死因 |
| 零用例 = `blocked` | 同上。这条救过无数团队 |
| catalog drift 三分类 | 等价于 Xray / TestRail / Testmo 的"用例台账 ↔ 自动化"同步能力，是平台的**真正差异化**所在 |
| 三个分母分开展示，禁止单一"覆盖率" | 诚实。业界大量团队死在"90% 覆盖率"上 |
| runner 契约 = 环境变量进 / summary 出 | 正确的抽象边界。与 Buildkite agent、GitHub self-hosted runner 同构 |
| 本地 runner 认领桌面任务 | 与 Azure Pipelines self-hosted agent / GitLab runner 同构，是行业标准解法 |
| 拒绝"运行时 AI 驱动浏览器"当执行器 | 判断准确。不可复现的用例没人会信 |
| Agent 产物必须走 PR（ADR-0003） | 正确。未经 review 的测试代码，绿色无意义 |
| 独立数据库（ADR-0004） | 正确，测试平台不该和业务库同生共死 |

### 1.2 严重问题（P0，必须改）

#### ① 每次运行都 `git clone` + `pnpm install` —— 最致命的一条

`server/runner/dispatcher.mjs` 的 `script()`：

```sh
git clone --depth 1 ${app.repoUrl} /work || { echo "clone failed"; exit 2; }
[ -f package.json ] && (pnpm install --frozen-lockfile || npm install --no-audit --no-fund) || true
```

问题密度很高：

1. **不可复现**：`--depth 1` 只能拿默认分支 HEAD。`mxt_runs.source_ref` 字段声明要存
   `{gitSha, branch, version}`，但**代码里根本没有 checkout 指定 sha 的路径**。
   "上周三那次失败在哪个 commit" 这个问题现在答不出来 —— 而这正是平台存在的理由之一。
2. **热路径成本**：compass 的依赖树（quasar + electron + better-sqlite3 + cypress）冷装
   3–6 分钟。定时每晚跑 5 条 suite = 每天纯浪费半小时算力，且 npm registry 抖动直接变红。
3. **`|| npm install` 是静默降级**：pnpm lockfile 装失败时悄悄换 npm，依赖树完全不同，
   测试结果失去意义。
4. **`|| true` 吞掉安装失败**：装挂了继续跑测试命令，报错信息指向 `cypress: not found`，
   排查方向被带偏。
5. **私有仓库无凭据**：内网 GitLab 的 clone 会直接 `exit 2`，没有 credential 注入设计。
6. **compass 的 web e2e 还需要先 build SPA**（`pnpm e2e:local` 干的事），当前脚本完全没有
   这一步，只支持外部 `MXT_BASE_URL`。

**正确做法（Cypress / Playwright 官方文档都明确推荐）**：把依赖和构建产物**烘焙进镜像**。

```dockerfile
# apps/compass/e2e.Dockerfile —— 由 CI 在合并到主干时构建并打上 gitSha
FROM cypress/included:15.0.0
WORKDIR /work
COPY pnpm-lock.yaml package.json ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY . .
RUN pnpm build                 # 产出 dist/spa，e2e 时用静态服务直接起
ENV MXT_ENGINE=cypress
```

运行期就只剩：`docker run -e MXT_* mxt/compass-e2e:<gitSha> pnpm e2e:run:mock`。
启动 5 秒，完全可复现，`sourceRef` 天然等于镜像 tag。

> 收益量化：单次运行从 ~6 分钟降到 ~90 秒；失败原因里"环境问题"占比从经验上的 30–40%
> 降到接近 0。

#### ② 结果只靠 Job 末尾一次 `curl` 上报

```sh
printf '{"exitCode":%s,"summary":%s}' "$MXT_EXIT" "$(cat "$SUMMARY")" > /tmp/payload.json
curl ... || echo "failed to report result"
exit 0
```

- **Pod 被 OOMKill / 节点驱逐 / 抢占 → 没有任何上报**，run 卡在 `running` 直到 lease 过期。
  没有 Job 状态的 reconcile 循环，平台不知道 Job 已经死了。
- **`exit 0` 兜底**让 k8s 永远看到 Job 成功，Job 状态这一路信号被主动丢弃。
- ~~**`printf` 的 `%` 注入 bug**~~ —— **本条判断有误，已撤回**。`printf FORMAT ARG` 只解析
  *格式串* 里的 `%`，参数里的 `%` 原样输出。实测 `printf '{"s":%s}' '{"t":"95% ok"}'`
  输出正确。真正会损坏 payload 的是另一件事：**summary.json 本身不是合法 JSON**
  （容器写到一半被 OOMKill），此时 payload 变成 `{"exitCode":0,"summary":<半截>}`。
  更糟的是退出码仍是 0 —— 而平台规则是"冲突时以退出码为准"，于是一次损坏的执行被判成
  **绿色**。修法不是换 `printf`，是让归一步骤在解析失败时把退出码一起改成 2。
- **无日志留存**：08 号文档自己写了"实时展示标准输出"，但没有日志管道。
  `ttlSecondsAfterFinished: 3600` 之后 Pod 日志随之消失。

**正确做法**：执行编排交给有状态机的引擎（Argo Workflows / Tekton / GitLab CI），
它们内建 Pod 状态 reconcile、日志归档、产物上传、失败原因分类。

#### ③ 完全没有并行 / 分片

一个 Job 串行跑完整个 suite。`mxt_runners.capabilities.concurrency` 定义了但从未被读取；
`dispatchQueued` 是 `listRuns({limit:10})` 的朴素循环，没有并发上限、没有队列公平性、
没有背压。

23 个用例现在还行，但"平台"的门槛是**测试时长不随用例数线性增长**。业界标准做法：

- **Playwright**：`--shard=1/4` 原生支持，各分片产 blob report，`npx playwright merge-reports`
  合并成一份 HTML/JUnit。这是最省事的一条路。
- **Cypress**：`--parallel` 需要协调服务（Cypress Cloud 收费，或自建
  [sorry-cypress](https://sorry-cypress.dev) 开源替代）。不想上协调服务就用
  `cypress-split`，按 spec 静态切分，且**可以用历史时长做加权切分**。
- **你已经有历史时长了**：`mxt_run_cases.duration_ms`。平台下发分片计划时按最近 N 次的
  p50 时长做装箱（LPT 贪心），能把长尾抹平——这是 Google TAP / Buildkite test-splitter
  的标准做法，而且**这是控制面该做的事，是平台真正该自研的部分**。

#### ④ 产物走 RWX PVC

`deploy/k8s/internal/10-artifacts-pvc.yaml` + Job 直接挂载写入。

- 多个 Job 并发写同一个 PVC 需要 **RWX** 存储类。单台 RHEL 上大概率是 hostPath 或
  临时 NFS，扩到第二个节点就废。
- 没有配额与背压：录像很占空间，PVC 写满 → 所有 Job 卡死 → 平台整体不可用。
- 清理靠 `manage.sh clean` 人工跑。

**正确做法：对象存储（MinIO / 内网 S3）**，配 lifecycle 规则自动过期。
这不是"做大之后的事"，它比 RWX PVC **更简单**：无需 RWX 存储类、无跨节点问题、
保留策略是一行 bucket 配置而不是一个脚本。Argo Workflows 内建 artifact repository，
直连 S3，连上传代码都不用写。

#### ⑤ suite.command 是任意命令 → 集群内 RCE

```js
command: ['pnpm', 'e2e:run:mock']   // 来自 API 写入的数据库字段
```

任何能调 `POST /api/v1/apps/:slug/suites` 的人，都能让集群执行任意命令，且容器里带着
平台签发的 `MXT_RUN_TOKEN`。`automountServiceAccountToken: false` 做得对，但还缺：

- `securityContext`: `runAsNonRoot`、`readOnlyRootFilesystem`（产物目录单独 emptyDir）、
  `allowPrivilegeEscalation: false`、`seccompProfile: RuntimeDefault`
- `command` 应当**不可由 API 自由写入**，而是从镜像内的 `mxt.suite.json`（随代码走 PR）
  读取，平台只选 suite 名。这与 ADR-0003"测试代码归 git"是同一条原则的延伸：
  **执行命令也是测试代码**。
- Egress NetworkPolicy 现在有，但要确认它禁止访问集群内其他业务服务与 metadata 端点。

#### ⑥ 自研 `summary.json` schemaVersion 2

每接一个新引擎就要写一个适配器。业界的通用解法是**先用通用交换格式兜底，再用原生格式增强**：

| 层 | 格式 | 谁产出 |
| --- | --- | --- |
| 底线（必须） | **JUnit XML** | Cypress（`cypress-multi-reporters` + `mocha-junit-reporter`）、Playwright（`--reporter=junit`）、pytest、WebdriverIO、go test…… 全都原生支持 |
| 增强（可选） | 引擎原生 JSON / [CTRF](https://ctrf.io) | Playwright JSON、mochawesome JSON |
| 富交互 | Playwright trace.zip / Allure results | 只有支持的引擎有 |

**建议**：`summary.json` 从"必填契约"降级为"可选增强"，ingest 的**主输入改成 JUnit XML**。
理由：任何团队接入新语言/新框架时零成本，这是"通用平台"的定义。
step / caseId / tracks 这些 JUnit 装不下的信息，走 `properties` 扩展或原生 JSON 补齐。

### 1.3 中等问题（P1）

| # | 问题 | 位置 | 建议 |
| --- | --- | --- | --- |
| 7 | 调度器无 leader election，`next_run_at` 轮询 | `server/scheduler.mjs` | 多副本会重复触发。要么锁死单副本 + `PodDisruptionBudget`，要么用 Argo CronWorkflow，要么 `SELECT ... FOR UPDATE SKIP LOCKED` |
| 8 | `MXT_CASE_FILTER` 契约定义了但派发器从不使用 | dispatcher | 用例级重试（05 号文档的 `retryPolicy`）实际无法实现。这是设计与实现的断层 |
| 9 | flaky 检测 / quarantine 只在文档里 | — | 见 [§4.3](#43-flaky-治理) 的具体算法 |
| 10 | 自研报告渲染 299 行 + 1096 行 vanilla JS UI | `server/report.mjs`、`web/assets/app.js` | 报告渲染是无底洞。改为托管 Playwright HTML report / Allure，平台只存指针 |
| 11 | "步骤 offsetMs → 录像跳转"要手工实现 | 05 号文档 | **Playwright Trace Viewer 免费给你更好的**：DOM 快照 + 网络 + 控制台 + 逐动作时间轴。自研的视频跳转性价比极低，建议直接砍掉换成 trace |
| 12 | CLI 登录用明文 password prompt，且支持 `--password` 传参 | `bin/mxt-runner.mjs` | `--password` 会进 shell history 和 `ps`。11 号文档说的是浏览器授权流，实现却是密码 grant。改为 device code flow |
| 13 | 密钥经 env 注入 | 04 号文档 | ~~改为挂载文件~~ → **结论相反，见 [20](20-secret-store.md)**：每个框架都从 env 读配置，改文件会摧毁零适配；且对本地执行机，文件会在崩溃后留在别人电脑上而 env 随进程消失。真正的防护是「不进 manifest / 不进 shell 环境 / 按精确值脱敏 / 加密落库」四条 |
| 14 | 无失败通知 | — | **没有通知的定时任务等于没跑**。见 [§4.4](#44-通知策略) |
| 15 | Case ID 靠标题正则关联 | 03 号文档第 2 级 | Playwright 用 `annotation`、Cypress 用 tag（`{ tags: ['@LP-FE-AUTH-001'] }`）更稳。存量保留正则，新用例强制注解 |

### 1.4 值得重新讨论的设计

**"双轨 functional / demo"**。05 号文档已经识别出"双轨是两份代码"的问题，方案是
"同一 spec 跑两条轨 + `tracks` 字段"。方向对，但可以更省：

- Playwright 的 **trace + video** 天然产出可给人看的东西；给客户看的"演示"其实是
  **报告的一种渲染**，不是**执行的一种模式**。
- 建议：**demo 不再是一条执行轨，而是对 functional 产物的一次后处理**——挑选
  `tracks: ["demo"]` 的用例，取它们的 video/trace，加旁白（`test.step()` 的 label 已经有了），
  拼成一份分享报告。执行只跑一次，成本减半，且演示的一定是真实通过的流程。
- 唯一损失是"每步停 900ms 让人看清"。这个可以用**报告里的分步截图 + 步骤旁白**替代，
  实际比看慢速视频更高效。

---

## 2 · 目标架构详解

### 2.1 L2 执行编排：为什么是 Argo Workflows

在已有 k8s 的前提下，Argo Workflows 一个组件同时替掉你现在自研的四块：

| 你现在自研的 | Argo 内建 |
| --- | --- |
| `server/scheduler.mjs`（cron 轮询） | `CronWorkflow`（含时区、并发策略 `concurrencyPolicy`、错过补跑 `startingDeadlineSeconds`） |
| `server/runner/dispatcher.mjs`（建 Job + 状态猜测） | Workflow controller，完整状态机 + 重试策略 + Pod GC |
| PVC 产物层 + 上传代码 | artifact repository（S3/MinIO），输入输出产物声明式 |
| 无 → 日志 | `archiveLogs: true` 自动归档到 S3 |
| 无 → 分片 | `withParam` / `withSequence` 扇出 + 汇聚步骤 |

一个分片 4 路 + 合并的 Workflow 骨架：

```yaml
apiVersion: argoproj.io/v1alpha1
kind: WorkflowTemplate
metadata: { name: mxt-web-e2e }
spec:
  entrypoint: main
  arguments:
    parameters: [{name: image}, {name: shards, value: "4"}, {name: runId}, {name: baseUrl}]
  templates:
    - name: main
      dag:
        tasks:
          - name: shard
            template: run-shard
            withSequence: { count: "{{workflow.parameters.shards}}" }
            arguments:
              parameters: [{name: index, value: "{{item}}"}]
          - name: merge
            template: merge-report
            dependencies: [shard]

    - name: run-shard
      inputs: { parameters: [{name: index}] }
      podSpecPatch: '{"containers":[{"name":"main","resources":{"requests":{"cpu":"1","memory":"2Gi"},"limits":{"memory":"4Gi"}}}]}'
      container:
        image: "{{workflow.parameters.image}}"          # 预构建镜像，无 clone / install
        command: [pnpm, "e2e:run:mock"]
        env:
          - { name: MXT_RUN_ID,   value: "{{workflow.parameters.runId}}" }
          - { name: MXT_BASE_URL, value: "{{workflow.parameters.baseUrl}}" }
          - { name: MXT_SHARD,    value: "{{inputs.parameters.index}}/{{workflow.parameters.shards}}" }
          - { name: MXT_ARTIFACTS_DIR, value: /artifacts }
        securityContext:
          runAsNonRoot: true
          allowPrivilegeEscalation: false
          seccompProfile: { type: RuntimeDefault }
      outputs:
        artifacts:
          - name: shard-out
            path: /artifacts
            archive: { none: {} }
            s3: { key: "runs/{{workflow.parameters.runId}}/shard-{{inputs.parameters.index}}" }
      retryStrategy:                                     # 只重试基础设施失败
        limit: 2
        retryPolicy: OnError                             # 注意不是 OnFailure：断言失败不重试
```

**关键点：`retryPolicy: OnError` 而不是 `OnFailure`。**
基础设施错误（镜像拉取失败、Pod 驱逐）重试；断言失败（退出码 1）不重试——
用例级重试是测试框架自己的事（Playwright `retries` / Cypress `retries`），
在编排层重试整个分片会污染 flaky 统计。

> **替代方案**：如果团队本来就重度使用 GitLab，直接用 **GitLab CI**：
> `parallel: 5` 做分片、`rules`/`schedules` 做定时、`artifacts:reports:junit` 做结果收集、
> `artifacts:expire_in` 做保留期。**零新增基础设施**，MXT 退化成"触发 pipeline + 收 JUnit"
> 的控制面。这是**最省事**的一条路，如果 GitLab 可用就选它。

### 2.2 L4 控制面：MXT 收窄后到底做什么

删掉执行与报告后，MXT 剩下的都是**别人不做而你需要**的：

1. **用例目录与 drift**（现有能力，最有价值，保留并强化）
2. **用例级历史表 `mxt_run_cases`**（保留）——这是 flaky 计分、分片装箱、
   "首次失败 commit" 的唯一数据源，Allure/GitLab 都做不好这件事
3. **flaky 计分与 quarantine 决策**（新建，见 §4.3）
4. **分片计划下发**（新建）——按历史时长装箱，把 shard 分配当作 API 返回给 runner
5. **任务定义与触发**（保留，但触发动作变成"提交 Workflow / 触发 pipeline"）
6. **本地 runner 注册与派活**（保留，Electron 必须靠它）
7. **权限与脱敏分享**（保留）
8. **通知**（新建）

对应的**代码删除清单**：

| 删 / 收窄 | 行数量级 | 替代 |
| --- | --- | --- |
| `server/report.mjs` | ~300 | Playwright HTML report / Allure |
| `web/assets/app.js` 的报告渲染部分 | ~600/1096 | 同上；UI 只留任务、run 列表、趋势 |
| `server/runner/dispatcher.mjs` 的 script 拼接 | ~120 | WorkflowTemplate（声明式 YAML） |
| `server/scheduler.mjs` | ~100 | CronWorkflow |
| `server/artifacts.mjs` 的存储实现 | ~150/209 | S3 presigned URL |

净减约 1200 行自研代码，换来并发、可复现、日志、保留策略、Trace Viewer。

---

## 3 · po-frontend Web e2e 详细方案（优先级最高）

### 3.1 存量评估

`public` 分支上的 23 个 Cypress 用例质量不错：

- `cypress.config.ts` 的 profile/track 正交设计、脱敏的 `sanitizeMetric`、
  `allowCypressEnv: false`、`api-metrics` 只记 method/path/status/duration ——
  这些都写得比多数团队好。
- `e2e-run.mjs` 里的 catalog 比对已经实现了 notRun / unmapped / duplicate。

**不要迁移到 Playwright。** 迁移 23 个用例的成本 ≈ 2 人周，收益 ≈ 0（这些用例现在就能跑）。

### 3.2 存量需要的四处改动（都很小）

**① 增加 JUnit 输出**（让平台不依赖自研 summary 也能吃结果）

```ts
// cypress.config.ts
reporter: 'cypress-multi-reporters',
reporterOptions: {
  reporterEnabled: 'cypress-mochawesome-reporter, mocha-junit-reporter',
  mochaJunitReporterReporterOptions: {
    mochaFile: path.join(runDir, 'junit/[hash].xml'),
    // 把 Case ID 放进 classname，平台可直接解析
    testsuitesTitle: false,
    jenkinsMode: true,
  },
},
```

**② 支持分片**（平台注入 `MXT_SHARD=2/4`）

```ts
const resolveSpecPattern = (): string[] => {
  const all = /* 现有逻辑返回的 glob 展开结果 */;
  const shard = process.env.MXT_SHARD;          // "2/4"
  if (!shard) return all;
  const [i, n] = shard.split('/').map(Number);
  // 平台下发的是显式 spec 列表时优先用它（按历史时长装箱的结果）
  if (process.env.MXT_SPEC_LIST) return process.env.MXT_SPEC_LIST.split(',');
  return all.filter((_, idx) => idx % n === i - 1);
};
```

> 更好的形态：平台直接下发 `MXT_SPEC_LIST`（按 `mxt_run_cases.duration_ms` 的 p50 做 LPT 装箱），
> 配置里只负责消费。取模切分是没有历史数据时的退化路径。

**③ 打开用例级重试**

```ts
retries: { openMode: 0, runMode: Number(process.env.MXT_RETRIES || 1) },
```

现在是 `runMode: 0`。05 号文档已经论证过：手跑时 0 是对的，定时跑必须给 1 次。
Cypress 的 retry 是**用例级**的（只重跑失败的 test），正合需要。
重试信息通过 `attempts` 进 summary，平台据此判 flaky。

**④ 会话改成编程式登录**（这是可靠性收益最大的一处）

现状 `cypress/.auth-session.json` 靠人工 `pnpm e2e:login` 捕获——无法无人值守，
且过期即全红。改法：

```ts
// cypress/support/commands.ts
Cypress.Commands.add('loginByApi', (username: string, password: string) => {
  cy.session([username], () => {
    cy.request('POST', '/api/auth/login', { username, password }).then(({ body }) => {
      window.localStorage.setItem('authStore', JSON.stringify({ token: body.token }));
    });
  }, { cacheAcrossSpecs: true, validate() { cy.request('/api/user/me').its('status').should('eq', 200); } });
});
```

- `cy.session` + `cacheAcrossSpecs` → 整个 run 只真实登录一次，其余用例秒进。
- 账号密码由平台注入 `MXT_SECRET_USERNAME/PASSWORD`，**平台只存账号不存会话**
  （04 号文档已经这么设计了，实现跟上即可）。
- **保留一个走 UI 的登录用例**（`LP-FE-AUTH-001`），确保登录页本身有覆盖。

> 这一条单独就能消掉 real profile 的大部分噪声。业界共识：
> **UI 登录只测一次，其余全部编程式建立会话。**

### 3.3 mock vs real 的正确分工

| profile | 打哪 | 跑什么 | 频率 | 判定 |
| --- | --- | --- | --- | --- |
| `mock` | 镜像内起的静态 SPA（`dist/spa`） | 全部 23 用例 | 每次合并 + 每小时 | 前端契约回归。**后端挂了它也该绿** |
| `real` | 测试环境 | smoke 子集（5–8 条 P0） | 每晚 | 端到端连通性。红了要么后端变了要么环境挂了 |

关键：**mock 轨绝不依赖网络**。镜像里 `pnpm dlx serve dist/spa` 起本地服务，
`MXT_BASE_URL=http://127.0.0.1:5555`。这样 mock 轨的失败**一定是前端代码问题**，
信号纯净——这是它值得每次合并都跑的前提。

### 3.4 新增用例用 Playwright

新写的 Web 用例建议直接 Playwright，与 Electron 共用一套技能与报告：

```ts
// testing/playwright/web/strategy.spec.ts
import { test, expect } from '@playwright/test';

test('策略中心保存草稿后可回填', {
  annotation: [{ type: 'case', description: 'CPS-FE-STRATEGY-003' }],
}, async ({ page }) => {
  await test.step('进入策略中心', async () => {
    await page.goto('/strategy');
    await expect(page.getByTestId('strategy-list')).toBeVisible();
  });
  await test.step('填写并保存草稿', async () => {
    await page.getByTestId('strategy-name').fill('测试策略');
    await page.getByRole('button', { name: '保存草稿' }).click();
    await expect(page.getByText('已保存')).toBeVisible();
  });
});
```

- `annotation` 直接携带 Case ID → 03 号文档的"第 1 级关联"，不依赖标题正则。
- `test.step()` 与你设计的 step 模型 1:1 对应，且 **Playwright 自动记录每步耗时并写进
  trace**，`offsetMs` 免费获得，不需要自研。
- 两套引擎共存不冲突：suite 声明 `engine: cypress | playwright`，平台按引擎选镜像。

### 3.5 稳定性硬规则（写进 `mxt lint`）

| 规则 | 理由 |
| --- | --- |
| 禁止 `cy.wait(<number>)` / `page.waitForTimeout()` | 固定等待是 flaky 的头号来源。等请求别名或元素状态 |
| 选择器优先级：`data-test` > `getByRole` > 文案 > CSS | CSS 路径随重构断裂 |
| 每个用例至少一条非"存在性"断言 | 防止"看起来测了很多"的空用例（07 号文档已列，做成 lint） |
| 涉及接口的用例必须断言 method + path + 关键参数 | 只断言 200 等于没测 |
| `real` profile 默认只读，写操作须声明 `writesData` 并附清理 | 共享环境的数据污染会拖垮所有人 |
| 每个 spec 独立可跑，禁止跨 spec 顺序依赖 | 分片的前提条件 |

最后一条是**分片的硬前提**，现在就要立规矩，否则将来切不开。

---

## 4 · 定时任务与运维

### 4.1 调度形态

```
每次合并到主干  → 构建 mxt/compass-e2e:<sha> → 触发 mock 全量（4 分片，~3 分钟）
每小时           → mock 全量（回归看门狗）
每晚 02:00       → real smoke（测试环境）+ Electron 打包冒烟（本地 runner 排队）
每周一 08:00     → flaky 周报 + catalog drift 周报
```

用 Argo `CronWorkflow`：

```yaml
apiVersion: argoproj.io/v1alpha1
kind: CronWorkflow
metadata: { name: compass-web-nightly }
spec:
  schedule: "0 2 * * *"
  timezone: "Asia/Shanghai"
  concurrencyPolicy: Forbid        # 上一次没跑完就跳过，避免叠加
  startingDeadlineSeconds: 3600    # 控制面挂了 1 小时内恢复仍补跑
  failedJobsHistoryLimit: 5
  workflowSpec:
    workflowTemplateRef: { name: mxt-web-e2e }
```

`concurrencyPolicy: Forbid` 很重要：测试任务变慢时最怕的是任务叠加把集群打满。

### 4.2 保留策略

| 产物 | 保留 | 机制 |
| --- | --- | --- |
| `summary.json` / JUnit | 永久（KB 级） | S3 |
| HTML 报告 | 90 天 | S3 lifecycle |
| trace.zip | 30 天（只留失败的） | Playwright `trace: 'retain-on-failure'` + lifecycle |
| 视频 | 14 天（只留失败的） | `video: 'retain-on-failure'` |
| `mxt_run_cases` 行 | 永久 | Postgres，趋势的唯一来源 |

**只保留失败用例的视频/trace** 是关键：通过的用例的视频没人看，却占 90% 空间。
Playwright 的 `retain-on-failure` 原生支持；Cypress 用
`videoCompression` + `after:spec` 钩子删掉全绿 spec 的视频。

### 4.3 flaky 治理

具体算法（放在 MXT 控制面，因为只有它有用例级历史）：

```
对每个 (app_id, case_id) 取最近 N=20 次 run：
  flip = 相邻两次结果不同且期间 sourceRef.gitSha 未变 的次数
  flakeScore = flip / (N-1)

flakeScore >= 0.3  → 标记 quarantine
  · 仍然执行、仍然记录
  · 不计入 run 的 pass/fail 判定
  · 不触发告警
  · 进「待修复」列表，附最近 5 次失败的 error_text 聚类

连续 10 次稳定通过 → 自动解除 quarantine
quarantine 超过 30 天未修 → 升级提醒 owner，或按规则退休
```

对应引擎侧配置：Playwright `retries: 1` + `--fail-on-flaky-tests`（CI 上让 flaky 可见），
Cypress `retries.runMode: 1`。**重试转绿不算失败但必须单独计数**——05 号文档写对了。

> 参考：Google《Flaky Tests at Google and How We Mitigate Them》给出的经验是
> 1.5% 的测试运行结果会不稳定；不做 quarantine，团队会在 3 个月内学会无视红灯。

### 4.4 通知策略

**没有通知的定时任务等于没跑。** 但更常见的死法是通知太多。规则：

| 事件 | 通知？ | 去哪 |
| --- | --- | --- |
| 状态由 passed → failed（**新失败**） | ✅ 立即 | 企业微信/飞书群 + owner |
| 连续失败第 2 次起 | ❌ 静默 | 只更新看板 |
| failed → passed（恢复） | ✅ 一条恢复消息 | 同群 |
| `blocked`（基础设施） | ✅ 立即 | **运维群**，不是业务群 |
| `expired`（本地 runner 没上线） | ❌ | 列表标灰即可（11 号文档已定，正确） |
| flaky | ❌ 实时 | 进周报 |

**只在状态跃迁时通知**——这是告警疲劳的唯一解药。消息体要带：run 链接、失败用例名、
错误首行（脱敏后）、上次通过的 gitSha。

### 4.5 该盯的指标

| 指标 | 目标 | 说明 |
| --- | --- | --- |
| 分片后 suite 墙钟时长 p95 | < 5 min | 超了就加分片 |
| flake rate（flaky 用例数 / 总用例数） | < 3% | 超了停止加新用例，先修 |
| `blocked` 占比 | < 2% | 这是平台自身的 SLI，基础设施问题占比 |
| 新失败到通知的时延 | < 2 min | |
| catalog drift（unmapped + notRun） | 0 | 每周清零 |

`blocked` 占比是**平台团队自己的 KPI**，把它和业务失败分开看，
否则平台的问题会被算成"测试不稳定"。

---

## 5 · Electron 自动化方案

### 5.1 先划边界：compass Electron 哪些该做 e2e

`src-electron/` 里已经有 ~25 个 `*.test.js`（launcher-user-auth、tunnel-resilience、
mihomo-proxy-integration、routing-manager……）。这些是**主进程单元/集成测试，
应该继续留在单元层**，不要往 e2e 搬。

| 层 | 测什么 | 工具 | 数量级 |
| --- | --- | --- | --- |
| 单元（已有） | 路由计算、凭据存储、更新检查、PowerShell 参数拼接 | node:test（现状） | 数十 |
| 主进程集成 | IPC 契约、窗口管理、菜单、协议注册 | Playwright `_electron` + `electronApp.evaluate()` | 10–15 |
| 打包冒烟 | 冷启动、登录、主界面可交互、无提权弹窗、自动更新可达 | Playwright `_electron`（打包二进制）/ WebdriverIO | **5–8 条，就够了** |
| 安装器 | 静默安装/卸载 | PowerShell / shell 脚本，不进 e2e | 2 |

**明确不做 e2e 的**：WireGuard / OpenVPN / mihomo 真实建隧道。理由不是做不到，
而是它会改执行机的系统路由——与你"不要影响 MX-H2I 用户联网"的约束直接冲突。
这些用 §5.5 的方式处理。

### 5.2 方案 A（首选）：Playwright `_electron`

```ts
// testing/playwright/electron/boot.spec.ts
import { test, expect, _electron as electron } from '@playwright/test';

test('打包应用冷启动进入主窗口且不请求提权', {
  annotation: [{ type: 'case', description: 'CPS-EL-BOOT-001' }],
}, async () => {
  const app = await electron.launch({
    executablePath: process.env.MXT_APP_PATH,       // 平台注入：打包后的 .exe / .app 内的可执行文件
    args: ['--mxt-e2e'],                            // 应用侧据此禁用自动更新、跳过引导
    env: { ...process.env, COMPASS_E2E: '1', COMPASS_SKIP_LAUNCHER_BOOTSTRAP: '1' },
    recordVideo: { dir: `${process.env.MXT_ARTIFACTS_DIR}/videos` },
  });

  // 主进程内断言——这是 Playwright 相对其他方案的独有能力
  const info = await app.evaluate(async ({ app }) => ({
    version: app.getVersion(),
    packaged: app.isPackaged,
  }));
  expect(info.packaged).toBe(true);

  const win = await app.firstWindow();
  await expect(win.getByTestId('app-shell')).toBeVisible({ timeout: 30_000 });
  await win.screenshot({ path: `${process.env.MXT_ARTIFACTS_DIR}/screenshots/boot.png` });
  await app.close();
});
```

**优点**

- 与 Web 用例**同一个框架、同一份配置、同一份报告、同一个 trace viewer**。团队只学一次。
- `electronApp.evaluate()` 能在主进程里跑代码 —— 可以直接断言 IPC、桩掉原生对话框：

  ```ts
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  });
  ```

  这一条对 compass 尤其有用：更新提示、退出确认、证书授权弹窗都能桩掉，否则 e2e 会卡死。
- 多窗口、`BrowserView`、通知都能拿到。
- VS Code 自身的 smoke test 就是这条路，规模验证过。

**限制与风险（必须提前验证）**

1. **只有 Node.js 绑定有 `_electron`。Python / pytest / Java / .NET 全都没有。**
   这是选型的决定性事实——如果坚持 pytest，Electron 只能走 WebdriverIO 或 Appium。
2. `_electron.launch()` 的实现是给进程加 `--inspect=0 --remote-debugging-port=0`，
   然后从 **stderr 里解析 `DevTools listening on ws://...`** 来连 CDP。
   因此：
   - **macOS 打包并签名（hardened runtime）的 app 可能拒绝 `--inspect`**，
     导致连不上。需要在测试构建里加 `com.apple.security.cs.allow-jit` /
     `disable-library-validation` 等 entitlement，或**专门产出一个未强化的 e2e 构建**。
   - `executablePath` 在 macOS 上要指到 `Compass.app/Contents/MacOS/Compass`，
     不是 `.app` 目录本身。
   - compass 用了 `electron-bootstrap.cjs` 做自定义引导，要确认它不吞掉命令行参数。
3. 没有 `_electron.connect()`。若上面 launch 路径走不通，回退方案是：
   自己启动应用并传 `--remote-debugging-port=9222`，再用
   `chromium.connectOverCDP('http://127.0.0.1:9222')`。
   **代价是失去 `electronApp.evaluate()` 的主进程能力**，只能测渲染进程。
4. Playwright 官方标注 Electron 支持为 experimental —— 实际很稳，但升级 Playwright 时
   要跑一次 Electron 用例做回归。

**建议：第一周就做一个 spike**，只做一件事：能不能用 `_electron.launch` 拉起
`dist/electron/dmg` 和 `.exe` 的产物并拿到 `firstWindow()`。
这个结果决定方案 A 还是方案 B，别等到写完用例才发现连不上。

### 5.3 方案 B（打包产物兜底）：WebdriverIO + wdio-electron-service

```js
// wdio.conf.ts
export const config = {
  services: ['electron'],
  capabilities: [{
    browserName: 'electron',
    'wdio:electronServiceOptions': {
      appBinaryPath: process.env.MXT_APP_PATH,
      appArgs: ['--mxt-e2e'],
    },
  }],
  reporters: ['spec', ['junit', { outputDir: process.env.MXT_ARTIFACTS_DIR + '/junit' }]],
};
```

**什么时候选它**

- Playwright 连不上打包产物（尤其 macOS 签名问题）时。
  WDIO 走的是 **Chromedriver**（对应 Electron 版本的那个），路径与 `--inspect` 无关，
  对签名/强化运行时的兼容性更好。
- 需要它的 `browser.electron.mock('dialog', 'showOpenDialog')` 这类 Electron API mock 能力。
- 它能自动发现 electron-builder / electron-forge 的输出目录，省掉路径拼接。

**代价**：多一套框架、多一份配置、报告体系不同（好在 JUnit 是通的）。
**不要两套都上**——选一套，另一套只作为 spike 失败后的替代。

### 5.4 明确排除的方案

| 方案 | 判断 |
| --- | --- |
| **Spectron** | 2022 年归档，Electron 14 起 EOL。禁止 |
| **pytest + Playwright Python** | Python 绑定**没有** `_electron`。只能通过 `connectOverCDP` 测渲染进程，失去主进程能力。除非团队只有 Python 技能栈，否则没有理由 |
| **Appium + WinAppDriver** | WinAppDriver 事实上停更。只在需要测 Windows 原生控件（托盘菜单、UAC 弹窗、安装向导）时才考虑，且建议用脚本而非 e2e 框架 |
| **Cypress 测 Electron 应用** | 做不到。Cypress 内置的 "Electron browser" 是拿 Electron 当浏览器跑你的网页，不是驱动任意打包 Electron 应用。这是常见误解 |

### 5.5 网络相关功能怎么测（关键约束）

compass Electron 的核心复杂度在 launcher / WireGuard / 隧道，但**这些不能在 e2e 里真连**：
会改执行机路由，违反"不影响 MX-H2I 用户联网"的硬约束。

分层处理：

| 目标 | 做法 |
| --- | --- |
| 路由计算、配置生成、命令行拼接 | 已有的 `src-electron/*.test.js` 单元测试。**继续加这一层，性价比最高** |
| launcher 交互契约 | Playwright `_electron` + 在主进程里 stub `luopan-launcher-manager` 的出网调用（`app.evaluate` 注入替身） |
| UI 状态机（连接中/已连接/失败重试） | 桩掉底层后驱动 UI，断言状态流转 |
| 真实建隧道 | **不进 e2e**。做成一台专用的、隔离网络的验证机上的手工/半自动 checklist |

判断依据：e2e 的价值是"验证集成"，但当集成的副作用会破坏执行机本身时，
正确答案是**在集成边界上打桩**，而不是硬跑。

### 5.6 Electron 的执行编排

Electron 用例只能在真实 Windows / macOS 上跑，这部分**保留你现在的本地 runner 设计**——
它是对的，与 GitHub self-hosted runner 同构。三点补强：

1. **至少一台常驻机**。09 号文档的开放项 #4 建议直接定：
   一台常驻 Windows（可以是虚拟机）跑 `mxt-runner watch --always`，
   否则"每晚跑"实际上是"谁开机谁跑"，趋势数据会断断续续，失去意义。
   macOS 若无常驻机，接受"排队等认领"的降级语义（11 号文档已定，合理）。
2. **runner 要自更新与自愈**：注册成 Windows 服务 / launchd，崩溃自动重启，
   版本落后时自动拉新。否则半年后没人记得那台机器上跑的是什么。
3. **被测产物由平台分发**：runner 不该自己 build。CI 产出安装包 → 上传制品库 →
   平台在派活时给出下载 URL + sha256 → runner 下载、校验、安装到临时目录、跑、清理。
   这样"测的是哪个包"永远清楚。

---

## 6 · Agent 生成用例：现有设计的评价与调整

07 号文档的判断（**产物进 git、生成动作可两处发起、永远走 PR**）是对的，保留。
两点调整：

1. **把生成的重点从"造新用例"移到"补选择器与断言"**。
   实践中 agent 写整条用例的通过率不高，但做这几件事非常可靠：
   - 从路由表反推"哪些页面一条用例都没有" → 生成**待实现的 catalog 条目**（不生成代码）
   - 给现有组件补 `data-test` 属性（机械且安全的改动）
   - 从失败历史里聚类 error_text，生成"这三条用例失败原因相同"的分诊结论
2. **失败分诊（07 号文档已提）优先级应高于用例生成**。它风险低、见效快，
   且喂给它的上下文（失败步骤 + 最近 20 次结果 + gitSha diff 范围）你的数据模型已经有了。
   建议把它提前到 P2，用例生成留在 P5。

---

## 7 · 落地路线（替换 09 号文档的阶段划分）

### 第 1 周 —— 消除最大风险

- [ ] **Electron spike**：`_electron.launch()` 能否拉起 compass 的 `.exe` 与 `.app`。
      产出一页结论：方案 A 还是方案 B。**这是唯一有可能推翻方案的未知数**
- [ ] po-frontend 增加 JUnit reporter，确认输出可解析
- [ ] 确定执行编排：GitLab CI（若可用）还是 Argo Workflows

### 第 2–3 周 —— Web 闭环（最高优先级）

- [ ] 写 `e2e.Dockerfile`，CI 在合并主干时构建 `mxt/compass-e2e:<sha>`，镜像内含 `dist/spa`
- [ ] 编排层跑通：4 分片 mock 全量 → JUnit 合并 → 上传 S3/MinIO
- [ ] MXT ingest 改为吃 JUnit（summary.json 降级为可选增强）
- [ ] `cy.session` 编程式登录，删掉 `.auth-session.json` 依赖
- [ ] 打开 `retries.runMode = 1`
- **出口**：合并触发 + 每小时定时，报告在平台上可看，墙钟 < 4 分钟

### 第 4 周 —— 运维闭环

- [ ] CronWorkflow 定时（每小时 mock / 每晚 real smoke）
- [ ] 状态跃迁通知（企业微信/飞书）
- [ ] S3 lifecycle 保留策略；trace/video 只留失败的
- [ ] flaky 计分 + quarantine（§4.3 算法）
- **出口**：早上打开群消息就知道昨晚有没有新失败；没有新失败时群里安静

### 第 5–7 周 —— Electron

- [ ] 按 spike 结论选定框架，写 5–8 条打包冒烟用例
- [ ] 一台常驻 Windows runner，注册为服务
- [ ] CI 产出安装包 → 制品库 → 平台派活时下发 URL + sha256
- **出口**：每晚自动跑 Electron 冒烟，结果与 Web 并列展示

### 第 8 周起 —— 收窄控制面

- [ ] 删 `report.mjs`、`scheduler.mjs`、dispatcher 的 script 拼接、artifacts 存储实现
- [ ] UI 只留：任务、run 列表、用例趋势、drift、flaky 待修复列表
- [ ] 失败分诊 agent
- [ ] 接入第二个应用，验证契约通用性（这才是"平台"成立的证明）

---

## 8 · 如果不想引入任何新基础设施

上面的方案假设可以上 Argo / MinIO。如果不行，**最小改动版本**（收益仍占八成）：

1. **预构建镜像**（§1.2①）—— 这条无论如何都要做，收益最大，不依赖任何新组件
2. **修 `printf` 的 `%` bug**，改用 `--data-binary @file`（§1.2②）
3. **Job 状态 reconcile**：调度器每分钟 `GET /apis/batch/v1/.../jobs?labelSelector=mxt.run-id`，
   Job failed 但 run 仍 `running` → 判 `blocked`，附 Pod 的 `terminated.reason`
4. **分片**：dispatcher 一次建 N 个 Job（同 runId 不同 `MXT_SHARD`），
   全部完成后 server 侧合并 —— 约 150 行
5. **产物**：仍用 PVC，但加**配额监控**与自动清理 CronJob；只保留失败用例的视频
6. **`cy.session` 编程式登录**（§3.2④）—— 零基础设施，收益极大
7. **通知**（§4.4）—— 一个 webhook，半天工作量
8. **flaky 计分**（§4.3）—— 纯 SQL + 一个定时任务

这八条里有六条不需要任何新组件，而它们覆盖了"玩具 → 可用"的主要差距。

---

## 9 · 三个必须现在拍板的问题

| # | 问题 | 为什么现在必须定 |
| --- | --- | --- |
| 1 | **执行编排选 GitLab CI 还是 Argo Workflows** | 决定第 2 周所有工作的形态。如果内网 GitLab 可用且团队在用，**强烈建议选它**——零新增基础设施 |
| 2 | **是否有一台可以常驻开机的 Windows 机器** | 决定 Electron 定时任务是"真无人值守"还是"排队等人开机"。没有的话 Electron 趋势数据不可用，要接受这个降级 |
| 3 | **real profile 打哪个环境、用哪个只读账号** | 09 号文档的开放项 #1，卡住 §3.3 的 real 轨。可以先只做 mock 轨，但要明确 real 什么时候接 |

---

## 附:参考的公开实践

- Google, *Flaky Tests at Google and How We Mitigate Them* —— flaky 率与 quarantine 策略
- Google Testing Blog, *Test Sizes* / *Just Say No to More End-to-End Tests* —— e2e 用例数量的克制
- Playwright 官方文档 —— `--shard` + `merge-reports`、Trace Viewer、`_electron` 类
- Cypress 官方文档 —— `cy.session`、`retries`、CI 镜像预装依赖的建议
- WebdriverIO `wdio-electron-service` —— 打包 Electron 应用的自动化
- Argo Workflows —— CronWorkflow、artifact repository、`retryPolicy: OnError`
- Microsoft VS Code 仓库 `test/smoke` —— Playwright 驱动 Electron 的规模化实例
- sorry-cypress —— Cypress 并行编排的开源自建方案
- CTRF (ctrf.io) —— 测试报告通用交换格式的近期尝试
