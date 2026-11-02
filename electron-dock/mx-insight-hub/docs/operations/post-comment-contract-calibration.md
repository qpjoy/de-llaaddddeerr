# 单帖评论：限定次数的服务器字段校验

日期：2026-11-02。用户已确认 JustOne 余额为零，本页现使用 TikHub 采样（probe v2）；不要执行旧 JustOne 版本命令。配套脚本只用于核对评论响应字段，不能把成功的 HTTP、官方例子或搜索结果附带评论当成完整迁移验收。

`inspect-post-comment-contract.mjs` 只读 Hub 保存的供应商原始响应，不发 HTTP。`probe-post-comment-contract.mjs` 使用 Hub 已有原生转发入口，各平台只申请一次首屏，不直连供应商。当前固定 TikHub 的 Twitter、Reddit、快手三个平台，供本次已经授权的少量付费验证使用。Instagram 已有历史响应可先复用，不追加付费探测。

## 先读已有响应

在同步了脚本的 Hub 项目目录执行；把 UUID 换成需要检查的 Hub 请求 ID：

```bash
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
  node --input-type=module - --request-id af456ad4-2523-4f73-a1fc-c95104b329a4 \
  < server/ops/inspect-post-comment-contract.mjs
```

旧事件若只有 Night-All connector call，没有原生供应商 call，会返回 `nativeCallEvidencePresent:false`。这表示本脚本没有可检查的 Hub 原生归档，不能证明 Night-All 没发过请求，也不能证明评论为空。

输出限定为：固定端点、调用状态、HTTP 状态、计费状态，以及 JSON 字段的路径、类型、数组长度、分页布尔信号和游标是否为空。v2 会继续遍历未知字段的子树，用 `[unknownN]` 匿名路径代替未知名称，避免漏掉整层评论列表。默认不输出任何未知属性名；显式 Twitter 结构模式的例外见下文。评论正文、作者资料、平台帖子/评论 ID、游标值、URL、密钥及错误文本均不输出。每次最多检查 3 个调用，每份原始响应 SQL 侧限制 4 MiB，先核验原始字节长度与 SHA-256，再解析 JSON；每个数组仅取前 3 个元素，深度与节点数有上限。`observedArrays` 是遇到的数组数，`sampledArrays` 是超过 3 项而被抽样的数组数；`sampledArrays:0` 不表示没有数组。`unknownKeys` 和 `truncated` 明确说明检查边界。

## 缺少归档时，每个平台只申请一次首屏

在 Hub 所在宿主机运行，目标固定为 `http://127.0.0.1:18150`。脚本需要 Node 22，不需要把供应商密钥交给操作人。`MX_HUB_PROBE_API_KEY` 使用具有限定授权的正常生产 Hub Key，不能使用 `mih_test_` 或 environment=test 的 Key（原生付费端点会在预留前返回 test_key_not_supported）；应已有 `social` 平台和下面三个原生能力授权，以及可用的现有采购控制。脚本不创建授权、不启用采购、不修改余额或自动切换供应商。

| 平台 | 固定原生能力 | 首屏供应商参数 |
| --- | --- | --- |
| Twitter | `native.t.api_3cd88a6621a01120` | `tweet_id` |
| Reddit | `native.t.api_c7f50cf300d63960` | `post_id`（`t3_` 前缀）、`need_format=false` |
| 快手 | `native.t.api_3cb972ba91c8fe44` | `photo_id` |

以上是待校准的 TikHub 替代端点，当前统一评论实现这三个平台仍固定为 JustOne，尚未切换。不能直接用 JustOne 的字段解析器处理 TikHub 响应；须先取得本页样本并核对正文、作者、时间及分页，再修改统一路由。只同步本页两个独立脚本即可采样，不需要为采样先部署统一评论改造。请在 Hub 管理台确认 TikHub 现有凭据可用，以及上表三个原生操作的审核价格和启用状态；不修改余额或扩大预算。若拒绝，贴回结果，不自动换渠道补买。

从下游现有采样目录读取 `twitter-*.request.json`、`reddit-*.request.json`、`kuaishou-*.request.json`。只接受首屏、明确的平台和一致的帖子标识；正文中 `postId`、`contentId` 或可解析的原文 URL 均可。样本中的 `method`、目标 URL、headers、cursor、params、count 和幂等键都不会作为执行指令使用。若同平台存在不同帖子首屏，报 `ambiguous_sample`，应先选择一个样本目录。

先预览，下面三条命令均不发 HTTP。将样本目录改为服务器上的实际位置：

