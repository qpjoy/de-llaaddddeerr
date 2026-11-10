# 企业数据接口：返回结构与 URL 字段（2026-11-10）

对应管理台「接口文档 → 数据服务 → 企业数据」。上游是启信慧眼（启信宝开放平台，`api.qixin.com`），Hub 经系统代理 / 固定 IP 中转访问。
本文只读整理，**没有发起任何真实企业查询**。字段名、类型和含义均来自代码和 Hub 内置的固定接口目录，没有用付费实测响应核对。

逐接口的请求参数和全部返回字段（274 个接口，8898 个字段行）放在附录：
[enterprise-data-response-fields-2026-11-10-appendix.md](enterprise-data-response-fields-2026-11-10-appendix.md)。

## 结论：有没有 URL

**有。** 但 1.31 企业模糊搜索（文档里的最小示例）的返回里没有 URL 字段。

- 274 个企业接口中，有 60 个在目录里声明了链接类字段，共 94 处。其中 59 个接口当前可调用；唯一例外是 55.82，它没有公开价，不能调用。
  - 图片 / Logo / 证照快照：23 处
  - 文件 / 附件 / 报告下载：11 处
  - 原文 / 来源 / 详情链接：37 处
  - 企业 / 机构网址：21 处
  - 域名：2 处
- 最常用到的几处：
  - 1.17 企业LOGO：`data.data.logo`
  - 47.51 / 55.29：`data.data.ent_info.logo_url`
  - 1.8 企业基础工商信息：`data.data.websites[].web_url`
  - 12.1 / 12.4 / 19.91 商标：商标图片
  - 8.4 专利详细：`annex`（附件）、`patent_img`（专利图片）
  - 10.1 / 10.4 新闻：`url`（原文链接）
  - 68.9 上市公司公告：`sourceurlcc`（公告 PDF）
  - 36.99 / 22.62 获取报告：`report_pdf`（报告 PDF 链接）
- **Hub 原样透传，不改写、不删除、不代理、不下载、不校验这些 URL。** 只有一处例外：响应中如果原样带回了 Hub 自己的启信凭据，会被替换为 `[REDACTED]`。凭据指 appkey、secret_key、本次请求的 sign 及其 URL 编码变体。见下文 §5.1。
- URL 的形式并不统一，Hub 不做规范化：
  - 有 `https://`，也有 `http://`。
  - 有不带协议的 `www.mi.cn`。
  - 86.42 声明为“附件url”，但目录示例只是一个文件名。
- 链接指向两类地方：
  - 启信的 OSS：`qxb-img-osscache.qixin.com`、`qxb-logo-url.oss-cn-hangzhou.aliyuncs.com`、`qxb-pdf-osscache.qixin.com` 等。
  - 政府或第三方站点：裁判文书网、国家企业信用信息公示系统、拉勾、搜狐等。

  这些链接能否访问、会不会过期，Hub 不保证，本次也没有实测。

## 1. 依据

| 内容 | 位置 |
| --- | --- |
| 公共路由 `POST /api/v1/data/enterprise/:apiId/query` | `server/app.mjs:6142` |
| 网关入口 `queryEnterprise` | `server/external-platforms/gateway.mjs:1393` |
| 请求校验、可调用判断、Hub 对目录的修正 | `server/contracts/enterprise.mjs` |
| 启信调用、状态判定、凭据回显脱敏、公共响应 | `server/adapters/qixin.mjs` |
| 外层 `requestId` / `meta` 拼装 | `server/external-platforms/gateway.mjs:155`（`deliveryBody`） |
| 接口文档页、OpenAPI 生成 | `server/contracts/enterprise-docs.mjs`，由 `server/public-docs.mjs:26` 引入 |
| 固定接口目录（请求/响应字段、示例） | `server/external-platforms/qixin-catalog.json`：18 类、274 个接口，目录快照 2026-09-01，价格与新增接口 2026-09-17 |
| 公开价（决定能否调用） | `shared/qixin-official-prices.mjs` |
| 出口路由（只影响请求发往哪里） | `server/external-platforms/proxy.mjs:292`（`createQixinProxyFetch`）、`server/external-platforms/egress-relay.mjs` |

Hub 的文档页、OpenAPI 和管理台「接口调试」都从同一份目录生成，所以“文档声明的字段”就是目录的声明。代码不按目录校验响应字段。实际返回以启信为准：可能比目录多字段，也可能少字段，见 §6。

## 2. 调用方式与外层结构

### 2.1 请求

```
POST {HUB_URL}/api/v1/data/enterprise/{apiId}/query
Authorization: Bearer <Hub Live Key，需 enterprise + enterprise.query>
Idempotency-Key: <8–128 字符；live_only / refresh 必填>
Content-Type: application/json

{ "query": { ... }, "body": { ... }, "method": "GET|POST", "deliveryMode": "live_only|cache_first|cache_only|refresh" }
```

- 顶层只接受 `query`、`body`、`method`、`deliveryMode` 四个键。`query` / `body` 只接受该接口目录里声明的字段，多一个字段就返回 400 `invalid_enterprise_request`（`enterprise.mjs:38-69`）。
- 字段名必须逐接口照抄。例如 1.31 用 `matchType`，19.91 用 `match_type`。
- Hub 路由始终是 POST。`method` 只决定 Hub 用什么方法请求启信，默认值是：目录方法里有 GET 就用 GET，否则用 POST。
- 没有公开价的接口直接返回 403 `enterprise_price_negotiated`（`enterprise.mjs:16-19`）。这样的接口有 14 个，见 §3。

### 2.2 成功响应（HTTP 200）

下面以 1.31 为例。业务部分取自目录示例，只保留 1 条。

```json
{
  "contractVersion": "mx-insight-hub.enterprise-query.v1",
  "apiId": "1.31",
  "data": {
    "status": "200",
    "message": "操作成功",
    "sign": "99ff6119e92ee89947d3c3547c51f710",
    "data": {
      "total": 345,
      "num": 10,
      "items": [
        { "name": "今日头条有限公司", "id": "ea17d0c8-81c5-4226-9704-97c55aa724c3",
          "start_date": "2016-08-24", "oper_name": "张利东", "reg_no": "110108021890807",
          "credit_no": "91110108MA007R7P8D", "matchType": "企业名称", "matchItems": "今日头条有限公司", "type": 0 }
      ]
    }
  },
  "requestId": "<uuid>",
  "meta": {
    "capturedAt": "2026-11-10T09:00:00.000Z",
    "resultState": "completed",
    "servedAt": "2026-11-10T09:00:00.120Z",
    "sourceMode": "live",
    "ageSeconds": 0,
    "reason": { "code": "live", "scope": "upstream", "summary": "Served from a fresh upstream call.", "degraded": false, "liveAttempted": true }
  }
}
```

| 路径（下游示例代码里的 `result.`） | 类型 | 生成方 | 含义 |
| --- | --- | --- | --- |
| `contractVersion` | string | Hub | 固定 `mx-insight-hub.enterprise-query.v1` |
| `apiId` | string | Hub | 接口编号，如 `1.31` |
| `requestId` | string(uuid) | Hub | Hub 请求 ID；可用于 `GET /api/v1/requests/{id}` 和 `GET /api/v1/acquisitions/{requestId}` |
| `data` | object | 启信，原样 | 启信完整业务响应，仅做凭据回显脱敏（`qixin.mjs:68-85,107`） |
| `data.status` | string | 启信 | 业务状态码，如 `"200"`；与 HTTP 状态不是一回事 |
| `data.message` | string | 启信 | 业务消息 |
| `data.sign` | string | 启信 | 启信的数据签名，不是 Hub 请求签名 |
| `data.data` | object / array | 启信 | 业务数据；结构逐接口不同，见附录 |
| `meta.capturedAt` | string(date-time) | Hub | 启信响应被 Hub 收到的时间；缓存命中时是原采集时间 |
| `meta.resultState` | `completed` / `no_data` / `pending` | Hub | 由业务 status 推出：200 → completed，201/206 → no_data，202/203 → pending（`qixin.mjs:108`） |
| `meta.servedAt` | string(date-time) | Hub | 本次交付时间 |
| `meta.sourceMode` | string | Hub | `live`、`fresh_cache`（一小时内缓存）、`stored_fallback`（存量回退） |
| `meta.ageSeconds` | integer | Hub | servedAt − capturedAt |
| `meta.reason` | object | Hub | `{code, scope, summary, degraded, liveAttempted, detail?}`，说明本次交付来源 |
| `meta.fallbackReason` | string | Hub | 仅回退交付时出现，如 `cache_only` |

响应头包括 `idempotent-replay`、`x-mx-insight-request-id`、`x-mx-insight-source-mode`（`app.mjs:6152-6155`）。

业务状态的判定在 `qixin.mjs:90-94`：

| 启信返回 | Hub 结果 |
| --- | --- |
| HTTP 200，业务 status ∈ {200, 201, 202, 203, 206} | HTTP 200，按上表给出 `resultState` |
| HTTP 200，业务 status 是其他三位数（如 104 未加白名单、208） | 失败，内部码 `enterprise_query_rejected`，对外 502 `external_platform_rejected` |
| HTTP ≥ 500、正文不是 JSON，或 status 缺失 / 不是三位数 | 失败，内部码 `enterprise_outcome_unknown`，对外 502 `external_platform_outcome_unknown` |
| HTTP 429 | 对外按供应商容量错误处理 |
| 正文超过 16 MiB | `enterprise_response_too_large`，按结果未知处理 |

对外错误码的映射见 `gateway.mjs` 的 `publicFailure`（约 `:236-346`）。错误响应体是 `{ "error": { "code", "message", "details"? }, "requestId" }`。

### 2.3 缓存、幂等重放与留存

响应正文在以下几条路径上都相同，URL 也就保持原样：

- **缓存交付**：`cache_first`、`cache_only` 和 `refresh` 的回退交付读的是首次采集保存的快照（`gateway.mjs:2221` 存，`:1703` 等处取）。外层同样经过 `deliveryBody`，`data` 与首次采集一致。
- **幂等重放**：同一个 Idempotency-Key 重放时，返回首次交付的原样正文。
- **留存查询**：`GET /api/v1/acquisitions/{requestId}` 的 `delivered.responseBody` 是同一份交付正文（`acquisitions/history-store.mjs:336`）。它的 `items[]` 只给观察 ID、外部 ID 等元数据，不含 URL。
- **Canonical 观察**：Hub 为每次企业响应写一条观察记录，其 `url` 固定为 `null`，整份响应放在 `extensions.response`（`qixin.mjs:96-105`）。也就是说，Hub 不从企业响应里抽取 URL，也不建立 URL 索引。

