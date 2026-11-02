# 单帖评论：限定次数的服务器字段校验

日期：2026-11-02。Twitter 原生校准与旧 URL 生产首屏验收均已完成，见本文末尾结果；保留所有标记，不再执行下方历史 Twitter 探测/验收命令。用户已确认 JustOne 余额为零，剩余平台使用 TikHub 候选校准（probe v2），不执行旧 JustOne 版本命令。原生 HTTP 成功、官方例子或搜索附带评论不能替代统一入口验收。

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

在 Hub 所在宿主机运行，目标固定为 `http://127.0.0.1:18150`。脚本需要 Node 22，不需要把供应商密钥交给操作人。`MX_HUB_PROBE_API_KEY` 使用具有限定授权的正常生产 Hub Key，不能使用 `mih_test_` 或 environment=test 的 Key（原生付费端点会在预留前返回 test_key_not_supported）；应已有 `social` 平台与本次目标对应的原生能力授权，以及可用的现有采购控制。脚本不创建授权、不启用采购、不修改余额或自动切换供应商。

| 平台 | 固定原生能力 | 首屏供应商参数 |
| --- | --- | --- |
| Twitter | `native.t.api_3cd88a6621a01120` | `tweet_id` |
| Reddit | `native.t.api_c7f50cf300d63960` | `post_id`（`t3_` 前缀）、`need_format=false` |
| 快手 | `native.t.api_3cb972ba91c8fe44` | `photo_id` |

Twitter 已切换 TikHub 并完成统一首屏验收；Reddit、快手的统一路由仍是 JustOne，上表对应 TikHub 端点尚待实际样本校准。不能直接用 JustOne 的字段解析器处理 TikHub 响应；先核对正文、作者、时间及分页，再修改对应统一路由。采样无需部署服务，需确认 TikHub 现有凭据、目标原生操作的审核价格和启用状态；不修改余额或扩大预算。若拒绝，贴回结果，不自动换渠道补买。

从下游现有采样目录读取 `twitter-*.request.json`、`reddit-*.request.json`、`kuaishou-*.request.json`。只接受首屏、明确的平台和一致的帖子标识；正文中 `postId`、`contentId` 或可解析的原文 URL 均可。样本中的 `method`、目标 URL、headers、cursor、params、count 和幂等键都不会作为执行指令使用。若同平台存在不同帖子首屏，报 `ambiguous_sample`，应先选择一个样本目录。

本轮已确认的防重记录根目录固定为 `/root/mx/workspace/de-llaaddddeerr/electron-dock/mx-insight-hub`。此前的 `outputs/hub_comment_samples_20261102/minimal-contentId` 不是已确认的回执目录，不能因为输入文件在别处就改动防重目录。

Reddit、快手先确定真实首屏样本的绝对路径，检查原根目录中的 `reddit.json`、`kuaishou.json` 标记是否存在。若输入目录不同，通过导出 API 分别指定输入与记录目录；下面仅示意零 HTTP 预览，不是新的付费执行命令：

```javascript
const plan = await loadPostCommentProbeSample(actualInputDirectory, platform);
const preview = await runPostCommentProbe({
  plan,
  sampleDirectory: '/root/mx/workspace/de-llaaddddeerr/electron-dock/mx-insight-hub',
  apply: false
});
```

预览结果必须显示 `revision=post-comment-contract-probe.v2`、`provider=tikhub` 和表内对应路径。之后用原 Hub Live Key 免费 GET capabilities，核对目标原生 capability 条目及 ready=true；原生授权平台为 social，不能仅凭过滤后的 platforms 列表判断授权。准备完成后每个平台最多发一个 Hub 首屏 POST，再读取同一归档；先 Reddit 后快手，不批量自动采购。遇到未知结果先查原回执，不能改幂等键再买。当前尚未取得这两个平台的真实目标，不能使用测试夹具里的占位 ID。

