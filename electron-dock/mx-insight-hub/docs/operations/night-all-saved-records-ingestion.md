# Night-All-A saved-records ingestion

Status: repository implementation, installed paused and unapproved by default.
Migration `066_night_all_saved_records_sources.sql` registers the fixed inputs;
it does not connect to the source database, read a row, approve a mapping,
activate a task or grant a Public API platform.

## 2026-10-18：标准化字段新增兼容

用户新截图显示14个类别已登记且映射已批准，但源表核对报
`source_contract_mismatch`。本次新增的14列为：`content_kind`、`content_status`、
`fetch_transport`、`has_full_text`、`published_at_precision`、`published_at_status`、
`published_at_utc`、`published_date`、`publisher_name`、`source_key`、`source_name`、
`standardization_warnings`、`storage_schema_version`、`summary`。
旧Hub只接纳原23列和可选的`tag`，所以这些列会使各分区停止读取。

本地Night-All-A checkout仍为2026-10-15的`b6f02c8`，没有这些新列的迁移或模型定义。
用户随后返回Internal源库`agent_data_crawler_platform`的只读目录结果，确认原23列及`tag`
的类型、可空性均未变，父表共38列。新增14列按该回执接纳，类型与可空性必须精确匹配：

| 字段 | PostgreSQL 类型 | 可空 |
| --- | --- | --- |
| `storage_schema_version` | `int4` | 否 |
| `source_key`、`source_name`、`publisher_name`、`summary` | `text` | 是 |
| `content_kind`、`content_status`、`published_at_precision`、`published_at_status`、`fetch_transport` | `varchar` | 是 |
| `has_full_text` | `bool` | 是 |
| `published_at_utc` | `timestamptz` | 是 |
| `published_date` | `date` | 是 |
| `standardization_warnings` | `jsonb` | 是 |

新增列在旧版本源库中可以缺省；一旦存在，仍严格检查类型和可空性，其他未知列继续阻断。
源表检查、运行时每页检查、独立SQL与运行环境审计使用一致的接纳范围，恢复时仍逐类
检查实际叶表、索引、来源身份和checkpoint。父表目录回执本身不代表所有任务已恢复。

上述列和`tag`不自动进入canonical extensions、公开摘要或检索字段；原始记录及raw hash
完整保留，现有已审核映射与canonical内容不变。新元数据单独变化不会改动canonical摘要、
时间、发布者或内容hash。后续使用这些字段应另行审核映射，不能由字段名推断语义。

checkpoint合同哈希不含源列清单，原固定映射与writer摘要也无需因附加列变更。
本次修复保留原映射、断点和既有门禁；不能通过清空checkpoint、重新批准映射或新增writer
确认来绕过当前漂移。原有writer提交顺序问题不因接纳新列而得到证明。

此次代码修复不需要新增Hub migration、源表DDL或重建索引，**发布尚未完成，未取得线上恢复回执**。
本次部署在等待Admin退出时失败；后续回执确认Admin可用且Deployment已处理最新配置。
同步本地部署诊断补丁后，可沿现有Hub部署流程重试一次并保留结果：

```bash
MX_INSIGHT_SYNC_LAUNCHER=0 MX_SMOKE_DATA=0 bash scripts/manage.sh ops internal-production deploy
```

该命令须从Hub目录执行；它是完整Hub发布，仍会执行原有迁移与源索引维护检查，并非
只更新两个进程的无DDL发布。当前脚本没有独立的Admin/ingest发布或跳过源索引维护选项。
ingest有90秒优雅退出窗口并保留持久化分页任务与checkpoint；正在清洗的TG会短暂停顿后
续跑，无需手动暂停、恢复或重置其任务。保持Launcher同步关闭，不更改MX-H2I登录和联网。

发布完成后，在Night-All-A控制页先点“重新核对”；以14类实际结果为准，通过后点一次
“恢复失败任务”，再点“立即同步全部”。原本手动暂停的类别仍保留暂停；其他受阻项应按
具体错误处理。以新游标处理数、错误状态和对应队列任务验证恢复，不以旧“最近运行”时间
或HTTP200单独宣称成功。

本地验证：79项相关检查通过，覆盖实际PGlite目录SQL、14个分区、原23列/含tag/38列
兼容、旧checkpoint分页续读、失败恢复及未知列/类型/可空性拒绝；类型检查和生产构建
通过。上述是本地验证，仍需发布后的任务游标与队列回执确认生产恢复。

### 同日部署受阻：Admin Pod退出等待超时

用户截图显示acquisition-history三个索引已就绪，随后Admin缩容到0，等待
`mx-insight-hub-admin-d6b5db4c7-qzbqv`删除超过120秒。失败发生在启动新migration Job、
Public/Admin更新及ingest更新之前；不能视作本次字段修复已上线。
清理日志中的“restoring”仅说明尝试恢复Admin副本数，不证明Pod已经Ready；新shadow镜像
此前已导入，重建出的Admin也不能直接认定为旧镜像回滚。

