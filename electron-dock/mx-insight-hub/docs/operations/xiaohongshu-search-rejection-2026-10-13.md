# 小红书搜索 HTTP 400 排查（2026-10-13）

## 已确认的线上证据

通过现有 Admin Token 会话读取请求诊断与采集查询复现，没有发起新采集或付费重试。

| 项目 | 保存的事实 |
| --- | --- |
| Hub requestId | `c50e78a8-624b-4e92-a8ff-d170554a548f` |
| 请求时间 | 2026-10-13 04:29:27.843 UTC（北京时间 12:29:27.843） |
| Hub 结果 | committed / HTTP 502 / `upstream_request_rejected` / live |
| 下游错误 | `external_platform_rejected` |
| 当次采购 | 1 次 TikHub 调用，0 次内部连接器调用 |
| 操作 / 端点 | `social.posts.search` / `xiaohongshu.app-v2.search-notes.v1` |
| 交付合同 | `night-all.data-search.v1`（合同名称不代表经过 Night-All） |
| 上游结果 | rejected / HTTP 400 / 1793 ms |
| 上游业务码 / requestId | 账本未记录；只读归档已确认 `detail.code=400` / `b366d704-5d8e-4e71-a843-a00769be0df1` |
| 供应商调用 ID | `5b171262-96b9-4436-97fb-2c9a6efced14` |
| 供应商计费 | 历史 billed 未知；归档消息声明本次不收费；USD 0.01 是 estimated，不是实际扣费证据 |
| 客户计费 | CNY 0.10，已扣款 |
| 交付记录 | 0 条，已保存完整 502 错误响应，可原样复现 |

