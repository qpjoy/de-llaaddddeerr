# Night-All 502 与采集查询复现排查

2026-09-21，针对 Hub requestId `9788c8f2-d59a-455a-8659-12d26bd2172d`。
已收到用户从故障所在 Internal 生产环境取回的 Hub 数据库和健康检查结果。
已取得对应 Night-All 错误日志；其他服务器的健康检查不作为本次事故证据。

## 最新进展：取得完整 400 正文，并修正搜索请求的多余鉴权头

用户部署诊断增强后，在 `2026-09-21T07:02:14Z`（北京时间 15:02:14）再次请求，仍失败：

| 关联项 | 值 |
| --- | --- |
| Hub requestId | `f112872c-3956-4e46-9dfd-a4493cd3552b` |
| Night-All requestId | `req_muawdsbe_a428dd8a` |
| Night-All traceId | `fb0099374bce75419e7742e07d426139` |
| RapidAPI requestId | `07fcd0fe01f3902a463fd7016847c6fd01b9951cf374c9895f074de12d38f93a` |

供应商完整响应为 `{"message":"400, bad request"}`；`bodyTruncated=false`、
`bodyCharacters=31`，不是 Hub 或日志截断掉了更详细的原因。
子进程耗时 `1356ms`，`upstreamCallCount=1`、`proxyFallbackUsed=false`。
重复打印的是同一错误及关联 ID，不代表自动重试了多次。
该响应仍不足以认定查询语法、Key/订阅状态或供应商后端中的哪一项导致 400。

