// Offline, reviewed WeChat-only import. Never fetch credentials or enable operations.
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const file = process.argv[2]
if (!file) throw new Error('Usage: node scripts/import-wechat-contracts.mjs OPENAPI_JSON')
const bytes = readFileSync(file), spec = JSON.parse(bytes)
const groups = { wechat_mp: ['mp', '微信公众号'], wechat_channels: ['channels', '微信视频号'], wechat_search: ['search', '微信搜一搜'] }
const clean = text => String(text || '').replace(/TikHub/gi, 'Hub').replace(/https?:\/\/[^\s`）)]+/g, '').split(/\/(?=[A-Z])/)[0].trim()
const endpoints = []
for (const [path, methods] of Object.entries(spec.paths)) {
  const platform = path.split('/')[3], group = groups[platform]
  const demo = path === '/api/v1/demo/wechat/article_extract'
  if (!group && !demo) continue
  const method = demo ? 'get' : 'post', op = methods[method]
  if (!op || op.deprecated) throw new Error(`Review method/deprecation: ${path}`)
  const slug = demo ? 'article-sample' : path.split('/').at(-1).replace(/^fetch_/, '').replaceAll('_', '-')
  const family = demo ? 'demo' : group[0], key = `wechat.${family}.${slug}`
  const ref = op.requestBody?.content?.['application/json']?.schema
  const body = ref?.$ref ? spec.components.schemas[ref.$ref.split('/').at(-1)] : ref
  const parameters = Object.entries(body?.properties || {}).map(([name, s]) => {
    const variants = s.anyOf || [s]
    if (variants.some(v => !['string','integer','number','boolean','null'].includes(v.type))) throw new Error(`Review schema: ${path} ${name}`)
    return { name, required: body.required?.includes(name) || false,
      ...Object.fromEntries(Object.entries(s).filter(([k]) => ['type','anyOf','minimum','maximum','minLength','maxLength','pattern','enum','default'].includes(k))),
      description: clean(s.description),
    }
  })
  for (const parameter of parameters) {
    const enums = { sort: [0, 1, 2, 'default', 'latest', 'hot'], publish_time: [0, 1, 2, 3, 'all', 'day', 'week', 'half_year'], duration: [0, 1, 2, 3, 'all', 'short', 'medium', 'long'] }
    if (platform === 'wechat_search' && enums[parameter.name]) parameter.enum = enums[parameter.name]
  }
  if (!demo && !/价格：0\.01\$\/次/.test(op.description)) throw new Error(`Review price: ${path}`)
  endpoints.push({ key, platform: demo ? 'wechat_mp' : platform, platformLabel: demo ? '微信演示' : group[1],
    provider: 'tikhub', path, method: method.toUpperCase(), hubPath: `/api/v1/data/wechat/${family}/${slug}`,
    summary: demo ? '固定文章演示（1 小时缓存）' : clean(op.summary), parameters, fixedQuery: {},
    authorizationPlatform: 'social', status: 'fixed_read_contract', sourceUrl: 'https://api.tikhub.io/openapi.json',
    schemaVersion: 'hub-wechat.2026-09-29', allowZeroCost: demo,
    procurementReference: { currency: 'USD', unitPrice: demo ? '0.000000' : '0.010000', observedAt: '2026-09-29',
      sourceUrl: 'https://api.tikhub.io/openapi.json', basis: demo ? 'documented_free_fixed_demo' : 'documented_base_price_per_request' },
  })
}
if (endpoints.length !== 26) throw new Error(`Review changed coverage: ${endpoints.length}`)
writeFileSync(new URL('../server/data/wechat-contracts.json', import.meta.url), JSON.stringify({ version:'hub-wechat.2026-09-29', observedAt:'2026-09-29', sourceUrl:'https://api.tikhub.io/openapi.json', sourceSha256:createHash('sha256').update(bytes).digest('hex'), endpoints },null,2)+'\n')
// Browser metadata deliberately excludes supplier coordinates and procurement.
writeFileSync(new URL('../shared/wechat-services.json', import.meta.url), JSON.stringify(endpoints.map(({key,platform,platformLabel,hubPath,summary})=>({key,platform,platformLabel,hubPath,summary,operation:`native.${key}`})),null,2)+'\n')
const previous = readFileSync(new URL('../migrations/112_native_forwarding.sql',import.meta.url),'utf8')
const tail = previous.slice(previous.indexOf('ON CONFLICT DO NOTHING;')).replaceAll('migration-112','migration-118')
writeFileSync(new URL('../migrations/118_wechat_services.sql',import.meta.url), '-- WeChat contracts only; preserve prices, grants, keys and all existing policies.\n'+previous.slice(previous.indexOf('INSERT INTO'),previous.indexOf('VALUES')+6)+'\n'+endpoints.map(row=>`  ('tikhub', 'native.${row.key}', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.${row.key}']::text[], 0, 'released')`).join(',\n')+'\n'+tail.replace("WHERE contract_version = 'mx-insight-hub.native-forwarding.v1' AND release_revision = 1", "WHERE operation_key LIKE 'native.wechat.%' AND release_revision = 1"))
console.log(`Pinned ${endpoints.length} WeChat contracts, disabled migration 118 and public metadata`)
const { NATIVE_FORWARDING_ENDPOINTS } = await import('../server/contracts/native-forwarding.mjs')
writeFileSync(new URL('../shared/native-service-access.json',import.meta.url), JSON.stringify(Object.fromEntries(['social','ecommerce'].map(platform=>[platform,NATIVE_FORWARDING_ENDPOINTS.filter(row=>row.authorizationPlatform===platform).map(row=>row.operation)])),null,2)+'\n')