## 3. 接口清单

共 18 类、274 个接口。Hub 路径统一为 `POST /api/v1/data/enterprise/{编号}/query`。

- **可调用**：260 个。其中 5 个公开价为 0：36.99、22.62、2.3、60.2、33.11。
- **不可调用**：14 个，都没有公开价，返回 403 `enterprise_price_negotiated`：55.82、35.86、33.14、12.62、30.3、30.4、55.55、82.1、82.3、79.22、79.23、66.21、72.51、79.39。
- 表中“上游方法”就是请求里 `method` 的默认值和可选值。
- “主要请求参数”列出全部目录参数，`*` 为必填。必填标志已按 Hub 的修正处理：19.91 的 `match_type`，以及 42.3 body 里的 `industry`、`regist_capi`、`status`，目录标了必填，但说明写“选填”，Hub 改为选填（`enterprise.mjs:20`）。66.35 与 22.11 是“二选一至少一个”（`enterprise.mjs:21`）。

#### 业务场景（7 个）

| 编号 | 名称 | Hub 路径（POST） | 上游方法 | 可调用 | 主要请求参数（`*` 为必填） |
| --- | --- | --- | --- | --- | --- |
| 47.51 | 客户信息尽调 | `/api/v1/data/enterprise/47.51/query` | GET（可选 GET/POST） | 是 | query: `keyword`*, `dimension`, `is_history` |
| 55.29 | 合作风险排查 | `/api/v1/data/enterprise/55.29/query` | GET（可选 GET/POST） | 是 | query: `keyword`*, `dimension`, `is_history` |
| 51.17 | 董监高信息洞察 | `/api/v1/data/enterprise/51.17/query` | GET（可选 GET/POST） | 是 | query: `keyword`*, `p_name`*, `dimension`, `is_history` |
| 55.82 | 企业信用全景报告-JOB申请 | `/api/v1/data/enterprise/55.82/query` | GET | 否（面议） | query: `keyword`*, `time_range`, `dimension`, `include_history`, `report_format` |
| 36.99 | 企业信用全景报告-获取报告 | `/api/v1/data/enterprise/36.99/query` | GET | 是 | query: `report_id`* |
| 35.86 | 董监高信息洞察报告-JOB申请 | `/api/v1/data/enterprise/35.86/query` | GET | 否（面议） | query: `keyword`*, `p_name`*, `time_range`, `dimension`, `include_history`, `report_format` |
| 22.62 | 董监高信息洞察报告-获取报告 | `/api/v1/data/enterprise/22.62/query` | GET | 是 | query: `report_id`* |

#### 搜索查询（4 个）

| 编号 | 名称 | Hub 路径（POST） | 上游方法 | 可调用 | 主要请求参数（`*` 为必填） |
| --- | --- | --- | --- | --- | --- |
| 1.31 | 企业模糊搜索 | `/api/v1/data/enterprise/1.31/query` | GET | 是 | query: `keyword`*, `matchType`, `region`, `skip` |
| 1.2 | 企业高级搜索 | `/api/v1/data/enterprise/1.2/query` | GET | 是 | query: `keyword`*, `skip`, `method`, `org_type`, `area_code`, `industry_code`, `econ_type`, `capi_from`, `capi_to`, `date_from`, `date_to`, `status`, `canbao_from`, `canbao_to` |
| 21.92 | 招投标信息搜索 | `/api/v1/data/enterprise/21.92/query` | GET | 是 | query: `keyword`*, `search_scope`, `notice_type`, `start_date`, `end_date`, `district_code`, `project_type`, `budget_amt_from`, `budget_amt_to`, `bid_amt_from`, `bid_amt_to`, `skip` |
| 19.91 | 商标信息搜索 | `/api/v1/data/enterprise/19.91/query` | GET | 是 | query: `keyword`*, `match_type`, `date_from`, `date_to`, `type_num`, `trademark_status_simplified`, `skip` |

#### 工商信息（50 个）

| 编号 | 名称 | Hub 路径（POST） | 上游方法 | 可调用 | 主要请求参数（`*` 为必填） |
| --- | --- | --- | --- | --- | --- |
| 1.41 | 工商照面 | `/api/v1/data/enterprise/1.41/query` | GET | 是 | query: `keyword`* |
| 79.36 | 新增企业 | `/api/v1/data/enterprise/79.36/query` | GET | 是 | query: `province_code`*, `created_date`, `district_code`, `start_date`, `industry_code`, `category`, `skip` |
| 1.43 | 工商股东 | `/api/v1/data/enterprise/1.43/query` | GET | 是 | query: `keyword`*, `skip` |
| 37.17 | 对外投资信息 | `/api/v1/data/enterprise/37.17/query` | GET | 是 | query: `name`*, `skip` |
| 57.18 | 最优股比信息 | `/api/v1/data/enterprise/57.18/query` | GET | 是 | query: `name`*, `skip` |
| 1.50 | 工商股东（工商公示） | `/api/v1/data/enterprise/1.50/query` | GET | 是 | query: `keyword`*, `skip` |
| 34.3 | 股权变更（工商公示） | `/api/v1/data/enterprise/34.3/query` | GET | 是 | query: `name`*, `skip` |
| 1.45 | 主要人员 | `/api/v1/data/enterprise/1.45/query` | GET | 是 | query: `keyword`*, `skip` |
| 1.8 | 企业基础工商信息 | `/api/v1/data/enterprise/1.8/query` | GET | 是 | query: `keyword`* |
| 1.47 | 变更记录 | `/api/v1/data/enterprise/1.47/query` | GET | 是 | query: `keyword`*, `skip`, `type_code` |
| 1.51 | 企业联系方式 | `/api/v1/data/enterprise/1.51/query` | GET | 是 | query: `keyword`* |
| 1.49 | 分支机构 | `/api/v1/data/enterprise/1.49/query` | GET | 是 | query: `keyword`*, `skip` |
| 79.18 | 分支机构所属总公司核查 | `/api/v1/data/enterprise/79.18/query` | GET | 是 | query: `name`* |
| 1.53 | 企业年报网址 | `/api/v1/data/enterprise/1.53/query` | GET | 是 | query: `keyword`*, `skip` |
| 3.1 | 工商年报 | `/api/v1/data/enterprise/3.1/query` | GET | 是 | query: `keyword`* |
| 1.16 | 企业简介 | `/api/v1/data/enterprise/1.16/query` | GET | 是 | query: `name`* |
| 1.17 | 企业LOGO | `/api/v1/data/enterprise/1.17/query` | GET | 是 | query: `name`* |
| 3.3 | 社保信息 | `/api/v1/data/enterprise/3.3/query` | GET | 是 | query: `keyword`* |
| 1.32 | 企业名/法定代表人名称二要素验证 | `/api/v1/data/enterprise/1.32/query` | GET | 是 | query: `name`*, `oper`* |
| 91.59 | 企业名/统一社会信用代码二要素验证 | `/api/v1/data/enterprise/91.59/query` | GET | 是 | query: `name`*, `creditNo`* |
| 1.27 | 三要素验证 | `/api/v1/data/enterprise/1.27/query` | GET | 是 | query: `name`*, `code`*, `oper`* |
| 1.30 | 四要素验证 | `/api/v1/data/enterprise/1.30/query` | GET | 是 | query: `name`*, `code`*, `oper`*, `start`*, `end` |
| 35.2 | 律所基本信息 | `/api/v1/data/enterprise/35.2/query` | GET | 是 | query: `keyword`* |
| 47.96 | 事业单位基本信息 | `/api/v1/data/enterprise/47.96/query` | GET（可选 GET/POST） | 是 | query: `keyword`* |
| 36.2 | 社会组织基本信息 | `/api/v1/data/enterprise/36.2/query` | GET | 是 | query: `keyword`* |
| 88.49 | 基金会基本信息 | `/api/v1/data/enterprise/88.49/query` | GET | 是 | query: `keyword`* |
| 46.1 | 香港企业信息 | `/api/v1/data/enterprise/46.1/query` | GET | 是 | query: `keyword`* |
| 59.5 | 主要人员对外投资任职信息 | `/api/v1/data/enterprise/59.5/query` | GET | 是 | query: `company`*, `name`* |
| 2.1 | 工商实时信息 | `/api/v1/data/enterprise/2.1/query` | GET | 是 | query: `keyword`*, `province` |
| 2.3 | 工商实时JOB状态 | `/api/v1/data/enterprise/2.3/query` | GET | 是 | query: `jobid`* |
| 60.1 | 小微企业-JOB申请 | `/api/v1/data/enterprise/60.1/query` | GET | 是 | query: `keyword`* |
| 60.2 | 小微企业-详情数据 | `/api/v1/data/enterprise/60.2/query` | GET | 是 | query: `jobid`* |
| 42.1 | 附近企业查询 | `/api/v1/data/enterprise/42.1/query` | GET | 是 | query: `keyword`*, `skip`, `distance`* |
| 42.3 | 周边企业总数 | `/api/v1/data/enterprise/42.3/query` | POST | 是 | body: `longitude`*, `latitude`*, `radius`*, `industry`, `regist_capi`, `status` |
| 42.4 | 周边企业详情 | `/api/v1/data/enterprise/42.4/query` | POST | 是 | body: `longitude`*, `latitude`*, `radius`*, `industry`, `regist_capi`, `status`, `skip` |
| 42.9 | 企业坐标 | `/api/v1/data/enterprise/42.9/query` | GET | 是 | query: `name`*, `type` |
| 93.16 | 企业工商风险扫描 | `/api/v1/data/enterprise/93.16/query` | GET | 是 | query: `name`* |
| 93.17 | 企业关联信息汇总 | `/api/v1/data/enterprise/93.17/query` | GET | 是 | query: `name`* |
| 79.11 | 企业性质（资本背景） | `/api/v1/data/enterprise/79.11/query` | GET | 是 | query: `name`* |
| 79.12 | 企业规模 | `/api/v1/data/enterprise/79.12/query` | GET | 是 | query: `name`* |
| 79.13 | 企业行业（国民经济分类） | `/api/v1/data/enterprise/79.13/query` | GET | 是 | query: `name`* |
| 79.34 | 企业三码 | `/api/v1/data/enterprise/79.34/query` | GET | 是 | query: `name`*, `skip` |
| 79.26 | 企业迁移情况 | `/api/v1/data/enterprise/79.26/query` | GET | 是 | query: `name`*, `skip` |
| 24.28 | 企业历史名称 | `/api/v1/data/enterprise/24.28/query` | GET | 是 | query: `keyword`*, `skip` |
| 21.47 | 减资公告 | `/api/v1/data/enterprise/21.47/query` | GET（可选 GET/POST） | 是 | query: `keyword`*, `skip` |
| 91.66 | 企业主体性质（司库） | `/api/v1/data/enterprise/91.66/query` | GET | 是 | query: `keyword`* |
| 64.13 | 规上企业 | `/api/v1/data/enterprise/64.13/query` | GET（可选 GET/POST） | 是 | query: `keyword`* |
| 51.39 | 小微企业 | `/api/v1/data/enterprise/51.39/query` | GET | 是 | query: `keyword`* |
| 77.58 | 医院信息 | `/api/v1/data/enterprise/77.58/query` | GET | 是 | query: `keyword`*, `skip` |
| 77.51 | 企业历史法人 | `/api/v1/data/enterprise/77.51/query` | GET | 是 | query: `keyword`*, `skip` |

