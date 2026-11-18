# LCY-delta 全业务权限与接口默认价

2026-10-10 用户进一步要求原 LCY-delta Key 不受请求配额限制、迁移已有 API，并让新接口自动定价。
用户随后明确：**客户扣费保留，通过内部设置余额使用**。此决策扩大了此前只修复 12 项微信授权的范围。

2026-11-18 用户再次明确：原 LCY-delta Key 拥有全部当前与后续新增业务 API 的权限，包含手机号库、邮箱库和各采集应用。此次修正原同步器只为 Twitter 用户邮箱添加例外的遗漏。

2026-11-18 后续 403 追查又发现：采集能力已进入全量目录，其对应的授权平台却没有一并加入。
现已让原 LCY 的 `lcyFullApiScopes()` 同时从 `COLLECT_CAPABILITIES` 推导平台和能力；
新增采集接口随目录注册及正常部署同步，不再分别维护两张清单。普通 Key 的范围不变。

## 生效行为

- 迁移 141 只将原 Key `fd2f8cc9-0ff1-4052-a538-8cc8150bde83` 标记为 `managed_full`，严格核对原 tenant/consumer。
  不更换 secret，不按名字匹配。每次 Hub 迁移完成后，从当前业务合同和数据源目录补齐 Consumer 与此 Key 的快照权限。
  新业务接口随部署自动加入，记录 scope audit；既有快照兄弟 Key 不扩权，活跃动态兄弟 Key 会使同步拒绝并报错。
  如果补回调用者授权会使其他活跃快照 Key 的遗留权限重新生效，同步也会拒绝，保留原配置供管理员核对。
  托管 Key 被撤销、过期或所属身份停用后不会自动恢复。后来注册的数据源在下一次迁移/部署时同步。
- 此 Key 免除 Key 总次数/速率、Consumer 窗口及套餐月度/窗口/突发请求配额，继承现有内部流量的 TikHub 本地限流豁免。
  正常身份校验、套餐有效性、请求合同/分页上限、共享并发容量、供应商可用性及资金检查继续生效。
  业务权限不授予 Admin Token 权限，也不自动购买独立订阅产品或消除供应商限制。
- 原 LCY 身份使用 `lcyFullApiScopes()`：从完整公共业务能力目录与文件数据集目录生成权限，包括 Twitter 用户邮箱、邮箱库、手机号库、`collect.*` 和 `public_opinion.all_ingested.read`。
  每次 Hub 迁移均补齐调用者授权及原 Key 快照；未来登记到目录的新接口同次发布自动加入，无须逐产品维护例外。
  其他托管 Key 和普通 Key 继续使用原授权规则。文件数据集已发布后即可查询；完整邮箱、手机号遵循查询接口现有 `reveal` 约定。
  此同步仅授予业务调用资格，采集引擎、供应商凭据、人工暂停、计费和合同验证继续使用各自运行配置；不会自动触发采集。
- 迁移 142 将已有租户的零默认价改为 1 最小货币单位；默认币种为 CNY，已有其他币种保留。
  默认 CNY 0.01/次覆盖没有套餐独立报价的现有及未来业务计费项。套餐明确价格（含免费）和已有非零租户默认价优先。
  计费模式、倍率、余额、已生成订单/账单不变。之后仍可在管理页把默认价或单项价改成其他值，包括 0。
  聚合查询等本来不计费的父请求保持不计费，其独立计费子请求使用各自报价。
- 每次 Internal 部署，`migrate-missing-operation-prices.mjs --defaults` 通过现有 Admin CAS 接口补齐所有已注册供应商操作缺失的采购价。
  现有采购价（含明确零价）、预算和人工状态不覆盖。每个缺失 endpoint 默认 1 最小货币单位；优先原账本/供应商配置币种，
  TikHub 缺币种沿用 USD、JustOne 沿用 CNY，其他尚未配置币种的操作采用 **CNY 暂估账本**。
  此数值是用户授权的成本估计，不是供应商实际收费证据。新 endpoint 无需再手动设置。
  缺失月度预算/补贴预算各默认 100000 最小货币单位，已有预算（含 0）优先。
- 只有完整审计链证明从未人工调整的初始化停用操作会启用；人工暂停/停用、canary 人群与退休合同保留。
  凭据缺失等独立阻塞如实输出；不会为了可用性自动采购、重试付费调用或解除未知扣费状态。

## 服务器执行

本次涉及运行时代码，**需要部署新 Hub 镜像**，只执行旧的微信修复脚本不能启用全权限策略。
先将本次 Hub 改动同步到服务器项目目录，再在 `electron-dock/mx-insight-hub` 执行：

```bash
MX_INSIGHT_SYNC_LAUNCHER=0 MX_SMOKE_DATA=0 bash scripts/manage.sh deploy

kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -- \
  node --input-type=module - < scripts/check-lcy-wechat-access.mjs
```

