# Night-All-A 清洗任务字段漂移与恢复核对

日期：2026-10-16。范围：用户提供的清洗任务截图、服务器容器发现输出、20:52:23 +08:00 的生产只读诊断结果、`/tmp/night-all-a-live-source.tgz`、`/tmp/night-all-a-website-source.tgz`、`/tmp/night-all-a-organization-web.tgz` 三包运行源码、`/tmp/docx/` 接口资料，以及本地 Night-All-A 与 Hub 源码。第一包 8 个文件的 SHA256 均与生产诊断一致；第三包包含完整 organization-web Python、manifest 和 sources，重叠的 adapter/collector 与前两包一致。新增文件的摘要单独记录于下文。尚未部署修复或执行源库 DDL，不把诊断通过当作线上恢复结果。

平台配置连接的实际数据库为 `100.127.0.6:5432 / agent_data_crawler_platform`，当前仍使用 `public.saved_records` 父表及按 `source_type` 划分的 14 个分区，新增类别已确认是 tender。截图中的 `tag` 错误来自第 24 列与 Hub 旧源合同不兼容；游标索引仅 tender 分区缺失，原 13 类均合格。实际运行源码还确认 writer 自身没有保证跨记录的时间戳与提交顺序一致，不能仅修 schema/index 后确认 writer 合同并恢复无遗漏增量。

## Hub 迁移兼容实施状态

用户进一步要求将兼容落实到上线流程。本地已补齐三层行为，尚未发布或执行生产维护：

1. 保留23列/可选tag兼容及旧断点、身份、mapping v1；组织网站额外保留站点ID、名称、域名、智库/NGO/藏等来源分类、内容范围及版本/日期证据。新闻与首页仍分别属于news/web，目录分类不创建新权限类别。publisher缺省使用site_id/site_name，现有sourceCodes筛选可识别新清洗站点；发布者目录仍需已有精确匹配或后续审核。
2. 部署源索引步骤由原13表扩展到目录中规范的新叶分区，包含tender；管理脚本核对全部已登记crawler连接，复用已有正确索引，拒绝错误/无效同名对象，不自动DROP。源DDL仍是独立psql并发维护，后台发现和Hub SQL migration不执行它。
3. 恢复入口清除failed/abandoned前重新检查schema/index、mapping、旧checkpoint及已存writer确认；失败保留原证据，手动暂停不启用，分类之间隔离。它不能自动证明writer提交顺序已经修复。

本轮不需要新增Hub表或修改已执行SQL migration。`npm run migrate` 单独运行不足以发布运行时代码或补源索引；正常Hub部署需发布Admin/Public/ingest。远端源未配置 `MX_INSIGHT_NIGHT_ALL_DDL_SERVICE` 时源索引步骤会警告跳过，须独立补齐并复核，不能以Hub部署成功推断tender已就绪。

325站当前仍是266新闻站+59首页站，全部有原始来源分类，其中296 configured、29待配。将来只有新增source_type规范叶分区才新增清洗任务；增加站点、标签或topic不会新增任务。每日自动发现可以登记并在已有writer保证有效、schema/index通过时启用新类；手动暂停不被发现覆盖，失败清洗不因migrate自动恢复，新增类别也不自动授予Public权限。

新字段会在新清洗/重新读取时进入canonical并参与内容hash；raw证据与身份保持，历史记录不因migrate自动回填。生产恢复仍需解决源writer ordering并进行有范围的历史对账，不能通过重置checkpoint或勾选旧确认掩盖。

本轮实现验证：清洗/动态类别/路由/新闻接口73项检查通过（含实际PGlite新闻读取）；source-contract与源索引SQL25项通过（17个真实目录语义场景）；部署脚本137项通过，shell语法与diff检查通过。HTTP测试最初因沙箱禁止127.0.0.1监听而失败，放行本地端口后通过，未访问生产。源索引测试在PGlite中移除CONCURRENTLY后创建内存索引，只验证目录/索引定义/前后校验，不证明真实PostgreSQL在线锁时序、psql执行或生产建索引成功。

## 表和版本证据

本地源仓库为 `/Users/qpjoy/workspace/mingxi/Night-All-A/`，核对时工作区干净，HEAD `b6f02c8`，提交时间 2026-10-15 14:31:47 +08:00。

