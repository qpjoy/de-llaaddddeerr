# 淘宝“华为笔记本”采集失败（2026-10-10）

## 已确认的结果

Hub Request ID：`3cd1a613-fd60-4bd2-9c30-e60c11c224d9`。
下游收到 `502 external_platform_rejected`。

运维按该 ID 读取原请求和归档，校验响应字节的 SHA-256 后，在 Public Pod 内
使用注入的归档响应重放 `JustOneAdapter`。未访问供应商、未重新计费，结果如下：

| 字段 | 历史账本 | 当前部署代码离线重放 |
| --- | --- | --- |
| outcome | rejected | rejected |
| HTTP status | 200 | 200 |
| businessCode | 301 | 301 |
| errorCode | upstream_collection_failed | upstream_collection_failed |
| billed | false | false |
| 耗时 | 50401 ms | 不用于评估线上耗时 |

离线重放还确认 `circuitCategory=upstream`、`affectsCircuit=true`、`retryable=false`，
与当前策略一致。JustOne 的[官方业务码说明](https://docs.justoneapi.com/zh/usage)
将 301 定义为采集失败、供应商不计费；客户扣费应独立查询客户账本，不能从采购字段推断。

本次 Hub 已收到供应商明确的业务失败。约 50.4 秒是此次调用耗时，
不能据此断言 JustOne 内部超时、Cookie 失效或目标平台风控。
这与 10 月 9 日没有收到 HTTP 响应的 transport_error 是不同证据类型。
离线重放未发现本次响应分类差异；它不能验证供应商现在的可用性。

部署后追加的只读查询确认原始消息为 `COLLECT FAILED, SEND REQUEST AGAIN`，
供应商 Request ID 为 `8508f6e0e83c441c8b5b1eba760105d8`，调用时间为
`2026-10-10T06:32:14.179Z` 至 `2026-10-10T06:33:04.590Z`。
`transport_failure=null`。原始消息也没有明确指出超时，不能把调用时长当作供应商超时阈值。

## Hub 改动

原先外层通用 502 没有保留“已确认采集失败”的原因，容易与网络异常混淆。
对经过 JustOne 适配器确认的 `rejected + 301 + upstream_collection_failed`，
继续返回 HTTP 502 和 `external_platform_rejected`，补充固定消息及以下字段：

```json
{
  "error": {
    "code": "external_platform_rejected",
    "message": "The data source reported a collection failure",
    "details": {
      "reasonCode": "upstream_collection_failed",
      "outcome": "rejected",
      "retryable": false
    }
  }
}
```

实际错误仍携带原有 Request ID。普通客户响应不暴露供应商名称、原始错误正文、
凭据或采购计费字段。未知业务码、其他供应商、网络 unknown 和解析失败保持原有语义。
Admin Token 请求诊断依据已有账本显示 301 的固定解释，无需读取额外原始正文。

保持原熔断、准入、预算、账本、缓存回退及幂等行为，不加入自动重试。
已提交的历史 502 继续原样重放，不追溯补写 reasonCode。同一个 Idempotency-Key
不能用来验证供应商恢复。MX-H2I 登录和联网不受影响。
本次改动是错误可诊断性修复，不能修复或掩盖供应商自身的采集失败；无需数据库迁移。

## 验证与上线

本地 158 项相关回归通过，覆盖 JustOne 合约/适配器、网关、公开 HTTP、归档、
native forwarding 和请求诊断。新增测试验证原因字段、脱敏、原账本与熔断、
单次分发、历史与新响应的幂等重放、unknown 优先及非匹配业务码不误分类。

运维已报告部署完成。服务器侧真实验收命令使用 LCY-delta 的 Hub Key，
`marketplace=taobao`、`query=华为笔记本`、`page=1`、`deliveryMode=live_only`，
每次测试仅允许一个新业务请求。最初提供的 `lcy-ecom-huawei-20261010-01`
没有回传执行结果，不能假定已执行。

部署后授权的验收使用 `lcy-ecom-huawei-20261010-02`，回传运行配置为供应商
`timeoutMs=120000`、预留 `leaseMs=180000`。客户端在 44 ms 后记录
`client_result_unknown / TypeError`，没有新 Request ID。该脚本只记录异常名称，
未区分请求头构造、连接和响应体读取阶段，因此不足以定位错误。
其账本查询使用旧 Request ID 加上可选的新 Request ID；本次只返回旧 301 记录，
**不能证明新幂等标识没有对应请求，也不能证明发生了第二次供应商失败**。

只读诊断在本地构造 Authorization 请求头检查格式（不输出 Key），
GET Pod 的 `/health/live`，并按已确认的 LCY-delta consumer ID 与新幂等标识
直接查询 `usage_requests` 及关联 JustOne 调用，不会发起商品采集。回传结果：

```json
{
  "keyCheck": { "nonEmpty": true, "asciiOnly": false, "headerValid": false },
  "listener": { "host": "0.0.0.0", "port": "18150" },
  "health": { "status": 200, "ms": 14 },
  "newLedger": []
}
```

本次验收阻塞已定位为输入的 Key 不能构造合法 Authorization 请求头；存活检查
正常且该幂等标识没有预留/调用记录。中文占位符未替换或复制夹带字符是可能来源，
未读取或输出实际凭据，不能进一步断定是哪一种。该结果不是新的供应商 301 失败。

修正验收命令改用 ASCII 占位符，发起请求前拒绝未替换占位符、非 ASCII 字符、
空白及空输入；错误输出保留阶段和有界底层错误码，账本始终按 consumer +
idempotency key 查询，不依赖客户端收到 Request ID。继续沿用
`lcy-ecom-huawei-20261010-02` 和原请求参数，只允许一次已授权业务分发，不自动重试。

修正 Key 后的单次真实验收已执行，结果未通过：

| 字段 | 新请求结果 |
| --- | --- |
| Hub Request ID | `e8961473-6b7c-4da9-9680-92ccb3096706` |
| 幂等标识 | `lcy-ecom-huawei-20261010-02` |
| 公开接口 | `502 external_platform_outcome_unknown`，耗时 10607 ms |
| usage / provider outcome | unknown / unknown |
| error_code | upstream_transport_error |
| 供应商调用耗时 | 10494 ms |
| HTTP / 业务码 / 供应商 Request ID | 均为 null |
| billed | null，计费结果未知 |

这是已通过 Hub 身份验证和准入后的传输失败，与旧请求已收到完整 301 响应不同。
随后只读查询归档 `01634f8b-fef2-44c0-8d3e-afb3872ca8cd`，确认底层证据：

```json
{"codes":["UND_ERR_CONNECT_TIMEOUT"],"phase":"request","elapsedMs":10492,"timeoutMs":120000,"deadlineExceeded":false}
```

失败调用为 `a74830ae-7281-478a-8a5c-c5edf8ee531d`，发生于
`2026-10-10T07:23:37.504Z` 至 `2026-10-10T07:23:48.009Z`。
运行时 Node v22.23.3、内置 undici 6.28.1。已确认连接阶段超时，且不是 Hub 的
120 秒总截止时间触发；尚不能据此定位具体 IP、TCP/TLS 阶段或机房链路责任。
保留此次 unknown 记录和原幂等标识，不自动重试、换标识或清除隔离。

供应商恢复验收未通过。若后续明确收到 301，保存对应 Hub/供应商请求关联 ID
和调用时间，由供应商排查采集链路，不通过换平台或返回空成功掩盖失败。

## 连接超时修复（待部署）

此前适配器只传入 120 秒 AbortSignal，未覆盖连接器独立的 10 秒默认值。
[Undici 连接器文档](https://raw.githubusercontent.com/nodejs/undici/v7.29.0/docs/docs/api/Connector.md)
及项目已安装版本的 `lib/core/connect.js` 均明确该独立默认值。
现在仅为 JustOne 创建独立 Agent，并在每次 dispatch 传入 dispatcher：

- 新增 `MX_INSIGHT_JUSTONE_CONNECT_TIMEOUT_MS`，默认 `min(30000, 总请求超时)`。
  显式值必须是正整数且不超过总超时；非法配置只禁用该可选供应商，部署预检会提前拒绝。
- 原总截止时间仍覆盖连接、等待响应和读取正文；连接预算不是额外增加到总时长上。
- K8s 部署脚本和 Compose 支持传入该配置，空值使用应用默认值。
  更新代码并重新构建部署 Hub 后即生效，无需数据库迁移；只设置旧镜像的环境变量无效。
- 关闭 Hub 时释放 JustOne 自有连接池；不修改全局 dispatcher、代理、DNS、TLS 校验、
  其他供应商或 MX-H2I 登录联网行为。
- 失败归档增加实际 `connectTimeoutMs`；不增加自动重试、不改旧 unknown 账本及计费/隔离。

这是连接等待配置修复，不等同于修复服务器出网或供应商节点故障。已提供对 DNS 返回
地址的逐个 TCP/TLS 握手探测（最多四个地址，每个 12 秒），不使用凭据，不发送 HTTP
采集请求。运维随后回传两条 DNS A 记录及探测结果：

| 地址 | TCP 连通耗时 | 完成 TLS 的累计耗时 | 结果 |
| --- | --- | --- | --- |
| `47.242.112.183` | 47 ms | 96 ms | OK |
| `8.210.230.99` | 43 ms | 149 ms | OK |

两个节点在此次探测时均可达且通过 TLS 校验，没有发现持续不可达的单个节点。
这不反证之前归档中的连接超时，也不证明商品采集恢复；具体故障节点、TCP/TLS
阶段和链路责任仍未确定。30 秒连接配置的部署及后续业务验收仍待确认。

本地 212 项相关回归全部通过，部署脚本测试通过。新增真实回环网络测试接受 TCP 后
故意不回应 TLS 握手，验证独立连接超时会产生正确错误码、仍只分发一次、保持计费未知，
并且不改变全局 dispatcher；配置测试覆盖短总截止时间、非法配置隔离及部署前拦截。

部署后可只读确认镜像中的有效配置（不创建 Adapter、不访问供应商）：

```bash
kubectl -n mx-insight-hub exec deploy/mx-insight-hub-public -c api -- node --input-type=module -e 'import{loadConfig}from"./server/config.mjs";const c=loadConfig();console.log(JSON.stringify({connectTimeoutMs:c.justOne.connectTimeoutMs,timeoutMs:c.justOne.timeoutMs,leaseMs:c.reservationLeaseMs,configurationError:c.justOne.configurationError?.code??null}));'
```

默认预期 `connectTimeoutMs=30000`、`timeoutMs=120000`、当前环境
`leaseMs=180000`、`configurationError=null`。这只验证代码/配置加载，不验证采集恢复。

运维实际回传 `connectTimeoutMs=null`（其他三项符合上述预期），说明当前 Pod 的
配置代码尚未包含新增字段，不能视为连接超时修复已上线。Internal Public 部署使用
`imagePullPolicy: Never`；需将修复代码同步到服务器，再通过 Hub 部署脚本重新构建、
导入本地镜像并更新工作负载。仅设置环境变量不能让旧代码支持新参数。

在服务器 Hub 目录执行下面的源码检查及部署命令；检查不通过时不会开始部署。
显式关闭 Launcher 同步，保持本次操作在 Hub 部署流程内：

```bash
node --input-type=module -e 'import{parseJustOneConfig}from"./server/external-platforms/config.mjs";if(parseJustOneConfig({}).connectTimeoutMs!==30000)throw new Error("Server source is outdated; sync the JustOne connection-timeout fix first");console.log("source_ready: connectTimeoutMs=30000");' && MX_INSIGHT_SYNC_LAUNCHER=0 bash scripts/manage.sh deploy
```

等待部署成功后重新执行上面的 Pod 配置查询；新配置生效仍不等同于供应商业务恢复。
