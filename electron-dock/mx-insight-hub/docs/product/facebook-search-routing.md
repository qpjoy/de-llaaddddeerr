# Facebook 搜索由 Hub 管理

更新：2026-10-15。Facebook 搜索迁入 Hub；平台策略由管理员管理，业务请求自动选路。raw 是已有的兼容数据服务入口，Facebook 是它的平台分支，无需另建一套客户授权或计费入口。

## 调用链与接口

核对的本地调用链：`po-infra/data_hub/data_query_collector.py` → `llm/data_query.py` → Hub `/api/v1/night-all/search/raw`。线上报错中的 request ID 证明请求到过 Hub，但不能据此断言线上采集端与本地版本完全一致。

以下 Facebook 搜索统一由 Hub 调用供应商，不再请求 Night-All，也不受 Night-All 的 `endpoint_degraded` 状态控制：

- `POST /api/v1/night-all/search/raw`、`POST /api/v1/search/raw`：保持原 raw 响应合同和共享幂等身份。
- `POST /api/v1/data/search`：保持 `night-all.data-search.v1` 内容投影。
- canonical/aggregate 的实时 Facebook 子请求复用 data/search；返回内容通过现有 ingest 队列异步写入 canonical。查询已存 canonical 数据仍为本地读取。

Facebook 的 crawl、user-info 尚未迁移。其他平台执行路径不变。数据源目录管理视图记录 Facebook 两个渠道以及 16 个既有平台的稳定目录编号；其他平台显示“沿用现有路由”，不因登记策略而自动启用新渠道。

2026-10-15 双渠道字段校准由 Hub 内部承担：相册真实图片、明确视频封面、数字字符串时间、
严格统计类型与已归一字段统一到原 raw／标准／canonical 字段，不改变公共 URL、请求结构、
envelope、授权或计费。新遍历使用内部投影 v2，旧游标和历史回放保持原投影与响应；
检索式不拆分、不改写。[完整字段矩阵、证据及兼容验证](../operations/facebook-provider-field-calibration-2026-10-15.md)。

支持一个 query/keyword（可含原有布尔检索式），页大小 1–100；标准搜索余量优先并自动补页，没有单个 Hub 请求默认 3 次派发的限制，仍受整次查询的 15 次采购、15 个公开页、原期限及字节预算约束。完整上游页分别归档、入库并保留余量。原 raw 仍按一个完整上游页交付，超出请求上限时明确报错。时间通过 `params.startTime/endTime` 或 `params.startDate/endDate` 传入，供应商接口只接受日期，精确到秒的窗口仍需调用方过滤。省略时使用中国时区的昨天至今天。

2026-10-15 用户要求后新增 Facebook 标准补页：余量优先、已交付 ID 去重，首次 429 保底计入整次采购上限；取得第一页后固定供应商。每次派发独立检查额度、操作、采购与限流，父请求只结算一次。达到补页预算或准入限制时返回已有内容、partial 与警告，安全游标仍可继续；结果自然耗尽允许短页。整次查询最多 15 次实际采购、15 个公开页，24 小时游标、原期限及含余量在内的 12 MiB 组页预算保持有界。新标准媒体投影把明确的 `video_thumbnail` 放入 `coverUrl`，有视频时仅从 images 移除与封面完全相同的 URL，保留真实混合照片和不同签名 URL。`photo.php` 等落地链接保留为来源链接，不猜 CDN 直链；旧 raw、原始响应与 canonical 入库投影不因此改变。普通帖子 title 仍为空／null，正文不截断。详见 [字段及兼容性核查](../operations/strategy-search-contract-audit-2026-10-15.md)。

本地采集端当前把时间放在顶层，而 legacy payload 归一化只保留 `params`，所以其时间窗口目前仅作用于结果过滤。部署验收应核对线上采集端版本；需要限定上游窗口时，把时间放进 params。示例请求体：

```json
{"platform":"facebook","query":"(Unitree OR \"Unitree Robotics\" OR 宇树科技)","count":100,"params":{"startTime":"2026-10-07T10:11:11Z","endTime":"2026-10-10T10:11:11Z"}}
```

Hub 游标绑定 Key、查询、时间和渠道，有效期一天、最多 15 页。旧 Night-All/供应商游标返回 `invalid_cursor`，须从第一页开始。已有分页不会把 RapidAPI cursor 发给 JustOne；渠道额度不足时返回 `search_restart_required`，调用方应以新 Idempotency-Key 从第一页重启并按帖子 ID 去重。暂停平台返回 `facebook_search_paused`。超时、5xx、成功但不可解析的响应保留结果不确定性，不自动重复可能已收费的调用。

