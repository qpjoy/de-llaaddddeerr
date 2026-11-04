# 单帖评论：限定次数的服务器字段校验

日期：2026-11-02。Twitter、Reddit、快手原生校准与旧 URL 生产首屏验收均已完成，见本文各阶段及末尾结果；保留所有标记，不再执行下方这三个平台的历史探测/验收命令。用户已确认 JustOne 余额为零，剩余七个平台仍须逐项核对替代能力，不执行旧 JustOne 版本命令，也不换目录绕过现有三平台采样边界。原生 HTTP 成功、官方例子或搜索附带评论不能替代统一入口验收。

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

历史阶段说明：本节编写时 Twitter 已完成统一首屏验收，Reddit、快手仍是 JustOne，等待上表 TikHub 端点样本校准。当前三个平台均已完成迁移与首屏验收，以下原生采样命令不再执行。不能直接用 JustOne 的字段解析器处理 TikHub 响应；先核对正文、作者、时间及分页，再修改对应统一路由。采样无需部署服务，需确认 TikHub 现有凭据、目标原生操作的审核价格和启用状态；不修改余额或扩大预算。若拒绝，贴回结果，不自动换渠道补买。

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

样本核对本身不部署 Hub、不修改历史失败响应、不操作 MX-H2I 登录或联网配置。Reddit、快手已完成原生校准、字段/分页实现与回归、发布和统一入口首屏验收；旧失败请求的不可变回放保持原结果。Twitter 同样已完成，本节三个平台均不重复执行。


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

### Reddit、快手目标已找到：固定来源后各采一页评论

用户回传 discovery.v1：Reddit 来自 usage `ee8dd99d-9146-4cb9-9ddc-eeeca3174c49`；快手来自 canonical `120ec88d-84f3-4369-b5d9-92b877f75bd7`。原故障窗口匹配 3 条，快手 night-all.search.v1 查询超时，但 night-all.compat.v1 的有界 50 条记录中找到了有效原帖。此次 HTTP/数据库写入均为 0；不需要额外搜索或新采帖子，也不重复超时扫描。

finder 新增精确模式：`--prepare <platform> --source-kind <usage|canonical> --source-id <UUID>`，只按主键读取这一个来源，并再次验证平台、评论路径/首屏身份，或原帖 dataset/object_type/deleted_at 与公开作品 URL。记录缺失、变成无效来源或查询失败都拒绝，不替换帖子、不回落到扫描。20 项 discovery 测试通过。

先同步本次更新的 `server/ops/find-post-comment-samples.mjs`；保留已有 probe v2、inspector v2 与全部标记，无需部署。以下命令先私下准备两份固定样本，再做一个免费 capabilities GET；两项原生授权与 ready 全通过才继续。随后 Reddit、快手依次各最多一页，合计最多 2 个新的 Hub 业务 POST；单次可能正常计费。每次成功后只读检查同一归档，任一已有标记、失败/未知、缺少持久 usage、归档异常就停止，不自动换目标、重试、鉴权恢复或续页。操作不会修改统一路由；两个平台的统一入口仍待实际字段映射。

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
import { planPostCommentProbe, runPostCommentProbe } from './server/ops/probe-post-comment-contract.mjs';
function admin(file, args) {
  return JSON.parse(execFileSync('kubectl', [
    '-n', 'mx-insight-hub', 'exec', '-i', 'deployment/mx-insight-hub-admin', '-c', 'admin', '--',
    'node', '--input-type=module', '-', ...args
  ], { input: readFileSync(file, 'utf8'), encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024 }));
}
async function boundedJson(response) {
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 2 * 1024 * 1024) throw new Error('preflight_response_too_large');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
try {
  const apiKey = process.env.MX_HUB_PROBE_API_KEY;
  if (!/^mih_live_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/.test(apiKey || '')) throw new Error('invalid_api_key');
  const sources = [
    ['reddit', 'usage', 'ee8dd99d-9146-4cb9-9ddc-eeeca3174c49'],
    ['kuaishou', 'canonical', '120ec88d-84f3-4369-b5d9-92b877f75bd7']
  ];
  const plans = sources.map(([platform, sourceKind, sourceId]) => {
    const sample = admin('server/ops/find-post-comment-samples.mjs', [
      '--prepare', platform, '--source-kind', sourceKind, '--source-id', sourceId
    ]);
    if (sample.revision !== 'post-comment-target-sample.v1' || sample.platform !== platform
        || sample.sourceKind !== sourceKind || sample.sourceId !== sourceId) throw new Error('source_mismatch');
    return { platform, sourceKind, sourceId, plan: planPostCommentProbe(platform, sample) };
  });
  const response = await fetch('http://127.0.0.1:18150/api/v1/data/capabilities', {
    headers: { authorization: 'Bearer ' + apiKey }, redirect: 'error', signal: AbortSignal.timeout(15000)
  });
  const capabilities = (await boundedJson(response))?.data?.capabilities;
  const checks = plans.map(({ platform, plan }) => {
    const capability = 'native.' + plan.path.split('/').at(-1);
    const row = Array.isArray(capabilities) ? capabilities.find(c => c.capability === capability) : null;
    return { platform, capability, granted: Boolean(row), ready: row?.ready === true };
  });
  console.log(JSON.stringify({ revision: 'comment-native-preflight.v1', httpStatus: response.status,
    checks, hubRequestLimit: 2, hubRequestsMade: 0 }, null, 2));
  if (response.status !== 200 || checks.some(c => !c.granted || !c.ready)) throw new Error('preflight_not_ready');
  for (const { platform, sourceKind, sourceId, plan } of plans) {
    const result = await runPostCommentProbe({ plan, sampleDirectory: process.cwd(), apiKey, apply: true });
    console.log(JSON.stringify({ ...result, sourceKind, sourceId }, null, 2));
    if (result.state !== 'http_response' || result.httpStatus !== 200
        || !result.requestId || result.requestIdSource !== 'usage_header') throw new Error('probe_stopped');
    const saved = admin('server/ops/inspect-post-comment-contract.mjs', ['--request-id', result.requestId]);
    console.log(JSON.stringify(saved, null, 2));
    const call = saved.calls?.[0];
    if (saved.usage?.status !== 'committed' || saved.usage.httpStatus !== 200 || saved.callsTruncated
        || saved.calls?.length !== 1 || call.provider !== 'tikhub' || call.platform !== platform
        || call.endpoint !== 'native.' + plan.path.split('/').at(-1)
        || call.outcome !== 'succeeded' || call.httpStatus !== 200 || call.billed !== true
        || call.archive?.state !== 'archive_verified' || call.archive.hashVerified !== true) throw new Error('inspection_stopped');
  }
} catch (error) {
  const safe = ['invalid_api_key', 'source_mismatch', 'preflight_not_ready', 'preflight_response_too_large',
    'probe_stopped', 'inspection_stopped', 'invalid_sample'];
  console.error(JSON.stringify({ error: safe.includes(error.message) ? error.message : 'comment_calibration_stopped',
    action: 'preserve_markers_and_report_output' }));
  process.exitCode = 1;
}
NODE
BASH
```

capabilities 只核对目标 native 条目（原生 social 平台授权已参与该条目 ready 的计算），不要求过滤后的 platforms 列表显示 social。未就绪时两个业务 POST 均为 0，标记不新增。独占标记仍是原 Hub 根目录中的 reddit.json/kuaishou.json；重复执行不会重买已尝试平台。检查恰好一条成功计费调用是严格校准门槛，若既有 LCY 明确未计费重试留下额外调用则停止人工核对，不直接断言业务失败。

首次运行产生的预检、probe 和 inspection JSON 全部贴回。即使某条评论列表为空，也先读取已保存结构，不自动换帖补买。剩余工作是据真实归档实现对应投影、分页和统一入口回归；本轮尚无 Reddit/快手付费回执，不能视为已迁移。

### Reddit 已取得评论，快手被拒绝：只读核验现有回执

用户回传两平台免费预检 granted/ready=true。Reddit 原生请求 usage `7eb265f4-5c2c-4d15-91d5-7dc7fed83b61`、幂等键 `comment-calibration-v1-34a1dc86-2fc6-4de7-9818-56c987cd3c8b`，HTTP/businessCode=200、committed、billed=true，TikHub endpoint native.t.api_c7f50cf300d63960。9844 字节归档已通过长度/SHA 校验。data.postInfoById.commentForest.trees 长度为 3，均有 node.id/content.markdown/authorInfo/createdAt/score，parentId=null，pageInfo.hasNextPage=false，more=null。结构摘要不披露 ID、时间、类型枚举等值，仍需逐条解析并与保存的请求目标核对。

快手 usage `ce942beb-a379-4e18-b62f-ee69cc24b3d3`、幂等键 `comment-calibration-v1-0513a892-81fb-47b7-9cc2-363d45db9e6d`，Hub HTTP 502/external_platform_rejected。包装脚本正确停止，未执行后面的快手归档检查。此结果不能确定供应商具体错误或是否计费；保留 kuaishou.json，不自动重试、改参数、换帖或换渠道。Reddit 的 reddit.json 和所有 Twitter 标记也保留。

新增无依赖候选解析器 reddit-comment-page.mjs：验证根帖和全部树、保留 Markdown/作者/时间/原始树、score 不映射成 likes；未知父级不推定为直接回复。未取得下一页 token 的实际响应位置，因此不把 more.cursor 或请求 echo.after 猜成帖子分页；仅在 hasNextPage=false 且没有更多占位/未返回子评论证据时标记终止。该解析器尚未接到运行路由，Reddit 统一入口仍是 JustOne。先用原生请求保存的 body.params.post_id 校验这份归档；缺失快照时拒绝，不以响应自己的根 ID 代替请求校验。

快手诊断脚本补上固定 native 端点白名单和经过身份/归档检查的 photo_id、pcursor 类型/长度摘要。原生账本作用域 social 会如实保留，供应商平台由具体端点确认。错误文案只输出既有白名单分类，供应商“不收费”声明不能覆盖 billed 账本。

同步以下三个文件即可，无需发布镜像、Key 或再次采购：

- server/contracts/reddit-comment-page.mjs（新增候选解析器）
- server/ops/inspect-post-comment-contract.mjs（增加 --verify-reddit-projection）
- server/ops/diagnose-tikhub-rejection.mjs（增加快手端点诊断）

```bash
bash <<'BASH'
set -euo pipefail
cd /root/mx/workspace/de-llaaddddeerr/electron-dock/mx-insight-hub
MX_COMMENT_READ_FAILED=0

