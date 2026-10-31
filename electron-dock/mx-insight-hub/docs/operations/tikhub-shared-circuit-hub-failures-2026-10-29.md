# 小红书搜索 503：TikHub 共享熔断被 Hub 自身失败触发（2026-10-29）

## 现象

Delta 调用小红书搜索（raw），Hub 返回：

- `503 external_platform_circuit_open`，请求 `0a92d464-e219-4a26-8db6-b2dd2a237490`
- `scope=shared_upstream`、`cause=upstream`、`reason=upstream_failure`、`failureThreshold=3`
- `circuitOpenUntil=2026-10-29T03:48:07.795Z`，`retryAfterMs=4445`；没有 `upstream` 字段

本次没有调用供应商，也没有计费。

## 生产证据（只读诊断 `provider-circuit-diagnostic.v1`，已核实）

- 03:47:02–03:47:07 共 10 次 TikHub Reddit 搜索（`native.t.reddit_app_fetch_dynamic_search`），全部 HTTP/业务码 200、**已计费**，但全部被 Hub 判为 `succeeded_unusable / invalid_content_search_contract`。
- 最后一次完成于 `03:47:07.795Z`，熔断恰好开到 `03:48:07.795Z`（开闸 60 秒），之后 `0a92d464` 被拒。
- 也就是说，触发熔断的是 **Hub 解析不了 Reddit 结果**，不是 TikHub 故障。
- 更早的 03:44:31–03:44:50 有一批真实的 TikHub 429（小红书、抖音、快手）和一次快手超时，这些属于供应商故障，修改后仍会计入熔断。
- 当前熔断已关闭（`consecutiveFailures=0`）。

## Reddit 搜索失败：两种新的非帖子节点（已核实并修复）

Hub 解析 Reddit 动态搜索时，只认识 `post`、`children`、`community`/`comment`/`author` 几种节点，其他节点一律判整页失败。只读诊断 `reddit-search-shape.v1` 读取已保存的响应，确认了两种新节点：

| 调用 | 内容 | 新节点 |
| --- | --- | --- |
| `93494c87` | 1 个 `SearchListComponent`，内含 6 条正常帖子（`SearchPost` → `SubredditPost`，ID 为 `t3_`） | `SearchInFeedSurveyUnit`：信息流里的调查卡片，只有 `__typename` |
| `0bf7cf68` | 只有 1 个节点 | `SearchErrorMessage`：Reddit 自己的提示，`presentation` 中有 `message`、`explanation`、`ctaButtonText`、`icon` |

两者都不是帖子，但旧规则让整页失败（已计费），6 条正常帖子也没有交付。

修改（`server/contracts/tikhub-content-search.mjs`）：

- **不认识的节点**：内部没有任何帖子痕迹时，按非帖子排除，整页照常交付。帖子痕迹包括 `post`/`posts`/`postTitle`/`permalink`/`selftext` 字段、以 `Post` 结尾的 `__typename`、`t3_` 开头的字符串，以及超过 6 层的嵌套。只要有帖子痕迹，仍判整页失败，不会悄悄丢帖子。
- **`SearchErrorMessage` 按提示文字区分**：
  - 写的是“没有结果”（no results、couldn’t find、没有找到等）：当作正常的空页，附 `reddit_no_results` 提示。
  - 其他提示：当作 Reddit 自身的错误，不当作空页，以免下游误以为“没有新内容”而跳过这一段时间。这一页失败时记录为 `upstream_search_error_message`，与 Hub 解析失败（`invalid_content_search_contract`）区分开。同页如果已有帖子，帖子照常交付，并附 `reddit_search_notice` 提示。
  - 两种情况都不计入 TikHub 共享熔断。
- 诊断升级为 `reddit-search-shape.v2`：对 `SearchErrorMessage` 只输出判定结果 `noticeClass`（`no_results` 或 `error`），不输出提示文字。判定规则与解析器一致，有测试保证。

部署后，可用同一命令确认 `0bf7cf68` 的提示属于哪一类（只读）：

```bash
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
  node --input-type=module - 93494c87-5a7e-4c90-b0b7-51793e9a1fda 0bf7cf68-6662-48aa-a5b0-9eae81301aee \
  < server/ops/diagnose-reddit-search.mjs
```

