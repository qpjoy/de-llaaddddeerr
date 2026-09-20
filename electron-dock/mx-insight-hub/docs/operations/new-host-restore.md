# 新机器安装与备份恢复

配套：[部署档案](../../mx-insight.deploy.md)、[备份设计与当前实现状态](backup-restore.md)。这是一份恢复操作规格，不是已实现的一键换机脚本。当前 `deploy` 只负责**已正确绑定的数据服务**；缺盘/丢失元数据时会停止。不要删除存储保护来让新机器“先跑起来”。

## 三种情况分别处理

| 场景 | 处理 |
| --- | --- |
| 原机器重启，原盘及 PV/PVC/Secret 完好 | 原 Hub deploy，自动起 mx-common |
| 全新业务环境，不需要旧数据/身份/Key | 正常首次安装，新实例和新凭据；这不是恢复旧 Hub |
| 接替旧机器、原盘坏了或希望回到历史时间点 | 先验证备份并恢复到独立目标，核验后接管；禁止直接 deploy 初始化同名空库 |

本次事故的 `recover-retained-storage.mjs` 针对“同机已核验的旧 PG/ES 目录 + 特定 recovery state”设计，不支持把一个任意新主机当作原机 resume，更不支持从 OSS 自动找出正确备份。

## 接管前准备

- 选定明确恢复点：PG base label、连续 WAL/UTC 目标时间、ES snapshot 名称、匹配的加密配置包和 SHA-256；确认副本能读取和解密。不要让不同仓库的 `latest` 各自选择一个时间点。
- 准备 Git commit、PG16/pgvector/其他扩展、pgBackRest、ES 9.4.2 的兼容镜像及 digest、HanLP 模型/词典；先恢复到备份时的兼容版本，后续升级单独进行。物理 PG 备份不能跨主版本直接启动；架构、扩展库和 locale 也要匹配。
- 恢复的是 mx-common **共享 PG 实例**，先列出其中其他产品及其负责人；如果只恢复 Hub，用隔离物理恢复 → Hub 逻辑导出 → 受控产品导入，不能回滚仍在服务的其他产品。
- 新主机准备持久磁盘、按 UUID 挂载、足够恢复空间、Node.js/kubectl/containerd/Docker；先验证镜像能导入 containerd，Docker 有镜像不代表 Kubernetes 有。
- 使用新 K8s 集群或与生产完全隔离的恢复目标，禁止新旧实例同时提供写流量、执行 worker、供应商调用或通知任务。恢复集群的备份凭据使用只读权限，不允许它向原生产备份仓库写入。
- 明确保留旧机/旧盘/原备份的边界。所有恢复写入新建空目录/空目标卷；脚本不得把“恢复目标”默认成现有 PGDATA，不得默认 `--delta` 覆盖一个有内容的目录。

只读获取源环境证据：

```bash
node scripts/backup-readiness.mjs
kubectl -n mx-common get statefulsets,deployments,pvc
kubectl get pv -l app.kubernetes.io/part-of=mx-common \
  -o custom-columns='NAME:.metadata.name,PATH:.spec.hostPath.path,RECLAIM:.spec.persistentVolumeReclaimPolicy'
```

配置包需要独立 age 私钥解密。它包含旧 UID、resourceVersion、claimRef、nodeAffinity、Service 地址及敏感值，**不可把整个 JSON 直接 `kubectl apply`**。先提取并审核所需资源的期望字段；不要恢复旧 service-account token、Pod 状态、Job 完成状态、旧集群 IP 或原节点 hostname。

## 分阶段恢复顺序与验收门槛

### 1. 还原 PostgreSQL 到隔离新卷

在与备份兼容的恢复容器内，用相同版本 pgBackRest 配置及仓库解密口令，选择具体 backup set；目标时间必须带时区，所需 WAL 必须连续。PITR 恢复初始选择停在目标/暂停供核验，不默认自动提升接管。恢复期间禁止普通 postgres 镜像 entrypoint 因目录检查失败而执行 initdb。

恢复结束检查 pgBackRest 结果和 PG 启动日志、system identifier、目标 timeline/时间、`pg_is_in_recovery()`、数据库/角色/扩展清单；不能仅凭文件存在认定恢复成功。核验恢复的 `mx_insight_hub`、原产品角色和原密码匹配，记录 schema 版本。不要为了修复连接失败自动重置所有数据库密码。

物理备份中的 system identifier 可以沿用原实例；**新磁盘 UUID 和新节点信息不能伪装成原机器**。新身份登记记录应保留来源备份及旧身份的追溯关系。