cat server/contracts/reddit-comment-page.mjs \
    server/ops/inspect-post-comment-contract.mjs |
  kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
    node --input-type=module - \
    --request-id 7eb265f4-5c2c-4d15-91d5-7dc7fed83b61 \
    --verify-reddit-projection || MX_COMMENT_READ_FAILED=1

kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
  node --input-type=module - \
  --request-id ce942beb-a379-4e18-b62f-ee69cc24b3d3 \
  < server/ops/inspect-post-comment-contract.mjs || MX_COMMENT_READ_FAILED=1

kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
  node --input-type=module - ce942beb-a379-4e18-b62f-ee69cc24b3d3 \
  < server/ops/diagnose-tikhub-rejection.mjs || MX_COMMENT_READ_FAILED=1

exit "$MX_COMMENT_READ_FAILED"
BASH
```

三项均为独立只读事务，某一检查未通过也继续读取其余证据，最后以非零状态表示有未通过项。首份预期版本 reddit-comment-projection-verification.v1、targetSource=saved_request_snapshot、requestedPostMatched=true、verified=true，并输出全部条目的数量；若解析拒绝，仅输出固定 reason。快手后两份分别用于确认 usage/供应商计费与原始结构，以及具体上游 HTTP/business code/错误分类。不发 HTTP、不重放、不写 canonical、不改变账单。

候选解析器、归档校验和拒绝诊断共 52 项测试通过；Twitter 既有校验回归包含在内。当前只准备以上只读核验，尚未获得服务器输出，未部署或切换任何平台。待 Reddit 完整校验通过后，接入其 TikHub recipe、投影、受控分页、旧 JustOne 回执/游标和入库兼容；不能把原生采样成功说成统一入口已迁移。

### Reddit 运行接入与快手 App 单次采样

本轮回传已确认：

- Reddit `7eb265f4-5c2c-4d15-91d5-7dc7fed83b61` 的 9844 字节归档通过完整纯解析；请求目标一致，3 个唯一评论，正文/作者 ID/时间各 3 条，score 2 条；根帖已排除、3 条父关系未知、当前样本明确结束。无需再购原生 Reddit 样本。
- 快手 Web `ce942beb-a379-4e18-b62f-ee69cc24b3d3` 保存为 committed/Hub 502；唯一 TikHub 调用为 HTTP/business 400、`upstream_request_rejected`、`billed:null`。835 字节错误归档校验通过。原 `photo_id` 为 15 位字符串，首屏未传 `pcursor`。供应商“未扣费”文案不能替代账本证据，不释放/重置原 usage。
- 快手 Web 上游 request UUID：`c5eb3eb1-b044-43ff-b2d3-8fc8892fb7b5`。保留原 `kuaishou.json`、幂等键及错误回执。

Reddit 统一路由本地已改为 TikHub `t.api_c7f50cf300d63960`，固定 `post_id`、`need_format=false`，沿用现有 `social.comments.v1` 与 PG 原始响应/规范记录/分页存储，不需要新表。完整正文、作者、时间和 signed score 入库；隐藏 score 为 null、likes 仍未知。每次最多一个供应商页；有余量先交付，未证实 next token 时返回 unknown，不把回复游标猜为 `after`。旧 Reddit 签名游标及 body.cursor/params.cursor 保持原请求指纹，仅原幂等键回放；不能跨供应商续采。旧已排队 JustOne 入库任务保持原归属。

先同步本轮完整 Hub 改动到服务器（合同、解析器、投影、工作流、index 路由、worker、文档与 ops），然后执行以下命令。它只发布 Hub；基础 smoke 不发真实数据采集，Launcher 同步/重启关闭。标准发布仍运行既有迁移/索引维护；本轮没有新增 DDL。

```bash
bash <<'BASH'
set -e
cd /root/mx/workspace/de-llaaddddeerr/electron-dock/mx-insight-hub
MX_INSIGHT_SYNC_LAUNCHER=0 MX_SMOKE_DATA=0 bash scripts/manage.sh deploy
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-public -c api -- \
  node --input-type=module - <<'NODE'
import assert from 'node:assert/strict';
import { POST_COMMENTS_RECIPES, buildPostCommentsDispatch } from '/app/server/contracts/post-comments.mjs';
import { normalizePostCommentsDelivery } from '/app/server/external-platforms/post-comments-workflow.mjs';
const recipe = POST_COMMENTS_RECIPES.reddit;
const request = normalizePostCommentsDelivery({ platform: 'reddit', contentId: 't3_abc123', count: 20 },
  { context: { consumer: { businessId: 'runtime-contract-check' } }, maxPageSize: 100, codec: {} });
const dispatch = buildPostCommentsDispatch(request);
assert.equal(recipe.provider, 'tikhub');
assert.equal(recipe.key, 't.api_c7f50cf300d63960');
assert.equal(dispatch.endpointPath, '/api/v1/reddit/app/fetch_post_comments');
assert.equal(dispatch.upstreamQuery.post_id, 't3_abc123');
assert.equal(dispatch.upstreamQuery.need_format, false);
assert.equal(request.manualProviderPagination, true);
assert.equal(POST_COMMENTS_RECIPES.twitter.key, 't.api_3cd88a6621a01120');
console.log(JSON.stringify({ state: 'reddit_comments_runtime_updated', provider: recipe.provider,
  nativeKey: recipe.key, manualProviderPagination: request.manualProviderPagination,
  supplierHttpCallsMade: 0 }, null, 2));
NODE
BASH
```

运行检查使用合成 ID，只导入容器代码，不连接供应商或数据库，不验证真实业务调用。回传 `reddit_comments_runtime_updated` 后，再安排旧统一 URL 的至多一次业务验收；不能把原生样本成功写成统一入口已验收。Twitter 已完成，保持原验收回执，不重复采购。

快手有独立的 [TikHub App 评论端点](https://docs.tikhub.io/467698474e0)，官方支持数字 ID 与短字符串 eID。首屏 `pcursor` 可省略，见 [官方 SDK](https://github.com/TikHub/TikHub-API-Python-SDK/blob/main/src/tikhub/resources/kuaishou_app.py)；不能仅因原 Web 请求未传 pcursor 就判断参数错误。本轮最多一次独立 App 首屏：`t.api_bc64c9d98dbf724c` → `/api/v1/kuaishou/app/fetch_video_comment`，复用原 Web 请求保存的真实 photo_id。App 结果取得前，快手统一路由仍不切换。若再次失败，停止本轮采购，使用上述上游 UUID 向 TikHub 核对请求和账单；不自动发工单。

单次 App 采样命令如下；只需宿主机同步新增 `server/ops/probe-kuaishou-app-comments.mjs` 和已有 inspector，不依赖新镜像。脚本按固定原 Web usage 读取有界保存请求，核对唯一 rejected/400 调用；数据库错误码是 `upstream_request_rejected`，公开原回执码是 `external_platform_rejected`，两层不能混淆。先免费查 App 原生授权/就绪，再最多发一笔 App 请求。独立 `kuaishou.app.json` 在调用前排他落盘；任何已存在的标记（含未知结果）都会阻止重新采购，原 `kuaishou.json` 完全保留。不要删除、换目录或重建标记。

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
import { runKuaishouAppCommentProbe } from './server/ops/probe-kuaishou-app-comments.mjs';
function admin(file, args) {
  return JSON.parse(execFileSync('kubectl', [
    '-n', 'mx-insight-hub', 'exec', '-i', 'deployment/mx-insight-hub-admin', '-c', 'admin', '--',
    'node', '--input-type=module', '-', ...args
  ], { input: readFileSync(file, 'utf8'), encoding: 'utf8', timeout: 30000,
    maxBuffer: 2 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }));
}
try {
  const sample = admin('server/ops/probe-kuaishou-app-comments.mjs', ['--prepare-private']);
  const result = await runKuaishouAppCommentProbe({ sample, sampleDirectory: process.cwd(),
    apiKey: process.env.MX_HUB_PROBE_API_KEY, apply: true });
  console.log(JSON.stringify(result, null, 2));
  if (result.requestId) console.log(JSON.stringify(admin(
    'server/ops/inspect-post-comment-contract.mjs', ['--request-id', result.requestId]
  ), null, 2));
  if (result.state !== 'http_response' || result.httpStatus !== 200) process.exitCode = 1;
} catch {
  console.error(JSON.stringify({ error: 'kuaishou_app_probe_stopped',
    action: 'preserve_all_markers_and_report_output' }));
  process.exitCode = 1;
}
NODE
BASH
```

私有帖子 ID 只在进程内传递；回传运行检查、App 请求摘要以及同 usage 的只读结构检查即可。无论 HTTP 成功还是拒绝，只要有持久 requestId 都先读取归档，不在失败时跳过证据。若归档读取失败也保留 App marker，不再次采样；根据已打印 requestId 单独重做只读检查。尚未确认 App 返回字段，不能提前将快手统一路由改成它。

本地验证：148 项相关合同、投影、历史回放、真实 gateway/runtime（模拟 HTTP）、入库、诊断及采样防重测试通过，typecheck 通过。运行检查命令已用本地模块离线校验；代理未部署服务器、未查询生产数据库、未新增供应商付费请求。下一步等待操作者回传。

### Reddit 单次业务验收与快手 App 完整归档验证

