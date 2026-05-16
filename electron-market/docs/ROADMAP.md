# QPJoy Plugin Market — 长期规划

本文是把"插件市场"从当前的本地原型推到"远程注册中心 + 多端嵌入 + 鉴权 + 同步"的全景图。下面所有阶段都可独立交付。

---

## 阶段 0（现状）

- 23455：Quasar 单页 SPA + REST API（host 本地）
- 23456：tunnel 自己的 admin（独立 HTTP 服务）
- SQLite：`<userData>/<app>/electron-plugin.db`，仅 host 自己用
- 远程 registry：硬编码 URL，未联网时整页报 500（**当前 bug**）
- 插件市场入口和宿主 App UI 完全割裂

## 阶段 1：离线可用（最近一公里）

**目标**：拔掉网线也能跑。

工作项：
1. host 包**自带一份兜底 `index.json`**（`registry/seed-index.json`，构建时拷进 `dist/`）。
2. `MarketplaceClient` 加 fallback：远端 fetch 失败 → 读本地兜底 → 写本地 SQLite `marketplace_cache` 表。
3. `/api/marketplace` 返回 cache + 远端 merged 视图，永不 500（远端失败时只在响应里多个 `staleSince` 字段）。
4. SPA 上添加"离线/在线"指示灯。

## 阶段 2：统一数据层 + migration 框架

**目标**：把当前 minimal 的 `electron-plugin.db` 扩成"市场的本地真相源"，并配套 migration 引擎。

### 2.1 选址

```
<userData>/qpjoy-plugin-host/marketplace.db    ← 单 app 内共享
```

跨 app 共享（`~/Library/Application Support/QPJoy/marketplace.db`）我倾向**不要**，理由：
- userData 隔离是 Electron 标准做法，跨 app 共享要处理多进程写入冲突
- 不同 host 装的插件版本可能不一样，强行共享会乱
- 同一台机器装多个 qpjoy app 是少数情况

但我想确认你的偏好（见下面问题区）。

### 2.2 Schema 设计（v1）

```sql
-- 系统 / migration 跟踪
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,        -- 001, 002, ...
  applied_at TEXT NOT NULL,
  checksum TEXT NOT NULL,             -- 防止偷改 sql
  release TEXT NOT NULL               -- 哪个 market release 引入的
);

-- 市场目录缓存（来自远端 / 本地 seed）
CREATE TABLE marketplace_entries (
  id TEXT PRIMARY KEY,                -- qpjoy.electron-tunnel
  npm TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  latest_version TEXT NOT NULL,
  manifest_url TEXT,
  tarball_url TEXT,
  homepage TEXT,
  verified INTEGER NOT NULL DEFAULT 0,
  bootstrap INTEGER NOT NULL DEFAULT 0,
  category TEXT,                      -- tunnel / theme / utility / ...
  visibility TEXT NOT NULL DEFAULT 'public',  -- public / paid / private
  spec_version INTEGER NOT NULL DEFAULT 1,    -- 哪个市场规则版本
  metadata_json TEXT,                 -- 备用：作者、icon、screenshots
  fetched_at TEXT,
  source TEXT NOT NULL DEFAULT 'remote'  -- remote / seed / manual
);

CREATE TABLE marketplace_versions (
  entry_id TEXT NOT NULL,
  version TEXT NOT NULL,
  changelog TEXT,
  released_at TEXT,
  min_host_version TEXT,
  max_host_version TEXT,           -- null = 永久向前兼容
  deprecated INTEGER NOT NULL DEFAULT 0,
  yanked INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (entry_id, version),
  FOREIGN KEY (entry_id) REFERENCES marketplace_entries(id)
);

-- 已安装插件（替换当前的 plugins 表，新增字段）
CREATE TABLE installed_plugins (
  id TEXT PRIMARY KEY,
  npm TEXT NOT NULL,
  version TEXT NOT NULL,
  install_path TEXT NOT NULL,
  install_source TEXT NOT NULL,    -- seed / registry / tarball / local-dir / sideload
  manifest_json TEXT NOT NULL,
  granted_permissions_json TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL,
  error_message TEXT,
  installed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- 远端关联（可能为 NULL：本地 sideload 的插件）
  marketplace_entry_id TEXT,
  FOREIGN KEY (marketplace_entry_id) REFERENCES marketplace_entries(id)
);

CREATE TABLE plugin_logs ( ... );    -- 现有，加 release/correlation_id 字段

-- 远端同步状态
CREATE TABLE remote_sync (
  scope TEXT PRIMARY KEY,          -- marketplace / migrations / user
  last_release TEXT,
  last_fetched_at TEXT,
  next_check_at TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);

-- 用户会话（阶段 5 才填，现在保留空表）
CREATE TABLE auth_session (
  id INTEGER PRIMARY KEY,
  access_token TEXT,
  refresh_token TEXT,
  expires_at TEXT,
  user_json TEXT
);
```

