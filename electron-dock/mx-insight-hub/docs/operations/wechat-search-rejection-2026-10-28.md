# 微信综合搜索 HTTP 400 排查（2026-10-28）

## 结论与证据

请求 `877297ae-5992-4c5a-aeb7-346b2a0f9942` 已确定收到 TikHub 通用请求失败响应，Hub 保存为 HTTP 502。**受控复测已确认为供应商侧故障**：TikHub 官方示例关键词以同样参数也返回同一通用 400（见下文“受控复测结果”），与原关键词和 Hub 字段映射无关。具体内部原因待 TikHub 工单答复；未修改运行时代码，搜索未恢复。

| 项目 | 已核实事实 |
| --- | --- |
| Hub 状态 | `committed / upstream_request_rejected / 502 / live` |
| 调用 ID | `3d5dd170-243d-4ee4-99d6-64ce0f7fd38a` |
| 操作 | `native.wechat.search.search` |
| 固定上游接口 | `POST /api/v1/wechat_search/v2/fetch_search` |
| 调用时间 | 2026-10-28 07:24:57.999–07:25:01.786 UTC（北京时间 15:24:57.999–15:25:01.786） |
| 上游关联 ID | `6a6d493a-fbe6-4805-8dc9-9fbe16846e1f` |
| 上游结果 | `rejected / HTTP 400 / detail.code=400` |
| 归档 | 917 字节；操作者已验证长度、SHA-256、UTF-8 JSON |
| SHA-256 | `66c9125f960f66c383c631b6e9852d21722ae1fb1ce61784b985b0a16f6fda7c` |
| 消息 | 长度 194，精确匹配现有 `request_failed_no_charge_claim` 分类 |
| 客户费用 | enforced / captured / CNY `chargedMinor=1`，即 ¥0.01 |
| 供应商费用 | `billed=null`；成本为 estimated；响应声明本次不收费，未独立核实供应商账单 |

保存请求的 `params` 仅含 8 字符 keyword。归档回显的 keyword 与之完全相同，其余为：

```json
{
  "business_type": "all",
  "sort": "default",
  "publish_time": "all",
  "offset": 0,
  "cursor": null,
  "raw": true
}
```

这表明实际执行的是综合搜索。当前 `wechat_mp` 别名会在保存前补入 `business_type:"article"`；本笔不符合该文章分支。账本 `platform=social` 是原生微信操作的授权数据域，不能据此判断路由错误，也不能还原调用方最初使用的入口。