#### 司法风险（21 个）

| 编号 | 名称 | Hub 路径（POST） | 上游方法 | 可调用 | 主要请求参数（`*` 为必填） |
| --- | --- | --- | --- | --- | --- |
| 47.4 | 立案信息 | `/api/v1/data/enterprise/47.4/query` | GET | 是 | query: `keyword`*, `skip` |
| 17.5 | 被执行企业 | `/api/v1/data/enterprise/17.5/query` | GET | 是 | query: `name`*, `skip` |
| 5.5 | 失信被执行企业 | `/api/v1/data/enterprise/5.5/query` | GET | 是 | query: `keyword`*, `skip` |
| 19.1 | 开庭公告 | `/api/v1/data/enterprise/19.1/query` | GET | 是 | query: `name`*, `skip` |
| 9.1 | 法院公告 | `/api/v1/data/enterprise/9.1/query` | GET | 是 | query: `name`*, `skip` |
| 62.89 | 送达公告 | `/api/v1/data/enterprise/62.89/query` | GET | 是 | query: `keyword`*, `skip` |
| 6.5 | 行贿违法 | `/api/v1/data/enterprise/6.5/query` | GET | 是 | query: `name`*, `skip` |
| 66.1 | 限制高消费 | `/api/v1/data/enterprise/66.1/query` | GET | 是 | query: `ename`*, `pname`, `skip` |
| 7.1 | 司法拍卖 | `/api/v1/data/enterprise/7.1/query` | GET | 是 | query: `name`*, `skip` |
| 51.4 | 破产案件 | `/api/v1/data/enterprise/51.4/query` | GET（可选 GET/POST） | 是 | query: `name`*, `skip` |
| 51.5 | 破产公告 | `/api/v1/data/enterprise/51.5/query` | GET | 是 | query: `id`* |
| 61.75 | 询价评估 | `/api/v1/data/enterprise/61.75/query` | GET（可选 GET/POST） | 是 | query: `keyword`*, `type` |
| 98.98 | 限制出境核查 | `/api/v1/data/enterprise/98.98/query` | GET | 是 | query: `keyword`*, `skip` |
| 6.6 | 整体诉讼 | `/api/v1/data/enterprise/6.6/query` | GET | 是 | query: `name`* |
| 6.4 | 涉诉统计信息 | `/api/v1/data/enterprise/6.4/query` | GET | 是 | query: `keyword`* |
| 85.71 | 案件串联 | `/api/v1/data/enterprise/85.71/query` | GET（可选 GET/POST） | 是 | query: `keyword`*, `skip` |
| 18.39 | 案件流程节点 | `/api/v1/data/enterprise/18.39/query` | GET | 是 | query: `case_id`*, `skip` |
| 27.59 | 企业风险统计 | `/api/v1/data/enterprise/27.59/query` | GET | 是 | query: `keyword`* |
| 39.38 | 受贿违法 | `/api/v1/data/enterprise/39.38/query` | GET | 是 | query: `keyword`*, `skip` |
| 99.68 | 董监高被执行 | `/api/v1/data/enterprise/99.68/query` | GET | 是 | query: `keyword`*, `p_name`*, `skip` |
| 16.53 | 董监高失信被执行 | `/api/v1/data/enterprise/16.53/query` | GET | 是 | query: `keyword`*, `p_name`*, `skip` |

#### 经营风险（25 个）

| 编号 | 名称 | Hub 路径（POST） | 上游方法 | 可调用 | 主要请求参数（`*` 为必填） |
| --- | --- | --- | --- | --- | --- |
| 32.1 | 行政处罚 | `/api/v1/data/enterprise/32.1/query` | GET | 是 | query: `keyword`*, `skip` |
| 67.1 | 终本案件 | `/api/v1/data/enterprise/67.1/query` | GET | 是 | query: `keyword`*, `skip` |
| 25.1 | 动产抵押 | `/api/v1/data/enterprise/25.1/query` | GET | 是 | query: `name`*, `skip` |
| 26.1 | 股权出质 | `/api/v1/data/enterprise/26.1/query` | GET | 是 | query: `name`*, `skip` |
| 34.1 | 股权冻结 | `/api/v1/data/enterprise/34.1/query` | GET | 是 | query: `name`*, `skip` |
| 1.55 | 经营异常 | `/api/v1/data/enterprise/1.55/query` | GET | 是 | query: `keyword`*, `skip` |
| 56.1 | 严重违法 | `/api/v1/data/enterprise/56.1/query` | GET | 是 | query: `name`* |
| 20.1 | 欠税信息 | `/api/v1/data/enterprise/20.1/query` | GET | 是 | query: `name`*, `skip` |
| 20.11 | 欠税合计 | `/api/v1/data/enterprise/20.11/query` | GET | 是 | query: `name`* |
| 63.2 | 非正常户 | `/api/v1/data/enterprise/63.2/query` | GET | 是 | query: `name`* |
| 20.3 | 重大税收违法 | `/api/v1/data/enterprise/20.3/query` | GET | 是 | query: `name`*, `skip` |
| 79.17 | 产品投诉情况 | `/api/v1/data/enterprise/79.17/query` | GET | 是 | query: `name`*, `start_date`, `end_date`, `skip` |
| 1.35 | 工商清算组人员 | `/api/v1/data/enterprise/1.35/query` | GET | 是 | query: `name`* |
| 22.8 | 企业工程不良行为 | `/api/v1/data/enterprise/22.8/query` | GET | 是 | query: `name`* |
| 12.5 | 知识产权出质 | `/api/v1/data/enterprise/12.5/query` | GET | 是 | query: `name`*, `skip` |
| 51.1 | 环保处罚列表 | `/api/v1/data/enterprise/51.1/query` | GET | 是 | query: `name`*, `skip` |
| 51.3 | 环保处罚详情 | `/api/v1/data/enterprise/51.3/query` | GET | 是 | query: `id`* |
| 66.36 | 食品安全 | `/api/v1/data/enterprise/66.36/query` | GET | 是 | query: `keyword`*, `skip`, `type` |
| 66.34 | 产品召回 | `/api/v1/data/enterprise/66.34/query` | GET | 是 | query: `keyword`*, `skip` |
| 66.35 | 未准入境 | `/api/v1/data/enterprise/66.35/query` | GET | 是 | query: `keyword`, `import_keyword`, `skip`；（`keyword` / `import_keyword` 至少一个） |
| 66.56 | 违法违规建设 | `/api/v1/data/enterprise/66.56/query` | GET（可选 GET/POST） | 是 | query: `keyword`*, `skip` |
| 40.2 | 司法协助 | `/api/v1/data/enterprise/40.2/query` | GET | 是 | query: `name`*, `skip`, `type_code` |
| 36.53 | 注销备案 | `/api/v1/data/enterprise/36.53/query` | GET | 是 | query: `keyword`*, `skip` |
| 69.75 | 外部黑名单 | `/api/v1/data/enterprise/69.75/query` | GET | 是 | query: `keyword`*, `skip` |
| 23.47 | 涉嫌冒用他人身份登记信息 | `/api/v1/data/enterprise/23.47/query` | GET | 是 | query: `keyword`*, `skip` |

#### 经营信息（26 个）