### 2.3 Migration 引擎

```
electron-market/packages/electron-market/src/db/
├─ Migrator.ts            # apply / status / rollback
└─ migrations/
   ├─ 001_initial.sql
   ├─ 001_initial.down.sql
   ├─ 002_add_marketplace_cache.sql
   ├─ ...
```

规则：
- 启动时 host 自动 `migrate:up`，跑到 host 包内嵌的最高版本。
- 远端 `version.json` 里的目标版本 > 本地最高版本时 → 通过 REST 拉对应 `.sql` 文件并执行（详见阶段 4）。
- 每条 migration 写校验和；下次启动校验，被改动过的迁移拒绝重跑（防止"偷改历史"）。
- `down` 仅在 dev 工具用，生产侧默认禁用。

### 2.4 tunnel 数据共享？

你的原文：「不管是只装了 electron-tunnel 还是通过 electron-plugin 安装插件，它们共用一个 sqlite」。

我建议**两层 DB**：
- `marketplace.db`（host 拥有）：市场目录、安装清单、权限、日志、远端同步状态。
- 各插件自己的 `plugin-data/<id>/<plugin>.db`：插件运行时业务数据（tunnel 的订阅、规则、流量等）。

理由：插件可以独立安装/卸载，业务数据应该在插件自己的沙箱里；市场只关心"装了什么"。

但 tunnel 独立安装时（没有 electron-plugin）的情况怎么办？我提议：
- 单独的 `@qpjoy/electron-tunnel` 装上去时，它在 host app 的 userData 里**也**写一份 `marketplace.db`（只有 installed_plugins 里那一行就是它自己），相当于一个"degenerate marketplace"。
- 之后用户装上 electron-plugin → electron-plugin 检测到这个 `marketplace.db` 已经存在 → 直接接管。

我想问你是不是这个意思，见问题区 Q1。

## 阶段 3：可嵌入的市场面板

**目标**：让任意 host app（包括 electron-test 这样的小测试 app，也包括将来的 quasar-client 主应用）能把整个 23455 市场面板内嵌进自己的 UI。

### 3.1 嵌入模型

我比较了三种方案，**推荐方案 B**：

| 方案 | 描述 | 优点 | 缺点 |
| --- | --- | --- | --- |
| A：iframe 套 iframe | 业务 app 用 iframe 套 23455；23455 再用 iframe 套 tunnel 的 23456 | 实现简单 | 跨 iframe 通信 hop 多；样式难继承；back 按钮逻辑混乱 |
| **B：单 iframe + postMessage 协议** | 业务 app 用 iframe 套 23455；23455 内部用 `<router-view>` 切换"已安装/市场/插件详情/插件 admin"，插件 admin 是 23455 内部再开一层 iframe | back 在 23455 内部就能完成；和业务 app 只用 postMessage 沟通主题/导航；插件作者只写自己的小 admin | 需要定义 postMessage 协议 |
| C：纯 Vue 组件库 | 把 23455 SPA 抽成 npm 包，业务 app 直接 import 用 | 体验最融合 | 业务 app 必须用 Vue/Quasar；跨技术栈不可用 |

#### B 方案细节

```
业务 app (Quasar / React / 任何)
   │
   │  <iframe src="http://127.0.0.1:23455/?embed=1&theme=dark&returnUrl=/dashboard">
   ▼
23455 (Quasar SPA, 嵌入模式)
   ├─ 路由 / : 已安装列表
   ├─ 路由 /marketplace : 市场列表
   ├─ 路由 /plugin/:id : 插件详情 + admin iframe
   │     └─ <iframe src="http://127.0.0.1:23456">   ← tunnel admin
   └─ 路由 /logs/:id : 日志
```

