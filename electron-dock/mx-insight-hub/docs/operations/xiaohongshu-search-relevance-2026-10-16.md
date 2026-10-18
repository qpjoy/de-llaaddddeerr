# 小红书 raw 搜索相关性排查（2026-10-16）

## 现有证据与边界

用户报告 `POST /api/v1/night-all/search/raw` 的三组查询：

| 查询 | 报告条数 | 提供的关联 ID |
| --- | ---: | --- |
| 杨小幂 AI合成 投诉 | 20 | `b42243d1-0dfd-45e5-99a5-9aebf3216dae` |
| 杨幂 论文 引用规范 | 20 | `c4dcec7a-8d2e-4aef-89a2-e93dfab10fae` |
| 杨幂 造谣 抹黑 维权声明 | 14 | `a330ca1e-cfd2-467e-9525-3d9dc31d69bd` |

前两组包含小说、医美心得、论文辅导等明显噪声；第三组较相关。这是用户提供的交付观察。第一轮现场回执现已取得，见下方；没有重新发起搜索。
标题/正文没有出现姓名不等于每条都不相关；图片、视频、简称和上下文不在这个字面统计范围。
不能仅凭 URL 中有 `night-all` 就判断执行方，也不能把检索质量问题与截图中的另一笔 Twitter `night_all_outcome_unknown` 混为同一故障。

已完成本地代码核对：