操作者已回传 `reddit_comments_runtime_updated`：运行容器的 Reddit 固定 TikHub `t.api_c7f50cf300d63960`、manualProviderPagination=true。该检查没有供应商请求，只证明运行路由更新，统一旧 URL 的真实交付尚待本节单次验收。Twitter 已完成，无需追加探测。

快手 App 本次已经成功：usage `16eb4f8e-7d1d-40e2-8593-02570ee3fd37`，幂等键 `kuaishou-app-comment-calibration-v1-729b12bf-c4df-4a06-83d7-0e3ca227e16e`，请求摘要 SHA256 `88473e1e26c6ceba5e5cdb8b066b68580e3ecc961fc9de85dcfb5f4e8360e428`。预检通过、恰好 1 次 Hub POST；同 usage committed，唯一 TikHub `native.t.api_bc64c9d98dbf724c` 调用 succeeded、HTTP/business 200、billed=true，13227 字节归档 SHA 验证通过。rootComments 长度 11，但结构摘要只抽样前 3 条；subCommentsMap 有回复预览，不能混为完整的根评论列表。保留 `kuaishou.json` 与 `kuaishou.app.json`，不要重跑 App 采购。

新增 `server/contracts/kuaishou-comment-page.mjs` 仍是候选，不接入快手运行路由。它保留完整根评论正文/作者/时间/点赞/实际 subCommentCount；数值 comment_id/author_id 必须为安全整数，或原本就是十进制字符串。内部 photo_id 可能大于安全整数且与公开 eID 不同，不用于身份。回复预览仅统计且保存在原始响应，不猜测完整回复或总数。候选强制比较保存请求目标与响应 `params.photo_id`；结构摘要的匿名 unknown11 尚不能单独证明这个实际键名。

同步候选解析器和更新后的 `server/ops/inspect-post-comment-contract.mjs`，不需部署镜像、不需要 Key，读取刚才已支付归档：

```bash
bash <<'BASH'
set -euo pipefail
cd /root/mx/workspace/de-llaaddddeerr/electron-dock/mx-insight-hub
cat server/contracts/kuaishou-comment-page.mjs server/ops/inspect-post-comment-contract.mjs |
  kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
  node --input-type=module - \
  --request-id '16eb4f8e-7d1d-40e2-8593-02570ee3fd37' \
  --verify-kuaishou-projection
BASH
```

输出仅包含全量条目/字段计数、数值安全类型、目标是否一致和分页状态；不会输出帖子/作者 ID、正文或游标值。调用/请求/归档严格绑定，同源只读事务，32 KiB 请求快照及 4 MiB 归档上限，零 HTTP/数据库写入。若发现不安全评论 ID、目标回显不匹配或其他合同差异，保留输出继续修解析；不重新采样。`pcursor` 缺失、重复及尚未证实的 `no_more` 哨兵先保持 unknown；普通推进 token 表示可显式续页，不保证下一页有评论。看到 no_more 的分类本身不自动修改生产分页行为。

Reddit 的新增 `server/ops/verify-reddit-comments-runtime.mjs` 是宿主机单次验收工具，也不需要部署。它只读准备已验证的原生 source usage `7eb265f4-5c2c-4d15-91d5-7dc7fed83b61` 的私有目标，验证固定原 `reddit.json`、平台及评论授权、已有原生授权的 TikHub 就绪状态，然后以 contentId/count20 请求旧 `/api/v1/search/post-comments`。独立 `reddit.unified-acceptance.json` 在发请求前排他持久保存，最多 1 次 Hub POST，不自动重试/续页，不修改原始原生样本。验收不假定新响应仍是 3 条，允许真实结束、未知状态或已购余量；空响应只能证明结构，不能通过正样本字段验收。评论 ready 当前不是 Reddit 专用判定，预检只用评论授权存在及 Reddit 原生就绪；普通业务 Key 不因此被要求增加原生授权。

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
import { runRedditCommentsRuntimeVerification } from './server/ops/verify-reddit-comments-runtime.mjs';
function admin(file, args) {
  return JSON.parse(execFileSync('kubectl', [
    '-n', 'mx-insight-hub', 'exec', '-i', 'deployment/mx-insight-hub-admin', '-c', 'admin', '--',
    'node', '--input-type=module', '-', ...args
  ], { input: readFileSync(file, 'utf8'), encoding: 'utf8', timeout: 30000,
    maxBuffer: 2 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }));
}
try {
  const sample = admin('server/ops/verify-reddit-comments-runtime.mjs', ['--prepare']);
  const result = await runRedditCommentsRuntimeVerification({ sample, sampleDirectory: process.cwd(),
    apiKey: process.env.MX_HUB_PROBE_API_KEY, apply: true });
  console.log(JSON.stringify(result, null, 2));
  if (result.requestId) {
    const evidence = admin('server/ops/inspect-post-comment-contract.mjs', ['--request-id', result.requestId]);
    const calls = evidence.calls.map(call => ({ provider: call.provider, platform: call.platform,
      endpoint: call.endpoint, outcome: call.outcome, httpStatus: call.httpStatus, businessCode: call.businessCode,
      billed: call.billed, errorCode: call.errorCode, archiveVerified: call.archive?.hashVerified === true }));
    const verified = evidence.usage?.platform === 'reddit' && evidence.usage.status === 'committed'
      && evidence.usage.httpStatus === 200 && !evidence.callsTruncated && calls.length === 1
      && calls.every(c => c.provider === 'tikhub' && c.platform === 'reddit'
        && c.endpoint === 'native.t.api_c7f50cf300d63960' && c.outcome === 'succeeded'
        && c.httpStatus === 200 && c.businessCode === 200 && c.billed === true && c.archiveVerified);
    console.log(JSON.stringify({ revision: 'reddit-unified-provider-evidence.v1', requestId: result.requestId,
      verified, usage: evidence.usage, calls, supplierHttpCallsMade: 0, databaseWritesMade: 0 }, null, 2));
    if (!verified) process.exitCode = 1;
  }
  if (result.verified !== true) process.exitCode = 1;
} catch {
  console.error(JSON.stringify({ error: 'reddit_acceptance_stopped', action: 'preserve_all_markers_and_report_output' }));
  process.exitCode = 1;
}
NODE
BASH
```

无论成功或失败，有持久 requestId 就先核对同 usage 保存调用；若核对失败，保留验收 marker，仅按已打印 requestId 重做只读核对。回传快手全量解析摘要、Reddit 业务验收摘要与同 usage 的采购证据，不需要提供 Key、正文或平台 ID。任何新验收都会按既有门禁及计价结算；不因 diagnostic 里的 supplierHttpCallsMade=0 而认为前面的实际请求免费。

本轮本地验证共 60 项通过：原 Twitter/Reddit 归档检查 25 项、快手候选解析 9 项、快手全量归档检查 12 项、Reddit 单次统一验收 14 项。新的生产解析器尚未用于快手运行路由；本轮代理未查询生产数据库、未发布服务、未新增付费请求。仅同步上述三个脚本/解析器文件即可执行两段命令，等待实际服务器输出。

### Reddit 已验收，快手发布与单次统一入口验收

Reddit 已闭环：旧 `/api/v1/search/post-comments` 的 usage `6fbf167b-9d1c-44f6-8ac0-5cd90fd3100b`，幂等键 `reddit-comments-acceptance-v1-e4df3667-de00-49e7-bb46-1b1d90e6955f`，HTTP 200，6 项合同检查均通过，返回 3 条、当前遍历 exhausted。同一 usage committed，唯一 TikHub c7 调用成功/计费/归档通过。保留原生及统一验收 marker，不再采购 Reddit 样本；这不是所有帖子、所有分页均已线上验证。

快手保存 App usage `16eb4f8e-7d1d-40e2-8593-02570ee3fd37` 全量校验通过：11 条根评论全部投影且唯一，正文、作者 ID、发布时间、点赞、回复数各 11 条；评论/作者数字 ID 均安全。内部 photo_id 全部是不安全数字，明确不用于请求/根帖身份；公开 eID 来自保存请求并与响应 params.photo_id 一致。2 条回复预览仅归档，不当作根评论。顶层 pcursor 为 no_more；当前保守合同保持 hasMore=null、continuationAvailable=false、stopReason=continuation_unproven，未自动认定 exhausted。

本地已将快手统一配方改为 TikHub App `t.api_bc64c9d98dbf724c`、`photo_id`，接入同一已验证纯解析器及每请求单页采购。旧首请求与回执指纹不变；旧非空原生 pcursor 因供应商来源无法区分仅历史原键重放，当前 Hub 签名游标可继续；原已排队 JustOne 入库保持其供应商归属。沿用现有 PG 原始归档、采购账本、social.comments.v1 和分页余量，无新 DDL。

先同步本轮完整 Hub 代码（不只是 ops 文件），包括配方、workflow、index、projection、parser、ingest、API 文档和新增 `server/ops/verify-kuaishou-comments-runtime.mjs`。以下一次完成 Hub 发布、静态路由检查、免费授权预检、最多一次统一入口验收及同 usage 的只读采购证据核对。发布开关保持 Launcher 不同步/不重启，数据 smoke 不采集。标准部署仍执行已有迁移/索引维护。

```bash
bash <<'BASH'
set -e
cd /root/mx/workspace/de-llaaddddeerr/electron-dock/mx-insight-hub
MX_INSIGHT_SYNC_LAUNCHER=0 MX_SMOKE_DATA=0 bash scripts/manage.sh deploy

kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-public -c api -- \
  node --input-type=module - <<'CHECK'
import assert from 'node:assert/strict';
import { POST_COMMENTS_RECIPES, buildPostCommentsDispatch } from '/app/server/contracts/post-comments.mjs';
import { normalizePostCommentsDelivery } from '/app/server/external-platforms/post-comments-workflow.mjs';
const recipe = POST_COMMENTS_RECIPES.kuaishou;
const request = normalizePostCommentsDelivery({ platform: 'kuaishou', contentId: 'fixturePhoto123', count: 20 },
  { context: { consumer: { businessId: 'runtime-contract-check' } }, maxPageSize: 100, codec: {} });
