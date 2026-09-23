import test from 'node:test'
import assert from 'node:assert/strict'
import { demoAccessIssues, newsAccessIssue } from '../../src/demo-access.js'
const access = {
 platforms:['xiaohongshu'], consumerPlatforms:['xiaohongshu'],
 capabilities:['social.posts.search','social.posts.resolve','social.users.posts','compat.xiaohongshu.app_v2'],
 consumerCapabilities:['social.posts.search','social.posts.resolve','social.users.posts','compat.xiaohongshu.app_v2'],
 operations:{'social.posts.search':{ready:true},'social.posts.resolve':{ready:true},'social.users.posts':{ready:false,effectiveState:'disabled'}},
}
test('news access separates consumer category grants from Key scope and unrelated catalog permission', () => {
 const category = 'data_center_saved_records_news'
 assert.equal(newsAccessIssue(null), null)
 assert.match(newsAccessIssue({ platforms: ['source_catalog'], consumerPlatforms: ['source_catalog'] }), /当前调用者尚未开通/)
 assert.match(newsAccessIssue({ platforms: [], consumerPlatforms: [category] }), /当前 Key 未包含/)
 assert.equal(newsAccessIssue({ platforms: [category], capabilities: [] }), null)
 assert.equal(newsAccessIssue({ platforms: ['data_center_saved_records_finance'] }), null)
 assert.equal(newsAccessIssue({ platforms: ['data_center_saved_records_custom_2026'] }), null)
 assert.match(newsAccessIssue({ platforms: ['news', 'data.canonical-search', 'data_center_saved_records_'] }), /当前调用者尚未开通/)
})
test('a disabled user-posts operation does not block search or detail',()=>{
 assert.deepEqual(demoAccessIssues(access,'social.posts.search',true),[])
 assert.deepEqual(demoAccessIssues(access,'social.posts.resolve'),[])
 assert.equal(demoAccessIssues(access,'social.users.posts',true)[0].kind,'runtime')
})
test('an old key missing the data grant is diagnosed independently of enabled operations',()=>{
 const issues=demoAccessIssues({...access,platforms:[]},'social.posts.search',true)
 assert.equal(issues.length,1)
 assert.equal(issues[0].scope,'xiaohongshu')
 assert.match(issues[0].message,/当前 Key/)
})
test('native search requires both operation and compatibility grants',()=>{
 const issues=demoAccessIssues({...access,capabilities:[]},'social.posts.search',true)
 assert.deepEqual(issues.map(item=>item.scope),['social.posts.search','compat.xiaohongshu.app_v2'])
 assert.equal(demoAccessIssues({...access,capabilities:['social.posts.resolve']},'social.posts.resolve').length,0)
})

import { ipRiskAccessIssues } from '../../src/demo-access.js'
test('IP debugger distinguishes consumer grants from stale Key snapshots and refreshed access', () => {
 const consumerAccess = { consumerPlatforms: ['ip_risk'], consumerCapabilities: ['ip.risk.query'], platforms: [], capabilities: [] }
 const stale = ipRiskAccessIssues(consumerAccess)
 assert.equal(stale.length, 2)
 assert.ok(stale.every(issue => issue.message.includes('当前 Hub Key 未包含')))
 const fresh = { ...consumerAccess, platforms: ['ip_risk'], capabilities: ['ip.risk.query'] }
 assert.deepEqual(ipRiskAccessIssues(fresh), [])
 assert.deepEqual(ipRiskAccessIssues(null), []) // Manual Key remains server-validated.
 const missing = ipRiskAccessIssues({ platforms: [], capabilities: [] })
 assert.ok(missing.every(issue => issue.message.includes('所属业务尚未开通')))
 assert.deepEqual(ipRiskAccessIssues({ ...fresh, capabilities: [] }).map(issue => issue.scope), ['ip.risk.query'])
})
