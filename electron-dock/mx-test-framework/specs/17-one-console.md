# 17 · 一个后台：Jenkins 只留给运维

> 问题：既然引入了 Jenkins，日常工作会不会被割裂成两个后台？
> 答案：不会，但这取决于一个具体的分工，而不是取决于愿望。

---

## 0 · 结论

**可以做到。** 使用者只开 MXT，Jenkins 只在排查构建问题时打开。

前提是守住一条分工：

```
Jenkins  = 构建产物 + 外部触发      运维面
MXT      = 用例 + 调度 + 执行 + 报告 + 历史      所有人的操作面
```

关键在于**不要把执行机接成 Jenkins agent**。

---

## 1 · 为什么"本机接成 Jenkins agent"会造成割裂

一台机器要跑 Electron 测试，有两种接法：

| 接法 | 结果 |
| --- | --- |
| 接成 **Jenkins agent** | 测试任务变成 Jenkins job。改跑哪条 suite、改定时、看为什么排队——**全都要开 Jenkins**。MXT 退化成一个报告查看器 |
| 接成 **MXT 执行机**（`mxt-runner`） | 任务定义、排期、派发、结果全在 MXT。Jenkins 与这台机器无关 |

第二种才是"不割裂"。而且 MXT 的本地执行机**本来就已经是这个东西**——
它与 GitHub self-hosted runner、Jenkins agent 是同构的，只是队列的主人不同。

所以答案不是"用 Jenkins 任务队列还是 MXT 点安装"，而是：

> **构建 agent 连 Jenkins，测试执行机连 MXT。同一台物理机可以两个都是，
> 但那是两个进程、两套凭据、两个队列。**

| | 构建 agent | 测试执行机 |
| --- | --- | --- |
| 进程 | `java -jar agent.jar` | `mxt-runner watch` |
| 谁派活 | Jenkins 队列 | MXT 调度器 |
| 在哪配 | Jenkins（运维） | **MXT 后台（所有人）** |
| 何时需要 | 出 Windows / macOS 安装包 | 跑 Electron 测试 |

Linux 构建不需要常驻 agent（k8s 起临时 pod）。**只有 Windows / macOS 构建需要**，
因为 k8s 起不了 Windows 容器。那是唯一需要人维护的常驻 agent。

---

## 2 · 交接点：构建 → 测试

Jenkins 构建完**不触发测试**，只发布产物：

```
Jenkins: quasar build -m electron  →  上传制品库
         POST /api/v1/apps/:app/packages  {url, sha256, version, gitSha}
                                        ↓
MXT:     按自己的排期建 run，把这个包快照进 run
                                        ↓
执行机:  认领 → 下载 → 校验 sha256 → 跑用例 → 回报
```

方向不能反。Jenkins 一旦触发测试，mx-base 就进了 MXT 的关键路径，
违反 [mx-base ADR-0001](../../mx-base/docs/adr/0001-shared-platform-services.md) 的硬约束
（mx-base 挂了 MXT 仍要能跑）。

两个实现细节，都是为了让"这次结果对应哪个构建"永远答得出来：

- **包在建 run 时快照，不在认领时解析。** 桌面 run 可能排队几小时；
  期间发布了新包，这次 run 也必须仍是它被创建时那个包的 run。
- **`sha256` 必填且强校验。** 执行机会把这个文件下载到别人自己的电脑上**并运行它**。
  校验不过就拒绝，不降级。

---

## 3 · 使用者在 MXT 里能做完的事

| 事情 | 在哪 |
| --- | --- |
| 登记应用（GitHub 地址 + 分支 + 访问凭据） | MXT |
| 建套件（引擎、镜像、工作目录、命令） | MXT |
| 建定时任务 / 立即执行 / 停用 | MXT |
| 接入自己的电脑当执行机 | MXT（`mxt-runner`，用 MXT 账号） |
| 看报告、录像、步骤、失败堆栈 | MXT |
| 看用例趋势、drift、未执行清单 | MXT |
| 生成对外脱敏报告 | MXT |
| —— | —— |
| 改构建流水线 | Jenkins（运维） |
| 排查"为什么包没构建出来" | Jenkins（运维） |
| 接入 Windows 构建 agent | Jenkins（运维，一次性） |

---

## 4 · 本机接入执行机：怎么做

现状是两条命令（不需要 mx-launcher，内网用 admin token 即可）：

```bash
npx mxt-runner login --server http://<MXT 地址>:30879
npx mxt-runner register --name "我的 Windows" --engines playwright-electron --surfaces electron
npx mxt-runner watch
```

runner 现在会自己完成整个准备工作 —— 这是这一轮补上的，之前它只能在一个
别人手工准备好的目录里执行命令：

1. 按 run 指定的 ref `git fetch` + `checkout`（缓存在 `~/.mxt/checkouts/<app>`，
   增量更新，不是每次重新 clone）
2. `cd` 到 suite 的 `workingDir`
3. 按 lockfile 装依赖（**不跨包管理器兜底**，装不上就是 `blocked`）
4. 下载被测安装包，**校验 sha256**，把路径放进 `MXT_APP_PATH`
5. 跑命令
6. 收 `summary.json`，没有就收 `junit/*.xml`，都没有就 `blocked`
7. 上传产物，回报结果（带真实 gitSha）

**准备阶段的任何失败都是 `blocked`，不是红。** 把基础设施问题记成用例失败，
是团队学会无视红灯的最快路径。

### 还可以更省一步

理想形态是后台点一下「接入我的电脑」，生成一个 15 分钟有效的一次性接入码，
页面按 User-Agent 给出对应的一行命令，`mxt-runner enroll --code XXX` 一步完成。
**这一步还没做**，现在是上面那两条命令。它是 UX 优化，不影响能力。

---

## 5 · 罗盘的两条 suite

同一个仓库、同一套 UI（Quasar 从一份源码出 web 和 electron 两个目标），
两条 suite 走两条完全不同的执行路径：

| | `web-mock` | `electron-smoke` |
| --- | --- | --- |
| 引擎 | Cypress | Playwright `_electron` |
| 跑在哪 | 服务端 k8s Job，全自动 | 本地执行机（Windows） |
| 被测对象 | `pnpm e2e:local` 自建的 SPA | Jenkins 构建的 `.exe` |
| 目标地址 | 无（`targetMode: self`） | 无（桌面应用没有 URL） |
| 定时 | 到点就跑 | 到点排队，等机器上线；12 小时无人认领标 `expired`（**不算失败**） |

`expired` 不算失败这条很重要：没有常驻机时，定时任务不会每天早上制造一条假红。

被测仓库要加一个 `e2e:electron` script（[16 §3](16-multi-stack-platform.md)：
执行命令也是测试代码，走 PR）：

```json
"e2e:electron": "playwright test -c playwright.electron.config.ts --reporter=junit"
```

spec 里用 `process.env.MXT_APP_PATH` 拉起平台下发的那个安装包，
JUnit 写到 `$MXT_ARTIFACTS_DIR/junit/`，平台零适配就能吃下。

---

## 6 · 还没做的

| 项 | 影响 |
| --- | --- |
| **失败通知** | 定时跑起来后最要紧的一件事。没有通知的定时任务等于没跑 |
| 一次性接入码 | 现在两条命令，够用 |
| `Jenkinsfile.electron` | 需要在被测仓库里写，且要一台 Windows 构建 agent |
| mx-base 上机验证 | 镜像构建、JCasC 加载、agent pod 三条都没在真实集群跑过 |
