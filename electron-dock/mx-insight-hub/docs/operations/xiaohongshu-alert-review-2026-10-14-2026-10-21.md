# 小红书告警归类与现场核查（2026-10-14—2026-10-21）

## 结论

这 25 条告警不是一个单一的字段兼容故障。应把 Delta 告警标签和 Hub/TikHub 的实际证据分开看：

1. **已经确认的主因是 TikHub 上游限流/容量拒绝。** 10 月 20 日 14:21—14:23 的 6 条请求形成一段连续的 HTTP 429；另有 10 月 19 日和 10 月 21 日的同类请求。Hub 归档中 `layer=upstream`、`reason=upstream_rate_limited`、`upstreamDispatched=true`、`retryable=false`，所以这不是 Hub 本地队列满，也不应自动重试。
2. **另一组是上游拒绝被 Hub 统一包装为 502。** 8 条记录的 Hub 证据为 `committed / HTTP 502 / external_platform_rejected`，其中评论接口返回的固定消息是“小红书服务不可用”。这些记录没有保留足够的 TikHub 下游细节，不能仅凭 502 判断是字段错误、账号风控还是供应商临时故障。
3. **`request_outcome_unknown` 是 Delta 的恢复/取证状态，不是根因。** 其中有的后来查到 200（交付 20 条），有的查到 429 或 502；同一请求在 Delta 的 409 和 Hub 的已提交响应不能互相替代。未知状态必须保留原幂等键和 `requestId`，禁止换键重发。
4. **少数属于 Delta 本地保护或网关观测问题。** `cold_start_progress_conflict`、`local_redispatch_block`、`source_not_in_conversation` 都没有发起新的 Hub 请求；一条网关 504 后通过原幂等键核查到 Hub 已提交且交付成功，说明 504 不能直接等价为采集失败。

## 表格统计

原始范围为北京时间 2026-10-14 18:11 至 2026-10-21 18:11，覆盖 dev 和 prod。飞书已发送 19 条（dev 12、prod 7），另有 6 条因告警聚合跳过而未单独发送。

| 维度 | 结果 |
| --- | --- |
| Delta 标签 `request_outcome_unknown` | 12（已发送 11、聚合跳过 1） |
| Delta 标签 `external_platform_capacity_exceeded` | 6（已发送 1、聚合跳过 5） |
| Delta 标签 `external_platform_rejected` | 3 |
| Delta 本地标签 | `cold_start_progress_conflict`、`local_redispatch_block`、`source_not_in_conversation` 各 1 |
| Delta 网关标签 | `gateway_timeout` 1 |
| 告警中记录的 HTTP 429 / 502 / 409 / 504 / 200 / 未取得 | 8 / 6 / 2 / 1 / 2 / 6 |

这里的 HTTP 计数是告警记录中的响应状态；`request_outcome_unknown` 行后来可能有独立的 Hub 留存状态，不能把两列相加当成新的请求数。

## 按实际证据归类

### A. TikHub 上游 HTTP 429：已确认限流

以下请求的 Hub 留存均指向上游限流，且 `upstreamDispatched=true`、`retryable=false`：

- 发送告警 8694：`46b01bbb-a319-491e-b9da-2b9740d4cb42`。
- 聚合跳过 8695、8697、8698、8699、8700：`9ecd736b-1574-47fa-8698-1d137cb42499`、`856484bc-c3b1-47f4-96c0-e325d4d20e27`、`388579a8-ad45-48f8-9ac5-14175867061e`、`85a138d8-b242-4a87-8484-5e251c801034`、`42d256be-04c1-4c6c-bd10-026084a6a51d`。
- Delta 标签为 unknown、但 Hub 留存后来显示 429 的 8507 和 9611：`07477fcb-bdda-49cb-9800-e8ae860a4d08`、`46e9c284-49c3-4e7c-9d99-47554aabe6f6`。

这 8 条是最强的共同根因证据：同一 dev 运行窗口内出现密集请求，供应商拒绝发生在 Hub 已经派发之后。`limit=null` 只表示供应商没有回传阈值，不能解释为 Hub 自己的 RPM 上限。

### B. TikHub 上游拒绝：Hub 502

当前可见的 Hub 证据为 `committed / HTTP 502 / external_platform_rejected`：

- 搜索：8267 `edbae8b2-d27b-460f-abfe-9fe75535c5b3`、8592 `10f7e6d5-7004-4614-a37b-d61309868f63`、4248 `63527196-ff78-4fd1-99b7-ff64ad5b1c9d`、5206 `58c5ddc2-4e16-46b6-bff6-add47966c19f`、5224 `cff8f769-1c71-4b8f-9158-fdc15ddb986e`。
- `request_outcome_unknown` 后核查为 502：8696 `cf6199c2-21c0-4488-bb6c-6024adf8452b`、8701 `440c2f90-59c1-4140-a53e-7829508be4af`。
- 评论：8702 `05f0d784-eafd-488f-80fc-68356122c030`，Hub 消息为小红书服务不可用。

