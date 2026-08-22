# MX Launcher Platform Operations and Admin Design System Roadmap

本文档把 K8s、运维自动化、跨 Linux 发行版支持和 Admin 产品设计系统合并成一条
MX Launcher 后续主线。短期不建设 AI 训练平台，优先借鉴 K8s 和成熟运维系统能力，
把 MX Launcher 做成稳定、可观测、可审计、可回滚的 Internal 控制面。

Launcher Network 当前多产品 Dashboard、MX-H2I/Luopan 过滤与拓扑归属、Connections 抽屉、
Feishu 用户显示、产品级用户 ban/unban、blocked inventory、匿名 ProductNetwork 隔离、
静态 lease 与实时 WireGuard 状态的区分，以及未来安全下线状态机见
[28-mx-h2i-connection-operations-and-anonymous-governance.md](./28-mx-h2i-connection-operations-and-anonymous-governance.md)。

## 目标

MX Launcher 的平台边界保持三层：

- Launcher Runtime：桌面常驻、登录、设备身份、AppCenter、Launcher Network。
- Internal 控制面：User/RBAC、Config、Release、DNS、Admin、Runner、
  Observability、Test/Evidence，是唯一真相。
- Domestic / Oversea slot：接收 Internal 推送的模块化 artifact，运行 relay、
  proxy、cache、forwarder、mihomo、hysteria2 和 site-agent 能力。

新增平台能力不改变这个边界。K8s、AWX、GitOps、观测、安全、备份等系统作为
Internal 的基础设施能力接入；Domestic / Oversea 不保存平台主数据，不拉全仓库，
只执行已授权、已审计、可回滚的变更。

## 架构原则

### Internal 仍是唯一真相

PostgreSQL 继续保存 MX 的业务真相，包括用户、角色、配置、release、site slot、
runner job、worker report、evidence、audit event 和 gate verdict。

etcd 不直接作为 MX Config Center 的业务数据库。etcd 是 K8s 控制面存储，MX 应通过
Kubernetes API 间接使用它：

- ConfigMap / Secret 承载运行时配置投影，不承载完整业务真相。
- Lease 可用于 leader election、短租约和协调锁。
- CRD 可用于把 `SiteSlotPlan`、`ReleasePlan`、`RunnerJob`、`EvidenceBundle`
  投影成 K8s 原生对象，由 controller reconcile。
- K8s watch 结果要回写 Internal audit/evidence，而不是替代 Internal 状态机。

### AWX 是执行平面，不是真相源

AWX 接入后作为 `ExecutionProvider`：

```text
Admin / CLI
  -> Internal Site Slot API
  -> Runner Session / Worker Job
  -> awx-provider
  -> AWX Job Template
  -> Ansible Role / Playbook
  -> Domestic / Oversea / Internal host
  -> AWX Events
  -> Worker Report / Evidence / Audit
```

MX Admin 仍负责 RBAC、confirm gate、change window、release gate、rollback policy
和 evidence drawer。AWX 负责 inventory、credential、job template、Ansible execution
和 task event。

### slot 执行必须幂等

Domestic / Oversea 的执行动作要从远程 shell 字符串升级为 Ansible role / site-agent
job：

- 每个 role 能重复运行。
- 每个 task 能解释 `changed`、`failed`、`skipped`。
- 每个变更先有 plan/check 模式，再有 apply。
- 每个 artifact 有版本、hash、签名、来源和 rollback 对象。
- 每个失败都能落到 `worker report steps` 和 Evidence Drawer。

## K8s 能力引入路线

### 第一批：直接增强当前 Internal

| 能力 | 建议组件 | MX 用法 |
| --- | --- | --- |
| 自动化执行 | AWX / Ansible Automation Platform | Domestic / Oversea inventory、SSH credential、job template、task event |
| GitOps | Argo CD 或 Flux | Internal K8s、CoreDNS、AWX、Observability、Admin 后端声明式发布 |
| 指标告警 | Prometheus Operator、Alertmanager、Grafana | Release Gate、Test Center、Admin topology health |
| 日志链路 | OpenTelemetry Collector、Loki、Tempo 或 Jaeger | API、runner、worker、Launcher trace/log/evidence 关联 |
| 证书 | cert-manager | Admin、Internal API、Ingress、mTLS、site-agent 证书生命周期 |
| 密钥 | External Secrets、Vault、SOPS 或 SealedSecrets | SSH key、数据库密码、Hysteria2 secret、API key |
| 网络 | Cilium 或 Calico | NetworkPolicy、pod 隔离、流量观测、网络排障入口 |
| DNS | CoreDNS | Internal authority、split DNS zone、shadow apply、DNS evidence |
| 制品 | Harbor、MinIO | 镜像、artifact、snapshot、runner evidence、截图、release bundle |
| 备份 | Velero、Postgres Operator | Internal 数据和 K8s 资源备份、恢复演练 |

