# Facebook 冷启动被既有未知交付阻塞（2026-10-17）

下游 Data Hub 报告 Facebook 冷启动第一页失败、完成0页、入库0条，策略Key为
`bb9721db-95e5-44c1-abe4-6b031dfb19be`。错误中Hub请求ID为
`76cb46bb-1bfe-4eec-a4d3-25048a763dda`，HTTP409，`request_outcome_unknown`，
精确消息为 `An equal Facebook delivery has an unknown outcome`。
告警单独的“检索式”“请求ID”字段均显示“-”，但原因文本保留了Hub ID。

## 已确认的代码路径

Delta的 `operation=raw` 是调用方动作名；此形状使用Hub标准 `POST /api/v1/data/search`。
上述精确消息来自 `facebook-search-fill.mjs` 对 `facebookFillUnknownFor` 的检查，
它查找同tenant、consumer、API Key、请求指纹，平台facebook、路径 `/api/v1/data/search`，
状态unknown且预留时间距当前不超过24小时的记录。

这与 `request_in_progress` 的正在执行锁不同：即使当前dispatch lease已经释放，
保存的unknown仍可阻止再次采购。错误details里的requestId由网关附加为本次交付ID，
不是命中保护的原unknown ID。判断发生在交付开始及后续准入重验处，
不能只凭下游0页/0入库断言本次没有供应商调用。

unknown可能来自传输结果不明、供应商调用或交付持久化不明、过期预留恢复等路径。
必须先找到相关原请求并核对调用和归档证据；截图不足以判断具体原因。
已有成功call或归档也不等于允许继续：正式续页读取还要求usage交付状态、范围、
时效、合同及原始字节完整性符合要求，不能把旧unknown直接改为成功。
24小时是当前检查范围，不是承诺届时原请求自动恢复，也不是重新采集的依据。

## 只读取证

独立工具 `server/ops/diagnose-facebook-unknown.mjs` 按给定UUID读取目标请求，
再查同scope、指纹的当前unknown候选、各请求采购调用及归档元数据。
候选窗口从目标预留前24小时到目标完成时间；没有完成时间时上界为目标预留后10分钟。
同时标记候选是否仍满足当前24小时unknown检查。查询只反映现存账本，
不把当前unknown状态当作事件发生时的状态记录，也不将候选直接认定为原始阻塞者。
无候选时仍可能是状态已变、记录已超出窗口或历史证据缺失。

同步新增脚本后，在Hub项目目录执行；无需重建服务：

```bash
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin \
  -- node --input-type=module - 76cb46bb-1bfe-4eec-a4d3-25048a763dda \
  < server/ops/diagnose-facebook-unknown.mjs
```

归档检查仅取存在性、大小、SHA和时间等元数据，不读取正文，也不宣称已验证完整性。
脚本不导入应用运行时、不调用供应商、不修改请求、锁、费用或检查点。
生产账本回执与后续代码复现见下文；历史unknown尚未恢复。

`tests/server/facebook-unknown-diagnostic.test.mjs` 的3项真实PGlite SQL回归全部通过，
无跳过。覆盖范围隔离、候选时间边界、当前guard与历史状态的区分、调用及候选截断、
归档元数据、敏感内容不输出、stdin错误处理，以及数据库拒绝只读事务内写入。
验证命令：

```bash
MX_INSIGHT_TEST_PGLITE_MODULE=/private/tmp/mx-ecommerce-db-test/node_modules/@electric-sql/pglite/dist/index.js \
  node --test tests/server/facebook-unknown-diagnostic.test.mjs
```

## 下游告警字段缺陷

本地po-infra的冷启动入口保存 `platform_scope.queries`，告警却只读取旧的
`query_expressions`，所以“-”不能证明检索式为空。已修复 `data_hub/alerts.py`，
按采集执行器同样的字段优先级读取，保留显式空查询快照，不重新读取策略当前配置替换历史查询。

Hub异常已经包含结构化 `request_id`，但collector将其包装为只含字符串的异常；
失败页没有把ID写入 `_collector.request_ids`，导致告警只能在原因文本中显示ID。
已修复 `data_hub/data_query_collector.py` 的Hub普通/产品异常包装和失败页保存，
保留结构化ID，写入 `_collector.failed_request_id` 并追加到历史 `request_ids`。
告警优先显示失败页ID；异常没有结构化ID时明确显示“-”，不会误用上一成功页的ID，
也不会从任意异常文本解析ID。原Telegram异常子类的request_id保持不变。
这些是告警可观测性缺陷；修复不能解除unknown阻塞、变更重试/幂等行为或声称冷启动已恢复。