| 编号 | 名称 | Hub 路径（POST） | 上游方法 | 可调用 | 主要请求参数（`*` 为必填） |
| --- | --- | --- | --- | --- | --- |
| 39.2 | 行政许可 | `/api/v1/data/enterprise/39.2/query` | GET | 是 | query: `name`*, `skip` |
| 38.2 | 抽查检查 | `/api/v1/data/enterprise/38.2/query` | GET | 是 | query: `name`*, `skip` |
| 52.1 | 纳税A级 | `/api/v1/data/enterprise/52.1/query` | GET | 是 | query: `keyword`* |
| 21.4 | 招投标列表 | `/api/v1/data/enterprise/21.4/query` | GET | 是 | query: `name`*, `type`, `role`, `publish_year`, `skip` |
| 21.6 | 招投标详情 | `/api/v1/data/enterprise/21.6/query` | GET | 是 | query: `id`* |
| 11.1 | 招聘信息 | `/api/v1/data/enterprise/11.1/query` | GET | 是 | query: `name`*, `skip` |
| 53.1 | 进出口企业查询 | `/api/v1/data/enterprise/53.1/query` | GET | 是 | query: `name`* |
| 76.1 | 简易注销 | `/api/v1/data/enterprise/76.1/query` | GET | 是 | query: `name`* |
| 52.3 | 纳税人类型 | `/api/v1/data/enterprise/52.3/query` | GET | 是 | query: `keyword`* |
| 43.4 | 主体信用评级 | `/api/v1/data/enterprise/43.4/query` | GET | 是 | query: `name`* |
| 43.5 | 债券信用评级 | `/api/v1/data/enterprise/43.5/query` | GET | 是 | query: `name`* |
| 38.3 | 双随机抽查 | `/api/v1/data/enterprise/38.3/query` | GET | 是 | query: `name`*, `skip` |
| 79.16 | 微信公众号 | `/api/v1/data/enterprise/79.16/query` | GET | 是 | query: `name`*, `skip` |
| 79.15 | 环境信用评级 | `/api/v1/data/enterprise/79.15/query` | GET | 是 | query: `name`*, `year`, `skip` |
| 79.32 | 园区信息 | `/api/v1/data/enterprise/79.32/query` | GET | 是 | query: `park_name`* |
| 79.31 | 企业所属园区 | `/api/v1/data/enterprise/79.31/query` | GET | 是 | query: `name`*, `skip` |
| 79.33 | 园区企业 | `/api/v1/data/enterprise/79.33/query` | GET | 是 | query: `park_name`*, `status_code`, `start_date`, `skip` |
| 66.33 | 财产线索查询 | `/api/v1/data/enterprise/66.33/query` | GET | 是 | query: `keyword`*, `skip` |
| 95.16 | 产品质量监督抽查结果 | `/api/v1/data/enterprise/95.16/query` | GET（可选 GET/POST） | 是 | query: `producer_name`*, `skip` |
| 57.83 | 进出口信用评级 | `/api/v1/data/enterprise/57.83/query` | GET | 是 | query: `keyword`*, `skip` |
| 88.24 | 企业所属开发区 | `/api/v1/data/enterprise/88.24/query` | GET | 是 | query: `keyword`*, `skip` |
| 36.38 | 开发区基本信息 | `/api/v1/data/enterprise/36.38/query` | GET | 是 | query: `zone_name`*, `skip` |
| 96.51 | 开发区企业 | `/api/v1/data/enterprise/96.51/query` | GET | 是 | query: `zone_name`*, `skip` |
| 15.72 | 票据承兑 | `/api/v1/data/enterprise/15.72/query` | GET | 是 | query: `keyword`*, `skip` |
| 23.48 | 营销商机线索 | `/api/v1/data/enterprise/23.48/query` | GET | 是 | query: `keyword`*, `skip` |
| 52.68 | 纳税人状态 | `/api/v1/data/enterprise/52.68/query` | GET | 是 | query: `keyword`*, `skip` |

#### 知识产权（20 个）

| 编号 | 名称 | Hub 路径（POST） | 上游方法 | 可调用 | 主要请求参数（`*` 为必填） |
| --- | --- | --- | --- | --- | --- |
| 79.37 | 知识产权统计 | `/api/v1/data/enterprise/79.37/query` | GET | 是 | query: `name`* |
| 12.1 | 商标列表 | `/api/v1/data/enterprise/12.1/query` | GET | 是 | query: `name`*, `skip` |
| 12.4 | 商标详细 | `/api/v1/data/enterprise/12.4/query` | GET | 是 | query: `number`*, `type_num` |
| 8.1 | 专利列表 | `/api/v1/data/enterprise/8.1/query` | GET | 是 | query: `name`*, `skip`, `role_code`, `role_history` |
| 8.4 | 专利详细 | `/api/v1/data/enterprise/8.4/query` | GET | 是 | query: `number`* |
| 79.25 | 电信许可 | `/api/v1/data/enterprise/79.25/query` | GET | 是 | query: `name`*, `skip` |
| 79.24 | 金融资质 | `/api/v1/data/enterprise/79.24/query` | GET | 是 | query: `name`* |
| 14.1 | 著作权 | `/api/v1/data/enterprise/14.1/query` | GET | 是 | query: `name`*, `skip`, `approval_date_start`, `approval_date_end` |
| 15.1 | 软件著作权 | `/api/v1/data/enterprise/15.1/query` | GET | 是 | query: `name`*, `skip` |
| 16.1 | 域名信息 | `/api/v1/data/enterprise/16.1/query` | GET | 是 | query: `name`* |
| 22.1 | 资质信息 | `/api/v1/data/enterprise/22.1/query` | GET | 是 | query: `name`*, `skip`, `type` |
| 22.11 | 资质证书详情 | `/api/v1/data/enterprise/22.11/query` | GET | 是 | query: `kind`*, `kind_id`, `register_no`；（`kind_id` / `register_no` 至少一个） |
| 79.21 | 标准制定 | `/api/v1/data/enterprise/79.21/query` | GET | 是 | query: `name`*, `skip`, `standard_type_code` |
| 22.6 | 工程资质资格 | `/api/v1/data/enterprise/22.6/query` | GET | 是 | query: `name`*, `skip` |
| 22.10 | 高新技术企业资质 | `/api/v1/data/enterprise/22.10/query` | GET | 是 | query: `name`*, `skip` |
| 22.3 | 食品生产许可证SC | `/api/v1/data/enterprise/22.3/query` | GET | 是 | query: `name`* |
| 22.4 | 食品生产许可证QS | `/api/v1/data/enterprise/22.4/query` | GET | 是 | query: `name`* |
| 22.5 | 食品添加剂生产许可证 | `/api/v1/data/enterprise/22.5/query` | GET | 是 | query: `name`* |
| 51.71 | 国际专利列表 | `/api/v1/data/enterprise/51.71/query` | GET | 是 | query: `keyword`*, `skip` |
| 15.44 | 国际专利详情 | `/api/v1/data/enterprise/15.44/query` | GET | 是 | query: `pub_num`* |

#### 关联关系（21 个）

| 编号 | 名称 | Hub 路径（POST） | 上游方法 | 可调用 | 主要请求参数（`*` 为必填） |
| --- | --- | --- | --- | --- | --- |
| 41.1 | 企业链图 | `/api/v1/data/enterprise/41.1/query` | GET | 是 | query: `keyword`* |
| 55.5 | 实际控制人 | `/api/v1/data/enterprise/55.5/query` | GET | 是 | query: `name`* |
| 77.76 | 参股控股企业 | `/api/v1/data/enterprise/77.76/query` | GET | 是 | query: `keyword`*, `skip`, `pname` |
| 33.13 | 实际控制企业 | `/api/v1/data/enterprise/33.13/query` | GET | 是 | query: `name`* |
| 44.2 | 股权穿透（三层股东） | `/api/v1/data/enterprise/44.2/query` | GET | 是 | query: `name`* |
| 55.2 | 股权穿透（十层股东） | `/api/v1/data/enterprise/55.2/query` | GET | 是 | query: `name`* |
| 33.15 | 股权穿透信息（股东穿透） | `/api/v1/data/enterprise/33.15/query` | GET | 是 | query: `name`* |
| 2.53 | 企业族谱穿透信息 | `/api/v1/data/enterprise/2.53/query` | GET | 是 | query: `name`*, `direction`*, `level`, `totpercent`, `form` |
| 28.1 | 三层族谱 | `/api/v1/data/enterprise/28.1/query` | GET | 是 | query: `name`* |
| 28.3 | 六层族谱 | `/api/v1/data/enterprise/28.3/query` | GET | 是 | query: `name`* |
| 33.12 | 关联企业 | `/api/v1/data/enterprise/33.12/query` | GET | 是 | query: `name`*, `relationship_type`, `relationship_level` |
| 33.9 | 疑似关联方查询 | `/api/v1/data/enterprise/33.9/query` | GET | 是 | query: `name`* |
| 45.93 | 两家企业间关联关系排查 | `/api/v1/data/enterprise/45.93/query` | GET | 是 | query: `keywordone`*, `keywordtwo`*, `relation`, `level` |
| 33.10 | 企业间找关系-JOB申请 | `/api/v1/data/enterprise/33.10/query` | GET | 是 | query: `enterprises`*, `persons`, `relations`, `level`, `containSuspect`, `suspect_relations`, `path` |
| 33.11 | 企业间找关系-详细数据 | `/api/v1/data/enterprise/33.11/query` | GET | 是 | query: `key`* |
| 22.36 | 多家企业间找关系job申请-50家 | `/api/v1/data/enterprise/22.36/query` | POST | 是 | body: `keywords`*, `is_execute`*, `relations`, `level` |
| 61.77 | 多家企业间找关系详情-50家 | `/api/v1/data/enterprise/61.77/query` | GET（可选 GET/POST） | 是 | query: `job_id`*, `skip` |
| 33.14 | 关联方认定 | `/api/v1/data/enterprise/33.14/query` | GET | 否（面议） | query: `name`* |
| 62.1 | 同电话企业 | `/api/v1/data/enterprise/62.1/query` | GET | 是 | query: `phone`* |
| 27.39 | 十大受益人 | `/api/v1/data/enterprise/27.39/query` | GET | 是 | query: `keyword`* |
| 12.62 | 受益所有人 | `/api/v1/data/enterprise/12.62/query` | GET | 否（面议） | query: `keyword`*, `is_far` |

#### 企业报告（1 个）

| 编号 | 名称 | Hub 路径（POST） | 上游方法 | 可调用 | 主要请求参数（`*` 为必填） |
| --- | --- | --- | --- | --- | --- |
| 1.13 | 企业图谱信息 | `/api/v1/data/enterprise/1.13/query` | GET | 是 | query: `keyword`* |

#### 企业评分（15 个）

