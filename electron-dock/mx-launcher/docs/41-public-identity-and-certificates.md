# 公网 Identity 与集中证书运维

状态：2026-10-03 本地实现与隔离测试；尚未部署生产、签发公网证书或验证真实飞书。完整的公网/内网两机操作步骤在配套 `de-mingxi` 仓库的 `compass/deploy/PUBLIC-IDENTITY.md`。

## 已确定入口

| 域名 | 职责 | 回调 |
| --- | --- | --- |
| `auth.minsight-ai.com` | 统一登录、邀请码注册、飞书 Web 绑定 | `/identity/feishu/callback` |
| `launcher.minsight-ai.com` | 个人管理台，按现有管理角色授权 | `/auth/admin/callback` |
| `hub.minsight-ai.com` | 原 Hub，复用原成员/租户与证书 | `/auth/sso/callback` |

新建 Auth、Launcher 两张证书，Hub 原证书不变。不合并到 www 的 SAN：通过同一 webroot、脚本、调度和 deploy hook 管理多个证书，Certbot 自动续期无需停止公网 80。

## 部署责任边界

公网 DNS/证书/443 域名路由与续期由 `de-mingxi` 管理；它只把请求经 WireGuard 转到内网 Nginx，不调用 Launcher/Hub 构建或部署脚本，也不读取应用数据库、OIDC 私钥或客户端密钥。

内网 Nginx 持有域名到各服务端口的映射；Launcher、Hub 各自管理进程、数据库和配置。Launcher 导出的身份连接档案属于一次性客户端配置交付，Hub 自己校验并载入；登记脚本不 import Hub 服务源码，运行时双方通过 OIDC/HTTP 协议连接。公网页面是否开放、证书续期和应用升级可以分别进行。

## 与原客户入口隔离

- 原 `https://10.88.88.88:18443/identity`、签名密钥、客户端、CA、用户 ID 不变。
- `profile.json.publicEntry` 声明单独公网 issuer `https://auth.minsight-ai.com/identity`；新 `mx-identity-public` Deployment 复用账户数据库，使用独立签名密钥与 Cookie namespace。
- 新回源只绑定 `10.88.88.88:18444`。Public TLS 在 Domestic 网关终止，经 WireGuard → Internal Nginx → 公网身份进程。端口占用预检不会接管其他服务。
- Internal ingress 默认只接受已知 WG 对端 `10.88.0.1` 并加入独立网关凭据。身份进程验证凭据、客户端 IP 与精确 Host；Launcher 公网 BFF 再验证凭据、Cookie/CSRF 和当前用户管理角色。
- Auth 域名只提供 `/identity/`；Launcher 只提供 `/admin/`、`/auth/admin/`、`/admin-api/`。原始 Internal API、注册 backchannel 不对公网代理，外部 Ops Token/Authorization 在公网管理代理中丢弃。
- 公网管理页先读取 `/auth/admin/session`；`accessMode: sso-only` 表示禁止浏览器直连原始 Internal API。2026-10-04 起支持统一账号或在同源 `/auth/admin/ops-login` 验证 Ops Token 后建立管理 Cookie；未登录或未获管理授权时只显示登录页，不展示工作台或加载管理数据；已授权的 JSON 请求和发布文件上传统一经过 `/admin-api/internal/v1/` 并携带会话 CSRF。会话过期不会回退到原始 `/internal/v1/`。内网应急 Token 模式保留原路径。
- 注册策略、邀请码和账号库沿用私网原 namespace。公开注册不授予管理角色。明确禁止 `mx-launcher` 后旧管理会话的下一次受保护请求也被拒绝。
- Hub 新登录使用公网 issuer；旧私网 SSO 会话沿原 issuer 走完原有有效期（早期版本为 8 小时；2026-10-04 起新签发为 30 天），复用同一加密密钥。新旧身份经原 `mx-user-center:<environment>` 身份绑定复用成员/租户，不按同名或邮箱合并。
- H2I、Luopan 的 SDK 登录协议、客户端配置、VPN 不由此入口改写。本次仍未改实际 Luopan 产品目录。正常 deploy 有既有滚动/重建行为，不能据此承诺线上完全无中断。

