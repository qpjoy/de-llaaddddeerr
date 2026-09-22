# Douyin 第二页 502：2026-09-22

Hub requestId：`37bf1066-508d-47c9-9c54-2d572e03a0a5`。
告警检索式：`受害企业 赔偿回收率`；失败页 2，完成 1 页，累计入库 1 条。
告警中的三天窗口是业务检索范围，不能把窗口起止当作失败调用的精确时间。

## 目前证据

Hub 返回 `night_all_rejected` / `upstreamStatus=502`，表明收到了 Night-All 地址对应的
HTTP 502。具体由 Night-All 应用还是其前置代理产生，需要调用记录与日志确认。
不能直接把它归因为 Hub 请求格式、代理、临时抖动或 TikHub 的某种分页错误。

另一截图报告的测试是 `keyword=AI`、`limit=1` 的首屏，三次 HTTP 200，
与此次不同关键词、第二页的请求不等价，也未验证同一服务实例/参数/游标。
截图同时报告标准化 items=0：这只能说明该次 HTTP 请求成功，不能证明有效数据交付已恢复。
这也不能直接解释此前的 502。`hub_legacy_request_failed` 是路由/日志名，不证明该路由过时。

## 原因不可见的代码缺口与修复

NightAllAdapter 收到错误 JSON 后保存在 UpstreamRejectedError.body，
但 legacy 失败结算只保存总括 HTTP 错误码与顶层关联 ID，原内层证据没有落库。
本次补充 migration 102 与固定字段的错误链投影，保存到 connector_calls.failure_evidence，
由 Admin Token 专用请求诊断展示。保留候选端点 errors/endpointTrace 中已有的错误码；
上游此前删掉的 statusCode/message details 无法从 Hub 重新推导。
响应头 ID 作为正文缺失 ID 时的补充。公开错误和原业务结果保持不变。

## 查这个历史请求

在 Hub K8s 管理服务器复制并执行：

```bash
bash diagnose-douyin-request.sh
```

脚本：[diagnose-douyin-request.sh](../../scripts/diagnose-douyin-request.sh)。
只读指定请求与连接器记录，包含真实调用时间、Night-All requestId/traceId、分页参数摘要；
游标/search_id 只输出长度和哈希。无需更新镜像，不请求供应商、不恢复冷启动、不扣费。

贴回 JSON 后，沿返回的上游 requestId/traceId 在实际 Night-All 实例查日志；
不要只在 Night-All 中搜 Hub UUID。若关联 ID 缺失，应按 connector started_at/completed_at
核对服务/代理日志。升级不会补回旧错误，因此不要靠重复复现这个 ID 验证新错误捕获。
不要自动重新执行第二页或冷启动；任何必要的新请求对照需用户明确触发。
