# Internal 搬迁与重启后的 deploy 恢复

状态：2026-09-21，面向已经部署过的 **单节点 Linux kubeadm + containerd + PostgreSQL 16**。
入口仍是 `scripts/manage.sh ops internal-production deploy`。首次安装空数据库、迁移到另一
集群/磁盘、数据库灾难恢复，不等同于重启恢复；本入口不自动推断这些操作。

## 日常恢复命令

在原服务器以 root 执行，目录为 `electron-dock/mx-launcher`：

```bash
TMPDIR=/data/tmp \
MX_K8S_OS_HOSTNAME=mx-internal-server \
MX_K8S_APISERVER_ADVERTISE_ADDRESS=192.168.1.2 \
MX_SHADOW_BUILDKIT_KEEP_STORAGE=2GB \
MX_SHADOW_BUILDKIT_PRUNE_UNTIL=24h \
bash scripts/manage.sh ops internal-production deploy
```

IP 改变时修改 `MX_K8S_APISERVER_ADVERTISE_ADDRESS`。如下载需要代理，在同一命令增加
`MX_LAUNCHER_BUILD_PROXY=http://127.0.0.1:7788`。这是构建/下载代理，不写入应用运行环境，
也不改 MX-H2I WireGuard、Hysteria、用户路由或飞书回调地址。

**更新代码后，应在当前服务正常时执行一次 deploy，建立原始身份和 Secret 恢复记录。**
没有备份的旧凭据无法通过重启凭空找回；这次曾经丢失的旧 Ops Token 不会因此重新有效。
后续保留的是现在集群实际使用的值。健康重复执行不会轮换 Token，显式在环境或 `.env`
设置 `MX_INTERNAL_OPS_TOKEN` 的既有主动轮换行为仍保留。
首次应用新增的 PostgreSQL 启动保护会更新 Pod 模板并重建数据库 Pod，存在短暂不可用；
请在合适的维护时段执行。后续模板相同时不会因该保护额外重启数据库。

## 本次事故与处理归纳

| 现象 | 原因/证据 | deploy 处理 |
| --- | --- | --- |
| 地址还是 `.4`、新主机为 `.2` | kubeadm 文件、Node、kube-proxy、Flannel 保存旧地址 | 沿用节点身份，同步配置与证书 SAN；变更前备份；检查直连 API 和 API Service TLS |
| kubelet Unauthorized、Node 不更新 | 旧节点客户端证书不再受当前 CA 信任 | 校验原节点、CA、证书时间；只对已证实失效的客户端证书签发替代，先验证再安装，恢复自动轮换 |
| 重启后主机服务未运行 | containerd/kubelet/Docker 未启动 | 核对数据挂载之后启动 inactive 服务；健康服务不因此重启 |
| PostgreSQL `FailedCreatePodSandBox` | Flannel API 不可达或 `/run/flannel/subnet.env` 缺失 | 修复 Flannel API；已就绪但租约仍缺失时，限一次重启 Flannel 并等待；不手写租约 |
| Pod 已 Running 但服务不可达 | kube-proxy / DNS 链路异常 | 验证 Service 转发，等待 CoreDNS，最后检查应用健康与就绪接口 |
| `mx-launcher-db missing`、旧 Ops Token 失效 | PGDATA 仍在，etcd 中的 Secret 丢失，之前 deploy 为缺失的 Ops Secret 生成了新值 | 同集群/原数据身份下从私有恢复记录补回缺失 Secret；不覆盖已有 Secret；首次无备份又缺原 DB/Ops Secret 时停止 |
| 飞书、SDK 或 OSS 配置缺失 | 配置/凭据可能仅存在 K8s Secret，未保存在 `.env` | 保存并恢复曾经存在的对应 Secret；从未观察到的配置无法恢复。生产 deploy 默认要求飞书配置齐全，缺失时在构建和应用部署前停止 |
| 员工 `invalid credentials` | 当前数据库中账号不存在/歧义、不活跃、凭据缺失或密码不匹配；也可能连接到旧库 | 用只读诊断核对实际 API 数据库和账号，不能通过换 PVC、重置用户或自动选库解决 |
| PV `immutable` 错误 | 已恢复 PV 的 `Directory` 与模板 `DirectoryOrCreate` 不同 | 校验并保留现有 PV；不自动删除 `Released/Failed` PV，不清除 claimRef |
| `Unexpected non-whitespace ... JSON` | kubectl 对多份 YAML 输出连续 JSON 文档 | 按文档解析，兼容 List；错误时停止而不创建部分 PV |
| `ErrImageNeverPull` / 镜像已导入却找不到 | 镜像进入错误运行时，或被 kubelet GC 回收；事故时磁盘使用 94% | 发现 kubelet 的真实 CRI socket；导入后比对 Docker/CRI image ID；rollout 失败且本地缓存镜像缺失时补导一次 |
| `host-gateway is not supported` | docker-container BuildKit 不支持该用法 | 代理 builder 使用 host network；不添加 host-gateway；不修改全局 Docker 代理 |
| Caddy upstream patch 失败 | 实际有两段带 block 的 reverse_proxy | 同步两段 API upstream，保留转发头策略，用内容摘要驱动更新 |
| `/admin/` 可访问，管理列表 Unauthorized | Connected 只证明连通，浏览器仍填旧 Token | deploy 末尾用当前 Secret 对运行 Pod 做只读管理鉴权检查；提示从现有 Secret 读取 Token，不输出明文 |

