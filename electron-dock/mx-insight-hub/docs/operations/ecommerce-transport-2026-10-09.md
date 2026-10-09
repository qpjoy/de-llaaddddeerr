# Delta 商品搜索网络故障（2026-10-09）

## 线上证据

Delta 的淘宝、天猫、京东、闲鱼共 5 次搜索返回
`502 external_platform_outcome_unknown`。Hub 账本显示：

| 平台 | Hub Request ID | 耗时 ms |
| --- | --- | --- |
| 淘宝 | `de58ba91-6eb0-4a84-b99c-07933d3a27f7` | 10179 |
| 天猫 | `5c21924f-35a6-4bd9-8e08-d72a195f6bb9` | 10329 |
| 京东 | `0c185983-b5fe-41b6-85be-0eaa366c3521` | 10492 |
| 闲鱼（苹果手机） | `fa779340-2ac8-405d-b9ca-cc788eb19c46` | 10425 |
| 闲鱼（耐克运动鞋） | `abe3243d-e8e3-4192-8939-fa7ff4f9fd9f` | 10181 |

时间为 2026-10-09 09:21:26–09:22:15 UTC。全部调用的供应商为 JustOne，
`operation=ecommerce.products.search`，`error_code=upstream_transport_error`，
`contract_state=transport_unavailable`，HTTP 状态、业务码、计费结果均为 null，
没有收到响应正文。配置的总请求超时为 120000 ms，reservation lease 为 180000 ms。
这些记录证明失败发生在响应头返回前，不能将其解释为解析失败或供应商限流。
约 10 秒与连接超时相符，但旧版本没有保存底层 cause，不能据此确认具体网络原因。

后续由运维在同一 Public Pod 执行无凭据探测：

- Node v22.23.3，内置 undici 6.28.1；没有 HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NODE_USE_ENV_PROXY。
- DNS 返回 IPv4 `47.242.112.183`、`8.210.230.99`。
- 固定首页 HEAD：默认 fetch 为 200/282 ms，IPv4 且连接超时 30 秒为 200/265 ms。
- 三个商品路径无 token GET：淘宝 401/355 ms、京东 401/294 ms、闲鱼 401/86 ms。

这些探测证明当时网络和鉴权入口可达，不证明有效商品搜索成功，也不能重建历史故障原因。
未基于这些证据修改代理、DNS、超时、凭据或响应解析规则。

## 本次改动

JustOne 适配器在请求失败或读取正文失败时，保存
`response_archives.raw_payload.response.transportFailure`，同时写入
`[external-platform] justone transport failure` 进程日志：

- `phase`：request（未得到响应头）或 body（读取正文）。
- `codes`：有界遍历 cause/AggregateError，仅保留固定白名单内的 DNS/TCP/TLS/undici 错误码。
- `deadlineExceeded`、`elapsedMs`、`timeoutMs`：区分适配器总截止时间与较早的底层失败。

不记录异常消息、堆栈、URL、商品关键词或 token。日志失败不影响原始失败归类。
不改变公开错误码、unknown 计费结果、熔断、隔离、幂等或自动重试规则。
新增字段只进入失败调用归档，不改成功响应、历史记录及其哈希。无需数据库迁移。

新版本部署后可按已知请求 UUID 查询归档；历史记录的新字段为 null，不能回填猜测值：

```sql
SELECT p.usage_request_id, p.error_code, p.http_status, p.latency_ms,
       a.raw_payload #> '{response,transportFailure}' AS transport_failure
FROM external_platform.provider_calls p
LEFT JOIN external_platform.response_archives a ON a.provider_call_id = p.id
WHERE p.usage_request_id = $1::uuid AND p.provider_key = 'justone';
```

## 验收

不需要 Delta 前端。使用原 LCY-delta 的 Hub Public Key，在 Public Pod 内请求
`http://127.0.0.1:18150/api/v1/data/ecommerce/products/search`，通过正常 HTTP 认证和准入。
传入 `marketplace=taobao`、`query=苹果手机`、`page=1`、`deliveryMode=cache_first`，
使用固定的新 Idempotency-Key，单次发送。不要直接把 Delta 的 action/count/limit/keyword/platform
额外字段转发给 Hub；它们属于 Delta 自己的工具参数。

200 且 `sourceMode=live` 才证明本次真实供应商采集成功；缓存或幂等重放证明交付链路可用，
不能作为供应商恢复证据。401/403 属于 Hub Key/权限，409 unknown 属于旧调用保护，
502 则保留新的 Request ID 继续查账本。不得自动换 Key、换关键词、重置旧账本或循环重试。
本次变更未涉及 MX-H2I 登录和联网。

运维随后通过 Public Pod 的正常 HTTP 接口，以 LCY-delta Key 验收淘宝“苹果手机”：

```json
{"idempotencyKey":"lcy-ecom-verify-20261009-01","status":200,"requestId":"63d66f94-28ff-4a08-8734-8893ac580fee","sourceMode":"live","replay":"false","count":10,"reasonCode":"live"}
```

这证明当时淘宝的鉴权、准入、真实供应商采集和 Hub 交付均成功，并非缓存或重放。
该成功发生在诊断补丁部署前，不能归功于补丁。

用户随后明确授权原 5 组请求的采集费用。运维使用同一个 LCY-delta Key、
`deliveryMode=live_only`，串行执行每组一次；幂等标识为
`lcy-ecom-recovery-20261009-02-1` 至 `-5`。结果全部为 HTTP 200、
`sourceMode=live`、`replay=false`、`liveSuccess=true`：

| 平台 / 关键词 | Hub Request ID | 返回商品数 | 耗时 ms |
| --- | --- | --- | --- |
| 淘宝 / 苹果手机 | `4c31e8d3-f507-4596-a602-2de8e78fad22` | 10 | 1466 |
| 京东 / 苹果手机 | `dbec3ddc-30ac-4923-b0ed-4f77a4931716` | 48 | 1727 |
| 天猫 / 苹果手机 | `13c58b21-7edf-4a7f-be3b-8bf70d170f28` | 10 | 1250 |
| 闲鱼 / 苹果手机 | `599ddc7a-df75-4646-880b-4939ae538d3c` | 10 | 2062 |
| 闲鱼 / 耐克运动鞋 | `a87bead5-8de0-4f4d-9fd4-b866a18bf9dc` | 10 | 2699 |

本轮 5/5 实时验收通过，确认原来报错的 5 组 Hub → JustOne 商品业务当前恢复，
没有缓存或重放掩盖失败。请求由服务器直接访问 Hub Public API，没有经过 Delta Agent，
因此本轮不单独验证 Delta 自身的工具参数转换或展示逻辑。
没有重写或释放原来的 5 笔 unknown 记录，网络故障的精确历史原因仍不可追溯。

本地验证：JustOne 适配器/合约/入库/资源接口、外部平台网关/归档/调用关系和 native
forwarding 共 146 项测试通过。新增覆盖四个平台连接失败的安全归档、聚合错误与循环 cause
的有界处理、日志故障、正文超时以及网关持久化后的 unknown 幂等保护。
