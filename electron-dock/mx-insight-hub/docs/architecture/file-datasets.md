# 文件数据集（File datasets）

场景应用 → **文件数据集**：从服务器上的大文件清洗入库、按版本发布、只读查询的数据产品。
当前有三个：

| 数据产品 | dataset key | 源文件 | 数据域 / 查询权限 | 接口 |
|---|---|---|---|---|
| Twitter 用户邮箱 | `twitter-user-email` | JSON 对象（用户名 → 邮箱），`.json` | `twitter_user_email` / `twitter.user_email.search` | `/api/v1/data/twitter-user-email/{search,metadata}` |
| 邮箱库 | `email-directory` | 每行一个邮箱，`.txt` | `email_directory` / `email.directory.search` | `/api/v1/data/email-directory/{search,metadata}` |
| 手机号库 | `phone-directory` | 每行一个手机号（+国家码…），`.txt` | `phone_directory` / `phone.directory.search` | `/api/v1/data/phone-directory/{search,metadata}` |

源文件可以是上述格式的普通文件，也可以是服务器上 **.zip 里的某个文件**（例如 `email-phone.zip` 里的
`email_only.txt` 与 `phone_only.txt`），见「压缩包来源」。

## 边界

- **只用 PostgreSQL**（mx-common PG，schema `account_dictionary`）。不写 canonical records、outbox、
  Elasticsearch、HanLP 或向量化；查询只读已发布版本，不触发任何采集。
- 不经过 Launcher、登录、DNS、WireGuard：不影响 MX-H2I 的用户登录与联网。
- 都是个人数据：数据域与查询权限只能显式授予 snapshot Key（`isExplicitOnlyKeyScope`），历史动态范围 Key 返回
  `403 snapshot_key_required`；托管全量 Key 不会自动获得。
- 默认返回完整值，`reveal:false` 返回脱敏值；查询内容只以 HMAC 记入 `access_events` 和计量证据。

## 代码结构

| 位置 | 作用 |
|---|---|
| `shared/file-datasets.mjs` | 产品注册表（UI、目录、文档、服务端共用）：key、名称、数据域、权限、路径、默认源文件与指纹 |
| `server/data/file-datasets/registry.mjs` | 产品 + 存储 kind |
| `server/data/file-datasets/kinds/*.mjs` | 每种数据的格式、清洗、列、去重、索引、验收查询 |
| `server/data/file-datasets/{engine,store,pipeline,search-base,services}.mjs` | 通用：清洗引擎、版本与锁、Admin 意图、查询通道、装配 |
| `server/data/file-datasets/{json-pairs,lines}.mjs` | 可断点续读的 JSON 对象 / 文本行读取器 |
| `server/data/<dataset>/{contract,search}.mjs` | 每个产品的请求校验与查询 SQL |
| `server/workers/dictionary.mjs` | 唯一读取大文件的 worker（k8s `mx-insight-hub-dictionary`） |
| `src/file-dataset-pipeline.jsx`、`src/file-dataset-page.jsx`、`src/pages-*.jsx` | 清洗任务卡片 / 任务控制、产品页（接口调试 · 产品展示 · 接入指南 · 管理） |

新增一个文件数据集 = 注册表条目 + kind + contract/search + 一条 seed `account_dictionary.datasets` 的迁移
（例：`migrations/180_file_datasets_email_phone.sql`）。

## 压缩包来源（.zip）

清洗计划里直接填写 .zip 路径即可，不需要先解压（`server/data/file-datasets/{zip,source}.mjs`）：

- **选择包内文件**：`datasets.source_entry`。不填时按顺序选：数据集默认文件名（邮箱库 `email_only.txt`、
  手机号库 `phone_only.txt`）→ 唯一一个扩展名匹配的文件；有多个候选时返回 `409 archive_entry_required`
  并列出候选，任务控制里可从列表中选。
- **不落地解压**：worker 读中央目录（支持 ZIP64，> 4 GiB 的包和文件），用 Node 自带 zlib 流式 inflate
  所选文件，直接交给按行 / JSON 读取器；不占额外磁盘。