postMessage 协议 v1（type / payload）：

| 方向 | type | payload | 用途 |
| --- | --- | --- | --- |
| parent → market | `set-theme` | `{ mode: 'light' \| 'dark', primary?: string }` | 主题继承 |
| parent → market | `set-locale` | `{ locale: 'zh-CN' \| 'en-US' }` | 语言 |
| parent → market | `navigate` | `{ path: '/marketplace' }` | 外部触发跳转 |
| market → parent | `ready` | `{ version: '0.1.0' }` | SPA mount 完成 |
| market → parent | `request-close` | `{ returnUrl?: string }` | 用户在 23455 顶部点了 "返回业务 app" |
| market → parent | `notify` | `{ level, message }` | 给宿主一份 toast 用 |
| market → parent | `route-change` | `{ path }` | 同步给宿主，方便宿主在 tab 上加 breadcrumb |

宿主侧只需要一段 ~40 行的 JS shim：监听 message + 用 postMessage 发指令。我会把它作为 `@qpjoy/plugin-market-embed` 单独发包。

### 3.2 内嵌时的 UI 变化

`?embed=1` 时：
- 隐藏 23455 自己的侧边栏（让宿主 app 来导航），只显示当前页面内容
- 顶部加一个 `<q-bar>`，左侧"← 返回"按钮 → postMessage `request-close`，右侧"在新窗口打开"按钮 → `window.open('/')`
- 主题色变量改成从 postMessage 传进来的值

### 3.3 插件 admin 嵌入

`/plugin/:id` 页面右侧拿出一块大区域显示该插件的 admin（如果 manifest 声明了 `contributes.adminPanel.url`），用 iframe 加载。也支持 `contributes.adminPanel.kind: 'embed' | 'external'` 让插件作者选择"嵌入显示"还是"另开窗口"。

## 阶段 4：远程注册中心

**目标**：让用户能联网拉到 qpjoy 官方插件目录的最新版。

### 4.1 服务端架构

```
┌────────────────────────────────────────┐
│  CDN (OSS + CloudFront / qcloud CDN)   │
│  /                                      │
│    api/v1/version.json                  │   ← 几 KB，轮询用
│    api/v1/marketplace/index.json        │   ← 公共目录全量
│    api/v1/migrations/0042.sql           │   ← 单条 migration
│    api/v1/plugins/<id>/manifest.json    │
│    api/v1/plugins/<id>/screenshots/*.png│
└────────────────────────────────────────┘
                │ 失效 / 上传
                ▼
┌────────────────────────────────────────┐
│  REST API server (Node + Fastify)      │
│   POST /api/v1/auth/login              │
│   GET  /api/v1/users/me                │
│   GET  /api/v1/marketplace/premium     │   ← 鉴权后的付费目录
│   POST /api/v1/admin/plugins           │   ← 后台同步用
│   POST /api/v1/admin/sync-npm          │   ← 触发 npm 扫描
└────────────────────────────────────────┘
                │
                ▼
            Postgres
```

公开内容 100% 走 CDN，鉴权内容走 API 服务器。客户端不知道服务器域名就能用基础功能。

### 4.2 版本/兼容矩阵

`version.json` 里出现的字段：

```jsonc
{
  "release": "2026.05.01",
  "minClientRelease": "2026.04.01",   // 比这老的 host 视为不兼容，弹升级提示
  "marketSpecVersion": 1,             // 市场规则版本（plugin manifest 用同一个）
  "supportedSpecRange": ">=1 <=1",    // 此 release 能消化的 plugin spec 版本
  "migrationsHead": 42,               // 客户端要把本地 schema 推到这个版本
  "manifestEtag": "sha256-...",       // marketplace index 的 hash，没变就不重拉
  "publishedAt": "2026-05-01T00:00:00Z"
}
```

向前兼容：
- 市场只关心 plugin manifest 的 `specVersion`。
- `supportedSpecRange` 决定哪些插件还能装。超出范围的插件在列表里灰色 + tooltip"市场规则已不兼容此插件，请通知作者升级"。
- 永远不直接删旧记录；只标 `deprecated` 或 `yanked`。

