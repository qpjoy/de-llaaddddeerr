# Rig 的公网入口（浏览器统一认证，docs/25 §11）

浏览器 SSO 需要一个稳定的 HTTPS 地址，作为 Rig 的入口和统一认证的回调：`https://rig.minsight-ai.com`。这个地址只开放下表中的路径。

域名和证书归平台网关管，配置在 `de-mingxi` 里，和 Hub、Pay 一样；mx-rig 不改那个仓库。这里写的是 Rig 对网关的要求，[internal-nginx.conf.example](internal-nginx.conf.example) 是可以照着改的样例。

```text
浏览器 ── HTTPS ── Domestic Nginx（证书、rig.minsight-ai.com）
                    ── WireGuard ── 10.88.88.88:80 Internal Nginx
                                    ── Rig 服务（scripts/manage.sh deploy 打印的地址，NodePort 30891）
```

## 转发哪些路径

| 路径 | 转发 | 说明 |
| --- | --- | --- |
| `/`、`/rig`、`/rig/*` | 是 | 工作台页面和静态文件 |
| `/auth/sso/*` | 是 | 统一认证的登录、回调、会话、退出（`@qpjoy/mx-common/identity/sso`） |
| `/auth/desktop/*` | 是 | 桌面端经系统浏览器登录时的交接 |
| `/api/rig/v1/*`、`/api/v1/*` | 是 | 已登录的人用的接口，每个接口都由 Rig 自己鉴权 |
| `/api/rig/v1/login`、`/api/rig/v1/native-login`、`/api/v1/auth/login`、`/api/v1/auth/password` | **否** | 公网入口不接受账号密码，只接受统一认证 |
| `/api/rig/v1/station/*`、`/runner/*` | **否** | 工位和执行机的机器接口，只走内网地址 |
| `/webhooks/*`、`/readyz`、`/healthz`、`/test-center/*`、`/artifacts/*` | **否** | 只走内网地址 |

网关没有挡住的请求，Rig 也会自己拒绝：Host 是公网域名时，不在上表里的路径一律返回 404。网关这一层是第一道，Rig 是第二道。

## 必须保留的东西

- **`Host: rig.minsight-ai.com`**：Rig 靠它认出公网入口。
- **`Origin`、`Cookie`、`Set-Cookie`** 原样转发：会话 Cookie 是 `__Host-`、`Secure`、`HttpOnly`、`SameSite=Lax`；写请求要用 Origin 做同源检查。
- **只用 HTTPS**：`__Host-` Cookie 只在 HTTPS 下生效；HTTP 一律 301 到 HTTPS。
- **转发头**：公网层覆盖客户端自带的 `X-Forwarded-*`。Rig 不信任这些头，限流用的是直接连上来的对端地址。

## 不需要的东西

- 不需要为 SSO 新开端口或新建服务：同一个 Rig 服务，同一个 PostgreSQL。
- 不需要改 Launcher 的反代路由：VIP 那条路由（桌面端用）保持原样。