- **指纹与身份**：SHA-256、dev:ino、mtime 描述整个压缩包；开启后包被替换或包内文件大小变化 → `source_changed`。
- **断点**：`byte_offset` 记录的是解压后的字节位置（`versions.source_entry_bytes` 是解压后总大小）。
  继续时从该文件开头重新解压并跳到断点（不需要保存 inflater 状态）：本机约 0.6 秒跳过 167 MiB，
  即每 GB 约数秒。
- **校验**：读到最后一个字节时核对包内声明的大小与 CRC-32；输出超过声明大小立即停止（防压缩炸弹）。
- **不支持**：加密条目、Deflate64 / bzip2 / LZMA / zstd 等方法、分卷包，以及 .rar（需要镜像里另装
  libarchive）；这些给出明确错误码（`archive_entry_encrypted`、`archive_method_unsupported`、
  `archive_multipart`、`unsupported_file_type`），需在服务器上解压或重新打成标准 deflate zip。

## 清洗流程（每个版本）

1. **校验文件**：流式计算 SHA-256（限速 200 MiB/s），与期望指纹不符即拒绝。
2. **导入**：每批 5 万条，行、隔离记录与字节断点在同一事务提交；限速 25k 条/秒，提交慢于 3 秒时退避。
3. **去重与建索引**：按分区去重（`COLLATE "C"`）→ kind 的索引 → `VACUUM (FREEZE, ANALYZE, PARALLEL 0)` →
   三元组抽样（只有支持片段查询的字段）→ 挂接到 `mappings_v<N>`。
4. **核对计数**：读取 = 入库 + 隔离、分区行数 = 入库、抽样行能经索引查回，然后待发布；发布只切换
   `datasets.active_version_id`，可回退到上一版本。

- 暂停 / 继续 / 放弃在批次或分区步骤之间生效；worker 重启从已提交断点继续。
- 共享内存、内存、连接数不足自动重试 5 次（1→15 分钟）；磁盘满立即失败并提示。
- 一个 worker 进程一次只处理一个版本（全局 `WORKER_LOCK`）；每个数据集另有 `datasetLock(key)`，
  因此某个数据集在跑时，另一个数据集的放弃仍可立即删表。

## 存储与索引

每个版本两张按哈希分区的表：`stage_v<N>`（导入期，去重后按分区删除）和 `mappings_v<N>`（只读查询）。

| kind | 分区键 / 分区数 | 行 | 索引 |
|---|---|---|---|
| user-email | `lower(username)` / 16 | username, email_local, domain_id | username 前缀；(local, domain)；两个三元组 GIN |
| email-list | `lower(email_local)` / 4 | email_local, domain_id | (lower(local), domain)；(domain, lower(local))；local 三元组 GIN |
| phone-list | `digits` / 4 | digits（E.164，不含 +） | digits；reverse(digits) |

域名统一存在 `account_dictionary.domains`，三个数据集共用。

### 清洗规则

- **邮箱**：去首尾空白，按最后一个 `@` 切分，域名小写；空行、无 `@`、`@` 前后为空、含空白/控制字符、超长进入隔离。
  按（原样本地部分, 域名）去重：`John@x.com` 与 `john@x.com` 是两行，查询时忽略大小写并把原样相等排第一。
- **手机号**：去掉 `+`、空格、`-`、括号、点后必须全是数字；位数 6–15（E.164）；国家码不能以 0 开头。

## 查询稳定性

- 精确、前缀、尾号、域名列表都是 B-tree 区间读取（`ORDER BY … USING ~<~` 防止规划器改走 GIN）；
  域名列表与号码前缀/尾号用 keyset 游标（`meta.nextCursor` → `after`），任意深度都只扫一段索引。
- 片段 / 近似先用抽样三元组估算候选量，超预算直接 `422 query_too_broad`；全 Hub 共 4 个慢查询槽（advisory lock），
  等待 1.5 秒仍满返回 `503 <platform>_busy`；语句超时快通道 3 秒、慢通道 2 秒。
- 手机号不提供片段查询：数字只有 10 种字符，三元组无法缩小范围。

## 实测（2026-11-06，本机 PG 17，完整文件、未限速导入）