## 一次登记，重复部署复用

在现有 Internal 生产机的 Launcher 根目录，以 root 运行：

```bash
bash scripts/manage.sh ops identity public \
  https://auth.minsight-ai.com \
  https://launcher.minsight-ai.com \
  https://hub.minsight-ai.com
```

此命令登记而不部署。它在生产部署锁内读取原环境/audience，持久保存公网密钥与 Hub SSO profile，并生成 `/var/lib/mx-launcher/identity/public-ingress.conf`。现有 Hub 私网 profile 备份为同目录 `profile.before-public.json`。相同参数重复执行不轮换密钥；已有配置冲突会停止，旧恢复档案不能移除已发布的公网凭据。

上线顺序：

1. Domestic：新域名 DNS → 宿主 80 Nginx ACME location → `certificates/manage.sh issue auth.minsight-ai.com launcher.minsight-ai.com`。
2. Internal：上面的统一登记命令 → 原 Launcher deploy（沿用 TMPDIR、K8s、7789 构建代理参数）。
3. Internal：把生成的 `public-ingress.conf` 以 root 0600 安装到 `/etc/nginx/conf.d/mx-public-identity.conf`，合入配套 Hub `/auth/sso/` 路由；Nginx 检查后 reload。
4. Domestic：`bash scripts/enable-public-identity.sh` 检查证书与 Nginx 后启用两个域名；更新后的 `40-hub.conf` 保留 Hub Cookie callback。
5. 确认公网 discovery 的 issuer/端点正确，且 Internal/Pod 能访问，再运行原 Hub deploy。
6. 验收原账号/租户、注册、权限禁用和旧客户联网。飞书后台追加公网回调，保留原回调。

后续原 Launcher deploy 自动维护两套身份进程/Secret，Hub deploy 自动载入相邻项目 `secrets/identity/profile.json`，无需逐个填写 SSO env key。原私网检查命令仍只检查私网入口；公网 DNS/TLS/回源应按完整 runbook 单独验收。

## 证书与重启/迁机

在 Domestic 的 `de-mingxi/compass/deploy` 使用统一脚本：

```bash
bash certificates/manage.sh status
bash certificates/manage.sh check auth.minsight-ai.com launcher.minsight-ai.com
bash certificates/manage.sh migrate hub.minsight-ai.com compass.minsight-ai.com delta.minsight-ai.com h2i.minsight-ai.com autotest.minsight-ai.com www.minsight-ai.com
bash certificates/manage.sh install-timer
```

先在需要 HTTP 验证的证书全部 SAN 对应的宿主 80 server 内配置 webroot。配套 de-mingxi 的 `cert migrate` 自动兼容版本：Certbot ≥2.3 使用 reconfigure staging 检查；旧版先对指定证书 dry-run，成功后正式续期一次以保存 webroot。已经使用 webroot 或自动 DNS 插件的证书重复运行只验证保存的配置，不切换验证方式或再次强制签发。成功后才能启用无人值守续期。脚本拒绝未迁移的 standalone、manual 验证和历史 pre/post 停服 hook。`cert methods` 查看当前验证方式；`cert force-renew` 是独立的一次性批量操作，全部试续期通过后才正式签发，不能加入应用 deploy 或定时任务。已存在的其他 cron/自建定时任务须核对。续期成功后仅 Nginx 检查与 reload，不重建 Docker。

备份 Domestic **整个 `/etc/letsencrypt`**（不只是 live 软链接），宿主/网关 Nginx 配置与调度；备份 Internal 身份目录、Hub `secrets/identity`、两应用数据库和原持久数据。公网 TLS 私钥不分发给应用；OIDC 密钥不放 Git/镜像。