这组需要现场读取 `provider_calls` 的 `http_status`、`business_code`、`upstream_request_id`、`billed`、`latency_ms` 和受限响应归档的哈希/结构摘要，才能继续区分供应商业务拒绝、账号/余额问题和网络/服务不可用。

### B.1 Delta 恢复分类存在一个高概率的确定性缺陷

po-infra `62e3157` 在 `llm/data_query.py` 把标准 `/api/v1/data/search` 的 5xx/unknown 先送入只读回执恢复，但 `terminal_rejection` 只识别 `social_upstream_rejected`。当前 Hub TikHub 网关对已拒绝的上游结果公开返回的是 `502 external_platform_rejected`；真正未知结果则返回 `external_platform_outcome_unknown`。因此，Hub 已明确拒绝的 502 可能被 Delta 再次当成“可恢复的 unknown”，恢复 GET 看到已提交但正文是错误后，又包装成 `request_outcome_unknown`。

这个链路与 8592、8696、8701、5206、5224 的“Delta unknown / Hub 502 external_platform_rejected”组合吻合。它解释了告警标签为什么比 Hub 实际根因更模糊，但不解释上游为什么第一次返回 502；后者仍需 provider-call 证据。

建议在 Delta 的标准搜索分支把 Hub 公开的 `external_platform_rejected`（以及明确 `outcome=rejected`、`retryable=false` 的等价拒绝 envelope）视为终态，保持 502、requestId 和不可重试语义；只对传输超时、504/408、无结构响应和真正 `external_platform_outcome_unknown` 进入回执恢复。现有 `tests_hub_receipt_recovery.py` 的 13 项基线测试只覆盖 `social_upstream_rejected`，没有覆盖 Hub 实际公开码，应该补上标准搜索 POST 返回 `502 {error:{code:"external_platform_rejected"}}` 时不调用 `hub_search_recover_data` 的回归用例。这个改动只影响 Delta 的数据查询错误归类，不触碰 Launcher、MX-H2I 登录或联网链路。

### C. 已提交但结果未知：禁止自动重试

8505（`d774f43b-5707-490d-8709-1680341cdf25`）仍是 `unknown / acquisitions 409`；3533、3544、3558 没有拿到 `requestId`，原幂等键查询返回 404。它们都不能被改判为“肯定未发出”，也不能用新幂等键补发。先保存原幂等键、请求正文和环境，等现场状态查询结果。

8696 与 8701 的 Delta 原始响应是 HTTP 409 `request_outcome_unknown` 且 `receiptState=committed`，后来 Hub 留存分别显示 502。应把 409 视为恢复层保护，把 502 视为已留存的上游结果，不能因看到 409 就再次采购。

### D. Delta 本地或观测层

- 8266：`cold_start_progress_conflict (本地)`，后来以原幂等键核查到 Hub HTTP 200、交付 20 条；它说明 Delta 冷启动/进度状态发生竞争，不是上游失败。
- 8387：Delta 当时收到网关 504；按原幂等键补回 `b2328f88-7c88-4d0c-8e0c-7ae071422325` 后，Hub 留存为 HTTP 200、交付 20 条。原始 504 与后来的 200 都要保留。
- 3545：`local_redispatch_block`，未发起 Hub 请求。
- 8693：`source_not_in_conversation`，本地来源校验失败，未发起 Hub 请求。

## 字段与路径核对

本批主要请求是标准 `POST /api/v1/data/search`，正文只有 `platform=xiaohongshu`、`query`、`pageSize=20`，续页使用 Hub 签发的 `mxec2` cursor。Hub 合同会把它转换为 TikHub App V2 的 GET `/api/v1/xiaohongshu/app_v2/search_notes`，并生成 `keyword`、`page`、`sort_type`、`note_type`、`time_filter`、`source`、`ai_mode`；续页才带 `search_id` 与 `search_session_id`。

