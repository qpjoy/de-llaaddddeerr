# DataPort 发布与域名迁移

2026-10-12。应用目录已从 `mx-harbor` 改为 `mx-dataport`，正式入口为 `https://dataport.minsight-ai.com`。本轮只完成代码和本机验收，生产步骤由运维执行。商城规则见 [Hub 订阅设计](../mx-insight-hub/docs/product/dataport-subscriptions.md)。

## 最新跟进：商品分类与地图加载（2026-10-12）

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
