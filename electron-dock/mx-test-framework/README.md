# MX Test Framework

内部通用 e2e 测试平台：建任务、跑任务（立即 / 定时 / 重复）、出报告和录像。

被测应用自带用例代码，测试同学在界面上登记用例，平台负责调度、执行、留存结果。
**它是独立平台**——不参与 mx-launcher 的发版流程，不进 AppCenter，只用它的账号登录。

**当前状态：功能完成，待上机。** 82 个测试通过；尚未在 Internal 上跑过 `deploy`，
派发 k8s Job 与 mx-launcher 登录这两条路径未在真实环境验证过。

## 三分钟上手

```bash
bash scripts/manage.sh dev          # 内存态起服务，无需数据库
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

## 跑在哪

| runner | 位置 | 测什么 |
| --- | --- | --- |
| 服务端 | Internal RedHat 上的 k8s Job，官方浏览器镜像 | Web SPA 无头 e2e，**全自动** |
| 本地 | 使用者自己的 Windows / macOS | Electron 打包产物 |

RHEL 服务器可以自动跑无头 e2e——用容器镜像，不依赖宿主的系统库。
桌面端接自己的电脑：

```bash
npx mxt-runner login --server https://你的平台地址
npx mxt-runner register --name "我的电脑"
npx mxt-runner watch
```

详见 [11-runner-environments.md](specs/11-runner-environments.md)。

## 部署

```bash
bash scripts/manage.sh deploy
```

镜像 → 数据库迁移 → k8s 服务 → 自动冒烟。另有 `seed` / `verify` / `clean` /
`status` / `logs` / `down`。详见 [10-deployment.md](specs/10-deployment.md)。

## 目录

| 路径 | 内容 |
| --- | --- |
| [`specs/`](specs/) | 设计文档与 ADR，**改代码前先改这里** |
| [`server/`](server/) | 控制面：API、调度器、结果归一、报告渲染、产物、身份 |
| [`web/`](web/) | 界面（原生 JS + neon-void 设计系统，零构建） |
| [`bin/`](bin/) | `mxt-runner` 本地执行机 CLI |
| [`contracts/`](contracts/) | OpenAPI、runner summary 与 case catalog 的 schema |
| [`migrations/`](migrations/) | PostgreSQL 迁移，由 `@qpjoy/mx-common` 执行 |
| [`deploy/`](deploy/) | k8s 清单与本地 compose |
| [`tests/`](tests/) | 82 个测试 |

## 四条硬约束

1. **平台是增益，不是前置依赖。** MXT 不可用时，被测应用仓库里的
   `pnpm e2e:local` 必须仍能独立跑通。
2. **零用例不是通过。** 配置错、浏览器起不来、目标不可达，一律 `blocked`（退出码 2）。
   退出码与 summary 冲突时以退出码为准——崩溃的执行机会留下写了一半的 `passed`。
3. **「未执行」不被静默吞掉。** 目录里有、这次没跑到的用例单独计数，
   否则删掉一条失败用例就能让结果变绿。
4. **不改 mx-launcher 任何代码，不介入 MX-H2I 的联网与登录路径。**

## 从哪开始读

[`specs/00-overview-and-scope.md`](specs/00-overview-and-scope.md)，然后按
[`specs/README.md`](specs/README.md) 的顺序。

新人上手与用例编写的设计见 [12-ui-and-onboarding.md](specs/12-ui-and-onboarding.md)。