第一批目标是让现有 site-slot、Release Center、Observability 和 Test Center 更可靠，
不是先做复杂多集群。

### 第二批：平台化能力

| 能力 | 建议组件 | MX 用法 |
| --- | --- | --- |
| 工作流 | Argo Workflows 或 Tekton | E2E gate、synthetic probe、release pipeline |
| 灰度发布 | Argo Rollouts 或 Flagger | Internal/Admin/API 灰度、自动回滚 |
| 策略准入 | Kyverno 或 OPA Gatekeeper | 镜像来源、资源限制、Secret 使用、危险权限阻断 |
| 安全扫描 | Trivy、kube-bench、Falco | 镜像漏洞、CIS baseline、运行时异常 |
| 弹性伸缩 | HPA、VPA、KEDA | runner、probe、worker、API 按负载伸缩 |
| 事件总线 | NATS、Redpanda 或 Kafka | runner event、audit event、evidence event 扩展 |
| K8s 原生控制器 | Kubebuilder / controller-runtime | MX CRD projection、reconcile、drift detection |

### 第三批：远期扩展

暂不建设 AI 训练平台，但保留接口意识：

- 如果 AppCenter 未来出现 GPU workload，再评估 Kueue、Volcano、NVIDIA GPU Operator。
- 如果 H2O 或新应用需要分布式计算，再评估 Ray、Kubeflow 等平台。
- 这些组件不进入当前 MX Launcher 主线，避免把 Internal 复杂度提前拉高。

## AWX 接入分阶段

### Phase A：AWX shadow

- 在 Internal K8s 内通过 AWX Operator 部署 AWX，仅暴露给 Internal 后端。
- 固定 AWX 版本，不追随 `devel`。
- 本地 shadow 入口落在 `deploy/k8s/awx-shadow` 和
  `bash scripts/manage.sh ops awx-shadow plan|dry-run|install|status|port-forward|logs|password|down`。
  AWX 独立使用 `mx-awx` namespace；`down` 只 scale workload 到 0，保留 Secret 和 PVC。
- 建立 `awx-provider` 抽象，保留现有 `shell-ssh provider` 作为 fallback。
- `bash scripts/manage.sh ops awx-provider upsert|list|check` 是 Config Center provider
  registry 的本地运维入口。默认指向
  `http://mx-awx-service.mx-awx.svc.cluster.local`，真实 launch 仍需要
  `AWX_API_LAUNCH_ENABLED=true`、`confirmAwxLaunch=true` 和一次性 token。
- 当前代码先落地 `awx-shadow`：它是 Worker Contract V1 的 runner/provider mode，
  只记录 inventory、credential、job template、extra vars、task event 和 worker
  report evidence，不调用 AWX API，也不登录或修改 Domestic / Oversea。
- Config Center 维护 `awx-provider` registry：`baseUrl`、organization、
  project、inventory/credential/job-template 命名前缀、适用 slot kind 和启停状态
  都由 Internal 保存，shadow evidence 优先读取这份配置。
- Admin 提供 Oversea one-shot shadow setup：
  `POST /internal/v1/admin/oversea/:siteId/shadow-setup`。它会一次性 upsert SSH
  Profile、issue Internal mihomo/access accounts、创建 plan / preflight / apply、
  创建 `awx-shadow` runner、创建 AWX worker job，并记录 worker report evidence。
  这个路径是“后台设置完 Oversea”的当前 shadow 完整链路，不登录远端、不执行 AWX
  launch。
- Admin 提供 gated real launch：`site-slot.worker-run.awx-launch`。它要求
  `AWX_API_LAUNCH_ENABLED=true`、`confirmAwxLaunch=true`、active provider 和一次性
  AWX bearer token / `AWX_API_TOKEN`，然后调用 AWX job template launch，等待 job
  完成时拉取 job events，并回写 worker report。blocked gate 不创建 report；AWX
  已启动后的失败必须创建 failed report，供 Release Gate / Rollback 消费。
