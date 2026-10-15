# 企业数据 / 启信慧眼

Hub 外部数据平台新增启信慧眼；接口说明统一位于「接口文档 → 企业数据」，平台详情只提供凭据、运行配置、用量与证据。

## 2026-10-13 企业请求并发拒绝追踪

用户提供请求 `7443d5db-d9b0-4d99-b204-eacd4e92df6c`。通过现有管理会话只读核对：

- 原 Key 为 LCY-delta；平台 `enterprise`，错误码 `external_platform_busy`。
- 2026-10-13 09:26:25.469 至 09:26:25.478 UTC（北京时间 17:26:25），约 9 ms；状态 `released`，没有保存响应正文，也没有该次上游调用记录。
- 客户计费为 `released / enforced / 0 CNY`，冻结已经释放。
- 18:14 左右的“限制与恢复”快照没有生效的持久化限制；供应商页当时显示最近一次启信成功为 17:29。二者都不能复原 17:26 的瞬时并发。

事故发生时的代码链路为 `POST /api/v1/data/enterprise/{apiId}/query` → 启信专用实例的
`ExternalPlatformGateway` → 幂等、授权、用量/钱包预占和派发租约 → 进程内并发门禁。
`QIXIN_CONFIG` 固定供应商并发 3、单调用者并发 1；单调用者的不同企业接口共同占用此容量。
`gateway.mjs` 的 `#enter` 满额时立即返回 `429 external_platform_busy`，不排队；该分支位于
采购成本预占、`beginProviderCall` 及实际 adapter 派发之前。LCY 的 TikHub 特例不豁免启信并发限制。
已保存的 9 ms / released / 零扣款 / 无调用记录与这个分支吻合；不能将其表述成启信返回业务错误或供应商宕机。

“响应 HTTP 未记录”是诊断证据来源不完整：`rejectWithoutDispatch` 将 429、`unavailable`
及错误码写入 `external_platform.gateway_requests`，而 `usage_requests` 只记 released 和错误码。
当时的诊断读取后者，没有关联网关记录。具体接口编号从 `usage_requests.billing_meter_key`
或快照中的固定接口路径读取；`gateway_requests` 本身没有 operation 字段。

用户随后返回生产脚本输出，补齐以下事实（结果均未截断）：

- 失败的是 **1.31 企业模糊搜索**，`POST /api/v1/data/enterprise/1.31/query`，并非补充分析中提及的股东查询。
- 网关记录 `56401bd8-5ceb-4f9b-a511-1640fd8d8b9e` 明确为 `qixin / unavailable / succeeded=false / HTTP 429 / external_platform_busy / providerCallId=null`，确认该次在 Hub 派发前拒绝。
- 唯一与目标时间窗重叠的已保存启信调用为 **1.41 工商照面**：请求 `e0f8a671-4a88-41a9-a85b-aa4493384cb7`，调用 `d013adec-2f46-4bde-8bdd-6eaa9dd6921a`；与目标同租户、同 consumer、同 Key。

| 北京时间（2026-10-13） | 已保存的事件 |
| --- | --- |
| 17:26:25.227 | 1.41 工商照面上游调用开始 |
| 17:26:25.469 | 目标 1.31 模糊搜索请求预留 |
| 17:26:25.478 | 目标请求因并发门禁返回 429，并释放预占 |
| 17:26:25.492 | 1.41 上游调用完成，HTTP/业务码均为 200 |
| 17:26:25.536–25.747 | 同身份 1.45 主要人员调用成功 |

工商照面调用比目标请求早开始 242 ms，在目标请求预留后 23 ms、拒绝后 14 ms 才记录完成。
上游完成时间不等于网关最终释放并发槽的时间，因此不能承诺只需等待 23 ms。
这组证据强烈支持同 consumer 并发 1 被在途企业查询占用的判断。
附近的 1.43 工商股东请求 `4929c65c-0856-4141-b214-ebad121e5dc9` 已于 17:26:23.279 完成，不与目标重叠。
后续 17:26:41.746–41.994 的另一笔 1.31 请求 `cc33239d-87d1-4d60-b4a9-660c3294ba10` 也成功；未读取查询参数，不能声称与目标关键词相同。