宿主机 Nginx 与 Caddy 可共存。本恢复流程不重写宿主机 Nginx、公网入口、飞书回调或用户联网配置。
该栈的数据服务是清单中的 PostgreSQL；不会顺带启动其它项目的 Redis/Docker 数据库。

## 执行顺序与停止条件

1. 原有发布测试、类型检查通过后，取得本机 deploy 锁，使用本机 `/etc/kubernetes/admin.conf`。
2. 核对 fstab 中相关挂载、实际文件系统 UUID/挂载根、PG_VERSION、PG system identifier、
   etcd 数据和 CA。初次记录原身份；后续任何不一致立即停止。随后启动 inactive 主机服务。
3. 修复 API 地址、kubelet 认证、kube-proxy、Flannel；确认原节点 Ready。
4. 所有关键 Secret 完整读取成功后，才决定是否补回缺失值。API 超时/拒绝访问不是“缺失”。
   校验原 cluster UID，缺失 Secret 用 `create`，不会 `replace` 已存在的值。
5. 建立私有凭据快照；校验 Secret 输入、所需登录配置与 PV/PVC；检查磁盘压力，再构建和导入镜像。
6. 在应用工作负载前再次检查原磁盘身份。给 PostgreSQL StatefulSet 加入原节点约束与
   启动检查，只有现存 PostgreSQL 16 数据目录、control file、base 目录齐全才进入原入口。
   这个检查保留在工作负载内，因此后续 kubelet 重启 Pod 时也禁止初始化空库。
7. 等待数据库、执行既有迁移、等待 API/Caddy、健康检查、只读 Ops 鉴权和所需飞书配置检查，保存最终快照。

不会自动 `kubeadm reset`、恢复整个 etcd、换 CA、选择某个历史数据库副本、初始化空库、
删 PV/PVC/卷、降低磁盘回收阈值、清用户数据，或为了绕过鉴权生成新 Ops Token。
挂载缺失时不会盲目 mount 覆盖一个可能已经写入数据的目录。磁盘压力导致反复回收、CNI 仍
不可用、系统/GPU 驱动异常等，输出诊断后停止。处理真实原因再重跑同一个 deploy。

kubelet 自动签发限于可读取的原 kubeconfig、当前有效 CA 和 CA key、相同原节点、已开启
`rotateCertificates`。未来时间证书提示先校时；配置/私钥文件缺失、CA 过期、身份不明时停止。
API/RBAC 错误不会触发盲目换证书。初次安装失败回退配置并尝试启动 kubelet；已验证的新配置
安装成功而轮换暂未完成时保留新配置，下次 deploy 可继续接回轮换文件。

首次安装请走原有集群初始化及 `k8s apply internal-shadow` 的受控安装流程，核实数据与凭据后
再启用此恢复入口。不要为消除身份不匹配报错而删除恢复记录；真实迁移需要人工核对和独立备份。

## 恢复记录与数据安全

默认记录在 **`/var/lib/mx-launcher-recovery`**，目录 `0700`、文件 `0600`，仅 root 可读：

- `host.json`：原节点、CA 指纹、文件系统/挂载身份和 PostgreSQL system identifier。
- `latest.json`：同一集群最近一次有效 Secret 集合和校验摘要。
- `secrets-*.json`：凭据变化时保留的历史版本；不会覆盖唯一旧副本。

包含 `mx-launcher-db`、`mx-internal-ops`、`mx-feishu-oauth`、
`mx-sdk-service-account-secrets`、`mx-release-oss`、存在时的 `mx-insight-hub-admin`。
缺失曾保存的 Secret 时禁止用不完整集合覆盖最后快照。文件采用临时文件、fsync 和 rename
提交。恢复时校验摘要及原主机/集群身份，日志不打印 Secret 的 data。