**部署前已确认（v2，只读）：** `0bf7cf68` 的提示为 `noticeClass=no_results`，即 Reddit 的“没有结果”提示，新解析器会把它当作正常的空页。两条调用的 `parser` 仍是 `installed_rejects`，因为线上运行的还是旧解析器（尚未部署）。

部署后预期：`93494c87` 的 `parser.state=installed_accepts`、`itemCount=6`；`0bf7cf68` 为 `notice` 节点，`noticeClass` 是 `no_results` 时解析器返回空页，是 `error` 时返回 `upstream_search_error_message`。如果它其实是“无结果”提示、只是措辞没被识别，就把措辞补进判定规则。

### 部署后复查（v2，只读）与末页修复

- `93494c87`：`installed_accepts`，`itemCount=6`、`nonPostCount=1`。调查卡片被排除，6 条帖子已能交付。
- `0bf7cf68`：提示已被识别，但又报 `contradictory_content_search_continuation`。原因是这一页的 `pageInfo` 同时有 `hasNextPage=false` 和非空的 `endCursor`（另有 `startCursor`、`hasPreviousPage`）。Reddit 按 Relay 分页规范返回 `pageInfo`：`endCursor` 只是本页最后一条的游标，末页也会有；有没有下一页只看 `hasNextPage`。旧规则把“有游标、却说没有下一页”当成矛盾，所以**任何 Reddit 搜索的最后一页都会失败**，不止这一次。

修改：Reddit 的 `pageInfo.hasNextPage` 明确为 false 时直接结束翻页，忽略 `endCursor`。`hasNextPage=true` 时仍必须有游标，否则照旧报错。

重新部署后，同一条诊断命令的预期：两条都是 `installed_accepts`；`0bf7cf68` 的 `itemCount=0`、`nonPostCount=1`。

**已验证（重新部署后，v2 只读诊断）：** `0bf7cf68` 为 `installed_accepts`，`itemCount=0`、`nonPostCount=1`；`93494c87` 为 `installed_accepts`，`itemCount=6`、`nonPostCount=1`。历史调用的 `succeeded_unusable` 记录和计费不会改写；之后的新 Reddit 搜索按新规则交付。

## 原因（代码）

所有 TikHub 平台（小红书、抖音、Instagram、Twitter、微信等）共用一个 TikHub 熔断：连续 3 次失败就暂停整个 TikHub 约 60 秒。

问题在于，计入这 3 次的不只是 TikHub 的失败，还包括 **Hub 自己的失败**：

| 记录的错误码 | 实际含义 | 之前是否计入共享熔断 |
| --- | --- | --- |
| `invalid_content_search_contract` | Hub 读不懂已付费的内容搜索页（例如 10-29 抖音“相关搜索”卡片问题，修复尚未部署） | 是 |
| `invalid_social_contract` | Hub 读不懂已付费的账号页 | 是 |
| `external_platform_enrichment_unknown` | 小红书详情补全时 Hub 内部出错，或已拿到数据但缺少采集时间 | 是 |
| 投影失败（`succeeded_unusable`，非供应商错误） | Hub 处理已付费的搜索结果时出错 | 是 |
| 结算写库失败后改记为 `unknown` | 供应商已应答，只是 Hub 写库失败 | 是 |

这样，某个平台的 Hub 解析问题会暂停所有 TikHub 平台，正是“上游能通、Hub 却拒绝”。

本次拒绝的 `reason=upstream_failure` 也指向这一点：熔断记录的最后一个错误码如果是供应商错误（`upstream_*`，如超时、5xx、429、余额），会原样显示；只有不是 `upstream_*` 的码，才会显示成通用的 `upstream_failure`。而上表的 Hub 错误码都不是 `upstream_*`。

本次拒绝不带 `upstream` 字段，是因为小红书搜索路径还在用旧的拒绝写法，没有附上触发熔断的那次调用（10-28 只改了小红书采集路径）。

## 修改

1. **Hub 自身失败不再计入共享熔断**（`tikhub-gateway.mjs`、`content-search-workflow.mjs`、`social-account-workflow.mjs`）：上表各项改为 `affectsCircuit: false`。
   - 解析失败的响应仍按原规则进入 5 分钟响应隔离，同一接口不会被反复付费采购，但不再连带暂停其他平台。
   - 真正的供应商故障照旧计入：超时、传输错误、5xx、429、鉴权或余额问题、接口不可用，以及 TikHub 返回的非法 JSON 或信封。
