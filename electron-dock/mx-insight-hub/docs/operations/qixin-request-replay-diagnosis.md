# 三个企业接口请求的失败取证（2026-09-22）

| 接口 | 原始 Hub requestId |
| --- | --- |
| 12.1 商标列表 | a227f54a-0ac6-43f5-9d23-687fc369f2ae |
| 77.1 企业供应商信息 | a8ff83f0-c297-4034-acb8-5e1652518c45 |
| 8.1 专利列表 | 49711b2c-766c-410c-b646-37047e4656b0 |

## 已确认与待确认

截图只显示第三个请求复现失败。`acquisition_query_run_unavailable` 是历史读取的
409：记录存在，但 `status != committed` 或 `response_body IS NULL`。
截图底部 `892a644a-3d10-427b-9153-d805bf25318f` 是本次复现 GET 的关联 ID，
不是专利查询的原始 ID。不能据此推断三次查询的上游错误相同。

本地目录将这三个接口映射到 QixinAdapter，均为 GET，必填 `query.name`，
可选 `query.skip`；专利另支持 `role_code`、`role_history`。
实际执行路由和参数仍需数据库证据，不能把此前 Night-All/Twitter 的 502 原因套用到此事件。

当前代码对 Qixin HTTP 200 + 业务码 200/201/202/203/206 接受交付（包括无数据或待完成）。
其他明确业务拒绝走 `enterprise_query_rejected`，没有存量结果交付时请求为 `released`，
保存的错误响应仍不满足成功交付复现条件。HTTP 5xx、缺失业务码、非 JSON 或传输异常可能
走 `enterprise_outcome_unknown`。仅凭这个总括错误码无法区分这些原因。

原始响应另外存于 `control.external_platform_restricted_raw_responses`，
独立于 `usage_requests.response_body`；“不能复现交付”不等于“没有原始错误证据”。
当前实现会释放明确拒绝的客户冻结金额，未知结果保留冻结；生产版本和实际账本需核实。

## 在 Hub 服务器取证

将 [diagnose-qixin-requests.sh](../../scripts/diagnose-qixin-requests.sh) 复制到有 kubectl
访问权限的 Hub 服务器，执行（也可在已同步的仓库根目录执行此相对路径）：

```bash
bash electron-dock/mx-insight-hub/scripts/diagnose-qixin-requests.sh > /tmp/qixin-request-evidence.json
cat /tmp/qixin-request-evidence.json
```

只复制脚本即可，无须部署镜像。默认 namespace `mx-insight-hub`，
目标 `deployment/mx-insight-hub-public`，容器 `api`。
环境不同可用 `HUB_NAMESPACE`、`HUB_TARGET`、`HUB_CONTAINER` 覆盖。

脚本在现有容器启动临时 Node 进程，使用现有 DATABASE_URL；数据库强制只读，
一致性快照事务，单条查询最长 10 秒，锁等待最长 2 秒，只查指定三个 ID。
不会请求供应商、重试采集、修改账本、读取密钥表、重启服务或更改 MX-H2I 登录/网络。
输出包含参数类型/长度与分页值，不导出企业名称、完整请求、完整响应或签名。
仅对 Qixin 非成功调用提取归档顶层 status/message，消息最多 1500 字符，
附原字符数并做文本脱敏；贴回前检查上游消息是否含业务敏感内容。

请贴回完整 JSON（包括 unavailable 段），按以下证据分支分析：

- `usage.rows` 缺少某个 ID：核对故障环境/数据库与保留期，不能当作该请求成功或未发生。
- `providerCalls` 的 `provider_key=qixin`：沿该调用的 `business_code` 与 `qixinErrorMessages`
  定位具体拒绝。只有实际出现 104/“未添加IP白名单”等证据，才归因相应配置。
- 有 usage、无 provider call：检查请求是否在调度前受策略阻止、使用缓存，或记录保存失败；
  结合 `error_code`、交付来源和真实时间取 Hub 日志，不能认定上游已拒绝。
- `unknown` + HTTP 5xx/无业务码：结合归档的 content_type、json_parsed、大小判断是否收到
  无法识别的响应。没有 HTTP 状态还需请求时间附近的 Hub/中继日志。
- `qixinErrorMessages=[]`：可能没有受限归档，或调用成功/走其他供应商，不代表无错误。
  `unavailable` + `42501` 是数据库读取权限不足；`42P01` 是表不存在。
- `customerCharges` 按 `enforcement_mode`、状态和 charged_minor 核对实际客户结算；
  provider 的 `billed=null` 表示供应商实际扣费未知，不能用估计 cost_minor 当实际扣款。

若错误正文未被历史版本保存，不能补造。需要先保留现有证据，再决定是否由用户明确
发起新的对照请求；不通过自动重跑这三个接口来“恢复”旧记录。

代码依据：[交付断言](../../server/acquisitions/history-store.mjs)、
[Qixin 适配器](../../server/adapters/qixin.mjs)、
[供应商结算存储](../../server/external-platforms/store.mjs)。
本次仅增加取证脚本与说明，不修改运行时业务逻辑。