脚本在请求前以独占创建方式写入传入 sampleDirectory 下 `.hub-comment-contract-probes-v1/<平台>.json`，权限 `0600`，保存随机幂等键和请求状态，不保存 Key 或帖子标识。供应商改为 TikHub 后仍复用 v1 记录目录，避免更换脚本重置本轮额度。若已经执行过旧 JustOne 版本并返回 already_attempted，请先贴回旧标记摘要，核对确定结果后再安排测试，不删除标记。相同目录重复执行、并发执行、超时后执行都会因已有标记停止；不要删除标记或换目录绕过本次次数限制。返回结果只包含状态、白名单错误码、Hub requestId 和幂等键，不打印评论响应。该标记是本轮操作预算，不是跨服务器或跨目录的全局配额。

脚本不自动重试、不续页、不跟随重定向；55 秒超时按 `outcome_unknown` 处理，不推定未扣费。Hub 原有 LCY 优先机制可能对**明确未计费**的限流拒绝重试一次，本工具不更改该机制，因此“每个平台最多 1 个 Hub 请求”不等于“底层一定只有 1 次 HTTP”。它不会因该机制增加已计费的样本数。

拿到每个平台的 `requestId` 后，逐个运行上面的只读检查，把 probe 简要结果和 inspection JSON 贴回即可。新脚本的 requestId 只取持久 usage 响应头或错误 details；顶层临时 HTTP UUID 单独保存为 httpRequestId，不能拿它查询用量归档。如果 `requestId:null`，保留本地标记中的幂等键进行后台查询，不能因此认定请求未发生。

剩余平台的样本核对不部署 Hub、不修改历史失败响应、不操作 MX-H2I 登录或联网配置。Reddit、快手需先在原生转发入口校准 TikHub 格式，再完成字段/分页实现与回归、发布和统一入口验收；旧失败请求的不可变回放保持原结果。Twitter 已完成上述首屏流程，不重复执行。


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

### 空评论样本已确认：限定一次所属会话采样

用户回传 v2：同一归档 `data.id` 等于请求帖子 ID、`thread=[]`、`replies=0`、`conversation_id` 不同、cursor 非空，结构未截断。这次响应是请求帖子加空 thread，不是一个可以作为评论返回的根对象；它只能校准空结果，不能校准非空评论的字段。不同 conversation_id 与该帖子本身属于另一个会话的情况一致，不能将 conversation_id 与请求 ID 相等设为所有评论的通用条件。非空 cursor 也不足以证明还有评论，现有自动补页工作流不能直接按它继续采购。

下一个样本选择这份已验证归档中的所属会话 ID，重新申请该会话帖子评论的首屏。它是不同目标的一次额外付费采样，不是原请求重试，不是按旧 cursor 续页，也不改变下游实际请求的帖子 ID。所属会话更可能包含当前回复，但不能保证本次一定非空。统一 Twitter 路由仍不切换，等非空条目和分页证据。

同步 `server/ops/inspect-post-comment-contract.mjs` 和 `server/ops/probe-post-comment-contract.mjs`，无需发布镜像。下面命令显式启动 Bash 并进入已确认的服务器 Hub 项目目录，也可以从 zsh 粘贴执行。sampleDirectory 使用用户只读诊断已确认的原回执目录：`/root/mx/workspace/de-llaaddddeerr/electron-dock/mx-insight-hub`，其原始及 auth-retry 回执可读且匹配，conversation 标记尚不存在。之前写成 outputs 下 minimal-contentId 的示例目录有误，不迁移或重建回执。

