> 2026-10-18 最新账号方案：企业超管继续统一 MX 登录，员工子账号由数港独立创建、认证和重置。发布顺序改为 **Hub（migration 159）→ DataPort**，不需要为本轮部署 Launcher/Auth 或配置旧专用账号 Secret。保留既有 MX 登录配置和所有旧密钥；旧托管子账号可通过超管重置显式转为独立登录。部署及验收见[数港独立子账号](docs/local-employee-accounts.md)。此方案替代同日早先的 Auth 账号桥接配置步骤。

## 2026-10-18 底部遮挡修复

在独立子账号基线之后，控制台和公共首页的页脚独占底部区域（至少56px，换行自增），正文随剩余空间伸缩，覆盖原型中固定减56px的高度规则。业务弹窗使用数港自己的共享框架：标题/关闭入口与滚动正文分开，按实际可见视口限制高度；成员详情缩短为资料和操作网格，消息弹窗保留手机两侧边距。原型及 `ui-design` 源文件未修改。

本次仅需 DataPort 前端完整重新构建和发布，无新迁移，不重启 Hub/Auth/Pay。沿用服务器原发布参数执行 `MX_HARBOR_BUILD_PROXY=http://127.0.0.1:7788 bash scripts/manage.sh ops internal-production deploy`；发布前同步 `pro` 并保留服务器既有改动，不执行旧账号 Secret 初始化。

本地 Chrome 用合成数据复核 1440×700、390×500、390×844、320×480；覆盖控制台各页的正文/页脚分离、成员创建/详情/编辑/角色/启停及重置确认、角色权限长表单、Key 创建/替代/撤销确认、订单详情、订阅确认、工单创建/长详情、消息及登录，并核对320px公共首页的页脚换行。合成页面不连接生产，未提交付款、查询或凭证修改。完整原生手机软键盘与生产发布后布局仍需复测；受保护的一次性凭证结果页面尚未覆盖，不能按通用弹窗检查记为通过。构建含类型检查通过，相关无监听依赖测试26项通过；另1项账号诊断测试因环境禁止本机监听（EPERM）未完成。截图与测量在工作区 `screenshot/postdeploy-20261018/`，不进入仓库。

# DataPort 发布与域名迁移

页面与业务验收见 [数港系统页面与功能测试流程](docs/system-functional-test-flow.md)，包含测试准备、逐角色/逐页面操作、跨端闭环、异常恢复及执行记录模板。

## 撤回数港独立平台管理员方案（2026-10-15）

用户已取消本轮新增的 `mx-dataport-admin` 角色、平台管理网页及对应企业/超管管理接口，恢复原统一 MX 登录、Hub 企业权限和 Admin Token 配置专属邀请码的方式。前序登录权限协议校验及会话恢复修复保留，后续提交仍合并到 `pro`。没有按用户名自动授予权限，也未在本地工作中给线上 `taku` 授权。

`151_dataport_platform.sql` 已随之前的 pro 提交发布到版本历史，保留原文以兼容可能已执行的实例；该文件仅建表/加列，不授予管理员角色，回退后的服务不使用这些结构。不要修改校验值、删除线上表或执行数据回滚。如果尚未部署之前的平台管理版本，无需为已撤回功能部署 Auth/Hub；如果已经部署，则需要发布本次回退的 Auth → Hub → DataPort 代码，撤掉新增授权逻辑、入口及接口。已有 Auth 数据中若曾登记或授予该角色，应先核实记录再清理，不能推定代码回退会删除线上角色记录。

## 登录成功但所有导航消失（2026-10-15）

若 `/bff/v1/session` 返回有效的 `role: "owner"` 和旧 `capabilities`，但 `memberships[]` 没有 `dataport` 对象，说明当前 Hub 会话接口尚未提供新版数港权限协议。此时重复授予 owner 无法补齐接口；应核对数港的 Hub 上游、全部 Hub 副本版本，并部署包含 migration `149_dataport_enterprise.sql` 的 Hub，再发布数港。迁移由 Hub 原部署流程执行，不改写已应用迁移。

