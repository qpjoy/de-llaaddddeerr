# Twitter 空资料响应与后续 409

日期：2026-11-01（Asia/Shanghai）。本地已修正错误分类，并按用户后续决定取消不可用响应冷却；未部署、未再次采购。

## 最新决定：取消不可用响应冷却

用户明确选择“取消不可用响应冷却，保留幂等和在途去重”。所有使用共享 ExternalPlatformStore 的
正常运行配置现将 `RESPONSE_QUARANTINE_MS` 设为 0，内存与 PostgreSQL 准入显式跳过非正冷却时长；
Admin 诊断也不再把已结束坏响应列为冷却项，未来时间戳不会误触发保护。旧部署变量继续忽略。
原时长参数及诊断分支仅为内部兼容保留，显式旧时长测试仍覆盖原错误分类；没有新增面向用户的开关。

同一幂等键的原 502/unknown/成功回执继续回放；真正执行中的相同请求、有效派发锁继续去重。
新请求可立即再次查询，不会自动触发重试，也不修改原始响应和账单，可能再次产生供应商费用。
连续故障的供应商/平台契约熔断、速率/并发/资源限制、授权、预算和钱包规则保持不变。
已配置主备供应商的搜索可以在原路由规则允许时继续使用备用；未添加任何新的回退路由。

取消冷却不需要新增数据库迁移或清理历史记录。需将完整 Hub 代码同步到服务器并更新全部
Public/Admin API 副本；混合版本时旧副本仍可能返回冷却 409。
在服务器 `electron-dock/mx-insight-hub` 目录执行既有发布流程：

```bash
MX_INSIGHT_SYNC_LAUNCHER=0 MX_SMOKE_DATA=0 bash scripts/manage.sh deploy
kubectl -n mx-insight-hub rollout status deployment/mx-insight-hub-public --timeout=300s
kubectl -n mx-insight-hub rollout status deployment/mx-insight-hub-admin --timeout=300s
```

本次未执行生产发布。MX-H2I 登录、联网、SSO 和 Pay 未修改。

## 已确认的生产证据

Delta 请求 `/api/v1/data/social/crawl`，请求体为
`{"platform":"twitter","usernames":["11"],"count":50,"activityTypes":["posts"]}`。

- `df24d98c-4568-49ae-9df3-46ebec7bae06`：北京时间 12:55:02，HTTP 409；账本为 released / external_platform_pre_dispatch_failed，自有采购记录为零，未保存响应正文。
- 同指纹较早请求 `94925dbb-a2b2-448b-9550-e1364e73ec7c`：12:54:38–12:54:40，committed / 502 / social_upstream_response_unusable。
- 该请求唯一采购 `d2d99160-7730-4867-a0a0-f52e9a3511da`：rapidapi / social.profile.get / twitter-aio.user-info，HTTP 200，succeeded_unusable，billed 为 null（未知），没有抓帖调用。
- 已保存 JSON 精确为 `{"data":{"users":[{}]}}`；body_size 和实际字节数均为 23，存储 SHA-256 为 `5fa2d36df254afe1af3d16f5752a63928faf7d2264429d6060197295587715e4`。本地相同字节的 SHA-256 一致；本次 SQL 没有重新计算生产 body_bytes 的哈希。
- 12:55:07、12:55:18 两次同幂等键请求同样 released / external_platform_pre_dispatch_failed。22:46 的只读检查没有匹配的当前锁；这不证明历史时刻无锁。

这些证据确认原始资料不可用，不证明账号不存在、被封禁或供应商未收费。
原 409 的正文和历史锁 owner 未取得；前一笔不可用响应与后续保护拒绝的时间顺序吻合，
本地精确 fixture 能复现该链路，但不能据此声称已读取生产原始 409 错误码。

## 修正与边界

`social-account-workflow.mjs` 原先将 `acquireDispatchLease` 返回的
`reason=succeeded_unusable` 混入 `request_in_progress`，错误提示 acquisition pending。
现在沿用已有 gateway 合同：HTTP 409 / `external_platform_response_unusable`，
`details.upstreamDispatched=false`、`details.blockedUntil`，说明近期响应不可解析且禁止自动重试。
真实在途和 unknown 分支保持原有行为。

事故发生时保护窗口默认 5 分钟，匹配 provider、operation、endpoint 和 contract version，
并非只有相同账号会命中。最初只修正错误分类；后续取消冷却的决定见本文开头。
没有改写历史 502、采购记录、归档或账务；相同幂等键的已保存失败继续精确回放。

当前账号归一化会把裸数字 `11` 先作为 ID；只有明确的 no-account 回答才允许一次用户名回退。
空对象不提供这种证据，继续返回 502。若调用意图确实是用户名 `@11`，新查询应明确传
`usernames:["@11"]` 或 `urls:["https://x.com/11"]`。这是身份消歧，不是旧失败的自动恢复；
未验证生产当时版本、实际出站 URL，也未验证 `@11` 当前是否存在或可采集。

## 离线验证

新增回归通过真实适配器、账号工作流和内存账本执行该 23 字节 fixture：
首次 502、不回退用户名、不抓帖；后续新键被保护时为准确的 409 原因；
被拒绝请求无新增采购并释放客户预留；原键重放不追加采购，原账本保持不变。
先运行回归复现 `request_in_progress` 错码，修正后通过。
相关 5 个测试文件共 122 项通过、0 失败、0 跳过，覆盖数字账号回退、真实并发保护、
账号工作流、账号不可用判定和合同兼容；HTTP 测试仅监听本地端口、供应商均为替身。
`git diff --check` 通过。

取消冷却后的验证：8 个专项文件共 198 项全部通过、无跳过，包含 PGlite 0.2.17 执行的实际
PostgreSQL 派发和 Admin 查询；验证新请求不受旧坏响应影响、未来完成时间不形成冷却、
pending/有效租约继续阻塞、原失败回放和账务/归档不变。扩展至 raw-search-routing 与 hub
共 337 项，331 通过、6 失败；临时独立副本使用未修改 HEAD 重跑后两个文件，139 项中
相同 6 项失败（2 项 Hub 历史接口、4 项 Twitter 搜索合同），没有新增失败。
微博的新请求仍返回真实上游 502 而非冷却 409；Instagram 原配置主备路由可继续选择备用，
主供应商熔断仍生效。生产恢复未验证。

发布仅涉及 Hub；遵循既有部署流程并保持 `MX_INSIGHT_SYNC_LAUNCHER=0 MX_SMOKE_DATA=0`。
本轮没有发布、生产写入、付费探测，未更改 MX-H2I 登录、SSO、网络、VPN、DNS 或 Pay。
取消冷却和改善错误分类均不保证上游开始返回可用资料。
