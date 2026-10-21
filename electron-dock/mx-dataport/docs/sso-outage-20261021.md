# 数港登录 410 / 503 排查（2026-10-21）

## 已确认的现象

本轮从本机直接访问生产域名（`curl --noproxy '*'`，无 Cookie、用户密码或业务操作）：

| 请求 | 结果 | 含义 |
| --- | --- | --- |
| DataPort `/status` | 200，auth/hub 都为 configured | 配置已挂载，不代表上游可用 |
| DataPort `POST /auth/sso/start?view=login` | 503，`sso_application_unavailable` | Auth capabilities 预检失败，尚未创建登录事务 |
| DataPort `GET /auth/sso/form` | 410，`account_flow_expired` | 当前匿名请求没有有效登录 flow |
| Auth `/identity/.well-known/openid-configuration` | 502，Nginx HTML | 公开身份链路异常，与用户密码无关 |
| Auth `POST /identity/app-account`（不带凭据） | 502，Nginx HTML | 未正常到达应用认证拒绝响应；未验证数港客户端凭据 |
| Launcher `/auth/admin/session` | 502，Nginx HTML | 同一公网身份进程承载的另一个入口也异常 |

直接访问 Auth、Launcher、DataPort 的远端 IP 都是 `116.62.51.154`。Auth / Launcher 返回的错误页标记为 nginx/1.14.1；版本标记不足以判断是哪一层 Nginx 产生错误。

代码中 `mx-common/src/identity/sso.mjs` 在启动阶段调用 `capabilities`，失败统一包装成截图中的 503；只有预检成功后才建立登录事务。前端先读取表单，410 时尝试重新启动 SSO，属于既有恢复流程。因此本次不能靠清 Cookie、去掉 410、修改邀请码或重新 enroll 解决。

最近的 `loginOnly` 变更不修改 capabilities 路径。下述 Internal 回执已将本轮故障定位到公网身份的 hostPort 转发；尚无恢复后的验收结果，不能宣称线上已恢复。

## Internal 回执与迁盘的关系

用户回传的生产结果：

- `mx-internal-shadow/mx-identity-public` 为 1/1 Ready；Pod `mx-identity-public-57dc86b444-gtmft` 在 `mx-internal-server`，Pod IP 为 `192.168.224.83`。
- 主机 `mx-internal-svc` 接口拥有 `10.88.88.88/32`，Pod 声明 `hostIP=10.88.88.88 / hostPort=18444 / containerPort=18444`，未使用 hostNetwork。
- 直接请求 Pod IP 的 `/healthz` 返回 200，而 `10.88.88.88:18444` 连接被拒绝。
- iptables 使用 nf_tables 后端；`PREROUTING` 和 `OUTPUT` 均跳转到 `CNI-HOSTPORT-DNAT`，该链的回执仅有 18220，没有 18444。

