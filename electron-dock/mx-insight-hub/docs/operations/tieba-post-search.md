# 百度贴吧帖子搜索接入与验收

更新于 2026-11-18。本页描述仓库中的实现；尚未完成真实上线、会话有效性、联网采集和入库检索的联合验收。离线测试通过、引擎探测健康、任务交付成功是不同证据，不能互相替代。

## 接入范围

公开能力为 `collect.tieba.posts.search`，通过 Night-All-A 的 `tieba / content.search` 匿名搜索公开主题。只接收 `tieba.thread`；用户、楼层和评论实体不进入这个产品。`body` 保留搜索实际返回的正文或片段，不承诺已经抓取帖子全文、所有楼层或全部搜索结果。

新采集使用独立的 `datasetId=tieba.posts.v1`、`platform=tieba`、`objectType=post`，采集连接器标识为 `collect:tieba-post-search`。主题 ID 保留为字符串，以平台、对象类型和源 ID 形成稳定身份；相同主题的后续采集按既有 canonical 入库机制更新。原 `data_center_saved_records_forum` / `data-center.saved-records.forum.v1` 的身份、检查点和新闻发布规则保持原样，历史论坛记录不会因为新能力自动公开或迁移。

本接入不修改 MX-H2I 的登录、联网、Launcher SSO、WireGuard 或 DNS，也不复用用户的登录凭据。

## 授权与默认状态

| 操作 | 所需授权 |
|---|---|
| 提交采集任务 | 调用方与 API Key 的有效能力授权包含 `collect.tieba.posts.search` |
| 查询自己的任务与交付结果 | 现有 collect 调用方归属校验 |
| 查询已入 Hub 的帖子 | 调用方与 API Key 的有效平台授权包含 `tieba` |

采集能力授权不隐含已存数据授权；`tieba` 平台授权也不授予实时采集。已有论坛平台授权不会自动扩大为 `tieba`。授权检查同时考虑调用方授权和 Key 的范围快照。

能力目前为 `candidate`。标准引擎 `night-all-a.tieba` 的类型为 `night_all_a`、容量为 1；新建默认 `enabled=false`、`billingEnabled=false`。候选能力不会因加入目录而自动授予 `managed_full` Key。必须完成引擎配置、显式授权和启用，才能派发任务。

## 引擎和平台会话

标准引擎使用 `http://100.127.0.1:8100`；代码仅接受该固定主机的 `8100` 或 `8101` 端口。调用方不能指定来源地址、连接器、认证模式或备用来源。

标准凭据名为 `collect-night-all-a-session`，复用 Hub 现有凭据库。凭据内容是 JSON 字符串：

```json
{"sessionCookie":"<dq_admin_session 的值>","csrfToken":"<平台 CSRF token>"}
```

这里只填 cookie 的值，不含 `dq_admin_session=` 或完整 `Cookie` 请求头。两个字段均必填，不允许额外字段。适配器将其转换为 `Cookie: dq_admin_session=...` 和 `x-csrf-token`。这是 Night-All-A 管理平台会话，不是百度贴吧账号 cookie，也不是 MX-H2I 登录 token；贴吧查询固定 `auth_mode=anonymous`。

可在 Hub 管理台「自建引擎」录入该 JSON，或使用既有管理接口：

1. `GET /internal/v1/admin/collect/engines/night-all-a.tieba` 读取 `data.credential.revision`。
2. `PUT /internal/v1/admin/collect/engines/night-all-a.tieba/credential`，请求字段为 `apiKey`（上面的 JSON 序列化为字符串）、`expectedRevision`（当前版本，首次为 0）、`reason`（操作原因）。

凭据只写不回显；平台会话过期时通过同一接口更新。不要把实际会话写进文档、命令历史或版本库。只有显式去掉引擎的 `credentialProvider` 才表示使用上游 VPN 免认证模式；标准配置不会在缺少会话时自动降级。

`POST /internal/v1/admin/collect/engines/night-all-a.tieba/probe`，空 JSON `{}`，只读取 `/api/connectors?q=tieba`，核验清单有效且包含 `content.search`。探测成功不代表贴吧查询、保存记录、Hub 入库或索引可用。

## API：提交、轮询、读取结果

公共请求沿用 Hub API Key 认证。下列 JSON 是请求体示例；提交需要独立的 `Idempotency-Key`（8–128 个安全字符）。

`POST /api/v1/data/collect/jobs`

```json
{
  "capability": "collect.tieba.posts.search",
  "input": {
    "query": "新能源汽车",
    "maxResults": 20,
    "page": 1,
    "maxPages": 1
  }
}
```

