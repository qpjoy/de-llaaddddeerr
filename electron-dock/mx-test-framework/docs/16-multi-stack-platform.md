# 16 · 多技术栈：平台，而不是某个项目的方案

> 起因：08 号文档和 15 号文档都是围绕 compass / 罗盘写的，读起来像"给 po-frontend
> 做的 Cypress 方案"。平台的判据不是它能不能跑罗盘，而是**接入第二个技术栈时要不要
> 改平台代码**。这份文档回答那个问题，并记录为此做的改动。

---

## 0 · 判据

一个测试平台是不是平台，只看一件事：

> **接入一个新项目 / 新语言 / 新框架，需要往平台里写代码吗？**

在这次改动之前，答案是**需要**——ingest 只认 MXT 自己的 `summary.json`（v1/v2），
而**世界上没有任何框架原生产出这个格式**。罗盘能接上，是因为它的
`scripts/e2e-run.mjs` 恰好写了一个适配器。换 pytest、换 k6、换 go test，
都得先写一个适配器。那不是平台，那是"一个带调度的 Cypress 外壳"。

现在答案是**不需要**。

---

## 1 · 契约：JUnit XML

```
容器镜像进  →  JUnit XML 出  →  退出码 0 / 1 / 2
```

JUnit XML 是唯一被所有主流测试框架原生支持的结果格式：

| 框架 | 怎么产出 |
| --- | --- |
| pytest | `--junitxml=out.xml`（内置） |
| Playwright | `--reporter=junit`（内置，Node / Python / Java / .NET 都有） |
| Cypress | `cypress-multi-reporters` + `mocha-junit-reporter` |
| WebdriverIO | `@wdio/junit-reporter` |
| k6 | `--out junit` |
| go test | `go-junit-report` |
| JUnit / TestNG / PHPUnit / RSpec | 原生 |

实现在 `server/ingest/junit.mjs`。关键设计：**它把 JUnit 转成 v2 summary，
再交给现有的 `normalizeSummary`**，而不是另开一条写库的路。
脱敏、重复用例检测、退出码仲裁、目录比对全都在那里，
第二条入库路径就是第二个让它们跑偏的地方。

约定：suite 把 JUnit 写到 `$MXT_ARTIFACTS_DIR/junit/*.xml`。
容器脚本发现没有 `summary.json` 就自动改发 JUnit，**suite 侧不需要知道平台的存在**。

### Case ID 的三级关联

和 [03](03-case-catalog.md) 定义的顺序一致，最明确的优先：

1. `<property name="caseId" value="HUB-API-SQL-001"/>` —— Playwright 的 annotation、
   pytest 的 marker 都能产出，**新用例一律用这个**
2. `name` 或 `classname` 里正则匹配到的编号 —— 存量用例不用改
3. 都没有 → 合成 `~<classname>::<name>`

第 3 级很重要：**没有编号的用例不能被悄悄丢掉**。它会以 `unmapped` 出现在 drift
报告里，正是"你跑了目录里没登记的东西"这个信号。丢掉它等于把 drift 检测的意义
抹掉一半。

### 平台规则照样生效

JUnit 路径不是绕过规则的后门。实测（`tests/junit.test.mjs`）：

- 零用例的报告 → `blocked`，不是通过
- 退出码与报告冲突 → 以退出码为准
- 断言消息里粘进了 `authorization: Bearer ...` → 入库前脱敏
- 报告里有失败但退出码 0 → 仍然判 `failed`

### 代价说清楚

JUnit 装不下三样东西：**步骤时间轴、每条用例的产物关联、tracks**。
所以：

| 想要 | 用什么 |
| --- | --- |
| 任何框架零适配接入，用例级结果 | **JUnit XML** |
| 步骤时间轴 + 点某一步跳到录像那一秒 | `summary.json`（平台原生格式） |

两者都支持，`summary.json` 存在时优先。这是明确的取舍，不是缺陷：
**先让所有栈能进来，愿意投入的项目再买回额外精度。**

---

## 2 · 引擎与镜像

`ENGINES` 从 3 个放开到 6 个，每个只决定一件事——**默认镜像**：

| engine | 默认镜像 |
| --- | --- |
| `cypress` | `cypress/included:15.0.0` |
| `playwright` / `playwright-electron` | `mcr.microsoft.com/playwright:v1.56.0-noble` |
| `pytest` | `python:3.12-slim`（要浏览器就覆盖成 `playwright/python`） |
| `k6` | `grafana/k6:0.58.0` |
| `generic` | **无**，必须自己填 `runnerImage` |

两条规则：

- **版本一律钉死，绝不用 `latest`。** 镜像是"这个结果意味着什么"的一部分；
  底座在脚下变化会让一次绿色执行莫名其妙变红，而没人能从记录里还原原因。
- **`generic` 没有镜像就拒绝派发，不猜。** 拿 Cypress 镜像跑 Python 会在测试命令
  深处失败，而那个失败会被记成"用例失败"而不是"配置错了"，把排查方向带偏。

`suite.runnerImage` 永远优先。**这才是平台开放性的落点**：一个没列在上面的栈，
填自己的镜像就能进来，平台一行代码不用改。

---

## 3 · 接入一个新项目需要什么

平台侧**零代码**。使用者在后台填四样：

| 字段 | 说明 |
| --- | --- |
| `repoUrl` + `defaultBranch` | **用例代码在哪个仓库**。可以是测试团队自己的仓库（[ADR-0007](adr/0007-test-code-ownership.md)），业务仓库零改动 |
| `workingDir` | monorepo 里项目根的相对路径，不填就是仓库根 |
| `engine` + `runnerImage` | 决定跑在什么镜像里 |
| `command` | 任意 argv：`["pytest","-q","--junitxml=out.xml"]`、`["npx","playwright","test"]` |

