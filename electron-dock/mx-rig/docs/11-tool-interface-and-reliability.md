# MX Rig 工具接口与可靠性改进

日期：2026-09-21。接续 [实现评估](10-implementation-review-and-codex-harness.md)。

产品版本统一为 0.8.0 Preview：Internal 与 MCP 从 Rig 根 package.json 读取版本，桌面打包沿用同一版本。迁入的 test-platform 内核保留独立包版本。

## 1. 决定：将测试能力工具化，保留平台

Rig 应提供一个可以独立启动的工具服务，同时保留 Internal 控制面、执行机和证据库。

| 组件 | 负责什么 |
| --- | --- |
| Codex 或其他 Agent harness | 理解目标、规划、工具调用审批、解释证据 |
| Rig MCP adapter | 协议、参数校验、调用现有 Rig 工具执行器 |
| Rig Internal | 测试资产、账号权限、工具策略、派发、原始结果与产物 |
| Rig Runner / K8s Job | 执行已有测试套件，操作专用测试浏览器或 Electron 应用 |
| Rig Electron 客户端 | 人工操作、观察执行、处理需要人的流程；保留自身 Agent Runtime |

Codex 的公开 MCP 接口支持 stdio 工具服务；因此优先实现 **Codex → Rig MCP → Rig API → Runner**。这不要求将 Codex 嵌入 Electron，也不要求 Rig 配置模型。将来需要在 Rig UI 内展示 Codex 会话时，再单独引入 SDK/App Server 适配器。[Codex MCP 文档](https://developers.openai.com/codex/mcp)

本次提供的是“测试领域工具”。已有套件可以执行网页/Electron 测试；MCP 不提供任意 shell、原生桌面点击或自由浏览器控制，也不会因为接入 Codex 自动获得这些能力。通用电脑操作仍需独立的观察、动作、断言和执行隔离设计。

## 2. 已实现接口

入口：`bin/mx-rig-mcp.mjs`。采用锁定版本的官方 `@modelcontextprotocol/server@2.0.0`，通过 stdio 提供服务，保留 2025 握手兼容。stdout 只承载 MCP；错误日志走 stderr。[SDK 文档](https://ts.sdk.modelcontextprotocol.io/v2/get-started/first-server)

所有工具复用 `packages/runtime/tools.mjs` 的定义、闭合参数 schema、Internal 策略检查和 HTTP 客户端。没有第二套测试执行实现。

| 工具 | 参数 | 语义 |
| --- | --- | --- |
| `tests_apps` / `tests_list` / `tests_runs` / `tests_runners` | `{}` | 应用、计划、最近执行、执行机 |
| `tests_cases` | `app` | 已登记用例 |
| `tests_result` / `tests_case_results` / `tests_artifacts` | `runId` | 原始执行状态、用例结果、产物引用 |
| `tests_wait` | `runId`，可选整数 `timeoutMs` | 默认等待 10 秒，允许 1–30 秒，超时可续等 |
| `tests_run` | `taskId` | 派发已有计划，立即返回 run ID，不承诺通过 |
| `tests_cancel` | `runId` | 请求取消，返回取消记录；停止范围见回执 |

默认只暴露 9 个读工具。派发和取消需要同时满足：

1. MCP 进程启动时设置 `MX_RIG_MCP_ALLOW_WRITES=1`。
2. Internal 的工具策略允许对应工具；每次执行重新读取策略并核对版本。
3. 当前 bearer 具有 Rig API 所需的 operator/admin 权限。

MCP 的 `readOnlyHint` 等 annotation 只是给宿主的提示，不是鉴权。建议 Codex 对写工具使用审批。MCP 桥接层最多允许 8 个并发调用、1 个并发写调用；不自动重试派发。

`tests_wait` 返回形如：

```json
{
  "run": { "id": "trun_example", "status": "running" },
  "wait": { "terminal": false, "timedOut": true }
}
```

等待超时不修改 Run。`passed / failed / flaky / blocked / expired / timeout / cancelled` 是执行终态。取消等待一个 MCP 调用只会停止等待，**不会隐式取消测试**；取消测试应显式调用 `tests_cancel`。测试失败作为正常工具结果返回原始状态，API/权限/协议失败才是 `isError`。

推荐调用流程：读取计划 → 派发一次 → 保存 run ID → 有界等待 → 读取用例与产物 → 给出带证据的判断。Agent 判断不覆盖平台 verdict。

## 3. 在 Codex 中接入

需要 Node.js 22+、已安装 Rig 依赖和可访问的 Rig Internal。通过现有身份链路取得当前 Rig 账号的 bearer，使用进程环境注入 `MX_RIG_URL`、`MX_RIG_TOKEN`；token 不作为工具参数、不写进项目配置，也不从 MX-H2I 的本地会话目录读取。

将下面配置合入 Codex 配置，路径按安装位置调整。本次没有修改用户的 Codex 配置或连接生产服务。

```toml
[mcp_servers.mx_rig]
command = "node"
args = ["/Users/qpjoy/workspace/qpjoy/de/de-llaaddddeerr/electron-dock/mx-rig/bin/mx-rig-mcp.mjs"]
env_vars = ["MX_RIG_URL", "MX_RIG_TOKEN"]
startup_timeout_sec = 10
tool_timeout_sec = 60
default_tools_approval_mode = "writes"

# 需要派发/取消时开启，并在 Rig Internal 允许 tests_run/tests_cancel。
# [mcp_servers.mx_rig.env]
# MX_RIG_MCP_ALLOW_WRITES = "1"
```

`MX_RIG_URL` 是 origin，例如 `https://rig.example.internal`，远端不接受明文 HTTP；回环地址允许 HTTP。这里只保存连接引导信息和客户端写权限上限，模型、测试计划、允许工具等业务配置仍在 Internal。

请直接执行 Node 入口，不将 `npm run mcp` 作为宿主 command：npm 的脚本横幅可能污染 stdio。`npm run mcp` 仅供终端调试。bearer 失效后沿用现有登录流程刷新，再重启 MCP 连接。

已有部署保留原有工具允许列表，不会在升级时自动扩大权限。要用新 `tests_wait`，需在 Internal 启用它；`tests_cancel` 也需明确启用。

## 4. 本次可靠性修复

### 取消与停止分离

`cancellation.stopState` 表示：

- `not-started`：取消在认领前完成，没有派发中的执行凭据。
- `requested`：已取消平台记录，仍待执行端确认。
- `stopping`：Kubernetes 已接受删除请求，但 Job 尚未消失。
- `stopped`：收到 Runner 回执，或已观察到 Job 消失。

本地 Runner 每约 5 秒检查租约；短租约时缩短间隔。401/403/409 会停止本次工作，连接中断时最迟在租约到期停止。checkout、依赖安装、安装器、下载、执行、上传共享取消信号。macOS/Linux 对本次进程组先 TERM、再 KILL；Windows 使用指定 PID 的 `taskkill /T /F`。不会按应用名结束用户已有浏览器或 MX-H2I。

回执携带 `scope`：`process-group` / `process-tree` / `kubernetes-job`。它表达执行器管理范围内的停止事实，**不是操作系统沙箱证明**。POSIX 主动脱离进程组的子进程不在该保证内；需要更强约束的套件应运行在容器或专用测试机，后续补 Windows Job Object、原生桌面执行隔离。

K8s 调度器按自己创建的 Job 标签清理 cancelled/expired/timeout，使用 UID 前置条件和 Foreground 删除，下个调度周期确认 Job 消失；失败留待重试。部署的 ServiceAccount 需要本 namespace 内 Jobs 的 list/get/create/delete 权限。旧 Runner 不会发送停止回执，旧版本保持 `requested`，不能解释成已停止。

取消、续租、完成、调度采用带预期状态的写入。迟到完成不能复活已取消执行；构建安装包发布与完成写入放在同一个存储提交中，避免取消后把包标成最新构建。

### 其他修复

- SSE 缺少完成标记、损坏 JSON、错误帧、长度截断等不再作为完整回答或可执行工具调用接受。
- finding 只核对带工具来源的测试观察；前一次 finding、浏览器页面文字、无来源 tool 消息不能为后一次结论作证。ID 使用完整匹配，避免前缀误认。
- 指标读取与用例健康度都按同一时间窗口过滤；窗口外失败不再生成当前风险。明确最近 200 个 Run、40 个窗口内已判断 Run 的样本上限。
- Docker 构建阶段生成必需设计资源；生产服务启动只校验资源，缺失或过期提示重建，不向只读应用目录写入。

## 5. 升级与验证边界

新增数据库迁移：`packages/test-platform/migrations/018-run-cancellation.sql`。PostgreSQL 部署先使用 Rig 的迁移流程应用它，再更新 Rig 服务和 Runner。Memory 模式不需要迁移。重新构建服务镜像，才能带入预生成的设计资源。

本次代码改动限定于 `mx-rig`，没有更改 Launcher SDK、MX-H2I 登录/会话、Luopan、Hub 或系统网络所有权代码，也没有执行生产迁移/部署。

本地已验证：122 个模块通过语法与网络耦合检查；完整回归 430 项通过，包含真实 stdio MCP → 临时 Rig API；只读/写权限、viewer 拒绝、策略撤销、未知参数拒绝；有界等待；真实 Runner 取消与停止回执；忽略 TERM 的父/孙进程组清理；K8s 删除/确认协议与调度竞争；SSE、finding、时间窗口和只读资源回归。

没有验证：现网 Codex 配置接入、真实账号登录、Windows 进程树清理、真实 Kubernetes 删除、PostgreSQL 迁移实跑、Docker 镜像启动、真实模型和 MX-H2I 现网回归。测试进程和服务均使用临时目录与测试凭据。

## 6. 后续优先级

1. 工具调用可靠性：持久化 request ID 幂等派发、分应用/计划的凭据权限、可分页证据。当前派发超时后先查询近期 Run，不盲目再次派发。
2. 观察与验证：浏览器结构化元素/截图证据、确定性 wait/assert、错误归因；保留原始测试门禁与 Agent 分析的区别。
3. 客户端宿主：在 Rig 自己的 product ID、userData 和权限域下接入 standalone launcher 的薄适配层；只复用基础能力，单独验证登录/配置接口，不引入 MX-H2I 主进程和网络 owner。
4. 更强的执行隔离、停止确认、异常恢复与中央事件存储。正式提高权限前完成专用机/容器验收。
5. 若需要内嵌 Codex 会话，再实现 AgentEngine 适配器，并用相同任务和证据比较原生 Runtime 与 Codex。暂不重写现有图引擎，也不将数据清洗/BI 能力搬入 Rig；这部分继续属于 Insight Hub。