- Domestic relay peer append 也采用 AWX-first：Admin 先用
  `site-slot.domestic-relay-peer-append-awx.prepare` 创建 `awx-shadow` runner 和
  `awx-runner` worker job，readonly probe / peer handoff 审阅后先进入
  `site-slot.worker-run.awx-sync-plan`，生成 AWX organization / project / inventory /
  host / credential / job template 的 plan-only 清单；清单 ready 后先进入
  `site-slot.worker-run.awx-credential-sync`，在 env gate、confirm、token 和 active
  SSH Profile 都满足时，把 Internal 管理的 SSH Profile 同步成 AWX Machine
  Credential；再进入 `site-slot.worker-run.awx-object-sync`，受控创建/更新 AWX
  organization、project、inventory、host、job template，并引用已同步的 credential。
  对象同步完成后再进入
  `site-slot.worker-run.awx-launch`。`remote-ssh` prepare / execute 只保留为
  fallback 和现场排障。
- 手动同步一组 `oversea-sg-1` / `domestic-main` inventory、credential 和 job template。
- 将 AWX job id、status、stdout、event count 回写 worker report。

### Phase B：Config Center 到 AWX 的同步

- SSH Profile 已有受控同步入口 `site-slot.worker-run.awx-credential-sync`：默认 blocked；
  满足 `AWX_API_CREDENTIAL_SYNC_ENABLED=true`、`confirmAwxCredentialSync=true`、active
  provider、AWX token 和 active SSH Profile 后，才会把 `identityFile` 写入 AWX
  Machine Credential。
- Site Slot 同步成 AWX Inventory host/group。
- `awx-provider` registry 同步成 AWX API adapter 的 provider contract；当前已经支持
  list/check、sync plan、gated credential sync、gated object sync 和 gated launch。
  下一步补 AWX object / credential diff 和 drift report。
- `awx-provider` check 作为 launch 前置门禁：只读检查 AWX ping、organization、
  project、inventory、job template，并把 HTTP status、count、matched name、
  failures 暴露给 Admin Foundations 面板。
- Internal mihomo、hysteria2、domestic relay 参数作为 extra vars 注入 job template。
- Credential 由 Internal/Vault 管理，AWX 只拿最小可执行凭据。

### Phase C：Ansible role 化

建议拆分 role：

- `mx_common_preflight`：发行版、架构、systemd、sudo、网络、磁盘、时间、DNS 检查。
- `mx_container_runtime`：Docker / Docker Compose / Podman 兼容安装和验证。
- `mx_oversea_access`：hysteria2、mihomo、site-agent、subscription output。
- `mx_domestic_edge`：WireGuard relay、H2I proxy、API proxy、snapshot cache。
- `mx_observability_forwarder`：log/metric/trace forwarder。
- `mx_release_artifact`：artifact 拉取、hash 验证、签名验证、原子切换、rollback。

### Phase D：Evidence 映射

AWX task event 映射到 `worker report steps`：

- `task` -> `stepId` / `phase`
- `host` -> `siteId` / target host
- `changed` -> step changed flag
- `failed` / `unreachable` -> status 和 diagnosis
- `stdout` / `stderr` -> redacted evidence
- `duration` -> timing
- `playbook` / `role` / `jobTemplate` -> execution metadata

Evidence Drawer 应能展示 AWX job summary、task timeline、失败 task、host vars
摘要、redaction policy、rollback hint。

## Ubuntu / CentOS 支持契约

MX Launcher 的 Domestic / Oversea slot 必须支持 Ubuntu 和 CentOS / RHEL-family。
实现上不要假设某一个发行版，所有远端执行先走 preflight。

### 支持目标

| 维度 | Ubuntu | CentOS / RHEL-family |
| --- | --- | --- |
| 包管理 | `apt` | `dnf` / `yum` |
| 服务管理 | `systemd` | `systemd` |
| 防火墙 | `ufw` 可选 | `firewalld` / `nftables` 常见 |
| 安全机制 | AppArmor 常见 | SELinux 常见 |
| 网络管理 | systemd-resolved / netplan / NetworkManager | NetworkManager / firewalld |
| 容器 | Docker / containerd | Docker / Podman / containerd |
| iptables | nft backend 常见 | iptables-nft / legacy 混用可能 |
| cgroup | v2 常见 | v1 / v2 取决于版本 |