po-infra执行 `python3 -B -m unittest data_hub.tests_cold_start_diagnostics`，6项全部通过，
覆盖第一页unknown、第二页失败、有/无结构化ID、查询快照优先级、产品包装和Telegram兼容。
测试通过AST加载实际生产函数，模型及HTTP依赖使用隔离适配；本机Python无Django，
未运行Django数据库全栈测试。`data_hub/tasks.py`、分页检查点、重试和幂等逻辑没有改动。
修改文件语法检查与定向diff检查通过。告警修复尚未发布，需要随Delta发布生效；
Hub只读取证脚本可独立运行，无需部署Hub新镜像。

本次不改Hub的unknown保护、客户权限、采购策略、历史结算，以及MX-H2I登录和联网功能。

## 生产回执与归档一致性缺陷

操作者返回 `facebook-unknown.v1` 回执，数据库快照时间为
`2026-10-17T06:33:22.718Z`：

- 本次 `76cb46bb-1bfe-4eec-a4d3-25048a763dda` 于05:28:24.323Z预留，
  8毫秒后以 `external_platform_pre_dispatch_failed` 释放，没有自己的供应商调用或交付响应。
- 唯一同范围unknown候选为 `274d119a-27df-48de-a193-56211e926137`，
  05:26:36.132Z预留、05:26:40.028Z完成，当前仍命中24小时unknown检查。
- 该候选唯一调用 `5152ab7f-20c5-40f6-a094-b43e67c41341` 使用
  JustOne `native.j.facebook_post_search_v1`，调用状态unknown，HTTP和错误码均为null。
  但05:26:40.016Z已保存accepted/HTTP200归档，原始响应153字节、JSON已解析。
  原始字节SHA为 `b2875f43b9e11fd43ec68d5c64fbc7c8bcc38864694e51b6f5e330fced0cb27c`，
  运营归档摘要为 `f8f36f5c399f96d88dd407a6ac6217395cd44f6af840aad8805c923185ffaea8`。
- 当前无dispatch lease。当前状态查询仍不等于记录了事件发生时的完整状态变化。

本地找到并用真实SQL精确复现了上述状态组合：

1. JustOne原生请求不含 `page`，`createJustOneCallArchiveObject` 却无条件写入
   `request.page: undefined`。归档摘要算法将undefined编码为null，而JSONB序列化会删除该字段。
2. `PostgresExternalPlatformStore.stageProviderEvidence` 回读JSONB与内存原对象严格比较，
   因缺失字段而报 `external_platform_evidence_conflict`，两次内部保存尝试均回滚。
3. Facebook流程随后用 `markPersistenceUnknown` 保存原始证据并终止交付。
   该方法不补写原未持久化的HTTP字段；成功证据里的 `errorCode: null` 又覆盖其默认错误码，
   最终出现unknown/HTTPnull/errornull与accepted/HTTP200归档并存。

这不是由空结果触发的特殊规则：空 `business_data=[]` 和有帖子的数据均可复现。
上述本地复现确认代码缺陷；操作者后续返回的精确归档验证也确认了相同的缺失字段/摘要特征，
详见下文。

已实施两处最小运行时修复：

- `server/contracts/justone.mjs` 把缺省page显式写为null。修复前后摘要完全相同，
  已有真实页码保留；不放宽数据库的证据一致性校验。
- `server/external-platforms/facebook-search-fill.mjs` 在持久化失败且原错误码为空时，
  保存 `external_platform_persistence_unknown`，不再丢失错误分类。保留unknown和防重复采购。
- 沿正常交付后的入库路径检查还发现：Facebook producer生成的
  `justone/rapidapi + facebook + night-all.search.v1` 入库任务被worker遗漏的组合校验拒绝。
  `server/workers/ingest.mjs` 仅补入这两个实际组合，保留其他平台、供应商和dataset的校验。
  这是正常Facebook结果入库的另一处缺陷，不是本案归档冲突的根因。

修复只作用于后续处理，不能覆盖历史unknown、修改归档或自动恢复该冷启动。
本次没有执行生产部署、供应商请求或账本修复。
运行时缺陷修复本身不需要迁移。后续显式历史恢复工具新增157审计表迁移，
迁移只创建恢复记录表和禁止修改/删除/清空记录的触发器，不恢复请求或修改余额。
代码正常发布时按既有Hub部署流程禁用Launcher联动和数据采购smoke：