| 对象 | 已核实的内容 | 证据与限制 |
| --- | --- | --- |
| 逻辑父表 | 运行版 ORM `SavedRecord.__tablename__` 仍为 `saved_records` | 导出 `app/models.py:306–332`；不能仅凭当前 OID 证明历史上未替换 |
| 分区迁移 | 0013 按 `source_type` 创建 LIST 分区父表、复制并核对数据，最后替换原表 | `backend/migrations/versions/0013_source_type_partitions.py`；历史上发生过物理重建，但最终业务表名保持 |
| 新标签 | 0022 为原表增加 `tag VARCHAR(128) NULL`，无默认值、无历史回填 | `backend/migrations/versions/0022_collection_tags.py`；同时新增 `(tag,created_at)` 索引，不是增量游标索引 |
| 325 站新闻 | 通用 `save_record_batch` → `SavedRecord` → `saved_records_news` | 运行版 source_types 将 organization-web 默认映射为 news；导出 collector 明确输出新闻/RSS/PDF 引用记录 |
| 首页版本快照 | `homepage_updates` 明确输出 `source_type=web`、`record_type=web.page`，经同一 writer 落入 `saved_records_web` | `homepage_updates.py:49–63`；`source_id` 含站点、最终 URL 和区域内容版本哈希，不是独立的新内容表 |
| 招标 | 实际数据库存在 `saved_records_tender`，分区边界为 `FOR VALUES IN ('tender')` | 生产目录与 Alembic `0027_tender` 已核实；本地 checkout 仍只有 13 类 |

运行版 `record_service.py:215–222` 确认普通记录的 `record_key` 由 `connector_id + NUL + record_type + NUL + source_id` 计算，标签不参与身份；第 311 行仅在创建时使用 `run.tag`，更新白名单不覆盖标签。第 286–290 行对既有 news/news.article/news.resolved 身份直接跳过，因此同一身份的 RSS 摘要后续即使取得全文，也不会经此保存路径自动升级正文、刷新 last_seen_at 或改标签。该结论限定于此 service 路径；标签不应作为租户授权边界。

## 已定位的服务器部署

用户提供的服务器输出确认 Compose 项目为 `data-query-platform`，部署目录为 `/opt/data-query-platform`，当前 platform/runtime 同时使用 `docker-compose.yml` 和 `docker-compose.override.yml`。

| 运行容器 | 镜像标签 | 镜像 ID |
| --- | --- | --- |
| `data-query-platform-platform-1` | `dq-platform:tender-batch2-20261016` | `sha256:5e3857cd84159c30b7bee168b0c287ac16cb545598e166f16b7e9b56e531c2a2` |
| `data-query-platform-runtime-1` | `dq-runtime:tender-batch2-20261016` | `sha256:c419d880ef54749fc27641490cadbe1cf490f0949f9b287f459edbc89ab44d39` |

两个容器均显示 healthy。宿主机 `/opt/data-query-platform/collectors` 挂载到两个容器的 `/app/collectors`；后端代码未显示 bind mount，所以必须核对容器内后端文件，不能以宿主机 Git 提交代表运行代码。用户随后执行 Git 查询得到 `not a git repository`，部署目录没有可用的 Git 元数据。镜像标签是版本线索；招标分区和迁移头已由后续数据库诊断独立确认。

`127.0.0.1:8100` 由 Docker 映射到 platform，`100.127.0.1:8100` 由 Nginx 监听。发现输出不含 Nginx 的实际转发配置，不能仅据此断言代理目标。平台配置目标与实际连接均指向 `100.127.0.6:5432`，不能根据本机存在 `data-query-platform-postgres-1` 而改查该容器。

## 生产只读诊断结果

快照时间为 `2026-10-16T20:52:23.327384+08:00`。PostgreSQL 16.11，实际连接的 `transaction_read_only=on`，Alembic 唯一头为 `0027_tender`。父表 OID 为 `1962432855`，分区方式为 `LIST (source_type)`；14 个直属分区均为普通叶表，目录返回完整。

| 检查 | 结果 |
| --- | --- |
| 父表和全部 14 个分区 | 均 24 列，`tag varchar(128) NULL`；缺列、未知列、类型/可空性不匹配均为空 |
| 原 13 类游标索引 | 13/13 满足精确、唯一、有效、ready/live 的 B-tree `(last_seen_at,id)` |
| `saved_records_tender` | OID `1968997131`，10 个已有索引均有效，但没有任何以 `last_seen_at` 为键的索引，`cursorIndexReady=false` |
| 父表游标索引 | `cursorIndexReady=false` 不属于待修复项；Hub 读取叶表，不能照搬两列唯一索引到分区父表 |

