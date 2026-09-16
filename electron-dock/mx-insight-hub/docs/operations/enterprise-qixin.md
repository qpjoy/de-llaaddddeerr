# 企业数据 / 启信慧眼

Hub 外部数据平台新增启信慧眼；接口说明统一位于「接口文档 → 企业数据」，平台详情只提供凭据、运行配置、用量与证据。

## 目录与契约依据

- 用户提供的 `/tmp/company/qixin_api/catalog.json`，快照时间 `2026-09-01T09:41:48.4710710Z`，18 类、272 项。仓库内固定副本为 `server/external-platforms/qixin-catalog.json`，运行不依赖 `/tmp/company`。
- 同项目 `client.py` 的 Auth 2.0 签名及固定接口调用；保留其 19.91、42.3 的可选字段修正，以及 66.35、22.11 的二选一约束。
- 2026-09-17 浏览核对[官方目录](https://data.qixin.com/api-list?from=qxb-navigation-data)及[1.31 企业模糊搜索](https://data.qixin.com/api-detail?categoryId=1309333f837748bbafda78c9d02f40d8&apiId=1.31)的签名、参数和状态约定。此为文档核对，不是 272 个接口的付费实测。

## 管理与启用

先执行正常 Hub 数据库迁移，包含 `091_enterprise_qixin.sql`，再发布服务。新建的 272 项运行策略全部为 disabled，不修改现有消费者或 API Key 授权，也不触发供应商查询。

在外部数据平台的「启信慧眼」详情页成对填写 **App Key / Secret Key**。时间戳与 sign 自动生成，无需人工填写。凭据使用 AES-256-GCM 加密后存入现有受限凭据表，沿用版本冲突检查；普通响应不返回明文，查看/复制必须再次输入 Admin Token。加密依赖现有 `MX_INSIGHT_API_KEY_PEPPER`；恢复数据库时必须保留同一 pepper，换 pepper 后需重新保存此平台凭据。

供应商账户需要配置 Hub 的出口 IP 白名单。按接口搜索运行配置，填写合同核实后的 CNY 最小货币单位采购价、日期和月预算，再显式选择 canary/active。官网标价仅为文档参考，不自动成为采购价或客户售价。当前金额模型为整数分；客户售价仍通过现有套餐发布/分配流程配置，每项计费键为 `enterprise.api.{apiId}`。

仅目录中标价为零的五项读取/状态接口允许显式发布零采购价：36.99、22.62、2.3、60.2、33.11。其他接口继续要求正整数采购价。没有新增余额监控、自动报告轮询或下载。

默认技术上限为供应商并发 3、单消费者并发 1、每分钟 30 次；30 秒超时、响应上限 16 MiB。仅接受固定 `https://api.qixin.com` 目录地址，禁止重定向和自定义 URL、Headers。供应商是否真实扣费记录为未知，采购成本按已审核价格估计。未知调用结果阻止自动重发。

## 对外调用与数据留存

固定公共路由：`POST /api/v1/data/enterprise/{apiId}/query`，请求体使用各接口文档列出的 `query`、可选 `body`、`method` 与 `deliveryMode`。消费者与 Live Key 需同时具有 `enterprise` 平台和 `enterprise.query` 能力。旧 Key 不自动获得新增权限。

`live_only` 为默认模式；`live_only`、`refresh` 要求 Idempotency-Key。同一请求重试保留标识，分页和新查询更换标识。`cache_only` 只读 Hub；`cache_first` 优先一小时内快照；可回退的存量范围为一天。快照按调用者与完整请求隔离。

返回的外层 `data` 保留完整业务信封，包括供应商业务 `status/message/sign/data`；不因字段名为 token、sign 或 URL 而丢失业务数据。仅删除本次平台凭据/签名的精确回显。200 为完成，201/206 为无数据，202/203 为处理中；处理中不代表报告已完成，也不会触发自动查询。异常响应保留可获得的原始证据，不伪造成功；超限或无法安全转换的响应不会被截断后作为完整结果交付。

交付前，PostgreSQL 保存完整受限原始响应、调用记录、调用者快照和可靠入库任务。入库 worker 写入 `enterprise.responses.v1` / `enterprise` 的 Canonical 响应观察、修订和 outbox，进入现有检索投影链路。一次响应观察不是一家企业，不能把观察数量当成去重企业数。`GET /api/v1/acquisitions/{requestId}` 按原 Key/消费者权限复现原交付结果，不访问上游。

内存开发模式及 Admin listener 不创建付费 adapter；缺凭据、未启用或不可用只影响企业查询。MX-H2I 登录、网络和现有平台的路由保持原有实现。

## 验证

`tests/server/enterprise-qixin.test.mjs` 覆盖全目录本地校验、签名、双凭据加密及版本冲突、HTTP 身份隔离、精确响应、缓存/幂等、未知结果、零价边界和文档授权。全部供应商响应使用合成测试数据。

设置 `MX_ENTERPRISE_PGLITE_MODULE` 指向可用 PGlite 模块时，额外运行 common + Hub 全量迁移，并验证 PostgreSQL 价格策略、归档、队列、Canonical/outbox、所有者隔离及原结果复现。未设置时明确跳过数据库集成项。浏览器验证使用本地合成凭据，覆盖双字段保存、二次验证查看、平台接口筛选及独立文档导航。