```bash
MX_INSIGHT_SYNC_LAUNCHER=0 MX_SMOKE_DATA=0 bash scripts/manage.sh ops internal-production deploy
```

发布修复不等于完成历史请求恢复；下面的只读归档验证无需等待部署。

验证：JustOne合同22项通过；Facebook/JustOne adapter/native及buffer组合120项通过，
3项需要独立PostgreSQL实例的既有测试跳过。新增真实PGlite回归
`facebook-provider-evidence-postgres.test.mjs` 3项全部通过，无跳过；
覆盖旧缺陷、修复后幂等保存、原始字节/摘要不变、篡改仍拒绝和历史unknown不可覆盖。
Facebook错误码回归先在旧代码上失败，再在修复后通过，并验证不会再次采购。
Facebook真实service/adapter到入库任务、worker分类和字段恢复的回归，加上既有
Twitter/Instagram组合校验及Facebook字段清洗，共24项通过、无跳过。
修复前真实producer生成的两种Facebook任务均被拒绝，修复后保留完整正文、字符串ID、
未知指标null和真实0，重放不重复采购或入队。没有重放生产入库队列。

## 核验这一条历史归档

同步 `server/ops/verify-facebook-unknown-archive.mjs` 后，在Hub目录执行：

```bash
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin \
  -- node --input-type=module - \
  274d119a-27df-48de-a193-56211e926137 \
  5152ab7f-20c5-40f6-a094-b43e67c41341 \
  b2875f43b9e11fd43ec68d5c64fbc7c8bcc38864694e51b6f5e330fced0cb27c \
  < server/ops/verify-facebook-unknown-archive.mjs
```

只读一致性事务按request/call/原始SHA绑定，原始响应最多4KiB、运营归档最多64KiB，
输出原始完整性、业务码/已知数组条数和摘要比对布尔值，不输出正文/查询/供应商游标。
若 `requestPagePresent=false`、`storedPayloadHashMatches=false`，但
`restoredMissingPageAsNullHashMatches=true`，说明仅补回缺失page=null即可匹配原摘要，
与已复现缺陷相符；这仍不表示已经重建交付、完成结算或允许再次采购。

验证脚本的4项回归全部通过（含真实PGlite只读事务和原JustOne producer摘要对照），
覆盖精确ID/SHA绑定、字节完整性、缺失page指纹、正文不输出、错误回滚和大小上限。

## 原始归档验证回执已确认

操作者返回 `facebook-unknown-archive.v1`：原usage/call当前仍为unknown，
accepted/HTTP200响应原始153字节通过SHA校验；`businessCode=0`，`data.results=[]`，
无cursor，`normalEmptyPage=true`、`emptyTerminalPage=true`。这是合法空终页，
不是缺少下一页或尚待补采的部分结果。

882字节运营归档中 `requestPagePresent=false`、`storedPayloadHashMatches=false`，
只在副本补回page=null即 `restoredMissingPageAsNullHashMatches=true`；
运营记录对原始body的摘要和大小引用也均匹配。生产证据与已完成的真实SQL复现相符，
支持本次失败由缺失page字段造成的归档一致性冲突。

### 旧任务恢复边界

代码修复的发布与旧任务恢复是两个动作。当前没有可直接重放原始归档并恢复Facebook
unknown交付的现成接口：`commitFacebookFillDelivery`要求usage=reserved、来源call=succeeded；
限制与恢复页面也不解除unknown。不能为了通过正常接口而先把原记录重置成reserved。

客户结算触发器允许unknown→committed，按原报价结算；已有captured不重复扣费，
但已released的客户账单不能再走此提交路径。合法空终页仍沿用原有按请求计费规则，
不能把0条结果解释为0费用。采购cost reservation的released只表示预算占位结束，
不表示供应商未计费或客户已退款。恢复前需要核对原charge、hold、终态流水及退款，
并保留原始归档字节、摘要和过去的失败记录。

Delta冷启动的普通重试会保留原Run和分页，但重新创建Step；其幂等键含新Step UUID。
标准请求未传type，Hub默认fresh、回放窗口120秒；即使手工找回原key，过期后也可能再次采购。
因此不能把普通重试当作无采购的恢复，也不能更改原请求为stable。

