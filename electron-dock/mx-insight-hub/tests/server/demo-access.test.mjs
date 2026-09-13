import test from 'node:test'
import assert from 'node:assert/strict'
import { demoAccessIssues } from '../../src/demo-access.js'
const access = {
 platforms:['xiaohongshu'], consumerPlatforms:['xiaohongshu'],
 capabilities:['social.posts.search','social.posts.resolve','social.users.posts','compat.xiaohongshu.app_v2'],
 consumerCapabilities:['social.posts.search','social.posts.resolve','social.users.posts','compat.xiaohongshu.app_v2'],
 operations:{'social.posts.search':{ready:true},'social.posts.resolve':{ready:true},'social.users.posts':{ready:false,effectiveState:'disabled'}},
}
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
