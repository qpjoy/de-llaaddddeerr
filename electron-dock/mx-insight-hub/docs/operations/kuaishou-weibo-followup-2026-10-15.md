# 快手未知结果与微博互动指标再次核对

更新：2026-10-15。用户已回传统一只读报告；依据原记录、失败阶段日志及实际数据库复现修复归档写入边界。未向供应商重新搜索，未改运行时解析、代理选路或历史账本。

## 回传结果与本地修复

报告指纹与 v8 源码匹配。快手原请求 `b84a5351-0bea-4b8b-a533-276692ffa94d` 的 own call 为 `03776a61-c4c0-4a1d-8dec-15937a0d8c90`；原请求在 22:57:12 UTC 被标记 external_platform_persistence_unknown，调用随后在 22:58:07 UTC 被 reaper 标记 reservation_lease_expired。原调用没有留存归档，HTTP／business／billed 均未知。匹配该请求及调用的运行时日志明确为 `phase=finish_failure/errorClass=Error/sqlState=23502`；公开／Admin Pod 当时 imageID 均为 `sha256:8ff0e8fea41c1b43eec5555f26ce38de4c06d1772c466300bb332542bc40c729`。这将本次事故范围缩到失败回执的数据库非空约束，而非仅凭耗时猜测网络超时。

实际生产 DDL 的 `archive_objects.raw_payload` 是 jsonb NOT NULL。适配器在非法 JSON、不安全 Unicode、负零或深层克隆无法产生安全 JSON 投影时，会显式给 response 对象 `rawPayload=null`，精确原始字节仍在 restrictedResponseArchive。node-postgres 把 JS null 参数当成 SQL NULL，触发 23502；finishFailure 事务回滚前面已插入的 operational／restricted 回执，markPersistenceUnknown 重试相同对象也回滚，最后只剩待 reaper 处理的 pending 调用。四类样本均在实际 051／058 表约束下完整复现该序列。日志未保留具体列及原始上游正文，因此不能断言原调用属于哪一类样本或独立证明具体列；已确认修复的是能复现此次日志及丢档组合的具体缺陷。

修复仅在 PostgresExternalPlatformStore 的归档参数边界：`object.kind === 'response' && object.rawPayload === null` 时，传入 JSON 文本 `null`，让数据库保存 JSONB null。非空约束、其他字段、item payload 和 undefined 校验保持原样，无新增迁移、假正文或空对象替代。读回仍是 JS null，SQL `IS NULL=false`、`jsonb_typeof='null'`，读取方不会把它当作已解析正文；精确字节及 SHA 独立保留。此修复让未来该类供应商失败可稳定保存完整回执，不能保证快手上游成功，也不会恢复原 unknown 或丢失的正文。

微博查到同 Key／精确“肖战”的候选请求 `83d9b20a-0fd2-4744-a069-9678308e0949`，own call `d922f361-15d0-44d9-a761-f881dcbeb9f2`，HTTP／business 200、succeeded、billed=true、10 条 ingest，12611 字节归档 SHA `85820f9b1a3269c7b27f7eb0a098c0e3a65a60754cc3082619e4a7d27527b62f` 已核验。10 条的 interaction.like_count／comment_count／repost_count 原值均为 numeric0，views／bookmarks 缺失；六种已知指标容器和固定 raw／HTML 候选位置均缺失。Hub 候选投影如实保留 0 和 null，没有非零计数被本轮已检查字段映射丢失的证据。这仍是候选而非用户确认的精确截图回执，也不证明真实微博互动为零或任意未知字段没有备用值。当前不再猜测、补采或修改 Weibo 指标映射。

如向供应商反馈，可使用以上请求／调用及归档指纹、端点 `/api/v1/weibo/web_v2/fetch_realtime_search`、采集时间 2026-10-14 23:00 UTC 和匿名 10×3 零值汇总，询问这些 0 是实采还是解析默认、此固定端点的可靠计数来源及能否在同份响应提供字段依据；不得发送凭据或把 Hub 内部调用 ID 冒称供应商请求 ID。本轮没有发送任何外部消息。

108/108 运行时相关回归通过、无跳过：既有 store／gateway／content-store 101 项和新增 provider-failure-archive 7 项。新用例使用实际 051／058 DDL 与 056 结算触发器，验证四类失败能保全原字节／哈希、稳定原 502、原计费分类、一次结算、未知 hold 保留、item／undefined 拒绝、强制后续数据库故障的完整回滚。节点语法与 diff 检查通过。仍需操作人员同步完整 Hub 源码并重建发布：

```bash
MX_INSIGHT_SYNC_LAUNCHER=0 MX_SMOKE_DATA=0 bash scripts/manage.sh ops internal-production deploy
```

在服务器 `electron-dock/mx-insight-hub` 目录执行。此修复没有新增迁移；不要用复制诊断包代替运行时发布。旧 unknown／旧账单继续保持，不能据本地修复自动解锁或重新采购。

## 本轮记录

- 快手关键词“早上好”：Hub 请求 `b84a5351-0bea-4b8b-a533-276692ffa94d`，幂等键 `1e1fc238-ac2d-4d16-99cf-1847d20386db`，界面 `request_outcome_unknown`。这是新记录，不能用此前无归档的 `c3095da0…` 代替。
- 微博关键词“肖战”：页面显示 10 条正文，点赞／评论／分享均 0，浏览／收藏未提供。截图没有完整请求 ID，不能把此前“王一博”的 `78dfbef4…` 归档当成这次证据。页面底部“完整响应与请求证据”的顶层 requestId 可进一步确认精确归属；在取得它之前，同身份／精确关键词的最近记录均标记为候选。

