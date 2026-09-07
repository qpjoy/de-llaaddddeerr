# 07 · 路线图与商业价值

> 状态：提议。阶段顺序和投资门槛用于控制范围；没有附真实 evidence 的阶段都视为未完成。

## 路线图原则

1. 每一阶段都产生用户可检查的结果，而不是只增加基础设施。
2. 先证明一个真实项目的闭环，再扩展工具数量。
3. 下一阶段不能以破坏 standalone、Internal 真相源或 MX-H2I 登录边界为代价。
4. 平台先成为可信的测试工作台，再扩展 Agent、CI/CD、网络抓包和商业连接器。
5. 任何“支持某框架”的声明都要包含版本、平台、项目、日期和 run evidence。

## Phase 0：合同与风险基线

### 交付

- Project、Catalog、Suite、Task、Run 的术语与状态机；
- JUnit baseline 和 rich sidecar 的 schema 草案；
- standalone / Internal / 登录隔离 ADR；
- Luopan / Compass 验收协议；
- 安全、流量、artifact 和保留预算。

### 验收

- 产品、测试、开发、架构和运维共同 review；
- 重要未决项有 owner 和 decision deadline；
- schema 示例通过 JSON / XML contract lint；
- 文档未把未实现功能写成完成；
- 依赖图中不存在 mx-auto-server → launcher deployment / database 的写入边。

### 当前说明

本目录提供了 Phase 0 的文档草案，但仍需正式 review，因此不标记 Phase 0 已验收。

## Phase 1：Standalone 壳与身份

### 交付

- mx-autotest 作为 standalone launcher 应用注册；
- Neon Void 工作台壳；
- Internal 配置读取；
- mx-launcher 账号登录；
- 本地会话、退出和授权不足体验；
- 与 MX-H2I 同时运行。

### 验收证据

- MX-H2I 未运行时独立启动和登录录像；
- 同时运行时无端口、协议、缓存和单例冲突；
- 登录 token 不进入日志；
- Internal 配置版本和 audience 记录；
- 部署前后 MX-H2I 登录与基础联网 smoke。

### 停止条件

若必须修改 MX-H2I 现有登录或联网路径才能登录 mx-autotest，应停止实现并重新评审架构，不能把兼容风险带入下一阶段。

## Phase 2：独立 mx-auto-server 基座

### 交付

- 独立 K8s namespace、PostgreSQL、artifact 存储、Secret 和 RBAC；
- Node / TypeScript API 与有限调度器；
- migration Job；
- deploy / migrate / verify / status / logs / clean / down；
- Project、Suite、Task、Run、Catalog 最小 API；
- JUnit ingest 与 zero-test protection。

### 验收证据

- 空环境一命令 deploy；
- 第二次 deploy 幂等；
- migration checksum 漂移会阻断 rollout；
- JUnit pass / failure / malformed / zero-test contract tests；
- server runner Job 权限越界测试；
- down 后数据库与 artifact 仍在；
- launcher workload 未滚动，MX-H2I 非回归通过。

### 不做

- Jenkins；
- 通用流水线 DSL；
- 多副本调度；
- 任意大型工具在线安装；
- 对外公开分享。

## Phase 3：Luopan / Compass Web 闭环

### 交付

- public 分支存量 Cypress inventory；
- 与 feat/yjj/hdo_v2 的 compatibility review；
- QA 外部仓库或保留业务仓库的逐 Suite 决策；
- compass-web-smoke evidence-fast；
- compass-web-review review-video；
- JUnit、报告、截图和视频索引；
- Catalog drift。

### 验收证据

- 固定应用 / 测试 commit 与 Cypress / browser digest；
- 快速通过 Run；
- 人为断言失败 Run；
- 目标不可达 blocked Run；
- 无人为等待的快速视频证据；
- 人工触发的慢速完整视频；
- 报告能从 Case 到视频、源码和日志；
- 脱敏检查；
- MX-H2I 登录非回归。

Phase 3 通过后，平台才可以对内宣称“在已记录环境中完成 Luopan / Compass Web Cypress 闭环”。

## Phase 4：Luopan / Compass Electron spike

### 交付

