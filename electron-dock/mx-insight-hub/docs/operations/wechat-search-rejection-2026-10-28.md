# 微信综合搜索 HTTP 400 排查（2026-10-28）

## 结论与证据

请求 `877297ae-5992-4c5a-aeb7-346b2a0f9942` 已确定收到 TikHub 通用请求失败响应，Hub 保存为 HTTP 502；具体失败原因仍未确定。未发现可证实的 Hub 参数映射或成功响应解析缺陷，未修改运行时代码，也未宣称搜索已经恢复。

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

## 受控复测（最多 2 次供应商调用，待执行）

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

## 处理边界

- 本次错误发生在收到上游 HTTP 400 后，尚未进入成功响应解析；不适用 B 站缺省空页修复。
- 此次调用不是 unknown，也不是 succeeded_unusable，不产生对应未知结果阻塞或解析隔离；当前 HTTP 400 分类的 `affectsCircuit=false`。没有依据清除保护或使用 Twitter 历史阻塞处置。
- 原生合同的同一幂等请求继续回放已保存的 502，不重新采购，不能用它验证上游是否恢复。新请求验证是另一笔采集，可能产生费用。
- 当前计费触发器按 committed 请求捕获原报价，独立于供应商声明或返回条数。此次不更改失败收费政策，不回写 billed，不退款或修改原始账本。
- 上游消息中的“重试”和“不收费”是供应商陈述，不是重试授权或已核实账单。本轮未调用供应商、未发送工单、未部署，MX-H2I 登录及联网未改。

## 供应商核查草稿（尚未发送）

Subject: WeChat universal search returned HTTP 400 — request 6a6d493a-fbe6-4805-8dc9-9fbe16846e1f

Please investigate this saved request:

- Endpoint: POST /api/v1/wechat_search/v2/fetch_search
- Request ID: 6a6d493a-fbe6-4805-8dc9-9fbe16846e1f
- UTC time: 2026-10-28 07:24:57.999–07:25:01.786
- HTTP status and detail.code: 400
- The echoed keyword matches the submitted keyword (8 characters; omitted here).
- Echoed options: business_type=all, sort=default, publish_time=all, offset=0, cursor=null, raw=true.
- The response contains only the generic request-failure message and a no-charge statement. No specific invalid field is identified.

Please identify the precise failure stage, any additional parameter/account requirements, and confirm whether this request was charged and whether a corrective action is needed before another request. We have retained the original 917-byte response and have not automatically retried it.

## 本地验证

相关合同、适配器、别名与幂等回归 5 项通过，均使用本地合成数据。只读取证脚本已检查语法、精确调用范围、归档校验、回滚、关键词/游标和常见凭据脱敏；操作者返回上表中的生产取证结果。上述验证不能替代供应商内部日志，也不能证明当前实时可用性。

受控复测脚本另有 6 项本地测试（`tests/server/wechat-search-877297ae-probe.test.mjs`），用真实 `TikHubAdapter` 加合成 HTTP 响应覆盖：对照失败时不发原关键词、两次上限、请求体只能是 keyword、归档回显不一致时拒绝、输出不含关键词/内容/游标、未知参数在读库前退出。尚未在生产执行。