const dispatch = buildPostCommentsDispatch(request);
assert.equal(recipe.provider, 'tikhub');
assert.equal(recipe.key, 't.api_bc64c9d98dbf724c');
assert.equal(dispatch.endpointPath, '/api/v1/kuaishou/app/fetch_video_comment');
assert.equal(dispatch.upstreamQuery.photo_id, 'fixturePhoto123');
assert.equal(request.manualProviderPagination, true);
assert.equal(POST_COMMENTS_RECIPES.twitter.key, 't.api_3cd88a6621a01120');
assert.equal(POST_COMMENTS_RECIPES.reddit.key, 't.api_c7f50cf300d63960');
console.log(JSON.stringify({ state: 'kuaishou_comments_runtime_updated', provider: recipe.provider,
  nativeKey: recipe.key, manualProviderPagination: request.manualProviderPagination, supplierHttpCallsMade: 0 }, null, 2));
CHECK

read -r -s -p 'Hub Live API Key: ' MX_HUB_PROBE_API_KEY </dev/tty
printf '\n'
export MX_HUB_PROBE_API_KEY
node --input-type=module <<'ACCEPT'
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { runKuaishouCommentsRuntimeVerification } from './server/ops/verify-kuaishou-comments-runtime.mjs';
function admin(file, args) {
  return JSON.parse(execFileSync('kubectl', [
    '-n', 'mx-insight-hub', 'exec', '-i', 'deployment/mx-insight-hub-admin', '-c', 'admin', '--',
    'node', '--input-type=module', '-', ...args
  ], { input: readFileSync(file, 'utf8'), encoding: 'utf8', timeout: 30000,
    maxBuffer: 2 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }));
}
try {
  const sample = admin('server/ops/verify-kuaishou-comments-runtime.mjs', ['--prepare']);
  const result = await runKuaishouCommentsRuntimeVerification({ sample, sampleDirectory: process.cwd(),
    apiKey: process.env.MX_HUB_PROBE_API_KEY, apply: true });
  console.log(JSON.stringify(result, null, 2));
  if (result.requestId) {
    const evidence = admin('server/ops/inspect-post-comment-contract.mjs', ['--request-id', result.requestId]);
    const calls = evidence.calls.map(c => ({ provider: c.provider, platform: c.platform, endpoint: c.endpoint,
      outcome: c.outcome, httpStatus: c.httpStatus, businessCode: c.businessCode, billed: c.billed,
      errorCode: c.errorCode, archiveVerified: c.archive?.hashVerified === true }));
    const verified = evidence.usage?.platform === 'kuaishou' && evidence.usage.status === 'committed'
      && evidence.usage.httpStatus === 200 && !evidence.callsTruncated && calls.length === 1
      && calls.every(c => c.provider === 'tikhub' && c.platform === 'kuaishou'
        && c.endpoint === 'native.t.api_bc64c9d98dbf724c' && c.outcome === 'succeeded'
        && c.httpStatus === 200 && c.businessCode === 200 && c.billed === true && c.archiveVerified);
    console.log(JSON.stringify({ revision: 'kuaishou-unified-provider-evidence.v1', requestId: result.requestId,
      verified, usage: evidence.usage, calls, supplierHttpCallsMade: 0, databaseWritesMade: 0 }, null, 2));
    if (!verified) process.exitCode = 1;
  }
  if (result.verified !== true) process.exitCode = 1;
} catch {
  console.error(JSON.stringify({ error: 'kuaishou_acceptance_stopped', action: 'preserve_all_markers_and_report_output' }));
  process.exitCode = 1;
}
ACCEPT
BASH
```

验收只使用已经验证的 App 来源和同目录 kuaishou.app.json，目标及原 bodySha256 匹配后才允许调用；新增 kuaishou.unified-acceptance.json 在发请求前排他持久化，任何已有对象均阻止再次采购。不自动重试/续页、不改原 Web/App marker。验收不假定当前仍返回 11 条；空页不能算正样本通过，失败/未知也消费一次验收机会。若同 usage 只读核对失败，按已打印 requestId 单独核对，不能通过删 marker 重新购买。

本轮本地 121 项相关回归通过，包括 33 项 gateway/runtime/入库、42 项合同/游标/API 文档、32 项投影、14 项一次性验收；typecheck 通过。命令静态语法及本地模块路由检查通过，代理未部署服务器或新增供应商调用。等待以上三份服务器摘要；其余七个 JustOne 评论路由仍受余额阻塞。


### 快手发布检查仍返回 JustOne：只读核对源码与运行容器

操作者在 Public 容器静态检查中得到 `actual: justone / expected: tikhub`。这证明被检查容器仍含旧快手配方；不能单凭此断定缓存、服务器未拉代码或镜像导入失败。若按上一节完整 `set -e` 命令执行，已在检查处退出，后面的 Key 输入与统一入口付费验收未执行。保留所有样本及验收 marker，不重复原生采样。

本地配方已是 TikHub App；部署脚本从脚本所在 Hub 目录构建并复制完整 server，向本机 containerd 导入，使用当前 kubectl context，随后显式 rollout restart/status。镜像引用存在不证明内容正确，本机 runtime 也不自动证明与所选集群一致。成功清理可能移除 Docker 标签，不能用其缺失推断构建失败。

以下命令不依赖新 ops 文件，可直接粘贴到服务器。只读取当前检出版本、固定六个源文件的 SHA256、配方声明，以及 Public/Admin 各 Pod 的版本和节点信息；不读取密钥/业务数据、不请求供应商、不修改服务。配方是源码声明摘要，不替代下一步完整运行路由断言。文件 hash 为 null 表示读取失败，Pod source 为 null 表示容器检查未完成，均不能当作已一致。

```bash
bash <<'BASH'
set -euo pipefail
cd /root/mx/workspace/de-llaaddddeerr/electron-dock/mx-insight-hub
node --input-type=module <<'NODE'
import { execFileSync } from 'node:child_process';
import { hostname } from 'node:os';
const run = (cmd, args, input) => execFileSync(cmd, args, {
  input, encoding: 'utf8', timeout: 15000, maxBuffer: 2 * 1024 * 1024,
  stdio: ['pipe', 'pipe', 'pipe']
}).trim();
const snapshot = String.raw`
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
const root = process.argv[2];
const paths = ['contracts/post-comments.mjs', 'contracts/kuaishou-comment-page.mjs',
  'contracts/post-comment-projection.mjs', 'external-platforms/post-comments-workflow.mjs',
  'index.mjs', 'workers/ingest.mjs'];
const files = Object.fromEntries(paths.map(path => {
  try { return [path, createHash('sha256').update(readFileSync(resolve(root, 'server', path))).digest('hex')]; }
  catch { return [path, null]; }
}));
let declaredRecipe = null;
try {
  const source = readFileSync(resolve(root, 'server/contracts/post-comments.mjs'), 'utf8');
  const match = source.match(/^\s*\['kuaishou',\s*'([^']+)',\s*'([^']+)'/m);
  if (match) declaredRecipe = { provider: match[1], path: match[2] };
} catch {}
console.log(JSON.stringify({ declaredRecipe, files }));
`;
try {
  let gitHead = null;
  try { gitHead = run('git', ['rev-parse', 'HEAD']); } catch {}
  console.log(JSON.stringify({ section: 'server', hostname: hostname(), cwd: process.cwd(),
    gitHead,
    context: run('kubectl', ['config', 'current-context']),
    source: JSON.parse(run(process.execPath, ['--input-type=module', '-', process.cwd()], snapshot)) }, null, 2));
  const nodes = JSON.parse(run('kubectl', ['get', 'nodes', '-o', 'json']));
  console.log(JSON.stringify({ section: 'nodes', nodes: nodes.items.map(n => ({
    name: n.metadata.name, runtime: n.status?.nodeInfo?.containerRuntimeVersion,
    addresses: n.status?.addresses
  })) }, null, 2));
  const pods = JSON.parse(run('kubectl', ['-n', 'mx-insight-hub', 'get', 'pods',
    '-l', 'app.kubernetes.io/name in (mx-insight-hub-public,mx-insight-hub-admin)', '-o', 'json']));
  if (!pods.items.length || pods.items.length > 6) throw new Error('pod_inventory_unexpected');
  for (const p of pods.items) {
    const container = p.metadata.labels['app.kubernetes.io/name'] === 'mx-insight-hub-public' ? 'api' : 'admin';
    const status = p.status?.containerStatuses?.find(c => c.name === container);
    let source = null;
    try { source = JSON.parse(run('kubectl', ['-n', 'mx-insight-hub', 'exec', '-i', p.metadata.name,
      '-c', container, '--', 'node', '--input-type=module', '-', '/app'], snapshot)); } catch {}
    if (!source) process.exitCode = 1;
    console.log(JSON.stringify({ section: 'pod', name: p.metadata.name, node: p.spec.nodeName,
      createdAt: p.metadata.creationTimestamp, deleting: Boolean(p.metadata.deletionTimestamp),
      image: p.spec.containers.find(c => c.name === container)?.image,
      imageID: status?.imageID, ready: status?.ready,
      sourceState: source ? 'read' : 'unavailable', source }, null, 2));
  }
} catch {
  console.error(JSON.stringify({ error: 'runtime_diagnosis_incomplete' }));
  process.exitCode = 1;
}
NODE
BASH
```

判断顺序：服务器 source.declaredRecipe.provider 仍为 justone，先同步完整 Hub 改动；服务器已 tikhub 而某 Pod 仍为 justone 或 hash 不一致，继续核对构建/导入/集群与 rollout 结果，暂不执行付费验收。所有当前容器与源码一致后再执行上一节完整运行路由检查，检查通过才继续保留防重标记的单次验收。不要为通过断言而仅改配置值、删除 marker、强制删 Pod 或重启 Launcher。

本轮仅更新诊断文档与状态，未改运行代码；Bash/Node 语法及本地源码摘要已检查，未执行生产命令或供应商调用。等待服务器输出确认实际版本差异。

### 快手发布版本已对齐：继续统一入口单次验收

两次服务器回传已定位并解决版本差异。第一次服务器 HEAD `af1f07010cad8db22666eab1347e535bc875f58c` 的源码配方仍是 JustOne，Public/Admin 的六个文件 SHA256 均与宿主机一致，同节点、同镜像；直接原因是未同步包含快手切换的源码。后续服务器 HEAD `1089e532a51a530eb9eaf0bd29db4ff7f716bd51`，宿主机/Public/Admin 六个文件均与本地 TikHub App 版本一致，配方为 `/api/v1/kuaishou/app/fetch_video_comment`。Public `mx-insight-hub-public-68656bc769-xd8kc` 与 Admin `mx-insight-hub-admin-5c58b86489-rlml5` 均 Ready、未删除，同节点 `mx-internal-server`、同镜像 `sha256:c001eb6cf3cc5842422b59006a8563a2934d92edf091a047e1c99ee39d586a04`。发布版本已对齐，不再重复 Git 同步、部署或镜像诊断；这仍不是统一入口的业务验收结果。

下一步使用“Reddit 已验收，快手发布与单次统一入口验收”一节现有命令，去掉 `MX_INSIGHT_SYNC_LAUNCHER=0 MX_SMOKE_DATA=0 bash scripts/manage.sh deploy` 一行，保留 Public 纯运行路由断言、Key 输入和 ACCEPT 块。命令固定在服务器 Hub 根目录，复用已成功的 App 来源 `16eb4f8e-7d1d-40e2-8593-02570ee3fd37`，免费预检后最多请求一次旧统一 URL，再只读核对同一 usage 的供应商证据。已有 `kuaishou.unified-acceptance.json` 则停止，不换目录、不删 marker；失败有持久 requestId 时只重做其归档检查，不重新采购。原 Twitter、Reddit 及快手 Web/App 回执全部保留。

预期收到运行配方摘要、`kuaishou-comments-runtime-verification.v1` 和 `kuaishou-unified-provider-evidence.v1`；后两者均 verified=true 才能闭环。新响应不必仍为 11 条；`no_more` 仍按已验证保守合同返回 unknown，不能强制改为 exhausted。本轮只更新证据状态，截去部署后的 Bash/Node 语法及本地相同模块的完整路由断言通过，没有代理生产调用、运行代码、数据库、Launcher 或 H2I 变更。

### 快手统一入口首屏验收已通过

操作者回传运行断言通过：TikHub `t.api_bc64c9d98dbf724c`、manualProviderPagination=true。统一旧 URL `/api/v1/search/post-comments` 的 usage `2274fe73-43e4-4914-9f21-a3629b188d09`，幂等键 `kuaishou-comments-acceptance-v1-6c90d52e-cefd-44d2-953f-b28cd8ac6c66`，请求摘要 SHA256 `7ebd241348c94e08fe32792c6188bce0d87dc7abc41fcf327d4d93644f1553e3`。免费预检 HTTP200，kuaishou、social.comments.list 授权及 TikHub App 原生就绪均通过；随后恰好一次 Hub POST，HTTP200、verified=true、contractValid=true，合同/条目/身份/字段/采购/分页六项均通过，返回 11 条评论。

同 usage 的独立只读证据 verified=true：platform=kuaishou、committed、HTTP200；恰好一次 TikHub `native.t.api_bc64c9d98dbf724c` 调用 succeeded、HTTP/business200、billed=true、errorCode=null，archiveVerified=true。第二份证据里的 supplierHttpCallsMade=0/databaseWritesMade=0 仅说明读取证据未追加采购或写入，前面的业务请求确实计费一次。

交付分页为 hasMore=null、continuationAvailable=false、paginationStatus=unknown，符合保守合同：本页可交付，没有已证实的续页入口，不宣称所有评论已取完。原 App 保存样本的 no_more 已校准；本次摘要没有公开供应商游标值，不据此推断新归档必然出现同一哨兵。不要自动把 page 加一或换键重买以尝试补页。

至此 Twitter、Reddit、快手的统一入口首屏均验收完成，无需重部署、原生重采或再次验收。固定服务器 Hub 根目录 `.hub-comment-contract-probes-v1` 内的原始/认证恢复/会话/App/统一验收标记全部保留，特别是 `kuaishou.json`、`kuaishou.app.json`、`kuaishou.unified-acceptance.json`；旧 Web 400、billed=null 的证据仍保持未知，不改写历史账本。其余七个 JustOne 平台仍受余额阻塞，小红书/Instagram/YouTube 原已是 TikHub 但本轮未新增统一入口生产验收；不能宣称全部平台闭环。优先核对原需求中的微博候选及已有归档，暂无新增付费动作或架构/存储变更。本轮仅记录服务器验收证据及更新当前状态，无运行代码、DDL、Launcher 或 MX-H2I 登录/联网变更。


### 下一步微博：先查已保存的主评论归档

原需求优先使用微博评论。当前仍是 JustOne 的七个平台为微博、抖音、TikTok、知乎、LinkedIn、Bilibili、Facebook。微博有两条已登记 TikHub 主评论候选：Web `t.api_631f7f6fd007cba9`（id/count/max_id），App `t.api_ac75edddcf5bb304`（status_id/max_id/sort_type）。子评论 `t.api_11c128f19504d074` 不替代主评论。现有 inspector 已识别两条主评论端点，但统一投影尚未校准，不能只改 provider 后上线。

下方 Admin stdin 命令只读最近 5000 条 TikHub 调用的固定元数据，利用现有 `(provider_key, started_at DESC)` 索引；在有界切片内筛两个微博主评论端点，最多显示三个 usage UUID、状态和受限归档存在性，不取正文/请求目标/凭据、不发供应商 HTTP、不写数据库。只读事务、4s 语句/1s 锁/6s 客户端超时；第四条仅判断返回结果是否截断。不存在于切片不等于历史全无；archivePresent=true 不等于内容已通过 SHA/字段验证。该发现没有改变现有三平台付费 probe 限制，没有新采样授权或绕过目录标记。

```bash
bash <<'BASH'
set -euo pipefail
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
  node --input-type=module - <<'NODE'
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL,
  max: 1, connectionTimeoutMillis: 5000, query_timeout: 6000,
  options: '-c default_transaction_read_only=on -c statement_timeout=4000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=10000' });