| 编号 | 名称 | Hub 路径（POST） | 上游方法 | 可调用 | 主要请求参数（`*` 为必填） |
| --- | --- | --- | --- | --- | --- |
| 30.3 | 启信分 | `/api/v1/data/enterprise/30.3/query` | GET | 否（面议） | query: `name`*, `incl_branches` |
| 30.4 | 启信分详情 | `/api/v1/data/enterprise/30.4/query` | GET | 否（面议） | query: `name`*, `incl_branches` |
| 55.55 | 启信分波动 | `/api/v1/data/enterprise/55.55/query` | GET | 否（面议） | query: `keyword`*, `skip` |
| 82.1 | 企业空壳指数 | `/api/v1/data/enterprise/82.1/query` | GET | 否（面议） | query: `name`* |
| 82.3 | 企业空壳指数详情 | `/api/v1/data/enterprise/82.3/query` | GET | 否（面议） | query: `name`* |
| 79.22 | 司法风险评分 | `/api/v1/data/enterprise/79.22/query` | GET | 否（面议） | query: `name`*, `risk_type` |
| 79.23 | 司法风险评分详情 | `/api/v1/data/enterprise/79.23/query` | GET | 否（面议） | query: `name`*, `risk_type`* |
| 66.21 | 合同违约指数 | `/api/v1/data/enterprise/66.21/query` | GET | 否（面议） | query: `keyword`* |
| 83.52 | 企业科技创新能力评分 | `/api/v1/data/enterprise/83.52/query` | GET | 是 | query: `keyword`* |
| 91.74 | 企业科技创新能力评分详情 | `/api/v1/data/enterprise/91.74/query` | GET | 是 | query: `name`* |
| 95.03 | 企业科技创新能力评分模型指标 | `/api/v1/data/enterprise/95.03/query` | GET（可选 GET/POST） | 是 | query: `name`* |
| 86.83 | 科创企业综合评分 | `/api/v1/data/enterprise/86.83/query` | GET | 是 | query: `keyword`* |
| 98.85 | 科创企业综合评分详情 | `/api/v1/data/enterprise/98.85/query` | GET | 是 | query: `keyword`* |
| 65.48 | 科创企业综合评分模型指标 | `/api/v1/data/enterprise/65.48/query` | GET | 是 | query: `keyword`* |
| 72.51 | 综合风险分 | `/api/v1/data/enterprise/72.51/query` | GET | 否（面议） | query: `keyword`* |

#### 企业标签（7 个）

| 编号 | 名称 | Hub 路径（POST） | 上游方法 | 可调用 | 主要请求参数（`*` 为必填） |
| --- | --- | --- | --- | --- | --- |
| 82.11 | 概念标签 | `/api/v1/data/enterprise/82.11/query` | GET | 是 | query: `name`* |
| 79.14 | 科技型企业 | `/api/v1/data/enterprise/79.14/query` | GET | 是 | query: `name`*, `skip`, `type_code`, `level_code`, `state_code`, `year` |
| 82.10 | 企业特点（初创企业） | `/api/v1/data/enterprise/82.10/query` | GET | 是 | query: `name`* |
| 82.12 | 企业信息标签 | `/api/v1/data/enterprise/82.12/query` | GET | 是 | query: `keyword`* |
| 1.25 | 主营业务 | `/api/v1/data/enterprise/1.25/query` | GET | 是 | query: `name`*, `skip` |
| 44.82 | 概念标签V2 | `/api/v1/data/enterprise/44.82/query` | GET | 是 | query: `name`*, `type_id` |
| 89.95 | 地区认定标签 | `/api/v1/data/enterprise/89.95/query` | GET | 是 | query: `keyword`* |

#### 新闻舆情（2 个）

| 编号 | 名称 | Hub 路径（POST） | 上游方法 | 可调用 | 主要请求参数（`*` 为必填） |
| --- | --- | --- | --- | --- | --- |
| 10.1 | 新闻列表 | `/api/v1/data/enterprise/10.1/query` | GET | 是 | query: `name`*, `skip`, `tag_list`, `sentiment`, `company_sentiment`, `class_types`, `new_tag_list`, `company_new_tag`, `create_time_range` |
| 10.4 | 新闻详细信息 | `/api/v1/data/enterprise/10.4/query` | GET（可选 GET/POST） | 是 | query: `oid`* |

#### 企业发展（7 个）

| 编号 | 名称 | Hub 路径（POST） | 上游方法 | 可调用 | 主要请求参数（`*` 为必填） |
| --- | --- | --- | --- | --- | --- |
| 37.3 | 融资信息 | `/api/v1/data/enterprise/37.3/query` | GET | 是 | query: `name`* |
| 50.5 | 核心团队 | `/api/v1/data/enterprise/50.5/query` | GET | 是 | query: `name`*, `skip` |
| 49.5 | 产品信息 | `/api/v1/data/enterprise/49.5/query` | GET | 是 | query: `name`*, `skip` |
| 48.1 | 竞品信息 | `/api/v1/data/enterprise/48.1/query` | GET | 是 | query: `name`*, `skip` |
| 66.28 | 投资机构与投资项目查询 | `/api/v1/data/enterprise/66.28/query` | GET | 是 | query: `name`*, `source`, `skip` |
| 79.39 | 企业所属产业链环节 | `/api/v1/data/enterprise/79.39/query` | GET（可选 GET/POST） | 否（面议） | query: `name`*, `skip` |
| 83.58 | 战略新兴产业 | `/api/v1/data/enterprise/83.58/query` | GET | 是 | query: `keyword`* |

#### 客商关系（3 个）

| 编号 | 名称 | Hub 路径（POST） | 上游方法 | 可调用 | 主要请求参数（`*` 为必填） |
| --- | --- | --- | --- | --- | --- |
| 77.1 | 企业供应商信息 | `/api/v1/data/enterprise/77.1/query` | GET | 是 | query: `name`*, `skip` |
| 77.2 | 企业客户信息 | `/api/v1/data/enterprise/77.2/query` | GET | 是 | query: `name`*, `skip` |
| 79.41 | 供应链上下游查询 | `/api/v1/data/enterprise/79.41/query` | GET | 是 | query: `name`*, `skip`, `relationship_code` |

#### 集团信息（4 个）

| 编号 | 名称 | Hub 路径（POST） | 上游方法 | 可调用 | 主要请求参数（`*` 为必填） |
| --- | --- | --- | --- | --- | --- |
| 31.29 | 集团成员 | `/api/v1/data/enterprise/31.29/query` | GET | 是 | query: `name`*, `skip` |
| 83.2 | 集团对外投资信息 | `/api/v1/data/enterprise/83.2/query` | GET | 是 | query: `name`* |
| 83.3 | 集团投资方信息 | `/api/v1/data/enterprise/83.3/query` | GET | 是 | query: `name`* |
| 61.45 | 集团图谱 | `/api/v1/data/enterprise/61.45/query` | GET（可选 GET/POST） | 是 | query: `keyword`* |

#### 证券信息（43 个）

| 编号 | 名称 | Hub 路径（POST） | 上游方法 | 可调用 | 主要请求参数（`*` 为必填） |
| --- | --- | --- | --- | --- | --- |
| 43.3 | 股票信息 | `/api/v1/data/enterprise/43.3/query` | GET | 是 | query: `name`* |
| 68.1 | 上市公司概况 | `/api/v1/data/enterprise/68.1/query` | GET | 是 | query: `name`* |
| 68.2 | 股东人数 | `/api/v1/data/enterprise/68.2/query` | GET | 是 | query: `name`*, `skip` |
| 68.3 | 十大股东 | `/api/v1/data/enterprise/68.3/query` | GET | 是 | query: `name`*, `skip`, `date`* |
| 68.4 | 十大流通股东 | `/api/v1/data/enterprise/68.4/query` | GET | 是 | query: `name`*, `skip`, `date`* |
| 68.5 | 上市公司高管 | `/api/v1/data/enterprise/68.5/query` | GET | 是 | query: `name`*, `skip` |
| 68.6 | 股本结构 | `/api/v1/data/enterprise/68.6/query` | GET | 是 | query: `name`* |
| 68.7 | 股本变动 | `/api/v1/data/enterprise/68.7/query` | GET | 是 | query: `name`*, `skip` |
| 68.8 | 十大股东持股变动 | `/api/v1/data/enterprise/68.8/query` | GET | 是 | query: `name`*, `skip` |
| 68.9 | 上市公司公告 | `/api/v1/data/enterprise/68.9/query` | GET | 是 | query: `name`*, `skip` |
| 68.10 | 上市公司员工构成 | `/api/v1/data/enterprise/68.10/query` | GET | 是 | query: `name`*, `skip` |
| 68.11 | 对外担保 | `/api/v1/data/enterprise/68.11/query` | GET | 是 | query: `name`*, `skip` |
| 68.12 | 违规处理 | `/api/v1/data/enterprise/68.12/query` | GET | 是 | query: `name`*, `skip` |
| 68.13 | 分红情况 | `/api/v1/data/enterprise/68.13/query` | GET | 是 | query: `name`*, `skip` |
| 68.14 | 增发情况 | `/api/v1/data/enterprise/68.14/query` | GET | 是 | query: `name`*, `skip` |
| 68.15 | 配股情况 | `/api/v1/data/enterprise/68.15/query` | GET | 是 | query: `name`*, `skip` |
| 68.17 | 财务主要指标 | `/api/v1/data/enterprise/68.17/query` | GET | 是 | query: `name`*, `skip` |
| 68.20 | 现金流量表 | `/api/v1/data/enterprise/68.20/query` | GET | 是 | query: `name`*, `skip` |
| 68.18 | 利润表 | `/api/v1/data/enterprise/68.18/query` | GET | 是 | query: `name`*, `skip` |
| 68.19 | 资产负债表 | `/api/v1/data/enterprise/68.19/query` | GET | 是 | query: `name`*, `skip` |
| 43.2 | 新三板 | `/api/v1/data/enterprise/43.2/query` | GET | 是 | query: `name`* |
| 58.3 | 债券基础信息 | `/api/v1/data/enterprise/58.3/query` | GET | 是 | query: `name`*, `skip` |
| 72.1 | 私募管理人列表 | `/api/v1/data/enterprise/72.1/query` | GET | 是 | query: `skip(可选)`* |
| 72.2 | 私募管理人信息 | `/api/v1/data/enterprise/72.2/query` | GET | 是 | query: `name`* |
| 72.3 | 私募管理人高管 | `/api/v1/data/enterprise/72.3/query` | GET | 是 | query: `name`*, `skip` |
| 72.4 | 私募管理人关联方 | `/api/v1/data/enterprise/72.4/query` | GET | 是 | query: `name`*, `skip` |
| 72.5 | 私募管理产品查询 | `/api/v1/data/enterprise/72.5/query` | GET | 是 | query: `name`*, `skip` |
| 72.6 | 基金协会会员列表 | `/api/v1/data/enterprise/72.6/query` | GET | 是 | query: `skip(可选)` |
| 72.7 | 基金协会一般成员 | `/api/v1/data/enterprise/72.7/query` | GET | 是 | query: `name`* |
| 72.8 | 基金协会高管信息 | `/api/v1/data/enterprise/72.8/query` | GET | 是 | query: `name`*, `skip` |
| 72.9 | 证券私募子公司列表 | `/api/v1/data/enterprise/72.9/query` | GET | 是 | query: `skip` |
| 72.10 | 证券私募子公司信息 | `/api/v1/data/enterprise/72.10/query` | GET | 是 | query: `name`* |
| 72.11 | 一级与二级私募管理信息 | `/api/v1/data/enterprise/72.11/query` | GET | 是 | query: `name`*, `skip` |
| 72.12 | 私募子公司基金产品 | `/api/v1/data/enterprise/72.12/query` | GET | 是 | query: `name`*, `skip` |
| 72.13 | 注销私募列表 | `/api/v1/data/enterprise/72.13/query` | GET | 是 | query: `skip`* |
| 69.21 | 股权质押信息 | `/api/v1/data/enterprise/69.21/query` | GET | 是 | query: `name`*, `skip` |
| 69.22 | 股权质押详情 | `/api/v1/data/enterprise/69.22/query` | GET | 是 | query: `emorderid`* |
| 72.14 | 私募管理人产品 | `/api/v1/data/enterprise/72.14/query` | GET | 是 | query: `name`*, `skip` |
| 86.42 | 债券违约信息 | `/api/v1/data/enterprise/86.42/query` | GET | 是 | query: `keyword`*, `skip` |
| 27.35 | 股票行情 | `/api/v1/data/enterprise/27.35/query` | GET | 是 | query: `keyword`*, `skip`* |
| 47.26 | 董监高股权质押 | `/api/v1/data/enterprise/47.26/query` | GET | 是 | query: `keyword`*, `p_name`*, `skip` |
| 52.86 | 董监高股权出质 | `/api/v1/data/enterprise/52.86/query` | GET | 是 | query: `keyword`*, `p_name`*, `skip` |
| 43.82 | 企业证券名称变更 | `/api/v1/data/enterprise/43.82/query` | GET（可选 GET/POST） | 是 | query: `keyword`*, `skip` |

