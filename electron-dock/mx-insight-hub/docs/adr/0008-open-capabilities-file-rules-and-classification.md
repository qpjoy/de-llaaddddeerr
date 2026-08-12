# ADR-0008: 开放能力、文件规则与有界分类成本

状态：accepted，分阶段交付。

## 背景

Hub 已经有租户、调用者、多 API Key、平台授权、配额和调用证据，但公开面仍以
Night-All 数据查询为中心。HanLP、Jieba、CJK bigram 已属于 Hub 的搜索依赖，
却没有一个可计量、可授权、能说明实际后端的通用分词接口。

文件接入已经支持单文件上传、人工批准的版本化字段映射、原始行保留、文件哈希
幂等和 canonical 业务键去重；它还不支持宿主机目录、跨来源复用的格式规则、规则
提示词生命周期和大批量低成本分类。管理台也缺少一个从 PostgreSQL 权威数据出发
的数据中心。

这些能力必须扩展 Hub，但不能改变 Launcher/MX-H2I 的登录、DNS、VPN、WireGuard、
Clash 或用户联网链路。

## 决策

### 1. 一个 Key 体系，能力与数据平台分开授权

不建立第二套“开放平台 Key”。现有关系保持不变：

```text
tenant 1 ── N consumer 1 ── N api_key
                         ├── platform grant: telegram / twitter / ...
                         └── capability grant: nlp.tokenize / ...
```

平台授权回答“这个调用者能读取哪个平台的数据”；通用能力授权回答“这个调用者能
调用什么工具”。二者共享 Key 生命周期、调用者归属、固定窗口配额、幂等请求、使用
记录和撤销机制，但在目录和管理界面中分栏展示。`nlp.tokenize` 不能伪装成名为
`hanlp` 的数据平台。

内外网调用使用同一稳定 API contract 和 API Key 认证。所谓“内部完全开放”指内部
调用者可由管理员统一授权，不等于匿名开放；匿名分词会把同一 Internal 节点上的 CPU
变成无配额公共资源。公网暴露仍需要 TLS、反向代理、来源限流和现有 Key。

首个通用接口为 `POST /api/v1/tools/tokenize`，授权标识为 `nlp.tokenize`。请求只接收文本，不接收 URL、凭据、
请求头或后端地址。响应必须返回本次调用的实际后端和降级状态，不能用全局“最近一次
可用”状态猜测。

### 2. 分词优先级

默认链为：

```text
HanLP -> Jieba -> CJK bigram
```

- HanLP 是首选中文模型分词；
- Jieba 是本地、低成本、语义边界优于机械二元切分的降级；
- CJK bigram 不依赖字典或模型，作为 Jieba 初始化/推理也失败时的最终保底。

每次调用原子返回：

```json
{
  "tokens": ["人工智能", "平台"],
  "backendUsed": "hanlp",
  "degraded": false,
  "errorCode": null
}
```

`backendUsed` 属于这一次调用，不能从共享的 `available`/`lastError` 推导。非空输入得到
空数组或非法 token shape 视为上游失败并继续降级。生产搜索仍 fail-soft；公共分词
接口如返回降级结果，必须明确 `degraded: true`。

### 3. 数据中心读 PostgreSQL 权威数据

管理台新增数据中心，展示：

- dataset 数、current record、revision、tombstone；
- 按 `dataset_id` 聚合的平台、对象类型、内容类型、最近事件/采集时间；
- 经过安全字段选择的最近 canonical 记录；
- 后续增加文件规则、分类覆盖率、projector backlog 和 ES projection 状态。

数据中心不以 ES 命中数作为权威计数。ES 整库删除或重建期间，PG 中的数据集合仍必须
可见。原始 payload、连接凭据和未筛选 `extensions` 不在目录列表直接展开。

### 4. 宿主路径只进入专用 ingest 边界

支持管理员从已登记的服务器根中选择相对目录/文件，但不允许浏览器登记任意绝对路径，
更不能让 Admin/Public Pod 直接读取。根目录只能由运维配置为只读 allowlist，例如：

```text
source root: internal-files -> /srv/mx-insight/import
request path: reports/2026-08/
```

解析后的真实路径必须仍位于该根目录，拒绝 `..`、符号链接逃逸、设备文件、socket、
可执行文件和未知 archive extractor。API 不接受 glob；批量选择来自 landing agent 生成的
目录 inventory/manifest。专用 ingest worker/landing agent 获得该根目录的
read-only mount；Public/Admin Pod 不挂宿主数据目录。多节点环境优先使用落地 agent 将
content-addressed raw object 与 manifest 单向上传，不能把单节点 `hostPath` 当成集群协议。

批量提交先做 inventory/preview，再由用户批准规则和发布范围；不让 Agent 在看不到
完整证据时直接把一整个目录写进 canonical。

### 5. 文件、规则和记录三层幂等

幂等不能只依赖文件名：

