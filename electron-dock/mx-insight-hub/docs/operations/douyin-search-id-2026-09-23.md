# 抖音 Video Search V1 的 search_id 提取修复

2026-09-23，通过三次用户授权的供应商直连请求复现并修复 Night-All 的分页标识遗漏。
Hub 的 60 秒等待设置保留；本次不修改 Hub 公共接口、MX-H2I 登录/联网、计费或已保存交付。

## 实测

使用 Night-All 配置的官方 TikHub 地址、现有凭据和目录默认参数，查询“人工智能”。
端点固定为 `POST /api/v1/douyin/search/fetch_video_search_v1`，不重试、不切候选端点、
不请求详情、不写入服务数据库。所有调用完成于 06:52–06:53 UTC。

| 调用 | 请求差异 | HTTP | 返回与结论 |
| --- | --- | --- | --- |
| 首屏 | cursor=0，search_id/backtrace 为空 | 200 | cursor=8，7 个搜索行，其中 6 条归一化内容 |
| 第二页，旧行为 | 沿用首屏 cursor=8、backtrace，search_id 为空 | 400 | 复现供应商拒绝；错误响应声明本次不扣费 |
| 第二页，对照 | 其他参数相同，search_id 取首屏 data.log_pb.impr_id | 200 | cursor=16，8 个搜索行，其中 7 条归一化内容；与首屏内容 ID 无重叠 |

共发送 3 次实际请求。两次成功响应声明会计费，具体金额未查询账单，不能从 HTTP 状态
推算金额。首屏和第二页成功响应均没有名为 search_id/searchId 的字段；其
`data.log_pb.impr_id` 与 `data.extra.logid` 是相同的非空字符串。

[TikHub Video Search V1 文档](https://docs.tikhub.io/370212779e0) 要求下一页 search_id
来自上一页响应，但没有明确这两个响应路径；本次映射的依据是该端点的实际对照结果。
这与历史请求 `98a5c405-dbe4-4ccc-bf0a-5e6907ca7320` 的 cursor=8、有 backtrace、
没有 search_id、供应商 400 特征吻合。历史原始错误正文缺失，本次测试是新请求，
不能把新请求的 ID 或账务结果记作历史请求证据。

## 改动

Night-All `lib/domains/search/tikhub-endpoint-orchestrator.js` 的 extractProviderPage 原来
只搜索 search_id/searchId，因此遗漏真实响应中的 session，后续保存及转发的 nextParams
只含 cursor/backtrace。现在按以下优先级提取：

1. 原有显式 search_id/searchId。
2. 当前响应数据根部的 log_pb.impr_id。
3. 当前响应数据根部的 extra.logid。

后两项只用于 platform=douyin 且 endpoint_id=douyin_search_fetch_video_search_v1。
只接受非空字符串，避免数字精度丢失或把对象当成 ID；不读取请求回显、结果数组中的日志
字段、任意嵌套 log 对象或供应商 request_id，不沿用上一页请求中的 session 猜测新状态。
不重写原始响应，不更改 cursor/backtrace，不新增重试或补页。

本次不为 general_search_v2 或其他端点启用该别名；这些端点没有进行此次付费验证。
原有显式 search_id 透传和复合游标兼容继续保留。

Night-All 两份回归测试更新覆盖提取优先级、空值/非法类型、端点隔离、请求回显与数组隔离、
旧状态独立 cursor 补齐、标准搜索内部补页/保存/下一页。Hub
[verify-night-all-pagination.mjs](../../scripts/verify-night-all-pagination.mjs) 也改用 V1
实测的 impr_id 字段结构，验证提取器 → 参数映射 → Hub 不透明游标往返三页。

新提取规则的回归在旧实现上有 2 项失败，修复后 Night-All 四文件共 58 项通过。
跨源码验证两类端点各 3 页通过；general V2 仍测试其原有显式 search_id。
另将两份实际成功响应离线送入修复后的提取器，cursor、search_id、backtrace 均匹配源响应。
离线验证不产生额外付费请求。

## 部署及下游标准

需更新 Night-All 源码并重启实际 API 进程（包括 tmux 内启动的进程）；本次仅修改本地源码，
未操作服务器部署。Hub 不需要改变公开分页接口或由下游补供应商参数：

- `/api/v1/data/search`：把响应 `data.pageInfo.nextCursor` 原样传入下一次请求顶层 cursor。
- 历史 `/api/v1/search/raw`：原样回传 `data.page.nextCursor`。
- 新页使用新的 Idempotency-Key；确切同页重试保留原请求体和 Key。

已经保存的坏状态没有 search_id，新代码无法凭空重建。部署后由调用方明确发起新的首屏
请求（省略 cursor、使用新的幂等 Key），再使用新返回的游标；不能自动重放历史失败页、
改写 unknown/结算结果或声称旧游标已修复。60 秒设置也不能修复缺参造成的供应商 400。

可从 Hub 项目根目录执行离线验证：

```bash
node scripts/verify-night-all-pagination.mjs /path/to/Night-All
```

取证摘要见 [三次调用摘要](evidence/douyin-search-id-2026-09-23.json)。原始响应不提交仓库。