#### 地产建筑（17 个）

| 编号 | 名称 | Hub 路径（POST） | 上游方法 | 可调用 | 主要请求参数（`*` 为必填） |
| --- | --- | --- | --- | --- | --- |
| 80.1 | 建筑企业资质查询 | `/api/v1/data/enterprise/80.1/query` | GET | 是 | query: `name`*, `skip` |
| 80.5 | 建筑企业不良行为 | `/api/v1/data/enterprise/80.5/query` | GET（可选 POST/GET） | 是 | query: `name`*, `skip` |
| 80.6 | 建筑企业黑名单 | `/api/v1/data/enterprise/80.6/query` | GET | 是 | query: `name`*, `skip` |
| 71.1 | 建设工程规划许可证 | `/api/v1/data/enterprise/71.1/query` | GET | 是 | query: `name`*, `skip` |
| 71.3 | 工程竣工验收信息 | `/api/v1/data/enterprise/71.3/query` | GET | 是 | query: `name`*, `skip` |
| 71.5 | 土地闲置信息 | `/api/v1/data/enterprise/71.5/query` | GET | 是 | query: `name`*, `skip` |
| 71.7 | 建设用地规划许可证 | `/api/v1/data/enterprise/71.7/query` | GET | 是 | query: `name`*, `skip` |
| 71.11 | 预售项目信息 | `/api/v1/data/enterprise/71.11/query` | GET | 是 | query: `name`*, `skip` |
| 71.13 | 土地成交信息 | `/api/v1/data/enterprise/71.13/query` | GET | 是 | query: `name`*, `skip` |
| 71.15 | 土地划拨信息 | `/api/v1/data/enterprise/71.15/query` | GET | 是 | query: `name`*, `skip` |
| 71.17 | 土地一级开发信息 | `/api/v1/data/enterprise/71.17/query` | GET | 是 | query: `name`*, `skip` |
| 71.19 | 土地征收信息 | `/api/v1/data/enterprise/71.19/query` | GET | 是 | query: `name`*, `skip` |
| 71.21 | 选址意见书 | `/api/v1/data/enterprise/71.21/query` | GET | 是 | query: `name`*, `skip` |
| 71.23 | 规划核验信息 | `/api/v1/data/enterprise/71.23/query` | GET | 是 | query: `name`*, `skip` |
| 71.25 | 建筑名称核准信息 | `/api/v1/data/enterprise/71.25/query` | GET | 是 | query: `name`*, `skip` |
| 71.27 | 地产相关行政处罚 | `/api/v1/data/enterprise/71.27/query` | GET | 是 | query: `name`*, `skip` |
| 61.1 | 购地信息 | `/api/v1/data/enterprise/61.1/query` | GET | 是 | query: `keyword`*, `skip`, `type`* |

#### 特色专区（1 个）

| 编号 | 名称 | Hub 路径（POST） | 上游方法 | 可调用 | 主要请求参数（`*` 为必填） |
| --- | --- | --- | --- | --- | --- |
| 98.12 | 综合风险事件 | `/api/v1/data/enterprise/98.12/query` | GET | 是 | query: `keyword`*, `skip`, `risk_issue`, `business_time`, `data_type`, `risk_level` |

## 4. 每个接口的返回结构

外层结构对所有接口都一样，见 §2.2。业务字段逐接口列在附录里，包括字段路径、类型、是否声明必返和含义；字段路径相对于 Hub 响应的 `data`。

几条通用规律（均以目录声明为准）：

- 256 个接口在目录里声明了 `status`、`message`、`sign`、`data` 四个顶层字段。其余 18 个接口的声明有缺漏、错位、重复或拼写问题（见 §6.1），但它们的目录示例顶层都是 `status` / `message` / `sign` / `data`。
- 列表型接口的业务数据大多是 `data.total`（总数）、`data.num`（本页条数）和 `data.items[]`。翻页用该接口自己声明的 `skip` / `page` 等字段，步长看接口说明。例如 1.31 每页 10 条，19.91 每页 20 条。Hub 不自动翻页。
- 详情型接口的 `data` 是单个对象。报告类接口（36.99、22.62 等）返回报告内容，或在 pending 时只返回状态。

1.31 企业模糊搜索的完整返回字段：

| 字段（Hub 响应中的完整路径） | 类型 | 含义 |
| --- | --- | --- |
| `data.status` | String | 返回结果状态 |
| `data.message` | String | 返回结果消息 |
| `data.sign` | String | 数据签名 |
| `data.data` | Object | 返回查询结果；无匹配时为空 |
| `data.data.total` | Number | 记录总数 |
| `data.data.num` | Number | 当前返回条目数 |
| `data.data.items[]` | Array | 企业列表 |
| `data.data.items[].name` | String | 企业名称 |
| `data.data.items[].id` | String | 企业编号（eid，后续接口可用） |
| `data.data.items[].reg_no` | String | 注册号 |
| `data.data.items[].credit_no` | String | 统一社会信用代码 |
| `data.data.items[].oper_name` | String | 法定代表人 |
| `data.data.items[].start_date` | String | 成立日期 |
| `data.data.items[].matchType` | String | 匹配类型 |
| `data.data.items[].matchItems` | String | 匹配关键字 |
| `data.data.items[].type` | String（示例里实际是数字） | 企业类型：0 企业，4 社团，5 律所，6 香港公司，7 非法社团，8 台湾，9 澳门 |

## 5. URL / 链接字段

### 5.1 Hub 如何处理

URL 在 Hub 里走过的路径如下：

1. `qixin.mjs:52`：向启信发请求时设置 `redirect: 'error'`。这只作用于 Hub 调用启信的那一跳，与响应里的 URL 无关。
2. `qixin.mjs:68-85`：凭据回显脱敏，这是唯一会改动正文的地方。
   - 用 `createCredentialEchoRedactor`（`server/core/credential-redaction.mjs`），把正文中出现的 appkey、secret_key 和本次请求 sign 替换为 `[REDACTED]`。
   - 替换范围包括这些值的 URL 编码和双重编码变体，并且字符串的键和值都会处理。
   - 代码注释明确写着，名为 sign、token、url 的业务字段和嵌套业务内容保持原样。
   - 所以，只有当某个 URL 恰好带着 Hub 的启信凭据（例如带 appkey 的签名下载链接）时，这一段才会被替换，链接也随之失效。普通业务 URL 不受影响。
3. `qixin.mjs:107`：公共响应的 `data` 就是上一步之后的 payload，不做投影、裁剪或字段重命名。
4. `gateway.mjs:155-191`：`deliveryBody` 对正文做 `structuredClone`，只追加 `requestId` 和 `meta`，不碰 `data`。
5. `qixin.mjs:99,109`：canonical 记录 `url: null`，`archiveObjects: []`。企业数据不下载、不转存任何图片或附件，也不生成 Hub 自己的链接。
6. 管理台「企业数据 → 接口调试」（`src/pages-enterprise.jsx`）用 `JSON.stringify` 把响应当纯文本展示，不渲染成可点击链接，也不改写。

结论：所有 URL 字段都是**原样透传**。没有过滤、重写或代理，也没有删除 URL 的代码。下游拿到的是启信给的原始字符串，需要自己处理：

- 补全协议（值可能是 `www.xxx`）。
- 判断值是否为完整 URL（86.42 示例只有文件名）。
- 处理 http 与 https。
- 应对链接可访问性和失效。

### 5.2 字段清单

- “Hub 响应字段路径”从响应体根开始，也就是下游代码里的 `result.`。
- “目录示例里的取值”只列出目录示例中出现的协议和域名，不代表真实返回一定落在这些域名上；“—”表示示例里没有值或示例无法解析。
- 22.11 资质证书详情按入参 `kind` 返回不同字段组，表中注明了对应的 kind。

#### 图片 / Logo / 证照快照（23 处）