**这些文件包含可还原的凭据，不能提交 Git、贴聊天或放入普通日志。** 应与数据库、etcd 和
`/etc/kubernetes` 的受控异机备份一起保存；本机 Secret 快照不是数据库备份，也不能防磁盘损坏。
脚本不会在运行中的 PGDATA 上执行文件复制来冒充一致性数据库备份。
通过其它工具轮换 Secret 后，应再次 deploy 更新恢复记录。若要撤销凭据，应明确轮换为新值；
单纯删除受保护的 Secret 后运行 deploy，会按本恢复约定补回旧值。

本次实际落盘关系：

- PostgreSQL：`/var/lib/mx-launcher/k8s/postgres/pgdata`，通过挂载落到
  `/data/mx-runtime/mx-launcher/k8s/postgres/pgdata`。
- PV/PVC、Secret 等 K8s 元数据：etcd，`/var/lib/etcd` → `/data/mx-runtime/etcd`。
- Docker 镜像/容器：`/data/docker`，与上面的 PostgreSQL 数据路径相互独立。

验证到同一个 PG system identifier，只证明数据库实例身份；不能证明业务记录是最新、完整的。
本次曾出现记录更新时间与用户最近使用时间不符的疑问，不能以 deploy OK 替代数据完整性核验。

### 已确认接到了旧库：先定位，不能继续自动恢复

本次后续确认：恢复库没有实际生产中的 SMH、SQB 等用户。因此此前的挂载/实例校验只能
证明“再次使用了同一份目录”，**不能证明这就是最新生产数据**。当前恢复身份记录也可能已
记录这份旧库，不能据此宣布数据恢复完成。

已知过程是从 7 月 6 日的 etcd 副本取回数据库 Secret，再按清单启动已有
`/var/lib/mx-launcher/k8s/postgres/pgdata`；该目录在启动前就显示旧时间，业务最新记录到
7 月 2 日。恢复 Secret 本身没有把 PostgreSQL 回滚到某个日期；它与清单共同使应用连接
到了这份旧数据。原凭据可连接、PGDATA 完整，都不足以判定生产库来源正确。

这时暂停 deploy、迁移和用户管理写入，不清理镜像/容器/卷，也不要直接启动任何离线原件。
先运行只读清单（无需构建或 deploy）：

```bash
KUBECONFIG=/etc/kubernetes/admin.conf node scripts/k8s-database-inventory.mjs
```

- 查看现存及停止 Docker 容器的数据库地址、显式存储模式和挂载；地址中不输出用户名/密码。
- 对运行中的 Docker/K8s PostgreSQL，从本地 socket 以只读事务检查所有可连接数据库，
  不按库名 `mx_`/`mx-` 前缀筛选；查找各 schema 的 `mx_platform_records` 和 SMH/SQB 线索。
  不能认证、没有权限、超时或非标准 socket 的实例会标记为“未核实”，不是“没有数据”。
- 对停止容器、匿名卷、`/data/k8s`、已知挂载及 containerd 快照的常规 PostgreSQL 路径只读
  文件元数据和实例标识。目录扫描限制深度、数量和时间，遇到上限明确标记；跳过符号链接和
  任意镜像层遍历，不启动 PostgreSQL、不挂载快照，不执行全盘内容搜索。
- 当前 K8s 模板使用 PostgreSQL；代码的 memory 模式只存在于进程内。是否曾使用 memory
  必须以原服务实际配置为证，容器环境未显式设置不代表实际用了 memory（还可能加载 env 文件）。

找到候选后，先确认独立备份容量与来源，再验证副本。停止实例的完整冷备需要核实没有任何
进程在使用原目录，并覆盖外部表空间/WAL 链接；运行实例使用一致性逻辑/物理备份，不直接
复制活动中的 PGDATA。以 SMH/SQB、近期业务记录、环境、用户凭据及部署来源共同确认权威库。
切换前也备份目前旧库，避免遗漏恢复期间新增的记录；不自动合并两库。

只有完成核验后才制定明确的数据库/PV/Secret 切换和回退步骤，并更新已核实的恢复身份。
不要删除 `host.json` 绕过保护、按目录修改时间自动选库，或将一个库的文件覆盖到另一个库。
这份只读清单不执行切换，也不能单凭“未命中”判定新数据未落盘或已丢失。

## 员工/飞书登录失败时

