# Web Search：Night-All 配置迁移与 Delta 接入

2026-10-13。用户选择在 Internal 服务器重新部署 Hub；本次交付代码、迁移工具和接入文档，未在生产写入凭据、启用操作或发起收费搜索。Delta 的调用合同见 [Web Search](../integrations/web-search.md)。

2026-10-14 部署补充：用户要求从 `config.json` 自动补缺。未配置 `NIGHT_ALL_DATABASE_URL` 的部署现在使用服务器 JSON 导入已支持供应商；已配置 SQL 来源的部署仍遵循下文 SQL 流程，SQL 失败不回退 JSON。每家每次部署仅选一个来源，已有凭据和人工清空保持。JSON 路径发现与状态说明见 [Night-All 供应商凭据迁移](night-all-credential-migration.md)。

## 已核对的来源

本机 Night-All 根目录 `config.json` 的 `searchApis` 中，Exa、Tavily、Serper、You.com、SearchAPI、Firecrawl 六家均有非空 `apiKey` 且 `enabled=true`，固定 origin 与 Hub 适配器相符。SerpApi 没有密钥且停用；没有百度配置节点。此清单只记录存在性，不包含密钥值，不证明供应商账号仍有效。

线上 Hub 浏览器只读观测：LCY-delta 已授权八家，百度显示可调用，另外七家未就绪；Exa 的凭据为 revision 0，操作已有预算。历史文档中的“百度停用”不再代表这次观测。就绪状态不等于真实搜索成功。

用户后续指定直接使用数据库 SQL，替代上一版 JSON 默认迁移。Night-All 的 `start-node.sh` 和 Docker 默认使用 `NIGHTALL_CREDENTIALS_SOURCE=database`；本次迁移默认读取该数据库的 `public.provider_credentials` 与 `public.credential_modules`，仅选择凭据 `status='active'` 且模块 `active=true` 的记录。上面的六家 JSON 清单是历史调查结果，不能当作数据库迁移数量或账号有效性证明。

SQL 见 [源库只读查询](../../scripts/sql/night-all-web-search-credentials.sql)。迁移器以只读事务执行参数化查询，每家最多返回一条，默认遵循 Night-All 的模块优先、provider 回退与更新时间规则。数据库不可用时不回退 JSON，也不使用 Hub 自己的 `DATABASE_URL`。查询结果只在进程内进入加密凭据 API，日志不输出 secret；不要将查询结果导出到终端或日志。

## 服务器部署

同步本次 Hub 代码后，在服务器 `.env.internal` 设置 **Night-All 源库**的连接串（使用具有两张凭据表 SELECT 权限的只读账号，勿提交到 Git）：

```bash
NIGHT_ALL_DATABASE_URL='postgresql://mx_data:REPLACE_WITH_PASSWORD@127.0.0.1:5432/night_all'
```

同机配置已按用户提供的 PostgreSQL 地址核对：本地 Night-All `config.json`、`.nightall-docker/config.json` 和 `start-node.sh` 均选择 `night_all` 库、`mx_data` 用户。`psql -d public_opinion` 只是连接另一数据库，不能证明凭据表也在那里；若服务器用 `DATABASE_URL` 覆盖 Night-All 的默认库，以实际覆盖配置为准。将上面的占位符替换为服务器数据库密码，密码若含特殊字符需作 URL 编码；真实密码不写入本文或 Git。

可先在服务器只读确认数据库和两张表（按提示输入数据库密码，不输出任何供应商 Token）：

```bash
psql -h 127.0.0.1 -p 5432 -U mx_data -d night_all -W \
  -c "SELECT current_database(), to_regclass('public.provider_credentials') AS credentials, to_regclass('public.credential_modules') AS modules;"
```

使用可从服务器主机网络访问的 TCP 地址。部署通过刚构建的 Hub runtime 镜像运行迁移，复用镜像内的 `pg`，不要求源码目录安装 `node_modules`。临时容器使用 host 网络和只读根文件系统，只读挂载迁移脚本目录，不挂载数据库 socket 或额外凭据文件。然后在 `electron-dock/mx-insight-hub` 目录按原方式部署：