- Desktop Runner 注册、能力匹配、claim、lease 与 run token；
- 官方固定版本 Playwright Node Electron toolchain；
- 内容寻址缓存；
- 固定 digest 打包制品；
- Electron launch、主窗口、一个核心流程、trace、video 和 JUnit；
- 原生对话框 coverageMode 清单。

### 验收证据

- 首次下载与第二次缓存命中的字节和耗时；
- 成功 Run、可控 renderer 失败 Run、应用无法启动 blocked Run；
- Playwright / Electron / OS / arch / artifact digest；
- Trace Viewer 可打开；
- 测试结束无残留进程和用户配置污染；
- native dialog 的 automated / manual / unsupported 边界；
- MX-H2I 与 mx-autotest 同时运行非回归。

若技术 spike 失败，交付物是带证据的选型结论和替代方案，不是假装支持 Playwright Electron。

## Phase 5：多技术栈平台化

### 进入条件

- Phase 3 和 4 的领域对象与 ingest 没有硬编码 Compass；
- 接入第二个工具不需要新增数据库写入路径；
- JUnit baseline 已稳定。

### 候选顺序

1. pytest：API、数据、ETL、Agent 测试；
2. Playwright Web：新增跨浏览器或跨 origin e2e；
3. k6：受控环境下的性能与基线；
4. generic：验证一个平台未预置的 JUnit producer；
5. tshark：仅在专用安全 runner 上做时间与大小受限的协议证据。

### 验收

- 每个 adapter 有官方固定版本 manifest；
- 至少一个非 Node 技术栈不修改平台核心即可接入；
- JUnit 与 sidecar 缺失能力在 UI 中诚实显示；
- 权限、网络和资源配额按能力收窄；
- 文档和模板面向测试意图，不变成工具百科。

## Phase 6：团队协作与质量治理

### 候选能力

- flaky 趋势和 quarantine 建议；
- requirement / risk 关联；
- 通知与缺陷系统链接；
- 脱敏分享副本；
- source / toolchain 差异比较；
- runner fleet、缓存和成本可视化；
- Webhook 与外部 CI evidence API；
- 角色、审计、保留和组织策略。

### 验收

- PM 能从风险目录看到未验证项；
- 开发能从失败 Run 到首个可行动证据；
- 负责人能看到 blocked / flaky / cost，而不是只有通过率；
- 分享链接可撤销、到期且不暴露敏感信息；
- 外部 CI 读取结果不会让 MX Autotest 接管发版。

## Phase 7：测试领域 Agent 工作台

Agent 可以调用经过授权的工具：

- 读取需求与 Catalog，提出缺口；
- 生成测试源码 PR；
- 选择已有 Suite 并触发隔离 Run；
- 归纳失败、比较历史和推荐复现步骤；
- 帮助生成脱敏评审材料；
- 在人批准后创建定时 Task。

边界：

- Agent 不直接写默认分支；
- 不绕过项目权限、Secret policy 和 runner 沙箱；
- 不把一次探索性浏览器操作记录成稳定回归；
- 不自动向生产目标发起性能或抓包任务；
- 结论链接原始 evidence，用户可检查。

## 不引入 Jenkins 的当前决策

当前需求是：

- 手动 / once / cron；
- 在匹配能力的 runner 上运行一个受控入口；
- 收集 JUnit 与 artifact；
- 形成历史、风险和报告。

这些能力可由 mx-auto-server 的有限 Node / TypeScript 调度器和 K8s Job 完成。引入 Jenkins 会增加 JVM、插件供应链、权限面、PVC 和第二套运维 UI，却没有带来首轮不可替代价值。

满足任一条件时重新评估 Jenkins、Argo 或既有企业 CI：

- 需要跨阶段 fan-out / fan-in 与汇聚逻辑；
- 需要人工审批后继续执行；
- 超过三个团队独立管理复杂构建流水线；
- 需要 Windows / macOS / Linux 多平台并行构建并晋升制品；
- 企业已有成熟 CI，希望 MX Autotest 只收 quality evidence。

即使引入，Project / Catalog / Suite / Task / Run 仍属于 MX Autotest；外部 CI 是执行 provider。

## 对不同角色的价值