上述默认值与核对时的[官方 OpenAPI](https://api.tikhub.io/openapi.json)一致，POST 路径和字段也与[官方 Python SDK](https://raw.githubusercontent.com/TikHub/TikHub-API-Python-SDK/main/src/tikhub/resources/wechat_search_v2.py)一致。关键词正文未读取；长度与回显一致不能证明所有未公开的业务条件都满足。通用消息只建议检查参数或联系支持，没有指出错误字段、关键词限制、账号资源问题或服务端内部原因。

## 复核：不是公众号路径，也不是字段错配（2026-10-28 晚）

- **不是 wechat_mp**：`wechat_mp` 别名和聚合搜索的公众号子源都会在保存前写入 `business_type:"article"`，聚合子源还会写 `raw:false`。本笔保存的 params 只有 keyword，TikHub 回显 `business_type:"all"`、`raw:true`，因此是直接调用微信搜一搜综合搜索（原生路径，或 `platform` 为 `wechat`/`weixin`/`wechat_search` 的别名），与公众号文章搜索无关。
- **字段与当日官方合同一致**：重新下载 TikHub OpenAPI（`V5.3.2`），`POST /api/v1/wechat_search/v2/fetch_search` 仍只要求 `keyword`（1–100 字），其余 6 个字段的类型、枚举与默认值和 Hub 固定合同逐项相同；Hub 26 个微信合同路径全部仍在。Hub 实际发送 `{keyword, business_type:"all", sort:"default", publish_time:"all", offset:0, raw:true}`，JSON POST、`content-type: application/json`、超时 30 秒（官方建议值）。
- 官方文档说明字段错误返回 422（`business_type`）或带说明的 400（`sort`/`publish_time` 非法值）；本笔 TikHub 原样回显了全部参数且只给通用失败文案，说明请求已被解析，失败发生在其后的采集阶段。耗时 3.8 秒，远低于超时。

本地代码层没有可修复的映射问题。要区分“供应商当时整体故障 / 该关键词被微信拒绝 / 已恢复”，只能再做一次受控调用。

## 受控复测（最多 2 次供应商调用，已执行 1 次）

`server/ops/verify-wechat-search-877297ae.mjs` 在 Admin Pod 内复用已部署的 TikHub 适配器、凭据存储、出口代理与超时：

1. 只读核对原请求、调用、上游 ID 与 917 字节归档 SHA-256；归档回显的 keyword 必须与保存的 keyword 完全一致才继续。
2. 对照调用：TikHub 官方示例关键词 `人民日报`，参数与原请求同形。
3. 仅当对照成功时，用保存的原关键词再发一次。进程内硬限 2 次，且只允许 `{params:{keyword}}` 这一种请求体。

输出只含 HTTP 状态、耗时、错误分类、上游 request_id、固定枚举回显、结果盒子/条目计数，不含关键词正文、结果内容或游标。两次调用直接打到 TikHub，不经过 Hub 账本：不产生客户扣费，也不会出现在 `provider_calls`；供应商成本最多 USD 0.02（失败时供应商声明不收费）。不写数据库、不改熔断、不重放原请求。脚本无需部署，从有 kubectl 权限、包含此文件的 Hub 源码目录执行：

```bash
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- node --input-type=module - --execute < server/ops/verify-wechat-search-877297ae.mjs
```

去掉 `--execute` 为只读核对，不调用供应商。请只执行一次带 `--execute` 的命令，`conclusion` 的含义：

| conclusion | 判断 | 下一步 |
| --- | --- | --- |
| `demo_also_rejected_supplier_side` | 官方示例也被同样拒绝：TikHub 该接口或我方账号侧故障，与关键词和 Hub 字段无关 | 带两个上游 request_id 发工单 |
| `saved_keyword_rejected_demo_accepted` | 接口正常，仅该关键词失败：微信侧拒绝该词（敏感词或不支持的字符等） | 工单询问具体原因；Hub 无法通过改字段修复 |
| `saved_keyword_now_accepted` | 两次都成功：10-28 15:24 为瞬时故障，现已恢复 | 原 502 保留；调用方用新 Idempotency-Key 重新搜索 |
| `*_other` / `errorCode` | 未预期结果 | 贴回输出再分析 |

## 受控复测结果

操作者在 2026-10-28 执行 `--execute` 一次，返回 `wechat-search-877297ae-probe.v1`：

| 项目 | 结果 |
| --- | --- |
| 原请求核对 | `sourceVerified=true`（请求、调用、上游 ID、917 字节归档及回显关键词均匹配） |
| 供应商调用 | 1 次；原关键词未发送（`control_not_accepted`） |
| 对照关键词 | TikHub 官方示例 `人民日报`（4 字） |
| 对照结果 | HTTP 400 / `detail.code=400` / `upstream_request_rejected`，耗时 2885ms |
| 上游 request_id | `10c2337c-e329-4c90-b0be-1e915814fb0c`，`router` 与接口一致 |
| 文案 | 194 字符，精确匹配 `request_failed_no_charge_claim` |
| 回显 | keyword 一致；`business_type=all`、`sort=default`、`publish_time=all`、`offset=0`、`cursor=null`、`raw=true` |
| 响应 | 907 字节，SHA-256 `76b7b6d9d872c03d8afc8401d22a8b1781c4aafc8c26395b91991acf17302cd4`（直连调用，仅在内存中计算，未入库） |
| 结论 | `demo_also_rejected_supplier_side` |

两次失败相隔数小时、关键词不同（其一为供应商自己的文档示例），参数完全为官方默认值，返回同一通用文案。这排除了关键词与 Hub 字段映射，问题在 TikHub 微信综合搜索接口本身或其对我方账号的服务。401/402/403/429 等账号、余额、权限与限流错误都有独立状态码，本次均不是；但仍不能仅凭外部响应区分“接口全局故障”与“仅我方账号受影响”，需供应商答复。

在 TikHub 答复或接口恢复前，不要再用 `--execute` 重复本脚本（它不记录已执行状态）。恢复验证只需一次普通搜索。

## 处理边界

- 本次错误发生在收到上游 HTTP 400 后，尚未进入成功响应解析；不适用 B 站缺省空页修复。
- 此次调用不是 unknown，也不是 succeeded_unusable，不产生对应未知结果阻塞或解析隔离；当前 HTTP 400 分类的 `affectsCircuit=false`。没有依据清除保护或使用 Twitter 历史阻塞处置。
- 原生合同的同一幂等请求继续回放已保存的 502，不重新采购，不能用它验证上游是否恢复。新请求验证是另一笔采集，可能产生费用。
- 当前计费触发器按 committed 请求捕获原报价，独立于供应商声明或返回条数。此次不更改失败收费政策，不回写 billed，不退款或修改原始账本。
- 上游消息中的“重试”和“不收费”是供应商陈述，不是重试授权或已核实账单。除操作者授权的 1 次对照调用外未调用供应商；工单未发送、未部署，MX-H2I 登录及联网未改。
- 故障期间客户每次调用该接口都会失败，且仍按 committed 捕获 ¥0.01（400 不计入熔断）。是否在管理台暂停 `native.wechat.search.search` 是运营决定，本次未改。

## TikHub 工单（尚未发送）

提交入口：登录 TikHub 用户后台 → [Support / Open tickets](https://user.tikhub.io/dashboard/support/open-tickets)（需登录验证后才能提交）。客服只用英文，用英文提交处理更快；按客服等级与提交时间排队，首次回复从美国太平洋时间 12:00 上线后开始计时。可在工单页或通知邮件里回复。[Discord](https://discord.gg/aMEAS8Xsvz) 只适合社区讨论，计费与故障核查以工单为准。

TikHub 文案要求附“response JSON”。以下正文已含全部可公开字段，供应商可凭 request_id 查内部日志。原请求的 917 字节归档会回显我方客户的原关键词，**不要附件上传**；对照请求未入库，仅有上表的哈希。若客服坚持要完整 JSON，再决定是否在其文档页用示例参数重测（会产生新的调用）。

**Subject:** WeChat Search V2 `fetch_search` returns HTTP 400 even with the documented demo keyword

**Body:**

> Hello TikHub support,
>
> `POST /api/v1/wechat_search/v2/fetch_search` is failing for our account. Every request we sent today returned HTTP 400 with `detail.code=400` and only the generic message "Request failed. Please retry. Check the docs below to verify your parameters, test with the default demo parameters, and send the response JSON to support. You won't be charged for this request."
>
> As that message suggests, we retested with your documented demo keyword and default parameters. The result was the same, so the failure does not depend on our keyword or our parameters.
>
> | # | Request ID (detail.request_id) | Time | Keyword | Result |
> |---|---|---|---|---|
> | 1 | `6a6d493a-fbe6-4805-8dc9-9fbe16846e1f` | 2026-10-28 07:24:58–07:25:01 UTC | customer keyword (8 chars, echoed back unchanged) | HTTP 400, detail.code 400, generic message |
> | 2 | `10c2337c-e329-4c90-b0be-1e915814fb0c` | 2026-10-28, later the same day (UTC) | `人民日报` (your OpenAPI example) | HTTP 400, detail.code 400, generic message, 2.9 s |
>
> Both requests sent the following JSON body (only `keyword` differs). Your response echoed it back unchanged in `detail.params`:
>
> ```json
> {"keyword": "人民日报", "business_type": "all", "sort": "default", "publish_time": "all", "offset": 0, "raw": true}
> ```
>
> Headers: `Content-Type: application/json`, `Authorization: Bearer <our API key>`. Client timeout is 30 s, as your docs recommend. Neither request came close to it.
>
> Could you please:
> 1. Look up both request IDs and tell us the actual failure reason and stage.
> 2. Tell us whether this endpoint is currently down for all users or only for our account (for example an account, region or WeChat-session restriction), and when it is expected to recover.
> 3. Confirm that neither request was charged.
> 4. Tell us whether we need to change anything on our side before sending more requests.
>
> We will not send further test requests until we hear back. Thank you.

## 本地验证

相关合同、适配器、别名与幂等回归 5 项通过，均使用本地合成数据。只读取证脚本已检查语法、精确调用范围、归档校验、回滚、关键词/游标和常见凭据脱敏；操作者返回上表中的生产取证结果。上述验证不能替代供应商内部日志，也不能证明当前实时可用性。

受控复测脚本另有 6 项本地测试（`tests/server/wechat-search-877297ae-probe.test.mjs`），用真实 `TikHubAdapter` 加合成 HTTP 响应覆盖：对照失败时不发原关键词、两次上限、请求体只能是 keyword、归档回显不一致时拒绝、输出不含关键词/内容/游标、未知参数在读库前退出。生产已执行一次，结果见“受控复测结果”。