运行容器中 32 个被检查文件与本地对比：0001–0023 的 23 个迁移逐一 SHA256 相同；`source_types.py`、`record_service.py`、`models.py`、`config.py`、organization-web `collector.py` 共 5 个文件不同；0024–0027 共 4 个迁移本地缺失，分别为 website_incremental、website_auth、qixin_once、tender。当前写入模块 SHA256 为 `c6b7a8cb7dc30c163d37171f754f7f5ef28229ba1ccc1fd877c5557128ef3533`。

导出的 0027 迁移第 9 行只增加 `saved_records_tender PARTITION OF saved_records`，另外建立 tender_sites、tender_scans、tender_work 三张控制表（站点、扫描进度、工作队列）。upgrade 未更新、删除、回填或重建原 13 个分区；downgrade 第 36–38 行拒绝删除并要求保留数据及断点。新分区继承父表的 10 个索引，原 13 类各自的额外游标索引不在父表上，所以不会自动继承；0027 也未显式补建它。这解释了唯一缺口。

Hub 已支持动态类别的稳定 source/dataset/platform ID 和独立 writer 合同。无需把 tender 加入初始 13 类静态数组，否则会改变旧 writer digest；本次可选 tag 兼容已覆盖当前 14 类的实际列结构。

本次没有读取业务正文，不能由分区存在推断 325 个站点已全部入库、首页快照已产出或采集覆盖已满足需求。文件特征标记也不足以验证 writer 的提交顺序。

待执行的最小索引维护仅针对 tender 叶表：

```sql
CREATE UNIQUE INDEX CONCURRENTLY saved_records_tender_last_seen_at_id_uidx
ON public.saved_records_tender USING btree (last_seen_at, id);
```

这段语句尚未执行。维护前需再次确认数据库/表身份，并通过 `to_regclass('public.saved_records_tender_last_seen_at_id_uidx')` 检查整个 public schema 是否存在同名对象；当前目录报告只覆盖 saved_records 父子表。不能用 `IF NOT EXISTS` 掩盖同名错误索引，也不能将并发建索引置于事务块。维护后重新运行诊断，确认 tender 的索引有效性，不修改其他 13 类索引或 checkpoint。建索引不会自动解决 writer 合同或恢复任务。

## 截图错误的含义

| 错误 | 原因与检查边界 |
| --- | --- |
| `unexpected crawler column tag requires mapping review` | Hub 原固定合同只允许 23 列，0022 添加的第 24 列触发漂移检查；源端迁移本身无需撤销 |
| `crawler source requires an exact live unique btree (last_seen_at, id) index` | 生产目录已定位到新增 tender 分区确实缺失索引；原 13 类索引均通过，不需要重建 |
| `source_contract_mismatch` | 清洗运行检测到 schema、分区或索引合同不匹配后的失败状态，不是“已经换库”的证据 |

源端 0013 的 PostgreSQL 索引和 0022 标签索引均没有保证 `(last_seen_at,id)` 唯一游标索引。ORM `last_seen_at index=True` 不能替代真实 PostgreSQL 目录核验。Hub 旧 `night-all-saved-records-source-indexes.sql` 只覆盖初始 13 类，本轮已改为目录驱动维护；旧版本曾执行成功不能证明tender已具备索引。

## 本次 Hub 修复边界

为固定 crawler 输入兼容经过源码核实的可选 `tag` 列：旧 23 列继续接受；新增列必须是可空 `varchar`；其他未知列、错误类型或错误可空性继续拒绝。保留原 source key、source/dataset/platform ID、表定位、mapping version、writer 合同和 checkpoint。

批次标签仅保留在受限原始记录证据中，不因通用 mapping 的剩余字段处理进入公开 extensions 或内容主题标签。这不改变上游原始业务记录，也不替历史数据回填标签。

本次没有自动建源索引、更新源端代码、确认 writer、恢复/启用任务、重置 checkpoint、重建 ES 或启动全量向量化。索引修复及生产恢复必须依据下述实际核验结果逐类进行。

## 增量写入保证尚未成立

Hub 当前 writer 合同要求：晚提交事务不能让记录的 `last_seen_at` 落在已消费 checkpoint 后方，相关修改要推进时间，删除要可观察。