私有仓库配 `MXT_GIT_TOKEN`（经 credential helper 注入，不进 URL、不进 `.git/config`、
不进进程表）。

### command 直接填，不需要业务仓库配合

> **本节已按 [ADR-0007](adr/0007-test-code-ownership.md) 修订。**
> 原来的规则是"只能调用被测仓库里的具名入口（`pnpm run x` / `make x`）"。
> 那条规则不自洽：它限制 `command`，却完全不限制 `runnerImage`——
> 填任意镜像，入口点就是任意代码。所以它挡不住有意的人，只挡得住正当用法。

现在直接填就行：

```json
["pytest", "-q", "--junitxml=junit/results.xml"]
["npx", "playwright", "test", "--reporter=junit"]
["k6", "run", "script.js", "--out", "junit=junit/k6.xml"]
```

只剩两条约束：**argv[0] 不能是 shell**（参数不经过 shell，把 argv[0] 交给 shell
等于把刚去掉的解析放回去；要管道就在测试仓库里写个脚本），
**参数不能含控制字符**（会破坏 argv 传递并允许伪造日志行）。

真正的信任边界是 **admin 角色 + 沙箱容器 + 审计**：容器没有 service account token、
egress 受 NetworkPolicy 限制、工作区随 Pod 消失、run token 只作用于这一次执行。

---

## 4 · pytest 和 Playwright 对平台的价值

问题问的是"对平台有没有提升"，这两个的答案不一样。

### Playwright：**能力提升**

它是唯一一个一套框架覆盖多个面的引擎：

| 能力 | 对平台意味着什么 |
| --- | --- |
| `_electron.launch()` | 桌面端测试的唯一现实路径（**只有 Node 绑定有**） |
| 跨 origin / 跨 tab | 登录跳转、OAuth 类流程能测 |
| 原生 `--shard` + `merge-reports` | 用例变多后墙钟时间不线性增长的前提 |
| Trace Viewer | DOM 快照 + 网络 + 控制台，比录像强得多 |
| `test.step()` | 步骤时间轴免费获得，不用自研 |
| 多语言绑定 | Node / Python / Java / .NET 团队用同一套心智 |

对平台的实际收益：**一个基础镜像服务多个项目**，而且 Web 和 Electron 共用一套技能、
一套报告。这是真的能力扩张。

### pytest：**覆盖面提升，不是能力提升**

pytest 本身不给平台任何新能力——它做的事 Playwright 也能做。它的价值是**让已经在用
Python 的团队零摩擦上车**：

- 原生 `--junitxml`，不需要学平台的格式
- agent / text2sql / ETL 这些业务测试本来就是 Python 写的
- `pytest-playwright` 还能顺带拿到浏览器能力

诚实的边界：**pytest 测不了 Electron**（Playwright 的 `_electron` 只有 Node 绑定）。
但那是项目层面的约束，不是平台层面的——平台不该要求所有人用一种语言。

> 结论：**Playwright 是平台的主引擎，pytest 是平台的接纳能力。**
> 二者不冲突，因为平台绑的是 JUnit 契约，不是语言。

---

## 5 · Jenkins 能不能同时支持这些

能，但**这个问题问错了对象**。

让多栈并存的不是 Jenkins，是**容器 + JUnit 契约**。Jenkins 做的只是"起一个 pod，
用仓库声明的镜像，跑命令，收 XML"——GitHub Actions、Argo Workflows、GitLab CI
做的是同一件事，MXT 自己的 k8s 派发器做的也是同一件事。

所以：

| 需求 | 谁做 |
| --- | --- |
| 定时跑 e2e（任意栈） | **MXT 自己**。它已经能按引擎选镜像、派 k8s Job、收 JUnit |
| 手动点一次 | **MXT 自己** |
| 出 Electron 安装包 / 构建产物 | **MXT 的 `kind: build` 作业**，跑在它本来就需要的那台 Windows 执行机上（[ADR-0006](adr/0006-mxt-absorbs-builds-jenkins-deferred.md)） |
| 合并主干即触发 | Webhook 打到 MXT |

**多技术栈支持不是引入 Jenkins 的理由**——那件事平台自己已经做到了。
后来核实下来，"构建"也不是：唯一真正难复制的是多阶段流水线 DSL，
而当前流水线只有三步。Jenkins 的启用条件写在 [ADR-0006](adr/0006-mxt-absorbs-builds-jenkins-deferred.md)。

---

## 6 · 还没做的

| 项 | 说明 |
| --- | --- |
| ~~仓库内 manifest（`mxt.yaml`）~~ | **已否决**（[ADR-0007](adr/0007-test-code-ownership.md)）。让仓库声明执行配置，等于把"怎么测"的决定权交回给业务开发的排期。配置留在 MXT 后台，代码留在测试团队自己的 git 仓库 |
| ~~suite 变更审计~~ | **已完成**，见 [19-audit-trail.md](19-audit-trail.md) |
| CTRF | [ctrf.io](https://ctrf.io) 想做"带步骤的通用格式"。等它生态起来了再看，现在 JUnit + 原生 JSON 两级够用 |
| 分片 | Playwright 的 `--shard` 已经支持，平台还没有下发分片计划的接口 |
| eval 类 suite | LLM 评测的分数不该进 pass/fail，见 [14 §6](14-ci-runners-and-stack.md#6-llm-评测的位置) |