```bash
bash scripts/manage.sh ops internal-production deploy
```

部署会在 Admin 就绪后执行：

1. 从 Night-All 数据库读取当前登记八家的有效凭据，通过主机 `127.0.0.1:18151` 的 Admin API 写入对应供应商；不调用搜索供应商。
2. 复用现有默认采购价流程。保留已有价格、预算、人工停用/暂停和 canary 范围；仅既有审计能证明未被人工修改的初始化停用项可恢复。缺失价格仍沿用原部署政策的暂估值，不等于实际供应商收费。
3. 后续请求由原 Key/Consumer 授权、费用、额度和供应商操作控制共同检查。此迁移不修改租户授权、Key secret、搜索顺序或客户价格。

运行链路是 **Delta → Hub Web Search → 对应供应商**。Night-All 数据库只在上述补迁移时读取，供应商 Token 加密保存在 Hub。正常搜索由 Hub 适配器直接调用固定供应商地址和 Hub 自己的出网策略，不转发 Night-All HTTP 服务，也不查询 Night-All 凭据库；Night-All 服务是否运行不影响这条 Web Search 链路。其他尚未迁移的 Hub 产品可能仍使用 Night-All，不能据此停掉整个旧服务。

若 Night-All 的 `searchApis` 使用自定义 `credentialProvider` / `credentialModule`，需要将非默认绑定明确写入同一 `.env.internal`（SQL 表本身不能推断 JSON 内的绑定）：

```bash
NIGHT_ALL_WEB_SEARCH_BINDINGS='{"exa":{"credentialProvider":"shared","credentialModule":"exa-search"}}'
```

只填写存在自定义绑定的供应商。显式绑定精确匹配 provider/module，没有匹配时不回退其他密钥。只指定 provider 时 module 同名；只指定 module 时 provider 默认为对应供应商。Night-All 客户端的环境变量密钥覆盖不在此次 SQL 迁移范围，若运行账号来自环境覆盖，应在 Hub 界面明确录入。源模块的 base_url/host 若与 Hub 固定供应商 origin 不一致，会跳过并报 `source_endpoint_mismatch`。

数据库没有匹配的 active 记录时输出 `source_missing`；连接串缺失、连接失败、字段无效或目标读写失败输出无密钥错误状态并警告。不把可选搜索渠道变成 Hub 启动或登录的依赖。遇到网络失败，先重新读取状态；脚本不自动重发未确认的写入。重复部署保留已配置的 Hub 凭据，也保留 revision 大于 0 的人工清空。迁移后数据库凭据不会持续同步覆盖 Hub 管理员修改。单独 `apply` 不构建镜像；若主机 Docker 镜像已被清理，迁移会警告，使用完整 `deploy` 重建后执行。

## 单独预览或补迁移

在 Hub 目录执行，Admin Token 通过环境提供，不能放入命令参数或贴到聊天。管理地址默认是 loopback；远程仅允许明确指定的 HTTPS origin，拒绝重定向和非本机明文 HTTP。

```bash
# 只读预览；包括所有已登记搜索供应商。
node scripts/migrate-web-search-credentials.mjs \
  --source database \
  --providers baidu,exa,tavily,serper,you,searchapi,firecrawl,serpapi \
  --dry-run

# 执行同一范围；已配置或人工清空的目标保持原样。
node scripts/migrate-web-search-credentials.mjs \
  --source database \
  --providers baidu,exa,tavily,serper,you,searchapi,firecrawl,serpapi \
  --apply
```

上述独立 Node 命令需要 Hub 已安装依赖（包含 `pg`）；完整部署没有此主机依赖要求。独立运行时需先将 `.env.internal` 中的 `NIGHT_ALL_DATABASE_URL`、`MX_INSIGHT_ADMIN_TOKEN` 及可选 `NIGHT_ALL_WEB_SEARCH_BINDINGS` 载入环境；Node 命令不会自动读取该文件。不要把真实连接串或 Token 放入命令参数、聊天或日志。