| | 邮箱库 `email_only.txt` | 手机号库 `phone_only.txt` |
|---|---|---|
| 文件 | 340 MB，14,627,139 行 | 164 MB，12,569,400 行 |
| 隔离 | 0 | 2,938（位数 2,937，国家码 1） |
| 唯一 | 14,626,778（361 条只差域名大小写） | 12,566,462 |
| 表 / 索引 | 852 MiB / 1.38 GiB | 722 MiB / 756 MiB |
| 未限速导入 / 建索引 | 61 s / 132 s | 37 s / 68 s |
| 生产限速下导入（25k/s） | 约 10 分钟 | 约 8.5 分钟 |

从 `email-phone.zip` 直接导入（未限速）：前 750 万行 23.7 s（约 31.6 万行/秒，含解压），暂停后新 worker 继续，
首批 0.6 s（含重新解压 167 MiB）；最终计数与普通文件完全一致。

查询中位数：邮箱精确 1.3 ms、前缀 0.7–1.1 ms、域名列表每页 0.8 ms（gmail.com 连续 20 页共 35 ms）、
片段 3.7–7.6 ms、近似 15 ms（宽泛的 `john` 139 ms）；手机号精确 / 前缀 / 尾号 0.3–1.3 ms。

## 运维

### 首次启用宿主机文件读取

在 Internal 主机同步新版 Hub 代码，在 `electron-dock/mx-insight-hub` 目录执行：

```bash
sudo bash scripts/manage.sh install-host-file-reader
MX_INSIGHT_SYNC_LAUNCHER=0 MX_SMOKE_DATA=0 bash scripts/manage.sh deploy
systemctl is-active mx-insight-file-reader.socket
```

宿主服务由 systemd 按请求激活。Admin 和 dictionary 通过专用 Unix 套接字访问它。
需要在备份或迁移主机时保留 `/var/lib/mx-insight-file-reader` 的引用索引，以便已保存的计划能继续找到原文件。

旧版安装若出现 `status=216/GROUP` 且 `getent group 1000` 无输出，原因是 systemd 239
在启动 socket 时尝试解析宿主组。同步新版代码后，重新执行 `sudo bash scripts/manage.sh install-host-file-reader`。
新版 unit 在每次绑定后直接设置数字 GID 1000。安装器会检查 socket 的属主、属组和权限
为 `0:1000:660`，并验证读取服务能响应。修复这项宿主安装故障只需重跑安装命令。

### 运行时使用任意数据盘

1. 在「手机号库清洗计划」的「服务器路径」中粘贴真实绝对路径，例如
   `/data/shared-archives-20260909/email-phone.zip`。包内文件填 `phone_only.txt`。
2. 点击「校验并保存」。服务按需打开文件，Hub 保存文件引用和 ZIP 条目。下一份文件在其他已挂载磁盘上时，直接换路径即可；无需登记目录、复制 ZIP、编辑 `.env.internal` 或重新发布。
3. 点击「开启」创建版本。worker 校验整个源文件的 SHA-256 并流式读取选中的条目。
   原文件必须在该版本读取期间保持可访问且内容稳定；改名或替换源文件后，请重新校验并开启新版本。

宿主服务以独立非 root 身份运行，只接受普通数据文件和数据集支持的扩展名，不跟随软链接。磁盘需要已经挂载在 Internal 主机上；服务身份需要能够进入上级目录并读取文件。系统目录、隐藏路径和伪文件系统受限制。
遇到 `server_file_host_unavailable` 时检查 `systemctl status mx-insight-file-reader.socket mx-insight-file-reader.service`；遇到 `server_file_unreadable` 时检查文件及其上级目录的权限。首次请求前，socket 可以已激活而 service 尚未启动。

### 已有的挂载来源

已保存的 `internal`、`shared-dir` 或 `email-phone-archive` 来源继续按原设置读取。
清洗计划仍支持用根目录 ID 和相对路径指定已有来源。通用服务器文件导入继续使用
`MX_INSIGHT_SERVER_FILE_ROOTS`。文件数据集的宿主机读取只用于清洗管理操作与 dictionary worker。
