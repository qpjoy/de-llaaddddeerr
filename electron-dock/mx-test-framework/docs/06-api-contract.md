# 06 · API 契约

两个面：

| 面 | 前缀 | 认证 | 调用方 |
| --- | --- | --- | --- |
| 控制面 | `/api/v1/*` | mx-launcher 用户 token（introspect 校验）或服务 admin token | Web UI、脚本 |
| Runner 面 | `/runner/v1/*` | runner token（长期，认领用）+ run token（单次执行，作用域限死） | 服务端 Job、本地 runner |

没有"发版门禁面"——不做门禁（[00](00-overview-and-scope.md)）。

## 控制面

### 应用与用例

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/v1/apps` | 应用列表 |
| `POST` | `/api/v1/apps` | 注册应用 |
| `GET` | `/api/v1/apps/:app/suites` | suite 列表 |
| `POST` | `/api/v1/apps/:app/suites` | 建 suite（引擎、surface、runner 类型、命令） |
| `GET` | `/api/v1/apps/:app/cases` | 用例目录，支持 `?priority=P0&retired=false` |
| `POST` | `/api/v1/apps/:app/catalog:sync` | 提交目录 JSON，upsert + 软删，返回 diff |
| `GET` | `/api/v1/apps/:app/cases/:caseId/history` | 单用例最近 N 次结果与 flaky 率 |

`catalog:sync` 是**显式动作**（CI 合并后调用，或平台按 `repo_url` 定期拉）。
一次 run 里少了个用例只会被标 `notRun`，绝不会悄悄把它从目录里删掉。

### 任务

```http
POST /api/v1/tasks
{
  "app": "compass",
  "suite": "compass-web-functional",
  "name": "compass 每晚回归",
  "profile": "real",
  "track": "functional",
  "targetUrl": "https://compass.example.internal",
  "schedule": { "kind": "cron", "cronExpr": "0 2 * * *", "timezone": "Asia/Shanghai" }
}
```

`schedule.kind` 三选一：

| kind | 附加字段 | 行为 |
| --- | --- | --- |
| `manual` | — | 只在有人点"执行"时跑 |
| `once` | `runAt` | 到点跑一次，跑完自动停用 |
| `cron` | `cronExpr`、`timezone` | 按表达式重复 |

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/v1/tasks?app=&enabled=` | 列表，带 `nextRunAt` 与上次结果 |
| `PATCH` | `/api/v1/tasks/:taskId` | 改配置或启停 |
| `DELETE` | `/api/v1/tasks/:taskId` | 删任务（历史 run 保留） |
| `POST` | `/api/v1/tasks/:taskId:run` | **立即执行一次**，返回新建的 runId |

"立即执行"对 `cron` 任务同样可用，不影响下次定时。

### 执行结果

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/v1/runs?app=&task=&status=&since=` | 列表，分页 |
| `GET` | `/api/v1/runs/:runId` | 摘要 + totals + 目录比对 |
| `GET` | `/api/v1/runs/:runId/cases` | 用例级结果 |
| `GET` | `/api/v1/runs/:runId/cases/:caseId/steps` | 步骤时间轴（含 `offsetMs`） |
| `GET` | `/api/v1/runs/:runId/artifacts` | 产物索引；产物已清理时返回 `expired: true` |
| `GET` | `/api/v1/runs/:runId/report` | 平台渲染的 HTML 报告 |
| `POST` | `/api/v1/runs/:runId:cancel` | 取消 |
| `POST` | `/api/v1/runs/:runId:rerun` | 重跑，可带 `{ "failedOnly": true }` |

### 对外分享（脱敏 + 品牌层）

```http
POST /api/v1/runs/:runId/shares
{ "brand": "compass", "expiresInDays": 7 }
→ 201 { "url": "https://.../s/shr_01J...", "expiresAt": "..." }
```

生成一份**脱敏副本**用于给客户看：

| 内部视图保留 | 分享副本移除 |
| --- | --- |
| 内网 URL、主机名、IP | 全部替换为产品名 |
| spec 文件路径、堆栈 | 移除 |
| 测试账号、runner 标识 | 移除 |
| 用例标题、步骤、截图、录像、通过率 | **保留**——这才是给人看的内容 |

分享链接有有效期，可随时撤销（`DELETE /api/v1/shares/:id`）。
默认所有报告仅内部可见，分享是显式动作。

### 趋势

| 方法 | 路径 |
| --- | --- |
| `GET` | `/api/v1/apps/:app/trends/pass-rate?suite=&days=30` |
| `GET` | `/api/v1/apps/:app/trends/flaky?days=30` |

## Runner 面

### 注册与登录

服务端 runner 由平台自己创建 Job，token 随 Job 注入，无需注册流程。

**本地 runner**：

```
mxt-runner login
  → 浏览器打开 mx-launcher 授权页
  → 用户用现有 mx-launcher 账号登录并同意
  → CLI 拿到用户 token
```

```http
POST /runner/v1/runners:register      Authorization: Bearer <用户 token>
{ "name": "老王的开发机", "os": "windows", "arch": "x64",
  "engines": ["playwright"], "surfaces": ["electron","web"] }
→ { "runnerId": "rnr_...", "token": "mxt-rnr-..." }   # 长期 runner token
```

`owner_principal` 记为登录的那个人。**它只能认领自己有权限的应用的任务。**

### 认领与上报

```http
POST /runner/v1/runs:claim            Authorization: Bearer <runner token>
{ "runnerId": "rnr_...", "capabilities": {...} }
→ 200 {
    "runId": "trun_...",
    "env": { "MXT_RUN_ID": "...", "MXT_BASE_URL": "...", "E2E_BASE_URL": "...", ... },
    "secrets": { "MXT_SECRET_USERNAME": "...", "MXT_SECRET_PASSWORD": "..." },
    "runToken": "mxt-run-...",
    "leaseSeconds": 1800
  }
→ 204   # 当前没有适合这台机器的任务
```

`secrets` **只在 claim 响应里出现一次**，不可重复获取。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/runner/v1/runs/:runId/heartbeat` | 续租；超时未续 → `timeout` |
| `POST` | `/runner/v1/runs/:runId/steps` | 实时步骤上报（可选，用于进度） |
| `PUT` | `/runner/v1/runs/:runId/artifacts/*` | 上传产物（本地 runner 用；服务端 runner 直接写 PVC） |
| `POST` | `/runner/v1/runs/:runId:complete` | 提交 `summary.json` + 退出码，run 终结 |

两级 token 的边界：**runner token 只能 claim，不能读写任何 run 的数据；
run token 只能操作自己那一个 run，随 run 终结立即失效。**
理由见 [ADR-0005](adr/0005-federated-identity-and-runner-tokens.md)。

## 错误约定

```json
{ "error": { "code": "no_runner_available",
             "message": "No online runner satisfies os=windows surface=electron",
             "details": { "suite": "compass-electron" } } }
```

常用 `code`：`app_not_found`、`no_runner_available`、`summary_schema_invalid`、
`artifact_storage_full`、`secret_ref_missing`、`task_schedule_invalid`、
`share_expired`、`forbidden_app`。