```bash
# 服务器已同步本轮 Auth/Hub/DataPort 代码，并完成账号服务配置后执行
cd ../mx-insight-hub
MX_INSIGHT_BUILD_PROXY=http://127.0.0.1:7788 \
  bash scripts/manage.sh ops internal-production deploy
bash scripts/manage.sh ops internal-production status
```

新版会话中的每个企业须返回 `dataport.permissions` 字符串数组及 `dataport.ownerChallengeRequired` 布尔值。未通过专属邀请码校验的超管应显示验证表单，而不是“当前角色没有权限”。需在原 Hub Admin Token 通道为该企业超管配置专属邀请码，具体接口见 [企业权限上线配置](docs/alignment-and-enterprise.md)。不要以旧 capabilities 或 role 在浏览器推导完整新权限来绕过超管验证。

数港现已校验新会话协议：缺字段、权限结构错误或租户无法匹配成员时保留登录态，显示“企业权限服务尚未就绪”，诊断码为 `customer_permissions_unavailable`，不加载私有业务或消息。后台会话恢复时同步当前企业选择，避免已取得新权限仍匹配空企业而误报无权访问。真实的空权限仍按无权访问处理；无企业成员的账号仍可走邀请确认。此提示修复需要另行提交、同步并发布数港；不会自动更新线上 Hub 或配置邀请码。

## 构建镜像拉取 EOF 与代理端口切换（2026-10-15）

若构建停在 `docker.io/docker/dockerfile:1.7` 或基础镜像元数据请求并返回 `EOF`，说明构建器访问 Docker Hub 的链路失败，尚未进入数港编译和数据库迁移。先在部署服务器检查实际 HTTP 代理：

```bash
curl --proxy http://127.0.0.1:7788 --connect-timeout 10 --max-time 30 \
  -I https://registry-1.docker.io/v2/
```

此匿名请求返回 `401 Unauthorized` 及 Docker Registry 认证提示属正常，表示已收到仓库的 HTTPS 响应；不代表随后所有镜像、认证及下载请求都已验证。若仍为 EOF 或连接拒绝，先处理该代理的监听、协议或 Docker Hub 出口，不靠删除缓存修复。

旧脚本固定复用 `mx-harbor-buildproxy`，仅首次创建时配置 BuildKit 容器代理；更改 `MX_HARBOR_BUILD_PROXY` 无法更新已有构建器的镜像拉取代理。本次改为按代理地址摘要选择独立构建器，复用前核对单节点、host 网络、代理及绕过配置；旧构建器和缓存保留。新构建器明确允许 `network.host`，使构建 RUN 步骤也能访问本机代理。

更新并同步本次脚本后，使用服务器实际端口重跑：

```bash
MX_HARBOR_BUILD_PROXY=http://127.0.0.1:7788 \
  bash scripts/manage.sh ops internal-production deploy
```

若服务器暂未同步修复，可在确认没有其他构建占用这个专用构建器后，执行 `docker buildx rm --keep-state mx-harbor-buildproxy`，再用上面的原命令重跑。旧脚本会按本次传入的代理重新创建构建器；`--keep-state` 保留其构建缓存。该操作不重启 Docker、数港运行容器或 Kubernetes，不更改业务权限与网关配置。

`MX_HARBOR_BUILD_PROXY` 是构建代理，不会配置 Git 的代理。构建阶段失败不会创建数港迁移 Job 或更新运行 Deployment；部署前置步骤可能已校验或同步本应用 Secret 与命名空间标签，不能据此声称整次部署完全无写入。

## 本轮：原型对齐与企业权限（2026-10-14）

已实现原型尺寸与导航、固定/自定义角色、统一 MX 员工开户与邀请确认、超管新登录邀请码校验、企业共享查询历史、Excel 批量查询、风险参考建议、Key 管理、账单筛选、工单和审计。用户已授权本轮修改数港相关 Auth/Hub 链路；需要 Auth → Hub 新迁移 149 → DataPort 的发布顺序。专用服务令牌、Auth 加密密钥和现有超管邀请码必须先配置，不能直接沿用以下历史轮次的“无需迁移/不改 Auth”结论。

完整说明、角色矩阵、配置和验证步骤见 [原型对齐与企业权限](docs/alignment-and-enterprise.md)。仅完成本地实现与验证，未发布生产；线上网关恢复后再验收真实只读业务数据。