这与 [TikHub 官方搜索合同](https://docs.tikhub.io/420136398e0) 一致：`keyword` 必填，`page` 从 1 开始，排序/筛选值受限，翻页需要首请求返回的 `search_id` 和 `search_session_id`。因此不能把表中 Hub 顶层的 `query`、`pageSize` 或 cursor 直接当成 TikHub 字段错误。评论请求的 `sort=hot` 由 Hub 转成官方 `sort_strategy=like_count`，该条 502 也不能单凭字段名归因。

`/Users/qpjoy/workspace/mingxi/po-infra` 中仍有历史 spider 直接调用已过渡的 App V1 路径，并使用 `filter_note_type`、`filter_note_time`、`session_id` 等旧字段。这些历史直连必须与本批 Hub `provider_calls` 分开归因；只有现场证据明确显示来源为 legacy spider 时，才按旧合同问题单独处理。

## 与近期架构变更的关系

- po-infra 的 `63848ca`（2026-10-14）是平台采集配置/查询的大范围重构，时间上接近 8266 的本地冷启动冲突；但 8266 后续 Hub 交付成功，现有证据只支持 Delta 状态竞争，不能证明该提交造成上游错误。
- po-infra 的 `62e3157`（2026-10-19 00:55）加入 Hub 502 的回执恢复；随后出现 unknown、429 和本地 redispatch block。应在现场对照 Delta 与 Hub 的部署版本/配置指纹，确认恢复代码和标准搜索路径是否同时上线。
- Hub 的 TikHub XHS 适配器和合同在 10 月 2 日后没有看到同类字段变更；当前证据更偏向上游限流、供应商拒绝、部署版本差异或 Delta 恢复链路，而不是再次改字段。

## 服务器只读核查

仓库已有 `server/ops/diagnose-tikhub-rejection.mjs`，不需要重新部署。它在 Pod 内开启 `REPEATABLE READ READ ONLY` 事务，单语句超时 5 秒、锁超时 1 秒，最多读取 10 条 TikHub `provider_calls`，先校验受限响应 SHA-256，再输出固定字段形状；不会发 HTTP、不会重放、不会写库，也不会打印关键词、游标、请求头、凭据或正文。

在 Hub checkout 根目录执行下面的批量命令，把输出按 requestId 原样贴回即可：

```bash
set -u
for id in \
  21ceaedb-1973-4cc4-997e-441e2ba1293f \
  edbae8b2-d27b-460f-abfe-9fe75535c5b3 \
  b2328f88-7c88-4d0c-8e0c-7ae071422325 \
  d774f43b-5707-490d-8709-1680341cdf25 \
  07477fcb-bdda-49cb-9800-e8ae860a4d08 \
  fa54c847-21d2-44ff-93b7-559ab28c1762 \
  10f7e6d5-7004-4614-a37b-d61309868f63 \
  63527196-ff78-4fd1-99b7-ff64ad5b1c9d \
  46b01bbb-a319-491e-b9da-2b9740d4cb42 \
  cf6199c2-21c0-4488-bb6c-6024adf8452b \
  05f0d784-eafd-488f-80fc-68356122c030 \
  9ecd736b-1574-47fa-8698-1d137cb42499 \
  856484bc-c3b1-47f4-96c0-e325d4d20e27 \
  388579a8-ad45-48f8-9ac5-14175867061e \
  85a138d8-b242-4a87-8484-5e251c801034 \
  42d256be-04c1-4c6c-bd10-026084a6a51d \
  46e9c284-49c3-4e7c-9d99-47554aabe6f6 \
  58c5ddc2-4e16-46b6-bff6-add47966c19f \
  cff8f769-1c71-4b8f-9158-fdc15ddb986e \
  440c2f90-59c1-4140-a53e-7829508be4af; do
  echo "===== $id ====="
  kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
    node --input-type=module - "$id" \
    < server/ops/diagnose-tikhub-rejection.mjs || true
done
```

3533、3544、3558 没有 requestId，只能使用当前同一 consumer 的有效 Hub Public API Key 对原幂等键执行状态 GET：

```bash
for key in '<从表格 G 列复制的 3533 幂等键>' '<3544 幂等键>' '<3558 幂等键>'; do
  curl -fsS "$HUB_URL/api/v1/requests/by-idempotency-key" \
    -H "Authorization: Bearer $HUB_KEY" \
    -H "Idempotency-Key: $key"
  echo
done
```

这个 GET 不创建 usage、不访问供应商，也不返回原响应正文。若返回 `request_not_found`，只能说明当前 consumer 的状态查询没有记录，不能证明请求从未到达网关；若返回 `unknown`、`reserved` 或 `committed`，请连同状态、requestId 和环境贴回，不要发起新的 POST。

现场若要扩大范围，只读聚合应限定在 `2026-10-14 10:11:00Z` 至 `2026-10-21 10:11:00Z`，并按 `provider_key='tikhub'`、`platform='xiaohongshu'` 聚合 `external_platform.provider_calls` 的 `outcome/http_status/error_code/endpoint_key/upstream_request_id/billed/latency_ms`。不要输出 `query`、cursor、Authorization、API Key 或原始响应正文。

## 处置边界

本次分析和核查只涉及 Hub 数据面、TikHub 适配器、Delta 恢复/告警和历史 Night-All/legacy spider 归因。不要为处理这些告警修改 Launcher、MX-H2I 登录、Internal/Domestic 路由、WireGuard、DNS、用户记录、支付中心或现有联网配置；TikHub 凭据缺失、上游熔断或搜索失败只能降级小红书数据能力。

