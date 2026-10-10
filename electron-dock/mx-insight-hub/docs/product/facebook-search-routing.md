# Facebook 搜索由 Hub 管理

2026-10-10。Facebook 搜索迁入 Hub；平台策略由管理员管理，业务请求自动选路。raw 是已有的兼容数据服务入口，Facebook 是它的平台分支，无需另建一套客户授权或计费入口。

## 调用链与接口

核对的本地调用链：`po-infra/data_hub/data_query_collector.py` → `llm/data_query.py` → Hub `/api/v1/night-all/search/raw`。线上报错中的 request ID 证明请求到过 Hub，但不能据此断言线上采集端与本地版本完全一致。

以下 Facebook 搜索统一由 Hub 调用供应商，不再请求 Night-All，也不受 Night-All 的 `endpoint_degraded` 状态控制：

- `POST /api/v1/night-all/search/raw`、`POST /api/v1/search/raw`：保持原 raw 响应合同和共享幂等身份。
- `POST /api/v1/data/search`：保持 `night-all.data-search.v1` 内容投影。
- canonical/aggregate 的实时 Facebook 子请求复用 data/search；返回内容通过现有 ingest 队列异步写入 canonical。查询已存 canonical 数据仍为本地读取。

Facebook 的 crawl、user-info 尚未迁移。其他平台执行路径不变。数据源目录管理视图记录 Facebook 两个渠道以及 16 个既有平台的稳定目录编号；其他平台显示“沿用现有路由”，不因登记策略而自动启用新渠道。

支持一个 query/keyword（可含原有布尔检索式），页大小 1–100；每个上游响应作为完整一页交付，不补齐、不截断。上游返回条数超出请求上限时保留受限原始响应并明确报错。时间通过 `params.startTime/endTime` 或 `params.startDate/endDate` 传入，供应商接口只接受日期，精确到秒的窗口仍需调用方过滤。省略时使用中国时区的昨天至今天。

本地采集端当前把时间放在顶层，而 legacy payload 归一化只保留 `params`，所以其时间窗口目前仅作用于结果过滤。部署验收应核对线上采集端版本；需要限定上游窗口时，把时间放进 params。示例请求体：

```json
{"platform":"facebook","query":"(Unitree OR \"Unitree Robotics\" OR 宇树科技)","count":100,"params":{"startTime":"2026-10-07T10:11:11Z","endTime":"2026-10-10T10:11:11Z"}}
```

Hub 游标绑定 Key、查询、时间和渠道，有效期一天、最多 15 页。旧 Night-All/供应商游标返回 `invalid_cursor`，须从第一页开始。已有分页不会把 RapidAPI cursor 发给 JustOne；渠道额度不足时返回 `search_restart_required`，调用方应以新 Idempotency-Key 从第一页重启并按帖子 ID 去重。暂停平台返回 `facebook_search_paused`。超时、5xx、成功但不可解析的响应保留结果不确定性，不自动重复可能已收费的调用。

## 策略、额度与恢复

管理入口：**数据接入与治理 → 数据平台 → Facebook → Raw Search 上游选路**。Facebook 是数据平台；RapidAPI、JustOne 只是可替换的上游供应商。模式为自动（RapidAPI → JustOne）、仅 RapidAPI、仅 JustOne、暂停。每次保存要求修改原因和当前 revision，数据库 CAS 防止覆盖别人刚保存的策略，并记录审计事件。接口仅接受 Admin Token：

- `GET /internal/v1/admin/platform-search-policies`
- `PUT /internal/v1/admin/platform-search-policies/facebook`

默认额度为用户提供的 **1000 次/周期**，可配置；不把“$5 免费”当作已核验的供应商套餐定价。套餐内调用记零边际采购成本，订阅费不等于单次调用费；JustOne 沿用已有审核价、预算和启停控制。

额度状态保存在 Hub 的 PostgreSQL，所有副本共享。每次发送前原子预留次数；同一订阅最多一个 RapidAPI 在途请求，繁忙时自动模式可使用 JustOne。次数用尽、供应商返回剩余 0 或确认月额度耗尽时阻断 RapidAPI。明确 HTTP 429 后可在同一客户请求内调用 JustOne；两次上游调用分别留档，只结算一次客户请求。发送前跳过 RapidAPI 不虚构一次上游调用。

优先读取 `x-ratelimit-requests-remaining/reset`，以及 RapidAPI 免费套餐 hard-limit 响应头。reset 是距重置的秒数，不能按自然月第一天猜测；短时限流按 Retry-After 冷却，不直接封禁整月。[RapidAPI 响应头说明](https://docs.rapidapi.com/docs/response-headers)。

未拿到重置时间时，默认每 **72 小时**允许下一条真实业务请求做一次恢复探测；无请求时不主动调用。恢复需成功响应且供应商明确返回正的剩余额度；仅 HTTP 200 不足以证明恢复，因为套餐可能允许超额计费。未知周期探测可能计费，采购证据记为未知，不能记成确认免费。管理员可修改探测间隔（24–744 小时）。

## 部署与凭据迁移

正常 `bash scripts/manage.sh deploy` 会应用迁移 143，创建并种入策略、额度和审计表；迁移登记保证重复部署不重置额度或管理员配置。RapidAPI 新搜索操作初次启用；已有手工策略不覆盖。JustOne 使用现有原生接口的价格发布流程，管理员暂停仍保留。

部署还会运行 `scripts/migrate-facebook-credentials.mjs`：先读 Hub 目标配置，只对从未配置的 RapidAPI/JustOne 凭据做 CAS 导入。已有数据库/环境凭据、手动清空记录均保留。密钥由现有 Hub 加密凭据库管理，不写入迁移 SQL、日志或文档。

**不需要配置 `NIGHT_ALL_CONFIG_PATH`。** 部署脚本会从当前主机约定的 Night-All 本地工作区自动发现 `config.json`（当前用户工作区下的 `workspace/mingxi/Night-All`，以及 Hub 上级目录的常规兄弟路径），然后使用安全读取器导入。也支持显式环境变量覆盖路径；找不到来源时记录 `source_unavailable`，管理员仍可在供应商详情填入密钥，部署不以这个可选来源作为身份系统的健康条件。

```bash
cd electron-dock/mx-insight-hub
bash scripts/manage.sh deploy
```

迁移表位于 Hub 数据库的 `control` schema；截图中的 `public_opinion.public.source_endpoint_catalog` 并不是这些新表所在的位置。不要为此修改 Night-All 的端点状态。Launcher/MX-H2I 登录、网络服务和权限配置不在本次修改范围。

## 本地验证与上线边界

离线 provider fixtures 验证 raw 别名、data/search、正文不截断、游标隔离、429 回退、未知结果不重发和凭据迁移幂等。可丢弃 PostgreSQL 中验证全部迁移及重复应用、并发额度预留、跨周期恢复、CAS 审计、单次客户结算、两份原始响应和一条入库任务。

管理页面用 Playwright + 本机 Chrome 验证保存、刷新、桌面与手机布局（本会话没有 Browser 插件，按前端测试技能使用 Playwright 回退）。隔离服务只模拟供应商和额度状态；未连接 Launcher、真实供应商或生产数据库。

本次未部署生产、未进行真实付费请求、未把生产密钥迁移到生产库。上线后应确认 deploy 的凭据结果、两家供应商的操作状态，再用业务 Key 发一次新搜索并保留 requestId 验收。历史失败请求与未知计费请求不要批量自动重放。
