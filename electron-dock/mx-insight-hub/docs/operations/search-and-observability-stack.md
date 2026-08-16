# Elasticsearch、HanLP、Kibana 与日志组件

状态：Hub content/chunk current-state projector 与 PG 降级查询已实现；仓库中的
`deploy/compose/search` 仍只是本机/受控开发样板，不代表生产批准。

## 1. 结论

- Elasticsearch：用于客户安全数据的可重建全文/geo/facet 投影，也可承载独立日志 data stream；不是唯一事实库。
- HanLP：作为独立 enrichment service/worker；不把旧的第三方 ES plugin 放进生产集群。
- Kibana：对内部工程、数据质量、索引排障有用；不作为客户 BI，也不公开 5601。
- Filebeat/Elastic Agent：仅用于 tail 主机/容器日志。不能解析 `/shared_dir` 的 XLSX/ZIP/DOCX 业务数据。
- Logstash：首期不用于业务 ETL。规范化、租户策略、血缘和 checkpoint 必须由 Hub ingest worker 完成。

## 2. 旧 standalone 配置的处理

旧 `de-mingxi/elk` standalone 以 Elasticsearch/Kibana/Logstash/Filebeat 8.13.4 为一组，healthcheck、ILM、snapshot repository 和 bootstrap 思路可以保留。以下内容不能原样迁移：

- `xpack.security.enabled=false` 加宿主所有地址端口暴露；
- OPC 专用 index template、sample logs 和 dashboard；
- Filebeat → Logstash 作为业务文件导入路径；
- 单节点/零副本被误称为高可用或备份；
- 固定旧版本直接成为 2026 生产版本，或未经 Upgrade Assistant/快照跨大版本升级。

新的本地样板只绑定 `127.0.0.1`，ES/Kibana 使用同一个 `ELASTIC_VERSION`，并且与 Hub 默认 Compose 分开启动。生产必须启用认证/TLS、独立 Secret、持久卷、snapshot、资源预算和网络策略。

## 3. 本地样板

```bash
cd electron-dock/mx-insight-hub
cp deploy/compose/search/.env.example deploy/compose/search/.env
bash scripts/manage.sh search plan
bash scripts/manage.sh search up
bash scripts/manage.sh search status
```

默认端口：

- Elasticsearch `127.0.0.1:19200`
- Kibana `127.0.0.1:15601`

停止：

```bash
bash scripts/manage.sh search down
```

`down` 保留 named volumes。删除 volume 不是普通生命周期操作，也不写进一键命令。

样板安装：

- `mx-insight-content-v1` mapping template；
- `mx-insight-logs-policy` 和日志 data-stream template；
- 本地 fs snapshot repository。

Compose bootstrap 本身不搬业务数据；当前 projector 启动后会 reconcile
content 与（配置 embedding dimensions 时）chunk 的唯一 `*-current` 索引，
从 PostgreSQL 扫描 current truth、原子切 alias，再异步排空 outbox/delete queue。
启动 reconcile 使用严格 tokenizer provenance；若 ES、HanLP 或 mapping 校验失败，
projector 以非零状态退出，由 Deployment restart/backoff 重新执行整个 reconcile，
不会错误进入一个只重试 outbox、却永远不再尝试 schema/alias 迁移的循环。

## 4. HanLP 集成

Elastic classic plugin 会校验精确 ES 版本。现有社区 `elasticsearch-analysis-hanlp` 的公开兼容范围停留在旧 7.x 系列，不能直接装进旧 ES 8.13.4 或当前 9.x。

目标 enrichment contract 如下；当前服务只装载固定的 coarse tokenizer，只有在
第二套模型真实部署并带版本后才允许填充 `tokensFine`：

```json
{
  "model": "hanlp2",
  "modelVersion": "pinned-model-digest",
  "language": "zh",
  "tokensFine": ["..."],
  "tokensCoarse": ["..."],
  "entities": [{"text": "...", "type": "...", "start": 0, "end": 2}],
  "keywords": ["..."],
  "processedAt": "2026-08-04T00:00:00Z"
}
```