- 单一 `query`、`count=20`、无特殊参数的小红书 raw 请求，在已启用直连合同时进入 Hub 的 TikHub 搜索适配器；两条 raw URL 保持原兼容合同。生产是否部署、是否开启以及该次是否命中缓存，需要账本确认。
- 当前实现将整条去除首尾空白的查询传入 `keyword`，不拆词、不改写姓名、不丢弃前面的词。三条真实适配器离线 HTTP 捕获均验证这一点；没有发送供应商网络请求。
- Hub 固定使用 `sort_type=time_descending`、`ai_mode=0`。本机 Night-All 的 `lib/domains/search/providers/tikhub/static-endpoints.js` 同样显式使用时间倒序，因此不能据此宣称 Hub 迁移改变了排序。
- [TikHub 当前搜索文档](https://docs.tikhub.io/420136398e0)说明 `general` 为综合排序、`time_descending` 为最新排序，`ai_mode=0` 为关闭。文档没有承诺空格分词后的严格 AND 或必须命中人名。时间排序/供应商召回语义是待验证因素，尚不能确定为本次原因。

此次不修改 raw 的搜索词、排序、过滤、计费或分页，不以静默删除未命中姓名的行来掩盖上游质量。生产证据若显示关键词映射或交付关联错误，再针对已证实的缺陷修复；原始供应商页的主体缺失现象已经确认，后续业务相关性治理应在独立、明确的研究检索策略中设计主体约束和质量标记，而不是改写历史 raw 语义。

## 第一轮现场回执（2026-10-16 接收）

用户返回 `xiaohongshu-relevance.v1` 的三行完整结果。三笔都按 **Hub request ID** 命中，均为 `committed/HTTP 200`，调用时间实际是 **2026-09-14 17:16:13–17:16:33（Asia/Shanghai）**。这是历史取证，不能证明当前镜像、配置或当前搜索质量。三笔旧记录都没有可读的 `acquisition_request`；不能把缺失解释为当时没有参数。

| 查询 / Hub ID 前缀 | 本次交付来源 | 已保存交付姓名命中 | 已核验原始搜索页姓名命中 | 原始页关键词回显 |
| --- | --- | ---: | ---: | --- |
| 杨小幂 AI合成 投诉 / b42243d1 | live | 0 / 20 | 0 / 20 | 完整匹配预期 SHA256 |
| 杨幂 论文 引用规范 / c4dcec7a | fresh_cache | 6 / 20 | 本轮未取得来源调用 | 没有可据以判断的原始页 |
| 杨幂 造谣 抹黑 维权声明 / a330ca1e | live | 13 / 14 | 13 / 14 | 完整匹配预期 SHA256 |

计数是标题或固定正文别名中出现“杨幂”或“杨小幂”的行数。两份原始页及三份交付均无行/文本截断；不是相关性评分，也没有逐行证明原始页与交付内容完全相等。

已核验两份搜索档案：

- `b42243d1` 自身搜索调用 `da2ddc76-2d43-4b91-89c6-f6ce881432e1`，上游 `109e3ec3-436b-445d-8e4c-20ae709483d0`；99418 bytes，SHA256 `d51869a7508b8bce7d960e2587c96d45102d5e6c7f13b5907cd54add6bba5198`。
- `a330ca1e` 自身搜索调用 `aad1456d-d071-4359-8aef-1f58235dcff5`，上游 `e2b03a8d-0d59-4c52-b4e3-35b2f40137f8`；65067 bytes，SHA256 `90fd1a2cf5bd373afda0e494db7aa84dd1ab5846ee80316a7039803757161ccd`。

两份均通过长度、SHA256 和上游 UUID 一致性校验，搜索调用为 `succeeded/HTTP 200/business 200/billed=true`；原始回显为完整预期 `keyword`、`sort_type=time_descending`、`ai_mode="0"`、第 1 页。这排除了这两次调用因 Hub 丢掉姓名而向上游发送截断关键词的解释。第一组在供应商原始页就已出现全部标题/正文缺少姓名的现象；具体是召回、分词、排序还是平台搜索实现所致，回执没有提供唯一原因，不能将所有未出现姓名的内容判作无关。

第二组只有约 15ms 的 `fresh_cache` 网关交付、`provider_call_id=null`，不能当作新一次供应商搜索或供应商未执行的证据。V1 未读取网关 `snapshot_id`；旧缓存来源需要沿该指针核对，不能从当前可覆盖更新的 snapshot 直接推出 9 月 14 日原始调用，也不能因此宣称串缓存。当前代码的搜索指纹包含完整 query，未发现漏掉关键词的缓存键缺陷。

另有两组各 4 条 `social.posts.resolve` 明细，记录 `HTTP/business 200`、`billed=true`、`outcome=unknown`。这些是详情补全调用，和成功的主搜索调用分开。V1 的 `archive=null` 表示该脚本只检查搜索合同、未检查详情档案，不表示详情档案不存在。它们不能解释原始搜索页已经缺少姓名的现象，也不能凭 200/billed 自动结清 unknown、宣称补全成功或触发重试。

当前处理：接受两份原始搜索页的现场证据；保留第二组缓存溯源缺口和详情 unknown 的历史状态。没有足够证据修改搜索映射、排序、原始结果或历史账单；不再要求重查第一/第三组或发送付费探测来重复证明已知事实。

### V2 修正缓存诊断的遗漏

源码确认 `commitSnapshotDelivery` 写入网关 `snapshot_id`，缓存交付的 `provider_call_id=null` 是现有路径的记录方式。`response_snapshots` 的同一行会被后续成功请求覆盖更新 `captured_at/updated_at/last_success_call_id`，因此缺失调用 ID 不能直接判定丢数据，而当前指针也不是历史来源的充分证据。

脚本现为 `xiaohongshu-relevance.v2`：补充原交付 `responseCapturedAt`、网关 `snapshotId` 和同 consumer/TikHub/搜索操作范围内的当前快照元数据。时间是否相同、快照是否在该网关记录后更新由 PostgreSQL 按完整时间精度判断。`currentSnapshot.state=mutable_current_snapshot` 且 `historicalOriginConfirmed=false`，不会沿当前 `lastSuccessCallId` 读取档案冒充历史搜索；缺失或范围不匹配明确返回状态。这是诊断工具修正，不是修改缓存内容、缓存键或搜索运行逻辑。

第二轮用于核对缓存留存边界的命令如下（用户现已执行并返回，无须重复）：

```bash
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- node --input-type=module - c4dcec7a-8d2e-4aef-89a2-e93dfab10fae < server/ops/diagnose-xiaohongshu-relevance.mjs
```

这一步只能补充快照留存情况，不保证恢复已被覆盖的历史来源；不通过时间邻近、唯一候选或重复付费查询补猜缺失证据。V2 已在实际 PGlite 覆盖未更新快照、微秒时间、后续覆盖更新、快照缺失及跨 consumer 隔离。

## 第二轮现场回执：缓存指针与时间已核对

用户返回三笔完整 `xiaohongshu-relevance.v2`，第一、第三笔原始搜索档案 SHA、关键词回显和姓名计数与 V1 一致。

第二笔 `c4dcec7a-8d2e-4aef-89a2-e93dfab10fae` 的新增证据如下，时间均为北京时间 2026-09-14：

| 字段 | 记录 |
| --- | --- |
| 请求预留 / 交付 | 17:16:21.365 / 17:16:21.380，约 15ms |
| 原交付保存的采集时间 | 17:12:15.057 |
| 网关保存的 snapshot ID | `15669274-aa13-42cc-9c83-a343f15ea57b` |
| 当前同范围快照采集时间 | 17:12:15.057 |
| 当前快照记录的更新时间 | 17:12:18.553 |
| 当前快照指向的成功调用 | `9453daf3-ad66-4fc7-a17e-63b8e70e741d` |
| PostgreSQL 精确时间校验 | `captureMatchesDelivery=true`、`notUpdatedAfterGateway=true` |

交付引用的数据采集于 **246.323 秒（4 分 6.323 秒）前**；快照记录的更新时间早于交付 242.827 秒。两个布尔值来自 SQL 的精确时间比较，不是 JavaScript 毫秒舍入或相近时间推断。现有记录支持该请求复用了此前的独立快照，没有呈现该快照在交付之后更新的时间证据。

三笔网关的 snapshot ID 分别为 `88a463bb-240c-45a1-9402-494910d995f9`、`15669274-aa13-42cc-9c83-a343f15ea57b`、`8bb85dd2-4b76-46fd-8f83-a6615c76626c`；对应当前来源调用也分别为 `da2ddc76-2d43-4b91-89c6-f6ce881432e1`、`9453daf3-ad66-4fc7-a17e-63b8e70e741d`、`aad1456d-d071-4359-8aef-1f58235dcff5`。没有证据表明第二笔直接复用了刚返回的第一笔快照；这不等于对所有历史缓存内容完成了逐行一致性审计。

`historicalOriginConfirmed=false` 是 V2 对所有可变快照固定返回的保守标记，第一、第三笔也一样；它不是校验失败、缓存损坏或串数据告警。本轮仍未读取 `9453daf3...` 的原始响应，不能补写该来源调用的关键词、HTTP、计费或原始页姓名统计。第二组可确认的内容仍是原交付 query 哈希正确、20 行中 6 行有姓名。

本事故的取证在此收敛：已确认完整关键词到达第一/第三笔上游，第一笔原始页存在主体缺失；第二笔有独立早期缓存的留存证据。未建立 Hub 丢词或缓存键遗漏 query 的代码缺陷，供应商内部召回/分词/排序原因仍未确定。不再增加泛化日志查询或要求重复执行 V1/V2，也不以新付费搜索推断旧请求。原始 raw 合同保持，相关性治理应另行明确主体约束和质量标记；详情 unknown 继续作为独立历史状态保留。

本轮仅更新回执结论与操作记录，没有搜索运行代码、数据库、授权、账单或部署变更。MX-H2I 登录和联网保持原状。

## 一次只读取证

脚本：`server/ops/diagnose-xiaohongshu-relevance.mjs`。只接受上表三个 ID，无参数时依次检查全部；先按 Hub 请求 UUID 精确查找，再按 TikHub 搜索的 `upstream_request_id` 精确关联。不会全库扫描正文查找名字、调用公开接口、触发 reaper、采集、重放、恢复或计费。

把本次脚本同步到服务器上的 Hub checkout 后，在 `electron-dock/mx-insight-hub` 目录执行：

```bash
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- node --input-type=module - < server/ops/diagnose-xiaohongshu-relevance.mjs
```

可直接流入现有 Admin Pod，无需发布镜像、重启、写 Pod 文件或修改 RBAC。使用 Pod 既有数据库访问；权限不足时停止，不扩大权限。输出每个 ID 一行 JSON，可以直接返回排查。

范围及输出：

- 每个 ID 独立 `REPEATABLE READ / READ ONLY` 事务并最终 `ROLLBACK`；语句 5 秒、锁 1 秒、空闲事务 10 秒超时。
- 最多关联 3 笔 Hub 请求、20 条网关记录、20 条自身或网关明确链接的供应商调用；多出的记录明确标记截断。缓存关联调用的 `ownCall=false`，不会伪装为这次重新派发。
- 保存的查询仅输出长度、SHA256、与上表预期查询完全相同/去首尾空格后相同；请求方法/路径/平台只输出固定允许值，异常值标为 `other`。不输出原查询或完整请求体。
- 分别统计不可变 Hub 交付与已核验供应商原始页中的姓名出现行数。只检查固定标题/正文别名，不递归扫描任意 JSON，不打印标题、正文、URL、令牌、凭据、游标或异常原文。
- 供应商档案须为固定 TikHub 小红书搜索合同；先验证原始字节长度、SHA256、UTF-8 JSON，再核对已保存与响应中的上游 UUID（存在时）。关联冲突时不统计笔记。单档案/交付最多 8 MiB，最多 100 行，每字段最多 100,000 UTF-16 code units；明确显示缺失、未知形状和截断。
- 仅检查原始档案固定的可选 `params` / `detail.params` 回显。未回显关键词不是关键词错误证据。查询参数快照证明调用者提交的内容，不能独自证明历史进程的 HTTP 序列化。

## 如何判断下一步

| 取证结果 | 能说明什么 |
| --- | --- |
| 保存 query/keyword 与预期不匹配 | 先核对 ID 对应的真实请求；不自动改为预期文字 |
| 原始页 hash 校验失败、档案缺失或合同不符 | 证据不足，不能推断供应商页或绕过校验 |
| 原始页已有无姓名的笔记 | 字面缺失来自原始页；结合人工已确认噪声判断供应商检索质量，不能推断所有无姓名行都无关 |
| 原始页与交付统计不同 | 进一步检查合法详情补全文、字段映射和缓存关联；差异本身不等于串数据 |
| `fresh_cache` / `stored_fallback` / `idempotent_replay` | 该交付不是一次新搜索成功证据 |
| 无匹配请求 | 可能不是 Hub/TikHub 搜索 ID，或历史连接器未保存关联；本工具不扫描 Night-All 日志补猜 |

本地验证覆盖查询保真、只读真实 PostgreSQL SQL（PGlite）、缓存调用关联、参数不匹配、未知路径/合同、档案完整性、截断、错误脱敏和 stdin 运行。测试入口：

```bash
MX_INSIGHT_TEST_PGLITE_MODULE=/path/to/pglite/dist/index.js node --test tests/server/xiaohongshu-relevance-diagnostics.test.mjs
```

两轮生产取证已由用户执行并返回；本地没有访问生产数据库或重新搜索。没有修改历史响应/账单/授权，也没有改动 Launcher 或 MX-H2I 登录、联网。