运行版 `record_service.py` 第 57–72 行仅按 record_key 获取事务锁；第 306 行调用 Python `utcnow()`，第 316/343 行写 last_seen_at，直到第 520 行才提交。`commit=False` 分支第 522 行只 flush；实际 `persist_run_records` 第 171 行使用该分支，第 175 行确认采集 checkpoint，最后第 193 行提交外层事务。新的网站 checkpoint 与记录处于同一事务有利于采集原子性，但不等于 Hub 的消费水位具备跨事务提交顺序保证。

不同 record_key 可以发生：A 先赋时间 100 后慢提交，B 赋 101 并先提交；Hub 消费到 101 后，A 的 100 才可见。Hub 当前拉取 SQL 使用严格 `(last_seen_at,id) > checkpoint`，因而这种交错会漏读 A。相同 record_key 的锁不能防止不同记录的此类交错。源码证实此 service 自身允许该情况，不代表已经观察到生产丢数据；导出范围之外若存在覆盖所有写入口的全局提交协调，还需独立证据，不能直接勾选确认。

导出路径保持旧身份和来源分区，未见业务硬删除实现，但本批不含全部 API、worker、维护工具或删除触发器，不能据此证明所有入口均满足无硬删除合同。0027 的拒绝 downgrade 只保护该迁移，不等于全系统删除保证。

附件建议至少 5 分钟重叠回读，但未给出最长事务时间或时钟偏差上限，不能等同无遗漏 CDC，也不是当前 Hub 已实现的行为。可靠恢复需要源端提交有序 CDC，或与写事务绑定、按待确认事件消费的变更队列；仅给 outbox 分配自增 ID 后继续按最大 ID 前进，同样不能排除晚提交遗漏。修复后还需对旧 checkpoint 之前的数据做幂等历史对账，不能只向后续跑并宣称历史齐全。原 checkpoint 保留作为证据，不清零代替对账。

## 325 站点：目录、分流与采集状态

补充包两个文件已审阅：`app/website_incremental.py` SHA256 为 `8ed69cb1356aad36d9ebaacbb2f643792d86c09b30767658b2478dcdceeed12b`，organization-web `adapter.py` 为 `d8332f0cd95a3a9f6393a0fffcadc2308b744574ef0a5035e1bb376ec227c886`。它们未在前一份服务器指纹清单中，属于用户后续单独导出的证据。

第三包共 12 个文件：10 个 Python 文件及 manifest/sources。新增核心证据摘要如下：

| 文件 | SHA256 |
| --- | --- |
| `news_incremental.py` | `fc2fd187a1448553d5c54752b2e213b4697a09718b49bf26d34b3bde0dc16d4f` |
| `homepage_updates.py` | `60af35281bc20b52be105c583b78e5968a43dcaf1d7bbcd4d470fdd1cf6db9f6` |
| `manifest.yaml` | `5355a299c98759c881c838c99a401266073cd87cfe84dcac33128f5da927e8f2` |
| `sources.yaml` | `b5c370ffb89d24e8baf5977d34fdd7e31d66daaa46360eef0dec516134eb270a` |

`sources.yaml` 的 325 个站点 ID 与本次 manifest 枚举、此前 `/tmp/docx/capabilities.json` 的 organization-web 枚举完全同集合，无重复 ID。来源标记是 `11111.xlsx` 的 351 行；实际 import_rows 连续覆盖 2–352，299 站对应一行、26 站对应两行，按域名归并为 325 站。

| 路径 | 站点数 | 配置标记 configured | 配置标记 needs_configuration |
| --- | ---: | ---: | ---: |
| 新闻：257 个默认模式 + 9 个显式 news | 266 | 239 | 27 |
| 首页更新 homepage_updates | 59 | 57 | 2 |
| 合计 | 325 | 296 | 29 |

所有 configured 站都有入口；待配站中 26 个入口为空，3 个虽有入口仍标记待配。首页待配两站是 dgap.org、rusi.org。目录没有任何站点配置为 `latest_update`；该算法存在不等于当前 325 站已启用固定 URL 文章版本采集。

原始分类允许重叠：智库 246（231 configured）、NGO 56（55 configured）、藏 49（36 configured）；互斥组合为仅智库 222、仅 NGO 30、智库+NGO 24、仅藏 47、NGO+藏 2。类别成员数 351 不能当作 351 个独立网站。`gmfus.org` 的 original_names 同时包含“德国马歇尔基金会”和“乔治·索罗斯开放社会基金会”（sources.yaml:4686），标记为原始名称归并待核对，不能自动当作合法机构别名。