索引时把 tokens 保存为独立预分词字段；查询时用同模型生成 query tokens。现有
`*Hanlp` 是历史命名的 pre-segmented 字段：HanLP 是配置了服务时的主后端，但常驻
streaming projector 为了不阻断 outbox，在请求失败时仍可能写入 Jieba/bigram
fallback，且当前文档没有持久化逐字段 model digest。严格启动 reconcile 与
`reindex-search` 会拒绝这种降级结果，因此可保证一次完整基线重建的后端一致性；
若要让后续增量也具有可证明的 HanLP provenance，下一 schema 必须把 HanLP、
fallback/pending 拆成独立字段并保存模型 digest，而不是只依赖字段名。模型升级创建
新 enrichment version，通过 shadow reindex/A-B relevance 验证后再切 alias。

### 4.1 相关性语义与重建分词投影

长中文查询后排出现“只命中一个字”的记录，根因不是 PostgreSQL
`pg_trgm`，而是 ES 原文的标准 analyzer 与 CJK unigram/bigram 回退分词在
OR 查询下放大了单字共现。正文检索现默认使用“原文 phrase 命中”
或“预分词 token 全部命中”；作者、会话与 chunk 的词法分支也不再以单字
命中作为宽松召回条件。

已经以旧分词器发布的 current-state 投影可从 PostgreSQL canonical truth
重建：

```bash
cd electron-dock/mx-insight-hub
bash scripts/manage.sh reindex-search
# 等价的显式命令：
bash scripts/manage.sh ops internal-production reindex-search
```

该命令要求 projector 正好一个副本，并在现有 projector Pod 内执行一次性
strict reconciler；不会 rollout 或重启常驻 projector。任务先验证当前部署
要求的 HanLP/jieba 后端（显式 fallback 配置则为 bigram），随后每个待索引
字段都校验实际分词 provenance。短暂错误每字段最多尝试 3 次（两次有界退避
重试）；仍然得到 fallback、degraded 输出或 mapping
冲突时，命令以非零状态退出且不会把该批伪报为成功。此前已经写入的、通过
校验的批次仍是安全的，可在后端恢复后重跑。

reconciler 从 PostgreSQL current truth 重放 content 与 chunk；只有需要新建
投影时才原子切换 alias，既有 current index 允许同 source revision 覆盖旧
分词字段。该操作不重启 Public/Admin API、ingest、Launcher、MX-H2I 登录
或联网链路。执行前仍应在低峰期确认 ES 磁盘和 PG 读取余量。

### 4.2 content v4 与搜索 profile 变更手册

仓库最新 mapping 声明 content v4；任何仍由 content v3 alias 服务的环境都必须
完成本节的 schema-versioned 迁移后才算升级。v3 已有 raw `standard` 与 HanLP
coarse 预分词字段，姓名/username 另有 prefix、CJK bigram 和 identifier
substring；v4 新增 `title.cjk`、`body.cjk` 和 `title.prefix`。它的目标是让
相关性实验优先成为查询变更，而不是每次都改 mapping。

服务端 profile registry 只接受以下不可变、带版本的 allowlist：

| Profile | 默认/权限 | 查询分支 |
| --- | --- | --- |
| `canonical.balanced.v1` | Public/Admin 默认 | raw phrase 或 HanLP coarse terms-all；等价于当前严格基线 |
| `canonical.phrase.v1` | Public/Admin | raw phrase only |
| `canonical.terms-all.v1` | Public/Admin | coarse query tokens 全部命中预分词字段 |
| `canonical.zh-recall.v1` | Public/Admin，content v4 | phrase + terms-all + 低权重、有序 CJK bigram phrase；禁止单字 OR |
| `canonical.title-prefix.v1` | Public/Admin，content v4 | 标题及已有名称/handle/username edge-prefix；查询侧不生成 ngram |
| `canonical.cjk-bigram.v1` | Admin Search Lab | 单独观察 bigram tokens/排名 |
| `canonical.legacy-or.v1` | Admin Search Lab | 只用于和旧 OR 行为比较，禁止设为公共默认 |

