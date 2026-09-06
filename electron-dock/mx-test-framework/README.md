# MX Test Framework

内部通用 e2e 测试平台：建任务、跑任务（立即 / 定时 / 重复）、出报告和录像。

被测应用自带用例代码，测试同学在界面上登记用例，平台负责调度、执行、留存结果。
**它是独立平台**——不参与 mx-launcher 的发版流程，不进 AppCenter，只用它的账号登录。

**当前状态：已在本机真实部署，罗盘 web 与 electron 两条流程端到端跑通。**
205 个测试通过。真部署（docker compose：server + PostgreSQL，12 个迁移）、
Cypress 23/23、Playwright `_electron` 4/4 —— 全部实跑验证，记录见
[23-local-verification.md](docs/23-local-verification.md)。

**尚未验证**：Internal 上的 `deploy`、k8s Job 派发、mx-launcher 登录。
本机 k8s 卡在 kubeconfig 证书过期（[23 §4](docs/23-local-verification.md)）。

## 两种部署形态，别搞混

| | **Windows 本地服务版** | **正式形态** |
| --- | --- | --- |
| 用途 | **做测试、出 demo** | 团队日常、无人值守 |
| 平台跑在 | 一台 Windows 的 Docker Desktop | 内网 **Linux** 服务器的 Kubernetes |
| 执行机 | 同一台机器（自己连自己） | Linux 容器跑 Web；Windows / macOS 跑桌面端 |
| 数据 | 随时可丢，重来即可 | 趋势的唯一来源，不能丢 |
| 文档 | [24-windows-local-service.md](docs/24-windows-local-service.md) | [10](docs/10-deployment.md) + [15](docs/15-server-side-first-run.md) |

**同一份代码、同一个镜像、同一套迁移，不同的只有部署拓扑。**
桌面端那条链在两种形态下完全一致——在本地验过什么，上服务器就是什么。

## 三分钟上手

```bash
bash scripts/manage.sh dev          # 内存态起服务，无需数据库
```

要真数据库但不想重建镜像（比如系统盘快满了）：

```bash
bash scripts/local-postgres.sh      # PostgreSQL 在容器里，平台跑在宿主机上
```

浏览器打开 <http://localhost:8790>，账号随便填，密码用 `MXT_ADMIN_TOKEN`
（默认 `local-admin-change-me`）。然后：

```bash
MXT_BASE_URL=http://localhost:8790 MXT_ADMIN_TOKEN=local-admin-change-me \
  node scripts/seed.mjs             # 灌示例数据，界面就不是空的了
```

示例数据里有一次失败的执行，点进去能看到失败在第几步；还有一条故意没实现的用例，
用来演示「已登记、待实现」。

## 核心模型

```
Task（任务）              Run（执行）
应用 + 套件 + 目标    ──>  每次调度产生一个
+ 调度方式                 ├─ passed / failed / blocked
  · 立即执行               ├─ 用例级结果 + 步骤时间轴
  · 定时一次               └─ 报告 + 录像 + 截图
  · cron 重复
```

同一个任务反复执行产生一串 run，于是有了历史与趋势。

执行过程是**实时可见**的：run 详情页顶上是一条七段流水（认领 → 检出 → 装依赖 →
启动 → 执行 → 收产物 → 归档），跑到哪一段哪一段亮；下面是用例列表，跑到哪条哪条
高亮，步骤逐条追加。跑完页面自己切到结果，不用手动刷新。没有接进度上报的 suite
也有流水，只是没有用例级明细。做法与取舍见
[25-live-runs-and-runner-onboarding.md](docs/25-live-runs-and-runner-onboarding.md)。

## 跑在哪

建任务时**自己选**，不再由套件隐式决定：

| 选项 | 跑在哪 | 适合 |
| --- | --- | --- |
| 服务器静默跑 | k8s Job 或注册为 `--kind server` 的机器 | 定时回归。快、出报告、**不录像** |
| 我的这台电脑 | 你自己接进来的执行机 | 想看着它点，想要录像 |
| 指定执行机 | 点名某一台 | 只有那台机器有的环境 |
| 任意执行机 | 谁先空出来谁跑 | 桌面端的日常 |

桌面端套件选「服务器」会当场被拒绝——服务器上没有 Windows，也没有可以启动的安装包。
详见 [25 §13](docs/25-live-runs-and-runner-onboarding.md)。

RHEL 服务器可以自动跑无头 e2e——用容器镜像，不依赖宿主的系统库。

把自己的电脑接进来只要一条命令：在「执行机」页面点「把这台电脑变成执行机」，
拿到的命令粘到这台机器的终端里。**不用在这台机器上输密码**（接入码 15 分钟有效、
只能用一次），也**不需要管理员权限**（装在用户目录）。装好就在前台等任务，
关掉窗口就断开；`mxt-runner uninstall` 撤出。

接进来的那一刻，浏览器里那张卡片自己会变成「已连接」。

详见 [11-runner-environments.md](docs/11-runner-environments.md) 与
[25 §6](docs/25-live-runs-and-runner-onboarding.md)。

## 部署

```bash
bash scripts/manage.sh deploy
```

数据库 → 镜像 → 迁移 → k8s 服务 → 自动冒烟，一条命令。`.env.internal` 里
**只有 `MXT_ADMIN_TOKEN` 是必填的**：数据库默认由 deploy 自己拉起（namespace 内
独立实例、独立磁盘，**不与 mx-insight-hub 共实例**），密码自动生成。设了
`MXT_DATABASE_URL` 才改用外部实例。

另有 `seed` / `verify` / `clean` / `status` / `logs` / `down`。
详见 [10-deployment.md](docs/10-deployment.md)。

## 目录

| 路径 | 内容 |
| --- | --- |
| [`docs/`](docs/) | 设计文档与 ADR，**改代码前先改这里** |
| [`server/`](server/) | 控制面：API、调度器、结果归一、报告渲染、产物、身份 |
| [`web/`](web/) | 界面（原生 JS + neon-void 设计系统，零构建） |
| [`bin/`](bin/) | `mxt-runner` 本地执行机 CLI |
| [`contracts/`](contracts/) | OpenAPI、runner summary 与 case catalog 的 schema |
| [`migrations/`](migrations/) | PostgreSQL 迁移，由 `@qpjoy/mx-common` 执行 |
| [`deploy/`](deploy/) | k8s 清单与本地 compose |
| [`tests/`](tests/) | 205 个测试 |

## 四条硬约束

1. **平台是增益，不是前置依赖。** MXT 不可用时，被测应用仓库里的
   `pnpm e2e:local` 必须仍能独立跑通。
2. **零用例不是通过。** 配置错、浏览器起不来、目标不可达，一律 `blocked`（退出码 2）。
   退出码与 summary 冲突时以退出码为准——崩溃的执行机会留下写了一半的 `passed`。
3. **「未执行」不被静默吞掉。** 目录里有、这次没跑到的用例单独计数，
   否则删掉一条失败用例就能让结果变绿。
4. **不改 mx-launcher 任何代码，不介入 MX-H2I 的联网与登录路径。**

## 从哪开始读

[`docs/00-overview-and-scope.md`](docs/00-overview-and-scope.md)，然后按
[`docs/README.md`](docs/README.md) 的顺序。

新人上手与用例编写的设计见 [12-ui-and-onboarding.md](docs/12-ui-and-onboarding.md)。
