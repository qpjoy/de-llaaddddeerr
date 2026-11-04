# B 站搜索缺省 result 的零结果页

## 已确认的原因

Hub 请求 `3e1956b1-89fe-4122-b04b-daa99789d55d` 的 TikHub 调用 `3c56edf1-7375-46bd-a47d-1c4d5eefad8b` 使用 `native.t.bilibili_web_fetch_general_search`。供应商 HTTP 200，但 Hub 记录为 `succeeded_unusable / invalid_content_search_contract`，向调用方保存了 HTTP 502。原请求是 `/api/v1/data/search`，第一页、20 条。

用户在生产执行的只读检查限定上述 usage、call、provider、operation，并验证受限归档为 1603 字节，SHA-256 为 `ec6010ef2fca230e794d90e182a980f9397b25043b808e1f4376b7eb88cc4164`。返回的字段类型和数值为：

```json
{
  "code": 200,
  "data": {
    "code": 0,
    "data": { "page": 1, "pagesize": 20, "numResults": 0, "numPages": 0 }
  }
}
```

此片段按补证重建，只展示相关字段，不是原始正文。三层均没有自己的 `result` 字段。业务成功且明确零结果，但旧解析器只有发现 `data.result` 才剥离 B 站内层包，随后把对象当成结果列表拒绝。

## 修复范围

只在 B 站固定搜索解析中兼容这种缺省空页：平台业务码必须是数字 `0`，内层 `result` 真正缺失，`numResults`、`numPages` 均为数字 `0`，`page`、`pagesize` 为正安全整数并匹配本次上游请求。不把 `null`、字符串数字、缺失计数、非零计数或冲突的列表/分页信息认成空页。

合格空页投影为空列表，`hasMore=false`，没有下一页参数或游标，不追加上游调用。供应商正文与受限字节归档不改写。B 站包解开前和解开后都检查业务码，避免外层错误码被丢弃。其他平台路由、授权、计费规则和重试策略不变。

原请求已提交，其保存的 502、调用、原始归档及账务保持不变；相同幂等键继续回放原响应。报告中的客户结算为 CNY `chargedMinor=1`（¥0.01）；供应商成本是估计值，不能据此独立确认实际扣款。此修复不回填成功状态，不退款、不重采旧页，也不使用 Twitter unknown 的准入处置。

## 发布与验收

在服务器 Hub 源码目录同步包含修复的代码，使用现有 Hub 独立发布流程：

```bash
MX_INSIGHT_SYNC_LAUNCHER=0 MX_SMOKE_DATA=0 bash scripts/manage.sh ops internal-production deploy
```

此次 B 站修复没有新增迁移、环境变量或共享服务配置。上述开关关闭 Launcher 同步及付费数据 smoke；MX-H2I 登录、联网与 SSO 不在改动范围内。

发布后在「诊断中心 → 限制与恢复」读取该请求当前保护状态，或使用管理员只读接口：

```text
GET /internal/v1/admin/admission-limits?requestId=3e1956b1-89fe-4122-b04b-daa99789d55d
```

检查精确调用的 `response_quarantine` 和 TikHub `provider_circuit`。当前工作流的解析失败可能累计供应商级熔断；不能只看 B 站。只对仍有效、且已确认由此次问题导致的保护使用现有管理员恢复入口；保留其目标、作用域、revision 和审计原因，不清空整个平台保护。已过期无需恢复，也不能强制清除 pending 或活跃租约。

等待下一次正常业务采集验收，新请求收到同样成功空页时应返回 200、空列表并结束分页。旧请求的历史 502 仍可查询，不能据此判断新版本未生效。重新采集可能产生费用，本次没有自动发起验证采购。

可选：本地构建独立诊断包，传到服务器后对原受限归档进行只读候选解析验证：

```bash
node scripts/build-content-search-diagnostic.mjs > /tmp/mx-hub-bilibili-empty-candidate.mjs
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
  node --input-type=module - 3e1956b1-89fe-4122-b04b-daa99789d55d \
  < /tmp/mx-hub-bilibili-empty-candidate.mjs
```

候选诊断只读数据库、校验归档后执行打包时的解析器，不采购、不改写原请求。它不重放完整供应商适配器；完整标准/raw 交付链路由本地合成响应回归验证。

## 验证状态

新增测试先在旧解析器复现正常空页失败及外层业务码漏检；修复后验证精确空页、异常计数/类型/页码、错误业务码、冲突续页信息、不可变证据，以及标准/raw 交付与幂等回放。生产原始正文没有下载到本机，本地用已核实字段重建测试响应。

最终契约、gateway 和诊断回归共 148 项通过，0 失败、0 跳过（诊断数据库测试启用本地 PGlite）；`npm run typecheck` 通过。独立复核补充外层已有 `result` 时保留其结果、不触发空页兼容的回归。候选诊断包已本地构建，尚未在生产原归档上执行。

当前为本地修复，尚未执行生产部署、恢复保护或付费查询。