```bash
node server/ops/probe-post-comment-contract.mjs --sample-dir outputs/hub_comment_samples_20261102/minimal-contentId --platform twitter
node server/ops/probe-post-comment-contract.mjs --sample-dir outputs/hub_comment_samples_20261102/minimal-contentId --platform reddit
node server/ops/probe-post-comment-contract.mjs --sample-dir outputs/hub_comment_samples_20261102/minimal-contentId --platform kuaishou
```

预览结果必须显示 `revision=post-comment-contract-probe.v2`、`provider=tikhub` 和表内的 `t.*` 路径；否则仍是旧脚本，停止执行。

在 Bash 中读入已有 Hub Key，先执行 Twitter；返回成功后再逐条执行需要的 Reddit、快手请求；每条最多 1 个 Hub HTTP 请求，三个平台总计最多 3 个。遇到未知结果时先查该请求，不能改幂等键再买：

```bash
read -r -s -p 'Hub API Key: ' MX_HUB_PROBE_API_KEY
export MX_HUB_PROBE_API_KEY
node server/ops/probe-post-comment-contract.mjs --sample-dir outputs/hub_comment_samples_20261102/minimal-contentId --platform twitter --apply
node server/ops/probe-post-comment-contract.mjs --sample-dir outputs/hub_comment_samples_20261102/minimal-contentId --platform reddit --apply
node server/ops/probe-post-comment-contract.mjs --sample-dir outputs/hub_comment_samples_20261102/minimal-contentId --platform kuaishou --apply
unset MX_HUB_PROBE_API_KEY
```

脚本在请求前以独占创建方式写入样本目录下 `.hub-comment-contract-probes-v1/<平台>.json`，权限 `0600`，保存随机幂等键和请求状态，不保存 Key 或帖子标识。供应商改为 TikHub 后仍复用 v1 记录目录，避免更换脚本重置本轮额度。若已经执行过旧 JustOne 版本并返回 already_attempted，请先贴回旧标记摘要，核对确定结果后再安排测试，不删除标记。相同目录重复执行、并发执行、超时后执行都会因已有标记停止；不要删除标记或换目录绕过本次次数限制。返回结果只包含状态、白名单错误码、Hub requestId 和幂等键，不打印评论响应。该标记是本轮操作预算，不是跨服务器或跨目录的全局配额。

脚本不自动重试、不续页、不跟随重定向；55 秒超时按 `outcome_unknown` 处理，不推定未扣费。Hub 原有 LCY 优先机制可能对**明确未计费**的限流拒绝重试一次，本工具不更改该机制，因此“最多 3 个 Hub 请求”不等于“底层一定只有 3 次 HTTP”。它不会因该机制增加已计费的样本数。

拿到每个平台的 `requestId` 后，逐个运行上面的只读检查，把 probe 简要结果和 inspection JSON 贴回即可。新脚本的 requestId 只取持久 usage 响应头或错误 details；顶层临时 HTTP UUID 单独保存为 httpRequestId，不能拿它查询用量归档。如果 `requestId:null`，保留本地标记中的幂等键进行后台查询，不能因此认定请求未发生。

这轮样本核对不部署 Hub，不修改历史失败响应，不操作 MX-H2I 登录或联网配置。当前只是在已有原生转发入口校准 TikHub 格式，统一评论尚未改为 TikHub。字段映射与分页实现通过测试后才发布 Hub，并通过新的幂等键做首次业务验收；旧失败请求的不可变回放保持原结果。


## request_not_found 时先读原始采样结果

不要重新采样或删除尝试标记。在原执行目录读取 `.hub-comment-contract-probes-v1/twitter.json`，其中只有安全摘要，没有 API Key。旧脚本可能把预留前拒绝的 HTTP 关联 UUID 误标为 requestId，导致 Admin usage 查询无记录。此现象本身不能证明供应商未调用或没有扣费。

必要时用原 Hub Key 和标记内的 Idempotency-Key，对同一 18150 服务发只读 `GET /api/v1/requests/by-idempotency-key`，Idempotency-Key 放请求头。其 `data.id` 才是持久 usage ID，顶层 requestId 是本次查询的 HTTP ID。若该 GET 能查到记录而 Admin 数据库查不到，再核对 Public/Admin 实际连接的运行环境；不要输出数据库连接串或密钥。

历史返回不会改写。此前“测试 Key”措辞已修正：原生端点不支持 test 环境 Key。原脚本会将 test_key_not_supported 归为 other，修复后的脚本保留该固定错误码；需要查看原结果状态和实际 Key 类型后才能判断是否是本次原因。


### Twitter 首次操作结果：401 invalid_api_key