标准搜索的旧 Hub 原生续页游标没有采购计数和前驱交付引用：RapidAPI 按此前公开页数保守继承；JustOne 另预留一次可能发生于首请求的 RapidAPI 429 派发，因此可能提前一页达到 15 次采购上限并要求明确重启。新 `facebook-fill.v1` 游标保存实际计数，不受这项历史不确定性折减。

## 策略、额度与恢复

管理入口：**数据接入与治理 → 数据平台 → Facebook → Raw Search 上游选路**。Facebook 是数据平台；RapidAPI、JustOne 只是可替换的上游供应商。模式为自动（RapidAPI → JustOne）、仅 RapidAPI、仅 JustOne、暂停。每次保存要求修改原因和当前 revision，数据库 CAS 防止覆盖别人刚保存的策略，并记录审计事件。接口仅接受 Admin Token：

- `GET /internal/v1/admin/platform-search-policies`
- `PUT /internal/v1/admin/platform-search-policies/facebook`

2026-10-14 用户确认：**Twitter 只走 RapidAPI；Facebook 优先使用 RapidAPI 套餐额度，耗尽后走 JustOne；其他平台不走 RapidAPI**。Facebook 套餐为用户提供的 **5 美元/月、1000 次/月**，约每月 27 日扣费；这是本账户的配置依据，不代表官网所有账户的当前价格。Facebook 计数与恢复检查独立于 Twitter，Twitter 不消耗这 1000 次。套餐内调用记零边际采购成本，订阅费不等于单次调用费；JustOne 沿用已有审核价、预算和启停控制。

额度状态保存在 Hub 的 PostgreSQL，所有副本共享。每次发送前原子预留次数，同一订阅最多一个 RapidAPI 在途请求。raw 和标准搜索共用 FIFO 等待队列，最多 32 个等待、10 秒，并为实际调用及持久化保留原请求期限；繁忙本身不再让自动模式改走 JustOne。队列满或超时返回 `503 external_platform_busy`，明确 Hub 等待原因；不在后台继续派发。等待后重新检查当前权限、凭据、操作、采购与派发保护。次数用尽、供应商返回剩余 0 或确认月额度耗尽时，自动模式才按额度规则转 JustOne；既有限流／可用性保护和明确 HTTP 429 的首请求回退规则保留。两次实际调用分别留档，只结算一次客户请求，发送前跳过 RapidAPI 不虚构一次上游调用。已绑定渠道的续页保持原渠道，不能自动迁移 cursor。

**1000 次是供应商请求次数，不是帖子条数或 Hub 请求数。** 标准搜索补出的每一页都要独立预留；仅交付已保存余量或幂等回放不增加采购。可用额度取本地上限减已预留数与供应商剩余的较小值，普通响应头只能收紧、不能调低 used 或增加剩余。拿到名额后取消或状态复核失败仍保守保留预留数，不用不确定结果返还额度。只有明确标记的恢复检查及可信正向计费证据可以确认新周期。