296 只是目录中的配置状态，不等于当前启用、可访问或每天成功的站点数。sources 没有 enabled/schedule/tag 字段；manifest 声明北京时间 12:00 默认计划，不能证明数据库已有启用计划。目录历史核验日期为 10 月 3–13 日，258 站带正的历史 record_count，也不能相加推算当前库存或 10 月 16 日成功率。

`adapter.py:40–54` 的分流顺序如下；不能将基础 collector 的限制直接套用到另外两条分支。

| 条件 | 调用 | 已确认的参数和边界 |
| --- | --- | --- |
| site.collection_mode=homepage_updates | homepage_updates.collect_homepage | 优先于 incremental；只传 site/browser/run_id/state，未传首次回看天数或新闻条数/页数限制；非增量时 state={} |
| 否则 incremental=true | news_incremental.collect_incremental | 默认 initial_lookback_days=7、max_listing_pages=5、max_results=10、max_pages=2；manifest 允许列表页数1–5、文章数1–50；增量默认关闭 |
| 否则 | collector.collect_site | 普通限量采集；默认10条/2页，complete仅为not issues，不能据此证明全窗口覆盖 |

`0024_website_incremental.py:8–14` 和 `models.py:633–640` 的 website_collection_states 按 plan_target_id 保存断点，是采集进度表，不是新的内容主表，也不是 Hub 清洗 checkpoint。`website_incremental.py:7–19` 读取该计划目标的 checkpoint，但 known_urls/known_versions 查询按 organization-web + attributes.site_id 读取整个站点历史，没有 tag、计划、source_type、时间窗口过滤，也没有 LIMIT/分页。

因此同站不同计划/标签共享已采集 URL 上下文；普通新闻明确跳过 known_urls，首页明确跳过 known_versions。再结合 writer 的 tag 仅首次创建写入、同身份新闻整条跳过，`tag=maidanglao` 不能自动代表“此计划曾遇见的全部记录”。跨计划成员关系若为业务需求，宜单独记录计划/批次与稳定记录的关联，而非简单把 tag 加入 record_key 复制正文。历史越大，去重上下文的查询和传输规模也越大。

### 采集 checkpoint 的接受条件

`confirm_checkpoint` 第21–29行要求 succeeded、save_requested、incremental、字典型 proposal；非空 items 时还要求 auto_persisted 且 created+updated+skipped 不少于返回条数。空结果绕过计数门槛。第30–38行锁已有计划目标状态，以 last_run_id 阻止旧运行覆盖较新状态，然后直接保存 proposal。

它没有独立检查 collection.complete、错误列表、水位单调或未处理 URL 是否保留；第35行注释将部分扫描的正确提案交给 collector。`adapter.py:55–67` 仅将浏览器缺失，或“无记录且有 source_errors”，变成 error；其他“已有部分记录且有错误”仍可返回 success。因此以下边界已经离线验证，不能把其中的“接受 proposal”解释为已证实水位错误前进：

| 输入情况 | 入口行为 |
| --- | --- |
| 空结果、成功、有 proposal | 允许接受 proposal |
| 空结果且有 source_errors | adapter 返回 error |
| 有部分记录并带 resource_limit 等错误 | adapter 可返回 success；保存计数完整时允许接受 proposal |
| 返回2条、只确认保存1条 | 不接受 proposal |
| 全部为既有新闻，保存结果为 skipped | skipped计入完成数，允许接受 proposal |
| organization_browser_required，已有部分结果 | adapter 仍返回 error |
| 旧 run ID | 不覆盖较新状态，但不取消其已保存记录的外层提交 |

验证直接抽取实际函数，替换数据库/collector 为离线 stub，9/9 断言通过；没有连接数据库或网络，不代表实际采集算法或事务并发测试。按 plan_target 的状态锁发生在记录赋时间及 flush 之后，也不提供跨目标的提交顺序，因此不能补上 Hub writer 的 ordering 条款。

### 新闻增量：正确续跑边界与已复现缺陷

`news_incremental.py:54–61,154–158` 已确认：只有没有有效旧 window_start/watermark 才使用首次 7 天回看；有 issues、pending 或 listing_resume 时，保留旧 watermark 和本轮窗口起点。仅全部清空时才推进到本次开始时间。普通条数上限会把剩余候选放入 pending，离线 limit=1 的三条记录连续三轮各取一条后正确完成。因此不能再把“平台允许保存部分 proposal”本身视作水位误推进。

