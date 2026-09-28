# Hub 独立社媒接口

日期：2026-09-28。阶段：独立接口第一批实现，默认禁用；尚未部署、未做付费上游验收。后续覆盖完成才由下游切换。

## 路径与隔离

原有两组 `/api/v1/search/{raw,crawl,user-info}` 与 `/api/v1/night-all/search/{raw,crawl,user-info}` 是同一兼容服务的别名。另有 `/api/v1/data/search` 提供统一搜索展示合同；本批不替换这三种入口，不迁移其游标或历史交付。MX-H2I/Launcher 登录与联网没有改动。

| 新接口（POST） | 当前平台 | 独立权限 | 第一批范围 |
| --- | --- | --- | --- |
| `/api/v1/data/social/search` | twitter（x 为同义值） | `social.content.search` | 一个关键词/表达式、一页内容、latest/top |
| `/api/v1/data/social/crawl` | twitter | `social.content.crawl` | 一个用户名或 ID 的一页时间线，含原时间线转推 |
| `/api/v1/data/social/user-info` | twitter | `social.profile.get` | 一个用户名或 ID 的基础资料，不补 about |

均要求 Live Key 同时具有 `twitter` 平台和对应操作权限。新 Key 权限不由旧 Twitter 授权推导；目录可见、代码实现、配置启用和实际健康分别判断。请求及响应字段以运行时 OpenAPI 为准；管理台“社媒与内容数据”的接口调试复用同一 OpenAPI。

链路：调用方 → Hub 路由/权限/预留/执行治理 → Node HTTP → RapidAPI 的 `twitter-aio.p.rapidapi.com`。固定 Host 和端点，客户端不可传 provider、URL、凭据、代理或采集预算。一次请求最多一次带采集凭据的业务 HTTP 调用；配置代理时，之前另有不带凭据的连通性探测。不启动 Python，无业务请求自动重试、补页、补资料或 Night-All/TikHub/JustOne 回退。少一层应用与进程启动不保证消除上游延迟，更不会自行修复供应商 HTTP 400。

## 请求与分页

```http
POST /api/v1/data/social/search
Authorization: Bearer <HUB_API_KEY>
Idempotency-Key: social-twitter-first-001
Content-Type: application/json

{"platform":"twitter","query":"AI feature update","count":20,"sort":"latest"}
```

账号内容传 `{"platform":"twitter","username":"example","count":20}`；基础资料传 `{"platform":"twitter","userId":"42"}`。username 与 ID 二选一，ID 必须为字符串。`keyword` 与 `query` 同义；`userId/user_id/uid` 同义；`count/pageSize/limit` 同义，同时提交必须一致。默认一页 20、最多 50，仍受 Key 更低上限约束。资料只允许单账号，不接受分页参数。

外层为 `{contractVersion, data, meta, requestId}`；`data` 含：

- `items`：统一帖子或账号列表。Twitter 内容没有标题，title 为 null，正文保留 note_tweet 完整文本；未知指标为 null，已知零值保留 0。
- `raw_info`、`raw_data`：JSON 字符串形式的迁移辅助投影，**不是 Night-All 完整兼容输出**。时间为 ISO 字符串，不承诺旧秒时间戳/字段集合；原始供应商全部字段保存在受限证据中，不混入公共 items。
- `page` / `pageInfo`：本页返回量、去重/丢弃数、nextCursor 与 hasMore，不宣称总量。无法解析的条目导致 partial，整体错误/未知结构不伪装成功空列表。
- `meta.upstreamCallCount=1`；资料 `profileCompleteness=base_profile_without_about`。时间线响应没有资料时 raw_info 可以为空。

仅接收本新接口生成的加密游标，绑定 Key、调用者、操作、查询/账号、排序和 count，整轮 24 小时、最多 15 页；重复游标、空页、超长游标停止。旧游标不可混用。下一页用新 Idempotency-Key，同页重试沿用原标识与请求体；持久化成功或失败的同一标识不再次采购。429/5xx/超时及已接受但不可用的结果不会自动改供应商或重新请求。

## 与聚合数据搜索的关系

复用现有三接口：

```http
GET /api/v1/data/aggregate/sources?execution=hub_only
POST /api/v1/data/aggregate/preview
POST /api/v1/data/aggregate/search

{"query":"AI feature update","mode":"refresh","execution":"hub_only","platforms":["twitter"],"objectTypes":["post"]}
```

`hub_only` 是执行方式，不是供应商选择。当前只登记 Twitter 的新 search 操作，每个子来源获取一页 20 条；preview 只读，不采购。搜索与聚合调用共用供应商治理和计费执行器；子请求使用新操作计量，聚合父请求不额外收取采购费。聚合分页继续传 execution 及原条件；不能将旧轮次游标转成新轮次。省略 execution 保持原聚合行为；未覆盖来源显式 unsupported，不转发 Night-All。

