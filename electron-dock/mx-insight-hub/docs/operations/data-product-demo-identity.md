# 数据产品统一演示身份

管理台的数据产品共用当前选择，默认匹配唯一 active、未过期、Live 且名称为 LCY-delta 的 Key。若不存在或重名则显示选择入口，不自动猜测其他租户。电商与小红书的 Public API 演示不再重复输入 secret；其他产品既有管理读取仍使用管理会话。

数据库只保存原 Key 摘要，因此不恢复或复制其 secret。Admin Token 通过 POST /internal/v1/admin/demo-credentials 申请一小时有效的签名凭据，引用原 Key ID。Public 每次重新检查原 Key、consumer、tenant 状态；授权、配额、计费、幂等仍归属原 Key。没有新建 Key、扩权、修改过期时间或修改 MX-H2I 登录链路。

凭据仅放在浏览器内存，跨数据产品保留选择，切换身份重建产品视图；刷新浏览器回到默认。过期可点“刷新演示凭据”。原 Key 撤销后其演示凭据立即失效。仅 Admin Token 能签发；普通 Launcher 会话保留手动输入选项。

部署需同步更新 Admin、Public 与前端，Admin/Public 使用同一数据库和 MX_INSIGHT_API_KEY_PEPPER。本次无需数据库迁移。

## TikHub 对照测试（2026-09-13）

使用本地 Night-All/config.json 的 crawlerProviders.tikhub.apiKey，明确 curl --proxy '' --noproxy '*' 排除环境代理。一次账户查询 HTTP 200 / 3.575 秒；返回账户 active、未禁用。一次 search_notes(keyword=摄影,page=1) HTTP 200 / 2.283 秒、业务码 200、有 data。上游 request_id：5f08f785-8f53-4a00-823e-e4644dfcc983。未存储密钥或账户个人数据；搜索测试不经过 Hub，因此不在 Hub usage 中。

这证明该本地 Key 和当时直连搜索可用，不证明服务器使用相同 Key，也不保证上游持续可用。--noproxy '' 不是禁用代理：若不传 --proxy ''，curl 仍可能继承环境代理。后续排查应对照实际凭据和出口，不能仅因其他请求超时判断 Key 无效。

官方账户接口：https://docs.tikhub.io/186826050e0
官方搜索接口：https://docs.tikhub.io/420136398e0
