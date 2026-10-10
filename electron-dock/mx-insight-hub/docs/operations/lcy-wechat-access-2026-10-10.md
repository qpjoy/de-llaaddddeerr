# LCY-delta 微信公众号授权修复

用户报告 `POST /api/v1/data/wechat/search/search` 返回 `403 capability_not_granted`，
关联 requestId 为 `f044f52c-67ce-47f5-a135-4cf6de23224e`。这个错误来自授权检查，
发生在价格预留、供应商调用之前，不代表搜索零命中，也不能由修改价格解除。
微信新合同要求 `social + native.wechat.search.search`；旧 `wechat_mp/wechat_search`
授权不自动获得新操作。本次没有读取线上该请求的日志，实际 Consumer/Key 缺项与运行策略需以服务器报告为准。

## 修复范围

- 迁移 `140_lcy_wechat_mp_grants.sql` 定向补齐原 Consumer 的 12 项能力及原 Key 的权限快照：
  11 项 `native.wechat.mp.*` 加 `native.wechat.search.search`。不包含视频号、视频搜索或 demo。
- 使用固定 Key UUID `fd2f8cc9-0ff1-4052-a538-8cc8150bde83`，核对原 tenant/consumer，
  不按可改名的 `LCY-delta` 匹配。保留 secret、有效期、状态、原权限和原配额。
- 必须已有有效 `social` 平台授权和 Key 快照；已撤销/过期/测试/动态 Key、停用身份或活跃的动态兄弟 Key
  会让迁移失败回滚，不以修复为由恢复它们。其他数据库没有原 Consumer 时跳过。
- 新能力配额继承该 Key 的 social 快照并受现有能力策略约束；已有策略/快照不覆盖。
  写入审计，重复迁移不重复扩权；其他快照 Key 不获得这些能力。
- 价格工具新增 `--operation KEY`，可重复使用，必须指定单一 `--provider`。
  精确筛选完成且所有目标都存在后才开始写入，不能因拼错接口而执行部分批次。
- 只补这 12 项中缺失的采购价格，按用户授权采用**原币种 0.01/次**（TikHub 原账本默认 USD）。
  保留已有价格、明确零价、币种与预算；缺失预算沿用已授权恢复规则，各补 100000 最小货币单位。
  这不是客户售价，也不是实际供应商扣费。客户套餐、默认价、倍率、钱包和旧账单保持原值。
- 价格工具仅恢复审计证明为初始化停用、且仅被缺失价格阻塞的操作；人工暂停/停用、缺凭据、
  未发布合同等继续报告，不绕过。已定价但仍停用的操作也不会被悄悄启用。

## 服务器执行

先把本次迁移和三个脚本同步到服务器 Hub 项目目录。无需部署镜像或同步 Launcher。
在 `electron-dock/mx-insight-hub` 目录执行：

```bash
# 默认只读：原 Key 有效权限、运行状态、客户报价以及缺失采购价计划
bash scripts/repair-lcy-wechat-access.sh --preview

# 执行本次已授权修复，并输出最终状态
bash scripts/repair-lcy-wechat-access.sh --apply
```

脚本只使用 `kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin`。
源文件通过 stdin 运行，复用现有 Pod 的 DB 连接与 Admin Token；不在命令行或输出里打印密钥。
权限 SQL 直接从 stdin 读入内存，复用现有迁移锁，并在同一数据库事务内执行 SQL 和写入
`schema_migrations` 校验和；不创建临时文件，兼容 Admin 容器的 `readOnlyRootFilesystem`。
只执行迁移 140，不会顺带应用其他尚未部署的迁移。之后正常部署会识别该校验和并跳过已完成迁移。
不重启 Pod、不更换 Key、不调用供应商，也不改 MX-H2I 登录、联网、DNS 或 VPN。

两个阶段不是一个跨服务事务：权限先提交，价格按操作经现有 CAS Admin API 提交。
价格步骤失败时保留已完成状态并停止，不自动重试未知写入；重新运行 `--preview` 核对。
本次本地已完成真实 PostgreSQL 事务、回滚、幂等、身份/兄弟 Key/原配额保护与微信网关回归测试；
**线上执行和真实采集仍待服务器结果，不以本地测试代替验收。**

### 首次执行的只读文件系统错误

用户提供的服务器输出在 `mkdtemp /tmp/lcy-wechat-140-…` 返回 `EROFS`。
原脚本错误地假设 Pod 的 `/tmp` 可写，失败发生在数据库连接和权限迁移之前；前面的价格步骤
也是只读预览，不能将其 `skipped: 12` 解读为权限修复成功或价格必然齐全。
当前脚本已移除容器文件写入，不需要改变安全设置、增加挂载或重启 Pod。
同步更新后的 `scripts/repair-lcy-wechat-access.sh`，再次执行相同 `--apply` 命令即可。
新增测试实际执行脚本中的 Node 迁移段，在禁止所有文件写入的子进程内连接临时 PostgreSQL，
验证首次执行、相同 SQL 跳过、校验和冲突、SQL 失败整笔回滚及并发迁移锁拒绝。

单独查看最终状态的 K8s 命令：

```bash
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -- \
  node --input-type=module - < scripts/check-lcy-wechat-access.mjs
```

报告应有 `identityUsable: true`、`effectiveSocial: true`，12 项 `granted: true`。
操作运行需要 `state: active`，或 `state: canary` 且 `consumerInCanary: true`；
`blockers` 列出独立运行阻塞。强制计费还要有正常套餐、正确币种及足够钱包余额。
价格 `quotedMinor` 为最小货币单位，1 表示该币种 0.01。
`upstreamVerified: false` 表示此次没有付费采集，因此不能据此声称供应商返回文章正常。
如价格已齐全而状态仍不可用，保留报告再做针对性处理，不重置熔断/未知账单或批量重试。