这能覆盖关键词内容搜索的入口与编排，不能代替账号 crawl 或 user-info。后续每个平台需要固定的请求、响应、分页、计量适配才能加入聚合；供应商目录里有接口不代表已具备统一搜索能力。新 Twitter 结果本批只做交付快照和受限原始证据归档，**尚未进入 canonical/已收录数据索引**；已有索引查询仍按原逻辑运行。

## 配置与验收

1. 在 Hub 数据库执行常规迁移至 116。新增三操作均为 disabled，不改已有 grants、Key、客户价格或余额。116 只扩展采购草稿供应商类型及增加操作登记。
2. Admin 外部数据平台新增 RapidAPI；使用现有凭据存储、二次验证揭示、操作策略及审计。可选环境变量 `MX_INSIGHT_RAPIDAPI_API_KEY`；不要将凭据写入调用请求或共享日志。
3. 为 `twitter-aio.search`、`twitter-aio.crawl`、`twitter-aio.user-info` 分别审核采购价格、币种及预算。没有已验证官方价格，不自动猜价格；预算估算不等于实际扣费。支持现有采购草稿/批量开通流程。
4. 给指定消费者/Key 显式授予平台与新能力、发布客户价格；先使用 canary，仅对选定调用者启用。平台控制仍检查价格证据、费用预留、并发/速率、熔断及凭据版本。
5. 由操作者授权真实调用后验证三接口的首次/续页、同标识回放、空结果、账号不存在、400/429/5xx/超时与采购对账。保留 Hub requestId、供应商 requestId、HTTP 状态、业务 code。公共错误只展示允许的状态/code，不回显上游原始错误正文或 Key。

所有本地测试均使用合成响应，不能证明当前供应商已接受这些参数。此前两次 twitter-aio 400 仍需用实际请求参数和供应商成功样本定位，直接搬迁不会修复这一事实。

## 完全覆盖前的剩余能力

| 项目 | 当前状态 / 下一步 |
| --- | --- |
| Twitter 三个基本单页操作 | 本地实现；待真实合同与逐字段样本验收 |
| Night-All raw 完整旧字段、时间/排序/筛选语义 | 新合同明确差异，不能宣称 URL 无感替换；建立逐形状黄金样本 |
| Twitter about、多账号、最早帖子/历史时间窗、分块/任务续跑 | 尚未迁入；另建明确预算和子调用证据，禁止隐藏补采 |
| 其它平台 raw/crawl/user-info | 尚未接入新三接口；可复用 Hub 已有固定供应商合同，但需各平台投影、身份和游标适配 |
| 全量原始证据 → canonical 数据集/ETL/索引 | 已有证据归档；新社媒投影、异步导入及查询可见性尚待实现 |
| 自建工具/爬虫、SearXNG | 后续执行器/数据产品分类，不当作 RapidAPI 同类接口；必要时保留独立采集运行时 |
| 下游切换与 Night-All 下线 | 未执行；须逐平台/形状通过覆盖矩阵，保留旧调用直到使用情况明确 |

目录按“业务平台/数据集 → 数据产品能力 → 执行适配器 → 渠道与具体服务/Host/版本”分别登记。外部 API、自建工具、爬虫和存储数据都可成为产品来源，但授权域、逻辑平台、供应商与实体目录 ID 不应混为一项。

## 本地验证记录

- 服务端全量回归：2111 通过、0 失败、32 按环境条件跳过；最后的解析边界修改经相关 86 项回归验证，新社媒专项最终 10 项通过（含独立费用计量和聚合不重复扣费）。
- TypeScript 类型检查、生产构建、能力目录一致性和 diff 空白检查通过。
- 迁移 116 在临时 PGlite/PostgreSQL WASM 中执行与重入通过：三操作默认 disabled，保留已有操作及人工 paused 状态，不重复新增审计事件，采购草稿接受 RapidAPI。此验证不替代真实数据库环境验收。
- 没有访问 Internal、生产数据库、服务器 tmux 或真实付费供应商接口；未执行部署、生产迁移、授权变更或下游切换。

## RapidAPI 凭据迁移与系统代理（2026-09-28 后续）

已核对本机 Night-All `config.json` 的 `crawlerProviders.rapidapi.apiKey` 非空且该供应商 enabled；不展示 Key。服务器的实际值由操作者在服务器核对，不能把本机配置视为服务器运行环境的证明。Night-All 的读取顺序为：

1. `config.json → crawlerProviders.rapidapi.apiKey`。
2. 运行环境 `RAPIDAPI_KEY` / `RAPID_API_KEY` / `TWITTER_RAPIDAPI_KEY`。
3. 旧 `data/news-config.json → twitterDaily.apiKey`。