```bash
bash <<'BASH'
  set -e
  cd /root/mx/workspace/de-llaaddddeerr/electron-dock/mx-insight-hub
  read -r -s -p 'Hub Live API Key: ' MX_HUB_PROBE_API_KEY </dev/tty
  printf '\n'
  export MX_HUB_PROBE_API_KEY
  node --input-type=module <<'NODE'
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { planTwitterConversationCommentProbe, runPostCommentProbe } from './server/ops/probe-post-comment-contract.mjs';
const script = readFileSync('server/ops/inspect-post-comment-contract.mjs', 'utf8');
function inspect(args) {
  return JSON.parse(execFileSync('kubectl', [
    '-n', 'mx-insight-hub', 'exec', '-i', 'deployment/mx-insight-hub-admin', '-c', 'admin', '--',
    'node', '--input-type=module', '-', ...args
  ], { input: script, encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024 }));
}
try {
  const sample = inspect([
    '--request-id', 'f33e6d06-97f0-46c2-a049-c69ccfabf41d',
    '--twitter-post-id', '2117082385997250767', '--prepare-twitter-conversation'
  ]);
  const result = await runPostCommentProbe({
    plan: planTwitterConversationCommentProbe(sample), conversationSampleFrom: sample,
    sampleDirectory: '/root/mx/workspace/de-llaaddddeerr/electron-dock/mx-insight-hub',
    apiKey: process.env.MX_HUB_PROBE_API_KEY, apply: true
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.httpStatus === 200 && result.requestId) {
    console.log(JSON.stringify(inspect([
      '--request-id', result.requestId, '--twitter-post-id', sample.postId
    ]), null, 2));
  }
} catch (error) {
  const safe = ['invalid_sample', 'conversation_sample_not_allowed', 'api_key_required', 'invalid_api_key'];
  console.error(JSON.stringify({ error: safe.includes(error.message) ? error.message : 'sample_or_inspection_failed' }));
  process.exitCode = 1;
}
NODE
BASH
```

读取旧归档和事后字段检查均无 HTTP；中间最多新增 1 个 Hub POST。准备阶段要求唯一的成功计费调用、committed usage、完整 SHA 归档、原帖 ID 精确匹配、thread 空且 replies 为 0，以及不同的字符串会话 ID；否则拒绝。目标 ID 仅在内存传递，不打印。该额外采样必须引用原目录匹配的 usage_header 成功回执，新增固定的 `twitter.conversation.json`，并保留两份旧记录。新目标使用新的幂等键；重复、并发、换目标和未知结果都不能再次使用该槽位。没有自动鉴权恢复、换供应商或续页。

若 `conversation_sample_not_allowed`，先核对原目录及保存的成功回执，不删除或重建标记；若已经打印成功 probe 而后续检查失败，保留该 probe 的 requestId，只重做只读检查。也支持将准备结果重定向到私有文件后，用 `--sample-dir <原目录> --twitter-conversation-sample <文件>` 零请求预览，明确追加 `--apply` 才采样。

本地检查器 14 项、采样器 19 项测试通过。未向供应商发实际请求，未部署或修改统一路由、MX-H2I 登录及联网配置。

若旧命令出现 `read: -p: no coprocess`，是 zsh 将 `read -p` 解释为读取协进程，尚未运行后面的 Node（按原完整块执行时，`set -e` 在此退出）。使用上面的显式 Bash 包装；`</dev/tty` 保证密钥从终端读取，不会误把 heredoc 中的脚本行当作密钥。此修正不重置任何采样标记或次数。

### conversation_sample_not_allowed：定位原成功回执目录

用户随后回传此错误。已核对之前贴出的成功回执，其字段全部符合门禁；服务器上实际读到哪个文件仍待确认。该错误发生在本次 fetch 和新 `twitter.conversation.json` 标记创建之前，本次没有发起付费请求；当前代码可能已创建指定目录下的空标记目录。不要因此复制、重建或删除回执。

优先检查示例中固定的 `outputs/hub_comment_samples_20261102/minimal-contentId` 是否就是当时的实际采样目录。以下命令不需要 Key，只检查当前目录及该日期采样目录下至多四层、100 个目录；不遍历其他项目、不输出回执原始内容、不发 HTTP。输出 `readyForOneSample=true` 的原目录才满足本轮本地回执前提；仍须原有服务器归档校验及独占标记门禁。若找不到，说明这些查找范围内尚未定位到原成功记录，不证明记录不存在。