按用户确认的月套餐读取 `x-ratelimit-requests-remaining/limit`，兼容 `x-rapidapi-requests-remaining/limit`。同一组计费头的有效 reset 秒数可安排恢复检查；不同组值冲突、套餐上限不一致或缺失的计费证据不能确认恢复。`x-ratelimit-remaining/reset` 是短期限流，免费套餐 hard-limit 也是另一种限制，都不能混入本套餐的月额度。短时限流仍按 Retry-After 冷却。官方文档说明经 RapidAPI Proxy 的响应包含计费头，但连接失败或异常响应可能没有可用字段；缺失保持未知，不能当作额度为零或已恢复。[响应头说明](https://docs.rapidapi.com/v1.0/docs/response-headers)、[套餐计费头说明](https://docs.rapidapi.com/v2/docs/api-pricing)。

未拿到可信重置时间时，默认每 **72 小时**允许下一条真实业务请求做一次恢复检查；预计扣费日前一天至后两天（默认北京时间 **26–29 日**）缩短为 **6 小时**，可缩短此前已排定的 72 小时等待。无请求时不主动调用。管理员可配置扣费日（1–31）、普通间隔（24–744 小时）及扣费窗口间隔（1–24 小时）；短月份按月末处理，保留旧客户端未传的新设置。

时间到点、日历到了 27 日，都只允许一个跨副本共享 lease 保护的恢复检查，**不会清零 used 或补足 1000 次**。成功响应且可信套餐剩余额度大于零才恢复并校准本地计数；仅 HTTP 200 不足以证明恢复，因为套餐可能允许超额计费。2026-10-15 用户明确保留现有自动恢复探测，因此恢复检查仍是套餐耗尽后的受控调用例外，可能计费，采购证据记为未知，不能记成确认免费。管理页展示供应商剩余、重置提示及实际下次可检查时间，页面读取不触发检查。

每次 Facebook 有 HTTP 响应时，其白名单计费头解析结果保存在受限调用证据中，成功、429、响应体损坏均可排查，业务响应不暴露供应商额度。已收到明确 429 时，即使响应体读取失败，自动模式首请求仍可一次转 JustOne；不触发供应商故障熔断。超时、5xx 和不可解析的成功响应不自动换供应商。配额状态写入失败保留真实调用结果和原始错误，等待不确定 lease 过期，不覆写账本或重发已收费请求。RapidAPI 本地短时限流也允许自动模式首请求转 JustOne；绑定 RapidAPI 的旧分页和强制 RapidAPI 模式保持原有边界。

## 部署与凭据迁移

正常部署会应用迁移 143，创建并种入策略、额度和审计表；2026-10-14 新增迁移 **149**，仅增加扣费日和窗口间隔字段；2026-10-15 迁移 **151** 仅增加最多 32 个等待身份的 JSONB 队列。先完成迁移再发布 API；迁移登记保证重复部署不重置额度或管理员配置。混合新旧副本期间，旧副本仍可按旧规则处理，必须等所有 Public 副本完成滚动更新后再验收新队列。保留现有操作、授权、价格、暂停状态、历史响应与账本；JustOne 使用现有原生接口的价格发布流程。

部署通过 `scripts/migrate-night-all-deploy-credentials.mjs` 统一导入：先读 Hub 目标配置，只对从未配置的供应商凭据做 CAS 导入。已有数据库/环境凭据、手动清空记录均保留。RapidAPI/JustOne 使用既有独立凭据存储，不写入迁移 SQL、日志或文档。普通详情不返回明文，查看仍需二次 Admin Token 验证。完整来源规则见 [Night-All 供应商凭据迁移](../operations/night-all-credential-migration.md)。

标准目录不需要配置 `NIGHT_ALL_CONFIG_PATH`：部署脚本从服务器当前用户的 `workspace/mingxi/Night-All` 和 Hub 上级目录的常规兄弟路径发现 `config.json`。其他目录在服务器 `.env.internal` 显式指定路径。仅自动发现不到文件时保留旧 Facebook 环境/legacy 导入兼容；显式错误路径、JSON 无效或未知写入不会改用另一来源重试。来源不可用会提示，管理员仍可在供应商详情填入密钥，不将可选来源作为身份系统的健康条件。

```bash
# 在服务器的 mx-insight-hub checkout 中执行
MX_INSIGHT_SYNC_LAUNCHER=0 MX_SMOKE_DATA=0 bash scripts/manage.sh ops internal-production deploy
kubectl -n mx-insight-hub rollout status deployment/mx-insight-hub-public --timeout=240s
```

迁移表位于 Hub 数据库的 `control` schema；截图中的 `public_opinion.public.source_endpoint_catalog` 并不是这些新表所在的位置。不要为此修改 Night-All 的端点状态。Launcher/MX-H2I 登录、网络服务和权限配置不在本次修改范围。

## 本地验证与上线边界

离线 provider fixtures 验证 raw 别名、data/search、正文不截断、游标隔离、429 回退、未知结果不重发和凭据迁移幂等。可丢弃 PostgreSQL 中验证全部迁移及重复应用、并发额度预留、跨周期恢复、CAS 审计、单次客户结算、两份原始响应和一条入库任务。

管理页面用 Playwright + 本机 Chrome 验证保存、刷新、桌面与手机布局（本会话没有 Browser 插件，按前端测试技能使用 Playwright 回退）。隔离服务只模拟供应商和额度状态；未连接 Launcher、真实供应商或生产数据库。

本轮队列与单调计数修改尚未部署生产，未进行真实付费请求。上线前后可使用 [全局额度排查步骤](../operations/facebook-shared-quota-queue-2026-10-15.md) 只读核对当前余量、队列能力和最近计费头。PGlite 验证实际 PostgreSQL SQL 与状态转换，不证明真实 PostgreSQL 多连接锁行为；真实 PG 条件测试需要可丢弃测试库。本地测试不证明生产每次响应都会带齐计费头。历史失败请求与未知计费请求不要批量自动重放。
