# 小红书搜索 HTTP 400 排查（2026-10-13）

## 已确认的线上证据

初次排查通过现有 Admin Token 会话读取请求诊断与采集查询复现，没有发起新采集或付费重试。用户部署诊断补丁后另行授权的一次新请求验证，见下方“部署后验证与诊断重发入口”。

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
其中的重试/联系支持建议是上游响应内容，不是操作授权；初次排查没有执行重试或发送外部消息。后续一次新请求来自用户明确授权，并非执行上游消息中的指令。

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

## 初次诊断补丁的发布与边界

本次仅修改 Hub 诊断与上游错误元数据提取，无数据库迁移，不改授权、价格、账单或失败历史。
正常发布 Hub API 后，新失败才会保存补充元数据；旧记录仍使用只读档案脚本排查。
没有修改 Launcher、MX-H2I 登录、联网、VPN、DNS、mx-pay 或 Night-All。
生产档案哈希、嵌套错误结构、具体消息和上述参数形状已由操作者验证。用户随后确认已部署此诊断补丁；供应商内部原因仍未确定。部署后验证结果见下节。

将本次修改同步到服务器已审阅的 Hub checkout 后，在 `electron-dock/mx-insight-hub` 目录按
[标准部署流程](../../mx-insight.deploy.md)发布 Public/Admin；以下命令未执行：

```bash
MX_INSIGHT_SYNC_LAUNCHER=0 bash scripts/manage.sh ops internal-production deploy
```

保留服务器既有构建代理和运行配置。标准部署会执行已有迁移流程，本次补丁没有新增迁移；不要通过全仓未审阅的其他改动扩大发布范围。

本地验证：适配器及小红书相关回归 123 项、通用网关及 native 转发 83 项通过；
加入本次精确消息后，重新运行小红书适配器、管理员诊断与只读脚本，共 46 项通过。
两版实际粘贴命令分别通过 11 和 7 个 mock 场景。
以上初次补丁的 HTTP 回归仅使用本地模拟服务，`git diff --check` 通过。

## 部署后验证与诊断重发入口

2026-10-13 用户确认部署并要求发起类似请求验证，同时要求在请求诊断中按原链路发起新请求。
通过现有管理会话的笔记画卷接口调试入口，以原 LCY-delta 身份执行一次
`POST /api/v1/xiaohongshu/app_v2/search_notes`。关键词为示例“美食推荐”，
其余参数为 `page=1`、`sort_type=time_descending`、`note_type=不限`、`time_filter=不限`、
`source=explore_feed`、`ai_mode=0`，未传两个搜索 ID。
原请求的 14 字关键词未读取，因此这是同端点、同筛选条件的相似请求，不是原关键词的完整重发。

| 项目 | 新请求事实 |
| --- | --- |
| Hub requestId | `2c572155-4be4-45f9-90eb-55b66c51eac0` |
| 请求 / 完成时间 | 2026-10-13 08:27:35.681 / 08:27:39.068 UTC |
| Hub 结果 | committed / HTTP 200 / live |
| TikHub 调用 | 1 次 `social.posts.search`，HTTP / 业务码 200，3110 ms |
| 上游 requestId | `5a4e10b0-7db2-4f01-827f-44dc9c8d7cc2` |
| 供应商计费 | billed=true，USD 0.01 estimated |
| 客户计费 | CNY 0.10，captured / enforced |

这次没有复现原来的 400/502；只能证明这一次真实上游请求成功，不能保证原关键词或所有后续请求都成功。
原 `c50e78a8…` 的失败响应、历史账单与幂等回放保持不变，没有补写旧记录或自动退款。
本轮线上只发送上述一次请求；新入口的交互验收使用本地模拟 API，没有继续付费采集。

### 新入口（本轮代码，待再次部署 Hub）

在“数据浏览中心 → 请求诊断”查询旧 ID 后：

1. 点击“准备按原参数发起新请求验证”，只读加载已保存的路径、方法、参数与原 Key 身份。
2. 核对只读参数，点击“按原参数发送新请求（可能计费）”。生成独立幂等键，通过原 Key 的现有临时凭据机制调用原公开接口；当前授权、配额、价格和路由照常生效。
3. 展示新 requestId、HTTP、来源、费用及调用证据；“查看这次新请求的诊断”自动进行一次只读查询。

当前覆盖有 TikHub 小红书搜索调用证据、已提交响应且有完整参数快照的以下链路：

- POST `/api/v1/data/search`。
- POST `/api/v1/night-all/search/raw`、`/api/v1/search/raw`。
- GET / POST `/api/v1/xiaohongshu/app_v2/search_notes`。

保留 GET/POST 与原参数，不将原生接口转换成 raw。GET 保留空字符串，省略与默认语义等价的 null；POST 保留 null 原值。
不支持的路径、缺失/脱敏参数、未提交或结果未知的原请求明确提示不可重发，不猜测参数，也不开放任意 URL 派发。
新 `data/search` 快照保留原始 `type` 等字段；历史缺失字段无法自动补回。Admin 历史响应使用 `private, no-store`。

发送中或结果未知时禁止另建请求；手动重试沿用本次参数和幂等键。
若重试只收到 401/403/429 等准入错误，仍保留未知状态；明确幂等回放或匹配原 Key、幂等键、requestId、HTTP 的已提交记录才可确认结果。
较早“未发送”的尝试也不能绕过另一个未知请求的锁。会话在同一控制台内跨标签、查询和侧栏导航保留，登录身份改变或整页刷新会清除内存状态；未知时应先保存幂等键并核查，不应刷新后直接另发。
缓存、存量和幂等回放交付不会被标记为上游恢复。

本轮验证：后端相关回归 66 项，前端相关回归 16 项通过；生产构建通过（保留既有大 chunk 提醒）。
Chrome 本地模拟验收通过：只读准备零派发、一次新请求、新诊断深链接、跨页面保留未知请求、401 不解锁、同键恢复；窄屏无横向溢出，发送按钮可见。
此轮入口代码尚未部署，按上面的标准流程发布 Hub Public/Admin。没有新增数据库迁移，也未改 MX-H2I 登录、联网或 Launcher 服务。