`canonical.balanced.v1` 的查询路径没有绕开分词服务：无游标的第一页先调用当前
配置的 segmenter；仅当结果未降级时，才把 tokens 作为空格分隔文本，对
`*Hanlp` 字段执行 terms-all `AND`，并与 raw phrase 分支取并集。若 HanLP 请求
降级成 Jieba/bigram，execution metadata 原样报告
`backendUsed=hanlp|jieba|bigram`、`degraded` 和有界 `errorCode`，同时把实际策略切到
`canonical.phrase.v1`；fallback tokens 不会误查 HanLP postings。签名游标保存首屏
的 applied profile、tokens、backend 与降级状态，后续页直接复用，避免同一 PIT
因 HanLP busy 改变 query 与 `_score` 排序。CJK bigram 仅在 HanLP 健康时由
`canonical.zh-recall.v1` 以低权重、有序 phrase 方式补充，默认 balanced 不使用它。

Public API 只能选择受支持的 profile 名；不得接收任意 analyzer 名、字段、boost、
index、Query DSL、script 或 Elasticsearch `profile`/`_explain` 请求。Data Center
的 Admin Search Lab 可展示每个 profile 的只读索引表示/query plan、本次 query
tokens、实际 backend/degraded/errorCode、named query 命中分支、highlight 和
有界样例。当前没有可诚实展示的逐文档 HanLP model digest 或 profile 间 rank
delta；这些能力要在相应 provenance/evaluation 后端落地后再开放。完整
`_explanation` 仅限单条、小样本诊断，不进入普通分页响应。修改逻辑默认值必须有权限、审计和 optimistic revision；默认值
解析到 immutable profile 后写入游标绑定与幂等指纹，避免翻页期间排名语义漂移。

IK `max_word` index / `smart` search 的职责分离在 MX 中对应为“索引多个独立、
有界的词项视图，查询 profile 选较窄组合”：raw、HanLP coarse 和 CJK bigram
不能混成一个字段。当前 HanLP 的 `coarse` 请求参数不是可动态切换模型的证明；
增加 fine 模式前必须先部署真实模型、固定 digest、保存 provenance，并单独迁移。

变更是否需要重建按下面的边界判断：

| 变更 | 是否重建 | 操作 |
| --- | --- | --- |
| phrase/slop、AND/MSM、boost、filter、rescore、已有字段组合 | 否 | 发布新的 immutable profile，先在 Search Lab 对比 |
| 选择索引中已存在且与 postings 兼容的 search analyzer | 否 | 在 profile 内选择；不要修改调用者可传的任意 analyzer |
| 修改既有字段的 index analyzer 或 HanLP 模型/词典 | 是 | bump content schema，从 PG blue/green 全量重建 |
| 新增 CJK、edge-ngram、delimiter、html-strip、stem 等 multi-field | 是 | mapping 即使可原位新增，历史文档也不会自动有 postings；按新 schema 重建 |
| 只更新 field 的默认 `search_analyzer` | 文档无需重建 | 仍优先新增 profile；避免 close/reopen 或 alias 下 analyzer 不一致 |

content v4 发布时，先让代码声明新的 `mx-insight-hub-content-v4-current`，再执行
本节 4.1 的严格命令。strict reconciler 使用部署所要求的同一 tokenizer 对 PG
current truth 做第一遍扫描；只有完整成功后才把 read/兼容 write aliases 从 v3
原子切到 v4，然后做第二遍扫描关闭并发写窗口。不要在 v3 原位修改 analyzer，
也不要把只覆盖新写入的 multi-field 当作迁移完成。mapping conflict、HanLP busy/
timeout、意外 jieba/bigram fallback 或 degraded provenance 都必须让命令非零退出；
旧 v3 索引保留到 count/hash、代表性查询、磁盘和延迟验收完成，供 alias 回滚。

附件中的 analyzer 只能作为实验素材，不能直接复制到正文：

- `word_delimiter_graph` 面向 handle、产品号、文件名等 identifier，并使用
  `keyword`/`whitespace` tokenizer；`standard + word_delimiter` 会在 delimiter
  前丢失标点，`catenate_all`/`preserve_original` 还需验证 graph/phrase positions；
- `html_strip` 只对确认含 markup 的 dataset/contentType 建专用 search-text 投影，
  不能全局改变 Telegram、代码或纯文本；
- edge-ngram 只在 `title.prefix` 的 index-time 使用，search-time 使用普通 analyzer；
  不给长正文或 chunk 全量生成 3–5/1–N grams；