CentOS Linux 旧版本只能作为兼容目标处理；新部署优先 CentOS Stream、RHEL-compatible
发行版或 Ubuntu LTS。Admin UI 需要展示 OS support level：`supported`、
`compatible`、`legacy-risk`、`blocked`。

### 远端 preflight 必查

- `/etc/os-release`、kernel version、architecture。
- systemd、sudo、shell、user、home、umask。
- Python 是否可用，Ansible raw bootstrap 是否需要安装 Python。
- 包管理器和 repo 可达性。
- Docker / Docker Compose / Podman / containerd 状态。
- `ip`、`ss`、`dig` / `nslookup`、`curl`、`tar`、`sha256sum`。
- `iptables` / `nft`、firewalld、ufw、SELinux、AppArmor。
- `/dev/net/tun`、WireGuard kernel/userspace 能力。
- DNS resolver、default route、MTU、IPv4/IPv6。
- 磁盘空间、inode、内存、时钟同步。
- 是否能访问 Internal artifact endpoint、MinIO/Harbor、AWX callback。

### 执行规范

- package install 通过 OS family 分支，不写死 apt/yum。
- systemd unit 使用模板，路径和用户可配置。
- Docker Compose 文件用 `docker compose config -q` 或等价命令验证。
- `.env` 用模板生成，禁止拼接未转义 shell 字符串。
- 防火墙和 sysctl 变更必须有 plan、apply、rollback。
- SELinux/firewalld 变更必须进入 Evidence Drawer。
- 每个 slot 记录 `osFamily`、`osVersion`、`kernel`、`containerRuntime`、
  `networkStack`、`securityModule` 和 support level。

## Admin 产品设计系统

Admin 需要从“功能可用的 shadow 控制台”升级为 MX Launcher 平台的统一操作界面。
设计方向不是普通 SaaS 后台，而是带 3D 拓扑舞台的运维编辑器：深色、精密、可扫描、
高密度、强证据感。

### 技术选型

当前 `desktop` 已经是 Electron + TypeScript + Three.js，尚不是 Vue/Quasar 项目。
建议新 Admin surface 采用：

- React + Vite 作为 Admin 前端工程。
- shadcn/ui + Radix primitives 作为可复制、可改造的组件基础。
- Tailwind 或 CSS variables 作为 design token 输出层。
- lucide-react 作为基础图标。
- Three.js / React Three Fiber 作为拓扑舞台和 3D 状态图层。

选择 shadcn/ui 的原因：

- 它不是重型运行时框架，适合沉淀 MX 自己的组件风格。
- 能把 button、dialog、tabs、input、select、popover、toast、sheet 等组件复制进仓库后
  改造成 MX design tokens。
- 更适合和 Three.js、命令面板、证据抽屉、属性面板混合。

Quasar 适合 Vue 全家桶和快速产出完整后台。如果后续决定 Admin 走 Vue，那么 Quasar
可以作为候选；但在当前仓库边界下，不建议为了 Quasar 重写技术栈。

### MX Console 风格基调

设计 token 初稿：

| Token | 用途 |
| --- | --- |
| `bg.canvas` `#141417` | App 外壳和最深底色 |
| `bg.workspace` `#1A1B23` | 拓扑舞台、主工作区 |
| `bg.panel` `#21232D` | 左右面板、列表容器 |
| `bg.elevated` `#292C37` | Dialog、Drawer、Action surface |
| `accent.primary` `#2BF6D2` | 主操作、选中态、链路高亮 |
| `accent.info` `#5E8EEC` | 信息、发布提示 |
| `accent.success` `#48BC77` | 通过、健康 |
| `accent.warning` `#F8D06C` | 需要确认、门禁等待 |
| `accent.danger` `#EE6067` | 失败、高风险 |
| `accent.archetype` `#B974FF` | 模板、profile、抽象资源 |
| `text.primary` `#E2E2E2` | 主文字 |
| `text.secondary` `rgba(226,226,226,.7)` | 次级文字 |
| `text.muted` `rgba(226,226,226,.45)` | 辅助、时间、hint |

排版：

- 英文优先 `Poppins`，中文 fallback 使用系统 UI 字体。
- 操作界面内标题克制，避免 landing-page 大字。
- 字号以 12 / 14 / 16 / 18 为主；复杂面板中保持高密度。
- 字距保持默认，不做负字距。

空间和形态：

- 主界面采用 editor shell：top toolbar、left navigator、center topology/workspace、
  right inspector、bottom console/evidence。
