# Hub 备份、恢复与阿里云离机存储

核验日期：2026-09-21。日常重启入口见 [mx-insight.deploy.md](../../mx-insight.deploy.md)；全新机器接管见[换机恢复流程](new-host-restore.md)。此文档区分现有能力与待实施方案；不把“Pod 正常 / 备份策略存在”当作“可以恢复”。

## 当前状态与目标

**本次旧数据已找回，不代表已经有离机备份，也没有证明与停机前逐行一致。** 已核验租户、Key、历史请求、旧索引及 API；没有完整页校验、账本对账或真实灾备演练。

| 能力 | 当前代码状态 |
| --- | --- |
| 原盘完好后的普通 deploy | 已有盘身份、凭据、依赖恢复保护；不负责从云下载数据 |
| ES 每日快照 | 有 SLM，默认同节点 filesystem 仓库；必须检查最近成功时间 |
| PG 物理备份、持续 WAL、PITR | **尚未接入运行环境**；当前 PG 镜像/清单没有安装配置 pgBackRest |
| ES → OSS | 有命名 S3 client/repository 配置生成器；**ES client 配置、keystore 持久挂载及 OSS 兼容性验收尚未接入** |
| 小体积配置/凭据包 | `export-recovery-kit.mjs` 按 age 公钥加密后写本地文件；不含数据库，不自动上传 |
| 只读备份检查 | `backup-readiness.mjs`，查询 PG 归档、pgBackRest 元数据和 ES SLM；没有备份时返回 2 |
| 新机器自动恢复/定时云备份 | **未启用**；先按本文完成接入与隔离恢复验收，再开放自动调度 |

普通 Hub deploy 的成功与“灾备可用”是两套验收。当前不因为云备份目标暂不可达而阻断已有用户服务，也不在 deploy 中重置备份仓库或下载旧备份覆盖当前库。

暂按 **阿里云 OSS、PG RPO 15 分钟以内、ES 快照间隔 6 小时**做容量和实施设计；这些是待确认建议，不是已实现的服务承诺。RPO 是最多可丢失的新数据时间，RTO 是恢复业务所需时间。ES 和 PG 时间点不同，不能直接宣称跨库一致。

## 必须保护的资产

| 资产 | 所属 / 主备份方法 | 恢复意义 |
| --- | --- | --- |
| 租户、membership、Key、授权、计量账本、请求证据、源数据、队列、检查点、模型/代理/平台配置 | `mx-common` PG 内 `mx_insight_hub`；pgBackRest 物理 base + WAL | 业务事实源，优先恢复 |
| 其他产品数据库、角色、扩展 | 共享 PG 实例；同一物理备份 | 物理恢复是整个实例，不是只回滚 Hub |
| 搜索、chunk、向量索引及 alias | mx-common ES 原生 snapshot | 避免 TB 级全量重建及重复 embedding 成本 |
| `.env.internal`、原 Pepper、数据库密码、Admin/模型等 Secret、ConfigMap | 独立 age 加密配置包，变更/轮换前后保存 | 旧 Key 和数据库内加密凭据的解密依赖 |
| pgBackRest 仓库加密口令、age 私钥、云恢复身份/KMS 访问权 | 独立密码库/离线托管 | 丢失这些，云端备份也可能无法解密；不能只放在故障机器或被其加密的包里 |
| 镜像 digest、Git commit、schema 版本、PG/ES/扩展版本、HanLP 模型校验值 | 恢复清单及独立镜像/制品仓库 | 固定可恢复的软件环境，避免临时拉 latest |
| Redis | 当前是缓存/可选队列；持久业务任务以 PG 为准 | 恢复前重查实际启用的队列后端；不能把未落 PG 的任务视作可丢缓存 |
| Launcher 身份、VPN、Night-All / Night-All-A | 各自独立备份责任 | Hub 恢复不能代替它们的恢复，也不允许为 Hub 回滚它们 |

PG 的 `catalog.external_sources.connection` 可能含可直接使用的源密码；平台凭据、hook 等同样敏感。PG base、WAL、逻辑 dump 和 ES 业务文档都按敏感数据保护。配置包包含完整的两个 namespace Secret，不得贴到聊天、工单或 Git。