```bash
node --input-type=module <<'NODE'
import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const configured = resolve('outputs/hub_comment_samples_20261102/minimal-contentId');
const root = resolve('outputs/hub_comment_samples_20261102');
const dirs = new Set([process.cwd(), configured]);
const queue = [{ dir: root, depth: 0 }];
let visited = 0, truncated = false;
while (queue.length && visited++ < 100) {
  const { dir, depth } = queue.shift();
  dirs.add(dir);
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }
  if (entries.length > 500) truncated = true;
  for (const entry of entries.slice(0, 500)) {
    if (!entry.isDirectory() || entry.name === '.hub-comment-contract-probes-v1') continue;
    if (depth < 4) queue.push({ dir: join(dir, entry.name), depth: depth + 1 });
    else truncated = true;
  }
}
truncated ||= queue.length > 0;
async function read(dir, name) {
  try {
    const file = join(dir, '.hub-comment-contract-probes-v1', name);
    if ((await stat(file)).size > 16384) return { state: 'too_large' };
    const bytes = await readFile(file);
    if (bytes.length > 16384) return { state: 'too_large' };
    const value = JSON.parse(bytes.toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? { state: 'read', value } : { state: 'invalid_json_object' };
  } catch (error) {
    return { state: error.code === 'ENOENT' ? 'missing' : error instanceof SyntaxError ? 'invalid_json' : 'unreadable' };
  }
}
const expected = {
  revision: 'post-comment-contract-probe.v2', provider: 'tikhub', platform: 'twitter',
  path: '/api/v1/data/native/t.api_3cd88a6621a01120', state: 'http_response', httpStatus: 200,
  requestId: 'f33e6d06-97f0-46c2-a049-c69ccfabf41d', requestIdSource: 'usage_header', hubRequestsMade: 1
};
const candidates = [];
for (const dir of dirs) {
  const original = await read(dir, 'twitter.json');
  const auth = await read(dir, 'twitter.auth-retry.json');
  const extra = await read(dir, 'twitter.conversation.json');
  if (dir !== configured && [original, auth, extra].every(row => row.state === 'missing')) continue;
  const selected = auth.state === 'missing' ? original : auth;
  const value = selected.value || {};
  const failedChecks = selected.state === 'read'
    ? Object.entries(expected).filter(([key, expectedValue]) => value[key] !== expectedValue).map(([key]) => key)
    : ['source_' + selected.state];
  if (selected.state === 'read') {
    if (value.errorCode != null) failedChecks.push('errorCode');
    if (value.samplePurpose != null) failedChecks.push('samplePurpose');
    if (!/^comment-calibration-v1-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value.idempotencyKey || '')) failedChecks.push('idempotencyKey');
  }
  candidates.push({ sampleDirectory: dir, configured: dir === configured,
    original: original.state, authRetry: auth.state, conversation: extra.state,
    selectedReceipt: auth.state === 'missing' ? 'twitter.json' : 'twitter.auth-retry.json',
    failedChecks, readyForOneSample: failedChecks.length === 0 && extra.state === 'missing' });
}
console.log(JSON.stringify({ cwd: process.cwd(), candidates, truncated, httpRequestsMade: 0 }, null, 2));
NODE
```

若唯一匹配目录的 readyForOneSample 为 true，下一次只把采样命令的 sampleDirectory 改成该原目录，其他身份与次数限制不变。若 conversation 不是 missing，先读已有额外采样回执，不能删除后重跑。若无匹配或输出截断，先贴回诊断结果，不能换目录补建标记。

已收到定位结果：cwd 与正确 sampleDirectory 均为 `/root/mx/workspace/de-llaaddddeerr/electron-dock/mx-insight-hub`，原始/auth-retry 都可读，选中的 auth-retry failedChecks=[]、readyForOneSample=true、conversation=missing。此前示例 outputs/minimal-contentId 两份源回执都缺失，故被门禁拒绝；这次定位 httpRequestsMade=0。上面的执行命令已改用确认的绝对路径，保留所有身份与单次限制。下一步仅执行原已安排的一次所属会话采样，尚未得到其新付费回执。

### 所属会话样本已返回：完整解析已有 36 条，不再采购

用户回传新 usage `7e7cd2d0-aa97-4aa5-a113-5a92f8b3143b`，幂等键 `comment-calibration-v1-f295c520-f0eb-4eaa-ac11-c4ccdd3358fd`，samplePurpose=conversation_comments，HTTP/businessCode=200，usage=committed、billed=true。54697 字节原始归档完整，data.id/conversation_id 均与请求一致，thread 长度 36；抽看的前 3 条包含独立 id、同会话 ID、正文、作者、时间和互动量。cursor 非空。原始/auth-retry/conversation 三个标记全部保留；本轮采样已完成，不再执行上面的付费采样命令。