进一步核对不需要重发企业查询。将下面的只读脚本文件同步到有生产 Kubernetes 访问的服务器后，
从仓库根目录执行（不要求更新服务镜像）：

```bash
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
  node --input-type=module - 7443d5db-d9b0-4d99-b204-eacd4e92df6c \
  < electron-dock/mx-insight-hub/server/ops/diagnose-enterprise-busy.mjs
```

脚本读取精确请求的接口编号/方法/路径、网关拒绝记录及其前后 30 秒时间窗重叠的启信调用；
只输出 ID、状态、时间、HTTP 和同调用者/同 Key 的布尔关系，不读取企业参数、正文或凭据。
使用只读一致性事务和查询超时，结束回滚。最多各返回 100 条网关记录、上游记录并明确截断。
由于历史没有保存进程内计数或 Pod 身份，重叠调用只能提供关联证据，不能单独严格区分总并发 3 与单调用者 1 哪项先命中。

上述取证阶段只调查和准备诊断脚本，未修改业务并发、权限、价格或登录联网，也没有发起付费请求。
该次 busy 没有保存错误响应；相同幂等键重新发送可能创建新业务请求，不应将它当成只读回放。
脚本的 5 项本地模拟测试、Node 语法检查及差异格式检查通过；生产只读输出由用户执行并返回，本地未连接生产数据库。
后续用户明确要求增加到 10 并发并扩展通用队列，现已按下节实施；上述 3/1 为事故时的历史配置。

## 2026-10-13 并发与通用排队修复（待部署）

按用户要求，`QIXIN_CONFIG` 的每网关实例并发从 3 改为 **10**，单 consumer 从 1 改为 **10**。
不同企业接口共享该实例容量；超过并发时先等待，默认最多 10 秒、32 个待处理请求。
保留 Hub 现有每分钟 30 次限制；这两个值是 Hub 的准入配置，不代表已经核验的供应商合同上限。

通用 `ExternalPlatformGateway`、独立小红书用户资料/作品网关和 IP 网关复用已有并发等待实现。
范围、原期限、权限复核、取消、供应商限制及多实例边界见 [Hub 通用并发等待](hub-concurrency-admission.md)。

企业排队失败继续兼容 `429 / external_platform_busy`，message 明确“Hub 处理企业数据请求”，
并区分队列满、等待超时。details 标明 `layer=hub`、`stage=concurrency_admission`、
`upstreamDispatched=false` 和具体 `reason`；不能与供应商实际返回的 429 混淆。

诊断查询从与原错误匹配的网关账本补出历史 released 请求的 HTTP 状态；优先使用原 usage 状态。
确认派发前 busy 的请求显示 Hub 并发说明，不推断历史瞬时计数，不改写响应、收费或调用记录。

需要重新构建、部署 Hub Public API（队列与容量）和 Admin（诊断读取），无需新增迁移。
混合版本发布期间旧实例仍可能立即拒绝。无需调整 Key、授权、价格或供应商代理，MX-H2I 登录和联网不变。
本次没有新增线上付费验证或生产部署。

## 2026-10-15 工商股东历史拒绝复核

用户提供请求 `162d5e50-0360-45c9-9511-8dfc2a95b1dc`，下游标记为 **1.43 工商股东**。
截图记录 2026-10-13 07:55:36.567–36.578 UTC（北京时间 15:55:36），11 ms 后
`released / external_platform_busy`，客户结算 `released / enforced / 0 CNY`，没有保存响应正文或该次上游调用。
下游收到 HTTP 429 和 `External product search concurrency is exhausted`。

这条英文消息对应旧版通用网关的进程内并发拒绝；企业接口也复用了这条商品搜索文案。
用户随后返回只读脚本输出（网关与调用结果均未截断），已确认实际路径和计费键均为 1.43。
网关记录 `f066eab5-e2ee-4851-8009-f331c0bfa1bb` 为
`qixin / unavailable / succeeded=false / HTTP 429 / external_platform_busy / providerCallId=null`。
结合旧代码拒绝分支，确认这次是 Hub 派发前并发拒绝，不是启信上游返回的 429，也不经过 Night-All 13141。
`savedHttpStatus=null` 只是旧 usage 记录未保存状态；网关记录明确保存了 429。

