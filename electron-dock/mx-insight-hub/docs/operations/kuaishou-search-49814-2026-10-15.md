# 快手 49814f8b 响应不可用

日期：2026-10-15。候选修复已通过精确生产原归档的离线验收；生产发布尚未执行。

## 原归档证据与候选修复

操作者返回 v9（diagnostic SHA `331fa0a2f95b0b1ed262fac144ea53ea4de74dc36267fe83ab6a50bd7e963260`，业务 parser SHA `a972eb6bf0a855f506873e137038b7ff77024bd29e4b1621491e6921e703a09e`）。这是已生成的有效 v9，后续仅诊断元数据投影的收紧不影响本次结果，无需为版本差异重跑。

精确 own call `96762ff5-1e1a-4579-a052-1d2b44a804fe`，HTTP／业务码均 200、供应商 `billed=true`、`succeeded_unusable`，错误为 `upstream_payload_unrepresentable`。请求已 committed 502；完整 207474 字节归档 SHA `43d5d1899e62b528b3549b1b42f5a9413580f571f1f7091bc30a5ac603b72d06` 已核验，操作归档／1 个 archive object 已保存，没有 ingest job。该供应商计费标记不等同于客户结算证据。

由此确认首个失败发生在适配器的完整原始 JSON 可存储性检查。具体不安全叶子尚未定位；不能归因于 `photo_id` 大整数，因为该通用 JSON 检查并不拒绝有限的大整数。10 个作品各自使用现有 ID 规则投影通过，并可写入 PostgreSQL。

同页 `data.mixFeeds` 共 11 项：10 个 `itemType=5` 的 feed 作品，索引 5 是 `itemType=9` 的相关搜索词卡。它含 8 个推荐词，无作品 ID；原 parser 把该卡当作品，形成第二个 `invalid_content_search_identity` 缺口。v9 类型树仅采样前两个推荐词；后续精确原档验收已验证全部 8 个，不能仅靠 `itemType=9` 跳过任意条目。

候选修复限定在快手标准搜索：

- `forwardNative` 的内部标准投影选项只允许固定快手综合搜索端点；其他原生调用和 legacy raw 保留完整 JSON 可入库检查。HTTP／业务码、内容类型、大小、UTF-8、授权和采购控制不放宽。
- 原始响应完整字节与 SHA 始终保留。无法存储的可选 JSON 投影保持 null，不替换、清洗或重新序列化原字节。
- 页面成功前验证作品行、现代展示、分页状态和实际 canonical 各字段。仅对 canonical 中已有 Date 字段使用既有 ISO 入队语义；不先序列化任意数据来掩盖 NaN、Infinity 或负零。正文、媒体或游标仍不安全时，保存明确的 billed unusable 失败，不留到数据库异常后变成 unknown。
- 严格识别已观察到的相关搜索词卡：固定外层字段、嵌套结构与两个 JSON 字符串，最多 100 个推荐词全部验证；未知字段、真实作品或畸形推荐词不予排除。
- 标准快手缓冲读取可从完整字节重投影，保留字节／SHA、UTF-8、TTL、Key、来源合同、成功调用和已提交响应等检查。旧 502／`succeeded_unusable` 不能被当作成功来源使用。

本地 11 个相关测试文件共 331 项通过、0 跳过，包含实际 PGlite 约束及 056 结算触发器。覆盖未使用原字段中的 NUL／孤立 surrogate／负零／溢出数值解析、完整字节保留、10 作品＋1 推荐卡、20 条补齐、3＋3＋3＋1 缓冲交付、单次入库／结算、旧失败重放和不安全作品拒绝。全部为合成原档及本地 mock，无生产写入或供应商调用。另已完成以下精确原档验收。

## 精确原档验收

独立产物 `/private/tmp/mx-hub-kuaishou-49814-verification-v1.mjs`：1825448 字节，bundle SHA `1fd3f1c50323e5bb9e5511120f2f15bce894d74833d30eb0ab8f84e0070bb26b`。业务 parser SHA `5bb974a1a724e87d27af36f4801dad7d95582cd5622858212452105cb5e2d0cb`、adapter SHA `4b7bf99b881cb693c559888445c951f5c2714095352f3357c23f03404975ed2e`、workflow SHA `c90053d5b5b6d8f5f71e6976cd11d83ac780ac404b0ad8c12b4f31dc3e2a8284`；其他指纹在产物 metadata 中。

复制至生产服务器 `/tmp/mx-hub-kuaishou-49814-verification-v1.mjs` 后执行：

```bash
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
  node --input-type=module - 49814f8b-0297-4d53-ac45-ef187784d8ab \
  < /tmp/mx-hub-kuaishou-49814-verification-v1.mjs
```