PVC UID 是 Kubernetes 资源标识，不参与用户密码校验。当前实现将员工密码的 scrypt 哈希、
盐和参数一起保存在 PostgreSQL 的 `iam-user-credential` 记录中；正常重启和 deploy 不会
重新生成这些密码。Ops Token 是管理接口的独立凭据，换它不会直接造成员工 `invalid credentials`
或 `Feishu OAuth is not configured`。

密码登录按大小写精确解析账号（含旧别名），同一环境有重复匹配也拒绝登录。先核对账号是否存在、
是否 active、是否有 local-password 凭据，再核对数据库来源和修改时间。记录最新时间曾停在
7 月 2 日，而实际使用到 9 月，这个疑点必须继续核实；不要先改密码来掩盖旧库/错库问题。

更新代码后，在部署服务器的 `electron-dock/mx-launcher` 目录运行；无需重新构建或 deploy：

```bash
node scripts/k8s-login-diagnose.mjs SMH
```

命令读取原 PV/PVC、飞书 Secret 的字段存在状态，以及各 Ready Internal API Pod **实际使用的**
数据库地址（去掉用户名/密码）、环境、数据库实例标识、账号匹配数、状态、凭据存在状态和时间。
SQL 使用只读事务，不提交登录、不调用会写审计的密码校验方法、不读取/输出密码哈希值。
它还在 `server/.env*`、`/var/lib/mx-launcher-recovery` 及已知 `/data/mx-recovery` 子目录查找
飞书恢复线索，只输出字段是否存在；这不是全盘扫描或凭据有效性验证。输出可以用于排查，私有源文件不能贴出。

飞书启动报未配置时，需要恢复**原飞书应用**的 App ID、App Secret 和租户允许列表。
先核对历史 Secret/私有 env/恢复快照；若未备份这些值，需要从原应用的管理配置中找回。
不要通过创建另一个应用、随意生成新密钥或换 PVC 处理。核实后，把原值补入服务器私有
`server/.env` 的 `MX_FEISHU_APP_ID`、`MX_FEISHU_APP_SECRET`、
`MX_FEISHU_ALLOWED_TENANT_KEYS`，保持权限 `0600`，再执行正常 deploy；不能把这些值提交 Git。
原飞书重定向白名单也需要保持有效。

生产 deploy 默认 `MX_INTERNAL_REQUIRED_LOGIN_PROVIDERS=local-password,feishu`，与本系统两种
登录都在使用的要求一致。飞书配置缺失时不再仅警告并继续部署；原值可从已保存的 Secret 快照恢复，
或由私有 env 补齐后通过检查。**当前没有备份的原配置，脚本不能凭空找回。**
只有确实从未使用飞书的其它安装，才可明确设为 `local-password`；不要以此绕过本次登录故障。
普通 `k8s apply` 不设置该变量时保持原行为。部署末尾还读取运行中 API 的飞书公开配置确认 enabled，
但不会模拟真实员工密码或飞书授权，因此仍需本人做端到端验收。

## 成功后的确认

正常日志应包括原挂载验证、kubelet 认证验证、CRI 镜像验证、private recovery checkpoint、
`current Ops Secret accepted` 和最终 `internal-production deploy OK`。
查看 Admin 时，从可信终端读取当前 Token，填入页面密码框；不要粘贴到反馈日志：

```bash
kubectl --request-timeout=15s -n mx-internal-shadow get secret mx-internal-ops \
  -o go-template='{{index .data "token" | base64decode}}{{"\n"}}'
```

最终健康检查、Ops 鉴权和飞书 enabled 不等于真实用户密码/飞书端到端验收。搬迁后仍需用测试用户分别验证
这两种登录及 MX-H2I 原联网功能，特别是公网回调、Nginx、DNS 或外部飞书配置也发生变化时。

实现与验证参考：

- [Kubernetes kubelet 客户端证书恢复](https://kubernetes.io/docs/setup/production-environment/tools/kubeadm/troubleshooting-kubeadm/#kubelet-client-certificate-rotation-fails)
- [Kubernetes 镜像垃圾回收](https://kubernetes.io/docs/concepts/architecture/garbage-collection/#containers-images)
- [PostgreSQL 16 control file 的 system_identifier](https://github.com/postgres/postgres/blob/REL_16_STABLE/src/include/catalog/pg_control.h)
- 本地故障测试覆盖凭据恢复/保留、API 失败、身份不匹配、证书时间/CA/回退、镜像可见性和
  一次重试、Flannel 租约恢复、deploy 阶段顺序。真实服务器重启、硬件故障和两种登录需要现场验收。