let client;
try {
  if (!process.env.DATABASE_URL) throw new Error('database_url_required');
  client = await pool.connect();
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const { rows } = await client.query(`
    WITH recent AS MATERIALIZED (
      SELECT id, usage_request_id, marketplace, endpoint_key, outcome,
        http_status, business_code, billed, started_at
      FROM external_platform.provider_calls
      WHERE provider_key = 'tikhub'
      ORDER BY started_at DESC LIMIT 5000
    )
    SELECT c.usage_request_id AS "requestId", c.endpoint_key AS endpoint,
      c.outcome, c.http_status AS "httpStatus", c.business_code AS "businessCode", c.billed,
      EXISTS (SELECT 1 FROM control.external_platform_restricted_raw_responses r
        WHERE r.provider_call_id = c.id) AS "archivePresent"
    FROM recent c WHERE c.marketplace = 'weibo'
      AND c.endpoint_key IN ('native.t.api_631f7f6fd007cba9', 'native.t.api_ac75edddcf5bb304')
    ORDER BY c.started_at DESC, c.id DESC LIMIT 4
  `);
  console.log(JSON.stringify({ revision: 'weibo-comment-archive-discovery.v1',
    state: rows.length ? 'found' : 'not_found_in_recent_slice',
    scanLimit: 5000, results: rows.slice(0, 3), truncated: rows.length > 3,
    supplierHttpCallsMade: 0, databaseWritesMade: 0,
    boundary: 'Saved call metadata only. Archive presence does not verify its content; no match does not establish global absence.'
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ error: error.code === '57014' ? 'discovery_timed_out' : 'discovery_incomplete',
    supplierHttpCallsMade: 0, databaseWritesMade: 0 }));
  process.exitCode = 1;
} finally {
  if (client) { await client.query('ROLLBACK').catch(() => {}); client.release(); }
  await pool.end();
}
NODE
BASH
```

找到后按返回 requestId 使用现有 `inspect-post-comment-contract.mjs` 只读核对账本、精确字节归档及结构，再准备微博纯解析；没有找到则另行选择有界历史范围或保存的帖子目标，当前命令不会自动采集。Bash/Node 语法及实际表/索引定义已核对；尚未执行生产查询。


### 微博最近 5000 次调用未命中：按端点查历史并找原帖候选

操作者回传 `weibo-comment-archive-discovery.v1`：not_found_in_recent_slice、scanLimit=5000、results=[]、truncated=false，零供应商 HTTP/数据库写入。这仅排除了最近切片中的两个微博主评论端点，不证明全部历史没有归档。下一步不重复该切片，不发付费请求。

本地迁移定义保留 `(provider_key, operation, endpoint_key, outcome, completed_at DESC)` 索引。下列查询针对两个准确的 native operation/endpoint、succeeded 分别取最近四条（只返回前三条，第四条用于截断标记），不再受最近 5000 次跨端点调用覆盖；存在归档仍待 SHA/请求目标/字段核验。若无满足微博/200/成功计费/归档存在的候选，则在 night-all.search.v1 与 night-all.compat.v1 各先按 dataset/platform/event_time/id 取最新 50 条，再筛未删除原帖并选数字 external_id 候选，优先已有评论数为正的观测。查询失败由 savepoint 隔离并报告 timed_out/read_failed；4s 语句、1s 锁、6s 客户端超时。索引定义已本地核对，未声称生产执行计划或索引在线状态已验证。

输出只有 usage UUID、canonical UUID、固定端点/数据集、状态及计数/布尔值，不输出平台 ID、URL、正文、作者或凭据。canonical 数字字符串只是候选：历史通用映射可能把已舍入 Number 转成字符串，后续必须按固定 UUID 核验原始来源再准备采样；微博 URL 末段可能为 base62 bid/mblogid，不直接当数字 MID，也不自动转换。positiveSavedCommentCount 不保证实时仍有评论。

```bash
bash <<'BASH'
set -euo pipefail
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
  node --input-type=module - <<'NODE'
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1,
  connectionTimeoutMillis: 5000, query_timeout: 6000,
  options: '-c default_transaction_read_only=on -c statement_timeout=4000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=10000' });