| 层 | 稳定身份 | 重复行为 |
| --- | --- | --- |
| 原始 blob | `sha256(content)` | 同内容物理保存一次 |
| 来源观察 | `(source_root, relative_path, sha256)` | 保留路径观察，不重复 parse |
| 导入 run | `(source_id, input_sha256, rule_version)` | 同规则成功导入后直接 skip |
| canonical record | `(dataset_id, platform, object_type, external_id)` | upsert；payload hash 未变不增 revision/outbox |
| ES document | canonical ID + external version | 重放覆盖同版本，不生成第二份 |

源文件从磁盘消失只把观察标为 `source_missing`，默认不删除 PG/ES 数据。业务删除必须由
显式 tombstone、完整 snapshot contract 或经确认的数据保留策略触发。

### 6. 多个文件可以共享一个格式规则

“文件数据源”和“格式规则”是两个对象：

```text
file source N ── 1 active rule version
format rule 1 ── N immutable rule versions
format rule 1 ── N file observations/import runs
```

规则指纹由格式、sheet/JSONPath、规范化列名、列类型/必填特征和 parser family 组成，
不包含文件名或抽样值。两个路径的文件匹配同一指纹时，界面把它们放在同一规则下；
低置信度或 schema drift 进入待确认，不自动套用“看起来差不多”的规则。

规则版本包含 parser 参数、field map、identity rule、质量阈值、分类/脱敏策略和 prompt
版本引用。已批准版本不可原地修改；修改产生新版本，旧 import 仍能解释。

### 7. Prompt 是可管理资产，不是散落代码中的字符串

Agent 管理增加“文件规则提示词”：

- prompt key、用途、适用规则/格式、模板正文、输入字段 allowlist；
- immutable version、状态、创建者、审批者和回滚目标；
- 模型、采样参数、最大输入、预算和固定 eval dataset；
- 启用、停用、编辑为新版本、删除未引用草稿。

没有 prompt 时，可从已经人工批准的规则与脱敏后的 schema 证据生成**草稿**；生成结果
仍需人工批准。Prompt 不接收数据库密码、API Key、原始敏感行或任意工具地址。

### 8. 分类采用分层流水线，不逐条调用 LLM

每条记录直接调用 Agent 成本高、延迟大、不可稳定重放。分类顺序为：

1. 来源规则和现有字段：platform/source/feed tags/content type；
2. HanLP/Jieba token、实体、URL/domain 和确定性关键词规则；
3. 小批量 embedding，一次计算后与已批准类目的 centroid/原型比较；
4. 对同一规则/来源的相似记录聚类，按 cluster 抽样；
5. 只把低置信度、新 cluster 或 schema drift 样本发给 LLM；
6. 人工确认后把结论沉淀为规则、关键词或 centroid，再批量回填同 cluster。

每条记录保存 `taxonomy_version`、`labels`、`method`、`confidence`、`rule/model/prompt
version` 和 `classified_at`。Night-All 的“数据源分类”可作为 taxonomy seed，但来源级标签
不能冒充逐条内容分类。`unknown` 是正常结果，不能为了填满字段而强迫模型猜测。

这样 LLM 成本更接近“新模式/低置信 cluster 数”，而不是“总记录数”。

### 9. 搜索与高亮

现有 ES 投影继续同时保存原文与预分词字段，混合查询 raw、HanLP/Jieba token、CJK
bigram、edge-ngram、wildcard identifier 和 keyword exact；PostgreSQL `pg_trgm` 提供 ES
故障时的较窄模糊降级。公共搜索响应保留 `mode`，让调用者知道结果来自 ES 还是 PG。

高亮只针对可返回的 customer-safe 字段生成；不能从 `extensions`、raw payload 或不可见
字段通过 highlight 侧漏。分词字段名称后续应从历史 `*Hanlp` 迁移到中性 `*Segmented`
版本，避免 Jieba/bigram 降级时产生错误 provenance。

## 分阶段交付

1. `nlp.tokenize`、原子后端 provenance、现有 Key/配额复用、OpenAPI/公共文档；
2. 数据中心的 PG dataset 聚合与安全记录样例；
3. allowlisted host-file inventory、批量 preview 和 content-addressed manifest；
4. 可复用格式规则、版本化 prompt CRUD、人工审批和回放；
5. taxonomy、规则/embedding/cluster 分类、LLM 例外队列和覆盖率；
6. 分类检索/聚合、projection provenance 与 BI/Agent 消费。

每一阶段都必须保持 canonical ingest 在 Agent/ES/HanLP 不可用时仍可写入；任何 rollout
都不得同步 Launcher Secret 或重启 Launcher，除非操作者另外显式设置既有的
`MX_INSIGHT_SYNC_LAUNCHER=1` 门控。

## 后果

- 现有 Key 可以自然覆盖数据 API 和通用能力，调用者无需管理两套凭据；
- 授权目录从“平台”扩展为“平台 + 能力”，但旧平台 contract 保持兼容；
- 文件自动化以规则和证据为中心，Agent 只提出可审阅版本，不控制 identity/去重；
- 大规模分类的主要成本转为 embedding/规则计算，LLM 只处理新模式；
- 数据中心在 ES/HanLP/Agent 降级时仍忠实显示 PG 权威数据；
- MX-H2I 登录与联网链路不依赖上述任何能力。