只读取固定 UUID／调用的完整归档；原身份、合同、状态、207474 字节和 SHA 全部匹配后才解析。数据库事务为 READ ONLY，供应商传输由内存中的原字节替代，生产凭据不用；`upstreamCallCount=0` 与模拟适配器调用数分开。它复用实际修复后的适配器和 `projectContentPage`，输出 10 作品／1 推荐卡、全部 8 词检查、现代／入库／游标安全性，以及历史原状态。无须发布或再次搜索。

此专用验收器另有 5 项本地测试通过，包含实际 PGlite 的只读 SQL 与假字节哈希拒绝。独立编译产物审查确认真实哈希门槛在适配器运行前拒绝合成字节；8 个推荐词的完整校验及坏词拒绝、本地模拟适配器和实际工作流投影均通过。合成测试未伪造原档哈希或正向验收。

操作者已回传上述命令的原归档正向结果，版本及全部六个源码指纹与产物 metadata 一致：

- `readOnlyTransaction=true`；固定请求、调用、207474 字节和原 SHA 全部匹配。
- `fullRawPostgresSafe=false`，确认完整原始 JSON 不可直接存储；原字节重放后的适配器 `candidate_accepts`，原字节及 SHA 均保持一致，可选 JSON 投影仍为 null。具体不安全叶子未由此定位。
- 1 张相关搜索词卡的 `metadataAccepted=true`、`relatedSearchCount=8`、`inspectedCount=8`、`invalidIndexes=[]`，没有截断。
- 页面投影 `candidate_accepts`；`acquiredCount=10`、`nonPostCount=1`、`duplicateCount=0`、`uniqueIdentityCount=10`、`hasMore=true`、`ingestRecordCount=10`。作品行、现代展示、分页状态及入库字段的 PostgreSQL 安全检查全部为 true。
- `upstreamCallCount=0`，仅 1 次内存模拟适配器调用。原 `committed 502`、`succeeded_unusable`、供应商 `billed=true`、1 份归档和没有 ingest job 的历史状态在只读快照中保持不变；没有恢复或结算历史请求。

此结果证明修复后的实际适配器和工作流投影能处理该份完整原始响应。真实发布后的请求、跨上游页补齐及结算未由离线验收执行；补齐与缓冲行为由上述本地回归覆盖。

## 发布

快手本轮运行时修改只需发布 Hub，无新增迁移：在完整同步后的 `electron-dock/mx-insight-hub` 目录执行既有操作者发布流程。

```bash
MX_INSIGHT_SYNC_LAUNCHER=0 MX_SMOKE_DATA=0 bash scripts/manage.sh ops internal-production deploy
```

历史响应、unknown／隔离保护和账单不改写；原 stable 幂等响应仍精确重放旧 502。

## 初始排查记录

用户截图：关键词“许嵩”、每页 20 条，Hub 请求 `49814f8b-0297-4d53-ac45-ef187784d8ab`，错误 `external_platform_response_unusable`，消息 `Content-search acquisition failed; inspect its saved outcome`。

当前源码的该消息来自内容搜索获取失败的保存分支。相同错误码还可用于采购前的不可用结果保护，因此应以这笔请求的保存状态、HTTP 状态及 own provider call 为准。此前快手 `b84a5351…` 的 unknown／丢档结论不能代替本次证据。归档写入修复只保证该类失败能够保留原始响应，不保证供应商响应可以正常投影。

本地已尝试现有 Admin 请求诊断页，返回 `request_diagnostics_unavailable`（该本地实例没有 PostgreSQL 历史证据）。本机 Kubernetes 仅有 `docker-desktop` 上下文，现有文本附件没有这笔 UUID。无法从截图读取原始响应或认定具体字段差异。

离线代码对比确认：两个项目使用相同的快手综合搜索端点和默认参数；Night-All 通用清洗器支持的一些 `photo_info`、条目 `data` 包装及 `results` 容器，Hub 当前固定投影可能拒绝。这些是兼容能力差异，不是本次生产根因的证据。当前不据此猜测作品结构、静默丢弃未知条目或重发付费搜索。

本轮只读诊断补充逐条当前投影检查、有限拒绝条目的字段类型树，以及先前遗漏的固定适配器错误码。验证归档完整字节和 SHA 后才检查结构；只返回类型、索引、计数、固定错误和哈希，不输出作品、身份、URL、游标值或任意供应商消息。投影通过只证明数据投影通过，不能替代 HTTP、内容类型、业务码或 JSON 存储安全的适配器前置验收。

原 unknown／隔离、历史响应、供应商计费和客户结算保持原样；诊断脚本无需部署，也不需要新搜索。原档已回传，精确结论见文首。
