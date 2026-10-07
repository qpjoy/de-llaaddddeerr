import { AppError } from '../core/errors.mjs'
import { withPgTransaction } from '../stores/postgres-store.mjs'
import { BAIDU_IP_ORIGIN } from '../adapters/baidu-ip-risk.mjs'

export class BaiduIpAdminService {
  constructor(adapter,store){this.providerKey='baidu-ip';this.adapter=adapter;this.store=store}
  async overview(range){const detail=await this.detail(this.providerKey,range);return {range,providers:[detail.provider]}}
  async detail(_key,range='24h'){
    const duration={'24h':86400000,'7d':604800000,'30d':2592000000}[range]
    if(!duration)throw new AppError(400,'invalid_range','Invalid range')
    const [policy,analytics]=await Promise.all([this.adapter.policy(),this.store.analytics({from:new Date(Date.now()-duration),bucket:'hour'})])
    const upstream=this.adapter.pool?(await this.adapter.pool.query('SELECT count(*)::integer AS count FROM hub_commerce.ip_upstream_calls WHERE created_at >= $1',[new Date(Date.now()-duration)])).rows[0].count:0
    return {range,policy,endpoints:['base','overall'].map(endpoint=>({endpoint,url:`${BAIDU_IP_ORIGIN}/${endpoint}/{ip}`})),
      provider:{key:this.providerKey,displayName:'百度 · IP 风险画像 v2',configured:!!this.adapter.pool,status:policy.enabled?'unknown':'disabled',
        description:'独立于百度 Web Search；固定网页接口参考适配，base + overall 两个子接口，不自动回退。',
        metrics:{...analytics.totals,upstreamCalls:upstream},billing:{currency:null,actualCostMinor:null,grossEstimatedCostMinor:null,pricingSource:'unknown'},lastObservedAt:policy.last_observed_at},
      notes:{connection:'当前使用网页查询接口，无 API Key；固定域名，不复用 Web Search 凭据。',budget:'数据库跨副本限流；每个 IP 至多两次上游请求，客户成功交付扣一次订阅额度。601 冷却 30 分钟，无自动重试。'}}
  }
  async updateOperationPolicy(_provider,operation,input){
    if(operation!=='ip.risk.query.v2' || !input || Object.keys(input).some(k=>!['revision','enabled','dailyLimit','spacingMs'].includes(k)) || typeof input.enabled!=='boolean'
      || !Number.isInteger(input.revision) || !Number.isInteger(input.dailyLimit) || input.dailyLimit<1 || input.dailyLimit>1200
      || !Number.isInteger(input.spacingMs) || input.spacingMs<2000 || input.spacingMs>300000)throw new AppError(400,'invalid_ip_policy','Invalid IP channel policy')
    return withPgTransaction(this.adapter.pool,async client=>{
      const result=await client.query("UPDATE hub_commerce.ip_channel SET enabled=$1,daily_limit=$2,spacing_ms=$3,revision=revision+1 WHERE id='baidu-v2' AND revision=$4 RETURNING *",[input.enabled,input.dailyLimit,input.spacingMs,input.revision])
      if(!result.rowCount)throw new AppError(409,'commerce_revision_conflict','Channel changed; reload')
      await client.query("INSERT INTO hub_commerce.audit(actor,action,document) VALUES('admin-token','ip-channel.saved',$1)",[input]);return result.rows[0]
    })
  }
  updateCredential(){throw new AppError(409,'credential_not_required','This channel has no API credential')}
  revealCredential(){throw new AppError(409,'credential_not_required','This channel has no API credential')}
  updateProviderPriceBook(){throw new AppError(409,'procurement_pricing_unavailable','No verified procurement price')}
}