独立凭据导入只保存加密凭据，不修改操作状态。正常部署的后续补价/启用流程会处理符合现有规则的初始化操作；已有人工状态需在 Admin 明确调整。无匹配凭据的供应商保持不可用，百度既有凭据保持原样。迁移不复制 Night-All 的代理、重试、全文抓取或 AI 答案配置；Hub 固定 HTTP 适配器和每供应商 System Proxy 继续生效。旧 JSON 快照工具仍可显式使用 `--source json`，不属于本次部署路径。

## 管理入口与代理显示修正

- **Web Search → 供应商管理**：Admin Token 会话可看到全部八家，无需先给调试 Key 授权。选择供应商，输入新 API Key 后“保存到数据库”；“查看 / 复制”须再次验证 Admin Token。关闭弹窗、离开管理页或切换供应商/会话后清除页面明文。
- **上游供应商 → 对应平台**：与产品页共用同一份加密凭据，继续管理独立运行开关、采购价格/预算和 System Proxy。租户/Key 的授权和搜索顺序仍独立。
- 百度详情原先显示“TikHub 出网代理”是共享组件标题兜底错误；读取与保存一直使用当前供应商 provider，并非百度绑定了 TikHub。现在标题和探测说明均显示当前供应商，未变更实际代理策略。

## 验收与回退

- 在“上游供应商”检查每家凭据状态与 `web.search` 阻断原因。缺凭据与缺授权是两件事，不要用重复保存租户授权解决供应商配置问题。
- 使用 Delta 原 Hub Key 调用 `GET /api/v1/data/web-search/capabilities`；该读取不触发供应商搜索。保留原 Key 身份与顺序，百度是否排第一以实际 `data.order` 为准。
- 真实查询需显式发送并保存 `Idempotency-Key`、响应顶层 `requestId` / `x-mx-insight-request-id` 与返回结果。当前交付未验证六个账号的真实付费搜索；不要将配置迁移成功、`ready=true` 或本地夹具通过等同于供应商可用性。
- 停用某渠道使用其既有 Admin 操作控制，保留凭据审计、历史请求与幂等交付，不清表、不替换 Key、不改 Launcher/MX-H2I 登录、WireGuard、DNS 或联网配置。

本次不新增数据库 schema migration；Web Search 已有迁移 119。新版文档需要发布 Hub 代码后才会出现在服务器页面。

## 本地验证记录

第一轮 JSON/Delta 文档交付：89 项相关 Node 回归通过，1 项 PostgreSQL 集成测试因未配置一次性测试库跳过；部署 shell 测试 137 项检查通过，构建和 diff 空白检查通过。覆盖真实本机 Admin HTTP/加密凭据/CAS、未知写入后重跑、保留既有凭据与人工清空、禁用源跳过、部署失败隔离、Web Search 权限/幂等与文档示例。Tavily-only 租户的默认 OpenAPI 示例不固定百度，避免复制后越过当前渠道范围。

该轮 Chrome 本机文档预览已检查标题、正文、目录跳转与控制台，无渲染错误。本地 source reader 也已验证六家根 JSON 配置符合字段格式；没有验证账号余额、真实搜索结果或服务器部署。

SQL 与管理页后续交付：102 项相关 Node 测试通过，1 项 PostgreSQL 集成测试因缺少一次性测试库跳过；137 项部署 shell 检查、构建和 diff 空白检查通过。覆盖只读 SQL 参数/绑定、来源失败不回退、目标 CAS 与供应商隔离、八家 Admin 凭据查看/修改、非 Admin Token 拒绝、正确代理名称、未配置来源显示、管理入口授权和无主机 Node 依赖的迁移入口。SQL client 使用合成记录；部署容器参数通过 mock Docker 验证，实际容器/源库连通性和查询执行仍需服务器验证。

本机 Chrome 内存 Hub 验证管理页无需调用 Key、供应商切换、二次 Admin Token 验证读取合成密钥、关闭清除和空表单；控制台无错误/警告。仅使用合成凭据，没有生产密钥或供应商搜索。移动端布局未单独验收。
