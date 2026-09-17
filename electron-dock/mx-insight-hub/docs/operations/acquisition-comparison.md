# 数据中心：历史交付与新请求对比

采集查询复现的 GET 保持只读。Admin 可以在读取旧结果后，显式点击
“发送新请求并对比（可能计费）”。原响应、费用、requestId、幂等键继续显示，
新请求的响应、requestId、幂等键和费用另行显示。切换数据中心标签保留页面会话，
刷新整个页面则重新按 requestId 查询；不会自动发送或把比较记录写入浏览器存储。

当前支持已经通过 TikHub 执行的小红书单关键词 raw 搜索。公网兼容路径
`POST /api/v1/night-all/search/raw` 保留；满足 Hub 直连条件且运行策略启用时直接走
Hub → TikHub，不经过历史 Night-All。其他形状/平台仍按现有兼容路由策略处理，
不能把路径中的 night-all 当成物理上游，也不能声称整个兼容 API 都已迁移。

## 参数与身份

Migration 094 为 usage_requests 增加 nullable acquisition_request。
参数快照现在随 reservation 的同一条 INSERT 写入，因此它在任何上游动作之前就已存在，
幂等回放也无法改写它——不再需要 reserve 之后的第二次 UPDATE。覆盖范围是所有会建
usage_requests 的付费/计量分发点，而不只是 raw 分支。
`/api/v1/tools/tokenize` 是有意的例外：提交的文本本身就是敏感载荷，其用量证据被断言
不得包含该文本，复现方式是重新提交而不是从账本里读回来。
只保存 method/path/解析后的 body：Authorization、Admin Token、Idempotency-Key 和供应商
凭证根本不会传进来；另有兜底，`token`/`secret`/`apiKey`/`access_key` 等名字的字段值
写成 `[redacted]`。body 超过 16 KiB 时记为 `{bodyOmitted:'oversize', bodyBytes}`，
不做截断——截断过的参数既不能解析，也会被误当成完整参数。
新字段只通过 Admin 历史响应 requestEvidence.request 展示，不加入 Public acquisition projection。

对比通过既有 demo credential 机制引用原记录的 API Key；不恢复原 Key 秘密，
不创建 Key、不扩权。原 Key 失效或被撤销时不能换用默认身份发送。
实际业务请求仍经过固定公网兼容 API 的当前授权、配额、运行策略与计费检查。

### 旧记录：用指纹校验，而不是猜参数

旧记录的 acquisition_request 仍是 NULL，且指纹不可逆，Hub 不会反推参数。
`POST /internal/v1/admin/acquisitions/:requestId/verify-request` 接受一个候选
`{path, body}`，用与当初分发完全相同的规范化逻辑重算指纹并比对。
它是只读的：不调用上游、不计费、不修改历史记录，失败也不会泄露原参数。
校验通过即可证明该 JSON 规范化后与历史请求完全一致，对比记录标注为「已校验与原请求一致」；
未校验的仍标注「手动参数」，不作一致性声明。
适用范围与对比一致：Night-All 兼容搜索族的首页请求（`/api/v1/{night-all/,}search/{raw,crawl,user-info}`）。
延续游标需要当初 consumer 作用域的 codec，无法事后重建，会明确拒绝而不是给出错误结论。

## 交付条数核查

Night-All 在对 raw_data 去重之前就写好了 page.returnedCount，所以历史兼容路径交付的信封
可能自相矛盾（例如声明 20、实际 11 条）。Hub 不改上游的业务字段和计数，而是：

- 交付时比对声明值与实际数组长度，不一致则追加 `COUNT_DECLARATION_MISMATCH` 警告。
  该警告被显式排除在 partial 判定之外，不改变交付分类、fallback 窗口与计费单位
  （计费本来就按实际数组长度算，没有为幻影行付过费）。
- 读取时在 `delivered.countAudit` 现算同一份结论，因此**所有历史记录**（包括这次修复之前的）
  都能在复现面板看到「声明 N / 实际 M」。Hub 自己的直连投影三个计数同源，天然不会不一致，
  并有测试守住这条不变式。

要让「列表本身」满 20 条，属于另一件事：那需要上游在去重后补页，或 Hub 做跨页填充；
核查只保证 Hub 说的数和给的数一致。

## 幂等与结果边界

每次显式新请求生成独立 compare-UUID 幂等键，Hub 分配新的 requestId。
未收到响应、请求仍在处理中或结果未知时，保留该次参数和幂等键，只提供同键查询/重试，
不自动重试、不自动创建另一笔请求。收到明确响应后可以显式创建下一次比较。
新幂等键不意味着强制绕过缓存；界面优先展示交付账本的实际 sourceMode。
新响应收到后只读取一次历史证据，读取失败不会重新发送业务请求。

所有验证使用本机合成响应；此功能不自动修复历史费用或执行退款。
MX-H2I 登录、联网、Launcher 路由和供应商代理配置不受改动。
