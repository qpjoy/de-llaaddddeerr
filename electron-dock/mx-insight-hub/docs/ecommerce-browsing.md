# 电商数据：采集与已存浏览

2026-09-12。页面路由保留 `/data-products/ecommerce-treasure-box`，名称改为电商数据；列表默认，百宝箱为可选陈列视图。

## 两种分页

- **按平台采集**：默认淘宝、开放 API、refresh。首次点击从起始 page 查询，后续追加结果并保留批次内上游顺序。有 nextCursor 时用户下滑或点击下一页；没有分页证据时只允许手动尝试下一页，小红书必须使用 continuation。每次数据页是独立请求和幂等键，未决付费请求沿用原恢复机制，不自动重试。
- **浏览已存数据**：`GET /api/v1/data/ecommerce/products/items`；单平台或 all，仅本 consumer 成功提交的商品搜索响应。按请求创建时间倒序、请求 ID 倒序、商品序号升序。过滤 query 是标题子串，不是重新向上游搜索。每次 GET 计只读 usage，无供应商派发。
- 存量 pageSize 默认 20、最大 100，受 policy 进一步限制。HMAC 游标绑定 consumer、筛选、页大小、请求时间上界和精确行边界。时间上界阻止新建请求插入已翻页范围，但不宣称跨请求数据库快照；晚完成请求和保留期清理仍会改变可见历史。
- 同商品多次采集保留多次观察；当前功能不是去重后的商品主档，也不混合多个平台的实时采集。每条历史观察携带原 requestId，媒体继续走已有鉴权接口。
- 刷新当前查询重新读取指定起始页；切换条件后旧结果不能继续翻页，需重新查询。切换 API Key 清空当前结果。每页 3/6/9 只保留在百宝箱视图，和上游数据页无关。

## 参数覆盖与边界

商品搜索已发布淘宝、天猫、京东、小红书店铺、闲鱼。规范请求 query→keyword，page→page；淘宝/天猫 price.min/max→startPrice/endPrice，天猫标记由 marketplace 设置；淘宝/闲鱼 sort 按受审查枚举映射；小红书 searchId 包在签名 continuation 中。上游没有公开可设置的 pageSize，不承诺每页固定返回 10 条。

[官方淘宝搜索 V1](https://docs.justoneapi.com/zh/api/taobao-and-tmall/product-search-v1)确认 page、sort、tmall、startPrice/endPrice。
[官方闲鱼目录](https://docs.justoneapi.com/en/api/xianyu-goofish/)确认关键词搜索支持 page/sort。

商品搜索返回 Hub 归一化投影，不是原始业务 JSON 透传。已发布的平台原生接口是淘宝/天猫详情、评论、问答、店铺列表，各版本字段由 justone-resources 注册表产生文档并验证；data 保留业务字段。京东/闲鱼详情等未发布资源仍返回 unsupported_resource，不能将目录存在误称为已上线。供应商凭证由 Hub 管理，不透传客户端 token，不新增任意上游代理。

## 部署和验证

部署包含前后端与增量迁移 `072_ecommerce_stored_reads.sql`（consumer + 时间 + request ID 的部分索引）。存量读取当前依赖 usage_requests 中仍保留的成功商品搜索响应；若未来缩短其保留期，应先迁移到独立 observation/query-run 索引，再切读源，不能声称已归档全部历史数据。

验证包含内存库 consumer 隔离、签名/筛选绑定、跨 10 条翻页、只读 usage 和无上游调用；独立 PostgreSQL 临时表验证微秒时间及 ordinal 翻页；浏览器模拟两批 24 条、新幂等键、cursor/sort 保持、全部平台只读与手机视口。

未连接 mx-static；未修改 Launcher、MX-H2I 登录或网络路径；未部署线上，也未发真实付费采集。