- Snowball/stemming 只用于语言确认的英文专用字段/profile，不处理多语言正文、
  品牌名和 identifier。

每个新增 text multi-field 都会增加 postings/norms；CJK bigram 对长中文接近每个
相邻字符一个 token，content/chunk 同时增加会重复主要成本。迁移前用 1–5% 代表性
corpus 测 `_disk_usage`、rebuild 吞吐、merge/refresh、P95 和 top-query 相关性，
而不是为了“永不重建”预索引无限 analyzer。

## 5. 业务索引与日志索引隔离

| 类型 | 内容 | Retention | 访问 |
| --- | --- | --- | --- |
| `mx-insight-content-*` | 客户安全规范记录 | 跟 dataset policy；reindex 管理 | Hub query service account |
| `mx-insight-hub-chunk-*` | 当前语义切片与 embedding 投影 | 从 PG chunk/vector 重建 | Hub query/projector service account |
| `logs-mx-insight-*` | API/worker/projector 结构化日志 | 本地 7/30 日样板；生产按合规 | 运维/Kibana space |
| audit/usage | 权威审计和账本仍在 PG | 业务/合规策略 | Hub Admin，不依赖 Kibana |

日志不能包含 API Key、Authorization、Admin token、provider secret、原始查询全文或整行敏感数据。trace/request/tenant 使用内部 ID，平台等 label 必须是有界枚举。

## 6. Filebeat/Agent 的实际用途

有价值的场景：

- 继续 tail 宿主 Night-All 的 JSON 日志；
- 收集 landing agent/importer 的结构化运行日志；
- 非 K8s 遗留进程没有 stdout collector 时转发日志。

K8s 内优先统一 stdout + 集群级 collector（Elastic Agent/Filebeat/Vector/Fluent Bit 由平台选择），不要给每个 Hub Pod 再塞业务 sidecar。Filebeat 不读取业务工作簿或压缩包，Logstash 不决定 canonical ID、tenant policy 或 checkpoint。

## 7. 生产拓扑与升级

生产至少要求：

- ES/Kibana 同版本，版本和 image digest 固定；
- 认证/TLS 开启，9200/5601 不直接公网或 H2I 全网开放；
- 数据节点/副本、磁盘 watermark、JVM heap、PDB/反亲和按实际资源设计；
- 日志 ILM/数据生命周期和 snapshot repository 指向独立对象存储；content/chunk
  current-state index 不做 rollover，避免旧 `_id` 在 read alias 下复活；
- 升级前 snapshot + restore 验证、deprecation/Upgrade Assistant、plugin 清单和 rollback 计划；
- projector 支持暂停、积压观测、重放和 alias 原子切换；
- `core.chunk_projection_deletes` pending 数可观测；content/chunk 清空后均能从
  PG current state 重建，chunk delete 在 embedding provider 不可用时仍可续投；
- HanLP 服务与 ES 独立升级，模型 digest 跟随数据版本。

不要从旧 8.13.4 直接把 data volume 挂给 9.x。先快照和验证受支持的逐步升级路径，或在新集群从 PG/object source 重建业务索引。

参考：

- [Elastic release notes](https://www.elastic.co/docs/release-notes)
- [Elasticsearch plugins](https://www.elastic.co/docs/reference/elasticsearch/plugins)
- [Creating classic plugins](https://www.elastic.co/docs/extend/elasticsearch/creating-classic-plugins)
- [HanLP RESTful API](https://hanlp.hankcs.com/docs/api/restful.html)
- [Legacy community Elasticsearch HanLP plugin compatibility table](https://github.com/KennFalcon/elasticsearch-analysis-hanlp)

## 8. 与 MX-H2I 的隔离

Search/Kibana/collector 都是 Hub 自己的可选依赖：

- 不加入 Launcher network route plan、lease、WireGuard、PAC、NRPT 或 DNS owner；
- 不修改现有 MX-H2I Service/ConfigMap/host listener；
- Hub/ES/Kibana down 只影响 Hub 对应能力和管理卡片；
- Kibana 不经公共 Hub data route 暴露；
- 启用生产 route 前单独评审 DNS/TLS/NetworkPolicy，不把 Elasticsearch 端口当 API。