2. **熔断拒绝带上触发原因**：小红书搜索、小红书采集、排队后复核共 5 处，统一改用 `openCircuitError`。拒绝中附带最近一次供应商失败的 `upstream`（错误码、HTTP、业务码、是否计费、时间），诊断中心也能看到。内部冷却仍按原样说明。
3. **新增只读诊断** `server/ops/diagnose-provider-circuit.mjs`（`provider-circuit-diagnostic.v1`）：可用于任意平台的熔断拒绝。它列出被拒请求、当前供应商熔断状态，以及拒绝前后 5 分钟内该供应商的失败调用（平台、接口、结果、HTTP、业务码、错误码，含 Hub 自身错误码）。只读，不调用供应商，只输出已知代码和 Hub 接口名。

阈值、开闸时长和 5 分钟响应隔离都没有改，MX-H2I、登录和联网也没有改。

## 核实本次触发原因（只读）

在包含本次代码的 Hub 源码目录执行，不需要先部署：

```bash
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
  node --input-type=module - 0a92d464-e219-4a26-8db6-b2dd2a237490 < server/ops/diagnose-provider-circuit.mjs
```

看 `nearbyHistoricalFailures` 中 `completedBeforeTarget=true` 的几条：

- 错误码是 `invalid_content_search_contract`、`external_platform_enrichment_unknown` 等 Hub 自身错误：与上面的判断一致，部署本次修改即可。
- 错误码是 `upstream_*`（如 `upstream_deadline_exceeded`、`upstream_http_error`）：说明确实是 TikHub 自身故障，熔断是正常保护，只暂停约 60 秒。

## 测试

- 内容搜索解析失败后，TikHub 共享熔断计数保持 0。
- 小红书搜索的熔断拒绝带有 `cause=upstream` 和完整的 `upstream` 证据。
- 新诊断：可用于任意平台、能识别 Hub 自身错误码、查询只读，不输出未识别的存储值。
- Reddit：调查卡片被排除且帖子照常交付；“无结果”提示得到空页，其他提示判为 Reddit 错误，并在调用账本中记为 `upstream_search_error_message`，不计入共享熔断；藏有帖子的未知节点仍判失败；诊断的判定规则与解析器一致。
- 用 PGlite 0.2.17 跑完整服务端套件，失败项仍是原有 45 项；类型检查通过。

## 部署

```bash
MX_INSIGHT_SYNC_LAUNCHER=0 MX_SMOKE_DATA=0 bash scripts/manage.sh ops internal-production deploy
```

同时也会部署尚未上线的抖音“相关搜索”解析修复和 Twitter 准入等待。

## 2026-10-31 复查：拼写纠正组件（只读）

Delta 报 Reddit `409 external_platform_response_unusable`（如 `f7adc84e-f5f1-4ddb-a26d-f21e3c60e757`）。这是同一查询前一次解析失败后的 5 分钟响应隔离，本身没有供应商调用。

- 近 24 小时 Reddit 调用：`succeeded` 2001、`rejected / upstream_rate_limited` 89、`succeeded_unusable / invalid_content_search_contract` 30、`unknown / upstream_rate_limited` 4。
- 30 次解析失败全部在 2026-10-30 06:05–11:05 UTC（14:05–19:05 北京时间）之间，此后没有新的解析失败。
- 对其中三次（`84ab4773`、`f1285a1f`、`b2e21322`）运行 `reddit-search-shape.v4` 诊断：失败页都含 `SearchSpellCorrectionApplied`（`b2e21322` 另有 `SearchBanner` 和“无结果”提示）。用线上已安装的解析器重放，三次都是 `installed_accepts`：itemCount 分别为 6、7、0，并带 `reddit_spell_correction` 提示。

结论：这批失败由拼写纠正组件触发，2929aa81（只跳过该组件的三处 telemetry 子树）部署后已不再出现，不需要新的解析规则。剩余的 Reddit 失败主要是 TikHub 429（约 4.4%），由 LCY 供应商优先排队与限速处理。
