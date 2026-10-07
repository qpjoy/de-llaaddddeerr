import { AppError } from '../core/errors.mjs'
import { IpRiskGateway } from './ip-risk-gateway.mjs'
import { IP_PRODUCT_CAPABILITY, IP_PRODUCT_METER, IP_PRODUCT_VERSION } from '../contracts/ip-risk-product.mjs'
export { IP_PRODUCT_VERSION }
// Product access and customer metering are independent of the delivery supplier.
export class IpRiskProduct {
  constructor(channels,commerce) {
    this.commerce=commerce
    this.gateways=Object.fromEntries(Object.entries(channels.channels).map(([key,gateway])=>[key,new IpRiskGateway({
      ...gateway,operation:IP_PRODUCT_CAPABILITY,meterKey:IP_PRODUCT_METER,version:IP_PRODUCT_VERSION,
    })]))
  }
  async capabilities() {
    const policy=await this.commerce.delivery()
    const status=await this.gateways[policy.channel]?.capabilities()
    return {operations:{[IP_PRODUCT_CAPABILITY]:{ready:status?.ready===true}}}
  }
  async adminDelivery() {
    const policy=await this.commerce.delivery(),channels=[]
    for(const [id,gateway] of Object.entries(this.gateways)) {
      const state=await gateway.capabilities().catch(()=>({ready:false}))
      channels.push({id,ready:state.ready===true})
    }
    return {...policy,channels}
  }
  async query(context,{body,...input}) {
    if(!body || Array.isArray(body) || Object.keys(body).some(k=>!['ip','ips'].includes(k)) || (!!body.ip===!!body.ips)) throw new AppError(400,'invalid_ip_request','Provide ip or ips')
    const policy=await this.commerce.delivery(),gateway=this.gateways[policy.channel]
    if(!gateway)throw new AppError(503,'ip_risk_unavailable','产品服务暂不可用')
    // One durable batch fixes the chosen gateway for all its children. Replays
    // return that original response even after the administrator changes routing.
    return gateway.batch.query(context,{...input,body:{ips:body.ips ?? [body.ip]}})
  }
}
