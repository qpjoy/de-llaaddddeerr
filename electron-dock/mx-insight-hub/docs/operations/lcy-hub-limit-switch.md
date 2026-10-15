# LCY-delta 的 Hub 限制开关

此开关只控制原始 LCY-delta Key 的 Hub 请求次数、频率与并发限制。它不改变业务接口、请求参数、Key 密文、授权或价格，也不能解除上游供应商实际执行的限制。

## 管理入口与身份范围

使用 **Admin Token** 登录 Hub，进入 **API Keys → LCY-delta → Hub 限制开关**。在“数据浏览中心 → 限制与恢复”选中此 Key 后，也可以通过链接进入。普通租户会话和 Launcher/SSO 管理会话没有此设置入口或接口权限。

服务端同时校验以下不可变身份，不按名称匹配：

| 身份 | UUID |
| --- | --- |
| API Key | `fd2f8cc9-0ff1-4052-a538-8cc8150bde83` |
| 租户 | `277bf8a4-5ed5-414d-b429-d72fcd7d36b6` |
| 调用者 | `be7d07fe-3d98-4db3-b00d-e5cbe5a76190` |

重命名其他 Key、创建同名 Key、签发替代 Key、在业务请求中添加豁免字段，都不会获得此设置。读取和保存只访问 Hub 管理接口，不触发供应商查询。

## 三种保存状态

| 保存值 | 界面状态 | 行为 |
| --- | --- | --- |
| `null` | 沿用历史策略 · 尚未显式设置 | 保留现有内部 Key 的部分豁免；不等于已开启本开关的频率与并发豁免。部署迁移不会自动开启。 |
| `true` | 豁免已开启 | 跳过 Hub 业务查询的请求次数配额、限频、普通执行并发门禁和限流冷却；下列业务与安全边界继续生效。 |
| `false` | 豁免已关闭 · 普通 Hub 限制 | 使用普通 Hub 限制；明确覆盖原始 LCY Key 的 `managed_full` 及环境内部身份配置带来的额度豁免。 |

界面开关是待保存选项；点击保存并得到服务端确认后，才改变“当前状态”。每次变更填写原因，使用当前版本号提交，并记录不可变审计。首次把历史策略显式保存为关闭，会恢复普通限制，不能把它理解为“保持原样”。管理接口不提供写回 `null` 的操作。

保存影响后续准入，不清空历史计数，不改已经保存的响应或结算，不取消已派发调用，不重新执行旧请求。关闭后已有累计用量仍按普通规则计算，可能立即达到额度。

## 保留的业务与安全边界

以下规则继续生效：Key、租户和调用者有效性；平台、操作和合同授权；服务暂停/发布控制；凭据和合同校验；余额、价格、费用预占及结算；适用的采购/补贴预算；非限流故障保护；响应隔离；结果未知、重复采集和幂等保护；分页、响应大小及传输限制。

商品媒体传输仍受自身的请求频率、并发和响应大小限制，可能返回 `external_media_rate_limited` 或 `external_media_busy`。IP 订阅权益继续检查已购总次数、每日次数和有效期，可能返回 `commerce_quota_exhausted`、`commerce_daily_limit_exhausted` 或 `commerce_subscription_required`。这些分别属于传输资源保护和已购权益，不由此开关解除。

Facebook RapidAPI 的已购供应商额度账本和单笔派发记账顺序仍然保留，不能通过此开关清空已购额度或破坏不确定调用的账本。普通供应商并发/RPM 限制可豁免，供应商实际额度耗尽仍会阻止成功获取数据。此开关不会自动重试、切换供应商或增加付费调用。

“限制与恢复”中的共享供应商行仍显示真实全局状态。选中此 Key 时的豁免说明只描述该 Key 的效果，不将共享限制伪装成已解除，也不会影响其他 Key。

## 上游限流的错误语义

对新请求的已识别上游限流，保留原来的 HTTP/主错误码兼容性，并补充可区分来源的字段：

```json
{
  "error": {
    "code": "external_platform_capacity_exceeded",
    "details": {
      "layer": "upstream",
      "reason": "upstream_rate_limited",
      "upstreamDispatched": true,
      "upstreamStatus": 429,
      "limit": null,
      "retryable": false
    }
  }
}
```

示例用于解释字段，不是所有产品共用的新主错误码：原有社交/Web Search 等主错误码继续保留；供应商通过 HTTP 200 的业务码表达限流时，`upstreamStatus` 仍记录实际 HTTP 200。只有有证据时才附加 `outcome`，没有可靠额度/恢复时间时不编造 `limit` 或 `retryAfterMs`。旧的已保存响应保持不变。

