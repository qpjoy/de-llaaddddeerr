// Offline importer. Inputs are downloaded official OpenAPI documents, never credentials.
// The resulting registry is code-owned and reviewable; runtime cannot import URLs.
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const [tikFile, justDir] = process.argv.slice(2)
if (!tikFile || !justDir) throw new Error('Usage: node scripts/import-provider-contracts.mjs TIKHUB_OPENAPI JUSTONE_SPEC_DIRECTORY')
const sha = value => createHash('sha256').update(value).digest('hex')
const clean = text => String(text || '').replace(/https?:\/\/\S+/g, '').replace(/TikHub|Just\s*One(?:\s*API)?/gi, 'Hub').slice(0,600)
const social = new Set('tiktok douyin xigua toutiao xiaohongshu lemon8 kuaishou zhihu pipixia weibo wechat_channels wechat_mp wechat_search instagram youtube linkedin bilibili telegram twitter threads reddit'.split(' '))
const commerce = new Set('taobao jd xianyu douyin-ec xiaohongshu-ec 1688 aliexpress shopee tiktok-shop amazon'.split(' '))
const platformLabels = { douyin:'抖音', xigua:'西瓜视频', toutiao:'今日头条', xiaohongshu:'小红书', kuaishou:'快手', zhihu:'知乎', pipixia:'皮皮虾', weibo:'微博', wechat_channels:'微信视频号', wechat_mp:'微信公众号', wechat_search:'微信搜一搜', bilibili:'哔哩哔哩', tiktok:'TikTok', lemon8:'Lemon8', instagram:'Instagram', youtube:'YouTube', linkedin:'LinkedIn', telegram:'Telegram', twitter:'X / Twitter', threads:'Threads', reddit:'Reddit' }
const prohibited = /cookie|authorization|password|secret|proxy|captcha|sessionid|api.?key|access.?token|callback|webhook/i
const rows = [], sources = []
function collect(provider, spec, sourceUrl, bytes) {
  sources.push({ provider, url: sourceUrl, version: spec.info?.version || null, sha256: sha(bytes) })
  for (const [path, item] of Object.entries(spec.paths || {})) for (const method of ['get','post','put','delete','patch']) {
    const op = item[method]; if (!op) continue
    const platform = provider === 'tikhub' ? path.split('/')[3] : path.split('/')[2]
    const sourcePlatform = spec.tags?.[0]?.['x-platform-id'] || platform
    let reason = null
    const params = [...(item.parameters || []), ...(op.parameters || [])]
    const business = params.filter(p => !(provider === 'justone' && p.in === 'query' && p.name === 'token'))
    if (method !== 'get' || op.requestBody) reason = 'requires_method_or_body_review'
    else if (op.deprecated) reason = 'deprecated'
    else if (provider === 'tikhub' && !social.has(platform)) reason = 'non_data_operation'
    else if (/open_douyin_app|login|logout|sign(?:ature|_url)|generate|create|delete|update|send_|subscribe|payment|download.*file|solve|register/i.test(path)) reason = 'non_read_operation'
    else if (business.some(p => p.in !== 'query' || !p.name || prohibited.test(p.name) || p.name === 'token')) reason = 'credential_or_non_query_parameter'
    const parameters = business.map(p => {
      let s = p.schema || {}
      if (s.anyOf) { const variants = s.anyOf.filter(x => x.type !== 'null'); s = variants.length === 1 ? variants[0] : s }
      if (!['string','integer','number','boolean'].includes(s.type) || s.$ref || s.anyOf || s.oneOf) reason ||= 'complex_parameter_schema'
      return { name:p.name, required:p.required === true, type:s.type || 'unsupported',
        description:clean(p.description || s.description),
        ...(s.default != null ? { default:s.default } : {}), ...(s.enum ? { enum:s.enum } : {}),
        ...Object.fromEntries(['minimum','maximum','minLength','maxLength','pattern'].filter(k => s[k] !== undefined).map(k => [k,s[k]])),
      }
    })
    const key = `${provider === 'tikhub' ? 't' : 'j'}.api_${sha(`${method}:${path}`).slice(0,16)}`
    rows.push({ provider, key, platform, platformLabel:provider === 'justone' ? spec.tags?.[0]?.name || platform : platformLabels[platform] || platform,
      sourcePlatform, path, method:method.toUpperCase(), summary:clean(op.summary || spec.info?.title || path.split('/').at(-1)),
      parameters, fixedQuery:{}, authorizationPlatform:commerce.has(platform) ? 'ecommerce' : 'social',
      status:reason ? 'documented_only' : 'fixed_read_contract', reason, sourceUrl,
    })
  }
}
const tikBytes = readFileSync(tikFile,'utf8')
collect('tikhub', JSON.parse(tikBytes), 'https://api.tikhub.io/openapi.json', tikBytes)
const manifest = JSON.parse(readFileSync(`${justDir}/manifest.json`,'utf8'))
for (const entry of manifest.filter(row => row.file)) {
  const bytes = readFileSync(`${justDir}/${entry.file}`,'utf8')
  collect('justone', JSON.parse(bytes), entry.url, bytes)
}
const unique = [...new Map(rows.map(row => [`${row.provider}:${row.method}:${row.path}`,row])).values()]
const snapshot = { version:'hub-provider-docs.2026-09-27', observedAt:'2026-09-27', sources,
  collection:{ justonePages:manifest.length, justoneErrors:manifest.filter(row=>row.error).map(row=>({page:row.page,error:'document_unavailable'})) },
  endpoints:unique }
writeFileSync(new URL('../server/data/provider-official-contracts.json',import.meta.url), JSON.stringify(snapshot,null,2)+'\n')
console.log(JSON.stringify({endpoints:unique.length, fixed:unique.filter(row=>row.status==='fixed_read_contract').length,
  deferred:Object.fromEntries([...new Set(unique.map(row=>row.reason).filter(Boolean))].map(reason=>[reason,unique.filter(row=>row.reason===reason).length]))}))
const {NATIVE_FORWARDING_ENDPOINTS} = await import('../server/contracts/native-forwarding.mjs')
writeFileSync(new URL('../shared/native-service-access.json',import.meta.url), JSON.stringify(Object.fromEntries(['social','ecommerce'].map(platform=>[platform,NATIVE_FORWARDING_ENDPOINTS.filter(row=>row.authorizationPlatform===platform).map(row=>row.operation)])),null,2)+'\n')
const added = NATIVE_FORWARDING_ENDPOINTS.filter(row=>row.schemaVersion)
const values = added.map(row=>`  ('${row.provider}', '${row.operation}', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['${row.endpointKey}']::text[], 0, 'released')`).join(',\n')
const previous = readFileSync(new URL('../migrations/112_native_forwarding.sql',import.meta.url),'utf8')
const tail = previous.slice(previous.indexOf('ON CONFLICT DO NOTHING;')).replaceAll('migration-112','migration-114')
writeFileSync(new URL('../migrations/114_official_provider_contracts.sql',import.meta.url),
  '-- Official fixed read contracts. Preserve all existing prices, grants, rollout states and legacy routes.\n'+previous.slice(previous.indexOf('INSERT INTO'),previous.indexOf('VALUES')+6)+'\n'+values+'\n'+tail)
console.log(`New fixed contracts: ${added.length}; migration 114 starts disabled`)