### 2. 还原 Elasticsearch 快照

起一个隔离且版本兼容的 ES，配置原仓库为只读，选择具体快照与索引，排除 global state。检查快照是否完整 SUCCESS、主分片与索引/alias/文档数量，并保存恢复耗时。确认快照包含 Hub 当前内容、chunk/vector 索引和必要 alias；没有向量索引时不能把“自动重新调用 embedding”当成免费恢复路径。

PG 与 ES 恢复点不同的差异必须核验：尤其删除/撤权、更新和未重放 outbox。ES document count 不等于 PG canonical count，历史索引也可能存有重复版本。可以先让只读 Admin 查 PG 核验；未经核验不要开放面向用户的历史搜索索引。

### 3. 还原凭据与配置，保持业务停止

分别还原 mx-common 管理 Secret、Hub 产品 Secret、Hub Secret、模型等 Secret/ConfigMap 和匹配的 `.env.internal`，比较原 Pepper/产品角色密码/DSN 连续性。公开证据只输出“匹配/不匹配”和数量，不输出密钥、连接串或 Key 明文。

模型、清洗、采集、projector、retrieval、定时通知和所有写入 API 保持停止；只启动隔离验收所需的只读组件。原 deploy 会按设计恢复六种 Deployment 副本，因此**验收前不要用 deploy 作为创建基础设施的快捷入口**。

### 4. 显式登记新机存储

为新机器生成三组 Retain PV/PVC，hostPath 使用 `Directory` 指向已经恢复好的实际路径，显式 static class、正确目标 nodeAffinity 和本集群生成的新 claim UID；不复制旧 claim UID，不接受 DirectoryOrCreate 默默创建空路径。

核验所有卷、本地挂载 UUID、PG system identifier、ES 元数据与恢复来源后，再通过受控登记流程生成本机 `/var/lib/mx-common/storage-identity.json`，安装匹配的启动 guard。**不能直接复制旧 receipt，也不能删除它后靠 deploy 自动碰运气。** 当前普通 storage preflight 要求完整且正确的既有绑定；自动化新机登记/基础设施恢复入口尚待实现，不能声称本段已由 deploy 自动完成。

### 5. 应用及业务核验

在隔离路由、禁止供应商外呼的环境完成：

- schema 兼容；原角色的数据库认证；原 Pepper 解密/API Key digest 核验。
- tenant/member/consumer/Key/grant 状态；记录和请求历史的有界抽样；关键表计数/总量根据备份点对齐。
- 账本不可变记录、余额与预留一致；`unknown` 请求对照上游审计证据逐笔处理，不自动重放付费调用。
- ES alias/索引时间点与 PG 权限/数据的一致性；队列/水位/检查点应从所选恢复点继续。
- 小流量无副作用 HTTP smoke；全量校验可在隔离环境做，不能靠 UI 近 24 小时图表证明完整性。

记录演练报告到独立存储：备份标识、配置密文 SHA-256、软件版本、目标节点/卷、恢复时长、可恢复到的实际时间以及全部未决差异。需要新 schema migration 时先保护刚恢复的状态，再升级。

### 6. 接管与后续 deploy

先关闭旧实例的所有写入口/worker，再在明确的切换点开放新实例；变更 Hub origin/DNS/路由应使用现有网络与身份契约。切换前保留可回退的旧实例；切换后已有新写入时，不能简单把路由拨回旧数据库，否则再次分叉。

新机存储、配置、镜像和隔离验收全部完成后，日常仍使用：

```bash
MX_INSIGHT_BUILD_PROXY=http://127.0.0.1:7788 \
  bash scripts/manage.sh ops internal-production deploy
```

该命令会按既有配置恢复后台 worker；恢复前应检查其 operator 开关/预算/队列，避免把积压当成无限重跑。它不替换备份恢复流程。新实例成为唯一写者后，使用独立新 prefix/受控新 timeline 备份策略建立新的已验收恢复链，避免演练实例与原机同时写仓库。

## MX-H2I 与外部依赖

只更换 Hub 不应重建 Launcher 身份、VPN、订阅或用户登录数据。原 Launcher 可继续作为身份服务，Hub 还原 membership/Key 后沿用原认证契约；如果丢失的是整个 Internal 主机，Launcher 身份服务自身也必须按其独立备份恢复，这不在 Hub 配置包里。Night-All、供应商配置、模型服务的网络连通性逐项核验，不通过修改 MX-H2I 登录来绕过。