向后兼容：
- 老 host（minClientRelease 之下）连上新 server，server 返回 `426 Upgrade Required` + 一份"建议升级到 X 版本"的 hint。
- host 看到 426 时切回 cached / seeded 数据，不阻塞使用。

### 4.3 同步流程

```
启动 → 调度器（jitter，避免雪崩）
   │
   ▼
fetch /api/v1/version.json （CDN）
   │
   │  比较本地 schema_migrations.head 和远端 migrationsHead
   ▼
若需要 schema 升级:
   for v in localHead+1 .. remoteHead:
      fetch /api/v1/migrations/<v>.sql （CDN）
      校验 checksum（version.json 里附带）
      执行
      记录 schema_migrations
   │
   ▼
比较 manifestEtag：变了就 fetch /api/v1/marketplace/index.json，写入 marketplace_entries 表
   │
   ▼
若 user 已登录: fetch /api/v1/marketplace/premium（API server）
   │
   ▼
更新 remote_sync.last_release, last_fetched_at
```

整个过程**只读**远端，本地数据库一直是真相源。任何远端故障都不影响已装插件的运行。

### 4.4 CDN 与鉴权的取舍

你担心的点（CDN 不好做鉴权）确实存在。我的处理：

| 内容 | 渠道 | 鉴权 |
| --- | --- | --- |
| version.json / 公共 index.json / migrations | CDN | 无 |
| 公共插件 manifest / screenshots / 免费 tarball | CDN | 无（任何人能拉） |
| 付费/私有插件目录 | REST API | JWT |
| 付费插件 tarball 下载 | 走 API → 返回 OSS 预签名 URL（短期有效） | JWT + 一次性 URL |
| 用户数据、订阅、license | REST API | JWT |

这样 80% 流量通过 CDN，付费部分通过 API。客户端简单：先试 CDN，登录态下再叠加 API 数据。

## 阶段 5：鉴权与付费层

### 5.1 账号体系

- 邮箱注册 + magic link（避免存密码）。
- 可选 GitHub OAuth（方便插件作者绑定）。
- JWT 短期 token + refresh token，存在 `auth_session` 表。

### 5.2 三档可见性

```
visibility:
  - public    无需登录可见
  - free      需登录但免费
  - paid      需要 entitlement
  - private   仅作者自己 / share link
```

`/api/v1/marketplace/index.json` 只放 public。客户端登录后调 `/api/v1/marketplace/visible-to-me` 拿到融合后的列表。

### 5.3 客户端表现

- 未登录：可以浏览 public、可以装 public/bootstrap、看 free/paid 时显示"登录后查看"灰色卡。
- 登录后：自动并入 free。
- 付费插件 install 之前调 `/api/v1/entitlements/<plugin>` 看是否有 license；没有就跳支付。

## 阶段 6：服务端运维

### 6.1 仓库布局

新建一个独立的 `qpjoy-market-server` 仓库（或在 monorepo 里加 `server/` 顶级目录）。我倾向**新仓库**，理由是部署节奏完全不一样，不想用 git tag/branch 区分。

```
qpjoy-market-server/
├─ src/
│  ├─ api/          # Fastify routes
│  ├─ db/           # Postgres schema + migrations
│  ├─ jobs/         # cron jobs（npm sync 等）
│  └─ cdn/          # 生成 version.json / 上传文件到 OSS
├─ scripts/
│  ├─ deploy.sh
│  ├─ sync-npm.ts   # 扫 @qpjoy/electron-*，同步到 DB
│  └─ promote.ts    # 把一个 staging release 推到 production
├─ migrations/      # postgres 这边的 migrations
└─ Dockerfile
```

### 6.2 本地/远端 migration 同步

我提议**手写两套**（不是从一套生成另一套）：

- `electron-market/packages/electron-market/src/db/migrations/*.sql` （SQLite 方言）
- `qpjoy-market-server/migrations/*.sql` （Postgres 方言）

理由：表结构虽然概念上对齐，但本地有 `installed_plugins`（服务器不需要）、服务器有 `users`、`entitlements`、`audit_logs`（本地不需要）。强行共享反而易错。每次给市场加新概念时**同时**写两份。

### 6.3 npm 同步

