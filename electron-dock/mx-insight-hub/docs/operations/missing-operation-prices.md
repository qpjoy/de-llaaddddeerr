# 缺失采购价格的一次性恢复

2026-10-06 用户明确选择：检查所有供应商，因缺失采购价格而停用的操作先按原币种 `0.01/次`；缺失的月度采购预算、补贴预算各按 `100000 次 × 0.01 = 1000.00` 设置。已有价格、币种和预算保留。该数值是用户指定的临时采购估价，不是供应商实际扣费或客户售价。

使用 `scripts/migrate-missing-operation-prices.mjs`。这是显式运行的运维工具，不接入 schema migration、日常 deploy 或定时任务。无需重建镜像、重启 Hub 或改动 Launcher/MX-H2I。

## 筛选与写入边界

- 默认只读预览；`--apply` 才写入。`--all` 检查 Admin 目录中的所有供应商，也支持 `--provider NAME`。
- 必须有 `price_control_incomplete` 阻断，且至少一个必需 endpoint 单价为 null/缺失。已填的正价、明确的零价和免费接口不被覆盖；不补开未选用的可选 endpoint。
- 停用项只有完整审计链证明来自 migration 初始化及原默认价格 seed，才恢复为 `active`。明确的人工禁用、暂停、shadow 和无法确认来源的停用保留。已为 active/canary、仅价格阻断的操作保留其原状态及灰度名单。
- 缺凭据、合同未发布、技术配置错误、启信宝面议禁用等其他阻断跳过并列出。初始 legacy 环境合同开关可随已授权的数据库接管解除；不会修改环境变量或固定上游地址。
- 币种优先使用操作原值，其次是已配置的供应商默认币种。完全未定价的 TikHub/JustOne 可沿用仓库原默认采购账本币种 USD/CNY，报告标明 `provider_seed`；其他供应商币种未知则跳过，不从邻近接口猜测。已有部分价格却缺少币种时跳过，避免重新解释历史价格。非两位小数货币不自动迁移。
- 缺失的两个预算字段各补 `100000` 最小货币单位；已有预算（包括 0）保留。阈值仍按原实现以供应商及币种归集费用，不是为每个接口新增独立的免费调用额度。
- 通过既有 Admin policy API 一次性保存该操作的新价格版本、release、状态和审计原因；使用 `expectedRevision` 防止覆盖并发修改。只读数据库审计，不直接 UPDATE 控制表。
- 不改变租户、Consumer、Key 授权、客户套餐/售价、钱包余额、历史请求或登录联网。迁移不发起供应商调用，之后仍须通过原有授权、额度、余额、成本和限流检查。

## 在 Internal 服务器执行

将脚本同步到服务器的 `electron-dock/mx-insight-hub/scripts/` 后，在 **Hub 项目目录**执行。脚本通过 stdin 在现有 Admin Pod 的 `/app` 目录运行，复用该 Pod 的 Admin Token 和数据库连接，不需要导出密钥，也不需要部署新版镜像。

先预览；完整无密钥报告保存在服务器临时目录，终端显示计划数量及跳过原因汇总：

```bash
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -- \
  node --input-type=module - --all --missing-budget-minor 100000 \
  < scripts/migrate-missing-operation-prices.mjs \
  > /tmp/mx-hub-missing-prices-preview.json
```

执行用户已授权的恢复：

```bash
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -- \
  node --input-type=module - --all --missing-budget-minor 100000 --apply \
  < scripts/migrate-missing-operation-prices.mjs \
  > /tmp/mx-hub-missing-prices-applied.json
```

`--apply` 会重新读取并筛选当时的状态，不把旧预览作为授权覆盖现状。执行不是整批事务：每个操作独立原子提交；写入冲突、HTTP 失败或保存后仍被阻断时立即停止，退出码为 1。报告区分 `results` 已确认写入、`errors` 失败/结果未确认，以及 `summary.unattempted` 尚未执行。网络失败可能发生在提交后，不可把它解读为回滚；不自动重试 PUT，重新预览将保留已完成的价格。

需要查看具体剩余项时：

```bash
node -e 'const r=JSON.parse(require("node:fs").readFileSync("/tmp/mx-hub-missing-prices-applied.json","utf8")); console.log(JSON.stringify({summary:r.summary,errors:r.errors,skipped:r.skipped.filter(x=>x.reason!=="existing_prices_preserved")},null,2))'
```

迁移后“生效：正常”表示操作控制就绪，不代表上游已经真实成功。使用已有授权 Key 显式验证所需单页即可；不批量探测所有付费接口。此前的小红书用户发布笔记接口仍使用 `social.users.posts`，与同名 native 转发入口的独立操作策略分开。