Hub 增加 `npm run migrate:rapidapi-credential`，复用已有受限迁移工具。只向 loopback Hub Admin API 写 `rapidapi` 的数据库凭据，不调用供应商，不启用操作，不改源文件。原 `--all` 仍只迁移 TikHub/JustOne，RapidAPI 必须显式选中。若 Hub 已有数据库凭据默认拒绝覆盖；有意替换才设 `MX_INSIGHT_RAPIDAPI_MIGRATION_REPLACE=1`。前置检查失败不会写入，保存通过修订号保护并发修改。输出只有状态、修订号和凭据的短哈希摘要。

部署代码并按现有部署流程迁移至 **117** 后，在可访问 Hub Admin 的服务器、Hub 项目根目录运行下面的 Bash 命令。18151 是工具默认 Admin 本机端口，按实际监听端口修改。源路径采用已确认的服务器目录 `/home/fzj/Night-All`。示例复制到 0600 临时文件，不修改 Night-All 原配置或权限；如 Key 实际来自 tmux 环境，应在同一环境运行，或先安全注入对应环境变量，不能粘贴进命令行参数。

```bash
bash <<'SH'
set -eu
umask 077
migration_dir=$(mktemp -d)
trap 'rm -f "$migration_dir/config.json" "$migration_dir/news-config.json"; rmdir "$migration_dir"' EXIT
install -m 600 /home/fzj/Night-All/config.json "$migration_dir/config.json"
if [ -f /home/fzj/Night-All/data/news-config.json ]; then
  install -m 600 /home/fzj/Night-All/data/news-config.json "$migration_dir/news-config.json"
fi
export NIGHT_ALL_CONFIG_PATH="$migration_dir/config.json"
export NIGHT_ALL_NEWS_CONFIG_PATH="$migration_dir/news-config.json"
export MX_INSIGHT_ADMIN_BASE_URL=http://127.0.0.1:18151
read -r -s -p 'Hub Admin Token: ' MX_INSIGHT_ADMIN_TOKEN </dev/tty
printf '\n'
export MX_INSIGHT_ADMIN_TOKEN
MX_INSIGHT_EXTERNAL_CREDENTIAL_MIGRATION_DRY_RUN=1 npm run migrate:rapidapi-credential
npm run migrate:rapidapi-credential
SH
```

迁移后进入 **上游供应商 → RapidAPI → 凭据管理**，可保存新 Key；“查看”需再次输入 Admin Token。普通供应商详情、日志、Launcher 管理会话和租户 API 不返回 Key。数据库存储沿用现有供应商凭据表及受限访问，不能声称新增了应用层静态加密。环境变量来源只显示配置状态，复制为数据库来源后才可通过该查看入口揭示。

同页新增 **RapidAPI 出网代理**：继承 System Proxy 全局配置、指定 Proxy Sequence、直接出网三种模式；支持探测超时/次数/缓存覆盖和最近失败记录。保存后下一次请求生效，不重启或修改系统代理服务。117 默认直接出网以保持第一批行为，不能因迁移而绑定 TikHub 的代理。

代理探测只访问固定 `https://twitter-aio.p.rapidapi.com/`，不带 RapidAPI Key。出口选定后业务请求只派发一次；HTTP 400/429/5xx 或超时不切代理重发。出口探测全部失败会返回 `social_egress_unavailable`，记录为业务未派发、未产生该业务调用的供应商扣费；这不代表供应商搜索功能或订阅已验收。公共错误不暴露代理地址与凭据。代理绑定/审计/失败记录均按供应商隔离，删除仍被供应商绑定的序列会被阻止。

### 原三个接口如何决定搜哪些平台

本次管理增强验证：服务端 2118 通过、0 失败、32 按环境条件跳过；类型检查和构建通过。迁移 117 及真实 SQL 代理存储逻辑经临时 PostgreSQL WASM 验证（重复迁移、修订冲突、序列选择、TikHub 状态保持）。仍未在服务器执行凭据迁移或真实供应商采集。

Night-All 的 `raw`、`crawl`、`user-info` 都要求显式 `platform` 或 `platforms`，缺少时分别报 `SEARCH_PLATFORM_REQUIRED`、`CRAWL_PLATFORM_REQUIRED`、`USER_INFO_PLATFORM_REQUIRED`。raw 还需 query/keyword；crawl 和 user-info 则需账号标识。平台先确定，再按平台/操作选择供应商、参数映射和解析实现。Twitter 默认 RapidAPI；部分其它平台按操作采用 TikHub 或 JustOne，不应仅靠全局默认值推断所有操作。

Night-All 原生批量 raw 会展开指定的“平台 × 关键词”组合；不是猜测关键词属于哪个平台。Hub 现有兼容入口要求一个显式平台，且不让下游指定供应商；Hub 聚合搜索才负责按已授权范围跨平台展开。新三个社媒入口同样按传入 platform 适配，当前仅 Twitter；后续补充平台时保留同一路径及业务参数原则。