| 角色 | 平台价值 | 不应承诺 |
| --- | --- | --- |
| 测试新手 | 模板、preflight、清晰状态、一步重跑 | 无需学习任何测试知识就能生成可靠用例 |
| 测试专家 | 多栈 adapter、目录、版本、原生证据、扩展入口 | 平台替代所有框架专长 |
| 开发 | 复现指纹、首错、trace / video / log、分享 | 每次失败都能自动修复 |
| PM | 风险目录、未验证项、里程碑证据 | 一个通过率等于产品可发布 |
| 负责人 | 趋势、可靠性、成本、治理和隔离 | 工具越多平台越有价值 |
| 投资决策者 | 可复用控制面、组织效率、证据资产 | 在单项目 spike 后宣称全栈成熟 |
| 外部客户 / 合作方 | 脱敏、可撤销的真实验证材料 | 暴露内部日志或夸大未覆盖范围 |

## 商业价值路径

### 第一层：内部效率

- 缩短从失败到复现；
- 减少工具安装和环境漂移；
- 降低重复视频上传与依赖下载；
- 用目录和历史替代聊天记录；
- 让测试团队独立交付黑盒用例。

### 第二层：团队治理

- 项目级角色、审计和 Secret policy；
- runner fleet 和成本管理；
- 风险、需求、Catalog 与执行关联；
- 报告分享和保留策略；
- 多团队模板与 adapter catalog。

### 第三层：可商业化能力

可评估的产品层，而不是当前承诺：

- 企业身份、审计和策略包；
- 私有工具链镜像与离线安装；
- 托管 runner / 混合 runner 管理；
- 行业测试模板和合规 evidence；
- 缺陷、需求、通知与数据平台连接器；
- 测试领域 Agent 和组织知识库。

商业化前必须证明：

- 至少两个不同技术栈和多个 Project 复用核心模型；
- 一名新用户无需平台开发者陪同即可完成首个有效 Run；
- 运行成本和支持成本可测；
- Secret、隔离、审计和数据保留经过安全 review；
- 外部 evidence 不泄露内部信息。

## 对外宣传规则

### 可以说

- “MX Autotest 以 JUnit 为通用结果底线，并保留 Cypress / Playwright 原生证据。”
- “在指定版本与环境中完成了 Luopan / Compass Web Cypress 闭环。”——仅在 Phase 3 有 evidence 后。
- “在指定 OS / arch 与 Electron 版本上验证了 Playwright Electron smoke。”——仅在 Phase 4 有 evidence 后。
- “MX Autotest 独立部署，未进入 MX-H2I 登录和联网关键路径。”——需有架构 review 与非回归记录。

### 不能说

- “支持所有测试框架”；
- “100% 覆盖”；
- “AI 自动保证质量”；
- “Electron 所有原生交互已自动化”；
- “零侵入”而实际依赖业务仓库修改；
- “不影响 MX-H2I”而没有部署前后登录证据。

对外 case study 至少列出：日期、产品版本、测试源码版本、工具版本、环境、测试范围、未覆盖范围和脱敏报告。

## 投资门槛与停止规则

每个阶段评审以下问题：

1. 用户是否得到新的可验证能力；
2. 新基础设施是否替代了明确痛点；
3. 核心模型是否仍然与工具无关；
4. 运行成本、流量和支持成本是否可接受；
5. 是否扩大了对 MX-H2I 的故障半径；
6. 是否有更小的成熟外部能力可集成。

应停止扩张并修复基础的信号：

- blocked 率长期高于产品失败率；
- 大量 Run 无法还原源码或工具；
- 测试分支长期漂移；
- 用户只把平台当命令输入框；
- artifact 存储与流量不可预测；
- 为支持新工具不断修改核心 schema；
- 登录、网络或部署边界出现一次未解释影响。

## MVP 的唯一判据

MVP 不是“页面齐了”，也不是“能点运行”。它是 [03 · Luopan / Compass 初步验收](03-luopan-compass-acceptance.md) 的全部 Gate 被真实执行并形成证据：

- standalone 登录；
- Internal 配置；
- 独立 mx-auto-server；
- Cypress Web 快速证据和人工慢速完整视频；
- Playwright Electron 在明确边界内的打包制品验证；
- JUnit + rich evidence；
- 可复现与可分享；
- MX-H2I 登录和联网非回归。

在此之前，产品状态应标为 prototype / preview，而不是 production-ready。
