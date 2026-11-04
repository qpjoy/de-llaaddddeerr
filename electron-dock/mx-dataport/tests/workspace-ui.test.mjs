import test from 'node:test'
import { usageTrend } from '../apps/web/usage-trend.ts'
import assert from 'node:assert/strict'
import { ipLocation } from '../apps/web/ip-location.ts'
import { curlExample, documentOperations, exampleValue, resolveSchema } from '../apps/web/documentation-model.ts'

test('IP GIS uses only valid source coordinates and does not fabricate locations or a CRS', () => {
  for(const profile of [null,{}, {latitude:0}, {longitude:'0',latitude:0}, {longitude:181,latitude:0}, {longitude:0,latitude:91}, {longitude:NaN,latitude:0}]) assert.equal(ipLocation(profile),null)
  const zero=ipLocation({longitude:0,latitude:0})
  assert.ok(zero.embed);assert.equal(zero.wgs84,false);assert.ok(!new URL(zero.embed).searchParams.has('marker'))
  const known=ipLocation({longitude:120,latitude:30,coordinate_system:'WGS84'})
  assert.equal(new URL(known.embed).searchParams.get('marker'),'30,120')
  assert.equal(ipLocation({longitude:120,latitude:30,coordinate_system:'GCJ02'}).embed,null)
  assert.equal(ipLocation({longitude:0,latitude:89}).embed,null)
  assert.equal(new URL(known.embed).origin,'https://www.openstreetmap.org')
})

test('documentation follows filtered OpenAPI, resolves local refs and builds safe non-executing examples', () => {
  const doc={paths:{'/data/ip/risk/service':{parameters:[{$ref:'#/components/parameters/request'}],post:{summary:'IP risk',requestBody:{content:{'application/json':{schema:{$ref:'#/components/schemas/Body'}}}}}}},components:{parameters:{request:{name:'Idempotency-Key',in:'header',required:true,schema:{type:'string'}}},schemas:{Body:{type:'object',required:['ip'],properties:{ip:{type:'string',example:'203.0.113.1'},unneeded:{type:'string'}}},cycle:{$ref:'#/components/schemas/cycle'}}}}
  const ops=documentOperations(doc);assert.equal(ops.length,1);assert.equal(ops[0].method,'post')
  assert.deepEqual(exampleValue(doc,{$ref:'#/components/schemas/Body'}),{ip:'203.0.113.1'})
  assert.deepEqual(resolveSchema(doc,{$ref:'#/components/schemas/cycle'}),{})
  const example=curlExample(doc,ops[0],'https://harbor.test')
  assert.match(example,/https:\/\/harbor.test\/api\/v1\/data\/ip\/risk\/service/)
  assert.match(example,/\$HARBOR_API_KEY/);assert.match(example,/YOUR_UNIQUE_REQUEST_ID/);assert.match(example,/203\.0\.113\.1/)
  assert.equal(documentOperations({paths:{}}).length,0)
})
test('rolling usage trend retains both UTC dates and fills empty days in calendar ranges', () => {
  const rows=[{day:'2026-11-03',requests:2,committed:1},{day:'2026-11-04',requests:3,committed:2}]
  assert.deepEqual(usageTrend({from:'2026-11-03T08:30:00Z',to:'2026-11-04T08:30:00Z',daily:rows}),rows)
  const week=usageTrend({from:'2026-10-29T00:00:00Z',to:'2026-11-04T08:30:00Z',daily:rows})
  assert.equal(week.length,7);assert.deepEqual(week[0],{day:'2026-10-29',requests:0,committed:0})
  assert.equal(week.reduce((n,row)=>n+row.requests,0),5)
  assert.deepEqual(usageTrend(null),[])
})
