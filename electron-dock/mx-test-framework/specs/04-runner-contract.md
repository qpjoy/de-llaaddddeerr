# 04 · Runner 接入契约

这是平台最重要的可复用产物。**任何应用、任何引擎，满足本契约就能接入**，
平台不需要理解它内部用了什么框架。

契约延续 compass `docs/E2E.md` 里已写好的分工——应用维护用例与 fixture，
平台负责调度、密钥、日志、产物、历史——把它形式化。

## 输入：环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `MXT_RUN_ID` | 是 | 平台 run id，原样写回 summary |
| `MXT_APP` | 是 | 应用 slug，如 `compass` |
| `MXT_SUITE` | 是 | suite slug |
| `MXT_TRACK` | 是 | `functional` / `demo` |
| `MXT_PROFILE` | 是 | `mock` / `real` |
| `MXT_BASE_URL` | Web 必填 | 被测目标，绝对 HTTP(S)，无凭据无 query |
| `MXT_APP_PATH` | 桌面必填 | 被测应用可执行文件路径 |
| `MXT_ARTIFACTS_DIR` | 是 | 产物输出根目录，runner 只往这里写 |
| `MXT_CASE_FILTER` | 否 | 逗号分隔 Case ID 或 spec glob，用于重跑单个用例 |
| `MXT_DEMO_HOLD_MS` | 否 | demo 轨每步停留毫秒，默认 900 |
| `MXT_CALLBACK_URL` | 否 | 实时 step 上报地址 |
| `MXT_RUN_TOKEN` | 否 | run 作用域短期 token，配合 callback / 上传 |
| `MXT_SECRET_*` | 否 | 平台注入的测试账号等，见下 |

**存量别名**：接入 compass 时平台同时注入 `E2E_RUN_ID` / `E2E_BASE_URL` /
`E2E_PROFILE` / `E2E_TRACK` / `E2E_ARTIFACTS_DIR` / `E2E_SPEC`，值与 `MXT_*` 对应。
compass 的 `scripts/e2e-run.mjs` 因此**一行不改**就能被平台驱动。

## 输出：产物布局

```
$MXT_ARTIFACTS_DIR/
  summary.json        必填，机器可读判定
  report/index.html   选填，runner 自带的报告
  videos/**           选填
  screenshots/**      选填
  logs/**             选填
```

服务端 runner 的 `MXT_ARTIFACTS_DIR` 直接指向 PVC 上的 `runs/<runId>/`，写完即完成。
本地 runner 写到本机临时目录，跑完通过 `PUT /runner/v1/runs/:runId/artifacts/*` 上传。

## 输出：`summary.json`

Schema 见 [`../contracts/runner-summary.schema.json`](../contracts/runner-summary.schema.json)。

```json
{
  "schemaVersion": 2,
  "runId": "trun_01J...",
  "app": "compass",
  "suite": "compass-web-functional",
  "track": "functional",
  "profile": "mock",
  "engine": "cypress",
  "status": "passed",
  "startedAt": "2026-08-12T09:00:00Z",
  "finishedAt": "2026-08-12T09:04:31Z",
  "totals": { "tests": 23, "passed": 22, "failed": 0, "skipped": 0, "flaky": 1 },
  "cases": [
    {
      "caseId": "LP-FE-AUTH-001",
      "status": "passed",
      "attempts": 1,
      "durationMs": 3120,
      "spec": "cypress/e2e/smoke/auth.cy.ts",
      "title": "未登录用户访问受保护页面时跳转登录并保留目标地址",
      "steps": [
        { "seq": 1, "label": "打开受保护页面", "status": "passed", "offsetMs": 120 }
      ],
      "artifacts": [{ "kind": "video", "path": "videos/smoke/auth.cy.ts.mp4" }]
    }
  ],
  "blockedReason": null
}
```

### 硬性规则

1. `status` 必须是 `passed` / `failed` / `blocked` 之一，与退出码一致。
2. **零用例即 `blocked`**，不是 `passed`。直接继承 compass 的设计，防假绿的关键。
3. `artifacts[].path` **必须是相对 `MXT_ARTIFACTS_DIR` 的路径**，不得是绝对路径或 URL。
   平台负责搬运与重定位——这样就不再需要 compass 里那段 `reconcileVideoPaths` 补丁。
4. 不得包含凭据、请求体、响应体、Cookie、Token、query 参数。runner 侧应先脱敏，
   但平台**不信任**，ingest 时再脱一次。

## 退出码

| 码 | 含义 | 平台动作 |
| --- | --- | --- |
| 0 | 全部通过（含 flaky 转绿） | `passed` / `flaky` |
| 1 | 至少一个真实断言失败 | `failed` |
| 2 | 基础设施问题：配置无效、浏览器起不来、目标不可达、零用例 | `blocked` |
| 其他 | 视为 2 | `blocked`，`blockedReason` 记录退出码 |

退出码与 `summary.json.status` 冲突时**以退出码为准**：进程崩溃时 summary 可能
根本没写完。

## 凭据

compass 现状是手工 `pnpm e2e:login` 把登录态存进 `cypress/.auth-session.json`。
这条路无法无人值守，token 也明文留在开发机上。

平台的模型：

```
平台密钥库（加密存储，只存账号密码，不存会话）
  └── secretRef: "compass/e2e-readonly-account"
        │  suite 声明需要哪些 secretRef
        ▼
  claim 时解密 → 注入 MXT_SECRET_USERNAME / MXT_SECRET_PASSWORD（仅进程环境）
        ▼
  runner 走真实登录流程现拿会话
```

- **平台不存 session/token，只存账号凭据。** 会话每次现登，"登录态过期导致测试变红"
  这类与产品无关的噪声因此消失。
- 密钥只在 claim 响应中出现一次，不写日志、不进产物、不进 summary。
- `capture` 轨保留为本地开发兜底，不在平台上运行。
- `real` profile 默认只读账号；需要写数据的 suite 必须显式声明 `writesData: true`，
  否则平台拒绝调度。

## 两种 runner 的差异

| | 服务端 runner | 本地 runner |
| --- | --- | --- |
| 形态 | k8s Job，官方浏览器镜像 | 使用者机器上的 `mxt-runner` CLI |
| 身份 | Job 注入的 run token | mx-launcher 账号登录后签发的 runner token |
| 派发 | 平台主动创建 Job | runner 主动 `claim` |
| 产物 | 直接写 PVC | HTTP 上传 |
| 契约 | **完全相同** | **完全相同** |

契约不区分两者——同一个 `pnpm e2e:run:mock` 在服务器容器里和在个人机器上跑，
产出的 `summary.json` 是一样的。详见 [11](11-runner-environments.md)。
