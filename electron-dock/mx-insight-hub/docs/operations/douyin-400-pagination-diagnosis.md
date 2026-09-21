# Douyin 冷启动第二页 400 / Hub 502 排查与修复

日期：2026-09-21。策略“智象未来备案核验风险”，关键词“智象大模型”。
告警 Hub requestId：`a005b4aa-12cf-47d6-8715-755f74f02818`。

## 现场证据

用户从故障服务器 Night-All 数据库读取了 `source_call_logs`：

- `235101`，09:09:03–09:09:07 UTC：`douyin_search_fetch_video_search_v1`，
  POST，`cursor=0`，HTTP 200，成功。
- `235108`、`235110`、`235112`、`235114`：同一视频搜索接口，
  `cursor=8`、`request_search_id=null`，全部 HTTP 400。
- `235109`、`235111`、`235113`、`235115`：后备综合搜索 V2，
  同样 `cursor=8`、`request_search_id=null`，全部 HTTP 400。
- 这批记录同关键词、时间窗口和 business_id；该 business_id 是共享调用者标识，
  不是每次 Hub requestId。尚未单独查询 connector_calls 完成告警 UUID 的一对一关联。
- `request_search_id=null` 表示输入中没有非空 search_id；首屏为空正常，翻页为空可疑。
  `request_page=null`、`offset_param=null` 不表示缺少页码：该接口按 cursor 翻页。
  此次查询没有提取 backtrace，不能仅靠这些数据库行断言它也为空。

错误链：TikHub HTTP 400 → Night-All `TIKHUB_ALL_ENDPOINTS_FAILED` / 502 →
Hub `night_all_rejected` / 502。Night-All 已运行且首屏调用成功，不支持“服务未启动”的解释。
失败响应正文在该调用路径没有持久化；这些证据本身不能解释供应商全部 400 的具体原因。

用户随后从下游采集服务补充确认：失败发生于第 2 页，首次失败后自动重试 3 次，
首屏 next_cursor 有保存；步骤参数不等于最终 HTTP body，后者未记录。
告警侧指定的北京时间 17:12:13–17:12:28 对应本表最后一轮 `235114/235115`。
这加强了时间关联，但不能用步骤参数冒充已经取得完整请求报文或供应商响应正文。

## 已离线复现的 Hub 缺陷

[TikHub 视频搜索 V1 官方文档](https://docs.tikhub.io/370212779e0)
（2026-09-21 核对）说明翻页使用上一响应的 cursor、search_id、backtrace。

Night-All `tikhub-endpoint-orchestrator.js:extractProviderPage()` 对该端点返回
`paginationMode: "compound"`。存在搜索上下文时，它把主 cursor 放在
`nextCursor/providerCursor`，把 search_id、backtrace 放在 `nextParams`。
`payload-utils.js:paginationContract()` 保留这个模式和值。

Hub `capNightAllCompatibilityTraversal()` 原来仅在模式为 `composite` 时优先封装
完整参数。遇到 `compound` 且有 nextCursor 时走单游标分支，忽略 nextParams。
离线回归测试证实：输入同时含 cursor=8 和 search_id/backtrace，解封后的第二页请求
却只有 cursor=8。这与现场“首屏成功、续页 search_id 为空”的现象一致。
这是已确认的代码缺陷；测试使用合成响应，尚未取得该生产首屏完整响应来逐字段核对。

## 工作区修复

只修改 Hub 的 Night-All 兼容分页逻辑：

- 识别 compound，同时把完整 nextParams 与独立的主 cursor 封装进已有加密游标。
- 解封时恢复主 cursor 和参数组；静态筛选条件跨页保留，旧续页字段不从上一请求复活。
- 对 compound 保持既有公开单游标响应形态，调用方继续使用 page.nextCursor。
- 进一步为 composite/offset 等历史分支补齐统一的 page.nextCursor；保留 nextParams.cursor
  旧入口和旧 mode，两入口内容相同。下游不需要按平台选择分页算法。
- 保持 composite/page/offset 的上游还原语义、15 页上限、作用域校验和原始业务正文。
- 不改 Night-All 代码、候选接口切换策略、共享代理、MX-H2I 登录/联网、计费或历史快照。

## 离线验证

新增回归先在旧代码上失败，证实 search_id/backtrace 被丢弃，再应用修复通过。
覆盖首屏→第二页、跨多页筛选保留/续页字段替换、参数游标校验和第 15 页终止。
首轮相关五个测试文件共 86 项：85 通过、1 项按既有设置跳过、0 失败。
补齐统一游标入口、逐平台矩阵和公开文档后，相关七个测试文件共 111 项：
110 通过、1 项按既有设置跳过、0 失败。
首次在沙盒中运行时 HTTP 测试因 localhost 监听受限而无法执行；允许本机监听后通过。

另使用本机 Night-All 的真实 curated 端点、extractProviderPage、paginationContract 和
applyPageParams，串联 Hub 包装/解封函数做无网络验证：输出模式为 compound，最终
发送参数同时保留 cursor=8、search_id、backtrace；供应商调用数为 0。
该检查使用合成响应，不冒充生产请求成功。

## 部署后验收

1. 提交并部署 **MX Insight Hub API** 的本次修复，等待 API 实例全部更新。
2. 由用户明确发起同一关键词的新首屏请求，使用新的 Idempotency-Key，再用其返回的
   page.nextCursor 请求第二页；每一页使用各自的新 Idempotency-Key。
3. 验证第二页发送了 cursor 和非空 search_id，并检查实际供应商 HTTP 状态及交付结果。
   如果第一页未提供搜索上下文，或携带完整上下文后仍返回 400，继续分析供应商响应正文。
4. 旧 Hub 游标内已丢失的上下文无法凭部署补回。重复读取旧首屏交付、重用旧幂等键、
   或直接重试旧 cursor=8 均不能验证修复。历史 requestId 复现保持只读。

本地测试不使用生产 Key、不发起付费请求；线上恢复需以上验收确认。

## 下游与适配层责任

用户确认下游只调用 Hub 统一接口，分页差异必须由 Hub 管理。Douyin 调用方不新增
search_id/backtrace 逻辑，继续回传 nextCursor。更新后其他历史参数/offset 模式也可使用
同一入口；旧 nextParams 调用仍兼容。旧幂等交付和历史快照不重写。

按平台、操作和接口版本分别验证的依据与适配边界见
[集成架构](../architecture/night-all-integration.md#hub-owned-historical-pagination-boundary)。
新增平台矩阵覆盖 13 个端点形态（12 个平台）的合成分页响应；这是离线契约验证，
不表示已逐平台做付费在线验收，也不把所有 TikHub 接口视作同一种分页。
