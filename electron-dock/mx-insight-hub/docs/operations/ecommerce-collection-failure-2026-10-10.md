# 淘宝“华为笔记本”采集失败（2026-10-10）

## 已确认的结果

Hub Request ID：`3cd1a613-fd60-4bd2-9c30-e60c11c224d9`。
下游收到 `502 external_platform_rejected`。

运维按该 ID 读取原请求和归档，校验响应字节的 SHA-256 后，在 Public Pod 内
使用注入的归档响应重放 `JustOneAdapter`。未访问供应商、未重新计费，结果如下：

| 字段 | 历史账本 | 当前部署代码离线重放 |
| --- | --- | --- |
| outcome | rejected | rejected |
| HTTP status | 200 | 200 |
| businessCode | 301 | 301 |
| errorCode | upstream_collection_failed | upstream_collection_failed |
| billed | false | false |
| 耗时 | 50401 ms | 不用于评估线上耗时 |

离线重放还确认 `circuitCategory=upstream`、`affectsCircuit=true`、`retryable=false`，
与当前策略一致。JustOne 的[官方业务码说明](https://docs.justoneapi.com/zh/usage)
将 301 定义为采集失败、供应商不计费；客户扣费应独立查询客户账本，不能从采购字段推断。

本次 Hub 已收到供应商明确的业务失败。约 50.4 秒是此次调用耗时，
不能据此断言 JustOne 内部超时、Cookie 失效或目标平台风控。
这与 10 月 9 日没有收到 HTTP 响应的 transport_error 是不同证据类型。
离线重放未发现本次响应分类差异；它不能验证供应商现在的可用性。

## Hub 改动

原先外层通用 502 没有保留“已确认采集失败”的原因，容易与网络异常混淆。
对经过 JustOne 适配器确认的 `rejected + 301 + upstream_collection_failed`，
继续返回 HTTP 502 和 `external_platform_rejected`，补充固定消息及以下字段：

```json
{
  "error": {
    "code": "external_platform_rejected",
    "message": "The data source reported a collection failure",
    "details": {
      "reasonCode": "upstream_collection_failed",
      "outcome": "rejected",
      "retryable": false
    }
  }
}
```

实际错误仍携带原有 Request ID。普通客户响应不暴露供应商名称、原始错误正文、
凭据或采购计费字段。未知业务码、其他供应商、网络 unknown 和解析失败保持原有语义。
Admin Token 请求诊断依据已有账本显示 301 的固定解释，无需读取额外原始正文。

保持原熔断、准入、预算、账本、缓存回退及幂等行为，不加入自动重试。
已提交的历史 502 继续原样重放，不追溯补写 reasonCode。同一个 Idempotency-Key
不能用来验证供应商恢复。MX-H2I 登录和联网不受影响。
本次改动是错误可诊断性修复，不能修复或掩盖供应商自身的采集失败；无需数据库迁移。

## 验证与上线

本地 158 项相关回归通过，覆盖 JustOne 合约/适配器、网关、公开 HTTP、归档、
native forwarding 和请求诊断。新增测试验证原因字段、脱敏、原账本与熔断、
单次分发、历史与新响应的幂等重放、unknown 优先及非匹配业务码不误分类。

补丁尚待部署。另已提供一次服务器侧真实验收命令：使用 LCY-delta 的 Hub Key，
`marketplace=taobao`、`query=华为笔记本`、`page=1`、`deliveryMode=live_only`，
固定幂等标识 `lcy-ecom-huawei-20261010-01`，每次测试仅允许一个新业务请求。
验收结果尚未收到，不能声称这次采集故障已恢复。若仍为 301，保存新的 Hub/供应商
请求关联 ID 和调用时间，由供应商排查采集链路，不通过换平台或返回空成功掩盖失败。