这是已收到上游 HTTP 400 的拒绝，不是这次请求遇到 429、Hub 并发排队拒绝、连接超时或成功响应规范化失败的证据。
操作者已返回哈希验证后的 `detail.params` 摘要：关键词为非空字符串、长度 14；
`page="1"`、`sort_type="time_descending"`、`note_type="不限"`、`time_filter="不限"`、
`source="explore_feed"`、`ai_mode="0"`，未传 `query`、`search_id` 或 `search_session_id`。
这些已展示字段与[官方搜索文档](https://docs.tikhub.io/420136398e0)一致：接口使用 `keyword`，两个搜索 ID 用于后续翻页；
GET 查询参数以字符串呈现不能单独证明页码或 AI 模式类型错误。没有发现足以修正的参数映射缺陷；关键词内容未读取，不能断言所有业务条件都满足。
[官方 HTTP 状态说明](https://docs.tikhub.io/4579297m0)明确 400 可涉及参数或服务端内部错误，不能仅凭状态码确定唯一根因。

## 已复现并修复的诊断缺陷

原适配器只从响应顶层提取 `code`、`request_id`。离线 HTTP 400 模拟证明：
`{detail:{code:400,request_id:"有效关联ID"}}` 的字段会丢失，虽然原始字节完整归档。
操作者已返回本次生产档案摘要：`archive_verified/hashVerified=true`，顶层无 code/request_id/message，
`detail` 为对象且含 code 400、上表中的供应商 requestId 与长度 194 的 message。因此已确认该缺陷影响了本次生产诊断。
后续只读提取已确认 message 为通用请求失败：要求检查参数、以示例参数测试或联系支持，并声明
“You won't be charged for this request.”。消息没有指出具体错误字段或内部错误原因，不能据此把失败确定为参数错误、风控或供应商故障。
其中的重试/联系支持建议是上游响应内容，不是操作授权；本次没有执行重试或发送外部消息。

现在仅在非 2xx 响应中读取一层对象型 `detail` 的整数业务码与受约束关联 ID，顶层有效字段优先。
不接受字符串化或数组型 detail；不将成功响应的嵌套数据当成成功合同。
HTTP 状态仍决定原来的拒绝/未知结果分类、熔断和计费语义，原始字节与历史响应不改写，不新增自动重试。
通用网关另将 JustOne 的 302/303、100/600/601/602 业务码映射限定在 JustOne 错误类型内，
防止 TikHub 新提取出的同数字错误元数据被误判为 JustOne 容量故障；实际 HTTP 429 和历史失败重放保持原逻辑。

管理员诊断对已提交的失败响应明确说明“已保存失败响应”，并解释 HTTP 400 尚不能确定具体原因。
这是诊断修复，不是宣称供应商搜索已经恢复。

## 计费与后续核查

供应商“不收费”的响应声明、供应商历史账本 `billed=null` 和客户已扣 CNY 0.10 是三个不同事实。
当前失败结算逻辑不会因为供应商 billed 改成 false 就自动退还客户费用；本次不改该策略，也不回写历史采购或客户账单。
只读脚本对这条完整、精确匹配的消息输出固定分类 `request_failed_no_charge_claim`，保留声明证据；
不输出原文，不把含有该片段的其他消息推断为同一声明，不将分类用于定价、预算或自动重试。

要查明供应商内部原因，可向 TikHub 支持提供以下定位信息（尚未发送）：

- 上游 requestId：`b366d704-5d8e-4e71-a843-a00769be0df1`。
- 时间：2026-10-13 04:29:27.843 UTC；GET `/api/v1/xiaohongshu/app_v2/search_notes`。
- HTTP 400 / `detail.code=400`，上述首页参数及通用失败消息。
- 请核查具体失败阶段、是否存在未公开的参数限制，并确认该次采购未收费。

无需为此再次读取完整原始档案。同一 Hub 幂等标识会继续返回保存的 502，不能用它验证供应商恢复；新采集是另一笔操作。

## 读取本次受限档案

新脚本 `server/ops/diagnose-tikhub-rejection.mjs` 可通过标准输入运行，无须更新镜像或重启服务。
在有该脚本文件且能访问 Hub Kubernetes 的服务器执行：

```bash
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
  node --input-type=module - c50e78a8-624b-4e92-a8ff-d170554a548f \
  < electron-dock/mx-insight-hub/server/ops/diagnose-tikhub-rejection.mjs
```

脚本只读精确请求及最多 10 条 TikHub 调用，在 REPEATABLE READ / READ ONLY 事务内执行并最终回滚；
查询超时 5 秒、锁超时 1 秒，每份原始档案限 8 MiB，先核验原始字节 SHA256 再解析。
输出已保存状态、根/detail 的整数业务码和 UUID 请求 ID，以及固定字段类型、文本长度/消息分类、页码/数量。
不输出原始消息、关键词、游标、请求头、URL、凭据或任意异常文本；不是读取原文的通用 API。
生产 Pod 的数据库角色需要已有受限档案读取权限，失败时不扩大权限。

`archive_verified` 后比较保存值与根/detail 字段，才能判断是否由嵌套错误导致诊断信息缺失。
`archive_missing`、`archive_integrity_failed`、`archive_not_json` 不应被当成参数错误。
若只获得泛化 400，用提取的供应商 requestId 和 UTC 时间继续核查，不能盲目改参数或更换供应商。

## 发布与边界

本次仅修改 Hub 诊断与上游错误元数据提取，无数据库迁移，不改授权、价格、账单或失败历史。
正常发布 Hub API 后，新失败才会保存补充元数据；旧记录仍使用只读档案脚本排查。
没有修改 Launcher、MX-H2I 登录、联网、VPN、DNS、mx-pay 或 Night-All。
生产档案哈希、嵌套错误结构、具体消息和上述参数形状已由操作者验证；本地修复尚未发布，供应商内部原因与恢复情况尚未验证，此次未做付费验收。

将本次修改同步到服务器已审阅的 Hub checkout 后，在 `electron-dock/mx-insight-hub` 目录按
[标准部署流程](../../mx-insight.deploy.md)发布 Public/Admin；以下命令未执行：

```bash
MX_INSIGHT_SYNC_LAUNCHER=0 bash scripts/manage.sh ops internal-production deploy
```

保留服务器既有构建代理和运行配置。标准部署会执行已有迁移流程，本次补丁没有新增迁移；不要通过全仓未审阅的其他改动扩大发布范围。

本地验证：适配器及小红书相关回归 123 项、通用网关及 native 转发 83 项通过；
加入本次精确消息后，重新运行小红书适配器、管理员诊断与只读脚本，共 46 项通过。
两版实际粘贴命令分别通过 11 和 7 个 mock 场景。
所有 HTTP 验证仅使用本地模拟服务，`git diff --check` 通过。
