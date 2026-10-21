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

公开 Auth 502 已确认；**尚未取得生产 Pod、网关日志与数港 Pod 内探测结果，不能断言具体是 Pod 未就绪、回源地址、Nginx 还是网络故障，也不能宣称线上已恢复。** 最近的 `loginOnly` 变更不修改 capabilities 路径。无生产部署、重启、密钥或权限变更。

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

- Pod 未就绪或 18444 健康失败：检查 `mx-identity-public` 的状态、容器退出原因、事件及数据库连通。按明确原因修复；现有默认镜像策略为 Never，若是镜像不可见应核验实际 kubelet runtime，不能直接推断需要重建身份。
- 18444 健康正常、Domestic 的 Internal discovery 失败：检查 Internal 的 auth 虚拟主机、原回源地址及网关头。保留原凭据和来源限制，只对已确认错误的配置做修复。
- Internal discovery 正常、公网 discovery 仍 502：检查 Domestic 的 auth 站点实际回源及对应错误日志。Nginx 修改需先检查配置，再按原运维流程 reload。
- Pod 内 capabilities 返回 401：比较原数港 profile 与 Auth 实际加载的客户端登记，不生成新密钥。404/405 检查路由或运行版本；403 检查来源头/网关；502/503/504 先恢复上游；200 但字段不匹配则校对 appId/origin/audience/nativeForm。

`restart` / `migrate` 是数港完整 deploy 的别名；`enroll` 会写接入配置；Launcher `ops identity apply` 会处理私网和公网两个 Deployment 及共享 Secret。它们均不是本轮只读诊断命令，不应因 503 直接执行。MX-H2I 原登录与联网、私网 identity 18443、用户记录和既有密钥保持原样。

## 恢复验收

先确认公网 discovery 200、Pod 内 `diagnose-auth` 成功，再确认 DataPort SSO start 200 并能取得表单。最后由已有数港账号完成真实登录，子账号与原 MX-H2I 登录/联网分别回归；匿名 GET form 的 410 本身不属于恢复失败。

本地验证：诊断、认证表单、会话、BFF 与独立子账号测试共 38 项通过；运维脚本测试 31 项通过，合计 69 项，无跳过。新增用例覆盖 HTML 502、401、配置不匹配、DNS/TLS/连接失败、重定向拒绝、stdin 执行、脱敏、集群漂移拒绝与只读包装。类型检查及生产构建通过，保留既有大 chunk 警告。

首轮测试受沙箱监听限制，放行本机隔离监听后通过；本机缺少已锁定的 xlsx/exceljs，按现有 package-lock 安装依赖后构建通过，未修改依赖清单或锁文件。没有进行浏览器真实登录验收。

本地工具测试与线上恢复分开记录；当前线上恢复待取得上述诊断结果后继续。