Twitter 统一路由的本地实现已改为 TikHub `t.api_3cd88a6621a01120`，以 thread 为评论来源、保留未知直接父级，并按一份供应商页停止自动补页；36 条按 count=20 测试可先交付 20 条，再从已购余量返回 16 条。旧 JustOne 回执和入库任务保持原供应商身份，新采集拒绝旧签名游标。此处仍不是线上统一接口验收。

结构摘要仅取了 3 条，发布前应让**运行时使用的同一个纯解析器**逐条验证完整归档。同步以下两个文件即可，无需发布镜像或输入 Key：

- `server/contracts/twitter-comment-page.mjs`（新增；无依赖的运行时解析器）
- `server/ops/inspect-post-comment-contract.mjs`（新增完整解析验证模式）

```bash
bash <<'BASH'
set -euo pipefail
cd /root/mx/workspace/de-llaaddddeerr/electron-dock/mx-insight-hub
cat server/contracts/twitter-comment-page.mjs \
    server/ops/inspect-post-comment-contract.mjs |
  kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
    node --input-type=module - \
    --request-id 7e7cd2d0-aa97-4aa5-a113-5a92f8b3143b \
    --verify-twitter-projection
BASH
```

两个文件通过 stdin 拼接执行，避免容器旧代码或缺少相对路径依赖影响验证；运行时直接 import 的也是该纯解析器。输出版本 `twitter-comment-projection-verification.v1`，只含 inputThreadCount、projectedCount、distinctCommentCount、字段完整数和分页状态等，不返回正文、作者信息、ID 或游标值。核验原始长度/SHA 后才解析，所有 thread 条目都验证；第 36 条若不符合合同也会拒绝。targetSource=saved_response_root，使用该归档根 ID；其与请求 ID 的关系已经由先前检查证明，不把此模式说成独立重验了原始请求参数。

verified=true 表示这些保存条目通过当前纯解析器；不产生 HTTP、数据库写入、入库或费用。canonical 入库、计费、别名和分页由本地集成回归验证，本命令不调用这些写路径。缺少或损坏归档、源调用状态不符合、解析拒绝会显式失败，不能以重采替代检查。

本地 121 项相关测试与类型检查通过；共享社媒/YouTube 分页回归 53 通过、1 跳过。包含真实 HTTP 别名路由（本地模拟供应商）、36 条余量交付、未知分页、历史游标回放、旧入库任务、归档末行拒绝及 stdin 独立执行检查。尚未收到服务器完整解析验证结果，尚未发布 Hub。

### 全部 36 条服务器校验已通过：发布 Hub

用户回传 `twitter-comment-projection-verification.v1`：verified=true、archive/hashVerified=true、54697 字节；inputThreadCount/projectedCount/distinctCommentCount 均为 36，rootIncluded=false，textCount/authorIdCount/publishedAtCount 均为 36。unknownParentCount=36 如实保留，hasMore=null、continuationAvailable=true。supplierHttpCallsMade=0、databaseWritesMade=0。此次验证已完成，不再重复或重新采购样本；尚未收到 Hub 发布或统一接口验收结果。

先把本轮 Hub 完整代码同步到服务器，包括合同、投影、工作流、入库 worker、OpenAPI/文档及新增纯解析器，不能仅同步两个校验文件。使用标准发布：

```bash
bash <<'BASH'
set -e
cd /root/mx/workspace/de-llaaddddeerr/electron-dock/mx-insight-hub

MX_INSIGHT_SYNC_LAUNCHER=0 MX_SMOKE_DATA=0 bash scripts/manage.sh deploy

kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-public -c api -- \
  node --input-type=module - <<'NODE'
import { POST_COMMENTS_RECIPES } from '/app/server/contracts/post-comments.mjs';
import { normalizePostCommentsDelivery } from '/app/server/external-platforms/post-comments-workflow.mjs';
const route = POST_COMMENTS_RECIPES.twitter;
const request = normalizePostCommentsDelivery(
  { platform: 'twitter', postId: '2117082385997250767', count: 20 },
  { context: { consumer: { businessId: 'runtime-contract-check' } }, maxPageSize: 100, codec: {} }
);
if (route?.provider !== 'tikhub' || route.key !== 't.api_3cd88a6621a01120'
    || route.path !== '/api/v1/twitter/web/fetch_post_comments' || route.idField !== 'tweet_id'
    || route.available !== true || request.manualProviderPagination !== true) throw new Error('twitter_comments_route_not_updated');
console.log(JSON.stringify({
  state: 'twitter_comments_runtime_updated',
  provider: route.provider, nativeKey: route.key, upstreamPath: route.path,
  manualProviderPagination: request.manualProviderPagination,
  supplierHttpCallsMade: 0
}, null, 2));
NODE
BASH
```