2026-10-12。应用目录已从 `mx-harbor` 改为 `mx-dataport`，正式入口为 `https://dataport.minsight-ai.com`。本轮只完成代码和本机验收，生产步骤由运维执行。商城规则见 [Hub 订阅设计](../mx-insight-hub/docs/product/dataport-subscriptions.md)。

## 最新跟进：IP 画像地图与概要排版（2026-10-13）

地图从独立全宽区块移到右侧，风险等级与基础资料合为左侧独立区域；两侧标题顶部对齐，资料采用统一的两列标签/值网格，经纬度单独一行。地图所在列在当前桌面字号比例下宽 240px，底图高 144px；窄容器自动换行，与正文左右边缘对齐，手机底图高 160px。地图下仅保留“区域参考 · 非实时定位”，移除坐标说明展开区、重复地名/经纬度、坐标系与请求实现说明；OSM 署名保留在底图边缘。统一按钮尺寸、灰蓝文字和边框，降低地图饱和度，风险等级保留红/黄/绿语义色。长地名、经纬度和风险标签允许换行。

地图仍随画像自动加载，收起/展开复用，不重新查询或计费。首次完全无底图时，加载/失败状态占用地图区域，不与缩放按钮叠放；已有瓦片后继续保留地图和控件，后续慢加载/失败提示显示在底图下方，缩放时不盖住已有地图。缺少坐标时不丢失归属地，未知坐标系仍只展示区域，不兼容坐标系显示简短不可用提示。仅调整 DataPort 展示层；不修改 BFF、查询/计费、Launcher/Auth、MX-H2I 登录联网或部署配置。无需数据库迁移，尚未发布生产。

本机验收：`npm run build`（含类型检查）及 `node --test tests/workspace-ui.test.mjs` 通过；前一轮坐标/BFF 边界测试共 12 项通过。本轮 Browser plugin 不可用，使用现有 Playwright 1.57.0 + Chrome，以模拟会话/历史画像验证 1440、1024、900、768、767、390、320px 宽度，检查页面身份、有效内容、无错误遮罩、无意外控制台错误及截图。覆盖自动加载、收起/展开复用、展开说明不挪动概要、失败/慢加载重试、已加载地图缩放时保留控件、缺少坐标、GCJ02 禁用、WGS84 标记、长地名/标签换行，未产生新的画像查询。最终截图以真实 OSM 当前区域确认底图渲染，业务接口仍为模拟数据；未执行真实用户登录、联网链路、付费查询、付款或生产发布。

小字简化后重新通过构建、2 项 UI 测试及本机 Chrome 桌面/手机检查：技术说明不再出现在页面，概要经纬度、区域参考提示与 OSM 署名仍可见，收起/展开不新增瓦片请求，手机无横向溢出、无新画像查询或运行时错误。业务数据为模拟历史画像；未发布生产。

## 最新跟进：Logo 导航、登录态恢复与列表分页（2026-10-12）

Logo 原先链接 `/`，点击后整页加载；应用把登录态尚未确认的 `null` 也渲染为公开首页，导致闪屏。现改为站内导航到 `#/intelligence`，保留新标签打开链接的能力，手机导航随点击关闭。冷启动和登录返回先显示中性等待页，确认会话后直接显示目标页面；未知状态显示重试，不假定用户未登录。后台更新会话时保留已确认的界面和仍有权限的当前空间。既有登录目标、退出和支付返回定位继续保留，不修改 Launcher/Auth 或 MX-H2I。

DataPort 列表检查结果：

| 页面 | 处理 |
| --- | --- |
| 支付订单 | 服务端每页 20 条，返回总数/页码，可查看原先被 100 条上限截断的旧记录；失败在原页重试。 |
| 我的订阅 | 服务端每页 6 张卡片，仍按当前消费、可用、开始时间排序；翻页不改变消费选择。 |
| 数据商城 | 每页 12 款，先搜索和排序再分页，搜索/排序回到第一页；仍默认价格升序。 |
| API Keys / 空间成员 | 在完整的授权集合内每页 20 条；切换空间重置页面，不合并不同空间的数据。 |
| 新建查询的历史记录 | 保留已有服务端游标，每次 10 条，补充已显示条数与末页提示；回看不发起新查询。 |
| 消息中心 | 保留已有服务端游标，每次 20 条；浏览更早消息时固定已显示的首页，新消息提示手动刷新，避免后台刷新造成记录缺口。 |
| 用量概览 | 7/30 天图表保留完整；服务用量表每页 10 条；本期订阅最多展示 3 份摘要并链接完整订阅页。 |
| 公开定价 / 角色权限 / 接口文档 / 账户安全 | 套餐对比和固定权限矩阵保留完整；文档已有分类搜索与滚动目录；账户安全没有历史列表，不强行分页。 |

