# 内网统一登录：部署、重启与迁移

日期：2026-10-03。范围：Launcher 内网个人管理登录，使用现有账号与密码；尚未在生产部署验收。用户已说明 Launcher 暂无公网地址，本批不增加公网入口。

阅读时点：上句及下文记录早期内网批次。后续已新增 [Hub 与飞书 Web](40-hub-sso-and-feishu-web.md)、[公网身份与证书](41-public-identity-and-certificates.md) 和 [网页登录会话撤销](42-browser-session-lifecycle.md)。已配置公网身份的环境按这些增量文档维护，不重复首次初始化或轮换原身份档案。

## 一条命令开启，后续沿用原 deploy

同步完整、已提交代码到服务器后，在 Launcher 目录执行一次（需当前部署使用的 Linux root 权限与 openssl）：

```bash
bash scripts/manage.sh ops identity on
```

`on` 自动执行原 `internal-production deploy`，无需手填 OIDC 密钥、开关或再单独运行 deploy。它共用原部署锁、构建、迁移、API 滚动更新和登录检查；不是只修改一个开关，也不是跳过原检查的轻量重启。构建需要的代理、临时目录等仍继承当前部署环境，例如这台服务器可以使用：

```bash
TMPDIR=/data/tmp MX_LAUNCHER_BUILD_PROXY=http://127.0.0.1:7789 \
  bash scripts/manage.sh ops identity on
```

首次开启时，在原主机/集群恢复后、构建镜像前：

1. 已有身份档案就复用原地址。首次则优先使用当前 ConfigMap 中管理入口的本机私有 IP，否则使用本机 Kubernetes 节点的唯一内网 IP；默认端口 18443。
2. 检查是本机单节点集群，地址实际存在；检查 TCP 监听和全部命名空间的 Kubernetes hostPort/hostNetwork 端口预留。被其他服务占用就停止，不停服务、不自动换端口。已属于本身份 Deployment 的 Pod 可复用。
3. 自动生成 OIDC 客户端密钥、RS256 签名密钥、Cookie 签名密钥、内网 CA 与 HTTPS 证书，持久保存，然后继续部署并验证 HTTPS/SSO。

地址必须是**本机已有、管理员和 Launcher Pod 均可达的私有 IPv4**。脚本不会创建 IP、改变 VPN、修改路由或开放防火墙。没有公网 DNS/域名也可使用。若自动选择的地址不适合管理员访问，或首次发现 18443 被占用，可以在尚未生成档案时明确指定，例如：

```bash
bash scripts/manage.sh ops identity on https://10.88.88.88:18543
```

已经保存的 issuer 地址不能用另一个 `on` 覆盖，需按迁移流程处理。预检和工作负载实际启动之间端口仍可能被其他进程抢占；部署会等待真实就绪检查，失败不会报告成功。生成的档案保存在：

- `/var/lib/mx-launcher/identity/profile.json`：600 权限，目录 700；含私钥，需作为机密备份。
- `/var/lib/mx-launcher/identity/ca.crt`：公开信任根，供管理员导入证书信任。

重复执行 `on` 会再次运行原部署并复用原文件，不重置密钥；中途失败后可重试 `on` 或原 deploy。今后使用现有 `ops internal-production deploy`，或在 Launcher 的“服务与部署”重新生成计划后部署，都会自动检查、维护身份服务，无需再开启或填写 `MX_ADMIN_SSO_*`、手建 OIDC client/Secret。

初次开启保留为显式操作，普通 deploy 不自动为未启用的安装选择 issuer 或增加登录入口。资源预算为单个身份进程请求 50m CPU / 128Mi 内存，上限 500m / 384Mi；这是配置预算，并非实测占用。首次仍需要确定长期使用的地址和管理员的 CA 信任。每次 deploy 的计划与未启用提示会列出开启命令，新主机部署也能看到该事项。

仅希望先生成配置、稍后部署时，原 `ops identity init https://10.88.88.88:18443` 仍可使用。`init` 只生成档案，不启动服务；`on` 是推荐的完整开启入口。

**管理员首次使用需信任该 CA**，再打开 `https://10.88.88.88:18443/admin/`。从可信服务器取回 `ca.crt`，核对 `identity status` 打印的指纹后导入操作系统/浏览器信任；不要把 `profile.json` 交给普通客户端。自签内网 CA 无法自动成为所有浏览器的信任根。这一步仅适用于新个人管理入口，不要求原 H2I/Luopan 用户操作。