| 接口 | 可调用 | Hub 响应字段路径 | 类型 | 目录说明 | 目录示例里的取值 |
| --- | --- | --- | --- | --- | --- |
| 47.51 客户信息尽调 | 是 | `data.data.ent_info.logo_url` | String | logo地址 | — |
| 47.51 客户信息尽调 | 是 | `data.data.group_info.group_logo` | String | 集团logo | — |
| 55.29 合作风险排查 | 是 | `data.data.ent_info.logo_url` | String | logo地址 | `https://qxb-logo-url.oss-cn-hangzhou.aliyuncs.com` |
| 55.82 企业信用全景报告-JOB申请 | 否 | `data.data.group_info[].group_logo` | String | 集团logo | — |
| 55.82 企业信用全景报告-JOB申请 | 否 | `data.data.product_list[].logo` | String | logo链接 | — |
| 55.82 企业信用全景报告-JOB申请 | 否 | `data.data.similars_list[].logo` | String | 竞品logo | — |
| 19.91 商标信息搜索 | 是 | `data.data.items[].image_url` | String | 商标图片 | `https://qxb-img-osscache.qixin.com` |
| 1.17 企业LOGO | 是 | `data.data.logo` | String | 企业logourl地址 | `https://qxb-logo-url.oss-cn-hangzhou.aliyuncs.com` |
| 79.16 微信公众号 | 是 | `data.data.items[].qrcode_url` | String | 二维码 url | `http://ccimg.cn-sh2.ufileos.com` |
| 79.16 微信公众号 | 是 | `data.data.items[].logo_url` | String | logo url | `http://ccimg.cn-sh2.ufileos.com` |
| 12.1 商标列表 | 是 | `data.data.items[].image_name` | String | 商标图片链接 | `https://qxb-img-osscache.qixin.com` |
| 12.4 商标详细 | 是 | `data.data.image_url` | String | 商标图片链接 | `https://qxb-img-osscache.qixin.com` |
| 12.4 商标详细 | 是 | `data.data.org_image_url` | String | 商标图片链接 | `https://wcjs.sbj.cnipa.gov.cn` |
| 8.4 专利详细 | 是 | `data.data.patent_img` | String | 专利图片 | `https://qxb-img-osscache.qixin.com` |
| 22.11 资质证书详情 | 是 | `data.data.pic1_url_oss` | String | 排污许可证正本链接(oss)（kind=012 排污许可证 时返回） | — |
| 22.11 资质证书详情 | 是 | `data.data.pic2_url_oss` | String | 排污许可证副本链接(oss)（kind=012 排污许可证 时返回） | — |
| 50.5 核心团队 | 是 | `data.data.items[].logo` | String | 头像 | — |
| 49.5 产品信息 | 是 | `data.data.items[].logo` | String | logo链接 | `https://qxb-img-osscache.qixin.com` |
| 48.1 竞品信息 | 是 | `data.data.items[].logo` | String | 竞品logo | — |
| 66.28 投资机构与投资项目查询 | 是 | `data.data.logo` | String | 企业logo | `https://qxb-img-osscache.qixin.com` |
| 71.1 建设工程规划许可证 | 是 | `data.data.items[].licensePhoto` | String | 建设工程规划许可证快照 | `http://qxb-img.oss-cn-hangzhou.aliyuncs.com` |
| 71.7 建设用地规划许可证 | 是 | `data.data.items[].licensePhoto` | String | 建设用地规划许可证快照 | `http://qxb-img.oss-cn-hangzhou.aliyuncs.com` |
| 71.11 预售项目信息 | 是 | `data.data.items[].licensePhoto` | String | 商品房预售许可证快照 | `https://qxb-img-osscache.qixin.com` |

#### 文件 / 附件 / 报告下载（11 处）

| 接口 | 可调用 | Hub 响应字段路径 | 类型 | 目录说明 | 目录示例里的取值 |
| --- | --- | --- | --- | --- | --- |
| 36.99 企业信用全景报告-获取报告 | 是 | `data.data.report_pdf` | String | pdf版报告链接 | — |
| 22.62 董监高信息洞察报告-获取报告 | 是 | `data.data.report_pdf` | String | pdf版报告链接 | — |
| 88.49 基金会基本信息 | 是 | `data.data.rule` | String | 章程 | `https://qxb-img-osscache.qixin.com` |
| 51.5 破产公告 | 是 | `data.data.pdf` | String | 附件 | — |
| 51.3 环保处罚详情 | 是 | `data.data.punishments.document_url` | String | 文书 | — |
| 76.1 简易注销 | 是 | `data.data.items[].url` | String | 全体投资人承诺书（地址） | `https://qxb-img-osscache.qixin.com` |
| 8.4 专利详细 | 是 | `data.data.annex` | String | 附件 | `https://qxb-img-osscache.qixin.com` |
| 2.53 企业族谱穿透信息 | 是 | `data.data.doc_path` | String | 文件下载路径，当入参form=1时返回该字段 | — |
| 79.14 科技型企业 | 是 | `data.data.items[].attachment_url` | String | 附件链接 | — |
| 68.9 上市公司公告 | 是 | `data.data.items[].sourceurlcc` | String | 公告链接 | `http://qxb-pdf-osscache.qixin.com` |
| 86.42 债券违约信息 | 是 | `data.data.items[].attach_name` | string | 附件url | `H2_AN201807021161610216_1.pdf（仅文件名，非完整 URL）` |

#### 原文 / 来源 / 详情链接（37 处）

| 接口 | 可调用 | Hub 响应字段路径 | 类型 | 目录说明 | 目录示例里的取值 |
| --- | --- | --- | --- | --- | --- |
| 55.29 合作风险排查 | 是 | `data.data.exit_limitation_list[].url` | String | 内容 | — |
| 55.29 合作风险排查 | 是 | `data.data.huge_tax_punishment_list[].url` | String | 详情 | — |
| 55.82 企业信用全景报告-JOB申请 | 否 | `data.data.exit_limitation_list[].url` | String | 内容 | — |
| 55.82 企业信用全景报告-JOB申请 | 否 | `data.data.huge_tax_punishment_list[].url` | String | 详情 | — |
| 88.49 基金会基本信息 | 是 | `data.data.url` | String | 数据链接 | `http://ggfw.mzj.beijing.gov.cn` |
| 47.4 立案信息 | 是 | `data.data.items[].url` | String | 数据源链接（字段废弃） | — |
| 19.1 开庭公告 | 是 | `data.data.items[].url` | String | 数据源链接 | `http://tingshen.court.gov.cn` |
| 62.89 送达公告 | 是 | `data.data.items[].url` | String | 详情页链接 | `http://wjsfy.chinacourt.org` |
| 6.5 行贿违法 | 是 | `data.data.items[].url` | String | 链接 | `http://wenshu.court.gov.cn` |
| 39.38 受贿违法 | 是 | `data.data.items[].url` | String | 链接 | `http://wenshu.court.gov.cn` |
| 20.3 重大税收违法 | 是 | `data.data.items[].url` | String | 原文链接 | `http://xiamen.chinatax.gov.cn` |
| 22.8 企业工程不良行为 | 是 | `data.data.items[].url` | String | 原文链接 | `http://jzsc.mohurd.gov.cn` |
| 51.3 环保处罚详情 | 是 | `data.data.url` | String | 详细链接 | `http://www.sepb.gov.cn` |
| 66.36 食品安全 | 是 | `data.data.items[].url` | String | 链接 | `https://spcjsac.gsxt.gov.cn` |
| 66.34 产品召回 | 是 | `data.data.items[].url` | String | url | `https://www.dpac.org.cn` |
| 21.6 招投标详情 | 是 | `data.data.url` | String | 来源链接 | `http://www.ccgp-shanghai.gov.cn` |
| 11.1 招聘信息 | 是 | `data.data.items[].url` | String | 招聘地址 | `https://lagou.com` |
| 53.1 进出口企业查询 | 是 | `data.data.url` | String | 数据来源 | — |
| 23.48 营销商机线索 | 是 | `data.data.items[].url` | String | 线索来源url | — |
| 12.4 商标详细 | 是 | `data.data.notices[].url` | String | 商标公告链接 | `https://qxb-img-osscache.qixin.com` |
| 12.4 商标详细 | 是 | `data.data.url` | String | 详细页链接 | — |
| 22.11 资质证书详情 | 是 | `data.data.url` | String | 来源网址（kind=010 质量管理体系认证 时返回） | — |
| 22.11 资质证书详情 | 是 | `data.data.url` | String | 来源网址（kind=011 食品经营许可证 时返回） | — |
| 22.11 资质证书详情 | 是 | `data.data.url` | String | 链接（kind=012 排污许可证 时返回） | — |
| 22.11 资质证书详情 | 是 | `data.data.url` | String | 来源网址（kind=013 安全生产许可证 时返回） | — |
| 22.11 资质证书详情 | 是 | `data.data.url` | String | 网址链接（kind=014 CCC产品认证 时返回） | — |
| 22.11 资质证书详情 | 是 | `data.data.url` | String | 链接（kind=015 软件产品评估认证 时返回） | — |
| 22.11 资质证书详情 | 是 | `data.data.url` | String | 链接（kind=016 工业产品生产许可证 时返回） | — |
| 22.11 资质证书详情 | 是 | `data.data.url` | String | 链接（kind=017 特种设备公示信息 时返回） | — |
| 22.6 工程资质资格 | 是 | `data.data.items[].url` | String | 原文链接 | `http://jzsc.mohurd.gov.cn` |
| 22.3 食品生产许可证SC | 是 | `data.data.items[].url` | String | 原文链接 | `http://spscxkcx.gsxt.gov.cn` |
| 22.4 食品生产许可证QS | 是 | `data.data.items[].url` | String | 原文链接 | `http://spscxkcx.gsxt.gov.cn` |
| 22.5 食品添加剂生产许可证 | 是 | `data.data.items[].url` | String | 原文链接 | `http://spscxkcx.gsxt.gov.cn` |
| 15.44 国际专利详情 | 是 | `data.data.figure[].url` | string | url链接 | — |
| 10.1 新闻列表 | 是 | `data.data.items[].url` | String | 原文链接 | `http://www.sohu.com` |
| 10.4 新闻详细信息 | 是 | `data.data.url` | String | 原文链接 | `http://www.sohu.com` |
| 37.3 融资信息 | 是 | `data.data.financing_list[].news[].url` | String | 融资新闻 URL | — |

#### 企业 / 机构网址（21 处）

