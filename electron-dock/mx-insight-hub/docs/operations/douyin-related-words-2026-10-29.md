# 抖音搜索 502：第 3 页相关搜索卡片被误判（2026-10-29）

## 结论

请求 `9ae63ae0-e93e-4fe9-bf69-eaf642fa55a3`（抖音视频搜索，每页 20 条，共翻 3 页）返回 `502 invalid_content_search_contract`。这是 **Hub 解析问题**，不是上游故障：三次 TikHub 调用都是 HTTP/业务码 200，并且都已计费。

只读诊断 `content-search-diagnostic.v9`（已部署版本，原地执行）的结果：

| 页 | 调用 | 结果 | 内容 |
| --- | --- | --- | --- |
| 1 | `dd93d627-e56d-4c63-9884-179bdbea2503` | `succeeded`，7 条 | 8 个条目，其中 1 个是“相关搜索”卡片（type 6），6 个词全部通过 |
| 2 | `2f485ff3-708d-48fb-8719-fecc7423c8c9` | `succeeded`，7 条 | 同上 |
| 3 | `e908369d-8bb9-49b1-a488-069b8044b7eb` | `succeeded_unusable` | 相关搜索卡片元数据通过，但第 5 个词（index 4）没有通过逐词校验 |

旧规则逐词校验时只允许固定的字段和类型。第 3 页的第 5 个词与这个固定结构不一致（旧诊断只报序号、不报字段，所以还不知道是新增字段还是类型变化），整张卡片就不能确认为“相关搜索”，只能按帖子处理；它没有帖子 ID，于是报 `invalid_content_search_identity`。一页不可用会让整个 3 页请求失败，所以前两页的 14 条结果也没有交付。该页响应会进入固定 5 分钟的响应隔离，之后自动解除，不需要人工恢复。

## 修改

`server/contracts/tikhub-content-search.mjs`：

- **卡片外层仍按固定结构严格校验**（`data`、`rs_extra_info`、`words_query_record`、`card_info`、`ui_info`、`debug_*`），出现未知字段照旧拒绝。
- **单个词放宽**：仍要求有 `related_word` 和 `word_record.words_content`；其他字段可以新增或变化（布尔、数字、空值、字符串、数组、对象都可以）。
- **帖子内容仍拒绝**：词的任何层级（最多 4 层，包括内容是 JSON 的字符串）只要出现 `aweme_id`、`aweme_info`、`video`、`statistics`、`author`、`music` 等帖子字段，整页照旧报 `invalid_content_search_identity`，不会悄悄丢掉帖子。
- **诊断给出具体字段**：`relatedWordsCoverage` 增加 `invalidPaths`（最多 10 条，`{ index, path }`），例如 `word.word_record.aweme_info:post_field`、`word.related_word:missing`。只输出符合标识符格式的字段名，不输出值。

没有改熔断、隔离、计费、准入，也没有改 MX-H2I、登录或联网。

## 部署后验证

```bash
MX_INSIGHT_SYNC_LAUNCHER=0 MX_SMOKE_DATA=0 bash scripts/manage.sh ops internal-production deploy
```

部署后用原地诊断复查保存的第 3 页响应（只读，不调用供应商）：

```bash
kubectl -n mx-insight-hub exec deployment/mx-insight-hub-admin -c admin -- \
  node /app/server/ops/diagnose-content-search.mjs 9ae63ae0-e93e-4fe9-bf69-eaf642fa55a3
```

- 第 3 页（`e908369d`）的 `projection.state` 为 `candidate_accepts`，相关搜索卡片 `nonPostCount: 1`：修复生效。
- 仍为 `candidate_rejects`：看 `relatedWordsCoverage.invalidPaths`，它会给出出问题的字段，贴回即可按真实字段处理，不需要付费请求。

旧请求的 502 和计费记录保持不变；“重放”只会返回原来保存的结果。要确认线上新请求，需要再发一次相同搜索（会计费）。

可选：部署前在装有开发依赖（esbuild）的机器上打包候选诊断，对同一保存响应运行新解析器：

```bash
node scripts/build-content-search-diagnostic.mjs > /tmp/mx-hub-douyin-related-words-candidate.mjs
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
  node --input-type=module - 9ae63ae0-e93e-4fe9-bf69-eaf642fa55a3 \
  < /tmp/mx-hub-douyin-related-words-candidate.mjs
```

服务器上的源码目录没有 esbuild 时会报 `ERR_MODULE_NOT_FOUND`，在本地开发机打包后再把文件带过去即可。

## 测试

- 新增：一个词带新的无害字段（布尔、空值、数字字符串、额外对象、JSON 字符串、空白词、图片列表混入数字）时，卡片被识别为非帖子，整页不失败。
- 保留：缺少 `related_word` 或 `words_content`、`word_record` 为空、任何层级（含 JSON 字符串）藏有帖子字段时，仍然拒绝；卡片外层未知字段仍然拒绝；诊断返回对应的 `invalidPaths`。
- 内容搜索契约、gateway 与诊断测试 149 项通过；用 PGlite 0.2.17 跑完整服务端套件，失败项仍是原有 45 项。
- 未部署，未发起付费请求，未在生产保存响应上运行新解析器。

## 后续可选

目前多页请求中任意一页不可用，整个请求都会失败，即使前几页已经成功并已计费。可以考虑改为：后续页不可用时交付已成功的页，标记 `partial` 并说明原因。这会改变下游看到的状态码和分页语义，需要另行确认后再做。
