# Twitter unknown 人工重试与政情原页恢复

本轮在原 v1 人工重试基础上补齐 Twitter v2。操作入口仍为 Hub Internal「数据浏览中心 → 请求诊断」。正常搜索的并发、登录/SSO、MX-H2I 联网、支付中心和共享数据库配置不参与变更。

## 交付与账务边界

`unknown` 表示原请求是否完成、供应方是否计费不能确认，不表示请求没有发出。原请求、原 Key、采购证据、客户 hold 和账单保留。新的人工重试独立结算，可能再次计费；必须先只读准备、明确确认后才创建一次关联请求。本次开发没有对任何生产请求执行该确认或重新采购。

Twitter v2 的原 binding、完整规范化 body、原 usage 以及当前 RapidAPI 调用合同必须相互匹配。同一 tenant、consumer 和原 API Key、原窗口、type、页大小与游标均不能改变。游标过期、缺证据、仍在执行、其他供应商和其他平台不从此入口重购。底层已 committed、仅 v2 投影未知时也不允许把重购当作投影恢复。

原请求与新的永久幂等键在采购前持久绑定。相同键恢复同一次意图；换键、刷新、并发页面或丢失 POST 回应不能分叉出第二次重试。准备和核对可显示“已经登记意图、尚无新 usage UUID”，不能把没有 UUID 当作没发出采购。后续再次 unknown 时沿已有的单线关联核对，不从旧祖先另建分支。

## 使用步骤

1. 在原请求诊断选择「准备按原参数重试 Twitter」，核对原接口、完整 v2 时间窗/游标和原 Key。准备是 GET，不解密供应方凭据、不预留、不采购。
2. 符合条件时点击「确认按当前链路重试（可能再次计费）」。面板保留新的幂等键；若断线或 HTTP 回应不一致，选择「只读核对重试结果」。只有服务端证明确实尚未派发、协议可重试且游标仍有效时，才显示人工继续同一重试的按钮，继续使用已登记的键和原参数。真实 unknown 或仅缺少 UUID 不允许再次发送。不要用重建策略代替原请求核对。
3. 只有新请求的 v2 协议交付为 `complete`，且保存的业务 HTTP 结果成功，才可用于恢复数据。底层 usage 的 `committed` 与 v2 完成交付分别展示。
4. 恢复政情原页使用 Delta 已有 `reconcile_hub_search_page` 管理命令，先不带 `--apply` 只读检查。使用实际 Run **数字 ID** 和已保存的 stream，不能把截图的 Run UUID 当成数字 ID，也不能猜测 stream：

   ```bash
   python manage.py reconcile_hub_search_page --run-id <数字ID> --stream <原stream>
   python manage.py reconcile_hub_search_page --run-id <数字ID> --stream <原stream> --apply
   ```

5. 仅对已经停止的原 Run 应用恢复。命令在原 Run 行锁下比较指定页及 blocker 的完整快照，只写恢复指针、保留原 key 和原 request ID；不发采购、不入库、不推进游标、不提交采集任务。若存在其他 unknown 页或无法归属的 blocker，继续保留它们。
6. 通过已有正常重试入口接续原冷启动 Run。采集器对恢复页仅 GET 已保存的 v2 交付，完成既有幂等入库后才确认该页与后续游标；后续正常页仍遵循原搜索与计费合同。无需改 Luopan 页面或 Java 的政情创建合同。

Delta 实现与命令说明在 `/Users/qpjoy/workspace/mingxi/po-infra/docs/twitter-unknown-safe-recovery-20261019.md`；目标仓库其他已有修改不属于本轮修复。

## API 与存储

人工重试继续使用 `POST /api/v2/data/search`，Header 为新的 `Idempotency-Key` 和 `X-MX-Insight-Retry-Of: <原 usage UUID>`。同键永久回放，不因 `type=fresh` 再次采购。新增迁移 `162_twitter_v2_retry_intents.sql` 保存单一后续意图及服务端验证的分页关联；原 v1 采购重试账本继续在第一次实际采购或交付事务中原子认领。

`GET /api/v1/requests/{原 usage UUID}/search-recovery` 使用原有效 API Key，只读返回 `mx-insight-hub.data-search-recovery.v1`：原规范化 v2 请求、原协议状态、持久后续关联及完整保存的 v2 交付。未完成时 `delivery=null`。此接口不执行 reaper、预留、采购、重新投影或历史结算，也不把底层 v1 acquisition response 冒充成 v2 的时间窗交付。

Delta 先通过原持久 key 的状态 GET 确认原 usage 归属，再读取恢复接口，逐项核对请求、时间窗、页信息、已完成关联和保存结果。传入任意“成功 requestId”不能代替持久关联。重试成功后的下一页只能继承服务端从已确认父页和原签名游标验证的关联，客户端不能自行指定要忽略的 unknown。

## 发布与验证

先按 Hub 原标准流程应用迁移 162，并统一发布 Public、Admin 与前端，再发布 Delta 对应的只读原页恢复代码。Hub 发布保留 `MX_INSIGHT_SYNC_LAUNCHER=0 MX_SMOKE_DATA=0`。正常新请求仍保持既有路由/授权/报价/预算/运行开关；没有关闭金融或未知结果保护，没有提高上游并发或请求期限。此次不执行生产发布、历史清理或付费验收。

最终 Hub 定向回归 **292/292** 通过、无跳过，包含真实隔离 PostgreSQL 的 4 项多会话竞争/精确恢复测试，以及 PGlite、客户端、HTTP 和 SSO 路由回归。Delta 目标仓库离线回归 **147/147** 通过；另将实际 Hub 服务生成的合成恢复 DTO 交给 Delta GET-only 恢复函数验证通过。类型检查、前端构建和本轮文件差异格式检查通过；临时 PostgreSQL 已停止。这些结果不代表生产硬件压力验收或线上发布。

原先 `5a05a551-e349-4be1-b7a9-a755e5406f38` 的 30 秒请求超时仍是历史 unknown；本流程提供受控恢复入口，不宣称修复外部链路的超时原因。见 [原事故证据](political-report-twitter-timeout-2026-10-19.md)。