重启使用原持久档案、Secret、数据库和 systemd/Kubernetes 恢复。新主机先恢复备份和原网络，再部署；若 IP/issuer 也改变，需要单独迁移。恢复原档案的检查会阻止通过生成随机密钥“修复”旧身份。

## 本地验证

- 临时真实 PostgreSQL + OIDC：公网 issuer、原账号登录、精确 Host/可信网关、Ops Token 剥离、私网邀请码复用、旧 Hub 会话跨 issuer 配置切换、成员/租户复用、当前禁用、CSRF 和重放。
- 配置幂等、私有/公网 key 分离、Kubernetes 回源端口、旧档案恢复保护；Launcher typecheck/build 和 Hub typecheck。
- Nginx 1.30.5 实际 `nginx -t`：公网域名/Hub、生成的 Internal ingress、宿主 HTTP-01 配置。仅使用临时测试证书。
- 证书 CLI 隔离测试：新证书选择、完整 SAN、HTTP 验证失败不签发、standalone/hook 拒绝、reconfigure、dry-run 后调度、复用已有 timer；不会真正签证书/停服务。

真实公网、生产设备和飞书授权仍须上线后验收。证书 UI 看板未在本次实现；本批提供统一脚本和自动续期基础。

## 回源配置缺失时

`ops identity public` 属于 Launcher，必须在 `mx-launcher` 目录执行，Hub 的同名脚本不支持此子命令。只有成功登记后才会产生 `/var/lib/mx-launcher/identity/public-ingress.conf`。已经登记但该文件丢失时，在 Launcher 目录执行 `bash scripts/manage.sh ops identity ingress`，只按原档案补回文件，不轮换密钥或重启服务；今后 deploy 也会自动补回。内网 Nginx 仍独立检查和加载此文件。

配套 de-mingxi 新增仓库根目录/compass/deploy 的 `scripts/manage.sh cert ...` 统一入口、`internal-identity-install` 及 Auth/Launcher 内网参考模板。模板不含真实凭据，不可直接当生产配置安装。公网启用脚本在改变配置前先检查内网 discovery 和 SSO session，回源未就绪时停止。


## 2026-10-04 登录入口与 30 天会话更新

- Launcher 首页先验证登录，未登录、过期或没有 `mx-admin` 时隐藏整个工作台。默认「统一账号登录」前往 Auth；「账号选项」内可强制切换身份。Internal Ops Token 入口折叠显示。
- Hub 同样使用 Auth 主入口及折叠的 Admin Token 入口。已配置 SSO 时不再重复显示 Launcher 密码表单；未配置 SSO 的旧部署仍保留兼容入口和原 API。
- Auth 使用原 Launcher 用户中心及原密码，不创建另一份账号库。Hub 只复用同一身份对应的 member/tenant/membership，管理权和数据权限仍由各应用分别检查。没有按名称、邮箱合并账号或覆盖原数据。
- Auth 的登录/注册/飞书绑定保持一个认证界面；interaction ID 是每次认证事务的随机标识，变化是正常现象。默认 SSO 可复用有效身份；明确切换或管理操作重新验证才要求再次输入身份凭证。
- 新 Auth Session/Grant、Launcher 管理 Cookie、Hub SSO Cookie 及其服务端 access token、新 SDK 密码/飞书用户 Token 默认 30 天。请求更短有效期的 SDK 调用继续遵守请求值；服务账号 Token 的原期限不变。授权码、登录事务、待关联会话及短期 ID Token 不延长。个人管理写操作仍要求最近 5 分钟认证。
- 旧 Cookie/Token 按已经保存的绝对到期时间继续有效；部署不会重写它们。需要立即获得 30 天期限时退出后重新登录一次。密码更新、账号禁用、应用封禁及现有撤销机制继续生效。
- 公网 Ops Token 在请求正文提交一次，经 Origin、网关来源和限流检查后转换为 Secure/HttpOnly 管理 Cookie。数据库只保存凭据指纹和随机会话 ID 摘要；Token 轮换使相关会话失效。后续请求通过 BFF 和 CSRF 校验，不在公网 Nginx 放行 `/internal/`，不向前端返回服务器 Ops Token。