用户回传 v2 采样记录：HTTP 401、invalid_api_key、幂等键 comment-calibration-v1-22dabde8-689e-44da-8d91-3b9fbfb574df，临时 HTTP UUID 571b478a-4d88-42e5-b15c-bc2b4ab134dc。这一次是 Hub 鉴权阶段拒绝，未进入原生 gateway 采购，不是 TikHub 错误，无法通过该 UUID 找 usage 记录。保留原 marker；不据此删除其他未知请求记录。

改用此 Hub 实例签发的完整有效 Live API Key（mih_live_，不是供应商 Key、管理员 Token、Key ID 或界面掩码）。先仅 GET /api/v1/data/capabilities，读取 data.capabilities 中 native.t.api_3cd88a6621a01120 的存在性和 ready；此 GET 不采购、不创建 usage。ready=true 才表示当前检查时该能力可用，不是供应商现场响应验证。data.platforms 过滤了非历史平台，不能用它缺少 social 判定无权限。鉴权与就绪结果待回传后，再用保留的原幂等身份安排一次采样；不自动重发。


### 鉴权已恢复后的单次采样

用户回传只读检查 HTTP200、twitterNativeGranted=true、twitterNativeReady=true。允许继续原已授权 Twitter 一页采样，不再要求确认。先同步新版 probe 脚本（导出 POST_COMMENT_AUTH_RETRY_VERSION=1），无需重启 Hub。调用 runPostCommentProbe 时显式传 retryAuthenticationFor 为原键 comment-calibration-v1-22dabde8-689e-44da-8d91-3b9fbfb574df，postId 仍为 2117082385997250767，sampleDirectory 仍用原执行目录。

此恢复只接受保存的明确 401/invalid_api_key、单次 HTTP、匹配的平台/路径/版本/幂等键且没有持久 usage 来源。原 twitter.json 完全保留，新的 twitter.auth-retry.json 在发送前独占创建，复用原幂等键；重复、并发和超时后执行都不再采购。不得用它恢复 unknown、供应商拒绝或其他 HTTP 状态。新采样返回 requestId 才用于只读归档检查，原临时 UUID 不再用于 usage 查询。18 项操作测试通过；本地未发真实采集请求，等待服务器本次采样结果。

### Twitter 已成功计费：继续读同一归档

用户回传的持久 usage ID 为 `f33e6d06-97f0-46c2-a049-c69ccfabf41d`，原幂等键未变。TikHub 原生端点 `native.t.api_3cd88a6621a01120` 的 HTTP/businessCode 均为 200、outcome=succeeded、billed=true、usage=committed；2516 字节原始响应已通过 SHA-256 校验。这确认本次 TikHub 调用成功，尚未完成统一评论接口的字段验收。保留 `twitter.json` 和 `twitter.auth-retry.json`，本轮不重采、不续页。

v1 摘要显示 `data.id/text/author/conversation_id/replies/cursor`，其中 replies 是数字，cursor 非空，还有 26 个未展开字段。不能把 data 直接当评论，也不能据此认定没有评论。同步新版检查脚本后，在 Hub 项目目录执行：

```bash
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
  node --input-type=module - \
  --request-id f33e6d06-97f0-46c2-a049-c69ccfabf41d \
  --twitter-post-id 2117082385997250767 \
  < server/ops/inspect-post-comment-contract.mjs
```

这条命令只读同一归档，无 HTTP、无付费、无重启或镜像发布。应返回 `revision=post-comment-contract-inspection.v2`、`supplierHttpCallsMade=0`。`--twitter-post-id` 仅用于该固定 TikHub Twitter 端点：所有已知 ID 字段输出与操作人提供的帖子 ID 的相同/不同关系，不返回 ID 值、不将长 ID 转成 Number；不安全的数字单独标记。比较目标来自命令参数，不代表脚本重新核验了历史请求参数。

该显式模式在 `data` 同时具备 id、text、author 的帖子对象结构时，还输出其直接未知字段的受限名称（字母开头、仅字母数字下划线、最长 64 字符）及匿名路径对应关系，方便一次核对列表映射。嵌套动态对象的未知键名、其他格式的未知键名及原始字符串/数值继续隐藏。`rootIdRelation` 和 `conversationIdRelation` 分开检查；相同/不同本身不代表评论语义已验证。非空游标也不保证下一页一定有评论。

v1 的 usage.platform=other 是诊断白名单输出，不能据此判断 Twitter 被错路由；v2 单独允许 usage 的 social/ecommerce 作用域，同时保留 calls 中实际供应商平台证据。等待本次结构结果后再确定 TikHub 解析和统一路由切换，不改历史回执、登录或联网流程。

本地检查器 10 项测试通过，覆盖归档完整性、只读查询、未知子树、数组及遍历边界、64 位 ID、显式字段名范围和固定端点隔离；未发真实供应商请求。