快手普通行身份／分页解析失败会被包装为明确的 TikHub succeeded_unusable，再保存原始回执和稳定 502；未知结果还可能来自网络、调用开始／回执／最终交付持久化的不确定性或同意图旧未知保护。仅凭界面或耗时不能认定超时、未执行或未计费。

隔离 mock 另复现一个候选：代理路由读取在任何 HTTP 发出前抛 SQL 错误，会被适配器作为 upstream_transport_error 处理，产生 HTTP／计费未知、无归档的 unknown；相同幂等键随后重放 request_outcome_unknown。这不是新快手记录根因的证明，相同保存证据也可能来自真实连接失败。该分支作为已处理 TikHubUpstreamError 结算时，不会产生 persistence phase 日志；不能由日志为空排除它。本轮没有修改代理行为，也没有把任意传输错误改成“未计费”。

微博页面对 null 显示“未提供”，对数值 0 保留 0。Hub 的固定实时搜索和 Night-All 使用同一 query／page 端点；[官方精确实时文档](https://docs.tikhub.io/381269427e0)未提供备用 raw HTML／计数位置的成功示例。本轮不猜测 HTML 数字、不改热门端点、不新增付费详情采购、不将上游 0 伪造为非零或 null。旧 Night-All 兼容路径确有缺失指标默认 0 的行为，但不能仅根据返回 10 条推断本次走兼容路径。

## 一次只读收集（本轮已完成）

将生成的 `/private/tmp/mx-hub-kuaishou-weibo-readonly.sh` 复制到生产服务器 `/tmp/mx-hub-kuaishou-weibo-readonly.sh` 后执行：

```bash
bash /tmp/mx-hub-kuaishou-weibo-readonly.sh
```

该独立文件内含 v8 诊断和日志过滤器，不依赖服务器仓库版本，不需先发布或另装依赖；服务器需要既有 node／kubectl。只执行三类 Kubernetes 操作：在 Admin 中运行只读数据库查询、读取当前公开／Admin Pod 日志、读取两类 Pod 的镜像名称和 imageID。本地服务器仅创建 mode-0600 临时文件，结束后清理；不运行业务搜索、public request-status reaper、迁移、部署或生产写入。

数据库诊断以 REPEATABLE READ READ ONLY 事务查询已给出的 UUID／幂等键，再限定同 tenant／consumer／Key、精确“肖战”关键词、固定搜索路径、48 小时内最多 3 条近期微博候选。候选标记 recentSameKeyCandidate，不宣称精确命中截图。旧诊断默认“王一博”仍保留；v8 新参数 `--weibo-query=肖战` 使用 SQL 参数绑定，拒绝未知／重复参数、空值、超过 500 字及 NUL，不输出关键词值。

v8 新增固定 transport／proxy／body／encoding 错误码，避免把已保存代码变为 other。微博新增六种 Night-All 已声明指标容器的 present／numeric／zero／nonzero 汇总，只展开出现的固定字段，最多检查 100 行；raw／HTML 候选仅报固定路径的存在性和类型，不输出正文、URL、计数值、任意键名或做 HTML 解析。scope=fixed_candidates_only 明示未发现已知字段不等于没有任何其他备用值。业务映射保持原样。

日志只输出本快手请求的 requestId／callId／phase／errorClass／sqlState，必须同时匹配固定日志消息。过滤器有输入、行、块、Pod 数、记录数等上限，拒绝其他原始日志；没有匹配不能证明没有失败日志，可能是已处理传输未知、旧镜像、轮转、旧容器或 tail 限制。统一输出明确日志范围为当前容器过去 48 小时每容器末尾 2000 行，并保留各读取退出码，不回显 Kubernetes 原始错误文本。

## 本地验证与边界

此前 39/39 相关诊断／微博字段回归通过，无跳过，含实际 PGlite 的只读 SQL、同身份范围、48 小时／3 条限制、关键词参数化及隐私验证。原抖音业务 parser SHA 仍为 `a972eb6bf0a855f506873e137038b7ff77024bd29e4b1621491e6921e703a09e`，v7 原档 7 作品／1 推荐卡／6 词条验收保持有效。生产回传结果与归档写入修复见文首；不以本地 mock 宣称线上已恢复。

原样 v8 编译包另通过实际 PGlite 五平台／同身份“肖战”范围／默认兼容／嵌套指标和隐私验收，204 条诊断 SQL 均只读；文件与 stdin CLI 7 项参数验证通过，未建立网络或数据库连接。日志过滤器 8 项合成测试通过，包含 prefix／时间戳／多 Pod／多行和 JSON、私密字段、不匹配请求、截断和容量限制。统一脚本的 stderr 失败对象只投影固定 error／stage／SQLSTATE，Kubernetes 原始错误不会原样回显；镜像读取明确报告当前 Pod 范围及 imageIdsAvailable，不能证明已删除或先前容器的镜像。

统一脚本只接受版本、实现方式及三个源码 SHA 均精确匹配的归档报告；非预期 stdout JSON 变成固定错误，不原样输出。它的隔离 fake-kubectl 验证覆盖归档／目标日志合并成功、原始错误夹带私密字段、无日志及缺 imageID，检查只有 exec／logs／get、正确 UUID／关键词范围和临时目录清理；测试不调用真实 Kubernetes。

诊断产物：content v8 diagnosticSha256=`53f9817d12fdd473e56fc02bab51ef42ff352e9ee9f19b9fd54de1ad7d7937f4`，weiboDiagnosticSha256=`321d6f0533051b645a3fc50feb6fce4592ece230437000e5a5435734138fd5d9`，bundleSha256=`c48fbabb1106f85a9d3cdbe09052deb9574e4f444236cb59138ae0ea5e22e6ea`。旧 v7 包保持原样。本轮未改授权、价格、历史状态或 MX-H2I／Launcher 登录联网。
