# 租户数据产品与历史 Key 接入

## 权限模型

登录成员通过 membership 归属于租户。租户业务开通配置是调用者授权的统一配置入口；真正的数据接口授权仍由调用者的数据域、业务操作、Key 范围共同决定。

- 登录后的产品入口、HTML 文档、文档直链和下载 OpenAPI，按该成员所属租户中现有调用者的授权筛选。组合授权必须在同一调用者内满足，不能跨调用者拼接。
- 具体调用用选中的 Hub API Key。其授权范围与调用者当前授权取交集，额度、状态、有效期和运行条件独立检查。
- 将已有租户绑定登录成员不会重新创建调用者，不改变旧 Key、计费、余额或历史用量。原 Key 已含 source_catalog 且调用者仍授权时，不需要重新签发。
- 新增调用者授权不会静默扩大所有 Key；成员可在 API Keys → 调整 Key 权限中选择已开放范围，点击“应用权限到原 Key”。密钥和有效期不变，原有范围的 Key 限额不变；新增范围采用当前策略上限。授权变更会立即影响该 Key 的客户端。
- 更新需要该租户的 apikey.write 权限，并检查原权限快照避免覆盖并发变更；已撤销或过期的 Key 不能更新。变更留存元数据审计，不保存明文 Key。

## 数据源目录

租户目录页面只使用 Public API；Admin 的目录治理、编辑与内部连接信息继续保留在管理面。

| 用途 | 接口 | 所需数据域 |
| --- | --- | --- |
| 分类、字段、枚举、汇总、筛选项 | GET /api/v1/data/source-catalog/metadata | source_catalog |
| 列表 | GET /api/v1/data/source-catalog | source_catalog |
| 详情 | GET /api/v1/data/source-catalog/{id} | source_catalog |
| 目录下已存数据 | GET /api/v1/data/source-catalog/{id}/items | source_catalog + mobile_commerce |

请求携带 `Authorization: Bearer YOUR_HUB_API_KEY`，使用 Hub 的公开接口地址。列表按 `pageInfo.nextCursor` 续页；改变筛选或 pageSize 后清空游标。所有 GET 调用独立计量，不使用 Idempotency-Key，也不自动重试。完整字段与响应定义位于登录后 `/docs/source-catalog` 和对应 OpenAPI JSON。

## 发布

本次增加迁移 `079_api_key_scope_events.sql`，用于权限调整审计。按已有部署流程先运行 `npm run migrate`，再发布/重启 Hub 服务和前端；不需要修改 Launcher 或 MX-H2I。

前端依赖 session 新增的 productScopes 字段；后端与前端应配套发布。更新后刷新登录页面重新取得权限，已有机器调用仍使用原 Key。修改 Key 权限后，演示页点“刷新调用身份”读取新范围。

其他原本仅管理员可见的数据产品，其租户入口展示对应已授权 Hub 接口文档；不会开放管理员存量数据操作界面。
