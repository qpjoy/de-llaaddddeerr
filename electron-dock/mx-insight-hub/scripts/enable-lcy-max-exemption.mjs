import { pathToFileURL } from 'node:url'

export const LCY_KEY_ID = 'fd2f8cc9-0ff1-4052-a538-8cc8150bde83'
// Run inside the Admin Pod. No Key secret, SQL mutation, rollout or supplier request.
export async function enableLcyMaxExemption({ token, port = '18151', apply = false, fetchImpl = fetch }) {
  if (!token || !/^\d{1,5}$/.test(String(port)) || Number(port)<1 || Number(port)>65535) throw Error('Admin token or port is unavailable')
  const url = `http://127.0.0.1:${port}/internal/v1/admin/api-keys/${LCY_KEY_ID}/hub-limits`
  async function request(body) {
    let response
    try { response = await fetchImpl(url, { method: body ? 'PUT' : 'GET', redirect:'error', signal:AbortSignal.timeout(15000),
      headers:{'x-mx-insight-admin-token':token,...(body?{'content-type':'application/json'}:{})}, ...(body?{body:JSON.stringify(body)}:{}) }) }
    catch { throw Error(body ? 'Save outcome unknown; read current state before another apply. No automatic retry.' : 'Admin state read failed') }
    const payload = await response.json().catch(()=>null)
    if(!response.ok || !payload?.data) throw Error(`Admin ${body?'save':'read'} failed (HTTP ${response.status}); reread before applying again`)
    const value=payload.data
    if(value.apiKeyId!==LCY_KEY_ID || value.policyVersion!==2 || !Number.isSafeInteger(value.revision)) throw Error('Expected LCY policyVersion 2; deploy the updated Hub first')
    return value
  }
  const before=await request()
  if(!apply) return {applied:false,state:before}
  if(before.effectiveExempt===true && before.hubRateLimitExempt===true) return {applied:false,alreadyEnabled:true,state:before}
  await request({hubRateLimitExempt:true,revision:before.revision,reason:'用户要求 LCY-delta 最大 Hub 豁免：次数、频率、并发、采购/补贴预算和自动供应商熔断等待；保留计费与主动暂停'})
  const state=await request()
  if(state.effectiveExempt!==true || state.hubRateLimitExempt!==true) throw Error('The final state is not enabled; inspect concurrent changes')
  return {applied:true,state}
}

if (process.argv[1] === '-' || import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    const args=process.argv.slice(2)
    if(args.length>1 || args.some(arg=>!['--apply','--preview'].includes(arg))) throw Error('Usage: node scripts/enable-lcy-max-exemption.mjs [--preview|--apply]')
    console.log(JSON.stringify(await enableLcyMaxExemption({token:process.env.MX_INSIGHT_ADMIN_TOKEN,port:process.env.MX_INSIGHT_PORT||'18151',apply:args.includes('--apply')}),null,2))
  } catch(error) {console.error(error.message);process.exitCode=1}
}