原 HTTP 管理入口和 Ops Token 应急访问保留。已启用身份服务后，旧入口的“个人账号”区显示“打开安全管理入口”，不在 HTTP 页面启动 Secure Cookie 登录。

## 文件保存在哪里

| 内容 | 持久保存位置 | 容器重建后的处理 |
| --- | --- | --- |
| 完整身份档案，含 CA 私钥、OIDC 密钥、证书、安装标识 | 宿主机 `/var/lib/mx-launcher/identity/profile.json`（600，目录 700） | deploy 读取并复用，不在镜像构建时生成 |
| 身份服务需要的配置、服务证书/私钥、公开 CA | Kubernetes Secret `mx-identity-runtime`、`mx-identity-ca`、`mx-launcher-admin-sso` | 新 Pod 重新挂载；运行时不获得 CA 私钥 |
| 用户、绑定与身份会话 | 原 PostgreSQL 数据库/PVC | 复用持久数据库，不随应用镜像删除 |
| 完整身份档案及运行时 Secrets 的本机恢复快照 | 宿主机 `/var/lib/mx-launcher-recovery/latest.json` 与变更时的历史快照（600） | 同一原集群部署时可恢复丢失文件/Secret；已有配置不覆盖 |

普通 Docker 镜像重建、Pod 替换和服务器重启不会删除这些宿主机文件、Kubernetes Secret 或数据库卷。部署在身份预检/初始化后、以及身份服务就绪后 **API 滚动更新前** 就保存检查点，因此后续检查失败也保留本批凭据。相同内容重复部署不会增加快照；只有凭据、证书等内容变化才形成新版本。完整 CA 私钥只在宿主机私有档案和私有备份中，不同步进应用容器或普通管理接口。

本机快照不是异机灾备。迁移或重装系统仍须把上述私有档案、恢复目录及数据库/业务数据备份到另一块可靠存储；删除宿主机数据目录、etcd 或数据库卷属于数据删除，不能靠重建容器恢复。

## 登录与身份兼容

使用已有 MX 账号密码登录，大小写、别名冲突、密码哈希与账号停用沿用原语义。身份进程只查询旧 `iam-user` / `iam-user-credential` 记录，不复制账号、不写入密码、不触发网络开通；`sub` 使用原不可变 `userId`。Launcher 仅对显式配置的自管 issuer 自动建立映射，无需再输入一次密码关联。外部 IdP 仍采用原来的验证后关联流程，不按姓名/邮箱自动合并。

具有原 `mx-admin` 角色的个人账号可进入管理功能，普通用户不会因登录获得管理员权限。历史演示账号 `usr_demo_admin` / `usr_demo_user` 不允许用于个人登录；新安装如只有演示账号，应先通过原应急管理入口创建一个个人管理员。不会自动给其他用户提权。