日期只有 YYYY-MM-DD 时按整日比较；无可解析日期时保留候选并标记 date_unknown，不能伪造发布时间。普通新闻按 URL 去重，固定 URL 的新闻正文后续更新不会自动重采；虽有 latest_update 版本分支，当前目录未配置该模式。

使用导出的实际 collector/news_incremental 和内存 HTTP 页面，禁止 socket 连接后，复现以下边界。这些是确定可触发的代码问题，不是生产已经漏了多少条的统计：

| 问题 | 复现结果 | 源码位置与修复方向 |
| --- | --- | --- |
| 续跑页总排在入口之后 | 合法 max_listing_pages=1，连续3轮都重读入口，第二页始终在 listing_resume 中 | news_incremental.py:66–69；让上次续跑页获得有界优先级或轮转，避免入口持续耗尽页数预算 |
| 列表候选静默截断 | HTML和RSS分别放入151个合法候选，四轮均返回50/50/50/0，第三轮起 scan_complete=true，但第151条从未进入 pending | collector.py:180,370 的 `[:150]`；需显式截断证据和可恢复的候选/分页位置，不能仅扩大常数后继续宣称完整 |
| 新出现但发布日期较早的文章被排除 | 首轮12:00完成，次轮新出现11:30发布的URL被截止时间12:00排除，仍判断完成 | news_incremental.py:56,103,129,155–156；分开记录观察时间与源发布时间，配置重叠回看并历史对账；有限重叠不是任意延迟的完整性保证 |
| 连续失败候选饿死后续候选 | 前5篇持续 upstream_unavailable，三轮都停止在它们，后面的正常PDF引用一直得不到处理 | news_incremental.py:96,150–153；保留失败证据并按候选退避/轮转，站点级限流、robots和资源预算仍须尊重 |

`collection.complete` 仅等于 not issues，`no_new_content` 仅等于无记录且无 issues（第160–161行）；两者在仍有 pending/resume 时也可能为 true。运维/UI 应以 checkpoint.scan_complete 和待处理数判断窗口完成，不能用“成功/无新内容”代替覆盖结论。

基础 collector 已实现新闻详情、RSS 正文/摘要/元数据、PDF 链接引用。PDF 仍无下载或 OCR 正文；Hub 应保留 body_status、content_extent 和日期证据，不能把摘要、引用或首页列表宣称为文章全文。当前源码足以完成这轮表路由、目录和采集算法核对；实际启用数、库存、成功率及历史遗漏量属于运行数据，未由本次源码审计确认。

### 首页快照：已验证行为与限制

`homepage_updates.py:45–63` 用指定区域的文本和排序后的链接生成 edition_version，再用站点 ID、规范 URL 和版本生成 source_id。删除导航、脚本等元素后提取列表，不是文章全文；published_at=None、日期精度unknown。两个公开 JSON 首页适配器也是合成区域后保存一条快照，条目日期进入文本，不应拿它充当整条快照的发布时间。

同 URL 新内容会得到新身份；已持久化的 known_versions 会跳过已见版本。A→B→A 的第三次不新增，属于“按内容版本保存”的设计，不代表按每次变化保留完整事件时间线。正常无变化扫描可以推进采集 checkpoint；失败保留旧 watermark。版本记录和 checkpoint 在同一外层事务内保存，仍不解决前述跨事务提交顺序问题。若直接重放同一 web.page 身份，writer 会更新已有行和 last_seen_at；它与新闻同身份直接 skipped 的路径不同。

当前59站均是单入口，未在这一配置下发现阻断版本持久化的确定性错误。另有两个需要明确的配置边界：

- 函数只抓 entrypoints[0]（第74–77行），离线给两个入口时只请求第一个却标完整；当前目录没有这种配置。以后应限制首页只能单入口，或增加逐入口进度，不能直接扩大入口列表。
- 联合 selector 缺少其中一块时，只要其他区域仍达到长度和链接条件，扫描仍成功。离线已复现；当前配置未声明哪些区域必须同时存在，不能将它直接判成生产漏采。若要求逐区域覆盖，应增加区域存在性规则。

### 本轮验证范围