Hub 原租户商城只读接口新增可选 `ordersPage`、`subscriptionsPage`、`pageSize`，页码为正整数，单页上限 100，保留不传参数时的兼容返回。总数、已领试用、待付款商品、当前/未来订阅数和最长有效期独立汇总整个当前空间，不能由当前页推断。BFF 仍只转发原允许路径，Hub 仍验证当前空间 `billing.read`；不更改订单、支付、期限、额度或 Key 授权，无新数据库迁移。

发布顺序：**先 Hub，后 DataPort**，新客户端依赖 Hub 的分页参数支持。无需发布 Launcher、Pay 或 Nginx。同步代码后在服务器执行：

```bash
cd electron-dock/mx-insight-hub
MX_INSIGHT_BUILD_PROXY=http://127.0.0.1:7789 bash scripts/manage.sh ops internal-production deploy
cd ../mx-dataport
MX_HARBOR_BUILD_PROXY=http://127.0.0.1:7789 bash scripts/manage.sh ops internal-production deploy
```

本机验证：DataPort 类型检查及生产构建通过；隔离 PostgreSQL 中 127 条订单/订阅完整翻页、跨空间隔离、试用全局事实和分页参数校验通过；原查询历史游标测试通过。商城/Portal/空间测试共 37 通过、1 项既有 SSO 数据库测试未配置而跳过；DataPort 共 64 项通过、1 项迁移测试因未配置专用数据库而跳过（服务端 10 项使用允许本机监听的环境运行）。Chrome 1440×1000、390×844 使用模拟接口验证冷启动无公开首页、Logo 不刷新/不重做认证、手机导航关闭、保留登录目标与支付订单返回、各列表翻页/失败重试/空间切换；没有真实查询、付款或生产发布。

## 商品分类与地图加载（2026-10-12）

用户补充：地图改为随画像自动展开加载；DataPort 数据商城默认按价格从低到高，与公开定价页一致（试用版 → 基础版 → 专业版 → 企业版），仍可切换调用次数排序。若上轮商品分类和地图优化已发布，这两项补充只需重新发布 DataPort，不需要新迁移。

补充验收：DataPort 类型检查、生产构建和坐标/UI 相关 2 项测试通过；本机 Chrome 1920×1080、390×844 使用模拟业务数据验证打开历史画像即自动加载地图、收起/展开复用、失败重试、不兼容 CRS 不展示地图，以及乱序商品响应下的默认价格排序、手动切换次数排序、搜索和匿名定价页顺序一致。无运行时错误、无横向溢出、无新增画像查询。尚未发布生产。

Hub「数据商城 → 商品管理」默认显示已上架商品，可切换草稿、已下架、全部并查看各分类总数；支持商品名称/SKU 搜索和 DataPort 展示筛选。销售状态与对外展示仍是两个独立配置：只有 published 且 harborListed 不为 false 才对外展示。筛选只是查看，不更改商品、订单或订阅。

DataPort 地图改为站内 Leaflet 渲染，按用户最新要求，画像展示后自动展开并加载站内地图脚本和当前视野的 OSM 底图，移除外部网页 iframe 的脚本/样式加载链。收起再展开复用地图，正常使用浏览器缓存；不预取周边或其他缩放级别。8 秒仍未完成时提供慢加载提示、手动重试和 OSM 打开入口；失败不重新查询画像或改变额度。坐标系未知只显示大致区域、限制缩放、不画精确标记；明确不兼容坐标系不展示地图。瓦片仅发送区域路径与站点 origin Referer，不附带业务 Key、查询 IP、账号或页面查询参数。