manage.sh 会构建导入镜像、执行既有迁移/索引维护、等待 Hub Public/Admin 和 worker rollout，并运行基础 smoke；不额外重复 rollout 等待。Public 容器名为 api，Admin 为 admin。最后只读导入运行容器内的静态合同，不初始化 Hub runtime、不发供应商请求，只证明新固定路由代码已在容器内，不能替代统一接口真实验收。

部署成功后再核对下游 Key 的 twitter 平台与 social.comments.list 授权、现有 TikHub 采购控制。随后安排统一入口的业务验收；新验收使用自己的新幂等键，原历史 404/旧样本不改写、不换键自动重试。其余九个 JustOne 平台的余额阻塞仍未解决。

### 运行路由已更新：单次统一入口验收

用户已回传 `twitter_comments_runtime_updated`、provider=tikhub、nativeKey=t.api_3cd88a6621a01120、manualProviderPagination=true、supplierHttpCallsMade=0。这证明容器代码已更新，尚未证明统一入口业务成功。本轮只需同步新增 `server/ops/verify-twitter-comments-runtime.mjs` 及其已有依赖 `probe-post-comment-contract.mjs`、`inspect-post-comment-contract.mjs` 到宿主机，无需重建或重启服务。

使用前次原生请求成功的同一 Hub Live Key。免费 GET capabilities 检查 twitter 平台、social.comments.list 授权及本轮已有原生权限的 native.t.api_3cd88a6621a01120.ready；不以 social.comments.list.ready 判断 Twitter，该字段仍关联小红书旧操作。业务 Key 本身无需新增原生权限；这里是利用原校准 Key 预检 TikHub 配置。capabilities 不保证余额、预算、实时限流全部可用。

脚本在确认的原目录检查原始/auth-retry/conversation 成功回执链；从旧归档私下重新取得同一会话帖子 ID。预检通过才独占创建 `.hub-comment-contract-probes-v1/twitter.unified-acceptance.json`，持久化新幂等键、源 usage 与请求摘要，再向旧 URL 发送一次 `{platform:'twitter',contentId:会话帖子ID,count:20,includeRaw:false}`。这是统一入口的一次新业务验收，可能正常计费，不是再次执行原生样本探测。不自动补页或重试，已有标记时不再发送；任何异常都不能删标记或换目录重买。

下面命令只打印结构检查和供应商账本摘要；目标 ID、正文、作者值及游标不打印、不存到本地标记。成功后只读核验同一 usage 的 TikHub 调用与已保存归档，不产生额外供应商请求。