这说明 **Pod 已运行，但公网身份的 18444 hostPort DNAT 缺失**。readiness 探测 Pod IP，所以 Ready 与宿主机入口不可达并不矛盾。没有证据说明数据丢失、密码错误或需要重建身份库。关于探针与端口映射机制，参见 [Kubernetes HTTP 探针](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/)及 [CNI portmap](https://www.cni.dev/plugins/current/meta/portmap/)。

需区分两次故障：

| 故障 | 已有证据与处理 |
| --- | --- |
| 之前 `mx-harbor-migrate-cf91aed0` 超时 | 后续回执为 `ErrImageNeverPull → DeadlineExceeded`，迁移容器未启动；不是 SQL 执行超时。旧 DataPort 使用默认 `ctr` 地址，迁盘后 kubelet 使用独立 runtime；`23fb2852` 已改为解析实际 kubelet 地址、显式导入并通过 CRI 比对镜像 ID。旧失败镜像在两个实例中的实际分布未取得完整现场回执。 |
| 本次 Auth 502、数港 503/410 | 公网身份 Pod 健康，宿主机 18444 转发缺失。镜像导入修复不会补回已有 Pod 的 CNI 转发规则；应定向恢复公网身份 sandbox，再逐层验证。 |

`mx-move` 的[完成记录](../../mx-base/mx-move/k8s/cutover.md)为事务 `mx-k8s-20261020-053718-a8d8c128`，`services-restored / may_write=true / automatic_checks_passed=true`；本轮用户重新运行 `k8s status` 的回执再次确认这三个字段。此前已有用户确认原 MX-H2I 登录、联网及 Pay 正常。摘要中的 `preparation_step: flush` 是保留的历史准备进度，`user_login_and_network_validation: required` 是固定人工验收提示，都不推翻已完成状态。迁盘确实涉及旧 CRI sandbox 的 `stopp/rmp` 和新运行时启动，但检查的代码没有直接清空 iptables/nft。**目前不能确定 18444 规则由谁、何时删除，也不能仅凭先后顺序认定迁盘直接导致此次故障。**

自动验收检查运行时、挂载、工作负载和网络控制器 Ready，没有探测 18444 hostPort 或公网 discovery。`automatic_checks_passed=true` 不涵盖这条链路。完成事务再次 `resume` 仍会执行运行时激活、Pay 补丁核验和原工作负载恢复；它不会为已 Ready 的公网身份定向重建 hostPort。后续普通部署也可能改变迁盘历史模板，使全量 `verify` 报基线差异；这不等于迁盘失败。

**不要为本次故障重新执行 `migrate` 或 `resume`。** 在 Internal 的 `electron-dock/mx-base` 目录只读确认现场事务：

```bash
bash mx-move/scripts/manage.sh k8s status
```

若状态与上述完成记录不同，先分析当前事务，不继续执行定向恢复，也不自动 resume。

## 在 Internal 执行

在原 `electron-dock/mx-dataport` 部署目录同步本次脚本后执行，无需构建镜像、迁移或重新发布：

```bash
bash scripts/manage.sh ops internal-production status
bash scripts/manage.sh ops internal-production diagnose-auth
```

`diagnose-auth` 先沿用部署配置校验固定集群 UID，再通过 stdin 将诊断源码送到现有数港 Pod。它读取 Pod 内当前挂载的 SSO profile，以生产相同的 undici / CA 配置，只访问该 issuer 的 discovery 和 capabilities。不会访问旧 provider、跟随重定向、提交用户登录、创建登录事务、修改数据库或配置。

输出只包含检查分类、HTTP 状态及协议字段是否匹配；不会输出 profile、URL、clientSecret、sessionKey、Authorization、Cookie 或上游原文。发现失败时退出码非零是预期结果。若 Kubernetes 拒绝 exec，仅输出安全错误类别。

继续检查公网身份 Deployment 与直接健康端口；以下 kubeconfig / 地址来自当前 Launcher 部署约定，若生产已迁移则使用原固定配置，不切换集群：

```bash
kubectl --kubeconfig=/etc/kubernetes/admin.conf --request-timeout=15s \
  -n mx-internal-shadow get deploy mx-identity-public -o wide
kubectl --kubeconfig=/etc/kubernetes/admin.conf --request-timeout=15s \
  -n mx-internal-shadow get pods -l app=mx-identity-public -o wide
curl --noproxy '*' --connect-timeout 3 --max-time 8 -sS \
  -w '\nHTTP %{http_code}\n' -H 'Host: auth.minsight-ai.com' \
  http://10.88.88.88:18444/healthz
```

18444 的 `/healthz` 无需网关凭据；200 仅证明该进程和其数据库就绪检查，不验证客户端登记或完整 SSO。hostPort 通过 CNI 转发，`ss` 没有 18444 监听项不等于服务没运行。

## 在 Domestic 执行

```bash
curl --noproxy '*' --connect-timeout 3 --max-time 10 -sS \
  -w '\nHTTP %{http_code}\n' -H 'Host: auth.minsight-ai.com' \
  -H 'X-Real-IP: 10.88.0.1' \
  http://10.88.88.88/identity/.well-known/openid-configuration
```

这是固定 Domestic WireGuard 对端到 Internal Nginx 的原回源路径。不要在任意主机上添加来源头试图绕过访问限制；Internal 的 80 端口身份站点只允许该对端，本机测试返回 403 可能是正常限制。不要回传 `nginx -T` 全量输出，身份回源配置含网关凭据。

## 根据结果处理

- Pod 未就绪或 Pod IP 健康失败：检查 `mx-identity-public` 的状态、容器退出原因、事件及数据库连通。按明确原因修复；现有默认镜像策略为 Never，若是镜像不可见应核验实际 kubelet runtime，不能直接推断需要重建身份。
- Pod IP 健康、宿主机 18444 拒绝连接且 DNAT 缺失：仅恢复 `mx-identity-public` 的 sandbox，详见下节。不要清理全局 CNI/iptables、重启 kubelet/containerd 或执行 Launcher 全量发布。
- 18444 健康正常、Domestic 的 Internal discovery 失败：检查 Internal 的 auth 虚拟主机、原回源地址及网关头。保留原凭据和来源限制，只对已确认错误的配置做修复。
- Internal discovery 正常、公网 discovery 仍 502：检查 Domestic 的 auth 站点实际回源及对应错误日志。Nginx 修改需先检查配置，再按原运维流程 reload。
- Pod 内 capabilities 返回 401：比较原数港 profile 与 Auth 实际加载的客户端登记，不生成新密钥。404/405 检查路由或运行版本；403 检查来源头/网关；502/503/504 先恢复上游；200 但字段不匹配则校对 appId/origin/audience/nativeForm。

`restart` / `migrate` 是数港完整 deploy 的别名；`enroll` 会写接入配置；Launcher `ops identity apply` 会处理私网和公网两个 Deployment 及共享 Secret。它们均不是本轮只读诊断命令，不应因 503 直接执行。MX-H2I 原登录与联网、私网 identity 18443、用户记录和既有密钥保持原样。

## 定向恢复公网身份 hostPort

新增 `scripts/recover-public-auth-hostport.mjs` 替代此前内联脚本：不再硬编码旧 Pod 名或 `de-mx` 仓库目录，依赖文件按自身位置解析。保留完整仓库目录结构，同步脚本、现有 `k8s-runtime.mjs` 和 `mx-move` 模块，在 Internal 以 root 从 `electron-dock/mx-dataport` 目录运行：

```bash
# 只读预检（只取得运维锁，不修改 Kubernetes 资源）
node scripts/recover-public-auth-hostport.mjs

# 同样先预检，确认目标状态后仅触发一次公网身份重建
node scripts/recover-public-auth-hostport.mjs --apply

# 用现有数港 Pod 的实际接入配置检查上游
bash scripts/manage.sh ops internal-production diagnose-auth
```

`--apply` 会短暂重建共享公网 Auth，期间依赖它的新登录可能短暂不可用；操作目标仅为 `mx-internal-shadow/mx-identity-public`，不重建私网 identity、Internal API 或联网网关，不写 Secret、数据库和网络配置。

保护条件包括固定集群 UID/本机/单节点、节点可调度、迁盘已完成、实际独立运行时、Deployment/ReplicaSet/唯一 Ready Pod 归属、现有 Secret 摘要与运行配置注解一致、CRI 运行容器身份及运行镜像与部署标签解析为同一镜像 ID。Pod 健康必须为 200，宿主入口必须明确拒绝连接；超时或 HTTP 5xx 不按此故障恢复。四把非阻塞锁按迁盘工具顺序取得，冲突立即退出。

执行前再次核对状态，唯一一次写入为带 Deployment UID/resourceVersion 前置条件的 restart annotation JSON Patch；不自动重试写入。完成后核对新 Pod UID、相同镜像/认证配置和宿主入口 200。`already_healthy` 表示无需操作，`restart_required` 表示只读检查通过但仍需恢复，`recovered` 只表示该 hostPort 恢复，不能代替 SSO 与真实登录验收。错误中的 `mutationAttempted:true` 表示重建请求可能已经生效，必须先只读核对现场，不直接重复执行。任何拒绝或变更后验证失败都应保留输出继续排查，不转而运行全量 deploy/resume。

现有链回执也需要关注私网入口，但链中没有某端口并不一律表示故障：18443 使用普通 Pod hostPort；18090 是 hostNetwork 网关监听，DNS 还有 kube-proxy 的 Service.externalIPs 转发。可在 Internal 做以下只读检查，不提交账号、不退出当前正常连接：

```bash
curl --noproxy '*' --connect-timeout 3 --max-time 8 -fsS \
  -w '\nInternal API HTTP %{http_code}\n' http://10.88.88.88:18090/healthz
curl --noproxy '*' --connect-timeout 3 --max-time 8 -fsS \
  --cacert /var/lib/mx-launcher/identity/ca.crt \
  -w '\nPrivate identity HTTP %{http_code}\n' https://10.88.88.88:18443/healthz
```

私网检查异常应独立记录与定位，不能直接扩大此脚本的恢复对象。端口健康不代表 H2I 真实登录/隧道已验收。

## 恢复验收

先确认公网 discovery 200、Pod 内 `diagnose-auth` 成功，再确认 DataPort SSO start 200 并能取得表单。最后由已有数港账号完成真实登录，子账号与原 MX-H2I 登录/联网分别回归；匿名 GET form 的 410 本身不属于恢复失败。

本地验证：诊断、认证表单、会话、BFF 与独立子账号测试共 38 项通过；运维脚本测试 31 项通过，合计 69 项，无跳过。新增用例覆盖 HTML 502、401、配置不匹配、DNS/TLS/连接失败、重定向拒绝、stdin 执行、脱敏、集群漂移拒绝与只读包装。类型检查及生产构建通过，保留既有大 chunk 警告。

后续迁盘关联分析与恢复工具验证：恢复工具 7 项测试（含 21 类拒绝组合、状态变化、CAS、请求结果不确定、完成后核验及 CLI 锁调用），既有运行时与运维测试 39 项，合计 46 项通过，无跳过；语法及 diff 检查通过。均使用隔离命令替身，未执行生产重建。同期再次公网只读探测仍为 Auth discovery 502、DataPort status 200。

首轮测试受沙箱监听限制，放行本机隔离监听后通过；本机缺少已锁定的 xlsx/exceljs，按现有 package-lock 安装依赖后构建通过，未修改依赖清单或锁文件。没有进行浏览器真实登录验收。

本地工具测试与线上恢复分开记录；当前已取得 Pod/hostPort 诊断回执，生产定向恢复与最终登录验收仍待执行。
