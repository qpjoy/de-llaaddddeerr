# 09 · 阶段与开放项

每个阶段的出口标准都是"能被别人验证"，不是"代码写完了"。

## 阶段

### P0 · 骨架与部署 ✅ 代码完成，待上机

- [x] specs 与 ADR
- [x] `contracts/` JSON Schema、`migrations/001_initial.sql`
- [x] `server/`：apps / suites / cases / tasks / runs / claim / complete
- [x] 调度器：立即 / 定时一次 / cron 重复；`pending-runner` 排队与 `expired` 回收
- [x] 结果归一：compass v1 与平台 v2 两种 summary、二次脱敏、目录比对
- [x] `scripts/manage.sh`：`dev`、`test`、`local`、`deploy`、`migrate`、`verify`、`clean`、`status`、`logs`、`down`
- [x] `deploy/k8s/internal/`：namespace、RBAC、独立 PVC、迁移 Job、server、NetworkPolicy
- [x] 测试：44 个，覆盖 cron、调度、归一、脱敏、HTTP 全链路
- [ ] **在 Internal 上真正跑一次 `deploy`**（本机无 Docker/k8s，未上机验证）

出口：**`bash scripts/manage.sh deploy` 在 Internal 上跑通**，`verify` 建一个 run、
提交一份 `summary.json`、查到结果。`scripts/verify.mjs` 已实现这条链路的 16 项断言，
并已对着内存态服务端到端跑通。

### P1 · compass web 闭环

见 [08](08-compass-onboarding.md) 阶段 A 的完成标准。

- [x] 调度器：立即 / 定时一次 / cron
- [x] 服务端 runner 派发器（k8s Job + `cypress/included` 镜像）
- [x] 产物上传、存储、鉴权下载
- [ ] **在 Internal 上真正派发一次 Job**（本机无 k8s，派发路径未上机验证）
- [ ] 接入 compass 真实仓库跑通 23 个用例

出口：**平台上建一个任务点执行，23 个用例的报告和录像出来；设成每晚跑，
第 5 天能看到趋势。** 这是第一个可展示的里程碑。

### P2 · 报告与 review 体验 ✅ 代码完成，待上机

- [x] 平台侧渲染报告（不再依赖 mochawesome 相对路径）
- [x] 步骤时间轴 + 录像跳转，产物服务支持 HTTP Range
- [x] 对外分享：`?redacted=true` 脱敏副本 + `?brand=` 品牌层
- [ ] 单一 spec 双轨执行，compass 的 `demo/` 目录开始清空
- [ ] flaky 检测与 quarantine
- [ ] 分享链接与有效期（目前脱敏报告靠参数，未做独立分享令牌）

出口：管理员点"步骤 4 失败"直接跳到录像对应秒；能生成一个可发给客户的脱敏链接。

### P3 · 无人值守

- 密钥库 + real profile 自动登录（compass 阶段 B）
- 失败通知
- 产物清理任务（`manage.sh clean` 的定时版）

出口：每晚自动跑 compass real，早上有结果，无人干预。

### P4 · compass electron 与本地 runner

- [x] `mxt-runner` CLI：登录、注册、watch/claim、执行、上传、上报
- [x] `pending-runner` / `expired` 的排队语义
- [ ] 在真实 Windows/macOS 上跑通（本机无法验证）
- [ ] compass electron 的 7 个用例

出口：**在自己的 Windows 上跑 `mxt-runner watch`，平台派任务过来，
打包产物冷启动到登录的用例通过，结果在平台上和服务端跑的任务并列显示。**

### P5 · 规模化

- 接口性能/成功率专项（`api` 类）
- `mxt gen` / `mxt lint`（[07](07-agent-case-authoring.md)）
- 失败分诊
- 第二个应用接入，验证契约的通用性

## 开放项

已在这一轮定掉的（不再是开放项）：

- ~~service VIP / AppCenter~~ → 不需要，普通 ClusterIP + Ingress（[ADR-0001](adr/0001-standalone-platform.md)）
- ~~evidence 存储后端~~ → 独立 PVC + 目录，无对象存储（[10](10-deployment.md)）
- ~~GUI worker 归属~~ → 本地 runner，谁的机器谁跑，mx-launcher 账号登录（[11](11-runner-environments.md)）
- ~~报告是否对客户可见~~ → 默认内部；脱敏按钮 + 品牌层生成分享副本（[05](05-tracks-and-artifacts.md)）
- ~~门禁强制拦截时点~~ → 不做门禁（[00](00-overview-and-scope.md)）
- ~~compass 存量 Case ID 是否统一命名~~ → 不动，app 内唯一已足够（[03](03-case-catalog.md)）

仍需要你后续拍板的，不阻塞 P0/P1：

| # | 问题 | 说明 |
| --- | --- | --- |
| 1 | 测试账号与测试环境 | P3 前必须定：`real` profile 打哪个环境、用哪个组织的哪个只读账号 |
| 2 | 产物保留天数 | 默认 30 天。录像占空间，PVC 给多大取决于并发与保留期 |
| 3 | 权限粒度 | 目前设计是"应用级"（某人能看/能跑哪些应用）。是否需要更细 |
| 4 | 是否要一台常驻桌面机 | 不要也能用（排队等认领），要的话桌面任务的定时才真正无人值守 |
| 5 | 品牌层的具体样式 | 分享报告的 `?brand=` 目前只换标题文字，需要 logo 与配色 |
| 6 | launcher 的密码登录接口形状 | 代码按 `/internal/v1/sdk/oauth/token` 的 password grant 写的，未对接真实服务验证过响应字段 |

## 与 feat/mx_insight_hub 的合并

本设计在 `feat/mx_test_framework` 上开发。冲突面很小：

- 代码：`electron-dock/mx-test-framework/` 是新目录，无重叠
- 数据库：独立 `mx_test` 库（[ADR-0004](adr/0004-independent-database.md)）
- 共享依赖：`@qpjoy/mx-common`（只读使用，不改）
- **不改 `mx-launcher` 任何代码**（[ADR-0001](adr/0001-standalone-platform.md)）

如果两边都要改 `mx-common`，先在 `mx-common` 上单独提交。