let client;
try {
  if (!process.env.DATABASE_URL) throw new Error('database_url_required');
  client = await pool.connect();
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  async function read(sql, values) {
    await client.query('SAVEPOINT evidence_read');
    try {
      const result = await client.query(sql, values);
      await client.query('RELEASE SAVEPOINT evidence_read');
      return { state: 'read', rows: result.rows };
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT evidence_read');
      await client.query('RELEASE SAVEPOINT evidence_read');
      return { state: error.code === '57014' ? 'timed_out' : 'read_failed', rows: [] };
    }
  }
  const scans = [], calls = [], targets = [];
  for (const endpoint of ['native.t.api_631f7f6fd007cba9', 'native.t.api_ac75edddcf5bb304']) {
    const result = await read(`
      WITH recent AS MATERIALIZED (
        SELECT id, usage_request_id, marketplace, http_status, business_code, billed, completed_at
        FROM external_platform.provider_calls
        WHERE provider_key='tikhub' AND operation=$1 AND endpoint_key=$1 AND outcome='succeeded'
        ORDER BY completed_at DESC LIMIT 4
      )
      SELECT c.usage_request_id AS "requestId", c.marketplace AS platform,
        c.http_status AS "httpStatus", c.business_code AS "businessCode", c.billed,
        EXISTS (SELECT 1 FROM control.external_platform_restricted_raw_responses r
          WHERE r.provider_call_id=c.id) AS "archivePresent"
      FROM recent c ORDER BY c.completed_at DESC, c.id DESC
    `, [endpoint]);
    scans.push({ source: 'endpoint_history', endpoint, state: result.state,
      matchedRows: result.rows.length, truncated: result.rows.length > 3 });
    calls.push(...result.rows.slice(0, 3).map(row => ({ endpoint, ...row })));
  }
  const archiveCandidates = calls.filter(c => c.platform === 'weibo' && c.httpStatus === 200
    && c.businessCode === 200 && c.billed === true && c.archivePresent);
  if (!archiveCandidates.length) {
    for (const dataset of ['night-all.search.v1', 'night-all.compat.v1']) {
      const result = await read(`
        WITH recent AS MATERIALIZED (
          SELECT id, event_time FROM core.canonical_records
          WHERE dataset_id=$1 AND platform='weibo'
          ORDER BY event_time DESC, id DESC LIMIT 50
        )
        SELECT c.id,
          CASE WHEN length(c.external_id)<=30 THEN c.external_id END AS external_id,
          CASE WHEN length(c.stable_fields #>> '{metrics,comments}')<=20
            THEN c.stable_fields #>> '{metrics,comments}' END AS comment_count
        FROM recent r JOIN core.canonical_records c ON c.id=r.id
        WHERE c.object_type='post' AND c.deleted_at IS NULL
        ORDER BY r.event_time DESC, r.id DESC
      `, [dataset]);
      scans.push({ source: 'canonical', dataset, state: result.state,
        postRows: result.rows.length, sliceLimit: 50 });
      const candidates = result.rows.filter(r => typeof r.external_id === 'string'
        && /^[1-9][0-9]{0,29}$/.test(r.external_id)).map(r => ({
          sourceKind: 'canonical', sourceId: r.id, dataset,
          positiveSavedCommentCount: /^[0-9]{1,20}$/.test(r.comment_count ?? '')
            && BigInt(r.comment_count) > 0n,
          requiresSourceVerification: true
        }));
      candidates.sort((a, b) => Number(b.positiveSavedCommentCount) - Number(a.positiveSavedCommentCount));
      if (candidates.length) targets.push(candidates[0]);
    }
  }
  console.log(JSON.stringify({ revision: 'weibo-comment-evidence-discovery.v2',
    state: archiveCandidates.length ? 'archive_candidate_found' : targets.length ? 'target_candidate_found'
      : scans.some(s => s.state !== 'read') ? 'discovery_incomplete' : 'not_found_in_bounded_scan',
    archiveCandidates, calls, targets, scans,
    supplierHttpCallsMade: 0, databaseWritesMade: 0,
    boundary: 'Saved metadata only. Archives require integrity and contract checks; target candidates require original ID verification. No automatic acquisition.'
  }, null, 2));
} catch {
  console.error(JSON.stringify({ error: 'weibo_discovery_incomplete',
    supplierHttpCallsMade: 0, databaseWritesMade: 0 }));
  process.exitCode = 1;
} finally {
  if (client) { await client.query('ROLLBACK').catch(() => {}); client.release(); }
  await pool.end();
}
NODE
BASH
```

本轮未改变运行路由、付费 probe 三平台限制、标记目录、权限、计价或数据库结构；无需部署。Bash/Node 语法和固定 SQL 所用字段/索引已核对；这是待操作者执行的只读命令，本地没有生产查询或供应商调用。根据返回归档或目标 UUID 再进行精确核验，不重复全范围查找。


### 微博原帖候选已定位：按固定 UUID 核验入库来源

操作者回传 v2：两个准确的 TikHub 主评论 native operation/endpoint 成功历史查询均 read、matchedRows=0；night-all.search.v1 的有界切片返回 50 条原帖，从中选出 canonical `ffe325bc-1e9a-4cab-8693-4d866252c88a`，positiveSavedCommentCount=false、requiresSourceVerification=true；compat 切片无原帖。已有明确候选，下一步只读该 UUID，不重扫、不新增付费请求。

false 不是零评论结论：标准搜索 normalizer 只接收数值 metrics.comments，原字符串计数可能未进入 canonical。下面在同一只读快照中按 canonical PK→当前 record_revision PK→revision ingest_run，再按确切 connector/stream/object_type/source_key UNIQUE 找当前 source_objects。只支持代码已确认的普通搜索来源 night-all/weibo.search_posts.v1 或 external-platform:tikhub/weibo.external-platform.v1；手工修复/未知来源不猜 source_key。原始来源和 revision 可能属于不同 run，分别展示，不把 current source 当成原 revision。Night-All 旧链不持续维护 source_object_revisions，故不拿其回填记录当最新原文，也不对 hashVersion=0 声称完整原始 hash 校验。

每份 payload 最多读 128 KiB，只输出固定字段的类型、与 canonical ID 的匹配布尔值、评论量 positive/zero/unknown/unrecognized，以及内部 run/request/call UUID。`saved_source_identity_matched` 仅证明保存入库输入中实际采用的字符串 ID 与 canonical 一致；不证明上游从未预处理、不替代供应商精确字节归档校验，也不保证实时存在评论。返回的 providerCallId/connectorCallId 可用于后续精确读取，无需通过 requestId 猜某次调用。无值输出、无自动采集、无数据库写入。

```bash
bash <<'BASH'
set -euo pipefail
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
  node --input-type=module - <<'NODE'
import pg from 'pg';
const sourceId = 'ffe325bc-1e9a-4cab-8693-4d866252c88a';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1,
  connectionTimeoutMillis: 5000, query_timeout: 6000,
  options: '-c default_transaction_read_only=on -c statement_timeout=4000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=10000' });
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const type = v => v === undefined ? 'missing' : v === null ? 'null'
  : typeof v === 'number' ? Number.isSafeInteger(v) ? 'safe_integer' : 'unsafe_or_noninteger_number'
  : typeof v === 'string' ? 'string' : 'other';
const identity = v => typeof v === 'string' && /^[1-9][0-9]{0,29}$/.test(v.trim()) ? v.trim()
  : Number.isSafeInteger(v) && v > 0 ? String(v) : null;
const metric = v => ({ type: type(v), state: v == null ? 'unknown'
  : (typeof v === 'string' && /^[0-9]{1,20}$/.test(v) || Number.isSafeInteger(v) && v >= 0)
    ? BigInt(v) > 0n ? 'positive' : 'zero' : 'unrecognized' });