| 参数 | 规则 |
|---|---|
| `query` | 必填，去除首尾空白后 1–200 个 Unicode 码点，不能含控制字符 |
| `maxResults` | 整数 1–100，默认 20 |
| `page` | 整数 1–1000，默认 1 |
| `maxPages` | 整数 1–10，默认 1 |

只接受这些输入字段。`maxResults` 是本次请求上限；`page` / `maxPages` 是有界源分页，不是 Hub 已存检索的游标。此能力只支持异步 `/jobs`，不支持同步 `/query`。

提交返回 `202`，任务标识在 `data.jobId`；优先使用返回的 `data.links.self` / `data.links.result`：

1. `GET /api/v1/data/collect/jobs/{jobId}`：轮询 `data.status`，排队或执行中遵循 `Retry-After`。`data.delivery.available` 表示交付结果已经保存。
2. `GET /api/v1/data/collect/jobs/{jobId}/result`：读取 `data.payload`。尚未准备好返回 `409 result_not_ready`；终态无结果返回 `409 result_unavailable`。

交付 payload 仅包含 `platform`、`items` 和 `completeness`。每个 item 包含源主题字符串 ID、`contentType`、URL、标题、正文、有限作者与贴吧标识、指标、白名单图片 URL 和发布时间；不包含原始来源载荷、上游 task/run ID 或会话。缺失或不可验证的可选指标为 `null`，不补成 0。完整原始证据保存在受限入库链路中。

`dataStatus` 为 `success`、`no_data` 或 `partial`；同时读取 `payload.completeness` 中的 `scope=request`、`complete`、`requested`、`returned`、`stopReason`。达到请求上限的 `complete=true` 只表示完成本次请求，不表示穷尽贴吧。分页限制、限流等造成的部分结果仍可能交付为 `partial`；不凭空生成下一页游标。

Hub 会核验上游任务/运行身份、请求参数、终态及非空结果的保存计数，再校验整个主题批次。上游使用 `persist_results=true`、`max_attempts=1`。收到无法验证或丢失的提交回执时记为未知状态，不自动重交任务或切换来源。

## 异步入库与已存检索

链路为：

```text
POST collect/jobs → 上游任务 → 轮询并验证 → 安全交付结果 + 受限 ingest 队列（同一事务）
                                               ↓
                          ingest worker → canonical PostgreSQL → 检索投影/索引
```

ingest worker 核验已提交的 collect 任务状态、公开结果摘要及完整原始入库载荷的独立摘要，再重新校验原始主题，调用既有 `ingestExternalRecords`。摘要在任务完成的同一事务中保存，JSONB 字段顺序变化不影响验证。标题、正文、源 ID、作者、贴吧、可用指标与原始证据保留；公开输出没有任意 raw 扩展字段。观测时间来自已验证的上游 `finished_at`，而不是最后一次轮询时间。迟到的旧采集会保留原始证据，但不会覆盖较新的当前数据或索引。

**任务 succeeded、delivery.available 或 result 可读都不等于已入库/已建立索引。** ingest 与检索投影是独立的异步环节；失败应排查并重试保存的队列载荷，而不是再次向贴吧采集。

持有独立 `tieba` 平台授权的 Key 可调用 `POST /api/v1/data/stored/search`，另带该查询自己的 `Idempotency-Key`：

```json
{
  "platform": "tieba",
  "datasetId": "tieba.posts.v1",
  "objectType": "post",
  "query": "新能源汽车",
  "pageSize": 20,
  "type": "fresh"
}
```

同样可使用既有 `POST /api/v1/data/canonical/search` 做已存检索。两者都不触发外部采集；按现有 stored/canonical 授权、查询和计费规则执行。新的入库可见性检查应使用新的查询幂等键，避免把此前保存的检索交付当成最新索引状态。不要用原论坛平台或 live-compatible `/data/search` 代替这里的专用数据集过滤。

## 计费、重放与恢复

复用 collect 的预留、结算、任务幂等和结果读取机制。相同调用方用同一幂等键及相同规范化请求重试提交，会获得同一任务；更改请求不能复用该键。轮询、结果重读和 ingest 队列重试不重新派发，也不再次收取该任务的采集费用。

引擎默认关闭计费。显式开启后，按既有 collect 每任务结算：可验证成功交付包括 `partial` / `no_data`，不能假定零条结果免费；未知结果进入待核实状态，失败按现有释放规则处理。新幂等键是新任务，可产生新的采集及费用。stored/canonical 检索是独立业务请求，不包含在上述采集幂等中。