```bash
bash <<'BASH'
set -e
cd /root/mx/workspace/de-llaaddddeerr/electron-dock/mx-insight-hub
read -r -s -p 'Hub Live API Key: ' MX_HUB_PROBE_API_KEY </dev/tty
printf '\n'
export MX_HUB_PROBE_API_KEY
node --input-type=module <<'NODE'
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { runTwitterCommentsRuntimeVerification } from './server/ops/verify-twitter-comments-runtime.mjs';
const script = readFileSync('server/ops/inspect-post-comment-contract.mjs', 'utf8');
function inspect(args) {
  return JSON.parse(execFileSync('kubectl', [
    '-n', 'mx-insight-hub', 'exec', '-i', 'deployment/mx-insight-hub-admin', '-c', 'admin', '--',
    'node', '--input-type=module', '-', ...args
  ], { input: script, encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024 }));
}
try {
  const conversationSample = inspect([
    '--request-id', 'f33e6d06-97f0-46c2-a049-c69ccfabf41d',
    '--twitter-post-id', '2117082385997250767', '--prepare-twitter-conversation'
  ]);
  const result = await runTwitterCommentsRuntimeVerification({
    conversationSample, sourceRequestId: '7e7cd2d0-aa97-4aa5-a113-5a92f8b3143b',
    sampleDirectory: process.cwd(), apiKey: process.env.MX_HUB_PROBE_API_KEY, apply: true
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.httpStatus === 200 && result.requestId) {
    const saved = inspect(['--request-id', result.requestId]);
    const calls = saved.calls.map(c => ({
      provider: c.provider, platform: c.platform, endpoint: c.endpoint,
      outcome: c.outcome, httpStatus: c.httpStatus, billed: c.billed,
      archiveVerified: c.archive.state === 'archive_verified' && c.archive.hashVerified === true
    }));
    const verified = saved.usage.status === 'committed' && saved.usage.httpStatus === 200
      && !saved.callsTruncated && calls.length === 1 && calls.every(c =>
        c.provider === 'tikhub' && c.platform === 'twitter'
        && c.endpoint === 'native.t.api_3cd88a6621a01120' && c.outcome === 'succeeded'
        && c.httpStatus === 200 && c.billed === true && c.archiveVerified);
    console.log(JSON.stringify({ revision: 'twitter-unified-provider-evidence.v1',
      requestId: result.requestId, verified, usage: saved.usage, calls,
      supplierHttpCallsMade: 0, databaseWritesMade: 0 }, null, 2));
    if (!verified) process.exitCode = 1;
  }
  if (result.verified !== true) process.exitCode = 1;
} catch (error) {
  const safe = ['invalid_arguments', 'invalid_sample', 'source_receipt_unverified', 'api_key_required', 'invalid_api_key'];
  console.error(JSON.stringify({ error: safe.includes(error.message) ? error.message : 'twitter_unified_acceptance_or_inspection_failed',
    action: 'inspect_existing_receipt_before_any_retry' }));
  process.exitCode = 1;
}
NODE
BASH
```

预检失败会返回缺少的授权/就绪布尔状态，本次业务 POST 为 0。不要为预检便利而给业务 Key 自动增加原生授权。成功应同时看到响应 `verified=true` 和供应商证据 `verified=true`；允许实时评论数变化，不要求精确 20 或 36 条，不把未知分页当作结束。空页可为 contractValid=true、commentsObserved=false、verified=false，不把未观察到评论字段当成完整验收。供应商证据严格要求一条调用；如果既有 LCY 机制做了明确未计费的重试而产生多条记录，需人工核对，不直接判成业务失败。HTTP 200 但结构未通过、空页、超时、来源检查失败均保留现场，先查看回执再决定下一步。此脚本不修改授权、价格、开关、历史回执或 MX-H2I 配置。

本地新增 11 项模拟验证及既有 probe/inspector 共 49 项测试通过，包括同一个运行时投影生成的响应、未知分页、空页证据边界、重复/并发防重、未授权零 POST、响应限长和脱敏。测试没有真实供应商请求；随后用户执行的生产业务验收结果见下一节。


### Twitter 统一入口首屏验收已通过

用户回传 usage `d167ad9e-48b4-4668-bcd3-8b1d6ef2aeb0`，验收幂等键 `twitter-comments-acceptance-v1-039b7bf5-3115-48bd-9a13-a84bcba53d7f`，bodySha256 `12f977e4bfd098049d1018cdec50333021c5ac9e9f55a3f9099382e8b3ae8387`。`/api/v1/search/post-comments` HTTP 200，verified/contractValid/commentsObserved 均为 true；contract/items/identities/fields/acquisition/pagination 检查全部通过，returnedCount=20。免费预检的 twitterGranted/commentsGranted/twitterNativeReady 均为 true，业务 POST 恰好一次。

同一 usage 的只读证据 verified=true、status=committed、HTTP 200；恰好一条 provider=tikhub、platform=twitter、endpoint=native.t.api_3cd88a6621a01120、outcome=succeeded、billed=true 的供应商调用，archiveVerified=true。第二份摘要的 supplierHttpCallsMade=0、databaseWritesMade=0 只指账本检查本身；前面的业务采集已正常计费一次。

