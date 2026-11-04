# Instagram 熔断：JustOne 余额不足（2026-10-28）

## 结论

请求 `26bedabd-531b-41e1-afa7-d56d089e8091` 在策略搜索中返回 `503 external_platform_circuit_open`。这是**上游问题**：JustOne 账户余额不足，Hub 熔断只是暂停派发。Hub 没有调用供应商，本请求不产生供应商费用。

操作者运行只读诊断 `instagram-circuit-diagnostic.v1` 的结果：

| 项目 | 结果 |
| --- | --- |
| 请求 | `released`，2026-10-28 12:06:28 UTC，网关 `justone / circuit_rejected / 503`，无供应商调用 |
| JustOne 共享熔断 | 连续失败 2735 次，最后错误 `upstream_balance_exhausted`，每次失败后再保护 60 秒 |
| 附近失败 | 全部为 JustOne `instagram`、HTTP 200、业务码 `601`、`upstream_balance_exhausted`、`billed=false` |
| Instagram 契约熔断（Hub 解析保护） | 无记录，即 Hub 解析没有问题 |
| 路由 | `fixed / justone`，无备用供应商（revision 1，2026-10-14） |

## 恢复

两种方式任选其一，都在现有管理功能内完成，本次不改生产配置：

1. **给 JustOne 充值。** 余额恢复后，下一次请求成功即自动关闭熔断。
2. **切到 TikHub。** 在策略搜索 →“管理”中，把 Instagram 改为 `fixed / tikhub`。先发一次真实搜索确认可用；失败就改回。JustOne 充值后，可改为 `priority`（JustOne 主、TikHub 备），以后余额再出问题会自动切换。

   项目记录显示，TikHub Instagram 搜索在 2026-10-14 两次返回通用 HTTP 400，因此当时固定到了 JustOne；之后是否恢复只有用户的口头确认，没有新的成功证据，所以切换后需要先验证。在 `priority` 模式下，主供应商熔断打开后才会走备用，所以 JustOne 无余额时大约每分钟仍有一次请求先失败。余额不足期间建议用 `fixed / tikhub`。

## 改动：熔断拒绝带上原因和上游代码，诊断中心可查

**API 响应。** 所有 `external_platform_circuit_open` 都由同一个函数生成，新增：

- `cause`：`upstream`（上游连续失败）、`hub_response_parsing`（Hub 无法解析已付费的上游响应）、`hub_internal_cooldown`（内部冷却）。
- `reason`：使用实际的规范化原因码，例如 `upstream_balance_exhausted`。此前只在 4 个白名单值内传递，其余一律变成 `upstream_failure`。
- `upstream`：调用账本中该供应商最近一次失败的 `errorCode`、上游 HTTP 状态、上游业务码、`outcome`、是否计费、失败时间。

响应不含供应商名称或原文。只接受 `upstream_*` / `invalid_upstream_*` 形式的规范化代码，其他存储文本一律不输出。

证据来自 `provider_calls` 中拒绝前 15 分钟内该供应商的最近一次失败。查询走 `(provider_key, started_at DESC)` 索引，只在拒绝路径执行，读取失败时照常拒绝，只是不带 `upstream`。共享熔断报告任意平台的失败（同一供应商余额不足会同时影响电商和 Instagram）；契约熔断只看该平台的 `succeeded_unusable`。

覆盖范围：通用网关、排队后复核、TikHub 小红书采集与用户信息、Twitter fill、Facebook fill、内容搜索、社媒账号。电商采集仍沿用 2026-10-15 的决定：返回中性的 `reasonCode`，不透出上游代码。

**策略搜索等页面。** 错误面板在错误码下方增加一行：问题归属、原因码、HTTP 与业务码、保护截止时间，并注明“本次未派发上游请求”。

**诊断中心。** 网关记录为 `circuit_rejected` 且没有供应商调用时，诊断结果新增“拒绝原因（熔断保护）”：问题归属、供应商、触发调用 ID、上游错误码、HTTP、业务码、触发平台、是否计费、失败时间。建议文字和证据分析也会说明是上游问题还是 Hub 解析问题，以及下一步怎么做。这一部分在读取时从调用账本推导，不需要迁移，因此本次 `26bedabd` 这类历史请求也能查到原因。

## 验证

- 新增 `tests/server/circuit-refusal-evidence.test.mjs`：错误详情、代码过滤、契约熔断优先、读取失败容错、内存与 PGlite 查询窗口，以及诊断中心对上游、Hub 解析、无触发记录三种情况的说明。
- 扩展 Instagram 熔断路由测试，断言 `cause` 与 `upstream`。
- 用 PGlite 0.2.17 跑完整服务端套件，失败项仍是原有 45 项；另有两项此前存在的不稳定测试单独重跑 3 次均通过（其中一项会在随机请求 ID 恰好含 `601` 时误判）。前端构建与公开文档测试通过。
- 没有在浏览器中查看新界面，没有付费请求，没有改生产路由或配置，也没有改动 MX-H2I、登录或联网。尚未部署。

部署：

```bash
MX_INSIGHT_SYNC_LAUNCHER=0 MX_SMOKE_DATA=0 bash scripts/manage.sh ops internal-production deploy
```

