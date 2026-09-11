# 多平台用户搜索 · 外部实测记录对照

来源：`user_search_interface.md`（2026-09-10，基于 `user_search.py` / `fetch_profiles.py` /
`fetch_dy_search_profiles.py` 与 557 个去重账号的真实返回）。

那份文档描述的是**另一套独立采集脚本**，不是 Hub 的接入。它没有经过 Hub 的授权、配额、幂等、
成本预留或证据归档。本页只记录其中**对 Hub 有效**的部分，以及已经据此做出的改动。

## 已据此修改 Hub

| 发现 | 处理 |
| --- | --- |
| TikHub 的 Cloudflare 拒绝运行时默认 UA（Python 默认报 error 1010） | Node 的 fetch 默认发 `User-Agent: node`，同属未识别的运行时默认。两个适配器现在都发送 `HUB_USER_AGENT`（见 `server/core/outbound-identity.mjs`），如实标识 Hub 而不伪装浏览器 |
| JustOne 业务码 `202` 被描述为「鉴权/令牌无效」 | 与 `justone-ecommerce-collection` 里的「商品不支持此接口」直接冲突，且供应方自己的 usage 页把「Token 无效」归给 `100`、根本没有文档化 `202`。因此 `202` 保持 `unknown`（已经是永不自动重试），不臆测。等供应方给出明确含义再分类 |
| 供应方单价「约 $0.15/次」 | 采纳为临时基线：`seeds/pricebooks/justone.json` 由 5 分改为 **107 分**（¥1.07）。仍不是合同价——原文是约数、写给用户搜索接口、且未说明汇率。拿到合同价后在 Admin 改，不要改 seed 文件 |
| 实测安全间隔 ≥1.2~1.5s（约 40–50 次/分） | 两个供应方的默认速率都下调为 **50 次/分**（原 JustOne 90、TikHub 120），代码默认与部署默认一并调整。这是跨所有 Hub Pod 的共享令牌桶，按实测间隔而非供应方裸容量取值 |

## 尚未处理

暂无。

## 账号搜索的接入状态

`POST /api/v1/data/social/accounts/search` 已上线，**四个平台全部可派发**。授权域 `social`、
业务操作 `social.accounts.search`，落 canonical 数据集 `social.accounts.v1`
（`objectType: profile`，身份 `(platform, userId)`）。

| 平台 | 供应方 | 接口 | endpoint key |
| --- | --- | --- | --- |
| 小红书 · 搜用户 | JustOne | `GET /api/xiaohongshu/search-user/v2` | `xiaohongshu.account-search.v1` |
| 抖音 · 搜用户 | JustOne | `GET /api/douyin/search-user/v2` | `douyin.account-search.v1` |
| 微博 · 搜用户 | TikHub | `GET /api/v1/weibo/web_v2/fetch_user_search` | `weibo.account-search.v1` |
| 快手 · 搜用户 | TikHub | `GET /api/v1/kuaishou/app/search_user_v2` | `kuaishou.account-search.v1` |

**一个 operation，两个 release。** 哪家供应方服务哪个平台在契约里声明一次，路由据此选网关，
控制平面据此拆分 endpoint key。两家各自定价、各自受合同门与熔断约束——一家被阻断不会
让另一家的平台跟着失效。调用方看到的是同一个接口和同一套账号结构，不感知供应方。

实现上没有为第二家供应方复制一份编排：`ExternalPlatformGateway` 本来就只有五处写死了供应方名，
改成构造参数后，TikHub 侧用同一套 plan 驱动流程（同样的授权、配额、幂等、快照、成本预留、
熔断与证据），只是换了 adapter、config 与凭据。

TikHub 的计费方式不变——它用统一单价（`unitCostMinor`），新 endpoint 自动被覆盖，
不需要像 JustOne 那样逐个定价。

还有三个账号详情接口尚未接入（搜索命中后的二次核验用）：

| 平台 | 供应方 | 接口 | 入参 |
| --- | --- | --- | --- |
| 小红书 · 账号详情 | JustOne | `GET /api/xiaohongshu/get-user/v3` | `userId` |
| 微博 · 账号详情 | JustOne | `GET /api/weibo/get-user-detail/v3` | `uid` |
| 抖音 · 账号详情 | TikHub | `GET /api/v1/douyin/web/handler_user_profile_v3` | `uid` |

接入时值得注意的实测坑（原文第 7 节，**搜索接口的这几条已在契约里处理**）：

- 抖音 `business_data[].data.raw_data` 是 **JSON 字符串**，需要二次解析；解析失败或无 `uid` 的条目丢弃。
- 快手返回混合流（内容+作者），同一用户跨条目重复，`user_id` 去重必须做。
- 字段双命名：抖音 `is_verified`/`verified`、快手 `user_eid`/`eid`，两边都要试。
- 粉丝数类型不稳定：快手 `fansCount` 出现过字符串「1.2万」，不要硬转。
- 微博头像 URL 带签名会过期，长期展示需转存。
- 翻到底的判定各平台不同：小红书 `users` 空、抖音 `business_data` 空、微博 `parsed_data.users` 空、
  快手 `mixFeeds` 空。

注意最后这一点与 Hub 现有的分页契约一致：**空结果判定为终止，非空页不足以证明还有下一页**。
这些平台都没有显式的 `hasMore`，因此接入后 `hasMore` 会是 `null`（「上游没有声明」），
翻页靠 `page` 递增到空页为止——和京东修复前的情况相同，不是缺陷。

平台原生层的透传契约（`mx-insight-hub.ecommerce-resource.v1`）正好回避了上面大部分字段坑：
它不重命名、不裁剪，双命名字段和不稳定类型原样交给调用方，由调用方按供应方文档消费。