`scripts/sync-npm.ts` 干的事：
```
GET https://registry.npmjs.org/-/v1/search?text=scope:@qpjoy+keywords:qpjoy-plugin
   ↓
for each package starting with "@qpjoy/electron-":
   GET https://registry.npmjs.org/<pkg>
   检查 package.json#qpjoyPlugin
   解压最新 tarball 的 dist/plugin.manifest.json
   upsert marketplace_entries + marketplace_versions
   ↓
触发 OSS 上传：把更新后的 index.json、新的 manifest.json 推上去
   ↓
增量 version.json（release += 1）写到 CDN，触发 CDN 失效
```

执行节奏：每天 cron 一次，附带 webhook 入口让自己手动触发。

### 6.4 远端 admin

服务端 admin 复用 `electron-market/packages/admin-ui` 的 Vue 代码（理由：少维护一份 UI），但跑在不同的 mount：

- `https://admin.qpjoy.dev` ← 服务端 admin（鉴权 + 多用户）
- `http://127.0.0.1:23455` ← 本地 host admin（同源、单用户）

通过环境变量切换 API base 和登录态。

## 关键决策点（请确认）

请回答下面几个问题，回完我开始按阶段 1 → 2 → 3 的顺序写代码。

### Q1：tunnel 单独安装时的数据共享

我的提议：tunnel 独立安装时也写一份 `marketplace.db`，只有一行就是自己。你是这个意思吗？还是说"tunnel 完全不碰 marketplace.db，只有 electron-plugin 在的时候才有这张表"？

### Q2：marketplace.db 选址

- 选项 A：`<userData>/qpjoy-plugin-host/marketplace.db`（per-app，推荐）
- 选项 B：`~/Library/Application Support/QPJoy/marketplace.db`（机器全局共享）

我推荐 A。你选哪个？

### Q3：服务端技术栈

- Node + Fastify + Postgres ←我推荐，和现有栈一致
- 其他偏好？（Go / Rust / Python）

### Q4：CDN 提供商

- 阿里云 OSS + 阿里云 CDN
- 腾讯云 COS + 腾讯云 CDN
- AWS S3 + CloudFront
- 初期就用 nginx + Let's Encrypt 自建（最便宜，量小时够用）

哪个？

### Q5：嵌入时的宿主技术栈

未来打算把市场嵌入哪些 app？

- (a) 全是 Quasar / Vue：我可以再做一份"Vue 组件版"省 iframe
- (b) 有 React / 其他：必须走 iframe + postMessage 方案 B
- (c) 不确定

如果是 (b) 或 (c)，按方案 B 设计就行。

### Q6：登录方式

- 邮箱 magic link（推荐，无密码运维负担）
- 邮箱 + 密码
- GitHub OAuth 优先

哪个或组合？

### Q7：本地数据库迁移目录现状

当前 `electron-plugin.db` 表结构很小（plugins + plugin_logs）。我倾向**直接重新设计**（drop 旧表 + 新建 schema），因为现在还没人用。你 OK 吗？

如果 OK，第一次 v0.2 升级时会清掉用户已有的安装记录，需要重新 seed。这对你目前只有一个本地测试环境不算问题。

### Q8：实现节奏

我建议按这个优先级，每完成一段提交一次：

1. **阶段 1 + 阶段 3.1（嵌入模式）**：先解决 500 + 让市场能嵌进 electron-test 那个 quasar 界面（不再是独立的 tab 弹窗）。1～2 天工作量。
2. **阶段 2（统一数据层 + migration）**：把 schema 重新设计、引入 migration 引擎。2 天。
3. **阶段 4（远端拉取，先不做 auth）**：定义 REST + CDN 契约，搭最小 Node server + npm 同步脚本。3～5 天。
4. **阶段 5（auth）+ 阶段 6 剩余**：1 周以上。

你是按这个顺序、还是先要某一块？

---

## 我打算先动的代码

不等问题答完，我会先做"不会被你的回答推翻"的部分：

1. ✅ 修阶段 1 的 500（host 自带 seed-index.json，远端失败时降级）。
2. ✅ 阶段 3.1 的 `?embed=1` 模式 + postMessage 协议（双 iframe 还是单 iframe 已经定了）。
3. ✅ 在 electron-test 里把 tunnel 的 admin 从"另开链接"改成"嵌入 23455 的插件详情页"。

剩余部分等你回 Q1 ~ Q8 后再展开。