无采购恢复应先精确关联原幂等键中的Step UUID→Delta Step→Run→策略
`bb9721db-95e5-44c1-abe4-6b031dfb19be`，确认原页号/游标和当前Run/重试状态。
Hub完成原交付的审计恢复后，可用原API Key通过只读
`GET /api/v1/acquisitions/274d119a-27df-48de-a193-56211e926137`
取得已保存的响应及hash，不受fresh回放TTL影响；随后才能审计接回Delta原失败页，
将这份空终页记为完成。该Delta导入能力当前尚不存在，不能直接伪造成功Step或绕过group完成条件。

截至本回执，原交付、客户结算和Delta检查点均未执行恢复。

### 恢复前的只读账单与Step检查

`server/ops/prepare-facebook-empty-recovery.mjs` 固定绑定本案原request/call/原始SHA，
默认且仅支持dry-run，不实现apply。同步脚本后在Hub目录执行：

```bash
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin \
  -- node --input-type=module - < server/ops/prepare-facebook-empty-recovery.mjs
```

输出原客户charge、hold/capture/release/refund流水、原币种金额、采购预算占位状态，
以及按现有结算触发器预测的原报价capture。原charge不存在时不会生成账单或补定价格，
只说明现有触发器不会新建charge，仍需核对完整恢复条件。
同时输出幂等绑定是否仍指向原请求，从严格匹配的原Delta幂等键中只提取Step UUID和页号，
不打印原key、查询内容或凭据。

该脚本在只读一致性事务中查询，每类明细最多20条并标记截断；归档仅重新核对ID/SHA元数据绑定，
不代替前述原始字节验证，也不将无财务阻塞当作恢复已获批准或整个流程已经可执行。
任何正式恢复都还需重新核验完整证据、Delta归属/执行状态、并发状态以及操作者确认的具体变更。

该预检的3项真实PGlite回归全部通过，无跳过；覆盖原报价冻结/已扣款/已释放/退款、
无账单及孤立流水、精确身份绑定、Delta Step解析、只读事务、输出脱敏和失败回滚。

### 原账单与Delta Step回执

操作者返回 `facebook-empty-recovery-precheck.v1`，检查时间
`2026-10-17T07:50:33.008Z`。当时没有预检阻塞，usage/call仍为unknown，
没有保存交付响应，唯一供应商调用保持 `billed=true`、estimated CNY 1 minor。
采购占位已released；这不改变供应商调用的计费证据。

原客户账单 `ce660f68-a807-42d7-a3cf-d01310409b08` 为enforced/unknown，
原报价CNY 1 minor（0.01元）、charged=0、未结算，账户active且归属一致。
只有一笔原hold流水，无capture/release/refund。
按现有触发器完成原交付将消费这笔冻结款，新增capture为CNY 1 minor，
不创建新报价、hold或采购请求。正式恢复仍需在同一事务内重新核对这些状态。

原幂等绑定仍指向 `274d119a-27df-48de-a193-56211e926137`；
精确解析出的Delta Step为 `e09fc550-e30d-4098-aa6e-512e89042579`，
页号1、cursorRestarts=0。Step归属Run、策略、group及当前分页/任务执行状态
仍需由Delta数据库只读核对，不能由Hub幂等键代替。

### Delta原任务只读关联

`server/ops/diagnose-delta-facebook-empty-page.py` 只查上面固定Step，核对Run归属策略、
Facebook平台、冷启动group、当前分页及同Run第一页的尝试记录；不输出查询、游标正文或内容。
在Delta PostgreSQL上使用REPEATABLE READ READ ONLY事务并最终ROLLBACK。
它不联系Celery broker；数据库中的task ID和Step数量不能证明没有运行中或延迟重试的任务。

Delta当前仓库部署文档 `po-infra/docs/OnBoard.md` 记录正式Web容器为
`mx_data-web-1`，Dockerfile工作目录为 `/app`；尚未核验线上容器状态。
将此脚本同步到运行Delta正式容器的服务器，按实际文件位置执行：

```bash
sudo docker exec -i -w /app mx_data-web-1 \
  python manage.py shell < server/ops/diagnose-delta-facebook-empty-page.py
```

这里使用的是Delta文档中的Docker命令，不能套用Hub的Kubernetes namespace或deployment。
4项离线Python测试通过，执行真实脚本逻辑并模拟ORM边界；本机无Django，
未将该结果当作真实Django/PostgreSQL或生产集成验证。

### 显式恢复原Hub交付

