import { ipRiskV2Paths } from './ip-risk-v2-docs.mjs'
import { IP_PRODUCT_CAPABILITY, IP_PRODUCT_VERSION } from './ip-risk-product.mjs'
const operation=structuredClone(ipRiskV2Paths['/data/ip/risk/v2'].post)
operation.operationId='queryIpRiskSubscription'
operation.summary='IP 风险画像 · 空间订阅'
operation['x-mx-required-capabilities']=[IP_PRODUCT_CAPABILITY]
operation.description='同一空间内获授权的 Live API Keys 共用订阅。无需指定供应商。到期或达到本期上限后停止新查询，历史读取不增加调用次数。'
operation.requestBody={required:true,content:{'application/json':{schema:{oneOf:[{type:'object',required:['ip'],additionalProperties:false,properties:{ip:{type:'string',format:'ipv4'}}},{type:'object',required:['ips'],additionalProperties:false,properties:{ips:{type:'array',minItems:1,maxItems:100,items:{type:'string',format:'ipv4'}}}}]}}}}
operation.responses[200].description='逐项返回画像；单个查询也返回 data 数组。每项 status 表示该 IP 的结果，批次 200 不代表所有项成功。'
operation.responses[200].content['application/json'].schema.properties.contractVersion.const=IP_PRODUCT_VERSION
delete operation.responses[200].content['application/json'].schema.properties.data.items.properties.channel
export const ipRiskProductPaths={'/data/ip/risk/service':{post:operation}}
export const ipRiskProductGuide=`<section class="doc-page" data-doc-page="ip-risk-subscription"><h2>IP 风险画像 · 空间订阅</h2><p>识别 IP 风险、查看访问来源，支持网页工作台与 API 调用。空间内获授权的调用者与 Keys 共用本期调用上限。</p><h3>发起查询</h3><pre>POST /api/v1/data/ip/risk/service\nAuthorization: Bearer &lt;HUB_API_KEY&gt;\nIdempotency-Key: your-stable-request-key\nContent-Type: application/json\n\n{"ip":"1.1.1.1"}</pre><p>批量使用 {"ips":["1.1.1.1","8.8.8.8"]}，每批最多 100 项。结果 data 始终为数组；单项包含 ip、status、response 或 error。未知或处理中请保留原请求标识，不重复提交新请求。</p><h3>订阅与调用</h3><p>付款后自动开通。成功交付计入本期调用次数；明确失败不计入。有效无数据计入成功交付；未知结果保留待核对次数。订阅到期或达到上限后停止新查询，不自动从钱包扣费。</p><p>GET /api/v1/data/ip/risk/subscription 查看本期调用次数和有效期。历史接口沿用 /api/v1/data/ip/risk/history，仅能回看当前调用身份的记录，不增加次数。服务交付渠道由管理员配置，客户端无需修改接口地址。</p></section>`