部署按现有流程先迁移再更新 Hub 服务，随后自动补价。只操作 Hub；不改 Launcher、MX-H2I 登录、联网或网络基础设施。
脚本通过 stdin 运行，兼容 Admin 只读文件系统，不在 Pod `/tmp` 写文件，不输出 secret/Admin Token/数据库连接串。

如果部署后的补价步骤因连接或并发修改中断，可单独核对、再继续：

```bash
# 只读计划
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -- \
  node --input-type=module - --all --defaults --missing-budget-minor 100000 \
  < scripts/migrate-missing-operation-prices.mjs

# 继续补齐；已有价格不会重复写入
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -- \
  node --input-type=module - --all --defaults --missing-budget-minor 100000 --apply \
  < scripts/migrate-missing-operation-prices.mjs
```

验收报告应有 `identityUsable: true`、`accessProfile: managed_full`、`requestQuotaExempt: true`，
`fullScopeCheck` 中两项 missing 数组为空；默认价 `unitPriceMinor: 1`（人工覆盖除外）。
此检查现在使用完整 LCY 目录，也会报告缺失的手机号库、邮箱库和采集能力，避免旧检查因过滤它们而误报完整。
微信 12 项应显示 granted；运行需要 active，或 canary 且包含当前 Consumer。余额不足仍返回 `insufficient_credit`。
`upstreamVerified: false` 表示没有发起真实付费采集。**线上部署和供应商实际可用性须以用户执行结果为准。**

## 2026-11-18 平台授权缺项与 403 复核

用户返回的生产只读回执确认原 tenant/consumer/Key 三元组有效，`managed_full`、`snapshot`，
当时有效范围为 71 个平台、1182 个能力，旧检查报告两项 missing 数组为空。
这证明该 Pod 已安装目录与此 Key 的授权交集一致；不是该 Key 整体被降权，也不能证明每条报错请求
实际使用同一 Key、正确接口或同一版本的 Public Pod。余额和供应商状态属于其他检查，不产生
`platform_not_granted`；本次不调整计费、钱包或供应商状态。

独立遍历采集注册表发现旧 LCY 目录缺少 10 个平台：`tieba`、`app_market`、`audio`、
`web_content`、`classifieds`、`web_intelligence`、`company_registry`、`travel`、
`network_intel`、`ad_library`。涉及 27 个采集定义。提交入口只查能力，executor 预留账本
还要求平台和能力同时有效；因此旧目录同步完成也可能在后续入账时被
`api_key_scope_not_granted` 拒绝。不能将这个确切缺口直接当作所有历史 403 的共同原因。

最初抖音电商请求 `c6d44975-0c48-4b10-9d60-aa7ca635cb00` 的直接根因仍是采集端错走
`/night-all/search/raw`，该接口按 `douyin_ec` 检查授权；正确商品接口按 `ecommerce` 和
`ecommerce.products.search` 检查。不能通过给错误入口授予虚假的平台权限修复分流。
该请求被 Hub 前置拒绝，未到 JustOne；外部供应商 403 无需转 raw。本次采集端同步补传
失败响应的 `request_id/body`，保留 Hub 与上游拒绝的区别，未新增重试或 raw 回退。

新工具 `scripts/lcy-api-access.mjs` 独立于微信 inventory 和 Admin HTTP，固定原始身份，
默认使用同一连接的只读一致性快照，分别报告 Consumer、Key 快照和最终交集缺项。
`catalogCoverage` 独立检查采集平台/能力是否完整登记，`catalogFingerprint` 标识已安装目录，
避免仅比较同一份漏项目录后误报完整。它不调用供应商，不输出 Key、Token 或连接串。

从服务器 Hub 项目目录执行只读核对：

```bash
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -- \
  node --input-type=module - < scripts/lcy-api-access.mjs
```

退出码 0 表示当前目录授权完整；2 表示检查完成但存在缺项或身份不可用；1 表示无法完成检查。
旧 Pod 可做只读核对；只有新模块声明支持定向同步、采集目录覆盖完整、原身份有效且仍为
`managed_full` / `snapshot` 时才允许 `--apply`。旧 Pod 会返回
`installed_runtime_upgrade_required`，不会忽略新参数后误同步其他托管 Key。

正常部署已执行全目录同步。**新 Hub 版本部署后**，若只读检查仍发现权限缺项，可单独修复原 Key：

```bash
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -- \
  node --input-type=module - --apply < scripts/lcy-api-access.mjs
```

定向修复复用原同步器的事务、授权锁、兄弟 Key 保护及 scope audit；不改变 secret、身份生命周期、
其他托管 Key、价格、供应商开关或 MX-H2I。再次执行无差异时 `changedKeys: 0`。
如果存在动态兄弟 Key 或补 Consumer grant 会恢复兄弟快照的历史权限，整笔修复回滚并明确报错。
被撤销、过期、降为普通 profile 或改为动态 scope 的 Key 不会被此命令自动恢复。

