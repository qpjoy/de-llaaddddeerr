# Internal Nginx 与 Caddy 的 80 端口归属

状态：2026-10-14 已定位线上故障并完成本地修复。用户确认服务器发生重启，随后确认
网关已恢复；11:46（Asia/Shanghai）公网 Hub `/admin/` 实测 200。Pay 公网首页仍为 502，
须独立检查 Pay API、console 与其专用数据库，不能把网关恢复等同于全平台恢复。
MX-H2I 原账号登录、既有联网及其它业务链路仍待现场验收。

## 故障证据

Hub 公网 `/admin/` 返回 `MX Internal gateway route not found\n`，响应头为
`X-MX-Gateway: internal-app-gateway`。现场 `ss` 确认同一个 Caddy 进程占用
80、8008、18090；Nginx enabled 但启动失败，日志为 `bind() ... :80 ... Address already in use`。
Hub 18151 的首页与 `/health/ready` 均为 200，数据库状态为 up。

预期入口为 Domestic TLS → `10.88.88.88:80` Internal Nginx → Hub：
`/admin/` 剥前缀转到 18151；公共 API/docs 转到 18150；SSO/管理 API 转到 18151。
配套域名配置由 de-mingxi 的 `compass/deploy/internal-nginx/hub.minsight-ai.com.conf` 管理。
这次故障发生在入口分流层，不需要迁移数据、重新部署 Hub 或改身份配置。

旧启动脚本只看当前 80 是否被占用；Nginx 尚未启动时，Caddy 就会占用它。
这解释了启动顺序竞争；服务器重启由用户后续明确确认。

## 持久设置

网关容器支持 `MX_INTERNAL_GATEWAY_PORT80_OWNER`：

- `host-nginx`：无论 Nginx 当前状态如何，都剔除 Caddy 的可选 80 段。
- `auto` 或未设置：保持原来的端口占用检测，兼容独立网关部署。

18090、8008、现有应用路由与转发头保持原样。设置保存在 DaemonSet 容器 env 中，
清单刻意不声明这个 env 项，普通客户端 `kubectl apply` 不接管它；运行时发布路由
仅更新 ConfigMap 与 Pod 注解，也不会清除它。使用 replace、强制重建 DaemonSet 或
其它全量管理工具时须保留该设置。

不要把该值附加到 Caddy ConfigMap.data：Internal 发布路由会整体替换 data。
只设置 env 而仍运行旧启动脚本没有效果，必须同时更新启动脚本。

## 维护窗口内恢复

用户已允许这次恢复短暂中断。Caddy 与 18090 共用一个 Pod，更新模板会滚动网关；
新登录/控制请求可能短暂失败。这不修改用户、Token、VPN 配置或数据卷。
固定版本 Caddy 2.8.4、`admin off` 且没有 `--watch`，不能用 `caddy reload` 或 SIGUSR1
无中断释放端口；SIGUSR1 重载是较新版本的能力，不能套用到本部署。

同步本次脚本和清单后，在 Internal 服务器的 mx-launcher 目录，以 root 执行：

```bash
set -e
umask 077
export KUBECONFIG=/etc/kubernetes/admin.conf
mx_gateway_backup=$(mktemp -d /tmp/mx-gateway-port80.XXXXXX)
nginx -t
kubectl -n mx-internal-shadow get daemonset mx-internal-gateway -o json \
  > "$mx_gateway_backup/before.json"
node scripts/k8s-gateway-port80-patch.mjs "$mx_gateway_backup/before.json" \
  > "$mx_gateway_backup/patch.json"
kubectl -n mx-internal-shadow patch daemonset mx-internal-gateway \
  --type=strategic --patch-file "$mx_gateway_backup/patch.json"
kubectl -n mx-internal-shadow rollout status daemonset/mx-internal-gateway --timeout=120s
systemctl start nginx
curl --noproxy '*' -fsS --max-time 10 -D - -o /dev/null \
  -H 'Host: hub.minsight-ai.com' http://10.88.88.88/admin/
curl --noproxy '*' -fsS --max-time 10 http://10.88.88.88:18090/healthz
```

补丁生成器只读取保存的 DaemonSet，不访问集群；拒绝未知启动脚本、错误目标或未知的
现有端口策略。输出仅包含启动脚本、端口归属 env 与 resourceVersion，并发变更会被拒绝。
不应用空路由基线 ConfigMap，不改镜像、API Deployment、Secret、数据库或网络规则。
命令失败时保留备份和错误输出，不能通过删除整个网关/重建集群绕过。

恢复后核对 `ss`：Nginx 占 80，Caddy 占 18090/8008；再验收 Hub 公网页面及 SSO、
MX-H2I 原账号登录和现有联网。启动成功不等同于这些链路全部验收通过。
`conflicting server name "_"` 是另一个配置警告，与本次 bind 失败不同，后续单独核对。

## 本地验证

测试执行清单中的真实 shell，覆盖 Nginx 尚未启动时预留 80、IPv4/IPv6 占用、
独立网关默认行为、非法设置、旧无标记配置，并逐字节检查保留下来的 18090/8008 配置。

```bash
node --test scripts/k8s-gateway-port80*.test.mjs scripts/k8s-gateway-caddyfile.test.mjs
```