## 上线验收步骤

本次只接入贴吧，推荐使用单引擎 Admin API 创建、配置和启用。以下步骤尚未作为本次上线验收执行。

先 `GET /internal/v1/admin/collect/engines/night-all-a.tieba` 确认现状；若尚不存在，调用 `POST /internal/v1/admin/collect/engines`：

```json
{
  "id": "night-all-a.tieba",
  "kind": "night_all_a",
  "displayName": "百度贴吧帖子搜索",
  "baseUrl": "http://100.127.0.1:8100",
  "credentialProvider": "collect-night-all-a-session",
  "capacity": 1,
  "enabled": false,
  "billingEnabled": false,
  "routes": [{"capability": "collect.tieba.posts.search", "routeKey": ""}],
  "reason": "贴吧帖子搜索接入，保持停用待验收"
}
```

按上文录入会话并单独探测该引擎。健康后再次读取引擎详情，将 `data.engine.revision` 作为当前版本，调用 `PUT /internal/v1/admin/collect/engines/night-all-a.tieba`：

```json
{"enabled":true,"expectedRevision":1,"reason":"贴吧帖子搜索显式联网验收"}
```

其中 `expectedRevision:1` 仅为示例，必须替换为刚读到的实际版本。探测健康只代表连接器目录可用；还需独立检查调用方能力授权和 Key 范围。

标准脚本清单也包含 `night-all-a.tieba`，`node scripts/collect-acceptance.mjs plan` 可只读查看差异。其 `apply` 当前会创建**所有缺少的标准引擎**，`enable --healthy` 会启用所有探测健康的引擎，均不作为本次单独接入贴吧的操作步骤。

以下 smoke 命令在 Hub 目录执行。脚本 Admin Token 读取 `MX_INSIGHT_ADMIN_TOKEN`，未设置时读取 Hub 目录 `.env.internal`；默认 Admin 为 `http://10.88.88.88:18151`、Public 为 `http://10.88.88.88:18150`，可用真实支持的 `--admin` / `--public` 覆盖。

贴吧验收会真实采集并保存到 Night-All-A 与 Hub，因此标为 `explicitOnly`。普通 `smoke` 会跳过；必须用匹配它的 `--only` 显式选中，建议使用完整能力名：

```bash
node scripts/collect-acceptance.mjs smoke --only collect.tieba.posts.search --key-file /root/collect-acceptance.key
```

首次没有验收 Key 时，将 `--key-file` 换成 `--create-key /root/collect-acceptance.key`。脚本新建的验收 Key 授予全部 smoke 能力、`platforms=[]`，写到 0600 文件且不打印；已有 Key 不会自动补权。该 Key 因而不能直接完成 `tieba` 已存检索验收，需另外显式配置平台授权。

当前 smoke 输入是 `query=新能源汽车`、`maxResults=2`、`maxPages=1`。脚本只提交并轮询任务终态，不会读取 result、等待 ingest 或验证搜索命中。完整验收还需独立确认：

1. result 的条目、完整性与源持久化证据一致；partial 如实显示，不伪装全量成功。
2. 受限 ingest 队列完成，canonical 数据落入 `tieba.posts.v1 / tieba / post`，检索投影完成后能按源主题 ID 和正文核对。
3. 单独的 `tieba` 平台授权可查询；仅采集授权、旧论坛授权不能获得该平台查询权限。
4. 相同采集幂等键重放返回相同 job，结果重读和队列重试不重复采集或结算；MX-H2I 登录与联网维持原有行为。

真实部署、凭据录入、启用、联网 smoke 及以上联合验收均应另行记录实际证据；本页不代表这些步骤已经执行。

## 代码入口

- 能力、参数与适配器：[`shared/collect-engines.mjs`](../../shared/collect-engines.mjs)、[`server/collect/catalog.mjs`](../../server/collect/catalog.mjs)、[`server/collect/contracts/night-all-a.mjs`](../../server/collect/contracts/night-all-a.mjs)。
- 清洗、事务队列与入库：[`server/ingest/tieba.mjs`](../../server/ingest/tieba.mjs)、[`server/collect/store.mjs`](../../server/collect/store.mjs)、[`server/workers/ingest.mjs`](../../server/workers/ingest.mjs)。
- 路由、验收脚本与通用手册：[`server/app.mjs`](../../server/app.mjs)、[`scripts/collect-acceptance.mjs`](../../scripts/collect-acceptance.mjs)、[采集引擎上线手册](collect-engines-rollout.md)。
