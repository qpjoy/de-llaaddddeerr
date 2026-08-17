# 08 · 首批落地：compass

## 先说清楚"存量"指什么

compass 的 `public` 分支上**已经写好并跑通**的那套 e2e 代码：

```
po-frontend/
  cypress.config.ts              四轨（functional/demo/perf/capture）+ 双 profile
  cypress/
    case-catalog.frontend.json   用例目录，14 条
    case-catalog.agents.json     用例目录，9 条            ← 合计 23 个用例
    e2e/smoke/         4+3+3 个用例   登录、导航、首页
    e2e/core/          2+2+3+2+2 个   社媒、内容群聊、账户评论、策略、AI、Agent
    e2e/real/          2 个           部署环境连通性
    e2e/demo/          演示轨走查
    fixtures/          9 份 mock 数据
    support/           cy.step() 旁白、API 指标采集
  scripts/e2e-*.mjs                本地执行、报告汇总、登录捕获
  docs/E2E.md                      说明文档
```

"**存量零改写接入**"= 不改上面任何一行代码，平台就能调度它、收产物、出报告、留历史。
这是验证 [04](04-runner-contract.md) 的 runner 契约是否真的够用的唯一诚实方式——
如果接一个已有应用需要先改它，那契约就是不通用的。

## compass 的两个 surface

compass 是 quasar 应用，产出两个形态：

| surface | 构建 | 测试形态 | 跑在哪 |
| --- | --- | --- | --- |
| web | `quasar build` → SPA | Cypress（存量 23 用例） | 服务端 runner，全自动 |
| electron | `build:electron:{portable,installer,dmg}` | Playwright Electron（新建） | 本地 runner，个人 Windows/macOS |

## 阶段 A：compass web 零改写接入

平台侧准备：

1. 注册 app：`{ slug: "compass", surfaces: ["web","electron"], catalogGlob: "cypress/case-catalog.*.json" }`
2. 注册 suite `compass-web-functional`：`engine=cypress, surface=web, runnerKind=server,
   command=["pnpm","e2e:run:mock"]`
3. `catalog:sync` 导入现有两个目录（23 条，`schemaVersion: 1` 按默认值补全）
4. 服务端 runner 镜像：`cypress/included:<version>` + compass 仓库

runner 执行的就是 compass 现有的命令：

```bash
pnpm install && pnpm exec cypress install
pnpm e2e:run:mock      # 平台注入 E2E_* 别名变量
```

平台读 `artifacts/e2e/<run-id>/`，按退出码 0/1/2 判定。

**唯一的 gap**：compass 的 `summary.json` 是 `schemaVersion: 1`——它有
`specs[].tests[]`，没有 `cases[]`。两种处理，都不改 compass 主流程：

- **首批走这条**：平台侧 adapter，从 `functional.cases[]`（compass 已经算好了
  case→status 映射）转成 `cases[]`。零改动。
- 后续 compass 升 `schemaVersion: 2`，直接输出 `cases[]` + `steps[].offsetMs`。

### 完成标准

- [ ] 平台上建一个任务、点执行，23 个用例跑完，报告可看、录像可播
- [ ] 把任务设成每晚 cron，连续 5 天自动跑，趋势页有数据
- [ ] 故意改坏一个用例 → run `failed`，报告指向失败步骤
- [ ] 故意给错 `baseUrl` → run `blocked`（不是 `failed`，更不是 `passed`）
- [ ] 从目录删一条用例但代码还在 → 报 `unmapped`
- [ ] `manage.sh clean` 清掉 30 天前的产物后，历史列表和趋势仍完整
- [ ] compass 仓库里 `pnpm e2e:local` 仍能独立跑通

最后一条是硬约束：**平台是增益，不是前置依赖。**

## 阶段 B：real profile 与凭据

compass 的 real profile 目前靠 `pnpm e2e:login` 手工捕获登录态，平台上跑不了。

1. 平台密钥库存入 `compass/e2e-readonly-account`
2. compass 新增 `cypress/support/platform-login.ts`：优先读 `MXT_SECRET_USERNAME` /
   `MXT_SECRET_PASSWORD` 走真实登录；读不到时回落到现有 `.auth-session.json`。
   **本地开发体验不变。**
3. suite `compass-web-real`：`profile=real, writesData=false`
4. `cypress/e2e/real/` 下现有的 `LP-FE-REAL-001/002` 登记进目录

## 阶段 C：compass electron

新建，用 Playwright Electron 驱动**打包产物**（不是 dev server）：

```ts
const app = await _electron.launch({ executablePath: process.env.MXT_APP_PATH });
```

suite `compass-electron`：`engine=playwright-electron, surface=electron,
runnerKind=local, requirements={os:["windows","macos"]}`。

使用者在自己机器上：

```
mxt-runner login          用 mx-launcher 账号登录
mxt-runner watch          常驻认领，或 mxt-runner run <taskId> 只跑一次
```

首批用例（新 Case ID，`CPS-EL-*` 规范）：

| Case ID | P | 验证 |
| --- | --- | --- |
| `CPS-EL-BOOT-001` | P0 | 冷启动进入主窗口，不弹提权 |
| `CPS-EL-BOOT-002` | P0 | 主进程无未捕获异常，渲染进程无 console error |
| `CPS-EL-AUTH-001` | P0 | 界面上点登录，经 `@qpjoy/electron-launcher` 进入首页 |
| `CPS-EL-AUTH-002` | P0 | 重启应用后登录态保持 |
| `CPS-EL-NET-001` | P1 | 网络面板展示当前模式与连通状态 |
| `CPS-EL-UPD-001` | P1 | 检查更新流程可达且不阻塞主窗口 |
| `CPS-EL-WIN-001` | P1 | 窗口最小化/恢复/关闭到托盘的行为正确 |

**边界**：这些用例是在 Electron 界面上点按钮，网络由 launcher 自己分配，
测试框架不介入。用专用测试账号，不触碰生产 launcher 的登录服务配置。

定时执行时，如果没有个人机器在线，run 停在 `pending-runner` 等认领；
超过 12 小时无人认领置 `expired`——不算失败，不告警（[11](11-runner-environments.md)）。

## 不在首批

- 接口性能/成功率专项（`api` 类）
- insight-hub / launcher admin 的 web e2e —— 契约已通用，接入时就是重复阶段 A
- 系统与网络层测试（WG/DNS/路由）
