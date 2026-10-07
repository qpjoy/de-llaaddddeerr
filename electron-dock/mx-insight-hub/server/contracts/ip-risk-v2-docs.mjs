export const ipRiskV2Paths = {
  '/data/ip/risk/v2': {post:{operationId:'queryIpRiskV2',summary:'IP 风险画像 v2 · 单个、批量与渠道对照',tags:['IP 风险画像'],
    'x-mx-required-platform':'ip_risk','x-mx-required-capabilities':['ip.risk.query.v2'],security:[{ApiKeyAuth:[]}],
    requestBody:{required:true,content:{'application/json':{schema:{type:'object',additionalProperties:false,properties:{ip:{type:'string',format:'ipv4'},ips:{type:'array',minItems:1,maxItems:100,items:{type:'string',format:'ipv4'}},channels:{type:'array',minItems:1,maxItems:2,uniqueItems:true,default:['baidu-v2'],items:{type:'string',enum:['baidu-v2','legacy-v1']}}},oneOf:[{required:['ip'],not:{required:['ips']}},{required:['ips'],not:{required:['ip']}}]}}}},
    responses:{200:{description:'逐 IP × 渠道结果；批次 HTTP 200 不代表所有子项成功',content:{'application/json':{schema:{type:'object',required:['contractVersion','batchId','data'],properties:{contractVersion:{const:'mx-insight-hub.ip-risk.v2'},batchId:{type:'string',format:'uuid'},data:{type:'array',items:{type:'object',properties:{index:{type:'integer'},ip:{type:'string'},channel:{type:'string'},status:{type:'integer'},response:{type:'object',description:'成功响应 data 包含 status、data（风险字段）与 warnings；meta.capturedAt 为查询时间'},error:{type:'object'}}}}}}}}},403:{description:'渠道未授权、没有有效订阅或订阅已过期'},409:{description:'原请求处理中/结果未知或幂等冲突'},429:{description:'年度调用达到上限或上游限流'},503:{description:'服务暂不可用'}}}},
}
export const ipRiskV2Guide = `<section class="doc-page" data-doc-page="ip-risk-v2"><h2>IP 风险画像 v2</h2>
<p>POST /api/v1/data/ip/risk/v2，使用已授权的 Live Hub Key。要求 ip_risk 和 ip.risk.query.v2，以及当前调用者的有效订阅。普通请求无需 Idempotency-Key；可显式提供 8–128 位安全字符，在结果不确定时保持原值和原参数。</p>
<pre><code>Authorization: Bearer &lt;HUB_API_KEY&gt;
Content-Type: application/json

{"ip":"223.160.165.241","channels":["baidu-v2"]}

{"ips":["1.1.1.1","8.8.8.8"],"channels":["baidu-v2","legacy-v1"]}</code></pre>
<p>ip 与 ips 二选一；channels 默认 baidu-v2。选择 legacy-v1 还需 ip.risk.query，沿用旧计费规则。最多 100 个 IP × 渠道组合，保留顺序和重复项；不自动补查、回退或重试。即使单个查询也返回 data 数组，每项有 index、ip、channel、status，以及 response 或 error。必须逐项检查状态，不能只检查整批 HTTP 200。</p>
<h3>字段</h3><p>成功项 response.data 包含 ip、status、data、warnings。data 的 risk_level 保留上游等级，risk_score 等缺失量为 null。country/province/city/district、isp、scene、longitude/latitude 为实际返回的归属地、运营商、场景和坐标；data_date 是数据更新时间。risk_tags 每项含 category、name、parent、risk_level、last_seen。空标签、缺失字段和未评级不等于安全。</p>
<h3>计量与期限</h3><p>百度 v2 为定期订阅，每个 IP 成功交付（包括有效无数据）计入本期调用次数。失败不计次，结果未知的请求保留待核对状态。所选调用者的所有 Keys 共用年度调用上限；到期或达到上限停止，续订从下一周期开始统计。v1 对照另按旧套餐计费。</p>
<h3>历史与错误</h3><p>批次有 batchId，子项有独立 requestId。GET /api/v1/data/ip/risk/history 与 /history/batch/{batchId} 读取原交付，不调用上游，也不计入本期调用次数。401 表示凭据失效，403 为授权或订阅问题，429 为额度或限流；batch_deadline_not_dispatched 是未派发。结果不确定时保留原请求身份，先核对用量，不以新标识反复提交。</p></section>`