## 大数据量方案

### PostgreSQL：在线物理备份与 WAL

采用 pgBackRest，先做完整 base，以后按块增量/差异备份并持续上传 WAL。`repo1-bundle=y` 减少小对象，`repo1-block=y` 减少变化大文件的传输；两项都应从首次 full 开启。增量减少仓库和网络增量，仍可能扫描大量本地页，不等于备份时间与“新增记录数”线性相关。见 [pgBackRest 配置](https://pgbackrest.org/configuration.html#section-repository/option-repo-block)。

建议起始调度：每周 full、每天 diff、每 6 小时 incr；同一时刻只运行一种备份，错开 ES 快照、重索引和磁盘维护。保留 4 个 full 及其有效链、7 个 diff 作为初始容量方案；这不是严格 30 天 PITR 承诺，实际可恢复窗口由成功备份和连续 WAL 决定。先实测增长率/带宽，再调整频率与保留；未演练前保留首个已验证恢复链。

[pgBackRest 配置模板](../../deploy/backup/pgbackrest.conf.example) 只提供非密钥参数，**不是现在复制后就能工作的启动配置**。实施时必须完成：

1. 构建并固定包含 **PG16 + 当前 pgvector + 相同 pgBackRest 版本**的镜像和恢复镜像；保留 UID 999、现有 PG 身份启动保护、原服务地址及原密码。检查其他已安装扩展/locale/架构兼容性。
2. 通过私有 Secret 提供 S3 身份和仓库加密口令，持久挂载配置；不能仅 `kubectl exec` 安装软件或修改容器临时文件。备份执行者必须能访问 PGDATA 和本地 socket，不能把普通远程 SQL 连接当作物理备份能力。
3. 在受版本控制的 PG 启动参数中接入 `wal_level=replica`、`archive_mode=on`、`archive_timeout=300s`、`archive_command='pgbackrest --stanza=mx-common archive-push %p'`。仅设置超时不保证 RPO；归档必须持续成功。`archive_mode` 首次启用需要 PG 重启，需安排短暂维护窗口；不能手工启用后下次 deploy 又覆盖回去。
4. 在独立测试 prefix 跑 `stanza-create`、`check`、首个 full、incr 和隔离恢复，核验大对象/multipart/TLS/签名/清理；通过后才使用生产 prefix 并调度。
5. 使用版本化 Kubernetes CronJob 或主机 systemd timer，明确时区、超时、并发互斥、失败告警；正常备份不暂停 Hub，自动任务不能自动重建仓库、换密钥或清空 PGDATA。当前仓库尚未安装这些任务。

初始采用同步 archive-push。持续跟踪未归档 WAL、磁盘剩余空间、失败时间和仓库可用性；云网络中断时不能无限积压而无人知晓。不要设一个有限的 `archive-push-queue-max` 来“保护磁盘”：达到限制会丢弃 WAL，破坏 PITR 链。不要使用 `/bin/true` 伪造成功或在归档命令里吞错。若以后采用 async，单独验收 spool 和故障恢复语义。见 [pgBackRest 归档说明](https://pgbackrest.org/configuration.html#section-archive/option-archive-push-queue-max)。

TB 级日常主备份不用 `pg_dump | gzip`。逻辑 dump 保留作 **Hub 单产品迁移/隔离恢复**辅助手段，可按周/月或重大变更前执行；大库需要评估 directory format 并行导出、加密临时空间和 pg_restore 时间。物理备份本身覆盖全实例；只恢复 Hub 时，应将整套物理备份先恢复到隔离 PG，再逻辑导出 Hub，不能把共享生产实例整体倒回过去。连续归档的 base + WAL、PG 主版本兼容要求见 [PostgreSQL 16 文档](https://www.postgresql.org/docs/16/continuous-archiving.html)。

### Elasticsearch：原生增量快照

使用 ES 原生 snapshot/SLM，保存完整选定索引和 alias，以增量 segment 复用减少重复上传；Lucene merge 会产生新 segment，不能用“当天新增业务 GB”估算所有快照增量。保留 live alias 对应索引及所需 chunk/vector 索引；旧 rebuild/v1-v5 索引的保留须单独审查，备份任务不替用户删除它们。

**不能把在线或停机后的 `elasticsearch/data` 目录打包当作受支持的备份。** 恢复应使用兼容版本 ES 的 snapshot API，不恢复 global cluster state 以免覆盖目标配置。一个仓库只能有一个写入集群，演练/新机读仓库用 `readonly:true`。见 [Elastic 快照与恢复](https://www.elastic.co/docs/deploy-manage/tools/snapshot-and-restore)及[仓库设置](https://www.elastic.co/docs/reference/elasticsearch/configuration-reference/s3-repository-settings)。

PG PITR 与 ES 快照不是原子备份。先恢复业务事实源，再按两者时间点核验新增、更新、删除和 projector 检查点；不能简单重放“当前未完成队列”就认为所有差异已补齐。ES 比 PG 更新时可能暴露已被 PG 回滚的文档，应隔离这些索引。只有明确核验后才开放搜索；需要重建/向量化时另行评估预算，不由恢复脚本自动启动。

## 阿里云 OSS 接入与权限

以两个独立仓库 prefix 和不可覆盖的配置包为单位：

```text
oss://<backup-bucket>/mx/internal-production/pgbackrest/...
oss://<backup-bucket>/mx/internal-production/elasticsearch/...
oss://<backup-bucket>/mx/internal-production/config/<UTC-time>-<id>.json.age
oss://<backup-bucket>/mx/internal-production/evidence/<drill-id>/...
```

Bucket/地域待选。优先与服务器网络实测匹配的区域；在同区域 ECS 内可评估内网 endpoint，普通本地机不能假定能访问 OSS 内网地址。原盘、同盘 reflink、同盘 ES snapshot 不能算三份独立副本。目标是本地业务数据 + 离机备份 + 独立权限的异地/隔离副本。

- Bucket 私有、TLS 验证开启；PG 使用客户端加密，ES repository 对象使用合适的 OSS SSE/KMS 和访问控制。region/key/endpoint 不能写进公开日志，AK/Secret 不放在命令参数或 Git。
- RAM 最小权限限定到对应 prefix。备份写入、恢复只读、保留清理权限分别设计；pgBackRest/ES 需要仓库元数据维护和到期删除，不能盲目用“不允许删除/覆盖”的 WORM 策略锁住活动仓库。
- 为隔离/防误删副本配置独立账号或权限及合适保留。Bucket versioning 不等于一致恢复点：不能随便取每个对象各自的最新历史版本拼一个仓库。KMS key 的恢复权限必须在丢机演练中验证。
- 活跃 pgBackRest/ES 仓库先用 Standard。不对它们执行按对象年龄删除、任意改名、`sync --delete` 或归档层自动迁移；保留链和清理由备份工具掌管。需要冷归档时保存封存且验证过的完整恢复集到独立 prefix，并计算解冻时间和费用。
- 不把未经协调的 OSS 跨地域复制结果直接注册为 ES 仓库。复制到达顺序可能暂时破坏引用关系；先冻结写入并按仓库备份流程获得一致恢复集，再验收异地副本。见 [Elastic 仓库复制限制](https://www.elastic.co/docs/deploy-manage/tools/snapshot-and-restore/s3-repository#repository-s3-replicating-objects)。

OSS 仅支持 virtual-hosted 访问方式；pgBackRest 用 `repo1-s3-uri-style=host`，ES client 用 `path_style_access=false`。multipart ETag 不能当文件 MD5；用备份工具校验和与实际恢复验证。见 [阿里云 S3 兼容范围](https://www.alibabacloud.com/help/en/oss/developer-reference/compatibility-with-amazon-s3)。

ES 配置生成器的示例（只输出配置，不连接 OSS、不应用到 ES）：

```bash
MX_COMMON_SNAPSHOT_S3_ENDPOINT=https://oss-cn-hangzhou.aliyuncs.com \
MX_COMMON_SNAPSHOT_S3_REGION=cn-hangzhou \
  node ../mx-common/scripts/print-snapshot-config.mjs client

MX_COMMON_SNAPSHOT_S3_BUCKET=replace-with-your-private-bucket \
MX_COMMON_SNAPSHOT_S3_BASE_PATH=mx/internal-production/elasticsearch \
  node ../mx-common/scripts/print-snapshot-config.mjs repository
```

ES 9 的 endpoint/region/path-style 属于 `elasticsearch.yml` 的 `s3.client.mx_backup.*` 设置；AK/Secret 属于 `s3.client.mx_backup.access_key/secret_key` keystore 项。repository API 只引用 `client:mx_backup`，不是把 endpoint 和密钥塞进 repository JSON。已修正旧生成器混用位置和强制 path-style 的问题。**当前 manage.sh 不会安装该 client/keystore**，需要补持久 Secret/init 挂载及版本化配置；仅设置 Bucket 还不能正常备份，也不能复制明文配置进去就算验收。

正式接入使用新仓库名（例如 `MX_COMMON_SNAPSHOT_REPOSITORY=mx-common-oss`）和新 policy（例如 `MX_COMMON_SNAPSHOT_POLICY=mx-common-oss-6h`），先保留原 filesystem 仓库及其快照；不要将旧仓库名直接改指向空 OSS prefix。6 小时调度可显式配置 `MX_COMMON_SNAPSHOT_SCHEDULE='0 30 0/6 * * ?'`（UTC），相应检查使用新 policy 与 8 小时新鲜度阈值。当前默认 daily/36 小时保持不变。启用时把这些参数与 client/keystore 一起接入持久部署配置，不能只依赖某次终端 export。

接入流程要在专用测试 prefix 做 repository `_verify`、`_analyze`、snapshot/restore，验证实际 ES 9.4.2 与 OSS 的行为。S3 兼容并不保证完全兼容；不通过时不能宣称 OSS 直连可用。替代路线是独立备份主机上的受支持 repository，协调停止仓库写入后生成一致副本再通过 OSS 原生客户端离机保存；不能后台同步正在变化的 ES 仓库。详见 [Elastic S3 兼容要求](https://www.elastic.co/docs/deploy-manage/tools/snapshot-and-restore/s3-repository)。

## 现在可执行：检查与加密配置包

从 Hub 目录执行只读检查，无需新增库依赖：

```bash
node scripts/backup-readiness.mjs
bash ../mx-common/scripts/manage.sh snapshot status
```

前者退出 2 表示基本备份证据不完整；当前尚未安装 pgBackRest 时这是预期结果。退出 0 也仅表示观察到基本元数据，输出始终保留 `disasterRecoveryVerified:false`；它不下载验证所有 WAL、不做恢复、不证明 RPO。PG `last_archived_time` 还应结合有无写入/未归档 WAL 判断，空闲数据库不能只凭时间旧就判故障。后者已改为检查最近成功是否超过 36 小时、最近一次失败是否晚于成功；不再“历史成功过一次就永久通过”。

配置包工具需要安装官方 [age](https://github.com/FiloSottile/age)，在受保护的另一台机器/密码库生成并保管私钥，仅把 `age1...` **公钥**交给服务器。先用测试文本验证能加密/解密，再导出。以下占位符必须替换，不要把私钥放进 `--recipient`：

```bash
node scripts/export-recovery-kit.mjs \
  --recipient age1REPLACE_WITH_PUBLIC_RECIPIENT \
  --output /secure-backups/hub-config-20260921.json.age
```

目标父目录须已存在且为真实路径；输出文件必须不存在。默认读取本项目 `.env.internal` 和 `/var/lib/mx-common/storage-identity.json`（要求私有普通文件），可显式指定 `--env-file`、`--receipt-file`。获取两个 namespace 运行配置、镜像规格/在运行 imageID、Git commit/脏工作区标记、绑定证据和关键 Secret；发现关键 Secret 缺失或采集期间配置变化即失败。脏工作区标记为 true 时，Git commit 不代表完整运行源代码，应另行保留已提交版本或构建制品。不读取 PG/ES 数据，不改集群；明文配置只在进程内存，输出是 0600 加密文件，最后原子发布，不能覆盖旧包。运行主机也应禁用 core dump、保护 swap/管理员访问。

配置包是当时状态的证据，不证明 `.env.internal` 与 Secret 内容一致，不能当作 `kubectl apply` 清单。导出 JSON 中声明 `containsDatabaseBackup:false`；保留工具输出的密文 SHA-256 在外部记录。每次配置/Secret 轮换前后、重大部署后各保留一份，记录适配哪个数据库备份/时间范围；一个新 Pepper 不能解密旧备份。

OSS 身份通过受保护的 ossutil 配置/凭据提供，完成 Bucket 权限配置后再传密文：

```bash
ossutil cp /secure-backups/hub-config-20260921.json.age \
  oss://REPLACE_BUCKET/mx/internal-production/config/hub-config-20260921.json.age
```

使用唯一对象名，上传成功后在独立主机下载、核对 SHA-256 并解密验证。`ossutil cp` 支持大文件 multipart/断点续传；按安装的 2.x 版本配置 checkpoint、并发和带宽，下载的断点行为也须单独测试。它仅是传输工具，不会把在线 PGDATA/ES data 变成一致备份。见 [ossutil cp](https://www.alibabacloud.com/help/en/oss/developer-reference/cp/)。

在隔离恢复主机解密配置（只展示命令，不要贴出结果文件）：

```bash
umask 077
age --decrypt --identity /private/age-identity.txt \
  --output /private/hub-config.json /private/hub-config.json.age
```

数据库物理备份、ES 快照、配置包、密钥和恢复清单全部齐备并演练后，才能把某个时间点标成“可恢复”。

## 容量、耗时与验证

首次 full 和新机完整恢复都要传有效全量数据，增量不能消除这次成本。网络下限 `有效传输字节 × 8 / 实测有效 bit/s`；这里按十进制 1 TB，不含压缩收益、协议开销、WAL replay、磁盘写入、下载限额和 API 验证：

| 有效带宽 | 100 GB | 1 TB |
| --- | ---: | ---: |
| 100 Mbps | 约 2.2 小时 | 约 22.2 小时 |
| 500 Mbps | 约 27 分钟 | 约 4.4 小时 |
| 1 Gbps | 约 13 分钟 | 约 2.2 小时 |

80 MiB/s 的恢复限速，单 1 TiB 约 3.6 小时，仍要加 WAL 重放、索引恢复及验收。ES 当前生成器默认 snapshot 40mb/s、restore 80mb/s（每节点）；实际速率还受 recovery 设置限制。更换服务器时 PG 与 ES 的总传输量都应计入，不能只算 PostgreSQL database_size。

容量预算包括：多条 full 链、diff/incr、保留 WAL、ES segment 增量、versioning 的非当前版本、恢复演练临时空间、加密临时逻辑 dump 和网络中断时本地 WAL 余量。现场记录每日 WAL/索引变化量和首次 full 实测，再估算 OSS 容量、请求费、取回流量、KMS 与冷层费用；不凭原库大小推断账单。至少为恢复目标预留数据大小加 WAL/解压/索引恢复余量，不能把 PV 声明的 50Gi 当真实容量配额。

日常监控：最近成功 base/incr、云端可验证 WAL 进度、失败连续时长、ES 最近快照状态、加密包最新时间、空间/增长率、上次恢复演练时间。检查“不完整/未知”须告警，不能让一次脚本退出 0 替代这些指标。

每月在干净目标进行恢复演练，重大版本/加密密钥变更后额外演练；记录选定 base、WAL 终点、ES snapshot、配置包 SHA-256、版本、起止时间、实际 RPO/RTO。核验 Key/Pepper、用户 membership、租户授权、immutable ledger 与余额、unknown 请求的上游证据、记录/alias/checkpoint、只读业务/API 检查。不会为了验收自动触发付费调用或向量化。演练结果保存到故障集群之外。

## 本次本地验证范围

配置生成、备份健康判定、只读命令边界、密钥输出屏蔽、配置变更检测、私有文件权限和原子发布已做模拟回归；共享部署/恢复相关回归继续通过。本机未安装 age/pgBackRest，age 子进程使用测试替身验证调用与文件安全，**尚未进行真实 age 加解密、OSS 上传或数据库恢复**。这些上线验收须在具备工具和独立测试仓库的环境完成，不以模拟测试代替。
