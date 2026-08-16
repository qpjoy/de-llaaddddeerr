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

## 4. HanLP 集成

Elastic classic plugin 会校验精确 ES 版本。现有社区 `elasticsearch-analysis-hanlp` 的公开兼容范围停留在旧 7.x 系列，不能直接装进旧 ES 8.13.4 或当前 9.x。

推荐 enrichment contract：

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

索引时把 tokens 保存为独立预分词字段；查询时用同模型生成 query tokens。HanLP 失败时记录 `enrichment_pending`，原文和结构化数据仍发布。模型升级创建新 enrichment version，通过 shadow reindex/A-B relevance 验证后再切 alias。

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
