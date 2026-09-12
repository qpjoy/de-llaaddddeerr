# 电商数据：管理列表与平台采集

## 当前交互（2026-09-12 修订）

外层“数据列表 / 百宝箱”标签默认进入数据列表。列表使用当前 Admin Token 会话，自动读取全部平台的 Hub 已存商品，不要求客户 Public API Key。标题筛选默认空，每页默认 10，可设 1–100；筛选变化重新读取，游标不会跨条件复用。读取失败显示 HTTP 错误和重试入口，与空数据明确区分。

手机面板下拉（触摸、顶部向上滚轮或按钮）是显式获取选定单平台的下一上游页，仍使用采集设置中的 Public API Key 和原有幂等账本。首次从设置的起始页开始；已结束或未知请求保持原恢复限制。上划到底只获取 Hub 历史下一页。全部平台禁用采集，包括隐藏采集设置中的提交按钮。浏览历史不会验证或使用 Public Key。

管理端接口：
- `GET /internal/v1/admin/data-products/ecommerce/items`：marketplace、query、pageSize、cursor。仅 Admin Token，全调用身份视野，不创建客户 usage。
- 同路径 POST 新增、PUT 修改、DELETE 软删除。修改/删除须带 requestId、ordinal、revision；过期 revision 返回 409。新增必须选择单平台，允许修改标题和价格。手动记录明确标记。
- `GET /internal/v1/admin/data-products/ecommerce/media`：requestId、ordinal；读取保存的图片引用，继承现有图片校验、并发、缓存限制。仅管理端凭证，不传任意 URL。

部署须包含增量迁移 `073_ecommerce_product_edits.sql`。新增管理投影独立于 usage_requests 中的原始响应：修改或删除不改变客户原响应、幂等重放及其原始媒体，软删除只隐藏管理列表。Public 已存接口仍按 consumer 隔离。迁移缺失会显示读取错误，不默认为空。

## 原始采集与 Public 存量合同

`POST /api/v1/data/ecommerce/products/search` 保留原有单平台查询、page/cursor、price、sort 和幂等语义。百宝箱作为可选演示保留这些能力。`GET /api/v1/data/ecommerce/products/items` 是另一条客户 Public API：仍需要 live Key 和 ecommerce 授权，按 consumer 隔离，默认 10、上限 100，每次 GET 计只读 usage，返回原始成功观察，不应用管理编辑。

历史按请求创建时间倒序、请求 ID 倒序、商品序号升序。HMAC 游标绑定调用身份或管理域、筛选、页大小和时间上界。上界不是跨请求事务快照，晚完成请求和保留期清理仍影响可见历史。相同商品多次采集是多次观察，不做跨批去重。目前历史源仍是保留的成功 usage 响应，不宣称覆盖已清理记录或其他尚未归一化的数据集。

## 参数覆盖与边界

商品搜索已发布淘宝、天猫、京东、小红书店铺、闲鱼。规范请求 query→keyword，page→page；淘宝/天猫 price.min/max→startPrice/endPrice，天猫标记由 marketplace 设置；淘宝/闲鱼 sort 按受审查枚举映射；小红书 searchId 包在签名 continuation 中。上游没有公开可设置的 pageSize，不承诺每页固定返回 10 条。

[官方淘宝搜索 V1](https://docs.justoneapi.com/zh/api/taobao-and-tmall/product-search-v1)确认 page、sort、tmall、startPrice/endPrice。
[官方闲鱼目录](https://docs.justoneapi.com/en/api/xianyu-goofish/)确认关键词搜索支持 page/sort。

商品搜索返回 Hub 归一化投影，不是原始业务 JSON 透传。已发布的平台原生接口是淘宝/天猫详情、评论、问答、店铺列表，各版本字段由 justone-resources 注册表产生文档并验证；data 保留业务字段。京东/闲鱼详情等未发布资源仍返回 unsupported_resource，不能将目录存在误称为已上线。供应商凭证由 Hub 管理，不透传客户端 token，不新增任意上游代理。

## 部署和验证

部署包含前后端与增量迁移 `072_ecommerce_stored_reads.sql`（consumer + 时间 + request ID 的部分索引）。存量读取当前依赖 usage_requests 中仍保留的成功商品搜索响应；若未来缩短其保留期，应先迁移到独立 observation/query-run 索引，再切读源，不能声称已归档全部历史数据。

验证包含内存库 consumer 隔离、签名/筛选绑定、跨 10 条翻页、只读 usage 和无上游调用；独立 PostgreSQL 临时表验证微秒时间及 ordinal 翻页；浏览器模拟两批 24 条、新幂等键、cursor/sort 保持、全部平台只读与手机视口。

本次未连接 mx-static；未修改 Launcher、MX-H2I 登录或网络路径；未部署线上，也未发真实付费采集。

## 筛选、双向流与媒体（本次修订）

历史 GET 增加 minPrice/maxPrice（含边界十进制价格）及 from/to（含边界 ISO 请求时间）；条件参与签名游标。平台、标题、价格在管理列表联动，采集只发送该平台支持的参数：淘宝/天猫排序与价格，闲鱼自己的排序枚举，京东没有排序或价格参数。历史仍按时间排序，不冒充上游销量排名。

下拉拿到的批次放在顶部，保留批内顺序；上游超出展示页大小的剩余记录先放前端队列，后续下拉先消费队列，不重复付费请求。改筛选清空队列；刷新页面后已提交批次仍可从历史读取。默认展示 10 条，上游 pageSize 未支持，不能保证上游恰好返回 10 条。提示按当前筛选去重并显示 10 秒。

历史记录 media 保留 originalUrl、鉴权 hubUrl、externalFeeStatus=unknown、storage=memory_relay、retrievalPolicy=cache_first、staticUrl=null。费用未有可靠来源，不能猜成免费。媒体 GET 支持 deliveryMode=cache_only，未命中返回 external_media_cache_miss 且不访问外部；默认先缓存后原链接。此版本未接 mx-static，重启后内存缓存会丢失。

/docs 的平台原生接口按业务站点分类；供应商属于 Hub 适配层，不是用户传入的公开路由参数。增加可复用 Public API 双向流控制器示例、历史参数及 OpenAPI 路径。Public Key 复现本调用身份的数据流，不获得管理端跨身份 CRUD 权限。