已完成初次域名/SSO 登记的服务器：同步代码后，先执行原 **mx-launcher deploy**，再执行原 **mx-insight-hub deploy**，沿用原 7789 代理、TMPDIR、节点与 IP 参数。该更新无需重新运行 `identity public`、换证书或增加 env key，也无需修改 de-mingxi/内网 Nginx。部署后刷新两个页面，以已有账号与折叠 Token 入口分别验收登录、退出和权限；Auth 服务随 Launcher 部署更新。

本地验收包含真实 OIDC/HTTPS 与 PostgreSQL 的旧身份复用、租户连续性、重启恢复、30 天 Cookie、Token 登录来源/CSRF/轮换/退出，以及浏览器匿名门禁、文件上传 BFF、会话过期、普通账号阻挡、移动布局。生产入口仍需部署后验收。

### 跨域登录或切换账号后停在 303、刷新变为 400

若浏览器控制台同时提示 `form-action 'self'`，原因是 Auth 的 CSP 拦截了表单提交后的跨域回调。303 本身是正常跳转；此时认证事务可能已经消费，刷新旧 interaction/resume 地址会返回 400。

Auth 现在只将静态登记的 Launcher、Hub origin 加入 `form-action`，不从请求的 Host、Origin 或 redirect_uri 扩展白名单。OIDC 仍校验精确的回调地址，账号切换自动提交脚本仍使用精确哈希，不开放任意内联脚本。

此修复仅需更新代码并执行原 **mx-launcher deploy**，Auth 随之更新；已经完成上节升级的 Hub 无需再次部署。无需重新登记域名、修改 Nginx、轮换密钥或清空账号数据。部署后从 Hub/Launcher 首页重新发起登录，不刷新已经消费的 Auth 地址。

已在本地 Chrome、三个不同 HTTPS 测试域名及真实 OIDC/PostgreSQL 下验证首次登录、Hub 切换 A→B、Launcher 切换 B→A，以及应用退出后复用 Auth 会话；应用回调使用测试客户端验证授权码兑换、签名、state、nonce 与新账号 subject。原有用户和密码记录保持不变。

### 点击飞书登录仍被 `form-action 'self'` 拦截

这是另一段跨域跳转：Auth 登录/切换账号表单 POST 后，原实现直接以 303 跳到飞书授权域名。Chrome 会继续按原表单的 `form-action` 检查这一跳；增加飞书开发者后台的回调 URL 无法解除浏览器 CSP 拦截。

Auth 现在先返回同源的 200 导航页，再通过精确 SHA-256 哈希允许的固定脚本前往服务端生成的 HTTPS 飞书授权地址。禁用 JavaScript 时可点击「继续前往飞书」。导航地址只来自认证后端，不接受请求参数指定；表单允许来源保持原来的 Auth/已登记应用，不增加飞书域名、通配符或任意内联脚本权限。state、PKCE、浏览器绑定 Cookie、一次性事务和原账号绑定检查保持不变。

本地 Chrome 回归使用独立的 Auth、应用和模拟飞书 HTTPS origin，以及真实 OIDC/PostgreSQL：先复现相同 CSP 错误，再验证 Launcher/Hub 切换到已绑定飞书账号、显式绑定入口、禁用 JavaScript 后手动继续，且旧账号和密码记录不变。测试文件为 `server/src/identity/feishu-navigation.test.ts`，需设置隔离的 `MX_SSO_TEST_DATABASE_URL` 和已有 Playwright 的 `MX_SSO_BROWSER_MODULE`；浏览器测试没有使用真实飞书租户。

发布此修复只需同步代码后执行原 **mx-launcher deploy**，更新随之部署的 Auth。Hub、飞书回调配置、密钥、数据库和 MX-H2I 客户端均无需因此调整。部署完成后从应用重新发起登录；本地验收不代表生产已更新。
