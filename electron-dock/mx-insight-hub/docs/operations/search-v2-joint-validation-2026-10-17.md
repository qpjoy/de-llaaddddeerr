# 搜索 v2 联合验证记录（2026-10-17）

## 交付边界

Hub 新增 `/api/v2/data/search`；罗盘 → Java → Delta 为新业务显式选择 v2。旧请求、旧计划的后续增量、旧 Run 和旧 AgentVersion 沿原协议执行。不需要把所有下游 v1 调用整体替换成 v2。

本次已将 Delta、Java、罗盘修改写回用户指定的工作目录，写入前核对源码 HEAD 和逐文件基线哈希，写入后核对与测试版本一致。Java 基于更新后的 `b48124c8c2ca1ab304d39c494bffcf2724f25a06`；罗盘基于 `b90a8d1727df760a6468b4340bb90fb2984d4dd9`。保留原有作者信息映射、分页、环境和计划归属校验。

生产未部署，未修改线上数据库、授权、密钥或网络配置；验证使用模拟供应商，不产生真实采购。

## 已验证链路

- 冷启动：Java 业务范围进入 Delta 计划，Run 固定窗口，HTTP 请求实际包含完整 `timeWindow`。
- 增量：新 Run 根据原有进度语义确定窗口；分页与重试保持其原窗口和协议。
- 日报补搜：新日报保存 `data_as_of`、时区和方向范围，v16 发出同样的完整窗口；旧 v14/v15 保留。
- 分页：空的交付页有游标时仍可继续；两版本游标隔离，查询、时间窗或调用 Key 改变后不能复用。
- 幂等：v2 同键重放已保存的完整交付，包括原游标，不因时间经过而重复采购；v1 原语义保留。
- unknown：跨协议、改键、改窗、改游标或手工 rerun 不能绕过；底层采购成功与 v2 投影已确认分别记录；账本不可读取时不能放行为可重试。
- Java 重试：沿原 Run 调用 retry，保留原窗口/版本；409 不新建，429 携带有效新 Run 时绑定，响应未知时锁定本地重试 claim。

## 可复现测试

### Hub

```sh
MX_INSIGHT_TEST_PGLITE_MODULE=/path/to/@electric-sql/pglite/dist/index.js \
node --test tests/server/data-search-v2.test.mjs \
  tests/server/facebook-search.test.mjs tests/server/public-docs.test.mjs
```

最终核心套件 82 项通过，3 项需要独立 PostgreSQL 环境的既有测试按条件跳过。v2 新增 20 项覆盖协议、真实本机 HTTP 路由、合成的四平台响应与 PGlite SQL；Facebook 另加 5 项实际适配器/存档/分页执行链回归。OpenAPI 新路径使用 `/` server 覆盖，旧 v1 全局 base 不变。

扩展回归还覆盖原有 Instagram/Reddit 搜索、游标、fresh/stable 幂等窗口、请求状态、分页存储和浏览器 SSO，相关测试通过。另有一项真实 HTTPS OIDC + PostgreSQL 集成测试因未配置该环境跳过。PGlite 执行真实迁移和 SQL，但不替代多进程 PostgreSQL 并发或生产流量验证。Hub 类型检查通过。

### Java 与跨语言契约

在 `po-backend-java` 执行相关 Java 套件，并生成实际请求构造器和模拟 HTTP 捕获的 fixture：

```sh
mvn -o -q test-compile org.apache.maven.plugins:maven-surefire-plugin:3.1.2:test \
  -Dtest=PoliticalDailyAgentClientTest,PoliticalDirectionMonitorServiceTest,PoliticalReportControlTest,PoliticalReportWorkspaceServiceTest,PoliticalWorkspaceEnvironmentIsolationTest,LegacyStrategyCreationServiceImplTest,PoliticalSearchContractTest,PoliticalSearchContractFixtureTest,PoliticalWorkspaceDatabaseRecoveryTest,PoliticalReportWorkspaceControllerTest,StrategyConfigPlanOwnershipTest
```

115 项通过。显式使用本机已缓存的 Surefire 3.1.2；原 2.22.2 插件缓存缺少执行器类，未修改项目 pom。

在 Hub 执行：

```sh
node tests/integration/search-v2-business-chain.mjs \
  /Users/qpjoy/workspace/mingxi/po-infra \
  /Users/qpjoy/workspace/mingxi/po-backend-java/target/search-v2-contract-fixture.json \
  python3
```

12 条用例通过，覆盖 Facebook/Twitter/Reddit/Instagram × 冷启动/增量/日报。执行真实 Delta 窗口及请求构造函数、Hub 参数归一化、供应商日期转换、交付过滤和游标编码。ORM 与外部供应商使用测试适配器，不代表真实数据完整性。

### Delta

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest \
  llm.tests_facebook_hub_window llm.tests_facebook_daily_phase1 \
  llm.tests_search_v2 llm.tests_search_run_control \
  data_hub.tests_facebook_cold_start_window data_hub.tests_facebook_incremental_window \
  data_hub.tests_facebook_page_requests data_hub.tests_cold_start_range \
  data_hub.tests_cold_start_diagnostics data_hub.tests_cold_start_retry -q
```

147 项通过。使用 Python 3.12，执行生产函数并隔离 ORM/队列/HTTP；此次没有连接 Django 生产或测试数据库。

### MX-H2I 边界与罗盘

Launcher 密码登录、飞书授权、产品网络隔离、产品用户访问、租约身份和匿名接入策略 34 项通过。Launcher/MX-H2I 源码和配置未改动。罗盘业务条件与重试定向测试、Vue 脚本与模板编译通过；本地登录验证码旁路保护测试通过。

罗盘 PoliticalNews 扩展测试 51 项中 50 项通过；`PoliticalNewsPage.test.js` 的 `leadMinutes` 断言在未改源码上也失败，属于已有基线问题，本次未改该断言或推送业务。

## 发布依赖

先完成 Hub 新增的 `158_data_search_v2_protocol.sql` 迁移与 v2 服务，再同步 Delta Web、全部 worker 和 v16 Agent，最后发布 Java、罗盘新业务入口。不能单发新 Java 让旧 Delta 静默忽略 v2 标记。旧任务仍需其旧 AgentVersion 和 v1 服务。

回退时先停止新建 v2 业务，保留已持久化 v2 请求的执行能力与 unknown/幂等记录；不能用 v1 接管已有 v2 任务。具体 Hub 契约见 [v2 接入说明](../integrations/data-search-v2.md)，业务侧规则见 Delta `docs/search_v2_migration.md` 和 Java `docs/political-search-v2.md`。