后续用户回执确认Admin Deployment的desired/current/ready/available均为1；上述同名Pod
仍为Running且Ready，deletionTimestamp和finalizers均为空，终止宽限30秒，节点为
`mx-internal-server`。因此当前Admin可用，不能把本次超时直接归因为应用卡在退出；
最终副本数为1也可能仅由脚本EXIT恢复产生，尚不能认定有其他控制器回写。
第二份回执显示当前ReplicaSet `mx-insight-hub-admin-d6b5db4c7`的generation/observed均为1，
desired/current/ready均为1；历史10个ReplicaSet均为0副本。Hub没有HPA，查询时未返回Admin
相关事件；事件为空不能证明此前没有发生操作。标签查询未包含Deployment，因为现有清单
只在Pod模板与Service上声明该标签，Deployment自身没有，不能因查询漏行认为其不存在。
后续按名称直接读取确认Deployment generation=observedGeneration=414，desired/current/
ready均为1，未暂停，condition原因是MinimumReplicasAvailable和NewReplicaSetAvailable。
当前状态已收敛，但不能还原失败当时的缩容过程，也未证明此次超时根因已解决。
不再仅靠事后Ready状态反复推断历史；同步下述诊断补丁后，执行一次正常deploy重试。
若再失败，保留恢复副本前的快照，按实际desired/observed/Pod删除状态继续定位；不要连续
盲目重试。标准deploy会重新构建并导入对应源码镜像；apply路径不校验现存shadow镜像与
源码一致，不能仅为节省构建时间就替换成apply。发布成功后仍须核对Night-All-A任务恢复。
不以增加超时或强删Pod代替停止证据。
强制删除API对象不保证节点上的进程已退出，见[Kubernetes Pod终止说明](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#forced-pod-termination)。

本地部署脚本已在Admin停止超时、EXIT恢复之前输出有界元数据（Deployment及最多20个Pod，
每次请求10秒），诊断失败仍保留原始部署失败，且不启动迁移；恢复副本失败会明确告警。
显式`MX_SMOKE_DATA=0`现与Launcher开关一样优先于`.env.internal`，避免一次正常部署重试
被旧配置重新启用业务数据冒烟；未显式设置时仍保留原配置行为。两种情况均有回归覆盖。
完整部署脚本测试、Shell语法及diff检查通过，并经独立复核。这是失败诊断修复，
不是线上缩容故障已解决的证明。本次不调整源字段合同、checkpoint、TG任务、共享存储
或MX-H2I登录/联网配置。

## 2026-10-17：tasiting/maidanglao批次验证

用户确认tasiting已恢复；随后00:34源库及00:39 Hub完整回执确认maidanglao现有news3568/web170在源库、Hub原始层与有效canonical数量一致，缺失/已删/身份不匹配均0。news/web最近导入成功、拒绝0，任务active且游标idle无错误；本次批次入库链路已跑通，tasiting对应数量也保持。源配置为127.0.0.1:5432/agent_data_crawler_platform，无需改远端host、账号或端口。tag仍是原始批次标签、source_type是分类，同库新tag由原news/web任务读取；tender不影响这批数据。当前证据不等同源库全量key/正文逐条校验、325站全部采集或搜索投影完成。源/Hub只读脚本与回执详见[按批次核对](night-all-a-cleaning-schema-drift-2026-10-16.md#2026-10-17按批次核对实际库与清洗结果)。18项本地工具回归通过，会话未操作生产或改MX-H2I。

## 2026-10-16：迁移兼容、组织网站与恢复限制

源端 migration `0022_collection_tags` 在原 `saved_records` 增加可空 `varchar tag`。
Hub 现在兼容原 23 列和额外这一列，其他字段漂移仍阻断；批次标签保留在受限 raw
证据中，不自动公开为 extensions。原 mapping version、身份及 checkpoint 保持不变。
源端当前仍为 saved_records 父表及14个 source_type 分区，新增的是 tender。
完整运行源码已核实，writer 仍不能满足强提交顺序保证，不能直接勾选确认恢复。
见[源码核对、只读诊断及恢复顺序](night-all-a-cleaning-schema-drift-2026-10-16.md)。

本轮兼容不需要新增 Hub 数据库表或改已执行 migration：`npm run migrate` 仍只处理
Hub/mx-common 等原有迁移，不能代替发布新的 Admin/Public/ingest 代码，也不执行源库DDL。
`scripts/manage.sh deploy` 的独立源索引维护步骤现在检查原13类及全部已登记动态任务的连接一致性，
源SQL再按实际目录维护规范叶分区，覆盖 tender 和后续新增类别；后台每日发现仍只读。
远端源库必须配置受控的 `MX_INSIGHT_NIGHT_ALL_DDL_SERVICE` 才会执行该维护步骤；未配置时部署
只警告跳过，不能把部署成功当成源索引已补齐。

325站不是325个清洗类别：266站走 news，59站走 web；同一 source_type 还可包含其他采集器。
站点原始分类“智库/NGO/藏”可重叠，与 source_type 权限、内容主题和 Hub 发布者目录分开。
仅 organization-web 新增白名单 `stableFields.website`：站点ID/名称/域名、来源分类、正文状态/范围、
版本指纹和源日期证据。publisher.code/name 缺省使用站点ID/名称，已有新闻接口的 sourceCodes
可筛选新清洗记录；已审核目录精确别名可沿现有规则绑定，未知站点保持待归类，不自动创建325个目录项。
全文映射full_text、RSS摘要映射summary、首页/PDF/付费墙元数据映射reference，保留精细原状态，
不新增公共枚举或把列表当文章全文。站点标签不进入授权类别或正文topics。

上述元数据改变会在重新摄入时生成相应canonical修订，身份、mapping v1和raw证据算法不变；
旧记录不会因migrate自动补齐。源日期只有date-only且published_at为空时，本轮只保留website日期证据，
不扩大公共新闻日期推断。历史回填应单独采用有范围、可审计的幂等对账，不重置原checkpoint。

恢复失败/遗留运行现在先检查已保存的基础及动态writer合同、固定source身份、原active mapping、
实时schema/index和旧checkpoint，全部通过才保留原position并清失败；单类失败不阻塞其他类。
该操作不新写确认、不自动启用手动暂停任务，也不直接入队。已存确认只证明摘要匹配，
不能证明当前源端提交顺序；本次源端ordering问题仍是生产恢复前的独立阻碍。

### 核对、恢复与人工确认的区别

- “重新核对”只读取各分区的源表、索引和断点状态，不读取复选框、不清除失败标记、不启用任务。已通过源表检查的分区仍可能显示历史运行“需恢复”。
- “恢复失败任务”检查服务器已保存的确认及当前来源，逐类清除符合条件的失败状态，保留原checkpoint和暂停状态。HTTP200可包含部分失败；以每类 `resumed` / `error` 为准。原本启用的任务恢复后可重新进入调度。
- writer复选框只改变本页选择，点击“启用”时才提交人工确认；勾选本身不检查或修复源程序，也不会补写“恢复失败任务”所需的旧确认。只有实际验证写入顺序和删除语义后才能确认。之前已清洗过数据不是这些保证的证据。

本轮UI修复增加“正在核对”、完成时间、通过/受阻/缺失数量及逐类结果；重查中和失败时保留的旧结果明确标为“上次核对”。恢复HTTP200部分失败会显示准确计数、每类错误码和消息，不再统一提示全成功；恢复/同步动作返回值也不再短暂覆盖完整连接与任务配置。此改动不执行恢复、启用、重置或生产配置修改，需发布前端后生效。

验证：33项反馈/UI/恢复逻辑测试通过，Vite构建通过；桌面1440px及窄屏390px使用实际页面和全量mock接口完成浏览器检查，覆盖首次核对、重查、部分缺失、失败保留上次结果、HTTP200部分恢复及延迟刷新期间配置保留。复选框勾选/取消均零请求，未调用生产接口；这些验证不能证明线上任务已经恢复。

### 批量恢复的总锁冲突修复

随后用户截图显示汽车恢复成功，其余13类均因总key `night-all-saved-records` 报 `source_busy`。旧实现通过 `Promise.allSettled` 并发恢复，各项又分别申请同一总任务的非等待锁，导致批次内部互相阻塞。现在按类别顺序执行，每项独立捕获错误；总锁、分区锁和原有门禁检查全部保留。真实运行中的分区仍可报告占锁，一项受阻不会阻止后续类别检查。

修复只清除符合条件的失败状态，保留checkpoint、mapping和手动暂停状态，不提交writer确认、不直接入队。已恢复且仍为idle的汽车项再次恢复会返回无需恢复；active项可照原调度运行。该问题需发布Hub后端，刷新前端或勾选writer无效；本次代码修复不解决此前发现的源writer提交顺序缺口，也不代表线上清洗已恢复。

验证：使用实际 `DatabaseSourcePuller` 进程内互斥路径，修复前精确复现1成功/13总锁冲突，修复后14类（含tender）全部恢复。另覆盖外部总锁、外部分区锁、单类probe失败后继续、解锁重试及重复恢复不写游标；相关恢复/反馈/Store锁/调度/本地mock路由共55项通过。Store锁测试使用模拟PG会话，本轮未运行真实PostgreSQL或生产恢复。

## 2026-09-17：动态类别目录（取代下文固定 13 类的数量假设）

本计划的来源是 **Night-All-A**，控制台显示“Night-All-A 数据清洗任务”。
历史内部 `night-all-saved-records` 路径/source key 保留以兼容既有任务、映射和 checkpoint；
它不表示现在清洗的是历史 Night-All 兼容服务。不得仅凭名称切换源库连接。
下方 13 类是 migration 066 的初始集合，非永久枚举。

- Migration `088_saved_record_discovery.sql` 只增加发现状态表，不重置现有任务或授权。
- Ingest worker 独立发现循环每 24 小时读取 `public.saved_records` 的分区目录，Admin
  “发现新类别”可立即执行 `POST /internal/v1/admin/pipelines/night-all-saved-records/discover`。
  持久化最近成功发现时间，worker 重启不会重复全量发现；API/登录就绪不依赖发现循环。失败保留上次目录和已有任务。
- 最多读取 500 个分区；超过时整次发现失败并明确报错。DEFAULT 叶分区单独执行每日 `DISTINCT source_type`，查询限时 5 秒，
  最多返回 500 个类别；超限/超时明确提示目录不完整，不对整张父表全量扫描。
  多值分区、非叶分区、不规范类别标识和非约定表名均展示为待处理，不自动读取。
- 对规范 `source_type`（小写字母开头，字母/数字/单下划线分词，最长 38 字符（保持 platform 不超过现有 64 字符查询合同））、
  单值 LIST 叶分区 `public.saved_records_<source_type>` 自动原子登记独立 source + v1 mapping。
  登记事务暂存 **paused / unapproved** 与持久化自动启用意图，继承共享连接与周期。随后自动完成字段/分区/索引与 checkpoint 检查，批准固定映射并启用，无需管理员逐类开启；已有任务不变。
- 数据集为 `data-center.saved-records.<source_type>.v1`，授权平台为
  `data_center_saved_records_<source_type>`；这些是下游类别索引，而非物理 ES 索引名。
- 新增类别继承同一源程序已核对的 writer 语义，自动过程以 `system:category-discovery` 保存该类独立合同摘要和启用记录，不冒充人工审核。没有既有 writer 确认时阻断；自动启用核对同样的
  23 个必需列及可选的可空 varchar `tag`、单值分区、唯一 `(last_seen_at,id)` 索引、watermark/提交顺序/删除合同；
  源索引仍由源程序/源库运维准备，发现不会对只读源库执行 DDL。显式部署维护脚本已支持动态规范叶分区。通过检查即自动进入常规增量调度、canonical 入库和 outbox → ES 索引；阻断后下一轮自动重试，也可按“发现新类别”立即重试。人工暂停会取消自动启用意图，后续发现不会擅自重启。这里的writer检查是已存确认版本/摘要检查，不能代替源实现审核。
- 新类别登记会检查现有 grant、活跃未过期 snapshot entitlement 及 dataset/platform 冲突；
  发现占用时显示阻断，不把已有授权静默变成新数据权限。自动启用清洗仍不代表对外授权；公开内容沿原有发布规则并独立授予 Key 权限。
- 普通调度、手动单类/全类同步、进度、恢复、共享配置及 checkpoint 操作均从持久化目录取类别。
  新类别的暂停/失败不改变原有类别；所有数据沿既有 canonical → outbox → ES 流程。

### 下游类别发现

`GET /api/v1/data/platforms`（别名 `/api/v1/data/saved-records/categories`），需有效 Hub API Key，无需 Idempotency-Key，
不计 usage unit，不访问源库。返回所有已知类别（含未授权类别）的中性元数据：

```json
{
  "data": {
    "contractVersion": "mx-insight-hub.saved-record-categories.v1",
    "revision": "<目录及当前授权标记的 SHA-256>",
    "discoveryCheckedAt": "2026-09-17T00:00:00.000Z",
    "scope": "known_categories", "product": "saved_records",
    "items": [{
      "id": "news", "sourceType": "news", "label": "新闻资讯",
      "datasetId": "data-center.saved-records.news.v1",
      "platform": "data_center_saved_records_news", "objectType": "saved_record",
      "registered": true, "authorized": true
    }]
  },
  "requestId": "<请求标识>"
}
```

`registered` 是已安装且符合逻辑合同的任务；`authorized` 是该任务与 Key 当前有效权限的交集。
类别尚未规范映射时 datasetId/platform 为 null，authorized 为 false。目录不返回连接、表名、
provider、source key、凭据、原始数据、checkpoint，也不保证采集完整性或新鲜度。
看到目录不代表获得数据权限；新增 consumer grant 不扩大既有 snapshot Key，移除 grant 即时生效。

专题报告 `sourceScope=selected` 使用目录中 `authorized=true` 的 `platform` 值作为数组，
不再限制 13 项；`all_granted` 在任务创建时固化当时已登记且有效授权的全部类别。
既有报告不因之后目录增加而改变授权范围。stored/canonical search 可复用 platform + datasetId。
公开内容继续受 publication eligibility=candidate 过滤；未审核内容不会因为发现而公开。

控制台 `/docs/saved-record-categories` 和 OpenAPI JSON 已包含接口、字段与调用方式；
专题报告文档链接到目录。Admin 平台授权/租户服务配置也加载动态已登记类别。
部署只需 Hub migration/API/UI/ingest worker，不涉及 Launcher、MX-H2I、VPN、DNS 或用户登录。

## 1. Scope and isolation

Deployment topology confirmed on 2026-10-16: Internal/Hub runs on `100.127.0.6`,
the Night-All-A application runs on `100.127.0.1`, and the separate Night-All HTTP
service runs on Internal port `13141`. The supplied Night-All-A runtime audit's
environment candidate and actual read-only connection both target
`100.127.0.6:5432/agent_data_crawler_platform`. An application host is not its
database host: do not redirect the cleaner to `.1` or to Night-All HTTP based on
these service names. That audit does not independently verify the live application
process or current Hub configuration; deploy still checks its registered source
transport and local PostgreSQL identity.

The initial pipeline reads the 13 LIST leaf partitions below from the existing
`agent_data_crawler_platform` PostgreSQL database. It deliberately does not
pull from the `public.saved_records` parent: each leaf owns an independent
dataset, authorization platform, checkpoint, run history and failure state.

| `source_type` | Physical table | Source key | Dataset | Authorization platform |
| --- | --- | --- | --- | --- |
| `automotive` | `public.saved_records_automotive` | `night-all-saved-records-automotive` | `data-center.saved-records.automotive.v1` | `data_center_saved_records_automotive` |
| `finance` | `public.saved_records_finance` | `night-all-saved-records-finance` | `data-center.saved-records.finance.v1` | `data_center_saved_records_finance` |
| `forum` | `public.saved_records_forum` | `night-all-saved-records-forum` | `data-center.saved-records.forum.v1` | `data_center_saved_records_forum` |
| `hotspot` | `public.saved_records_hotspot` | `night-all-saved-records-hotspot` | `data-center.saved-records.hotspot.v1` | `data_center_saved_records_hotspot` |
| `local_news` | `public.saved_records_local_news` | `night-all-saved-records-local-news` | `data-center.saved-records.local_news.v1` | `data_center_saved_records_local_news` |
| `media` | `public.saved_records_media` | `night-all-saved-records-media` | `data-center.saved-records.media.v1` | `data_center_saved_records_media` |
| `news` | `public.saved_records_news` | `night-all-saved-records-news` | `data-center.saved-records.news.v1` | `data_center_saved_records_news` |
| `other` | `public.saved_records_other` | `night-all-saved-records-other` | `data-center.saved-records.other.v1` | `data_center_saved_records_other` |
| `recruitment` | `public.saved_records_recruitment` | `night-all-saved-records-recruitment` | `data-center.saved-records.recruitment.v1` | `data_center_saved_records_recruitment` |
| `research` | `public.saved_records_research` | `night-all-saved-records-research` | `data-center.saved-records.research.v1` | `data_center_saved_records_research` |
| `social` | `public.saved_records_social` | `night-all-saved-records-social` | `data-center.saved-records.social.v1` | `data_center_saved_records_social` |
| `technology` | `public.saved_records_technology` | `night-all-saved-records-technology` | `data-center.saved-records.technology.v1` | `data_center_saved_records_technology` |
| `web` | `public.saved_records_web` | `night-all-saved-records-web` | `data-center.saved-records.web.v1` | `data_center_saved_records_web` |

All implementation and state are inside MX Insight Hub. The pipeline neither
imports MX Launcher code nor changes Launcher authentication, Domestic/Internal
routing, DNS, WireGuard, Electron plugins or MX-H2I user sessions. A failure or
pause here affects only these 13 Hub ingestion tasks.

## 2. Registration and credentials

The migration stores only the stable source locator:
`schema`, `table`, `cursorColumn=last_seen_at` and `idColumn=id`. It contains no
host, port, database user, password or DSN. Configure one Admin-managed
PostgreSQL connection profile for all 13 tasks after deployment; the profile
owns transport and secrets while each source continues to own its physical
table, dataset, authorization platform and checkpoint.

The Hub source connection is read-only for its whole PostgreSQL session. Index
installation is a separate, explicitly authorized source-database operation
using a DDL-capable operator identity; never give that identity to the Hub
runtime.

## 3. Source index gate

Every leaf needs one valid, ready, non-partial unique B-tree whose exact keys
are `(last_seen_at, id)`. The parent primary key `(source_type, id)` does not
prove the generic keyset puller's total-order contract.

The Internal deploy reads the original 13 plus all registered crawler transport
shapes from the Hub catalog. Once all are configured consistently for
`127.0.0.1:5432/agent_data_crawler_platform`, it runs the versioned script as a
standalone `psql` operation through the host `postgres` peer identity, but only
after matching the Unix-socket postmaster PID to the real IPv4 5432 listener.
No source password is exported from the Hub catalog. A non-local or legacy
`dsnEnv` source uses the root-managed libpq service named by
`MX_INSIGHT_NIGHT_ALL_DDL_SERVICE`. Both paths disable password prompting and
bound connection setup to 10 seconds; partial or inconsistent task transport configuration
is drift and stops deployment rather than being treated as unconfigured.

An independently managed deployment can run the same operation directly,
outside any surrounding transaction:

```sh
cd electron-dock/mx-insight-hub
psql -X "service=night_all_ddl dbname=agent_data_crawler_platform" \
  -f scripts/night-all-saved-records-source-indexes.sql
```

The script requires the original 13 leaves, inventories at most 500 direct
partitions, and includes new canonically named single-value ordinary leaves.
DEFAULT and multi-value partitions are reported but not maintained. It verifies
the parent, leaf binding and non-null cursor types before building only missing
indexes with `CREATE UNIQUE INDEX CONCURRENTLY`. Any already-valid exact index
can be reused, regardless of name. An interrupted build with the exact managed
name, table and cursor definition can be repaired with `REINDEX INDEX CONCURRENTLY`
only when it is invalid but live, a regular index, and not owned by a constraint
or attached to an index partition tree. Repair also requires visibility of all
builders (`pg_read_all_stats` or superuser) and no active builder on that leaf.
Other managed-name conflicts and incomplete cursor indexes with other names
(including failed REINDEX `_ccnew`/`_ccold` remnants) stop maintenance for review.
No explicit DROP or session cancellation is issued. Long source types use bounded
hashed index names. Final checks repeat the safety guards and verify readiness
and unchanged leaf identities. Uniqueness failures are not bypassed.

Catalog checks retain a 2-second lock timeout. Concurrent CREATE/REINDEX uses
`lock_timeout=0` with a **30-minute statement timeout per index operation**, since
waiting for existing transactions is part of concurrent index construction. The
script prints its plan and each generated SQL command before executing it; any
failure stops the deploy and leaves earlier completed operations in place. Do not
run separate manual source DDL alongside this session: its advisory lock only
coordinates other executions of this same script. See PostgreSQL's
[concurrent index rules](https://www.postgresql.org/docs/16/sql-createindex.html)
and [concurrent rebuild recovery](https://www.postgresql.org/docs/16/sql-reindex.html).

For a blocked/failed build, stream the read-only status script into the **same
verified source connection**. Run the following on **Internal `100.127.0.6`**
in the Hub checkout after local-peer identity is verified, not on the Night-All-A
application host `100.127.0.1`:

```sh
sudo -u postgres psql -X -w -p 5432 -d agent_data_crawler_platform \
  -v ON_ERROR_STOP=1 -A -t -q \
  < scripts/night-all-saved-records-index-status.sql
```

It reports catalog flags, index progress, related locks and blocker PIDs, without
business rows, SQL text or connection secrets. It does not repair or cancel
anything. A timed-out builder may already have disappeared, and missing statistics
permissions can hide other sessions, so an empty progress list is not evidence
that the original wait had no blocker. Deploy reaches this source-index step
after Admin/Public rollout and before applying the ingest manifest; failure here
is a partial deploy, not a rollback. Sync the fix and rerun the ordinary deploy;
task recovery still requires the separate writer and checkpoint checks below.

## 4. Mapping and fixed cleaning

Migration 066 seeds mapping version 1 for each source but leaves every mapping
unapproved. The declarative mapping intentionally has a narrow role:

- canonical `externalId` is `record_key`; identity is therefore stable within
  the dataset for one `source_type`, without assuming global cross-type
  uniqueness;
- `record_type`, URL, title and text map to bounded canonical scalar fields;
- `first_seen_at` becomes collection time;
- `raw`, `evidence`, `author`, `metrics`, `media`, `attributes` and other large
  or source-private values are consumed by `_drop`, so they do not spill into
  canonical extensions or the public Elasticsearch projection;
- `_drop` does not delete source evidence: the exact source row remains in the
  restricted raw-ingestion lineage;
- `published_at` is not interpreted by the generic mapper. The fixed cleaner
  parses supported explicit offsets deterministically, interprets supported
  naive date-times as `Asia/Shanghai`, preserves source precision and error
  evidence, and does not invent a midnight instant for a date-only value.

The fixed cleaner also keeps collector and publisher separate. It classifies
both only against one active PostgreSQL source-catalog snapshot, records the
catalog entry ID/revision in `stable_fields.sourceCatalog`, and leaves unknown
or ambiguous values unresolved. It never infers a provider from a title.
After migration 066, the Internal deploy automatically streams the Hub-side
online index script into the shared Hub database before Public rollout. An
independently managed deployment can run the same operation directly (not
against the source database and not inside a transaction):

```sh
cd electron-dock/mx-insight-hub
psql -X "$DATABASE_URL" \
  -f scripts/night-all-saved-records-hub-indexes.sql
```

It contract-checks and builds four one-key expression indexes for the
independently planned source-catalog match paths:

- `stable_fields #>> '{sourceCatalog,publisher,entryId}'`;
- `stable_fields #>> '{sourceCatalog,collector,entryId}'`;
- `stable_fields #>> '{commerce,marketplace,entryId}'`;
- `lower(btrim(normalize(platform, NFKC)))`.

The three entry-ID indexes include soft-deleted records because catalog
governance reports both active and deleted counts. The related-data query uses
four `UNION` arms so one match path cannot make PostgreSQL discard the other
indexes and scan the entire canonical table. These Hub-local indexes are
distinct from the 13 source-database cursor indexes above.

## 5. Identity, cursor, writer and delete contract

Activation requires a human attestation of all of the following for every leaf:

1. The source keeps its reviewed declarations: only `run_id`, `source_family`,
   `collection_mode`, `published_at` and `raw` may be nullable; the other 18
   fixed columns are non-null. The optional `tag` column, when present, must be
   nullable `varchar`. `id` is immutable and never reused within that
   fixed leaf/dataset lifetime. `record_key` is the stable canonical source
   identity.
2. Each leaf contains only its declared `source_type`. Rebinding, replacing,
   truncating or restoring a table cannot silently continue the old checkpoint.
3. `last_seen_at` is a finite PostgreSQL timestamp. Every insert and every
   material update—including content, quality, metadata and a visible removal
   state—sets it to a value strictly suitable for the ordered cursor.
4. Commit ordering cannot expose a later transaction at or behind a
   `(last_seen_at, id)` checkpoint already acknowledged by Hub. If the writer
   cannot guarantee that property, use an ordered change journal or CDC before
   activation.
5. The source does not hard-delete rows already visible to Hub. A disappearing
   row is not a tombstone and is never inferred as deletion. Use a watermarked
   soft-delete/change event, CDC, or a separately reviewed reconciliation
   design.
6. The exact unique cursor index from section 3 remains valid and ready.

Each leaf has its own durable checkpoint. One leaf's schema drift, malformed
cursor or failed run must fail that task closed without resetting or blocking
the other 12. A checkpoint reset is a reviewed full-rescan action, not a repair
for an invalid writer contract.

The activation probe is not the runtime trust boundary. Every manual or
scheduled database page pull reloads this evidence from the source and fails
with `source_contract_mismatch` before canonical ingest when any item differs:

- the persisted source still has the fixed dataset, platform, object type and
  leaf locator;
- the leaf has the reviewed 23 columns and nullability, optionally plus the
  reviewed nullable `varchar tag`; every other extra column is rejected. The
  PostgreSQL types are exact: `id`/`run_id` are `int4`; source descriptors and
  `published_at` use their reviewed `varchar` fields; `source_url` and `text`
  are `text`; evidence/author/metrics/media/attributes/raw are `jsonb`; and the
  three seen/created timestamps are `timestamptz`;
- the relation is an ordinary leaf directly under
  `public.saved_records`, whose key remains `LIST (source_type)`, and its bound
  is the one fixed value for that task;
- a valid, ready and live unique B-tree remains on exactly
  `(last_seen_at, id)`, with no expression, predicate, included column or
  non-default ordering;
- every returned row's `source_type` equals the leaf value.

A saved checkpoint containing `infinity` or `-infinity` is rejected before a
source connection opens. After the exact unique B-tree passes, every real pull
also reads the first and last `(last_seen_at, id)` endpoints through that index;
this catches both infinities in logarithmic index probes, including a newly
inserted `-infinity` row that sorts behind an already advanced checkpoint. The
exact `last_seen_at::text` values returned by a page are checked before an
import run starts, and committed-batch replay evidence is checked again before
acknowledgement. Therefore neither source rows nor retry evidence can advance a
Night-All checkpoint to a non-finite watermark. These checks are scoped by the
exact Night-All source-key set; generic database, Telegram, province-opinion
and mobile-commerce pulls retain their existing contracts.

The activation `describe` probe derives the same strict partition and index
issues from its existing catalog metadata query, and the progress view applies
the same source, column and physical checks before counting. Progress also
counts non-finite watermarks and mismatched `source_type` values in its one
aggregate query, returning a blocked result instead of a plausible percentage
when either is present.

## 6. Public-authorization preflight

Migration 066 aborts before registering a source when any of the 13 reserved
platforms already has a consumer grant, or when an active, unexpired snapshot
key retains a latent entitlement for one. This prevents a grandfathered
`legacy_dynamic` key from inheriting a newly reserved corpus and prevents a
later grant from silently reactivating an old snapshot scope.
The migration runner executes the file in one transaction and takes bounded
`SHARE` locks on the grant and entitlement tables, so an Admin write cannot
cross the probe/commit boundary. A busy writer makes the migration fail on its
lock timeout; drain that writer and retry rather than bypassing the gate.

Run this read-only report before migration. Any nonzero count requires an
explicit grant/key audit and remediation; do not weaken or remove the migration
gate:

```sql
WITH reserved(platform) AS (
  SELECT unnest(ARRAY[
    'data_center_saved_records_automotive',
    'data_center_saved_records_finance',
    'data_center_saved_records_forum',
    'data_center_saved_records_hotspot',
    'data_center_saved_records_local_news',
    'data_center_saved_records_media',
    'data_center_saved_records_news',
    'data_center_saved_records_other',
    'data_center_saved_records_recruitment',
    'data_center_saved_records_research',
    'data_center_saved_records_social',
    'data_center_saved_records_technology',
    'data_center_saved_records_web'
  ]::text[])
), scope_counts AS (
  SELECT 'platform_grant'::text AS scope_kind, count(*) AS row_count
    FROM platform_grants grant_record
    JOIN reserved
      ON lower(btrim(normalize(grant_record.platform, NFKC))) = reserved.platform
  UNION ALL
  SELECT 'live_snapshot_entitlement', count(*)
    FROM api_key_platform_entitlements entitlement
    JOIN reserved
      ON lower(btrim(normalize(entitlement.platform, NFKC))) = reserved.platform
    JOIN api_keys api_key_record ON api_key_record.id = entitlement.api_key_id
   WHERE api_key_record.scope_mode = 'snapshot'
     AND api_key_record.status = 'active'
     AND api_key_record.expires_at > now()
)
SELECT scope_kind, row_count
  FROM scope_counts
 ORDER BY scope_kind;
```

When either count is nonzero, enumerate currently effective live keys before
changing any grant:

```sql
WITH reserved(platform) AS (
  SELECT unnest(ARRAY[
    'data_center_saved_records_automotive',
    'data_center_saved_records_finance',
    'data_center_saved_records_forum',
    'data_center_saved_records_hotspot',
    'data_center_saved_records_local_news',
    'data_center_saved_records_media',
    'data_center_saved_records_news',
    'data_center_saved_records_other',
    'data_center_saved_records_recruitment',
    'data_center_saved_records_research',
    'data_center_saved_records_social',
    'data_center_saved_records_technology',
    'data_center_saved_records_web'
  ]::text[])
)
SELECT tenant.id AS tenant_id,
       tenant.name AS tenant_name,
       consumer.id AS consumer_id,
       consumer.name AS consumer_name,
       api_key_record.id AS api_key_id,
       api_key_record.name AS api_key_name,
       api_key_record.key_prefix,
       api_key_record.last_four,
       grant_record.platform,
       api_key_record.scope_mode,
       api_key_record.expires_at,
       CASE api_key_record.scope_mode
         WHEN 'legacy_dynamic' THEN 'legacy_dynamic_inherited'
         ELSE 'snapshot_entitled'
       END AS entitlement_path
  FROM platform_grants grant_record
  JOIN reserved
    ON lower(btrim(normalize(grant_record.platform, NFKC))) = reserved.platform
  JOIN api_keys api_key_record
    ON api_key_record.consumer_id = grant_record.consumer_id
  JOIN consumers consumer
    ON consumer.id = api_key_record.consumer_id
   AND consumer.status = 'active'
  JOIN tenants tenant
    ON tenant.id = api_key_record.tenant_id
   AND tenant.status = 'active'
  LEFT JOIN api_key_platform_entitlements entitlement
    ON entitlement.api_key_id = api_key_record.id
   AND entitlement.platform = grant_record.platform
 WHERE api_key_record.status = 'active'
   AND api_key_record.expires_at > now()
   AND (
     api_key_record.scope_mode = 'legacy_dynamic'
     OR (
       api_key_record.scope_mode = 'snapshot'
       AND entitlement.api_key_id IS NOT NULL
     )
   )
 ORDER BY grant_record.platform, tenant.name, consumer.name, api_key_record.name;
```

The effective-key report starts from an existing grant and intentionally shows
only authority that works now. Independently enumerate every snapshot blocker
below, including suspended owners and entitlements with or without an exact or
normalized-equivalent consumer grant:

```sql
SELECT tenant.id AS tenant_id,
       tenant.name AS tenant_name,
       tenant.status AS tenant_status,
       consumer.id AS consumer_id,
       consumer.name AS consumer_name,
       consumer.status AS consumer_status,
       api_key_record.id AS api_key_id,
       api_key_record.name AS api_key_name,
       entitlement.platform,
       api_key_record.expires_at,
       EXISTS (
         SELECT 1
           FROM platform_grants exact_grant
          WHERE exact_grant.consumer_id = api_key_record.consumer_id
            AND exact_grant.platform = entitlement.platform
       ) AS has_exact_consumer_grant,
       EXISTS (
         SELECT 1
           FROM platform_grants normalized_grant
          WHERE normalized_grant.consumer_id = api_key_record.consumer_id
            AND lower(btrim(normalize(normalized_grant.platform, NFKC)))
                = lower(btrim(normalize(entitlement.platform, NFKC)))
       ) AS has_normalized_consumer_grant,
       CASE
         WHEN EXISTS (
           SELECT 1
             FROM platform_grants exact_grant
            WHERE exact_grant.consumer_id = api_key_record.consumer_id
              AND exact_grant.platform = entitlement.platform
         ) THEN 'snapshot_with_exact_consumer_grant'
         WHEN EXISTS (
           SELECT 1
             FROM platform_grants normalized_grant
            WHERE normalized_grant.consumer_id = api_key_record.consumer_id
              AND lower(btrim(normalize(normalized_grant.platform, NFKC)))
                  = lower(btrim(normalize(entitlement.platform, NFKC)))
         ) THEN 'snapshot_with_normalized_consumer_grant'
         ELSE 'latent_snapshot_without_consumer_grant'
       END AS entitlement_path
  FROM api_key_platform_entitlements entitlement
  JOIN api_keys api_key_record ON api_key_record.id = entitlement.api_key_id
  JOIN consumers consumer
    ON consumer.id = api_key_record.consumer_id
  JOIN tenants tenant
    ON tenant.id = api_key_record.tenant_id
 WHERE lower(btrim(normalize(entitlement.platform, NFKC)))
       ~ '^data_center_saved_records_(automotive|finance|forum|hotspot|local_news|media|news|other|recruitment|research|social|technology|web)$'
   AND api_key_record.scope_mode = 'snapshot'
   AND api_key_record.status = 'active'
   AND api_key_record.expires_at > now()
 ORDER BY entitlement.platform, tenant.name, consumer.name, api_key_record.name;
```

Neither this latent report nor the target-consumer report below filters tenant
or consumer status. The status columns are diagnostic: an active, unexpired
snapshot key remains a migration-066 blocker even when its owner is suspended.

Before any future crawler platform grant, use the following report instead of
the grant-based query above. Replace both values in `target`; it deliberately
does not depend on a grant already existing:

```sql
WITH target(consumer_id, platform) AS (
  VALUES (
    '00000000-0000-4000-8000-000000000000'::uuid,
    'data_center_saved_records_news'::text
  )
)
SELECT tenant.id AS tenant_id,
       tenant.status AS tenant_status,
       consumer.id AS consumer_id,
       consumer.name AS consumer_name,
       consumer.status AS consumer_status,
       api_key_record.id AS api_key_id,
       api_key_record.name AS api_key_name,
       api_key_record.key_prefix,
       api_key_record.last_four,
       target.platform AS proposed_platform,
       api_key_record.scope_mode,
       api_key_record.expires_at,
       CASE
         WHEN api_key_record.scope_mode = 'legacy_dynamic'
           THEN 'would_inherit_new_grant'
         WHEN EXISTS (
           SELECT 1
             FROM api_key_platform_entitlements entitlement
            WHERE entitlement.api_key_id = api_key_record.id
              AND lower(btrim(normalize(entitlement.platform, NFKC)))
                  = target.platform
         ) THEN 'snapshot_entitled_if_granted'
         ELSE 'snapshot_not_entitled'
       END AS proposed_effect
  FROM target
  JOIN consumers consumer ON consumer.id = target.consumer_id
  JOIN tenants tenant
    ON tenant.id = consumer.tenant_id
  JOIN api_keys api_key_record
    ON api_key_record.consumer_id = consumer.id
 WHERE api_key_record.status = 'active'
   AND api_key_record.expires_at > now()
 ORDER BY api_key_record.name, api_key_record.id;
```

Adding a consumer grant immediately widens every row marked
`would_inherit_new_grant`. Prefer rotating those keys to an explicitly selected
snapshot scope, and explicitly review any `snapshot_entitled_if_granted` row,
before granting the new data product.

## 7. Activation and publication gates

Keep every task paused until this sequence is complete:

1. run the Internal deploy, which applies Hub migration 066 and the four Hub
   indexes, and verify exactly 13 sources are `paused`, exactly
   13 version-1 mappings have no `approved_at`, every source has no connection
   profile yet, and both authorization preflight counts remain zero;
2. configure the shared read-only PostgreSQL connection without changing the
   fixed locators;
3. rerun deploy so it reconciles the 13 source indexes, then use **重新核对** to
   preserve the ready result as rollout evidence;
4. probe all leaves and review exact columns, nullability, types, constraints,
   source-type membership, `record_type` distributions and representative JSON
   shapes;
5. review the fixed published-time and source-catalog classifications;
6. accept the writer/delete/commit-order attestation, then approve only the
   fixed version-1 mappings and activate the selected tasks;
7. run a bounded first import, compare source/canonical counts and rejection
   evidence, then allow scheduled increments;
8. before any Public API grant, rerun the authorization counts and the
   target-consumer key report above, run a strict full `content-v6` rebuild from
   PostgreSQL current truth, switch the content aliases only after that build
   succeeds, and compare the PostgreSQL and Elasticsearch publication gates.

Deploy never accepts the writer/delete/commit-order attestation, activates a
task, schedules a pull, grants a Public capability, or starts an Elasticsearch
full rebuild. Those remain explicit Admin UI decisions. If the persistent
**projector 重启时自动全量重建** setting is still enabled, deploy idempotently
turns it off before building/importing the image and verifies it again before
the projector rollout. The change is logged; deploy does not start, cancel or
wait for a full replay. A strict rebuild must still be started separately by an
operator in Data Center.

Immediately after migration 066, this read-only acceptance query must return
`13, 13, 13, 13, 13` in column order:

```sql
WITH fixed_sources AS (
  SELECT id, status, database_connection_id
    FROM catalog.external_sources
   WHERE source_key ~ '^night-all-saved-records-(automotive|finance|forum|hotspot|local-news|media|news|other|recruitment|research|social|technology|web)$'
)
SELECT count(*) AS source_count,
       count(*) FILTER (WHERE status = 'paused') AS paused_count,
       count(*) FILTER (WHERE database_connection_id IS NULL) AS no_profile_count,
       (
         SELECT count(*)
           FROM catalog.source_mappings mapping
           JOIN fixed_sources source ON source.id = mapping.source_id
          WHERE mapping.version = 1
       ) AS mapping_count,
       (
         SELECT count(*)
           FROM catalog.source_mappings mapping
           JOIN fixed_sources source ON source.id = mapping.source_id
          WHERE mapping.version = 1
            AND mapping.approved_at IS NULL
       ) AS unapproved_count
  FROM fixed_sources;
```

Public delivery needs a separate decision. Existing
`POST /api/v1/data/stored/search` and
`POST /api/v1/data/canonical/search` are the reusable stored-data interfaces;
no Night-All-specific public endpoint is required. Each `source_type` has a
unique platform precisely so an API key may be granted one reviewed class
without receiving all 13. These Public API dataset and platform identifiers
are provider-neutral; `Night-All-A` is the internal source/pipeline display name; legacy `night-all-*`
identifiers remain for compatibility. Migration 066 creates no grant.

The fixed cleaner marks a row as a publication candidate only when
`record_type IN ('news', 'news.article')` and at least one canonical title or
body is nonempty after trimming. A URL alone is not publishable;
empty-content rows and other observed types—including account checks, feed
responses and operational result records—remain `internal`. The cleaner writes
that decision to
`stable_fields.crawler.publication.eligibility` (camel-case API form:
`stableFields.crawler.publication.eligibility`).

Both public stored search and public canonical search enforce the same rule:
for every `data_center_saved_records_*` platform, only records whose eligibility
is exactly `candidate` may be returned. The predicate is applied in both the
PostgreSQL page/count path and the Elasticsearch `content-v6` path. A mixed
platform query applies it only to the `data_center_saved_records_*` crawler branches;
visibility for all other platforms is unchanged. Admin and other internal
searches do not inherit this public filter.

Candidate is not approval: do not issue a public key for any
`data_center_saved_records_*` platform until the record-type review, the strict
full `content-v6` rebuild and the PostgreSQL/Elasticsearch serving comparison
are complete. During a rollout, an un-cursored request that still encounters a
`content-v5` index falls back to PostgreSQL; a cursor tied to an old v5 PIT is
rejected with `503 search_cursor_unavailable` instead of continuing against an
index without the crawler visibility field. That fallback is a deployment
safety measure, not permission to serve crawler data indefinitely from v5.
Restricted raw/evidence and internal connector/provider identity remain
unavailable through public stored search.

## 8. Pause and recovery

Pause before changing a connection profile, table binding, mapping, writer
semantics or checkpoint. Let in-flight jobs reach their durable boundary before
repair. Resume from the existing leaf checkpoint after correcting a transient
failure; reset only when an explicitly reviewed full alignment is intended.
Pausing or repairing this pipeline does not require restarting Launcher,
changing MX-H2I networking or modifying Domestic/Internal services.
