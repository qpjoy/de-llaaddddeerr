# 02 · 领域模型与 Schema

## 对象总览

七张表，没有多余的。

| 对象 | 表 | 说明 |
| --- | --- | --- |
| App | `mxt_apps` | 被测应用 |
| Suite | `mxt_suites` | 一组可执行用例，绑定引擎与执行环境 |
| Case | `mxt_cases` | 用例目录条目，`(app_id, case_id)` 唯一 |
| Task | `mxt_tasks` | 任务定义与调度（立即 / 定时一次 / cron 重复） |
| Run | `mxt_runs` | 一次执行 |
| RunCase | `mxt_run_cases` | run 内单个用例的结果——趋势与 flaky 的唯一来源 |
| Step | `mxt_steps` | 用例内的可见步骤，视频时间轴锚点 |
| Runner | `mxt_runners` | 执行节点注册（服务端池 / 个人机器） |

**没有 evidence 表。** 产物是 PVC 上 `/runs/<runId>/` 下的文件，
路径索引以 JSON 挂在 `mxt_runs.artifacts` 上。见 [10](10-deployment.md)。

**没有 gate / verdict 表。** 不做发版门禁（[00](00-overview-and-scope.md) 非目标）。

## Run 状态机

```
queued ──┬─ 服务端 runner: 直接派 Job ──> running ─┬─> passed | failed | flaky
         │                                          ├─> blocked   基础设施问题
         └─ 本地 runner: pending-runner ─claim──┘   └─> timeout
                    │
                    └─ 超过认领窗口 ──> expired   （不算失败）
```

三个状态值得单独说：

- **`blocked`** —— 配置错、浏览器起不来、目标不可达、零用例。对应退出码 2。
  **永远不算通过。** 这条直接继承 compass 的设计，是防止"零用例通过"假绿的关键。
- **`expired`** —— 定时的桌面任务到点了但没有个人机器上线认领。
  **不算失败、不告警**，只在列表里标灰。没有常驻机器的团队也能用定时任务。
- **`flaky`** —— 重试后转绿。不算失败，但单独计数并进入待修复列表。

**RunCase**：`passed | failed | skipped | flaky | notRun`。
`notRun` = 目录里有、这次没跑到，是用例被误删或被 `.skip` 的信号。

## Schema

完整 DDL 见 [`../migrations/001_initial.sql`](../migrations/001_initial.sql)。要点：

### 应用与用例

```sql
mxt_apps(
  id text primary key, slug text unique, display_name text,
  repo_url text, surfaces jsonb,        -- ["web","electron"]
  catalog_glob text, enabled boolean
)

mxt_cases(
  app_id text, case_id text,            -- primary key (app_id, case_id)
  title text, priority text, tags jsonb, tracks jsonb,
  spec_path text, suite_slug text, requirement_ref text,
  first_seen_at, last_seen_at,
  retired_at timestamptz                -- 软删
)
```

Case ID **只在 app 内唯一**。这样 compass 的 `LP-FE-*` 前缀零改动接入，
新应用按 [03](03-case-catalog.md) 的规范走。

`retired_at` 是必需的：用例从目录删掉后，半年前的 run 还引用它，报告不能因此炸掉。

### 任务

```sql
mxt_tasks(
  id text primary key,
  app_id text not null,
  suite_id text not null,
  name text not null,
  profile text not null default 'mock',      -- mock | real
  track text not null default 'functional',
  target_url text,
  -- manual: 只能手动触发 / once: 到 run_at 跑一次 / cron: 按表达式重复
  schedule_kind text not null default 'manual',
  cron_expr text,
  run_at timestamptz,
  timezone text not null default 'Asia/Shanghai',
  -- 本地 runner 任务：无人认领多久后置 expired
  claim_window_minutes integer not null default 720,
  enabled boolean not null default true,
  last_run_id text,
  next_run_at timestamptz,                    -- 调度器扫这一列
  created_by text
)
```

调度器每分钟扫 `enabled AND next_run_at <= now()`，建 run，重算 `next_run_at`。
cron 表达式用五段标准格式，按 `timezone` 计算。

### 执行

```sql
mxt_runs(
  id text primary key,
  app_id text, suite_id text, task_id text,
  profile text, track text, engine text,
  status text not null default 'queued',
  trigger text not null default 'manual',   -- manual | schedule | api
  target_url text,                          -- 已脱敏
  source_ref jsonb,                         -- {gitSha, branch, version}
  runner_id text,
  -- 产物索引，不是字节。目录是 <artifacts>/runs/<id>/
  artifacts jsonb,                          -- {report, videos:[], screenshots:[], expired:false}
  totals jsonb,                             -- {tests,passed,failed,skipped,flaky}
  catalog jsonb,                            -- drift 汇总，见 03
  queued_at, claim_deadline, started_at, finished_at, duration_ms,
  blocked_reason text, created_by text
)

mxt_run_cases(
  id bigserial primary key,
  run_id text references mxt_runs(id) on delete cascade,
  app_id text, case_id text,                -- 无外键：允许目录外的 case（unmapped）
  status text, attempts smallint,
  duration_ms integer, error_text text, spec_path text, title text,
  unique (run_id, app_id, case_id)
)
```

`mxt_run_cases` 是趋势查询的唯一入口：某用例最近 30 次通过率、首次失败的 commit、
flaky 排行，都从这张表出，不去解析 `summary.json`。

```sql
mxt_steps(
  id bigserial primary key,
  run_id text references mxt_runs(id) on delete cascade,
  case_id text, seq integer, label text, status text,
  offset_ms integer,          -- 相对该用例录像起点，用于点击跳转
  duration_ms integer
)
```

`offset_ms` 是给管理员 review 用的：报告里点"步骤 4 · 加载策略列表 ✗"直接跳到录像的
那一秒。compass 的 `cy.step()` 已经画了屏幕横幅，但没把时间戳交出来——这是明确的补强。

### Runner

```sql
mxt_runners(
  id text primary key,
  name text unique,
  kind text not null,            -- server | local
  os text, arch text,
  capabilities jsonb,            -- {engines:[], surfaces:[], concurrency:n}
  owner_principal text,          -- 本地 runner 的归属人（mx-launcher principal）
  token_sha256 char(64) not null,
  status text, last_seen_at timestamptz
)
```

`owner_principal` 让"这台机器是谁的"可见,也是权限判断的依据——一个人只能认领
自己有权限的应用的任务。

## 索引

```sql
create index on mxt_runs (app_id, suite_id, started_at desc);
create index on mxt_runs (status, queued_at) where status in ('queued','pending-runner');
create index on mxt_run_cases (app_id, case_id, id desc);   -- 单用例趋势
create index on mxt_tasks (enabled, next_run_at) where enabled;
```