本次改动尚未部署，未运行生产修复或真实供应商采集；服务器回执只用于当前状态核对。

本轮验证：Hub 65 项相关用例全部通过，含完整范围/定向同步、普通 Key 隔离、供应商拒绝、
真实 CollectService → CollectExecutor → 内存账本授权与提交，以及 PGlite 执行真实 PostgreSQL
同步 SQL（不覆盖多连接竞争）。本机 TLS 超时用例最初受沙箱禁止监听回环端口影响，
允许仅本机端口后单独通过，未访问外部供应商。TypeScript 检查通过。
采集端 Python 20 项通过；MX-H2I 六个离线安全脚本共 10 项通过，目录无改动。
以上不能替代生产发布后对具体失败请求的身份、路由和权限核对。

### 2026-11-19 贴吧 social_query 请求的现场证据

用户随后提供 `ae7e3195-a026-4a44-b6e5-1967a7343d9a`：`social_query`、`action=search`、
`platform=tieba`、`phase=python_helper`、调用方标签 `environment=dev`、Skill `version=7`，
返回 HTTP 403 / `platform_not_granted`。服务器只读报告于北京时间 2026-11-19 00:07:30
从独立授权拒绝记录定位到原始 LCY tenant/consumer/Key，归属无歧义；Key 是有效的 Live / snapshot。
当前 `consumerGranted=false`、`keyEntitlementPresent=false`、`effectivePlatformGranted=false`，
无 usage 行。由此排除“只是 dev 用了另一把 Key”的推测，并确认该原 Key 当前确实缺贴吧两层授权。
该报告的 `supplierHttpCallsMade:0` 表示诊断工具不发上游请求；历史请求的前置拒绝由已保存的
授权事件及 Hub 调用链证明，不能仅凭诊断工具的计数推断。

提交对比：`552a39e3` 将三处原有平台断言替换为同样判断的证据封装，允许条件、403 code 和
message 未变；`066955e5` 新增异步贴吧采集及 LCY 全量目录，没有删除其他平台 grants，
但漏了采集平台这一轴。本轮已补齐此漏项。对旧/新授权断言的八类输入对照一致；同一个
合成 Key 的贴吧缺权时 403、微博有权时 200，说明权限按请求平台分别检查。
这份证据不支持“贴吧提交让原本已授权的其他平台统一变成 403”；其他漏登记的采集平台
可以遇到同类缺权，其他具体请求仍需各自证据。

另有独立的调用适配缺口：修复前 po-infra `llm.query_skills.social:execute` 的贴吧 search
经共享路由选择进入 `/api/v1/night-all/search/raw`，没有对接新异步
`collect.tieba.posts.search`。Skill 版本号不等于冻结的 Python 源码；本次拒绝查询没有输出
历史 HTTP 路径，因此这里是仓库调用链证据，不能替代当时的请求 checkpoint。
服务器报告也确认 legacy raw、v2 和 TikHub 内容搜索目录均未登记贴吧。
离线调用实际 Hub 方法验证：即使同时补齐 Consumer 与 Key 的 `tieba` 权限，旧 raw
仍返回 `400 platform_operation_unsupported`，没有 usage 或模拟上游调用。
因此权限修复与 social_query 的新接口适配必须分开验收，不能用补权或改走通用 v1
历史 fallback 冒充新版贴吧实时搜索已经接通。新采集使用 `/api/v1/data/collect/jobs`
及结果轮询；已入库数据使用 stored/canonical search。

2026-11-19 后续修复已在 po-infra 本地实现：仅 `search + tieba` 接入
`collect.tieba.posts.search`，单次提交、按 Retry-After 轮询同一 job、成功后读取 result。
保留幂等身份、jobId、partial/no_data 与 request 范围 completeness；403、未知结果、
取消和超时不重提、不回退 raw。LCY 授权修复和采集端镜像仍需分别部署验收。
完整命令与默认只读/显式真实采集/已有 job 只读恢复步骤见 po-infra
`docs/tieba_social_query_rollout.md` 和 `scripts/check_tieba_social_query.py`。

## 撤销与调整

默认价通过现有租户计费设置、接口套餐或供应商操作价格设置修改；后续部署不覆盖明确单项价格。
关闭该 Key 的持续全权限策略需由管理员将其 `access_profile` 改回 `standard`，再使用现有 scope 编辑收窄已物化权限。
这不会自动撤销已授予的权限，也不恢复迁移前的默认价；禁用 Key 可立即阻止后续调用。

## 本地验证

75 项授权、默认价格、真实 PostgreSQL 扣费/迁移、Admin 权限、兄弟 Key 和只读文件系统回归全部通过；管理页构建与部署脚本检查通过。
最终版本在新空库完成所有迁移，合成的原 UUID 身份通过真实目录同步得到 1096 项业务 capability，
再次运行完整迁移新增 scope audit 为 0，Key 摘要保持不变。测试未使用线上 Key 或请求供应商。