IP 查询的公共 HTTP 状态保留原来的 502，并通过新增 `error.details.layer`、`reason`、`upstreamStatus` 等字段说明真实上游限流；不把普通 Key 的原 HTTP 合同改成 429。

Hub 自己的并发等待拒绝则使用 `layer: "hub"`、`stage: "concurrency_admission"` 与具体 `reason`，可提供 `retryAfterMs`。下游应展示消息、错误码、来源和 Request ID；不能单凭 HTTP 429 自动重发已经派发的付费请求。

## 管理接口

```text
GET /internal/v1/admin/api-keys/:id/hub-limits
PUT /internal/v1/admin/api-keys/:id/hub-limits
```

认证沿用 `x-mx-insight-admin-token`。GET 和 PUT 的 `data` 均返回：

```json
{
  "apiKeyId": "fd2f8cc9-0ff1-4052-a538-8cc8150bde83",
  "hubRateLimitExempt": null,
  "effectiveExempt": false,
  "inheritedQuotaExempt": true,
  "source": "legacy",
  "revision": 0,
  "updatedAt": null
}
```

`effectiveExempt` 仅表示显式开启本开关的豁免范围；`inheritedQuotaExempt` 说明历史额度豁免。显式保存后 `source` 为 `explicit`。PUT 请求为：

```json
{
  "hubRateLimitExempt": true,
  "revision": 0,
  "reason": "允许 LCY-delta 直接接收上游限流反馈"
}
```

必须使用刚读取的版本号。`409 api_key_hub_limits_changed` 表示其他管理员已修改，需重新读取后决定；`403 api_key_hub_limits_not_supported` 表示身份不在范围；失效/撤销/测试 Key 或停用身份不能保存。网络断开时保存可能已完成，界面会清除旧快照并要求重新读取，不自动重试 PUT。

## 发布与启用

先发布 migration `153_api_key_hub_limits.sql`、Public API、Admin API 和前端的同一版本，确认**所有 Public/Admin Pod 已更新，滚动更新中的旧 Pod 已退出**，再在界面保存开启。不能只更新前端或部分 Public 副本；旧进程既会执行旧限制，也不能正确处理 PGY 豁免派发使用的新 `exemptActive` 队列状态。迁移默认保留历史状态，不自动开启 LCY，也不修改其他 Key。

如果需要回滚旧代码，先关闭开关并等待正在执行的 PGY 豁免任务结束；关闭不会取消已派发任务。不要通过清空队列或未知结果记录来完成回滚，否则会丢失防止重复付费调用的证据。

由操作人员在服务器的 `electron-dock/mx-insight-hub` 目录执行既有 Hub 部署命令，代理参数沿用当前服务器配置：

```bash
MX_INSIGHT_SYNC_LAUNCHER=0 MX_SMOKE_DATA=0 \
bash scripts/manage.sh ops internal-production deploy
```

该流程只发布 Hub，保留 MX-H2I 的登录和联网链路。代码实现和离线验证不代表生产已发布或开关已开启；本次不自动执行生产部署、开关写入或付费探测。发布后可只读打开开关核对版本和状态，明确保存一次开启，重新读取确认，再观察后续原有业务流量的 Request ID 与错误来源。

## 界面验证记录

最终本地集成回归共 521 项：514 项通过、7 项因未配置真实 PostgreSQL 测试环境跳过、0 项失败。已启用实际 PGlite 的迁移、审计事务、准入与账本测试；覆盖开启/关闭、同名冒用、普通 Key 计数、分页中关闭、PGY 重复拥有者与未知结果保护。类型检查与 Vite 构建通过，未调用真实供应商。

本地使用实际 Hub React 页面和拦截的合成管理响应验证：历史状态开启/关闭及重新打开；必填原因；409 版本冲突后重新读取；保存响应丢失时不重复提交；同名其他 Key、错误租户和 SSO 管理员均不显示开关。所有测试均未发起 Public 业务查询。

1440×1000 桌面与 390×844 移动端的新增弹窗可正常显示、滚动和操作，没有弹窗内横向溢出、框架错误或未处理异常。API Keys 原有背景表格在手机宽度下仍有页面横向溢出，移除新增按钮也存在；本次未修改该表格布局。浏览器插件未提供，验证使用本机 Playwright/Chrome。管理客户端回归确认只使用 GET/PUT 管理路由，保留原版本号和错误详情，不自动重试保存。
