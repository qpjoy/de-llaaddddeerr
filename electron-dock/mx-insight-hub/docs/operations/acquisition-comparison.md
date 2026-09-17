# 数据中心：历史交付与新请求对比

采集查询复现的 GET 保持只读。Admin 可以在读取旧结果后，显式点击
“发送新请求并对比（可能计费）”。原响应、费用、requestId、幂等键继续显示，
新请求的响应、requestId、幂等键和费用另行显示。切换数据中心标签保留页面会话，
刷新整个页面则重新按 requestId 查询；不会自动发送或把比较记录写入浏览器存储。

当前支持已经通过 TikHub 执行的小红书单关键词 raw 搜索。公网兼容路径
`POST /api/v1/night-all/search/raw` 保留；满足 Hub 直连条件且运行策略启用时直接走
Hub → TikHub，不经过历史 Night-All。其他形状/平台仍按现有兼容路由策略处理，
不能把路径中的 night-all 当成物理上游，也不能声称整个兼容 API 都已迁移。

## 参数与身份

Migration 094 为 usage_requests 增加 nullable acquisition_request。
Hub 原生 raw 分支在请求通过授权、参数校验并获得新 reservation 后、上游执行前
保存 method/path/body。不保存 Authorization、Admin Token 或供应商凭证。
幂等回放不会覆盖原快照，留存失败在业务发出前中止。新字段只通过 Admin 历史响应
requestEvidence.request 展示，不加入 Public acquisition projection。
旧记录保留 NULL；指纹不可逆，不猜测参数。界面允许粘贴原 JSON，并标明“手动参数”。

对比通过既有 demo credential 机制引用原记录的 API Key；不恢复原 Key 秘密，
不创建 Key、不扩权。原 Key 失效或被撤销时不能换用默认身份发送。
实际业务请求仍经过固定公网兼容 API 的当前授权、配额、运行策略与计费检查。

## 幂等与结果边界

每次显式新请求生成独立 compare-UUID 幂等键，Hub 分配新的 requestId。
未收到响应、请求仍在处理中或结果未知时，保留该次参数和幂等键，只提供同键查询/重试，
不自动重试、不自动创建另一笔请求。收到明确响应后可以显式创建下一次比较。
新幂等键不意味着强制绕过缓存；界面优先展示交付账本的实际 sourceMode。
新响应收到后只读取一次历史证据，读取失败不会重新发送业务请求。

所有验证使用本机合成响应；此功能不自动修复历史费用或执行退款。
MX-H2I 登录、联网、Launcher 路由和供应商代理配置不受改动。