function fields(raw, expected) {
  if (!object(raw)) return null;
  const identities = ['externalId', 'id', 'content_id', 'weibo_id', 'idstr', 'post_id', 'status_id', 'mid']
    .filter(key => Object.hasOwn(raw, key)).map(key => ({
      field: key, type: type(raw[key]), matchesCanonical: identity(raw[key]) === expected
    }));
  const comments = [
    ['metrics.comments', raw.metrics?.comments], ['comment_count', raw.comment_count],
    ['comments_count', raw.comments_count], ['commentCount', raw.commentCount],
    ['interaction.comment_count', raw.interaction?.comment_count]
  ].map(([field, value]) => ({ field, ...metric(value) }));
  return { identities, comments };
}
let client;
try {
  if (!process.env.DATABASE_URL) throw new Error();
  client = await pool.connect();
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const { rows } = await client.query(`
    SELECT c.external_id, c.current_revision,
      c.stable_fields #> '{metrics,comments}' AS canonical_comments,
      v.parser_version, v.ingest_run_id AS revision_run_id,
      octet_length(v.normalized_payload::text) AS revision_payload_bytes,
      CASE WHEN octet_length(v.normalized_payload::text)<=131072
        THEN v.normalized_payload END AS revision_payload,
      r.connector_id, r.stream_id, r.request_id AS revision_request_id,
      r.connector_call_id AS revision_connector_call_id,
      r.external_platform_call_id AS revision_provider_call_id,
      s.id AS source_object_id, s.ingest_run_id AS source_run_id,
      s.last_seen_at, s.raw_payload_hash_version,
      octet_length(s.raw_payload::text) AS source_payload_bytes,
      CASE WHEN octet_length(s.raw_payload::text)<=131072
        THEN s.raw_payload END AS source_payload,
      sr.request_id AS source_request_id,
      sr.connector_call_id AS source_connector_call_id,
      sr.external_platform_call_id AS source_provider_call_id
    FROM core.canonical_records c
    LEFT JOIN core.record_revisions v
      ON v.record_id=c.id AND v.revision=c.current_revision
    LEFT JOIN ingest.ingest_runs r ON r.id=v.ingest_run_id
    LEFT JOIN ingest.source_objects s
      ON s.connector_id=r.connector_id AND s.stream_id=r.stream_id
      AND s.object_type=c.object_type AND s.source_key=c.external_id
      AND ((r.connector_id='night-all' AND r.stream_id='weibo.search_posts.v1')
        OR (r.connector_id='external-platform:tikhub' AND r.stream_id='weibo.external-platform.v1'))
    LEFT JOIN ingest.ingest_runs sr ON sr.id=s.ingest_run_id
    WHERE c.id=$1::uuid AND c.dataset_id='night-all.search.v1'
      AND c.platform='weibo' AND c.object_type='post' AND c.deleted_at IS NULL
  `, [sourceId]);
  if (rows.length !== 1 || identity(rows[0].external_id) !== rows[0].external_id) throw new Error();
  const r = rows[0], raw = r.source_payload;
  const selected = r.connector_id === 'night-all'
    ? typeof raw?.externalId === 'string' && raw.externalId.trim() ? raw.externalId : raw?.id
    : raw?.content_id;
  const sourceIdentityMatched = object(raw) && typeof selected === 'string'
    && identity(selected) === r.external_id;
  console.log(JSON.stringify({ revision: 'weibo-comment-target-inspection.v1', sourceId,
    state: sourceIdentityMatched ? 'saved_source_identity_matched' : 'source_identity_unverified',
    canonical: { revision: r.current_revision, comments: metric(r.canonical_comments) },
    revisionLineage: { parserVersion: r.parser_version, connector: r.connector_id,
      stream: r.stream_id, runId: r.revision_run_id,
      requestId: r.revision_request_id, connectorCallId: r.revision_connector_call_id,
      providerCallId: r.revision_provider_call_id, payloadBytes: r.revision_payload_bytes },
    revisionFields: fields(r.revision_payload, r.external_id),
    currentSource: { present: Boolean(r.source_object_id), sourceObjectId: r.source_object_id,
      payloadRead: object(raw), hashVersion: r.raw_payload_hash_version,
      payloadBytes: r.source_payload_bytes,
      runId: r.source_run_id, requestId: r.source_request_id,
      connectorCallId: r.source_connector_call_id,
      providerCallId: r.source_provider_call_id, lastSeenAt: r.last_seen_at,
      sameRunAsCanonicalRevision: r.source_run_id != null && r.source_run_id === r.revision_run_id,
      identityMatched: sourceIdentityMatched, fields: fields(raw, r.external_id) },
    supplierHttpCallsMade: 0, databaseWritesMade: 0,
    boundary: 'Only saved canonical and ingest input evidence. Current source may be newer than the canonical revision. No exact supplier-byte verification or live-comment guarantee; no automatic acquisition.'
  }, null, 2));
} catch {
  console.error(JSON.stringify({ error: 'weibo_target_inspection_incomplete',
    supplierHttpCallsMade: 0, databaseWritesMade: 0 }));
  process.exitCode = 1;
} finally {
  if (client) { await client.query('ROLLBACK').catch(() => {}); client.release(); }
  await pool.end();
}
NODE
BASH
```

本轮仅准备上述服务器只读核验；实际候选字段还未回传，微博统一配方仍是 JustOne。Bash/Node 语法与 ID 安全整数/字符串、计数正数/零/缺失、输出不含 ID/正文的本地辅助检查通过，固定 SQL 字段/唯一键/来源规则已核对。无运行代码、存储、权限、付费 probe 或 MX-H2I 登录/联网变更。


## 微博旧候选确认为零评论，授权重新采样最多两次

2026-11-02 操作者回传固定候选 `ffe325bc-1e9a-4cab-8693-4d866252c88a` 的来源核验：canonical revision 1、版本输入和当前来源的原帖 ID 一致，评论数均为安全整数 0。版本和来源同属 run `d7ceda59-d98d-4736-bbe0-793d7b1cf985`、request `216d5c81-4074-4d2c-ad1a-86d55ef088e1`；来源 payload 6454 字节，hashVersion 1。此次只读结果不等于供应商原始字节或当前在线评论数证明；已足以结束对这一旧候选的排查。

用户再次明确授权缺少历史记录时发起几次付费请求。本批次限定最多两个新 Hub POST：

1. TikHub Web 高级搜索 `t.api_7b07a36b82baa693`，固定 `q=科技/search_type=hot/include_type=all/page=1`。
2. 仅当第一步对应的唯一成功且已计费调用及完整归档 SHA 验证通过，并找到可保真原帖 ID 和正评论量时，TikHub Web 主评论 `t.api_631f7f6fd007cba9` 一页，`count=20`。无合格目标就停止，最多只采购搜索。

参数核对依据：[官方高级搜索](https://docs.tikhub.io/381269425e0)、[官方实时搜索](https://docs.tikhub.io/381269427e0)、[官方主评论接口](https://docs.tikhub.io/381269409e0)。实时搜索文档说明其响应结构与高级搜索相同；本地已有实时搜索投影使用 `data.parsed_data.results`，新选择器据此做受检查的候选解析。高级搜索文档没有完整真实响应例子，因此**仍待本次完整保存归档验证字段**；`parse_success=false` 或结构不符时停止，不追加搜索或猜测别的结构。

新增 `server/ops/probe-weibo-comments.mjs` 并更新 `server/ops/inspect-post-comment-contract.mjs` 的微博结构字段白名单。只需同步这两份文件到服务器，无需部署镜像。使用之前同一个 Hub 根目录下的 `.hub-comment-contract-probes-v1`；独立标记为 `weibo.search.json` 和 `weibo.comments.json`。现存标记（包括失败、未知、未完成、软链接）阻止重购，文件与父目录均在派发前 fsync；不删除、不换目录重跑，也不修改旧通用 probe 的平台数限制。免费 capabilities GET 验证两个 native 授权及 ready；无隐式授权、重试、续页或详情请求。

下面命令捕获私有目标，终端只打印回执与脱敏结构。`--prepare` 是只读内部模式，其 stdout 含原帖 ID，不能脱离封装单独执行后贴回。完整命令可从 zsh 或 bash 粘贴执行；输入 Key 不回显。任何错误都保留全部标记并贴回输出，不自行重采。

```bash
bash <<'BASH'
set -euo pipefail
cd /root/mx/workspace/de-llaaddddeerr/electron-dock/mx-insight-hub
test -f server/ops/probe-weibo-comments.mjs || {
  printf '%s\n' '请先同步 server/ops/probe-weibo-comments.mjs 和更新后的 inspect-post-comment-contract.mjs，无需部署。'
  exit 1
}
read -r -s -p 'Hub Live API Key: ' MX_HUB_PROBE_API_KEY </dev/tty
printf '\n'
export MX_HUB_PROBE_API_KEY
node --input-type=module <<'NODE'
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { runWeiboSearchProbe, runWeiboCommentProbe } from './server/ops/probe-weibo-comments.mjs';
const reasons = new Set(['invalid_arguments', 'api_key_required', 'invalid_api_key',
  'database_url_required', 'invalid_sample', 'source_receipt_unverified', 'source_read_failed',
  'invalid_search_response', 'no_positive_comment_target', 'search_not_completed', 'comments_not_completed']);
function admin(file, args) {
  try {
    return JSON.parse(execFileSync('kubectl', [
      '-n', 'mx-insight-hub', 'exec', '-i', 'deployment/mx-insight-hub-admin', '-c', 'admin', '--',
      'node', '--input-type=module', '-', ...args
    ], { input: readFileSync(file, 'utf8'), encoding: 'utf8', timeout: 30000,
      maxBuffer: 2 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }));
  } catch (error) {
    let reason = 'source_read_failed';
    for (const line of String(error.stderr ?? '').split('\n')) {
      try { const code = JSON.parse(line).error; if (reasons.has(code)) reason = code; } catch {}
    }
    throw new Error(reason);
  }
}
const input = { sampleDirectory: process.cwd(), apiKey: process.env.MX_HUB_PROBE_API_KEY, apply: true };
try {
  const search = await runWeiboSearchProbe(input);
  console.log(JSON.stringify(search, null, 2));
  if (search.state !== 'http_response' || search.httpStatus !== 200
    || search.requestIdSource !== 'usage_header') {
    if (search.requestId) console.log(JSON.stringify(admin('server/ops/inspect-post-comment-contract.mjs',
      ['--request-id', search.requestId]), null, 2));
    throw new Error('search_not_completed');
  }
  const sample = admin('server/ops/probe-weibo-comments.mjs',
    ['--prepare', search.requestId, search.idempotencyKey]);
  console.log(JSON.stringify({ revision: 'weibo-comment-search-selection.v1',
    sourceRequestId: sample.sourceRequestId, archiveVerified: true,
    searchItemCount: sample.searchItemCount, positiveCandidateCount: sample.candidateCount,
    positiveCommentTargetSelected: true, supplierHttpCallsMade: 0, databaseWritesMade: 0 }, null, 2));
  const comments = await runWeiboCommentProbe({ ...input, sample });
  console.log(JSON.stringify(comments, null, 2));
  if (comments.requestId) console.log(JSON.stringify(admin('server/ops/inspect-post-comment-contract.mjs',
    ['--request-id', comments.requestId]), null, 2));
  if (comments.state !== 'http_response' || comments.httpStatus !== 200
    || comments.requestIdSource !== 'usage_header') throw new Error('comments_not_completed');
} catch (error) {
  console.error(JSON.stringify({ error: reasons.has(error.message) ? error.message : 'weibo_calibration_stopped',
    action: 'preserve_all_markers_and_report_output' }));
  process.exitCode = 1;
}
NODE
BASH
```

本地验证：新批次测试 19 项、通用归档检查 26 项、快手归档回归 12 项，共 57 项通过；均为模拟 HTTP/数据库与临时文件，无真实采购。Bash 封装、内嵌 Node 与新模块语法通过。当前未执行上述生产命令；后续仍需真实微博评论字段验证、运行投影接入、发布及统一入口验收，不能把原生采样准备当作迁移完成。微博统一配方仍是 JustOne；没有变更数据库模式、权限、计费设置或 MX-H2I 登录/联网。


## 微博搜索已成功但未选出目标，只读检查本次归档

2026-11-02 操作者回传搜索 usage `15fc7955-8bcb-4b01-9618-d23c56ff64b6`、幂等键 `weibo-comment-search-v1-26c05d64-a345-4cfa-acb5-fd03e057d252`、body SHA `4f10441915479b94dfd12e55def722e60151e72334d602e8eaf2a97a21fcb927`，HTTP200，随后 `no_positive_comment_target`。依据当时封装和代码，此错误发生在精确 usage、请求快照、唯一成功且已计费搜索 call、完整归档长度/SHA/UTF8/JSON 和 results 数组检查之后；尚未调用评论 POST。结果可能为空、ID 不满足保真要求、计数缺失/全零/格式不支持，不能仅由这个错误区分。

[此前实时搜索已验证全零互动量](kuaishou-weibo-followup-2026-10-15.md) 是相关先例，不能直接推定这次高级搜索也相同。正评论量是我们为选样设置的条件，并非用户授权要求；若本次存在有效 ID 而计数全零或缺失，后续可复用同次搜索的目标，使用已经授权且尚未执行的那一次评论采样，不重复购买搜索。

先同步更新后的 `server/ops/probe-weibo-comments.mjs`（无需部署），执行下面命令。不需要 API Key、不发 HTTP、不改标记或账本；`--inspect-search` 与 `--prepare` 共用完整证据门禁，但允许返回零合格目标的诊断。只输出固定字段的类型/格式分布、选择状态计数，不输出 ID、正文、指标原值或任意字段名。

```bash
bash <<'BASH'
set -euo pipefail
cd /root/mx/workspace/de-llaaddddeerr/electron-dock/mx-insight-hub
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
  node --input-type=module - --inspect-search \
  '15fc7955-8bcb-4b01-9618-d23c56ff64b6' \
  'weibo-comment-search-v1-26c05d64-a345-4cfa-acb5-fd03e057d252' \
  < server/ops/probe-weibo-comments.mjs