OSM 公共底图不保证响应时间，用户日本代理链路的具体延迟原因尚未通过该链路抓包确认。实现遵循 [OSM tile policy](https://operations.osmfoundation.org/policies/tiles/)：固定官方 tile 域名、可见署名、正常缓存、仅当前视野、有效 Referer。无第三方脚本 CDN、代理转发或备用供应商切换。

本次没有新数据库迁移。同步代码后，依次部署 Hub 和 DataPort（沿用原环境参数）：

```bash
cd electron-dock/mx-insight-hub
MX_INSIGHT_BUILD_PROXY=http://127.0.0.1:7789 bash scripts/manage.sh ops internal-production deploy
cd ../mx-dataport
MX_HARBOR_BUILD_PROXY=http://127.0.0.1:7789 bash scripts/manage.sh ops internal-production deploy
```

DataPort 需完整发布包含静态资源及 CSP 的服务端镜像；仅将允许的图片源增加 `https://tile.openstreetmap.org`，脚本和业务连接仍限本站，禁用外部 iframe。无需发布 Launcher、Pay 或 Nginx。生产检查：四类切换与数量、搜索、DataPort 展示筛选、编辑原商品；打开历史画像后确认地图自动显示，再收起/展开地图，确认查询次数不变；模拟离线应提供重试。生产发布和用户代理链路验收仍待执行。

首轮（手动展开版本）本机已验证：Hub/DataPort 生产构建、DataPort 12 项坐标及 BFF/CSP 测试通过；Chrome 1440×1080、390×844 下分类数量、搜索、展示筛选、空状态、原编辑入口、地图按需加载/复用/缩放、8 秒慢加载、失败后手动重试、未知坐标系无标记及 GCJ02 禁用地图均通过，无意外控制台错误或新画像查询。浏览器使用模拟业务数据及受控图片响应验证失败路径，另以单次真实 OSM 可见地图确认渲染：6 张底图，约 3.3 秒完成；不是生产或用户日本代理链路的基准。Browser plugin 不可用，使用本机 Playwright + Chrome；未执行真实付款。

## 必须保留的身份与数据

`mx-harbor` 仍是现有 Auth appId/audience、K8s namespace/工作负载、会话库与网关协议的兼容标识，`MX_HARBOR_*` 环境变量继续有效。迁移只更换该应用的 origin、callback、interaction 和显示名称；不重建用户、空间、数据库，不轮换 clientSecret、sessionKey 或 gateway token，不改 MX-H2I/Luopan 网络授权。不要搜索替换线上 Secret 或重新初始化身份服务。

旧目录中的 **secrets/** 是忽略文件，Git 拉取不会替你搬迁。更新前备份，更新后将旧目录 `secrets/` 原样移到新目录（保留权限和内容）；先运行 `status` 核对原集群/节点。不要丢弃 Launcher 的原身份档案。

## 本次补丁：已完成 DataPort 域名切换的部署

2026-10-12 后续：修复首次登录表单在 SSO 跳转前短暂显示，以及缩放入场引起的闪动。表单准备完成或明确失败后才显示弹窗；保留本应用 SSO、邀请和退出流程。

同步本次代码后，沿用原环境参数，先在 **electron-dock/mx-insight-hub** 执行 `MX_INSIGHT_BUILD_PROXY=http://127.0.0.1:7789 bash scripts/manage.sh ops internal-production deploy`。它运行新增 migration `146_dataport_offers_and_trial.sql`；等待所有 Hub 副本就绪后，再在 **electron-dock/mx-dataport** 执行 `MX_HARBOR_BUILD_PROXY=http://127.0.0.1:7789 bash scripts/manage.sh ops internal-production deploy`。本次无需发布 Launcher、Pay 或 Nginx，也无需再次 enroll。

迁移自动发布未编辑过的三档初始套餐，并增加 0 元、10 次试用，默认 7 天有效、每个空间限领一次。Hub 的「数据商城 → 商品管理」可编辑试用有效天数、调用次数和销售开关。已编辑的三档商品不会被自动覆盖；需要自行将“销售状态”设为“已上架”，并开启“在数港上架”。原年度版继续保留；如果只展示新四档，在旧年度版编辑页关闭“在数港上架”，旧订单和订阅仍可使用。

生产验收：冷浏览器首次登录、关闭后重开、注册切换；定价出现已上架商品；在有权限的空间明确点击免费领取后只生成一份 0 元订单，显示 10 次和实际到期时间，无支付宝收银台。重复领取被拒绝；正式订单仍使用原 Pay 付款与返回路径。试用查询仍可能产生供应商成本，本机验证只用隔离数据库和模拟上游，没有真实查询或付款。

## 已有 Harbor 迁移顺序

### 支付返回地址先准备

在 Pay 管理中心的「支付渠道 → 原正式支付宝渠道 → 编辑配置 → 额外付款返回地址」中保留原条目，新增：

```text
mx-insight-hub https://dataport.minsight-ai.com/payment/return
```

这里的 `mx-insight-hub` 是现有 Hub 调用 Pay 的机器应用 ID；以该支付来源的实际 ID 为准，不因网站改名而改成 `dataport`。原 `https://harbor.minsight-ai.com/payment/return` 条目在过渡期保留。保存草稿、检查校验结果，再「发布并启用」使其生效；只更新本地 channels.json 不会覆盖已由控制台管理的渠道。

渠道默认「付款后返回地址」继续保留 Hub 的原地址，`notifyUrl` 继续指向 Pay 的原异步通知入口。若之前把全局默认地址改成了 Harbor，需要核对原 Hub 返回地址并恢复；DataPort 用上面的额外地址，不依赖修改所有应用共用的默认值。当前没有读取或修改线上渠道配置。

Hub 已从可信 Portal 的 `portalOrigin` 生成固定 `/payment/return`。完成 `enroll --migrate-domain` 和 Auth 发布后，从 DataPort 打开的收银台会请求新地址；Pay 未登记时会拒绝，不静默退回 Hub。已经打开的旧收银台链接不会自动改写，在原有效付款窗口内从 DataPort 重新打开原订单收银台即可；不要为改地址另建订单。旧 Harbor 返回仍由迁移入口接住。

若线上已经能从 Harbor 付款返回，通常已有按次返回地址能力，本次仅需发布渠道配置。若 Pay 没有「额外付款返回地址」或不支持 `checkoutReturnUrl`，先在 Internal 的 `electron-dock/mx-base/mx-pay` 用原参数执行 `bash scripts/manage.sh deploy`，确认全部副本就绪，再配置渠道。

### 分步发布

先把本次两个仓库的代码同步到对应服务器；本地工作区修改不会随服务器上的普通 git pull 自动出现。各步完成并检查成功后再继续，使用原部署参数。

1. 将 DataPort DNS 指向原 Domestic 网关，保留 Harbor DNS。备份原 Nginx 配置、相关身份档案与数据库。更新两个仓库代码。在 Pay 当前渠道的返回地址允许列表中增加 `https://dataport.minsight-ai.com/payment/return`（通常来源应用仍为 `mx-insight-hub`，以当前订单来源为准），同时保留 Harbor；不更换 Pay 应用/支付来源/签名秘密，也不补造付款事实。
2. Internal，先按原参数发布 Hub（包含 additive migration `145_dataport_subscription_rules.sql`），再在 **electron-dock/mx-dataport** 发布应用。两个命令分别在对应目录执行：

   ```bash
   # electron-dock/mx-insight-hub
   MX_INSIGHT_BUILD_PROXY=http://127.0.0.1:7789 bash scripts/manage.sh ops internal-production deploy
   # electron-dock/mx-dataport
   MX_HARBOR_BUILD_PROXY=http://127.0.0.1:7789 bash scripts/manage.sh ops internal-production deploy
   ```

3. Internal 的 **de-mingxi** 仓库安装新域名内网入口；Domestic 的同一仓库安装独立 HTTPS 证书和外网入口。这时旧登录仍可用，新域名尚未完成 Auth 切换。

   ```bash
   # Internal
   bash scripts/manage.sh internal-dataport-install
   # Domestic
   bash scripts/manage.sh dataport-install
   ```

   `dataport-install` 使用 HTTP-01、独立 `dataport.minsight-ai.com` 证书 lineage、Nginx 预检和共享续期 timer。不会删除旧证书或停止网关。新域名 `/health` 和 `/ready` 成功后再继续。
4. 在切换窗口，Internal 的 **electron-dock/mx-dataport** 执行显式迁移；再在 **electron-dock/mx-launcher** 沿用原发布命令和环境参数发布 Auth 客户端配置：

   ```bash
   # electron-dock/mx-dataport
   bash scripts/manage.sh ops internal-production enroll --migrate-domain
   # electron-dock/mx-launcher
   bash scripts/manage.sh ops internal-production deploy
   ```

   `enroll --migrate-domain` 仅接受固定的 Harbor → DataPort 迁移，保留密钥，创建 `.before-dataport` 私有备份，并同步原 DataPort/Hub Secret。部分同步失败可原命令重试；有身份或密钥冲突则停止。Secret 投影与 Auth 发布期间不要开放登录验收。新浏览器域名需要重新登录，旧域名 Cookie 不跨域搬运。
5. 完成新域名的登录、退出再登录和付款返回验收，再在 Domestic 的 **de-mingxi** 执行：

   ```bash
   bash scripts/manage.sh dataport-redirect
   bash scripts/manage.sh cert test-renew dataport.minsight-ai.com
   bash scripts/manage.sh cert test-renew harbor.minsight-ai.com
   ```

   旧站页面 308 到新站；旧 Auth 路径 303 到新站登录，不转发旧授权码；旧 BFF 返回 410，提示用户刷新。旧 `/api/v1/` 保持直通同一 Hub API，避免客户 Key 调用依赖跨域重定向。旧证书继续参与续期。
6. 在 Hub → 数据商城 → 商品管理核对三档草稿，设置“已上架”及“在数港上架”。旧商品不会自动下架；需要停止旧价格销售时手动下架，已售订单/权益保持。按原生产验收流程验证真实支付、幂等交付、切换订阅、每日限额，再开放正式销售。

**首次全新安装**在应用 deploy 后使用 `enroll`（不带 `--migrate-domain`）；其余仍按上述 Auth/Hub、网关、Pay 返回地址流程接入。日常 DataPort 更新只执行自身 deploy，不重复迁移或发布 Launcher。

## 验收与恢复

- DataPort：匿名定价只显示已发布且对外上架的商品；退出打开登录窗口；原账号、空间、API Keys、订单保持；旧 API 域名可用。匿名用户不能读取账单或编辑商品。
- Hub：价格/次数/有效期/每日限制可编辑；已售订阅快照不变。默认最早到期的可用订阅，可设置优先或恢复自动选择。升级按全价新购，支付确认后立即生效并优先使用，旧订阅保留。
- MX-H2I：用原验收账号检查登录及原联网能力；DataPort 退出不撤销其他应用会话。没有自动改变 H2I 配置或权限。
- 域名切换失败时保留旧 API 和所有数据库，先修复新入口。Auth 配置尚未发布时可恢复迁移前的本地档案和网关；Auth 已发布后，身份保留检查会拒绝直接回灌旧客户端配置，应优先修复新域名。必须撤回时另做精确反向身份迁移，并同步两端 profile 与网关，不绕过保留检查。迁移后的新订阅数据不要回滚为旧快照。
- 遇到部署锁，先运行 `bash scripts/manage.sh ops internal-production recover-lock` 只读检查。确认相关操作已退出后才使用 `--confirm-idle`；保留原锁名，兼容识别新旧目录中的操作进程。
- 完成 `enroll --migrate-domain` 后，若 Launcher 在恢复预检报 `public identity application credentials differ; recovery stopped`，先确认已同步本次 Launcher 修复：恢复检查与身份发布共用精确迁移规则，仅凭原客户端哈希证明允许 Harbor → DataPort 的域名和显示名变化。更新 `scripts/identity-app-profile.mjs`、`scripts/identity-deploy.mjs`、`scripts/k8s-recovery-state.mjs` 后，在 Launcher 目录沿用原环境参数重跑 `bash scripts/manage.sh ops internal-production deploy`，无需重复迁移。不要删除恢复快照、身份档案或 Secret，也不要重新初始化身份服务。若新版仍报错，说明差异不符合上述规则，应停止并核对原档案；不要绕过检查或输出密钥。

本地验证和截图记录：[2026-10-12 验证](docs/dataport-verification.md)。
