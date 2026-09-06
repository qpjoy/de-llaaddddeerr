# 00 · 定义与范围

## 一句话定义

MXT 是一个**独立的 e2e 测试平台**：建任务、跑任务（立即 / 定时 / 重复）、出报告和录像。
被测应用自带用例代码，平台负责调度、执行、留存结果。

**它不是 mx-launcher 的一部分，不参与发版流程，不需要装进 AppCenter。**

## 为什么建平台

compass 已经证明单应用的 e2e 可以做得很好——23 个用例、双轨、脱敏、0/1/2 退出码、
用例目录映射。它缺的不是测试能力，是**平台能力**：

| compass 现状 | 缺口 |
| --- | --- |
| 产物落在开发机 `artifacts/e2e/<run-id>/` | 没有历史、没有趋势、换台机器就没了 |
| 手工敲命令 | 不能定时、不能重复、不能无人值守 |
| 登录态靠手工 `cypress/.auth-session.json` | 会过期，跑一次要人先登一次 |
| 单机串行、`retries: 0` | 一次网络抖动就红 |
| 报告依赖 mochawesome 相对路径（要 `reconcileVideoPaths` 打补丁） | 报告与执行强耦合 |
| Cypress 单引擎 | 测不了 Electron 打包产物 |
| 只服务 compass | 换应用就得整套复制 |

MXT 补的是这些，不是重写用例。

## 核心模型：任务 → 执行

```
任务 (Task)          调度                    执行 (Run)
─────────────       ────────────           ──────────────
应用 + suite    ┌── 立即执行              每次调度产生一个 Run
+ profile       ├── 定时一次（某时刻）     ├─ 状态 passed/failed/blocked
+ 目标地址      └── 定时重复（cron）       ├─ 用例级结果
+ 执行位置                                 └─ 报告 + 录像 + 截图
```

一个任务反复执行，产生一串 run，于是有了趋势。这就是平台的全部核心。

## 执行位置：两种 runner

| runner | 跑在哪 | 能测什么 | 自动化程度 |
| --- | --- | --- | --- |
| **服务端 runner** | Internal RedHat 上的 k8s Job，官方浏览器镜像 | Web SPA 的无头 e2e | 全自动，定时任务无需人管 |
| **本地 runner** | 使用者自己的 Windows / macOS | Electron 打包产物、需要真实桌面的场景 | 需要机器在线；用 mx-launcher 账号登录后认领任务 |

RHEL 服务器**可以**自动跑无头 e2e，细节与理由见 [11-runner-environments.md](11-runner-environments.md)。

## 范围

**先做 e2e 测试平台。** 首批：

1. **compass web** —— 把 `public` 分支上已经写好的 23 个 Cypress 用例（下称"存量"）
   零改写接入，服务端 runner 自动跑。这是第一次闭环。
2. **compass electron** —— quasar 打出的桌面端，本地 runner 跑。

规划但不做：接口性能/成功率专项（`api` 类）、其他应用接入、系统与网络层测试。

## 非目标

- **不做发版门禁。** 不与 mx-launcher 的版本、release-center 挂钩。
  平台只回答"这次跑的结果是什么"，谁要拿它卡发版，自己调 API 判断。
- 不做视觉像素比对。
- 不做性能压测。`api` 类将来测的是基线与成功率，不是容量。
- 不做浏览器兼容矩阵。首批只跑 Chromium。
- 不替代单元测试。
- **不改 MX-H2I 的联网与登录路径。** e2e 在 SPA 页面上操作、或在 Electron 界面上点按钮,
  launcher 自己会分配网络——平台不介入这个过程。

## 与 09 号文档的关系

[`mx-launcher/docs/09-observable-automation-test-platform.md`](../../mx-launcher/docs/09-observable-automation-test-platform.md)
描述的是 HDOI 全链路质量控制面（site-agent、synthetic probe、release gate）。
那是 launcher 自己的课题,**不是 MXT 要做的事**。

MXT 只借用它的两个概念：run/case/step 的记录结构,和测试层级的划分。
门禁、probe、HDOI 链路都不在 MXT 范围内。