BASH

```

`--prepare` 仍为私有 stdout，不能单独打印贴回；不要重跑上一节的付费封装，也不要删除 `weibo.search.json`。本地 26 项 probe/诊断测试通过，包括原采购次数、标记和归档边界回归；无真实 HTTP/生产查询。等待上面诊断回传，当前未放宽运行选择器、未切换微博统一路由。


## 微博八条搜索结果均为零计数，复用首条采样一次评论

2026-11-02 操作者回传 `weibo-comment-search-inspection.v1`：usage `15fc7955-8bcb-4b01-9618-d23c56ff64b6` 的 8130 字节归档完整验证通过，8 条结果都是对象，8 个 `weibo_id` 均为有效字符串，8 个 `interaction.comment_count` 均为安全整数 0，没有缺失或不识别的所选计数。不是 Hub 漏掉正数字段的证据，也不证明帖子现在没有评论。

本轮继续用户已授权且尚未消耗的那一次评论请求。新增私有 `--prepare-zero-count` 模式，复用同一精确 usage/call/完整 SHA 校验，要求整页非空、每个所选 ID 有效、每个所选计数为零，然后固定使用保存顺序的第一条。输出 sample v2，`selectionBasis=verified_zero_count_search`、`commentCount=0`，不伪造正数；原 v1 的正数选样条件不变。仅采一页 `count=20`，空页/拒绝/未知也停止，不换目标、不续页、不重试或重新搜索。

同步更新后的 `server/ops/probe-weibo-comments.mjs`，保留上一轮已同步的 `inspect-post-comment-contract.mjs`，无需重新部署。下面命令仍使用相同目录的 `weibo.comments.json`，先检查已有标记，再只读准备私有目标，免费能力预检通过后最多一个评论 POST，最后读取同一次调用归档。保留全部旧 marker；私有目标只在进程内传递，不在终端输出。

```bash
bash <<'BASH'
set -euo pipefail
cd /root/mx/workspace/de-llaaddddeerr/electron-dock/mx-insight-hub
if [ -e .hub-comment-contract-probes-v1/weibo.comments.json ] ||
   [ -L .hub-comment-contract-probes-v1/weibo.comments.json ]; then
  printf '%s\n' '{"state":"already_attempted","hubRequestsMade":0,"action":"preserve_all_markers_and_report_output"}'
  exit 0
fi
read -r -s -p 'Hub Live API Key: ' MX_HUB_PROBE_API_KEY </dev/tty
printf '\n'
export MX_HUB_PROBE_API_KEY
node --input-type=module <<'NODE'
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { runWeiboCommentProbe } from './server/ops/probe-weibo-comments.mjs';
const reasons = new Set(['invalid_arguments', 'api_key_required', 'invalid_api_key',
  'database_url_required', 'invalid_sample', 'source_receipt_unverified', 'source_read_failed',
  'invalid_search_response', 'zero_count_sample_not_allowed', 'comments_not_completed']);
function admin(file, args) {
  try {
    return JSON.parse(execFileSync('kubectl', [
      '-n', 'mx-insight-hub', 'exec', '-i', 'deployment/mx-insight-hub-admin', '-c', 'admin', '--',
      'node', '--input-type=module', '-', ...args
    ], { input: readFileSync(file, 'utf8'), encoding: 'utf8', timeout: 30000,
      maxBuffer: 2 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }));
  } catch (error) {
    let reason = 'source_read_failed';
    for (const line of String(error.stderr ?? '').split('\n')) {
      try { const code = JSON.parse(line).error; if (reasons.has(code)) reason = code; } catch {}
    }
    throw new Error(reason);
  }
}
try {
  const sample = admin('server/ops/probe-weibo-comments.mjs', [
    '--prepare-zero-count', '15fc7955-8bcb-4b01-9618-d23c56ff64b6',
    'weibo-comment-search-v1-26c05d64-a345-4cfa-acb5-fd03e057d252'
  ]);
  console.log(JSON.stringify({ revision: 'weibo-comment-zero-count-selection.v1',
    sourceRequestId: sample.sourceRequestId, archiveVerified: true,
    searchItemCount: sample.searchItemCount, selectionBasis: sample.selectionBasis,
    supplierHttpCallsMade: 0, databaseWritesMade: 0 }, null, 2));
  const comments = await runWeiboCommentProbe({
    sampleDirectory: process.cwd(), apiKey: process.env.MX_HUB_PROBE_API_KEY, apply: true, sample
  });
  console.log(JSON.stringify(comments, null, 2));
  if (comments.requestId) console.log(JSON.stringify(admin('server/ops/inspect-post-comment-contract.mjs',
    ['--request-id', comments.requestId]), null, 2));
  if (comments.state !== 'http_response' || comments.httpStatus !== 200
    || comments.requestIdSource !== 'usage_header') throw new Error('comments_not_completed');
} catch (error) {
  console.error(JSON.stringify({ error: reasons.has(error.message) ? error.message : 'weibo_calibration_stopped',
    action: 'preserve_all_markers_and_report_output' }));
  process.exitCode = 1;
}
NODE
BASH
```

本地验证：整份采样/诊断测试 33 项通过，无跳过，含零计数全页门禁、旧 v1 拒绝零、完整归档验证、v2 类型检查、单次请求与跨版本共用标记并发；Bash/Node 语法及独立审查通过。均为模拟 HTTP/数据库，生产评论尚待执行；未切换微博统一路由，没有运行接口、存储、授权或 MX-H2I 登录/联网变更。


## 微博 22 条主评论归档的全量只读投影验收

本次评论采样已成功：usage `fedbc7e0-e9fa-4fe3-a3e3-5107fcb13849` 的 TikHub `native.t.api_631f7f6fd007cba9` 调用 committed、HTTP/business 200、唯一调用 `billed=true`，完整归档 137665 字节。结构检查显示 `data.data` 有 22 条根评论，嵌套 `comments` 是回复预览；此前只检查了前三条，尚不能把结构抽样当成 22 条全量合同。

新增 `server/contracts/weibo-comment-page.mjs`，使用保存请求的目标 ID 做纯解析：每条根评论要求可保真的 `idstr`、一致的 `mid`/`rootidstr`、作者 `user.idstr`、正文、可解析发布时间和安全互动计数；不安全数字 ID 只作影子字段，不能替代字符串；嵌套预览不投影为根评论。顶层 `max_id` 只有明确空字符串按无更多处理；数值 0、字符串 0、缺失、null、不安全数字或重复值均保守为 unknown/不可继续。官方主评论文档说明首屏 `max_id` 为空、后续使用返回值，但没有证明数值 0 是终态，见 [TikHub 主评论文档](https://docs.tikhub.io/381269409e0)。

同步以下两个文件到服务器，无需部署镜像：

- `server/contracts/weibo-comment-page.mjs`
- `server/ops/inspect-post-comment-contract.mjs`

执行只读全量验收：

```bash
bash <<'BASH'
set -euo pipefail
cd /root/mx/workspace/de-llaaddddeerr/electron-dock/mx-insight-hub
cat server/contracts/weibo-comment-page.mjs server/ops/inspect-post-comment-contract.mjs |   kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin --   node --input-type=module - --request-id   'fedbc7e0-e9fa-4fe3-a3e3-5107fcb13849' --verify-weibo-projection
BASH
```

命令只读取精确 usage、请求快照、唯一成功计费调用和完整归档，输出脱敏的数量、字段覆盖、身份类型和分页状态；不会访问供应商、修改数据库或 marker。把完整输出贴回。若某一行失败，保留当前回执，先修纯解析器再重读同一归档，不重复购买。