协议引擎采用固定版本 `oidc-provider@9.12.2`，不是自行编写 OAuth 协议。它提供标准授权码、PKCE、发现与签名；MX 实现现有账号校验、持久化适配和登录页。[引擎官方项目](https://github.com/panva/node-oidc-provider)。首批只静态登记 Launcher 客户端，允许 code + S256 和 `openid`，关闭动态客户端注册；没有开启公共注册、其他产品接入或密码修改接口。

新表 `mx_identity_records` 单独保存身份会话、授权码、授权记录和限流计数；按环境/issuer 隔离，按过期时间清理。授权码单次消费由数据库原子更新保证，多副本不能各兑换一次。已有用户和业务表不迁移；Launcher 自己的管理会话/映射仍保存在现有 SSO record kinds 中。

“退出当前工作台”仍只退出 Launcher 当前浏览器会话。全局退出、MFA、密码找回、飞书 Web 登录/绑定、邀请注册与 Hub 接入是后续阶段，不能把当前内网试点直接暴露成公网身份平台。

## 部署和服务器重启

原 deploy 的新增顺序为：

1. 原依赖与主机/集群恢复步骤完成；在同一部署锁内预检身份档案、地址、端口，`on` 首次生成档案；随后完成原镜像构建、数据库与迁移步骤。
2. 读取身份档案，核对已有 Kubernetes 资源的安装标识、issuer、密钥与 CA；有冲突就停止，不接管另一套 SSO。
3. 幂等配置 `mx-identity-runtime`、`mx-identity-ca`，启动独立 `mx-identity` Deployment。复用本次 Launcher 镜像但运行独立 Node 进程，限定 CPU/内存和数据库连接池，不持有 Kubernetes ServiceAccount Token。
4. 身份进程就绪后写入 `mx-launcher-admin-sso`，再按原流程更新 Launcher API。API 自动挂载并信任该 CA。
5. 从未进入退出阶段、已就绪的 Launcher API Pod 内依次检查配置/CA、本机 SSO 接口、HTTPS OIDC discovery 和 HTTPS 管理转发。只对连接超时、Pod 替换等暂时失败做有限重试；失败输出检查阶段和错误代码，不输出凭据或响应正文，也不自动重复部署。

身份 Deployment 使用持久 Secret 和 PostgreSQL，机器或 Pod 重启后由 Kubernetes 拉起，无需再跑 init 或设置开关。进程重启不会重建签名密钥或丢失数据库会话；独立身份进程更新时新登录可能短暂不可用，已有 Launcher 会话仍由 API 验证。

叶证书有效期一年，每次 deploy 在剩余不足 30 天时使用原 CA 续签；CA 有效期十年，临近到期要求计划轮换，不静默更换客户端信任。**当前不是定时自动续证**，长期不部署时需通过状态检查安排维护。重启本身不会运行证书更新命令。

```bash
# 查看本机部署档案和证书到期时间，不输出密钥
bash scripts/manage.sh ops identity status

# 只读诊断：Node/系统 OpenSSL 版本、CA/签名/IP/两组密钥匹配结果，不输出密钥
bash scripts/manage.sh ops identity doctor

# 从 API 容器验证真实 HTTPS/发现/启用状态
bash scripts/manage.sh ops identity check
```

尚未 init 的现有部署继续使用原登录。原单机恢复检查点包含完整身份档案及三个身份 Secret，并保留安装归属标识；检查原主机挂载、集群、数据库及凭据一致后可恢复丢失的主机档案。没有可用快照且发现已运行的自管身份服务时拒绝重新生成密钥；它不能替代异机备份。

若日志已经显示身份服务就绪和 API `successfully rolled out`，最后检查失败并不代表前面的部署被撤销。先运行 `ops identity check`：`configuration` 表示配置或 CA 挂载，`local-session` 表示 API 本机 SSO 状态，`discovery` 表示 API Pod 到 HTTPS 身份入口，`https-session` 表示 HTTPS 入口转发回管理 API，`pod-exec` 表示无法选中/执行就绪 Pod。不要用反复初始化密钥处理网络或检查错误。

### OpenSSL 1.1.1 初次 CA 生成失败的恢复

若旧版本首次部署在 `ensure configured identity service` 报“身份 TLS 证书/密钥不匹配”，而诊断显示仅 `caValid: false`，其余四项为 `true`，可能是旧生成命令与主机 `openssl.cnf` 的 `x509_extensions` 叠加，形成重复的 `basicConstraints`。已用原生成代码 + OpenSSL 1.1.1w + Linux 风格默认配置复现这一问题，Node 内置 OpenSSL 3.5.4 会判定该 CA 无效；不是密码或私钥配错。[OpenSSL 1.1.1 的扩展合并实现](https://github.com/openssl/openssl/blob/OpenSSL_1_1_1w/apps/req.c#L715-L729)。

新生成流程使用独立的 OpenSSL 配置和唯一扩展节，生成后立即校验，避免构建结束才发现问题。同步修复版本后直接重试原 deploy 或 `ops identity on`：在构建前、部署锁内检查是否确属上述重复扩展，且集群尚无任何身份 Deployment/Secret 或 SSO 配置，满足条件才自动修复。

修复先保存唯一的 600 权限备份 `profile.before-ca-repair.json`，保留 issuer、安装标识、OIDC 密钥、CA 私钥、CA 序列号和原服务证书/私钥，仅重签异常 CA 证书并验证完整 TLS 信任链。重复部署不会再次修复或不断增加备份。真正的密钥错配、不同旧备份、无法查询集群或已有 SSO 资源都会停止，不自动更换现网信任根。

**修正后的 CA 证书指纹会改变；如已导入旧 `ca.crt`，需重新导入服务器导出的新文件。** 不要删除 `profile.json` 重新初始化。原 HTTP/Ops 入口及 H2I/Luopan 登录与网络配置不参与这次修复。

## 新服务器与恢复

必须区分“全新独立安装”和“把原系统搬到另一台服务器”：后者要保留原用户、租户、数据和身份，不能重新 init 空系统。

```bash
# 原服务器：目标目录须为私有目录，目标文件不能已存在
install -d -m 700 /root/mx-backup
bash scripts/manage.sh ops identity export /root/mx-backup/identity.json

# 新服务器：用安全方式取回备份，保持文件 600 权限
bash scripts/manage.sh ops identity restore /root/mx-backup/identity.json
```

还必须按原恢复流程备份/恢复 **Launcher 完整数据库、原集群/应用 Secrets、业务文件与部署配置**。身份档案备份包含密钥和证书，不包含用户、租户、数据库会话或业务数据；这些在数据库中。恢复档案之后复用原 issuer 地址，再运行已准备环境的原 deploy，自动登记身份服务及 RP 配置，不逐个填环境变量。

如果新服务器不能沿用原内网 IP/端口，应先制定 issuer 与访问地址迁移；直接改地址会影响旧会话、客户端回调和信任。恢复检查不会为了“省一步”自动改 CA、用户 ID 或数据库身份。

**本批没有实现空白 Linux 上的一键安装 Kubernetes、Docker、数据库及所有子系统。** 原 `internal-production` 的单机恢复保护仍要求正确的集群、挂载和数据库身份；不能拿旧机器的恢复快照强行覆盖新集群。基础设施准备及各产品数据恢复仍按原 runbook，总体编排继续遵循文档 34。身份这一层已经做到一份档案、自动生成凭据、幂等接入和可恢复。

## 验收范围与后续

本地隔离 PostgreSQL + 真实 HTTPS 协议测试覆盖：原密码/大小写语义、CSRF、RS256、PKCE、单次授权码、授权码兑换前重启、SSO 会话重建、账号停用、跨重启限流、并发单次消费与原用户记录不变。管理端回归覆盖自管主体自动映射、未知主体拒绝、普通用户无管理权、原外部绑定和 Ops 通道。

部署替身验证重复 on/init/apply/restore、密钥和 CA 不变、档案丢失拒绝、外部资源不覆盖、凭据不打印和 Secret 恢复归属保留。开启测试还覆盖地址发现、已启用安装的 Pod 归属检查、其他 Pod 端口预留、真实本机端口占用/释放，以及开启失败中止构建与保留原部署参数。真实 Linux hostPort、CNI 回环可达性和服务器重启仍需目标环境验收。

浏览器验收使用隔离 PostgreSQL、真实 HTTPS 身份服务和真实 Launcher BFF 中间件，Chrome/Playwright（Browser plugin not available），地址 `https://127.0.0.1:18494`。1440×960 与 390×844 下验证旧 HTTP 入口跳转、登录页渲染、错误密码提示与密码清空、原账号登录免二次关联、个人管理请求授权和退出。没有脚本异常或横向溢出；401 为主动输入错误密码的预期响应。管理落地页用最小测试容器承载真实 `admin-session.js`，不是生产全量管理页面验收。测试证书仅在隔离浏览器上下文忽略证书错误，服务端通过显式信任测试 CA 完成正常 TLS 校验；生产仍需管理员信任生成的 CA。

运行 `pnpm --dir server test:identity`；真实数据库用例只接受显式 `MX_SSO_TEST_DATABASE_URL`，要求回环主机与名称含 `sso_test` 的独立数据库，未设置时会明确跳过，不读取生产数据库配置。发布验收须把数据库用例实际跑过，不能把跳过视为通过。

身份进程虽然独立且有资源预算，本批仍使用 Launcher 数据库凭据，只在实现中对旧账号做只读查询；不是独立数据库权限边界。对外开放前需完成凭据最小权限、限流/审计运营、身份管理恢复、全局撤销等验收。后续账号切换、内网邀请注册及公网 Hub 接入边界见 [文档 39](39-registration-and-account-switching.md)。Hub 成员/租户无感关联、飞书 Web 接入仍待后续交付。
