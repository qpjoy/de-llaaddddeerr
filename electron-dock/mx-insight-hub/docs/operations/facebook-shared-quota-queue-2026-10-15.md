# Facebook 全局额度排队与单调计数

更新：2026-10-15。代码与离线验证已准备，尚未部署生产。用户明确要求保留现有自动恢复探测。

## 原因与实现

原有 PostgreSQL 单例额度行已经通过行锁预留次数，并限制一个 Facebook RapidAPI 请求在途。
两个问题分别是：`source_busy` 会让自动模式首请求直接选择 JustOne；普通响应的较大剩余数
可能调低本地 used，在同周期增加可用额度。后者可由本地代码复现，但缺少原生产计费头，
不能断言它就是某次历史超额的唯一原因。

raw 与标准搜索现在共享 PostgreSQL FIFO。只有队首能原子预留，等待者不消耗套餐次数；
最多 32 个等待、10 秒，轮询间隔最多 500ms，轮询之间不持有数据库连接或事务。
每次仍保留原请求的供应商超时加 5 秒持久化时间。过期、取消或进程中断的等待身份可清理，
没有后台重发任务。队列满／超时返回 503 和明确 Hub 等待原因，不因繁忙切换供应商。
确认额度不足时，自动模式按原规则选择 JustOne；限流、渠道可用性与确认 429 的原有边界保留。

可用套餐额度为 `max(0,min(monthly_limit-used,remaining))`，未知 remaining 仅采用本地上限。
普通响应只能降低 remaining、提高 used，不能恢复额度。1000 是供应商请求／保守预留次数，
不是帖子数或 Hub 请求数；标准补页每次独立准入，已存余量与幂等回放不增加采购。
拿到名额后取消或复核失败仍保留保守计数；不自动返还不确定调用，也不修正历史计数或账本。

保留既有按需恢复探测：可信 reset 优先，否则默认 72 小时，扣费日附近默认 6 小时。
到点仅允许一条真实业务请求探测，不按日历清零；可信且一致的正向套餐余量才能确认恢复。
探测是耗尽后的受控例外，可能产生额外费用，不能保证包括探测在内总调用绝不超过 1000。
这也不约束其他应用绕过 Hub 直接使用同一订阅的调用。

排队后复核当前身份、授权、页大小、暂停、凭据版本、采购控制、熔断和派发保护。
既有付费完整页、余量、入库、一次客户结算、未知结果保护及原游标渠道绑定保持；
不能把已绑定 RapidAPI 的游标直接交给 JustOne。

## 服务器只读核对

先同步此文件对应的 `server/ops/diagnose-facebook-quota.mjs` 到服务器 Hub checkout。
此脚本兼容迁移 151 前后数据库，可在旧 Admin 镜像中执行，无需先升级镜像。
从 Hub 目录运行：

```bash
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
  node --input-type=module - < server/ops/diagnose-facebook-quota.mjs
```

脚本仅用 READ ONLY 一致性事务查询当前策略／保守用量／供应商余量／恢复时间、队列能力与深度，
以及最近七天内至多 30 条 Facebook RapidAPI 调用的白名单计费头。不会查正文、凭据、等待者身份，
也不会发起供应商请求、恢复、释放、扣费或重放。`queueSupported=false` 表示尚无迁移 151；
`usedReserved` 含保守预留，不等于已确认供应商计费次数。当前快照不能证明历史选路原因。
先回传此 JSON 即可，无需先导出通用日志或响应全文。

新版运行时另记录 `event=facebook_rapid_admission`，只含 requestId、等待时间、队列深度、
保守 used／remaining、是否探测与固定准入原因。历史请求没有该日志时不能补推当时原因。

## 发布和验收

迁移 151 仅增加有界等待数组，不重置用量、恢复时间、策略、价格、授权或历史记录。
部署前后保留只读快照，发布完整 Hub 源码，先迁移再滚动 API；等所有 Public 副本完成更新，
混合版本期间旧副本仍有旧的计数／繁忙逻辑。

```bash
MX_INSIGHT_SYNC_LAUNCHER=0 MX_SMOKE_DATA=0 bash scripts/manage.sh ops internal-production deploy
kubectl -n mx-insight-hub rollout status deployment/mx-insight-hub-public --timeout=240s
```

不要通过自动回放旧失败或未知请求验收；使用正常业务的准入记录与后续只读额度快照观察。
没有 Launcher/MX-H2I 身份或网络改动。

## 本地验证范围

实际 PGlite 执行迁移、准入、取消、观察及只读诊断 SQL；两个独立策略实例验证队首顺序、
最后一个名额只能一次预留、等待／过期不推迟恢复时钟、普通陈旧头不能补额度、显式探测可恢复。
raw／standard 集成覆盖两实例并发、最后一次后 JustOne、仍有余量时继续 RapidAPI、取消／超时
零派发、完整 301 失败与当前客户账本语义。适配器用合成响应，无付费探测。
PGlite 单会话采用客户端串行包装，不能代表真实 PostgreSQL 多连接锁验收；
条件式真实 PostgreSQL 测试需要可丢弃 `mx_facebook_test_*` 数据库，本机未具备条件。