| 北京时间（2026-10-13） | 已保存的事件 |
| --- | --- |
| 15:55:36.367 | 同租户、同 consumer、同 Key 的 1.31 企业模糊搜索开始调用 |
| 15:55:36.567 | 目标 1.43 工商股东请求预留 |
| 15:55:36.578 | 目标请求被 Hub 并发门禁拒绝并释放预占 |
| 15:55:36.597 | 上述 1.31 上游调用成功，HTTP/业务码均为 200 |
| 15:55:37.357–37.559 | 同身份的 1.45 主要人员查询调用成功，不与目标重叠 |

重叠的 1.31 请求为 `8e9fe5f4-22f8-4501-8af0-4e954fe378d3`，调用为
`19163ccc-cd9f-402e-a589-83200922163c`；它比目标预留早 200 ms 开始，在拒绝后 19 ms 才完成。
这强烈支持旧版单 consumer 并发 1 被在途查询占用的判断；历史没有记录 Pod/网关实例和瞬时计数，
仍不能严格排除实例总并发 3 也已满。调用结束不等于网关释放名额，不能据此保证等待 19 ms 即可成功。
1.45 的成功不是原股东请求已重试或恢复的证据。

现有修复提交 `a4d1d751`（2026-10-13 18:56:18 +08:00）晚于事故时间，且已经包含在当前分支中：
容量 10/10、满额等待 10 秒/32 项、明确 Hub 企业准入错误及历史诊断 HTTP 回填均已实现。
这次复核不重复修改容量或业务实现。新增真实本地 HTTP 回归，使用合成供应商响应，验证
1.41 与 1.43 混合占满十个名额后，第十一个 1.43 请求保持预占、等待且不创建供应商调用；
释放后得到原业务数据，幂等重放不重复采集。企业、诊断、队列与 HTTP 取消相关测试共
47 项通过、无跳过，包括 PGlite 全量迁移/结算/诊断集成测试。

### 线上只读核验

在有集群访问权限的服务器、仓库根目录执行；不会发送企业查询、重试原请求或修改账本：

```bash
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
  node --input-type=module - 162d5e50-0360-45c9-9511-8dfc2a95b1dc \
  < electron-dock/mx-insight-hub/server/ops/diagnose-enterprise-busy.mjs

# 检查所有 Public API Pod，而不是仅查看 Deployment 配置中的镜像标签。
kubectl -n mx-insight-hub get pods \
  -l app.kubernetes.io/name=mx-insight-hub-public \
  -o custom-columns='NAME:.metadata.name,START:.status.startTime,IMAGE_ID:.status.containerStatuses[*].imageID'

for pod in $(kubectl -n mx-insight-hub get pods \
  -l app.kubernetes.io/name=mx-insight-hub-public -o name); do
  echo "$pod"
  kubectl -n mx-insight-hub exec "$pod" -c api -- node --input-type=module -e '
    import { readFileSync } from "node:fs";
    import { createHash } from "node:crypto";
    import { QIXIN_CONFIG } from "/app/server/contracts/enterprise.mjs";
    const gateway = readFileSync("/app/server/external-platforms/gateway.mjs", "utf8");
    console.log(JSON.stringify({
      maxConcurrency: QIXIN_CONFIG.maxConcurrency,
      maxConsumerConcurrency: QIXIN_CONFIG.maxConsumerConcurrency,
      maxRequestsPerMinute: QIXIN_CONFIG.maxRequestsPerMinute,
      gatewaySha256: createHash("sha256").update(gateway).digest("hex"),
      hasLegacyBusyMessage: gateway.includes("External product search concurrency is exhausted")
    }));
    try {
      const { DEFAULT_CONCURRENCY_QUEUE } = await import("/app/server/external-platforms/concurrency-admission.mjs");
      console.log(JSON.stringify({ queue: DEFAULT_CONCURRENCY_QUEUE }));
    } catch { console.log(JSON.stringify({ queue: "unavailable" })); }
  '
done
```

