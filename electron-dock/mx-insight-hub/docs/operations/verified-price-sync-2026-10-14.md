# 已核验价格同步，2026-10-14

用户授权同时处理采购成本价和客户售价，已对外服务的高价先保留；跨币种先保存原币，不擅自选汇率或取整客户售价。这次实现价格专用数据迁移，不修改 Launcher / MX-H2I，也不改变接口授权、启停、灰度名单、预算、钱包余额或订阅权益。

## 证据与覆盖

| 供应商 | 证据 | 可映射采购端点 | 含义 |
| --- | --- | ---: | --- |
| TikHub | [官方公开逐接口目录](https://api.tikhub.io/api/v1/tikhub/user/get_all_endpoints_info)，2026-10-14T12:43:15.198629Z | 791 | USD 基础目录价；折扣、免费额度适用性另存，不能当作账户实扣 |
| 启信 | [官方目录](https://data.qixin.com/api-list)，2026-09-16T22:54:04.516663Z 快照 | 260 | CNY 历史官方公开价；14 个议价项跳过，本次刷新 HTTP 405，未冒充更新 |
| JustOne | 当日账户汇总与 Hub 成功次数 | 0 | 2026-10-14 总消费 CNY 92.55 已核对；端点单价没有明确证据，反推候选不迁移 |
| 其他 | 缺少逐端点、对应账户或计量单位证据 | 0 | 不把套餐均摊值、credits 或统一 0.01 变成真实采购价 |

TikHub 原响应 SHA256 为 `fb585f37c0b08af68cd06020faac186a1ab04d3eb1711bbb27150f8dbfffeb10`。规范快照在 `server/data/tikhub-official-prices.json`，共 1464 行、1463 唯一路径；一个路径的完全相同重复行去重，冲突拒绝。映射按代码合同中的精确路径，不按接口名称猜测。另保留规范快照哈希和原始采集时间。

目录来源已同步到 Admin 官方采购参考和官方价格草稿。原 `tikhub-reference-prices.json` 保留为历史证据，不再作为这两个当前目录的价格源。微信独立历史文档草稿仍保留自己的日期和来源。

## 写入规则

- 采购：按 operation 新建 immutable price book/release，CAS 更新引用；精确六位小数金额、币种、来源、日期、SHA、折扣资格写入 `control.procurement_price_drafts`，通过 `control.procurement_price_references` 绑定新采购书版本。旧版本不改。
- 现有预算账本按整数分记账。例如 USD 0.001 保存为 `amountMicros=1000`，预算仍为 1 美分的保守上限。未来分析可以按调用记录的 `provider_price_book_version` 查精确参考，但应继续注明目录价；实际扣费只由供应商账单或逐次费用回执确认。
- 采购书币种不同、预算缺失、缺少必要端点价、退休版本等明确跳过，不把旧人民币预算改读为美元。已明确免费采购价保持；合同不支持零价的官方免费项单独列出。
- 客户：仅 native 和启信等确定一次客户请求对应一次上游调用的 meter 可映射，共 1040 个候选。共享供应商 meter、多端点组合及可选补充调用跳过。
- 同币种、整分精度的候选覆盖已有一分价；免费条目保持。采购价与售价彼此独立，倍率保持，并在预览中同时列出基价及倍率后报价。
- 已服务或暴露情况不明的高基价、高实收价保留；折扣情况下会降低实际报价也保留。真实非 Admin 使用/扣款证据标为 served；存在外部 live Key、已绑定客户价格但无法证明纯内部使用则为 unknown，不能靠可编辑的名称认定测试用户。
- 每个受影响 consumer 新建独立 published plan/book 并 CAS 指向新版本，保留全部未选条目、limits、倍率和 `assigned_at` 微秒，因此额度周期不会重置。其全部 Key 使用同一 consumer 套餐；不修改 Key、grants、tenant fallback、订单、余额或历史扣款。
- 外币、低于一分、缺证及冲突都列为 blocked/skipped，不自动换汇、不自动向上取整客户售价。

采购和客户变更、审计回执位于同一 SERIALIZABLE 事务。任一失败全部回滚。apply 对预览状态重新核验；证据、套餐、曝光状态或价格漂移会要求重新预览。相同批次重复执行返回同一回执。业务计数正常增加但曝光分类不变，不会仅因此使预览失效。并发冲突仍可能要求重做。

## 执行

新文件位于 `server/ops`，会随 Hub 镜像的 `server` 目录发布。**先按现有流程发布包含本次代码的 Hub 镜像**；不需要新增 schema migration，也没有自动运行价格迁移的部署钩子。下面只操作 Hub Admin，不操作 Launcher 或网络服务。

```sh
kubectl -n mx-insight-hub exec deploy/mx-insight-hub-admin -c admin -- \
  node /app/server/ops/sync-verified-provider-prices.mjs --preview
```

preview 只保存审计批次，不改价格。输出 `id`、`hash`、30 分钟有效期及变更/保留/跳过摘要；生产实际修改数量以该结果为准，不能把 1051 个有证据的端点宣称为已更新数量。

需要完整逐项差异时：

```sh
kubectl -n mx-insight-hub exec deploy/mx-insight-hub-admin -c admin -- \
  node /app/server/ops/sync-verified-provider-prices.mjs --show '<id>' --details
```

执行该具体批次：

```sh
kubectl -n mx-insight-hub exec deploy/mx-insight-hub-admin -c admin -- \
  node /app/server/ops/sync-verified-provider-prices.mjs \
  --apply '<id>' --preview-hash '<hash>'
```

连接中断/提交结果未知时使用相同 id/hash 重试或 `--show '<id>'` 查询，不另外创建批次掩盖未知结果。过期或状态漂移会在写入前拒绝；重新 preview。不要手工 UPDATE published 历史书或账单。

## 后续多币种结算

可以按租户和币种分账户，消费保留原币金额、单位、价格版本及结算依据。后续统一折算应另记原币金额、目标币种、汇率来源/日期、规则、精度和差额，不覆盖原流水。已有客户执行链仍按当前套餐/钱包规则，本次没有实现一次请求自动选择外币钱包或同一笔费用双扣；采购支出与客户收入也应保留各自账务身份。

## 验证

67 项针对性回归全部通过、无跳过，包括隔离 PostgreSQL 上的采购/客户原子回滚、保存批次重放、CAS 漂移、不可变历史价格、额度周期、已有账单/套餐、原授予范围及管理员目录。测试仅连接 `/tmp` 中的独立本机数据库；未连接生产、未发起供应商业务请求。
