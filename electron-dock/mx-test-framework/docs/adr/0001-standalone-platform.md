# ADR-0001：独立测试平台，与 mx-launcher 只共享账号

状态：已接受（2026-08-12）

## 背景

compass 的 e2e 能力要扩展成通用测试平台。可选：并入 `mx-launcher/server`、
新建同级应用、或做成 launcher 的一个模块。

`mx-launcher/server` 里已有一个最小 Test Center（`/internal/v1/test/runs|steps|gates`），
面向 09 号文档描述的 HDOI 发版门禁场景。

## 决策

**新建 `electron-dock/mx-test-framework`，作为独立平台。**

与 mx-launcher 的耦合面只有一条：**用它的账号登录**
（`/internal/v1/user-center/token/introspect`）。除此之外：

- 不接管 launcher 的 test-center，**launcher 侧一行不改**
- 不参与 launcher 的发版流程，不做门禁
- 不注册 service VIP，不进 AppCenter
- 不介入 MX-H2I 的联网路径

launcher 的 test-center 继续服务它自己的 HDOI 门禁场景。两者各做各的，
不做转发、不做接管——那需要跨系统的一致性代价，换来的却只是概念上的统一。

## 理由

**launcher server 在 MX-H2I 的用户联网与登录路径上。** 测试平台是变更最频繁的
组件之一：新 runner、新引擎、新报告格式、新应用接入。把这种节奏绑到用户联网服务的
发布节奏上，两边都受损。"任何功能改动不影响 MX-H2I 现有登录"这条约束，
最省力的满足方式就是不动它的进程。

**门禁与执行是两件事，不该混在一个产品里。** 门禁关心的是"能不能发版"，
需要绑定 release、config snapshot、渠道；测试平台关心的是"跑一遍看看结果"。
把两者做进一个系统，测试平台的每个概念都要背上发版语义（run 属于哪个 release、
用例是否阻断灰度），复杂度翻倍而日常使用者根本用不到。

需要门禁的人可以调 `/api/v1/runs/:id` 自己判断——这是一个 HTTP 请求的事，
不值得为它引入整套 gate/verdict/waiver 模型。

**它不是分发给终端用户的产品。** e2e 在 SPA 页面上操作、或在 Electron 界面上
点按钮，网络由 launcher 自己分配，测试框架不需要感知。所以它不需要 VIP、
不需要进 AppCenter，就是 Internal 内网的一个普通管理页面。

## 后果

- `mx-launcher/server` 的 `TestCenterController` 保持原样。若将来确实需要在 launcher
  的发版流程里引用 MXT 的结果，用一个 HTTP 调用即可，不需要改本 ADR。
- MXT 依赖 launcher 的 introspection 接口来登录人。launcher 不可达时**人登录不了**，
  但已排队的任务、已注册的 runner 继续工作——这是必须保持的降级路径。
- 多一套部署。用 `mx-insight-hub` 的 `manage.sh` 范式摊薄成本，
  目标是 `manage.sh deploy` 一条命令（[10](../10-deployment.md)）。
- 09 号文档继续描述 launcher 自己的 HDOI 质量控制面，与 MXT 不是同一件事。
  MXT 只借用了它的 run/case/step 记录结构。

## 被否决的方案

- **并入 mx-launcher/server**：把 QA 的变更风险引入用户联网服务。
- **MXT 接管 launcher 的 test-center 并做转发**：为了概念统一付出跨系统一致性代价，
  而门禁场景本身已不在 MXT 范围内。
- **做成 AppCenter 里的一个应用**：它是内部工具，不是分发给用户的产品，
  走 AppCenter 只会引入不必要的分发、VIP 和权限链路。