当前源码期望 10/10、30 RPM、队列 10000 ms/32 项且不含旧消息；这些是容器文件的版本证据，
不是历史进程计数。将网关 SHA-256 与待发布版本同一文件比较；仅有队列模块存在不能证明调用路径接入正确。
若仍是旧版本，按现有 Hub 独立部署流程重新构建并发布 Public API 与 Admin；不要仅重启旧镜像。
如果线上已是新版本而只有这条历史请求失败，无须再次增加并发，也不会自动将历史失败改成成功。
本次没有连接生产或重新发起付费查询；线上生效状态等待运维输出核对。没有修改 MX-H2I 登录或联网。

## 目录与契约依据

- 用户提供的 `/tmp/company/qixin_api/catalog.json` 是初始合同依据（2026-09-01，272 项）。2026-09-17 补入官方新接口 77.58 医院信息、43.82 企业证券名称变更的合同，当前 18 类、274 项；既有 272 项的参数合同保持原样。仓库内固定副本为 `server/external-platforms/qixin-catalog.json`，运行不依赖 `/tmp/company`。
- 同项目 `client.py` 的 Auth 2.0 签名及固定接口调用；保留其 19.91、42.3 的可选字段修正，以及 66.35、22.11 的二选一约束。
- 2026-09-17（北京时间）逐页抓取[官方目录](https://data.qixin.com/api-list?from=qxb-navigation-data)：28 页、每页 10 项，共 274 项；260 项公开标价（含 5 项免费），14 项面议。`shared/qixin-official-prices.mjs` 保存每项 ID/名称/整数分价格、来源、UTC 采集时间和各页 SHA-256；`price_show != 1` 或非明确数值一律不作为可调用价格。仅查询公开目录元数据，没有付费业务实测。

## 管理与启用

先执行正常 Hub 数据库迁移，包含 `091_enterprise_qixin.sql` 与 `092_qixin_official_prices.sql`，再发布服务。092 发布官方采购标价快照，将尚未经过管理员编辑的公开定价操作设为 active；已有显式暂停、自定义价格等操作不变。不会修改现有消费者、API Key、套餐或余额，也不触发供应商查询。面议接口在运行策略和最终适配器均禁止调用，返回 `enterprise_price_negotiated`，手工录入价格也不能绕过。

在外部数据平台的「启信慧眼」详情页成对填写 **App Key / Secret Key**。时间戳与 sign 自动生成，无需人工填写。凭据使用 AES-256-GCM 加密后存入现有受限凭据表，沿用版本冲突检查；普通响应不返回明文，查看/复制必须再次输入 Admin Token。加密依赖现有 `MX_INSIGHT_API_KEY_PEPPER`；恢复数据库时必须保留同一 pepper，换 pepper 后需重新保存此平台凭据。

供应商账户需要配置 Hub 的出口 IP 白名单。操作控制支持名称/ID 搜索、每页 10 项及页码跳转。公开标价默认作为采购估计，真实账单仍未知；可按现有流程修订有价接口的合同采购价与运行状态。默认非客户计费采购预算/补贴预算均为 0：已有明确成交价且启用余额扣费的请求沿用客户钱包链路；未配置客户价格、未启用扣费的付费请求不会消耗未授权补贴。客户价格 0 不等于采购免费，仍受该预算限制。

给 LCY-delta 等现有 Key 追加服务：

1. 「开放能力」选择对应租户/调用者，在「启信宝 · 企业数据权限」中授权，分别开启 `enterprise` 与 `enterprise.query`，保留既有额度策略。
2. 点击「调整原 Key 权限」，选择原 Key，点击「勾选已开通的启信宝权限」并保存。原密钥、有效期、其他权限、历史用量不变。只授权消费者不会自动扩大旧 Key。
3. 「套餐与配额」点击「追加启信宝费率」。260 项官方价格追加到当前套餐草案，原有非启信宝费率保留。可选择官网原价、加价百分比或原价百分比折扣（90 为九折），点击应用再审阅、发布并分配。
4. 当前套餐仍绑定调用者，其下所有 Key 共用费率；钱包/计费模式/租户倍率维持现有租户级语义。启信宝产品倍率仅调整该产品的基础价，成交价还要应用原租户或套餐默认倍率。发布后才影响新请求，历史请求不追补。

例如官网 ¥3/次，加 20% 为 ¥3.60，九折为 ¥2.70；不足一分向上取整，官方免费项仍为 0。计费键为 `enterprise.api.{apiId}`。组合来源记录固定版本、采集日期和产品倍率；运行时使用已发布的完整不可变费率表。编辑、查看费率均支持搜索与每页 10 行；翻页不会丢弃编辑，发布校验全部草案。服务端单套餐支持最多 2048 项费率，发布请求限制 512 KiB。

仅目录中标价为零的五项读取/状态接口允许零采购价：36.99、22.62、2.3、60.2、33.11。其他可调用接口继续要求正整数采购价。没有新增余额监控、自动报告轮询或下载。

后续采价可运行 `node scripts/collect-qixin-prices.mjs /tmp/qixin-price-candidate.json`。脚本只抓取公开目录，检查分页数量、重复 ID、价格精度并输出候选快照。复核后发布新版本；它不会直接更新在线采购价或客户套餐，不在客户查询时抓价。

当前 Hub 技术上限为每网关实例并发 10、单消费者并发 10、每分钟 30 次；并发满时有界等待（默认 10 秒、32 个待处理请求）；30 秒超时、响应上限 16 MiB。仅接受固定 `https://api.qixin.com` 目录地址，禁止重定向和自定义 URL、Headers。供应商是否真实扣费记录为未知，采购成本按已审核价格估计。未知调用结果阻止自动重发。

## 出网代理与余额检查（2026-10-09）

迁移 `135_qixin_proxy.sql` 为启信增加独立的 System Proxy 绑定，默认 `system-egress`（不使用应用代理，也不继承全局代理）。先按正常流程迁移，再部署 Hub Admin、Public API 与前端；已有固定出口中继、其他平台绑定、全局代理、凭据和授权均不改动。重复执行迁移不会重置管理员已保存的启信绑定。

在「上游供应商 → 启信慧眼 → 启信慧眼 出网代理」选择系统网络、继承全局或指定 Proxy Sequence，填写原因后保存，下一次请求生效：

- 系统网络模式保留原固定出口中继；未启用中继时直接访问启信官方地址。
- 选用正向代理时访问固定的 `https://api.qixin.com`，不会把内网中继地址发给代理。出口仍需满足供应商 IP 白名单。
- 只对固定根路径做无凭据连通性探测；它不检查余额或企业业务可用性。仅在序列明确允许时回退系统网络，此时探测和业务请求都使用原中继设置。
- 全部探测失败记为未派发、明确未计费；已发送业务请求超时或失败不换代理重发。页面读取、保存配置都不触发上游调用。

固定出口中继现收纳在同一个「启信慧眼 出网代理」面板：顶部显示已保存的主路径和系统网络分支的中继地址，“查看 / 配置 Nginx 中继”展开并定位到配置区。主出口切到正向代理时，中继保留；切回系统网络后恢复使用已启用的中继，无须删除或重填地址。继承全局模式不伪装成已经确定的实际出口；提示会说明取决于全局路由。显示的是配置而不是探活结果，修改下方中继不会悄悄切换上方主出口。仍沿用原有两组 revision 和审计记录，不新增迁移。

本次界面分组验证：32 项现有代理/UI 回归、类型检查及构建通过。使用本地 PGlite 配置与隔离 Chrome 验证中继启用、代理切换保留中继、刷新持久化、在代理模式保存中继不改主出口、切回原中继、继承全局提示，以及 1440px/390px 的展开定位；无浏览器错误、无外网请求。没有新建云端代理、修改线上 Nginx 或调用付费企业接口。首次受限环境回归因本地端口权限失败，允许临时本地监听后 32 项全部通过。

**尚未确认免费的余额查询接口。** 2026-10-09 复查仓库已固定的 274 项官方业务合同，没有账户余额接口；本次访问[官方目录](https://data.qixin.com/api-list?from=qxb-navigation-data)及目录元数据接口返回 HTTP 405，不能据此断言供应商没有此接口。现有五个零价业务接口不是余额查询，不用它们探测账户状态。启信暂不启用 TikHub 式自动余额轮询或数值阈值告警；需供应商确认余额接口路径、签名、余额字段/单位、调用费用与限频后再接入现有监控。实际企业响应 `status=102`、`账户余额不足` 只证明该次业务拒绝，不能推算余额数值。

## 104 白名单拒绝与失败计费排查

上游 HTTP 200 不代表查询成功。已观测到 `status=104`、`message=未添加IP白名单`：应在该组 AppKey 的供应商账户中添加 Hub 请求的公网出口 IP。错误堆栈中 `connect ... IP:443` 的 IP 是探测服务目标地址，不是 Hub 出口，不能用于白名单。

如果 `api.ipify.org` 不可达，可在服务器从实际 Public API 容器查询 IPIP 的出口观察接口（[服务说明](https://www.ipip.net/myip.html)）。这不是企业查询，不发送任何平台密钥：

```bash
kubectl -n mx-insight-hub exec deployment/mx-insight-hub-public \
  -c api -- node --input-type=module -e '
const r = await fetch("http://myip.ipip.net", {
  signal: AbortSignal.timeout(10000)
});
if (!r.ok) throw new Error(`HTTP ${r.status}`);
console.log(await r.text());
'
```

若网络按目标分流，查询服务看到的出口只能参考，应以启信宝调用日志中记录的来源 IP，或访问 `api.qixin.com` 时实际使用的 NAT 出口为准。探测失败不需要修改 MX-H2I 的 DNS、代理或登录配置。

明确拒绝且没有存量结果交付的企业请求，保存失败响应并将用量记为 `released`，客户冻结金额释放；采购账单是否收费仍为未知。相同 Idempotency-Key 返回原错误和原 Request ID，不再访问供应商。白名单修复后由用户显式选择「以当前参数新建请求」，才重新查询和计费。超时等未知结果仍为 `unknown` 并保留冻结。成功、无数据和异步已受理的既有收费规则保持不变。

此修复不改写旧账本。旧版本可能将明确拒绝记为 `committed`，并在 enforced 模式扣费；应按 Request ID 核对 `billing.customer_charges`。确认为误扣时，管理员可在「套餐与配额」选择对应租户，通过「人工充值」按实际误扣金额补偿入账，原因及外部关联号填写原请求号；提交前核对是否已补偿，保留原扣款与补偿两条记录，不直接 UPDATE 余额或历史 charge。新代码需要正常部署后才在线上生效。

## 对外调用与数据留存

「数据产品 → 企业数据」默认打开接口调试，沿用当前 Hub Key 的调用身份；租户导航需要同一调用者同时开通 enterprise 与 enterprise.query，实际请求再检查原 Key 的权限。调试表单从已认证的 OpenAPI 读取接口、字段和开放状态，按名称/ID 搜索、分类及每页 10 项展示。只在点击发送时调用，不自动查企业、翻页或轮询；相同参数的重试和 tab 切换保留当前页面内的幂等标识。切换 Key 会清空请求与响应，浏览器刷新或离开页面后应使用已保存的 requestId/Idempotency-Key 核对，不能假定页面会恢复请求。

完整文档仍在「接口文档 → 企业数据」，包含 Node.js/Python、各接口 cURL、query/body 参数、响应结构、分页、状态核对和结果复现。调试页可以复制不含密钥的代码示例；替换 Hub Live Key 后供下游使用。长期集成不能使用管理台一小时临时凭据。目录合同覆盖不代表所有接口已做生产付费验收，面议接口仍禁止调用。

固定公共路由：`POST /api/v1/data/enterprise/{apiId}/query`，请求体使用各接口文档列出的 `query`、可选 `body`、`method` 与 `deliveryMode`。消费者与 Live Key 需同时具有 `enterprise` 平台和 `enterprise.query` 能力。旧 Key 不自动获得新增权限。

`live_only` 为默认模式；`live_only`、`refresh` 要求 Idempotency-Key。同一请求重试保留标识，分页和新查询更换标识。`cache_only` 只读 Hub；`cache_first` 优先一小时内快照；可回退的存量范围为一天。快照按调用者与完整请求隔离。

返回的外层 `data` 保留完整业务信封，包括供应商业务 `status/message/sign/data`；不因字段名为 token、sign 或 URL 而丢失业务数据。仅删除本次平台凭据/签名的精确回显。200 为完成，201/206 为无数据，202/203 为处理中；处理中不代表报告已完成，也不会触发自动查询。异常响应保留可获得的原始证据，不伪造成功；超限或无法安全转换的响应不会被截断后作为完整结果交付。

交付前，PostgreSQL 保存完整受限原始响应、调用记录、调用者快照和可靠入库任务。入库 worker 写入 `enterprise.responses.v1` / `enterprise` 的 Canonical 响应观察、修订和 outbox，进入现有检索投影链路。一次响应观察不是一家企业，不能把观察数量当成去重企业数。`GET /api/v1/acquisitions/{requestId}` 按原 Key/消费者权限复现原交付结果，不访问上游。

内存开发模式及 Admin listener 不创建付费 adapter；缺凭据、未启用或不可用只影响企业查询。MX-H2I 登录、网络和现有平台的路由保持原有实现。

## 验证

2026-10-09 出网代理与供应商页面修复：66 项相关服务端回归通过，无跳过；PGlite 执行 common + Hub 全量迁移，确认 135 保留其他平台绑定、全局代理、中继，重复执行不重置管理员选择。类型检查与生产构建通过（保留现有 bundle 大小提示）。Browser 插件不可用，使用隔离 Playwright/Chrome、本地内存业务数据与 PGlite 代理配置验证供应商总览、启信默认系统网络、保存代理、刷新持久化、恢复系统网络及 390px 页面；登录后无 JS 错误、请求失败或 5xx。登录前匿名 SSO 会话检查返回预期 401。所有业务响应使用合成数据，没有真实企业调用、余额轮询或飞书发送；尚未生产部署。

`tests/server/enterprise-qixin.test.mjs` 覆盖全目录本地校验、签名、双凭据加密及版本冲突、HTTP 身份隔离、精确响应、缓存/幂等、未知结果、零价边界和文档授权。全部供应商响应使用合成测试数据。

设置 `MX_ENTERPRISE_PGLITE_MODULE` 指向可用 PGlite 模块时，额外运行 common + Hub 全量迁移，并验证 PostgreSQL 价格策略、归档、队列、Canonical/outbox、所有者隔离及原结果复现。未设置时明确跳过数据库集成项。浏览器验证使用本地合成凭据，覆盖双字段保存、二次验证查看、平台接口筛选及独立文档导航。

2026-09-17 本次变更验证：服务端与 Sites worker 回归 1860 项通过、24 项按环境条件跳过；构建、类型检查通过。浏览器验证覆盖消费者授权、原 Key 追加权限、265 项组合费率的搜索/跳页/末页编辑/发布、加价与折扣，以及 390px 手机视口的弹窗与表格。测试仅使用本地合成账户和供应商响应，未改变线上 LCY-delta。独立运维脚本检查仍有既有 Docker 代理快照断言失败，本次未修改相关部署配置。

企业调试页追加验证：回归 1864 项通过、24 项跳过；274 个表单与服务端请求校验契约一致。浏览器在 1440px 桌面及 390px 手机宽度验证已授权/未授权 Key、目录最后一页、面议禁止调用、body 字段、pending 状态和跨 tab 幂等重放；两次相同请求只派发一次本地模拟上游，换数据页使用新标识。无真实供应商请求。