| 接口 | 可调用 | Hub 响应字段路径 | 类型 | 目录说明 | 目录示例里的取值 |
| --- | --- | --- | --- | --- | --- |
| 47.51 客户信息尽调 | 是 | `data.data.contract_info.websites_list[].web_url` | String | 网址 | — |
| 47.51 客户信息尽调 | 是 | `data.data.domain_list[].home_url` | String | 网站首页网址 | — |
| 55.82 企业信用全景报告-JOB申请 | 否 | `data.data.product_list[].website` | String | 项目地址 | — |
| 1.8 企业基础工商信息 | 是 | `data.data.websites[].web_url` | String | 网址 | `www.mi.cn（无协议）` |
| 1.53 企业年报网址 | 是 | `data.data.items[].url` | String | 网址 | `www.mi.com（无协议）`、`www.mi.cn（无协议）` |
| 3.1 工商年报 | 是 | `data.data.items[].websites[].web_url` | String | 网站网址 | — |
| 35.2 律所基本信息 | 是 | `data.data.website` | String | 主页网址 | — |
| 36.2 社会组织基本信息 | 是 | `data.data.domain` | String | 网址 | — |
| 16.1 域名信息 | 是 | `data.data.items[].home_url` | String | 主页URL | `www.camcard.com（无协议）`、`www.cc.cn（无协议）`、`www.ccint.com（无协议）`、`www.intsig.net（无协议）`、`www.cc.co（无协议）` |
| 22.11 资质证书详情 | 是 | `data.data.website` | String | 网站域名（kind=005 互联网药品信息回以下数据字段 时返回） | — |
| 22.11 资质证书详情 | 是 | `data.data.agency_domain` | String | 发证机构网址（kind=010 质量管理体系认证 时返回） | — |
| 22.11 资质证书详情 | 是 | `data.data.agency_domain` | String | 发证机构网址（kind=014 CCC产品认证 时返回） | — |
| 1.13 企业图谱信息 | 是 | `data.data.base_info.websites[].web_url` | String | 网址 | — |
| 37.3 融资信息 | 是 | `data.data.company_url` | String | 网站 | — |
| 49.5 产品信息 | 是 | `data.data.items[].website` | String | 项目地址 | — |
| 66.28 投资机构与投资项目查询 | 是 | `data.data.website` | String | 网址 | `http://www.allycapital.cn` |
| 68.1 上市公司概况 | 是 | `data.data.compweb` | String | 公司网址 | `www.hollyfuse.com（无协议）` |
| 43.2 新三板 | 是 | `data.data.url` | String | 企业网址 | — |
| 72.2 私募管理人信息 | 是 | `data.data.websites` | String | 机构网址 | — |
| 72.7 基金协会一般成员 | 是 | `data.data.websites` | String | 机构网址 | `www.vaneck.com（无协议）` |
| 72.10 证券私募子公司信息 | 是 | `data.data.websites` | String | 机构网址 | — |

#### 域名（通常无协议）（2 处）

| 接口 | 可调用 | Hub 响应字段路径 | 类型 | 目录说明 | 目录示例里的取值 |
| --- | --- | --- | --- | --- | --- |
| 47.51 客户信息尽调 | 是 | `data.data.domain_list[].domain` | String | 网站域名 | — |
| 16.1 域名信息 | 是 | `data.data.items[].domain` | String | 域名 | — |

### 5.3 容易误判为 URL、但不是链接的字段

以下字段名看起来像 URL，按目录说明其实不是链接，未列入上表：

- **`domain` / `domains`**：在 1.41 工商照面、1.8、2.1、2.3、41.1、1.13 里表示“行业”。`l1_domain_name` / `l2_domain_name` 表示门类和行业。
  - 只有 36.2 的 `domain`（网址）、47.51 的 `domain_list[].domain` 和 16.1 的 `items[].domain`（域名）是网址类，已列入上表。
- **`path`、`links`、`paths`、`voting_path`、`invest_path`、`control_path`、`equity_path` 等**：表示股权、投资或实控路径，不是链接。涉及 47.51、55.5、33.x、45.93、61.77、12.62、27.39、77.76、55.2、2.53 等接口。
- **其他与网址相关但本身不是 URL 的字段**：
  - `web_name`、`web_type`、`site_name`：网址名称和类型。
  - `source`：网址来源。
  - `if_website`：是否有网站。
  - `website_oper`：网站负责人。
  - `attachment_name`：附件名称。
  - 12.4 的 `image_name`：图片名称。注意 12.1 的 `image_name` 却是“商标图片链接”，同名字段含义不同。
  - 许可文件的 `name` / `number`。
- 请求侧：
  - 1.31 的 `matchType` 可传 `domain`，按网址匹配企业。
  - 1.31 `region` 参数的说明文字里带有一个民政部链接，这只是说明文字，不会出现在返回里。

## 6. 文档与代码对不上的地方

### 6.1 目录响应表与实际结构不一致

这类问题会体现在 Hub 文档页和 OpenAPI 上。代码原样透传，不会补救。

1. **12 个接口的响应表缺 `status`**：79.36、79.34、91.66、77.58、79.15、79.32、79.31、79.33、79.24、83.52、72.51、79.39。
   - 其中 91.66、77.58、83.52 只声明了 `data`。
   - 但代码要求响应里必须有三位数的 `status`（`qixin.mjs:90,93`），否则判为结果未知，对外返回 502。
   - 这些接口的目录示例里都有 `"status": "200"`，所以更可能是目录漏写，而不是真的不返回。本次没有实测。
   - 72.51 和 79.39 本来就不可调用。
2. **结构错位，有 2 个接口**：
   - 72.51 把全部业务字段声明在顶层（没有 `data` 包裹），示例里却在 `data` 里。
   - 79.13 把 `industry_code_l1..l4` / `industry_name_l1..l4` 声明在顶层、与 `data` 并列，示例里也在 `data` 里。
3. **字段名带尾随空格，有 4 个接口**：6.4、56.1、52.3、82.12 声明的是 `"message "`，示例里是 `message`。另外，68.18 利润表把 `sign` 声明了两次。
4. **长字段名被截断在 32 个字符**：涉及 8 个接口、66 个字段，分别是 83.52、91.74、95.03、86.83、98.85、65.48、68.20、68.19。
   - 例如 83.52 声明的是 `science_technology_original_scor`，示例里是 `science_technology_original_score`。
   - 其中 5 个接口的 38 个字段已能从示例确认真实名字更长。
   - 下游如果按文档字段名取值会取不到。附录照抄目录，所以也是截断后的名字。
5. **27.39 十大受益人**：受益人列表被声明在 `message.beneficiary_list` 下，示例为空，无法核对，大概率应在 `data` 下。
6. **示例与声明互有出入**：
   - 45 个接口的示例里共有 426 个字段没有出现在响应表中。例如 12.1 示例里有 `data.hkItems`，22.4 示例里有 `administration`、`detail` 等。
   - 77 个接口声明的字段在示例里没有出现。
   - 代码对 `data` 不做任何过滤，OpenAPI 也写了 `additionalProperties: true`，所以未声明的字段同样会透传给下游。不能把响应表当作完整清单。
7. **类型声明不可靠**：例如 1.31 的 `items[].type` 声明为 String，示例是数字 `0`。Hub 不做类型转换。
8. **URL 相关的说明问题**：
   - 86.42 的 `attach_name` 说明写“附件url”，示例只有 `H2_AN201807021161610216_1.pdf` 这样的文件名。
   - 88.49 的 `rule` 说明写“章程”，示例是一个 PDF 链接，说明没提到它是链接。
   - 47.4 的 `url` 已标“字段废弃”，但仍在响应表中。
   - 55.29 / 55.82 的 `exit_limitation_list[].url` 说明写“内容”，`huge_tax_punishment_list[].url` 说明写“详情”，没有示例值，无法确认是不是链接。

### 6.2 Hub 文档文字与代码

1. **`meta` 字段少写了**：
   - 文档页正文只提到 `meta.resultState`。OpenAPI（`enterprise-docs.mjs:48`）的 `meta` 只列了 `capturedAt`、`sourceMode`、`resultState`。
   - 实际代码还会返回 `servedAt`、`ageSeconds`、`reason`，回退时还有 `fallbackReason`（`gateway.mjs:155-191`）。
   - 这些都是追加字段，不影响已有解析，但文档没写。
2. **报告流程无法走通**：
   - 每个接口的文档都写着“报告申请和读取分别调用对应接口”（`enterprise-docs.mjs:130`）。
   - 但申请报告的 55.82（企业信用全景报告-JOB申请）和 35.86（董监高信息洞察报告-JOB申请）没有公开价，调用返回 403。
   - 读取报告的 36.99 和 22.62 可以调用（公开价 0），但需要 `report_id`。
   - 结果是只通过 Hub 拿不到 `report_id`，`report_pdf` 这个 URL 实际上取不到，除非 `report_id` 来自 Hub 之外。
3. **“data 是完整业务响应”不完全准确**：
   - 文档页说 data 是完整业务响应（`enterprise-docs.mjs:135`），OpenAPI 说“精确业务响应封装于 data”。
   - 代码在出现凭据回显时会把它替换成 `[REDACTED]`（§5.1），这时 data 与启信原始字节不同。
   - 这只发生在凭据回显这种异常情况，正常响应不受影响。原始字节只保存在 Hub 内部的受限归档里。
4. **请求侧，Hub 有意修正了目录**：19.91 的 `match_type`、42.3 的 3 个 body 字段改为选填，66.35 和 22.11 设了“二选一”。Hub 文档页显示的是修正后的值，与代码一致；只是与启信原始目录不同，对照启信官方文档时要注意。

### 6.3 顺带发现（不在本次范围，未改）

- 启信失败统一包装为 `JustOneUpstreamError`。
- `publicFailure` 里有两条按业务码映射的分支没有限定在电商，见 `gateway.mjs:284-286` 和 `:302-310`：
  - 业务码 302 / 303 会按供应商容量错误（`upstreamCapacityError`）处理。
  - 业务码 100 / 600 / 601 / 602 会对外返回 503 `external_platform_capacity_unavailable`（External data capacity is unavailable）。
- 同一函数里电商分支前的注释写明，这些业务码属于 JustOne，“其他供应商可能复用这些数字”。
- 如果启信返回这些业务码，对外状态和文案会与文档写的 502“响应拒绝”不一致。本次没有核对启信的错误码表，是否真的会碰到，未验证。