- 面板半径不超过 8px，避免层层卡片。
- 卡片只用于重复对象、dialog、drawer 和明确 framed tools。
- 状态色只用于状态，不做大片装饰渐变。
- Three.js 舞台是操作入口，不是背景装饰。

### 组件清单

第一批组件：

- `MxShell`：桌面级框架，承载 topbar、sidebar、workspace、inspector、console。
- `MxTopologyStage`：Three.js H/D/I/O 拓扑，可选中、聚焦、缩放、展示粒子链路。
- `MxActionBar`：高风险操作、确认门禁、回滚入口。
- `MxEvidenceDrawer`：execution、runner、worker、AWX、K8s、log、trace 的证据抽屉。
- `MxInspectorPanel`：对象属性、配置、健康、最近任务。
- `MxResourceTree`：站点、release、artifact、profiles、runner jobs。
- `MxCommandConsole`：远端诊断命令、只读 probe、runbook action。
- `MxStatusPill`：ready、running、blocked、failed、rollback、legacy-risk 等统一状态。
- `MxGateDialog`：confirm apply、remote execution、rollback、change window。
- `MxToast`：成功、失败、警告、信息，直接挂 evidence link。

第二批组件：

- `MxRunbookPanel`：SOP、故障复盘、推荐下一步。
- `MxDiffViewer`：manifest diff、CoreDNS diff、compose diff、Ansible check diff。
- `MxTimeline`：plan -> preflight -> apply -> AWX/job -> report -> rollback。
- `MxCredentialBadge`：credential 来源、作用域、过期时间、redaction 状态。
- `MxOsSupportBadge`：Ubuntu、CentOS/RHEL-family、legacy-risk。

### Admin 信息架构

V1 保留现有 MX Launcher 风格并升级为：

- AppCenter：用户可见应用、安装、更新、权限。
- Operations：H/D/I/O topology、site slot pipeline、AWX job、worker report。
- Release：release plan、artifact、灰度、rollback、gate verdict。
- Config：SSH Profile、DNS、Launcher Network policy、site profile。
- Observability：trace、log、metric、synthetic probe、evidence bundle。
- Security：RBAC、credential、policy、audit、CIS/security baseline。
- Runbooks：故障场景、SOP、复盘、自动化诊断动作。

## 从截图借鉴的产品语言

截图里的编辑器风格对 MX 有三点启发：

1. 左侧树和资源区适合承载 site、release、artifact、profile。
2. 中央 3D 舞台适合承载 H/D/I/O 拓扑和链路健康。
3. 右侧属性面板适合承载 evidence、gate、credential、diagnosis。

MX 不复制游戏编辑器，而是沉淀自己的“运维编辑器”语言：

- 任何节点都可选择。
- 任何状态都可追证据。
- 任何动作都可预演、确认、执行、回滚。
- 任何失败都能定位到命令、task、host、日志、trace、配置快照。

## 近期里程碑

### Milestone 1：文档和设计 token

- 完成本文档。
- 在 Admin UI 中引入 design token 文件。
- 统一 status color、button、input、panel、toast、drawer 的视觉规则。
- 把现有 Three.js topology 调整为 MX Console 风格入口。

### Milestone 2：AWX shadow provider

- 部署 AWX shadow。
- 新增 Config Center `awx-provider` 配置、Admin dashboard provider 状态、
  Foundations 配置面板和 adapter contract。
- 新增 `awx-provider` readonly check/list，不 launch job，不持久化 token。
- 完成一个 Oversea `check mode` job 和 evidence 回填。
- 保留现有 remote SSH provider 作为 fallback。

### Milestone 3：Ubuntu/CentOS preflight

- Ansible role 或 shell preflight 同时识别 Ubuntu 和 CentOS/RHEL-family。
- Admin pipeline 展示 OS support level。
- `.env`、compose、systemd、firewall 变更加入 validate step。

### Milestone 4：GitOps + Observability

- Argo CD 管理 Internal K8s 基础组件。
- Prometheus/Loki/OTel 进入 Release Gate 和 Evidence Drawer。
- MinIO/Harbor 承接 artifact、snapshot、evidence。

### Milestone 5：Admin 产品化

- 建立 `admin/` 前端工程或把现有 desktop Admin 拆成独立 surface。
- shadcn/ui 组件复制进仓库并改造成 MX components。
- Three.js topology、Evidence Drawer、Action Gate、Runbook Panel 形成统一体验。
