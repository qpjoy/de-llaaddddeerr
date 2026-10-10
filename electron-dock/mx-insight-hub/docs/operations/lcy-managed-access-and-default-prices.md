# LCY-delta 全业务权限与接口默认价

2026-10-10 用户进一步要求原 LCY-delta Key 不受请求配额限制、迁移已有 API，并让新接口自动定价。
用户随后明确：**客户扣费保留，通过内部设置余额使用**。此决策扩大了此前只修复 12 项微信授权的范围。

## 生效行为

- 迁移 141 只将原 Key `fd2f8cc9-0ff1-4052-a538-8cc8150bde83` 标记为 `managed_full`，严格核对原 tenant/consumer。
  不更换 secret，不按名字匹配。每次 Hub 迁移完成后，从当前业务合同和数据源目录补齐 Consumer 与此 Key 的快照权限。
  新业务接口随部署自动加入，记录 scope audit；既有快照兄弟 Key 不扩权，活跃动态兄弟 Key 会使同步拒绝并报错。
  托管 Key 被撤销、过期或所属身份停用后不会自动恢复。后来注册的数据源在下一次迁移/部署时同步。
- 此 Key 免除 Key 总次数/速率、Consumer 窗口及套餐月度/窗口/突发请求配额，继承现有内部流量的 TikHub 本地限流豁免。
  正常身份校验、套餐有效性、请求合同/分页上限、共享并发容量、供应商可用性及资金检查继续生效。
  业务权限不授予 Admin Token 权限，也不自动购买独立订阅产品或消除供应商限制。
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
bash scripts/manage.sh ops internal-production deploy

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
微信 12 项应显示 granted；运行需要 active，或 canary 且包含当前 Consumer。余额不足仍返回 `insufficient_credit`。
`upstreamVerified: false` 表示没有发起真实付费采集。**线上部署和供应商实际可用性须以用户执行结果为准。**

## 撤销与调整

默认价通过现有租户计费设置、接口套餐或供应商操作价格设置修改；后续部署不覆盖明确单项价格。
关闭该 Key 的持续全权限策略需由管理员将其 `access_profile` 改回 `standard`，再使用现有 scope 编辑收窄已物化权限。
这不会自动撤销已授予的权限，也不恢复迁移前的默认价；禁用 Key 可立即阻止后续调用。

## 本地验证

75 项授权、默认价格、真实 PostgreSQL 扣费/迁移、Admin 权限、兄弟 Key 和只读文件系统回归全部通过；管理页构建与部署脚本检查通过。
最终版本在新空库完成所有迁移，合成的原 UUID 身份通过真实目录同步得到 1096 项业务 capability，
再次运行完整迁移新增 scope audit 为 0，Key 摘要保持不变。测试未使用线上 Key 或请求供应商。
