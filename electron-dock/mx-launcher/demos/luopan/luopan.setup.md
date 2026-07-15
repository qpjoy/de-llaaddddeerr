# Luopan standalone 本地启动

```sh
cd electron-dock/mx-launcher/demos/luopan
cp .env.example .env
curl -fsS http://116.62.51.154:18090/bootstrap-healthz
curl -fsS http://116.62.51.154:18090/internal/v1/launcher-network/products/luopan
curl -fsS http://116.62.51.154:18090/internal/v1/app-center/apps/luopan
pnpm run setup
pnpm run dev
```

窗口出现后点 **Connect Internal**，允许系统安装 Luopan 自己的 WireGuard
服务。成功标志是运行态进入 `network-ready`，且路由只包含
`10.91.0.0/16` 与 `10.88.100.3/32`。

随后登录 User Center。若 Internal 已是 `network-ready`，Luopan 会自动：

1. `POST /internal/v1/user-center/users/:userId/oversea/ensure-subscription`；
2. 等待 `ensure.ready=true`，以内联 YAML 更新本机 tunnel runtime；
3. 启动应用级 mihomo mixed 代理；
4. 在 **Home to Oversea → 测试** 中用隔离窗口验证 Google 等站点。

安全流程固定为 **匿名 Connect Internal → 隧道内登录 → 自动确保订阅**；公网
bootstrap 只承载匿名首连，不承载账号、密码或 bearer token。若需要 user-range
lease，登录后执行一次 **Disconnect → Connect Internal**。若显示“等待远端同步”，先修复 Internal 的 Oversea SSH/runtime sync，
再点“刷新订阅”。不要把订阅 URL、token 或 Hysteria2 密钥写入 `.env`。

开发依赖使用 `pnpm run setup`（workspace local 模式）；只有正式打包前才改用
`pnpm run setup:npm`。这里不能省略 `run`，否则会调用 pnpm 自己的环境 setup 命令，
不会执行项目脚本。正式连接不需要 `LUOPAN_SDK_TEST_MODE=1`。