对照 [Twitter AIO 官方 Search 页面](https://rapidapi.com/viperscores-viperscores-default/api/twitter-aio/playground/apiendpoint_602d9730-5aec-48f1-ae31-7020727eb762)
（2026-09-21 读取实际浏览器页面，未点击 Run），确认仍提供 `GET /search/{searchTerm}`，
示例包括 `count=20`、`category=Top`、`includeTimestamp=false`，filters 为可选项。
页面 Authorizations 明确显示无需额外鉴权。
[RapidAPI Auth 文档](https://docs.rapidapi.com/docs/configuring-api-security)
规定使用 `X-RapidAPI-Host` 与 `X-RapidAPI-Key`；不能把 RapidAPI Key 当作独立的 Bearer token。
本地无网络的 Requests 准备请求验证确认：URL 解码后与原检索式完全一致，没有重复编码。

同时发现一个可独立修正的请求构造问题：`unified.py:configure_crawler()` 会向通用 Session
注入 `Authorization: Bearer <api_key>`，Twitter 搜索未覆盖它，最终请求会多带该鉴权头。
现已直接修改 Night-All 工作区中的 `GetCommentByKeywords.py`，在该请求的 headers 中使用
`Authorization: None` 排除 Session 继承头，与同仓库 Facebook RapidAPI 搜索的处理一致。
不修改通用配置器、其他平台、搜索路径、查询语法、分页、代理或重试规则。

新增回归测试走真实 `configure_crawler()`、Requests 的请求准备过程，拦截发送以禁止网络：
修改前因实际请求携带 Bearer 而失败，修改后通过；保留 RapidAPI 鉴权头、traceparent、
Session 配置及代理继承，连同原诊断测试共 8 项通过。
**这是已确认的多余请求头修正，不是已经证明的本次 400 根因或线上恢复。**

下一步：用户提交并同步本次修改，再以原 Hub Key、相同检索式和首屏参数明确发起一次新请求。
若仍为 400，才把 query 单独换为 `Zhejiang` 做一条对照请求；其他参数、凭据和出口保持一致。
简单查询成功则进一步隔离复杂表达式；简单查询也失败则需核对官方 Playground 的同凭据
结果或向供应商提供其 requestId，不能直接归咎于中文/AND，也不要自动换 Key 或循环请求。
这些在线对照可能消耗额度；本次本地工作未发起采集、未访问真实 Key、未部署生产。

## 前序证据：目标隧道与 TLS 已通过

用户随后执行下方目标连接检查，返回：

```json
{
  "proxy": "127.0.0.1:7788",
  "target": "twitter-aio.p.rapidapi.com",
  "ok": true,
  "tls": "TLSv1.2"
}
```

这确认检查当时通过 7788 可建立到 RapidAPI 目标的 CONNECT 隧道，并通过 TLS 证书校验。
结合运行时配置，当前不再需要重复检查 Night-All 是否启动、默认代理是否选中或端口是否监听。
TLS 握手没有发送 HTTP 搜索请求，因此尚未验证 API Key、订阅、查询参数或供应商搜索服务；
也不能由当前状态反推 11:54 的线路状态。`TLSv1.2` 本身不是这次 HTTP 400 的错误证据。

已定位的失败链仍为：目标请求收到 HTTP 400 → Python 失败 → Night-All 502 → Hub 502；
无交付正文导致旧 requestId 的只读复现返回 409。
错误证据增强已直接写入 Night-All 工作区，由用户提交并同步到服务器后，
再从原业务调用入口明确发起一次相同查询。
新查询可能消耗供应商额度；不要自动批量重跑冷启动，或修改查询条件来掩盖原错误。
新请求失败后，取包含 `upstream_error=` 的新日志判断具体原因；成功则证明该次查询恢复，
但不能补写或还原旧请求未保存的错误正文。

## 现场记录：已选中 7788，并验证目标连接

用户在 `2026-09-21T05:40:36.307Z`（北京时间 13:40:36）取得运行时状态：

- `*:7788` 有监听，进程显示为 `mx-internal-egr`，PID `882282`。
  该截断进程名与仓库 Internal egress 的 Mihomo 部署命名一致；仅监听不能证明出站可用。
- 默认配置为 `proxy-1789465000801-nhpumi5n5s` / `7788`，HTTP 与 HTTPS 出口均为
  `http://127.0.0.1:7788/`，配置来源 `/home/fzj/Night-All/config.json`。
- `system` 中的 `7890` 是进程启动时从 sudo 上游继承的环境；当前自定义默认代理覆盖它，
  不能把这个备用基线值当作实际选中的出口。
- 现场 `noProxy` 未包含通配 `*`、`rapidapi.com` 或目标域名。
  用这份名单及注入环境在本地 `requests.Session.merge_environment_settings()` 做无网络验证，
  `https://twitter-aio.p.rapidapi.com` 选中 `http://127.0.0.1:7788`。

以上确认当前配置选择和监听，尚未取得真实出口连通性结果，也不证明 11:54 故障时状态相同。
原日志的 `400 Client Error: Bad Request for url: https://...` 来自 `raise_for_status()`；
普通 HTTP 代理的 CONNECT 被拒绝通常表现为 `ProxyError` / `Tunnel connection failed`。
因此目前证据更偏向 HTTPS HTTP 响应层的拒绝，而不是未配置代理或端口未启动。
确切原因仍取决于未保存的 400 响应正文，不能据此断言代理完全正常或某个查询参数错误。

可在 Night-All 服务器使用采集器同一 Python，验证 **7788 → RapidAPI 域名的 CONNECT 与 TLS**：

```bash
/home/fzj/.conda/envs/nightall/bin/python - <<'PY'
import http.client, json, ssl, requests

target = 'twitter-aio.p.rapidapi.com'
conn = http.client.HTTPSConnection(
    '127.0.0.1', 7788, timeout=10,
    context=ssl.create_default_context(cafile=requests.certs.where()),
)
conn.set_tunnel(target, 443)
report = {'proxy': '127.0.0.1:7788', 'target': target}
try:
    conn.connect()
    report.update(ok=True, tls=conn.sock.version())
except Exception as error:
    report.update(ok=False, error=type(error).__name__, message=str(error)[:400])
finally:
    conn.close()
print(json.dumps(report, ensure_ascii=False, indent=2))
PY
```

该命令只向本机代理发 CONNECT 并与目标进行 TLS 握手，使用 Requests 默认 CA 做证书校验；
不发送目标 HTTP 搜索请求、不读取供应商 Key、不改变系统代理或 MX-H2I 配置。
成功仅证明当前到该域名的隧道及 TLS 可建立；后续仍需 HTTP 错误正文来判断查询失败原因。
失败则根据输出区分 TCP 连接、CONNECT 拒绝、TLS 校验或超时，不先重启共享出口。

## 已完成的代理配置核对与通用出口检查方法

用户补充：Night-All 代理池默认选中 `7788`，地址为 `http://127.0.0.1:7788`，
Twitter 采集需要代理。截图只证明界面所显示的选择，尚不能证明已保存或出口可用。

核对本地 Night-All 源码后的结论：

- `local-crawler-execution-service.js` 中的 `useHttpProxy=false`、`httpProxyConfigured=false`
  是旧的采集器显式代理参数，**不能据此判断子进程实际直连**。
- `lib/domains/crawlers/process-runner.js` 启动子进程前调用
  `proxy-runtime.childEnv()`，注入大小写两套 `HTTP_PROXY`、`HTTPS_PROXY`、
  `ALL_PROXY` 和 `NO_PROXY`。代理池选中的自定义出口会覆盖继承的代理地址。
- `lib/infra/network/proxy-runtime.js` 每次创建子进程读取已保存的 `config.json.proxyPool`；
  自定义 `7788` 出口保存后，下一次子进程应使用它，无需重启。
  若选择的是“系统代理”，使用的是 Node 进程启动时捕获的环境，之后在另一个终端
  `export HTTPS_PROXY=...` 不会改变已经运行的 Node 进程。
- Twitter 使用 `requests.Session()`，未关闭 `trust_env`，会读取这些环境变量。
  系统 `NO_PROXY` 与界面追加的直连名单合并；包含 `*`、`rapidapi.com` 或目标域名时
  可能绕过代理。因此只看到默认代理地址仍不够。
- 此处的 `127.0.0.1:7788` 是 **Night-All 所在网络命名空间** 的回环地址，
  不是打开控制台的个人电脑，也不是自动指向 Hub 的代理设置。

先在实际 Night-All 服务器执行以下两段，只输出监听信息和运行中服务返回的代理状态：

```bash
ss -ltnp '( sport = :7788 )'

curl --noproxy '*' --connect-timeout 3 --max-time 10 -fsS \
  http://127.0.0.1:13141/api/v1/config |
node -e '
let s = "";
process.stdin.on("data", c => s += c);
process.stdin.on("end", () => {
  try {
    const p = JSON.parse(s).data?.proxyRuntime;
    if (!p) throw new Error();
    console.log(JSON.stringify(p, null, 2));
  } catch { console.error("未取得 proxyRuntime；请保留 curl 错误并核对服务器版本。"); process.exitCode = 1; }
});'
```

然后点击截图中的“检测已保存的默认出口”，或者执行同一个检测接口：

```bash
curl --noproxy '*' --connect-timeout 3 --max-time 35 -fsS \
  -X POST http://127.0.0.1:13141/api/v1/config/proxy/test
```

该检测会访问已保存的检测 URL（截图为 Google `generate_204`），不调用 Twitter 搜索、
不更改配置、不重试旧采集。Google 检测成功只能证明当前通用出口可用，不能证明
当次 RapidAPI 请求的线路或参数正确。无监听、未保存的选择、直连名单命中，应先分别定位。
若当前代理检查正常而新的明确触发查询仍返回 400，使用下方已实现的错误证据增强定位。
本地已有代理测试中，系统/自定义/直连选择、NO_PROXY、子进程动态注入的 3 项测试通过；
这些测试不代表生产代理已通过检测。

## 已实现：Night-All HTTP 错误证据增强

13:30:10 北京时间再次运行 Hub 查询，旧 request/connector 记录未变化、当前健康接口仍为 200。
这不是一次新的采集或恢复验证，无需继续重复查询该旧 requestId。

按用户要求，已直接修改 `/Users/qpjoy/workspace/mingxi/Night-All` 工作区：

- `crawlers/twitter/rapid/GetCommentByKeywords.py`：补充错误诊断。
- `tests/test_twitter_rapid_search_errors.py`：对应的离线回归测试。

具体行为：

- HTTP 失败时，把经过凭据脱敏的供应商错误正文和供应商 request ID 加入现有异常信息。
- 错误正文展示最多 1200 字符，并明确记录是否截断及脱敏后的字符数；成功业务响应保持原样。
- 保留 `requests.HTTPError` 及其 response/request 引用、现有 HTTP 状态包装和重试策略。
- 诊断格式化失败时仍抛出原类型的 HTTP 失败，不把供应商失败变成成功或新的重试。
- 仅修改本机工作区，交由用户提交；没有部署生产或发起在线采集。

用户提交并同步该版本到服务器后，当前调用方式每次新建 Python 子进程并加载采集文件，
故下一次调用即可读取修改，
不需要重启 Night-All、Hub、Launcher 或修改 MX-H2I 登录/网络。
同步代码本身不调用供应商，也不会更新历史失败记录。

在修改后的 Night-All 工作区已通过 7 项离线测试：
400 错误正文和关联 ID、成功响应及请求参数不变、嵌套凭据/Key 回显脱敏、
纯文本凭据脱敏、超长错误正文、500 不增加重试、诊断失败仍保留 HTTPError。
测试会禁止真实网络调用。在 Night-All 根目录执行：

```bash
python3 -B -m unittest discover -s tests -p 'test_twitter_rapid_search_errors.py' -v
```

此次改动增强诊断，尚未修复供应商 400 的未知根因。只有明确触发的新查询才能验证当前供应商状态，
该查询可能消耗供应商额度；不要自动重跑整套冷启动或换 Key。
若新查询失败，按其新的上游 requestId 查日志，新增 `upstream_error=` 中将含具体错误正文。
不要继续只检索旧的 `req_muapnr70_b4eed30b`，旧日志不会补写。

## 已定位：RapidAPI HTTP 400 被包装为 Hub HTTP 502

用户随后提供实际 Night-All `/home/fzj/Night-All/logs/api.log` 第 399–402 行。
运行进程的工作目录为 `/home/fzj/Night-All`，stdout/stderr 均写入该日志。
以下结论由当次错误行直接支持：

1. `03:54:00.727Z`，Night-All 启动 Twitter `search_posts`，provider 为 `rapidapi`，
   使用 `/home/fzj/.conda/envs/nightall/bin/python`，第 1 页、20 条。
2. Python 成功执行到 HTTP 请求，目标是 `twitter-aio.p.rapidapi.com`。
   对该目标的请求收到 `400 Client Error: Bad Request`；尚未保存响应正文与响应头。
3. `03:54:03.012Z`，采集器 `exitCode=1`、`killed=false`、耗时 `2279ms`；
   配置超时为 `180000ms`，本次不是子进程超时或 Python 可执行文件缺失。
   记录 `upstreamCallCount=1`、`proxyFallbackUsed=false`。
   stderr 中重复的异常文字不是多次供应商 dispatch 的证明。
4. Night-All 将子进程失败包装为 `502 CRAWLER_COMMAND_FAILED`；
   `http_request_failed` / `http_request` 持有
   `req_muapnr70_b4eed30b`，在 `03:54:03.031Z` 返回 502。
5. Hub 收到该 502，记录 `night_all_http_502` 并释放本次 reservation，
   对调用方返回 `502 night_all_rejected`。没有交付正文，因此旧 requestId 复现返回 409。

实际供应商请求（检索式为 URL 解码后的形式）：

```text
GET https://twitter-aio.p.rapidapi.com/search/(浙江 OR Zhejiang OR Hangzhou OR Ningbo OR Wenzhou) AND update
query: count=20&category=Top&includeTimestamp=false
```

据此可以排除“本次因为 Night-All 未启动或 Hub 连不到它的端口”。
也没有证据支持通过修改 MX-H2I 登录、Launcher 网络或放行 Night-All 入站端口修复此错误。
当前尚未确定的是 **对 RapidAPI 目标的请求为什么收到 400**；
需结合实际出口及响应正文判断，不能仅凭目标 URL 排除代理链路的影响。

### 400 的具体原因仍缺供应商错误正文

`crawlers/twitter/rapid/GetCommentByKeywords.py` 的 `_request_search()` 先执行
`response.raise_for_status()`，之后才 `response.json()`；400 会在 JSON 读取前抛出。
异常处理仅打印异常字符串，未读取 `HTTPError.response` 的正文，随后父进程记录 stderr。
因此此次日志没有供应商的 `message/detail/error`，继续搜索同一组日志不能补出未保存的正文。
仅凭 HTTP 400 不能认定 `AND`、中文、`count`、`category` 或供应商账户中的任何一个因素是根因。

进一步验证应先取得供应商侧已保留的当次错误正文（如果有），或者在 Night-All Python
HTTP 错误边界增加经过凭据脱敏的有界错误正文及供应商关联 ID，再进行明确触发的单次验证。
先离线验证错误采集逻辑；新增在线验证会产生新的供应商请求，不能伪装成历史复现。
不要为获取错误正文自动换 Key、切换供应商、修改查询语义或循环重试。

### 独立的采集语义观察

本次发出的供应商 URL 为 `category=Top`，没有 `since:` / `until:`、日期查询参数或 `filters`。
日志不能证明告警中的三天时间窗口已经下推到供应商，也不能排除调用方另外做本地时间过滤。
`includeTimestamp=false` 是独立参数，不能当作时间范围过滤。
应另外核对调用方传入的完整请求及窗口/排序映射，不能把“改成 Latest”或“删除 AND”
作为已经证实的 400 修复。

## 现场证据更新（2026-09-21）

用户说明 Night-All 端口刚开通，并提供以下结果：

| 项目 | 实际记录 |
| --- | --- |
| Hub 调用时间 | `2026-09-21T03:54:00.679Z` 至 `03:54:03.033Z`，北京时间 11:54:00–11:54:03 |
| Hub 请求 | `released`、`night_all_http_502`、无已交付响应 |
| Connector | `failed`、HTTP `502`、`failure_kind=http`、耗时 `2351ms` |
| Night-All requestId | `req_muapnr70_b4eed30b` |
| Night-All traceId | `19e4e311bb87699fb6bbc9622c598124` |
| 当前 Hub 上游地址 | `http://127.0.0.1:13141/` |
| 13:15:44 北京时间健康检查 | HTTP 200、`ok=true`、PostgreSQL/Redis 均已连接 |

按当前代码，Hub 从上游 JSON 错误体中取得 requestId/traceId，Night-All 的请求中间件
生成 `req_<毫秒时间戳的 base36>_<随机值>`。本次 ID 的时间部分还原为
`2026-09-21T03:54:00.684Z`，与 Hub 调用时间吻合。
这些证据强烈支持：当时请求已到达 Night-All 应用，由其返回错误；
不是单纯 Hub 无法连接一个未启动的端口，也不是 Hub 超时分支。
当前运行配置是本机回环地址，若没有转发层且事发时配置相同，外部入站端口放行
不会解释这次调用的 502。尚不清楚用户此次“开通端口”的具体操作及历史配置，
不能由此声称 Twitter/RapidAPI 出站链路也已恢复。

下一步只需在 **实际 Night-All 项目根目录** 查这两个上游关联 ID。
仓库的 `start-node.sh` 将 API 日志写入 `logs/api.log`：

```bash
grep -n -F \
  -e 'req_muapnr70_b4eed30b' \
  -e '19e4e311bb87699fb6bbc9622c598124' \
  logs/api.log
```

贴回匹配到的 `http_request`、`unified_crawler_started`、`unified_crawler_failed`
及同请求的错误行。该采集器的错误日志已按现有代码去除供应商 Key/代理凭据。
若现场没有此文件或没有匹配，不能据此判定 Night-All 未处理请求：可能由
Docker/systemd/其他进程管理器接管 stdout/stderr，或日志已轮转；下一步需要确认其启动方式。
此时也可按下文第二步在 Night-All 数据库查同一 requestId。

## 已确认的错误语义

- `night_all_rejected` 且 `upstreamStatus=502`：Hub 收到了 HTTP 502。
  可能由 Night-All 应用返回，也可能由它前面的代理返回，不能仅凭这个错误判断服务未启动。
- Hub 直连未启动的 Night-All、连接失败或等待超时，走
  `UpstreamAmbiguousError` → `upstream_outcome_unknown`，不会走本次的明确 HTTP 拒绝分支。
  如果 Night-All 前面仍有运行中的反向代理，后端未启动则仍可能表现为本次的 502。
- 未交付的请求不能从“复现已交付结果”获得成功响应。该 GET 只读历史；
  `acquisition_query_run_unavailable` 是 409，表示请求存在，但不满足
  `status=committed` 且 `response_body IS NOT NULL`，不是再次采集失败。
- 截图中的 `d660d16d-67f6-478d-84cd-bf15c6b025c4` 是本次复现 GET 的关联 ID，
  原采集请求仍为 `9788c8f2-...`。即使上游恢复，原失败请求也不会自动拥有交付结果。
- 对此明确 502 且无可用精确快照的代码路径，Hub 将 request 标为 `released`、
  error code 记为 `night_all_http_502`，connector call 标为 `failed`；本次现场记录已经吻合。

代码位置：
[适配器](../../server/adapters/night-all.mjs)、
[错误与请求结算](../../server/hub-service.mjs)、
[历史交付断言](../../server/acquisitions/history-store.mjs)、
[HTTP 关联 ID](../../server/app.mjs)。

## Twitter 分支与证据缺口

所提供的 Night-All 源码中，`providers/provider-registry.js` 默认把 Twitter 路由到 RapidAPI。
`raw-search-service.js` 经本地 Python 采集器执行搜索；
`local-crawler-execution-service.js` 把子进程失败包装成 `502 CRAWLER_COMMAND_FAILED`。
Python 路径/依赖、代理/TLS/网络、供应商 HTTP 错误等都要结合当次 stderr 判断，不能直接定性。
该 raw 路径在 API 进程中执行子进程；单凭队列 worker 未运行不能解释这个同步请求的 502。
实际服务器版本、路由和错误细节尚未核实。

Hub 的失败 connector evidence 保存 HTTP 状态、耗时、上游 requestId/traceId，
但 `compatibilityUpstreamEvidence()` 将错误码归并为 `night_all_http_502`，
当前失败路径没有把 Night-All 原始错误体完整写入该记录。
Admin 复现又在读取调用证据前拒绝未交付请求，因此这张复现页无法展示失败根因。
需要从 Hub 找到上游关联 ID，再查 Night-All 的 `data_api_requests` 和 `unified_crawler_failed` 日志。
Hub UUID 不会作为 `x-request-id` 传给 Night-All，不能只在 Night-All 日志里搜索 Hub UUID。

## 第一步：在故障所在服务器执行只读取证

下面使用仓库标准 K8s namespace/deployment/container 名。任意目录执行，
不需要更新镜像或部署；只启动临时诊断进程，不重启服务。
数据库连接强制只读并限制查询时间；只查目标请求，不读取请求/响应正文或密钥。
唯一 HTTP 调用是使用 Hub 现有配置读取 Night-All `/api/v1/health`，不会采集数据。

```bash
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-public -c api -- node --input-type=module <<'NODE'
import pg from 'pg';
const requestId = '9788c8f2-d59a-455a-8659-12d26bd2172d';
const report = { checkedAt: new Date().toISOString(), requestId };
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
  connectionTimeoutMillis: 5000,
  options: '-c default_transaction_read_only=on -c statement_timeout=5000',
});
try {
  report.request = (await pool.query(`
    SELECT id, platform, status, error_code, response_status,
           response_body IS NOT NULL AS has_delivered_body,
           reserved_at, completed_at
    FROM public.usage_requests WHERE id = $1`, [requestId])).rows;
  report.connectorCalls = (await pool.query(`
    SELECT operation, platform, outcome, http_status, failure_kind,
           error_code, upstream_latency_ms, upstream_request_id,
           upstream_trace_id, started_at, completed_at
    FROM serving.connector_calls WHERE usage_request_id = $1
    ORDER BY started_at LIMIT 20`, [requestId])).rows;
} catch (error) {
  report.databaseError = { name: error.name, code: error.code || null };
} finally {
  await pool.end();
}
try {
  const base = process.env.NIGHT_ALL_BASE_URL || 'http://127.0.0.1:13141';
  const url = new URL(base);
  report.nightAllBase = url.origin + url.pathname;
  const response = await fetch(base.replace(/\/$/, '') + '/api/v1/health', {
    headers: process.env.NIGHT_ALL_SERVICE_TOKEN
      ? { authorization: `Bearer ${process.env.NIGHT_ALL_SERVICE_TOKEN}` } : {},
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  });
  report.healthNow = { httpStatus: response.status,
    contentType: response.headers.get('content-type') };
  if (report.healthNow.contentType?.includes('application/json')) {
    const body = await response.json();
    report.healthNow.ok = body.data?.ok ?? null;
    report.healthNow.databaseConnected = body.data?.database?.health?.connected ?? null;
    report.healthNow.redisConnected = body.data?.redis?.health?.connected ?? null;
  } else {
    await response.body?.cancel();
  }
} catch (error) {
  report.healthError = { name: error.name, code: error.cause?.code || error.code || null };
}
console.log(JSON.stringify(report, null, 2));
NODE
```

把这段 JSON 输出贴回即可。`request: []` 应先核对环境/数据库，不要换请求猜测。
`upstream_request_id` / `upstream_trace_id` 非空可用于定位 Night-All 记录；
为空只表示没有保存到关联值，不能单独证明是代理故障。
`healthNow` 仅表示执行命令时的状态，不证明故障时的状态。
告警里的三天时间窗口是检索范围，查日志应使用 `started_at` / `completed_at`。

## 第二步：沿上游 ID 查 Night-All

取得第一步结果后，在 Night-All 对应数据库只读查询 `data_api_requests` 的
`request_id, endpoint, platform, provider, status, http_status, error_code,
error_message, duration_ms, created_at, finished_at`，按已取得的 **上游** request ID 精确过滤。
若记录为 `CRAWLER_COMMAND_FAILED`，继续查看同一 ID 的 `unified_crawler_failed` 日志，
重点看 `details.stderrTail`、`exitCode`、`killed`、`proxyFallbackUsed`。
若上游 ID 缺失，则按 Hub 的真实调用时间，核对目标地址对应代理的 access/error log 与
Night-All 服务启动时间。只有这些现场记录才能确认“当时没有启动”。

不要通过点击新请求对比、重跑冷启动采集或换 Idempotency-Key 来做连通性诊断；
这些动作可能产生新的真实供应商请求，且不能解释旧请求为何失败。

## 本次验证范围

本地已有 adapter、compatibility、acquisition-history 测试共 47 项：46 通过，
1 项 PostgreSQL 集成测试跳过。未触发真实采集，未改动 Hub 业务代码、
MX-H2I 登录、Launcher 网络、路由、代理或生产服务配置。
