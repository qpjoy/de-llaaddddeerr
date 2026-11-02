# 单帖评论：限定次数的服务器字段校验

日期：2026-11-02。配套脚本只用于核对评论响应字段，不能把成功的 HTTP、官方例子或搜索结果附带评论当成完整迁移验收。

`inspect-post-comment-contract.mjs` 只读 Hub 保存的供应商原始响应，不发 HTTP。`probe-post-comment-contract.mjs` 使用 Hub 已有原生转发入口，各平台只申请一次首屏，不直连供应商。当前固定 Twitter、Reddit、快手三个平台，供本次已经授权的少量付费验证使用。Instagram 已有历史响应可先复用，不追加付费探测。

## 先读已有响应

在同步了脚本的 Hub 项目目录执行；把 UUID 换成需要检查的 Hub 请求 ID：

```bash
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
  node --input-type=module - --request-id af456ad4-2523-4f73-a1fc-c95104b329a4 \
  < server/ops/inspect-post-comment-contract.mjs
```

旧事件若只有 Night-All connector call，没有原生供应商 call，会返回 `nativeCallEvidencePresent:false`。这表示本脚本没有可检查的 Hub 原生归档，不能证明 Night-All 没发过请求，也不能证明评论为空。

输出限定为：固定端点、调用状态、HTTP 状态、计费状态，以及白名单 JSON 字段的路径、类型、数组长度、分页布尔信号和游标是否为空。评论正文、作者、平台帖子/评论 ID、游标值、URL、密钥、未知属性名及错误文本均不输出。每次最多检查 3 个调用，每份原始响应 SQL 侧限制 4 MiB，先核验原始字节长度与 SHA-256，再解析 JSON；每个数组仅取前 3 个元素，深度与节点数有上限。`unknownKeys`、`sampledArrays`、`truncated` 明确说明检查边界。

## 缺少归档时，每个平台只申请一次首屏

在 Hub 所在宿主机运行，目标固定为 `http://127.0.0.1:18150`。脚本需要 Node 22，不需要把供应商密钥交给操作人。`MX_HUB_PROBE_API_KEY` 是 Hub 的测试 Key；应已有 `social` 平台和下面三个原生能力授权，以及可用的现有采购控制。脚本不创建授权、不启用采购、不修改余额或自动切换供应商。

| 平台 | 固定原生能力 | 首屏供应商参数 |
| --- | --- | --- |
| Twitter | `native.j.api_bcedccd1a73cc8f2` | `tweetId` |
| Reddit | `native.j.api_9f1806a48fde0794` | `postId`（`t3_` 前缀） |
| 快手 | `native.j.api_e0c0bbd6b8e0784c` | `videoId` |

以上与本次统一评论实现选用的 JustOne 路由一致。此前有 JustOne 余额不足记录；若返回余额、采购控制或授权拒绝，保留结果，不换路径补买。

从下游现有采样目录读取 `twitter-*.request.json`、`reddit-*.request.json`、`kuaishou-*.request.json`。只接受首屏、明确的平台和一致的帖子标识；正文中 `postId`、`contentId` 或可解析的原文 URL 均可。样本中的 `method`、目标 URL、headers、cursor、params、count 和幂等键都不会作为执行指令使用。若同平台存在不同帖子首屏，报 `ambiguous_sample`，应先选择一个样本目录。

先预览，下面三条命令均不发 HTTP。将样本目录改为服务器上的实际位置：

```bash
node server/ops/probe-post-comment-contract.mjs --sample-dir outputs/hub_comment_samples_20261102/minimal-contentId --platform twitter
node server/ops/probe-post-comment-contract.mjs --sample-dir outputs/hub_comment_samples_20261102/minimal-contentId --platform reddit
node server/ops/probe-post-comment-contract.mjs --sample-dir outputs/hub_comment_samples_20261102/minimal-contentId --platform kuaishou
```

在 Bash 中读入已有 Hub Key，再逐条执行需要的请求；每条最多 1 个 Hub HTTP 请求，三个平台总计最多 3 个。遇到未知结果时先查该请求，不能改幂等键再买：

```bash
read -r -s -p 'Hub API Key: ' MX_HUB_PROBE_API_KEY
export MX_HUB_PROBE_API_KEY
node server/ops/probe-post-comment-contract.mjs --sample-dir outputs/hub_comment_samples_20261102/minimal-contentId --platform twitter --apply
node server/ops/probe-post-comment-contract.mjs --sample-dir outputs/hub_comment_samples_20261102/minimal-contentId --platform reddit --apply
node server/ops/probe-post-comment-contract.mjs --sample-dir outputs/hub_comment_samples_20261102/minimal-contentId --platform kuaishou --apply
unset MX_HUB_PROBE_API_KEY
```

脚本在请求前以独占创建方式写入样本目录下 `.hub-comment-contract-probes-v1/<平台>.json`，权限 `0600`，保存随机幂等键和请求状态，不保存 Key 或帖子标识。相同目录重复执行、并发执行、超时后执行都会因已有标记停止；不要删除标记或换目录绕过本次次数限制。返回结果只包含状态、白名单错误码、Hub requestId 和幂等键，不打印评论响应。该标记是本轮操作预算，不是跨服务器或跨目录的全局配额。

脚本不自动重试、不续页、不跟随重定向；55 秒超时按 `outcome_unknown` 处理，不推定未扣费。Hub 原有 LCY 优先机制可能对**明确未计费**的限流拒绝重试一次，本工具不更改该机制，因此“最多 3 个 Hub 请求”不等于“底层一定只有 3 次 HTTP”。它不会因该机制增加已计费的样本数。

拿到每个平台的 `requestId` 后，逐个运行上面的只读检查，把 probe 简要结果和 inspection JSON 贴回即可。如果 `requestId:null`，保留本地标记中的幂等键进行后台查询，不能因此认定请求未发生。

这轮样本核对不部署 Hub，不修改历史失败响应，不操作 MX-H2I 登录或联网配置。字段映射与分页实现通过测试后仍需发布 Hub，并通过新的幂等键做首次业务验收；旧失败请求的不可变回放保持原结果。
