# DataPort 本机验收 · 2026-10-12

此记录为本机验证，不代表生产已部署或真实支付/供应商查询已验收。没有修改生产数据库、证书、DNS 或 H2I 网络。测试使用独立 PostgreSQL 18.4、随机测试库、模拟支付中心/供应商；页面测试使用合成账号与订单。当前环境没有 Browser 插件，按 frontend-testing-debugging 技能使用本机 Playwright + Chrome。

| 范围 | 结果 | 关键覆盖 |
| --- | --- | --- |
| DataPort 全套 | 65 / 65，无跳过 | 204 退出、CSRF/Origin、接口白名单、配置迁移、部署锁、保留密钥、会话库重启 |
| DataPort 最后定向复测 | 19 / 19 | 总额度优先提示、每日限额、消费选择、部署命令与改名路径 |
| Hub Commerce / Portal / Workspace | 33 / 33，无跳过 | 商品快照、草稿不公开、每日末次并发/失败释放/跨日、偏好切换、升级付款前不生效与重复交付、租户权限、旧订阅兼容 |
| Launcher 身份登记/部署 | 5 / 5 | 迁移保留客户端及密钥、严格迁移证明、拒绝其他应用/密钥变化 |
| Launcher / MX-H2I 相关回归 | 18 / 18，无跳过 | DataPort 准入、应用访问、H2I SDK 密码认证、网络权限隔离 |
| mx-common 双应用 SSO | 1 / 1，无跳过 | 真实本机 Auth + 独立持久会话、原应用权限和退出隔离 |
| de-mingxi 安装/路由 | 24 / 24 | HTTP/HTTPS 就绪前不切换、Nginx 失败恢复、旧域名重定向、旧 API 直通 |
| de-mingxi 证书/HTTP-01 | 57 / 57 | 独立 DataPort lineage、保留 Harbor/H2I 等续期范围、复用 timer、错误处理 |
| Nginx 实际解析 | 3 / 3 | 新旧域名共存、共享片段、旧 API 不重定向，无运行中 reload |
| 生产构建 | 两端通过 | DataPort TypeScript + Vite；Hub typecheck + Vite，Hub 保留现有大包提示 |

浏览器使用 1440×1080 和 390×844。DataPort 验证退出后登录弹窗、切换优先订阅、匿名三档动态定价；Hub 验证修改价格/月数/每日次数、保存 payload、订阅切换、全价升级确认和订单意图。两端无页面异常、无控制台错误、无横向溢出。未访问生产身份/支付/供应商接口。

本机截图（均为模拟数据，临时文件不随仓库发布）：

- `/tmp/dataport-logout-login.png`：204 退出后返回登录弹窗。
- `/tmp/dataport-subscriptions.png`：当前消费、日限额、优先切换及升级。
- `/tmp/dataport-pricing-desktop.png`、`/tmp/dataport-pricing-mobile.png`：公开定价。
- `/tmp/dataport-hub-product-editor.png`：Hub 商品规则编辑。
- `/tmp/dataport-hub-upgrade.png`：新购高档套餐、旧权益保留。

发布前仍需按 [操作清单](../dataport.setup.md) 完成真实域名 HTTPS、应用 origin 迁移、Pay 返回地址、新旧 API 和原 H2I 账号的受控验收。三档新商品以草稿落库，不自动改旧商品或开放销售。