`server/ops/recover-facebook-empty-page.mjs` 只处理本案固定request/call/两个归档摘要及Delta Step。
默认dry-run，重新校验完整原始字节、合法空终页、缺page的运营归档摘要、原请求和供应商指纹、
幂等归属、原客户冻结款及采购占位。原请求存在未过期dispatch lease时拒绝恢复。
日期重建使用原请求时间，并展示 `sourceWindow`；不采用执行恢复当天的默认日期。

发布上述Hub代码及157迁移后，在Hub服务器生成实际预览：

```bash
kubectl -n mx-insight-hub exec deployment/mx-insight-hub-admin -c admin \
  -- node server/ops/recover-facebook-empty-page.mjs --dry-run
```

预览给出 `canApply`、`previewHash`、拟保存的空终页摘要、实际来源日期窗和费用变化。
本案费用变化为将已有CNY 1 minor冻结款转为capture，不新增hold、不调用供应商。
只有在审核该具体预览并决定恢复原Hub交付后，使用原样复制的64位摘要执行：

```bash
kubectl -n mx-insight-hub exec deployment/mx-insight-hub-admin -c admin \
  -- node server/ops/recover-facebook-empty-page.mjs \
  --apply --preview-hash '<预览返回的previewHash>' \
  --reason '恢复已核验的原Facebook空终页，按原报价结算既有冻结款'
```

apply在单个SERIALIZABLE事务内重新核验预览，原call从unknown转succeeded，
原usage从unknown转committed并保存标准空响应，由现有账本触发器结算一次。
保留原始归档、原报价、原hold、采购费用、供应商时间及历史失败事件；
新增成功交付事件和禁止修改/删除/清空的恢复审计。没有内容行，因此不创建入库队列或快照。
不修改其他请求、熔断、限流、权限或MX-H2I状态。

重复同一apply读取恢复回执，不再次结算。COMMIT确认丢失时也只用同一摘要查询/重放，
不能重新POST采购。只读查看恢复状态：

```bash
kubectl -n mx-insight-hub exec deployment/mx-insight-hub-admin -c admin \
  -- node server/ops/recover-facebook-empty-page.mjs --show
```

恢复工具8项PGlite回归全部通过；加载完整056账本及105客户报价保护，
覆盖真实hold→capture余额投影、原归档不变、晚期失败整体回滚、确认丢失、
释放/退款/状态变化拒绝，以及完成后幂等绑定变化或账户暂停时仍能只读查历史回执。
与原归档落库复现组合共11项通过、无跳过。PGlite为单连接，未验证真实多连接锁竞争。
恢复响应与正常HubService/Gateway/JustOne生成的空终页逐字段一致（仅请求ID归一）。

### 冷启动日期窗不能由空终页推断完成

Delta旧标准搜索迁移设计只在本地过滤日期，标准请求不发送Facebook日期params。
当前Hub Facebook合同在缺省日期时只使用昨日到今日；这与整月冷启动意图不一致。
因此本案 `sourceWindow` 若为缺省的2026-10-16至2026-10-17，合法空结果只说明
这次实际请求范围为空，不能自动把Delta的2026-09-17起整月冷启动标为完成。

Hub历史交付恢复与准确时间窗的新采集必须分别处理。不得改写原请求日期/指纹，
也不得把新日期参数直接加到旧cursor，否则会改变Hub scope并可能触发下游重新采购。
截至本次本地验证，没有执行Hub生产恢复、Delta任务恢复或新日期窗采集。

Delta本地已补新任务的日期绑定：`data_hub/api.py` 创建Facebook冷启动Run时，
以原窗口的北京时间日历保存版本1 `_facebook_hub_window`；`data_hub/tasks.py`
将该绑定复制到每一页Step请求，`llm/data_query.py` 只在显式绑定存在时发送日期params。
`llm/facebook_hub_window.py` 严格验证两个日期，不接收供应商路由参数。
旧Run/游标不补字段；新Run翻页和恢复沿用原绑定，现有本地精确时间过滤继续执行。
其他平台、普通Skill和增量请求未扩大变更范围。

Delta需要发布web与执行采集的workers及共享llm代码，无数据库迁移。
新日期绑定4项离线测试通过，包含真实API创建Run→task→分页payload→标准请求构造、
保存检查点与5天后恢复、跨北京时间午夜以及旧Run/游标不改scope；
与前序告警诊断组合共10项通过。因本机缺少Django，未运行Delta全栈测试。
本次仅修改本地源码，没有创建生产Run、重置分页或启动新日期窗采购。