新闻原测试10/10通过，另7个离线场景验证上述正确边界与四类问题（HTML/RSS截断分别验证）；首页原测试17/17通过，另4个行为复现完成。新闻剩余4个成功HTML正文测试依赖未安装的 crawl4ai.markdown_generation_strategy，未运行，没有伪造此依赖或安装新环境。此前平台保存/确认 checkpoint 的9个隔离断言通过。

目标算法均使用解包原文件，未修改。测试的 web_core 来自本地 Night-All-A 的 crawl4ai-web/adapter.py，未证明其与部署 helper 完全相同；所有新增请求页面来自内存，禁用了socket连接和DNS。结论属于离线源码/边界验证，不是线上浏览器、数据库并发或325站验收。新闻复现脚本及含环境/哈希的结果保存在 `/tmp/night-all-news-offline-audit.py`、`/tmp/night-all-news-offline-audit-result.json`。

Hub 本地 tag 兼容及 payload hash 回归已验证：相关清洗/发布/外部接口回归157项通过，路由/类别10项通过，实际PGlite目录审计4项通过；无需因本轮仅更新报告而重复运行。源码修复、源库DDL和线上恢复状态仍应分别记录。

## 只读核对与后续恢复

源表核对工具：[night-all-saved-records-source-audit.sql](../../scripts/night-all-saved-records-source-audit.sql)。在 **Hub 当前源连接所指向的数据库** 执行，避免把 Hub 自身数据库或源平台默认 Compose 数据库当成目标。脚本使用只读事务，只读取 PostgreSQL 目录；不扫描业务正文、不修改表、索引或任务。

服务器初步核对可用单文件 [night-all-a-runtime-audit.py](../../scripts/night-all-a-runtime-audit.py)。将脚本上传至服务器 `/tmp/night-all-a-runtime-audit.py` 后，在 platform 容器运行：

```bash
sudo docker exec -i -e PYTHONDONTWRITEBYTECODE=1 \
  data-query-platform-platform-1 python -B - \
  < /tmp/night-all-a-runtime-audit.py
```

该脚本内嵌上述目录 SQL，使用容器环境的 `PLATFORM_DATABASE_URL` 作为连接候选，只输出非凭据的连接目标、实际数据库身份、目录检查、最多 20 个 Alembic revision，以及固定源码路径的 SHA256/特征标记；不导入应用模块。它不证明运行进程未动态覆盖配置，也不证明 Hub 使用同一连接。`--files-only` 可只检查源码文件而不连接数据库。源码标记和镜像标签不能代替 writer 提交顺序验证。

使用已有只读连接配置运行；`NIGHT_ALL_A_READONLY_DSN` 是执行环境预先配置的连接变量，不要把其值发到聊天或日志：

```bash
psql "$NIGHT_ALL_A_READONLY_DSN" -X -v ON_ERROR_STOP=1 \
  -f scripts/night-all-saved-records-source-audit.sql
```

运行镜像、Alembic revision、第一包 8 个差异源码、第二包 2 个入口文件及第三包完整 organization-web 模块已经核对。已完成本轮代码层分析，无需继续逐文件导出。当前本地 checkout 缺少新迁移且核心文件不同，不能将它直接覆盖上线以恢复清洗。

恢复顺序：

1. 保存当前清洗任务状态、连接身份、checkpoint 和合同摘要；保持旧位置，不用清零重建替代诊断。
2. 核对实际源库的父子表、tag、全部已登记分区和索引；将报告中的分区逐一与 Hub 的 14 类任务对应。
3. 发布 Hub 的 tag 兼容修复；若需要补索引，在已核实目标上由源库独立维护流程完成，保持唯一性和有效性检查。只读清洗账号不执行 DDL。
4. 解决或验证当前 writer 提交顺序与删除保证；新增类别遵循其独立合同。不能以管理员勾选代替证据。
5. 重新探测每类来源及旧 checkpoint 兼容性。确认通过后，用原恢复入口保留位置；原本暂停的任务不擅自启用。
6. 先对选定类别验证小批量续读、幂等和 canonical/outbox，再检查其余类别。只有生产证据齐备后才能宣称清洗已恢复。
7. 325站点业务另外修复上述续跑/截断问题，补齐29站配置，并核验实际启用计划、news/web两类产出和原有历史缺口；这一步的验收不能由“14类清洗成功”替代。

以上范围仅涉及 Hub 数据清洗，不修改 MX-H2I、Launcher 用户登录、SSO、WireGuard、DNS、路由或支付服务。