部署后在诊断中心查询 `26bedabd-531b-41e1-afa7-d56d089e8091`，应显示“上游供应商 / upstream_balance_exhausted / HTTP 200 / 业务码 601 / 未计费”。

## 切到 TikHub 后 0 条：搜索网格换了版块布局（2026-10-28 晚）

Instagram 路由改为 `fixed / tikhub` 后，请求 `d71f27ff-d8c7-4f2d-987e-3bc9fb582a0f`（“钱学森”）返回 0 条，同时提示有下一页。只读诊断 `diagnose-instagram-search.mjs` 的结果：

- TikHub 调用 `5ee93056-c78f-43cf-b05f-50e14aa98327` 为 HTTP/业务码 200、已计费，上游 ID `96b0d67f-f182-4e23-a78e-458185dd5546`。
- 响应包含 `media_grid`，共 4 个 section，每个都有 `layout_content`，但都**没有** `medias`/`media`。
- 没有 `items`、`list`、`users`、`hashtags`、`places` 或关键词推荐；`has_more=true`，`next_max_id` 与 `rank_token` 都有。

这是 **Hub 解析问题**，不是没有结果。旧解析器把缺少 `medias`/`media` 的版块当作空版块（`layout.medias ?? layout.media ?? []`），帖子被静默丢弃。TikHub 文档仍只描述 `layout_content.medias`，实际响应已经换成 Instagram 搜索网格的其他版块布局。

修改（`server/contracts/instagram-search.mjs`）：

- 版块内的帖子还会从 `fill_items`、`one_by_two_item.clips.items`、`two_by_two_item.clips.items` 和 `two_by_two_item.channel.media` 读取，同时兼容 camelCase 写法和 `{ media }` 包装。这些容器格式错误时，仍按原规则判为 `invalid_instagram_media_grid`。
- 版块布局仍不认识时，**不再静默算作 0**：已识别版块的帖子照常交付，本页标为 `partial`，并附 `INSTAGRAM_UNRECOGNIZED_SECTIONS` 警告和版块数量。这样既不触发解析隔离、不阻断请求，问题也能在页面和诊断里看到。

`diagnose-instagram-search.mjs` 为每个版块增加 `layoutType`、`sectionKeys`、`layoutKeys`、`nestedKeys`、`knownContainers`、`knownMediaCount`、`unrecognized`。只输出符合标识符格式的结构键名（有数量上限），不输出值、正文或游标；身份校验也覆盖新增容器。

### 部署前确认真实键名（只读，不付费）

TikHub 原始响应已保存在 Hub 中，用新诊断读取即可，不需要再调用供应商。从更新后的 Hub 源码目录执行：

```bash
sed \
  -e "s|from 'pg'|from '/app/node_modules/pg/lib/index.js'|" \
  -e "s|from '../contracts/|from '/app/server/contracts/|g" \
  -e "s|import.meta.url === pathToFileURL(process.argv\[1\]).href|process.argv[1] === '-'|" \
  server/ops/diagnose-instagram-search.mjs |
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
  node --input-type=module - d71f27ff-d8c7-4f2d-987e-3bc9fb582a0f
```

看 `evidence[0].projection.shape.sectionShapes`：

- `knownMediaCount > 0`、`unrecognized=false`：这次修改能读出帖子，部署即可。
- 仍有 `unrecognized=true`：把 `layoutType`、`layoutKeys`、`nestedKeys` 贴回来，按真实键名补上。不需要付费请求。

此时的投影回放仍是已部署的旧解析器，`resultCount` 用新容器计算，`returnedCount` 反映旧解析结果。

### 部署后验证

旧请求的保存响应不会改写；“重放 / 重试原查询”只会返回原来保存的 0 条结果。需要用“新建相同查询（再次发送会计量）”发一次新的付费搜索，确认能返回帖子，或页面带 `INSTAGRAM_UNRECOGNIZED_SECTIONS` 提示。

测试：新增版块布局解析、未识别版块标记为 partial、格式错误仍拒绝、诊断输出键名但不泄露值。用 PGlite 0.2.17 跑完整服务端套件，失败项仍是原有 45 项。尚未部署。

### 键名已确认（只读诊断，未付费）

2026-10-28 用新诊断读取 `d71f27ff` 的保存响应：4 个版块依次为 `one_by_two_right`、`one_by_two_left`、`one_by_two_right`、`one_by_two_left`，每个版块的 `layout_content` 都只有 `fill_items` 与 `one_by_two_item`（内含 `clips`）。`knownContainers` 都是 `fill_items` 与 `one_by_two_item.clips.items`，每版块 5 条，`unrecognized=false`。

合计 20 条，其中 18 个不重复帖子（TikHub 文档注明 Instagram 综合搜索可能返回重复数据，Hub 按帖子 ID 去重），全部通过帖子身份校验（`invalidRowCount=0`）。已部署的旧解析器 `returnedCount=0`；部署本修改后，同样的响应会交付 18 条，且不会出现 `INSTAGRAM_UNRECOGNIZED_SECTIONS`。