pagination 为 hasMore=true、continuationAvailable=true、paginationStatus=continuable。结合已部署的单供应商页工作流，这表示已有已购缓存余量；本次新归档总条数未输出，不能照搬此前原生样本的 36 条，也不能推断下一供应商页必有数据。此次线上范围是首屏，后续交付/续页/回放仍依据已有本地回归，没有额外线上请求。

Twitter 首屏修复至此闭环，下游继续使用原 URL，带 twitter + social.comments.list 授权；正常新采集使用独立幂等键，同一请求重试保持原键与请求体，旧 404 回执不改写。保留 twitter.unified-acceptance.json 及原有三个原生采样标记，不再执行上述 Twitter 探测或验收命令。剩余九个 JustOne 平台未因此恢复；下一步先取得 Reddit、快手真实样本路径或帖子标识，再预览、免费预检和限定首屏采样。

### Reddit、快手：先从服务器查找真实目标

用户已授权继续：可从服务器已有记录查找，找不到时可新采集一个目标。当前没有可用的 Internal SSH 配置，本机 kubectl 指向 Docker Desktop；不要把本机集群查询误当作服务器结果。沿用操作员在服务器执行命令的方式。

同步新增 `server/ops/find-post-comment-samples.mjs` 即可，无需部署、Key 或供应商请求：

```bash
bash <<'BASH'
set -e
cd /root/mx/workspace/de-llaaddddeerr/electron-dock/mx-insight-hub
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
  node --input-type=module - < server/ops/find-post-comment-samples.mjs
BASH
```

默认输出版本 post-comment-sample-discovery.v1，每个平台只报告 found / not_found_in_bounded_scan / discovery_incomplete、来源类型与 Hub 源记录 UUID，以及各阶段查询状态。不会输出平台帖子 ID、URL、正文、作者或凭据。supplierHttpCallsMade=0、databaseWritesMade=0。

查找顺序：

1. 旧故障 af456ad4-2523-4f73-a1fc-c95104b329a4 时间前后各一小时，最多取 5000 条 usage ID；再查最近 5000 条。先通过 created_at 索引取得有界切片，之后筛选两个平台和三个已知评论路径，最多各 50 条匹配请求。仅接受明确首屏，保留字段冲突/不安全数字拒绝；params={} 可以使用。
2. 没找到的平台，查询 night-all.search.v1 / night-all.compat.v1 下 object_type=post、未删除的规范记录，按现有 dataset+platform+event_time 索引各取至多 50 条，在内存优先选已保存评论数大于零的候选。评论数可能过时，不保证实时非空。
3. Reddit 优先使用规范 external_id（剥离 t3_）；其 URL 可能指向站外文章。快手仅从已保存的 kuaishou.com 作品 URL 解析 photoId，不能把内部 numeric cid 当作 TikHub photo_id，也不拼接冲突的 ID 与 URL。

整个事务 READ ONLY，单查询 4 秒、锁等待 1 秒；某一来源超时/缺表时回滚到 savepoint，继续独立来源并标注 incomplete。没有结果只说明有界范围内未找到，不能据此声称全库不存在。没有 DDL、写入或回执变更。

found 后使用 `--prepare reddit` 或 `--prepare kuaishou` 在后续包装脚本内私下取得最小样本；此模式会含帖子 ID，不直接贴到聊天。样本只决定固定评论端点的帖子参数，不采纳保存请求中的 URL 目的地、headers、count、cursor、params 或业务标签。采购标记始终使用已确认 Hub 根目录，先免费检查目标 native capability/readiness，再每个平台至多一页；旧 Twitter 全部记录继续保留。

若查不到合适目标，按既有授权准备新目标采集：优先已实现投影的 Reddit 帖子检索（按评论排序）与快手综合搜索，最多各一页，再从返回的真实原帖标识校准评论，不自动续页。候选检索仍经过现有凭据、授权、预算及防重复控制，不把检索附带评论作为单帖评论能力。此处尚未执行服务器查找或任何新付费请求，也未切换 Reddit/快手统一路由。
