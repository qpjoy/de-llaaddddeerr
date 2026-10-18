# Canonical 延迟与 Delta 检查后续（2026-10-19）

## 请求是否都等待 Elasticsearch

不是。Twitter 实时采购返回后，同步路径仍要保存采购证据、归档、费用与交付账本以及持久化 ingest job；这些 PostgreSQL 操作会阻塞 HTTP 完成，但不等待 ingest / projector 把该页写入 ES。ingest 和 projector 为独立 worker。不能把“保存后续处理任务”与“本次响应等待 ES 索引完成”混同。

Canonical 查询读取已经保存的投影：配置并满足条件时用 ES；允许降级的首请求可以走 PostgreSQL。携带 ES 游标的后续页不能偷偷换成另一排序/可见性投影。管理数据中心无关键词列表直接查 PostgreSQL；有关键词走 SearchQueries。保存交付的幂等重放不再次检索。Canonical 的现有 `durationMs` 从准入完成后开始计时，不包含前面的策略读取、过期清理与额度预占，不能代表端到端响应时间。

此前三个 Twitter 样本供应方仅耗时 2.808–3.674 秒，Hub 后段出现明显等待，详见 [504 调查](hub-504-2026-10-18.md)。本次又确认了控制平面所在 NVMe 的超时，详见 [部署与存储调查](admin-freeze-controller-2026-10-19.md)。两组观测时刻不同；尚未取得 14Z 故障时逐请求的磁盘/锁证据，不直接声称所有 504 同因。

## 本次优化

1. 公共 canonical / aggregate 公用准入，原本对 N 个授权平台重复读取策略、套餐与 Key entitlement，总计约 4N 次读取。改为当前 consumer 策略集合、Key entitlement 集合、套餐各一次。只在同一请求内复用；不缓存跨请求授权。保留全授权集合中最严格额度、最长窗口和最小页限制；reserve 仍重检当前授权。兼容仅有单平台 getter 的 store。
2. PostgreSQL fallback 的精确计数和排序只携带 ID 与事件时间，先选出当前页再按主键读取正文、JSON 和发布状态。全部授权、软删除、数据集、发布可见性过滤仍先于分页；同一 SQL 快照，保留精确 total、空页 total、NULL 顺序和微秒游标。精确计数仍要检查匹配集，本次没有取消 total 或声称消除了全量扫描。
3. 同次 ES 请求的发布可见性与搜索 profile 检查复用一次 alias 读取；每个新请求仍重新检查，不缓存跨请求 alias 状态。

本次无 DDL、重建索引、修改已有数据或增加在线采购。12,000 条合成记录的实际 PostgreSQL 执行计划回归中，WindowAgg 行宽由旧查询 1,943 字节降低到不超过 32 字节，完整正文只在分页后读取。这是执行计划与内存负载改善证据，不是生产 p95 延迟承诺。

## Delta 截图的归属

| 现象 | 处理边界 |
| --- | --- |
| Hub Twitter crawl `upstream_pagination_stopped` | 保留已有结果并标记 partial；返回重复 cursor 等原因时停止继续采购，不能伪装全部完成。需要该 crawl 原 request ID 与 stopReason 才能判断具体上游行为，不能拿此前 data/search 样本代替。 |
| Hub username 400 | 当前 Twitter 用户名校验要求 1–15 位字母、数字、下划线；不要自动截短用户名掩盖输入错误。 |
| Hub YouTube crawl 502 | 需要原错误 code / outcome；仅凭 HTTP 502 不能决定重购或切供应方。 |
| `13141/.../youtube/channel-comments` 六次约 180 秒超时 | 请求仍在 Night-All；Delta collector 缺少已定义 YouTube comments 路由入口，单独修复并验证原页幂等恢复。上线需先确认 Hub 专用 comments gateway 修复已发布。 |
| `13141/.../post-comments` 200 + `STANDARD_PAYLOAD_EMPTY` | 不是 Hub 回执；空评论也可能是正常无数据。尚缺原平台、请求、返回结构，不能一律当成供应方失败或自动切到 Hub。 |
| Hub user-info `includeRaw` | 截图明确为历史 Delta 本地校验错误，最新调用成功；不改 Hub 服务端契约。 |
| 模型 503 | 模型调用，与上述数据 API 分别排查。 |

## TG、发布与验证

另一个会话“梳理数据产品接口与搜索策略”的 TG 查询、微秒分页和相关界面改动已经在本地 `577eb91e` 提交中；本次开始时工作树干净，未发现该会话遗留的未提交文件。本次继续优化通用 canonical，不重复修改 TG 专用路径。

测试使用本地离线 store、HTTP fixture 和 PGlite；不会派发生产搜索。存储故障尚未恢复，不能用本地测试通过代替线上验收。部署应待控制平面与磁盘稳定后执行，继续保留 `MX_INSIGHT_SYNC_LAUNCHER=0 MX_SMOKE_DATA=0`；保持 MX-H2I 登录和联网、SSO、支付账务不变。

本次定向回归 74 项：72 通过、2 项因需原生 PostgreSQL 跳过；类型检查通过。另一个 `content-search-aggregate.test.mjs:35` 的微博 refresh 断言在隔离 HEAD `df3f5ad9` 同样失败，属于既有合同/断言不一致，本次未修改。

Delta 评论路由与原页保护修复已应用到 po-infra：9 个文件，132 项离线回归在目标目录再次全部通过，保留两个原有 GetUserInfo 用户文件。线上 Public 已只读确认专用 youtubeCommentsGateway 绑定；这满足代码入口条件，不代表真实评论请求或生产恢复已验收。原页 key、参数、频道/视频范围和预算冻结；异常后只 GET 原回执，旧无身份及活动 Run 不自动重购。Django 专用测试因环境无依赖未执行，修改函数通过离线实函数回归。
