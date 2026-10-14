import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { inspectContentArchive, diagnoseContentSearch, contentDiagnosticFailure, inspectDouyinEntryCoverage, inspectContentFillCoverage, inspectSingleCardSchema, isDouyinIncidentCardSource } from '../../server/ops/diagnose-content-search.mjs'
import { normalizeTikHubContentSearchRequest } from '../../server/contracts/tikhub-content-search.mjs'
const digest=bytes=>createHash('sha256').update(bytes).digest('hex')
const archiveFor=payload=>{const bytes=Buffer.from(JSON.stringify(payload));return {body_bytes:bytes,body_size:bytes.length,body_sha256:digest(bytes),captured_at:new Date().toISOString()}}
test('offline content diagnostic verifies full archive and reports only fixed shapes/counts',()=>{
  const payload={code:200,data:{has_more:false,mixFeeds:[{photoId:'private-id',caption:'private-body',likeCount:7,shareText:'private-secret'}]}}
  const archive=archiveFor(payload),snapshot={path:'/api/v1/data/search',body:{platform:'kuaishou',query:'private-query',pageSize:20}}
  const report=inspectContentArchive(archive,snapshot,'kuaishou')
  assert.equal(report.hashVerified,true);assert.equal(report.projection.state,'candidate_accepts');assert.equal(report.projection.itemCount,1)
  assert.doesNotMatch(JSON.stringify(report),/private-/)
  assert.equal(inspectContentArchive({...archive,body_size:archive.body_size+1},snapshot,'kuaishou').state,'archive_integrity_failed')
  assert.equal(inspectContentArchive({...archive,body_sha256:'0'.repeat(64)},snapshot,'kuaishou').state,'archive_integrity_failed')
  const invalid=Buffer.from([0xff])
  assert.equal(inspectContentArchive({...archive,body_bytes:invalid,body_size:1,body_sha256:digest(invalid)},snapshot,'kuaishou').state,'archive_not_json_utf8')
})
test('offline diagnostic resolves supplied ledger or idempotency IDs, keeps followups same-Key and SQL strictly readonly',async()=>{
  const id=randomUUID(),callId=randomUUID(),identifier=randomUUID(),sql=[]
  const snapshot={path:'/api/v1/data/search',body:{platform:'kuaishou',query:'private-query',pageSize:20}}
  const endpoint=normalizeTikHubContentSearchRequest({platform:'kuaishou',query:'fixture'})
  const archive=archiveFor({code:200,data:{has_more:false,mixFeeds:[{photoId:'private-id',caption:'private-content'}]}})
  const client={release(){sql.push('RELEASE')},async query(statement,args){
    sql.push(statement)
    if(statement.includes('idempotency_key = ANY')) {assert.deepEqual(args,[[identifier],[identifier]]);return {rows:[{id,platform:'kuaishou',status:'unknown',error_code:'external_platform_persistence_unknown',reserved_at:new Date(),acquisition_request:snapshot,matched_idempotency_key:true}]}}
    if(statement.includes('row_number()')){assert.match(statement,/matched\.tenant_id=followup\.tenant_id/);assert.match(statement,/matched\.api_key_id=followup\.api_key_id/);assert.match(statement,/rn<=3/);assert.deepEqual(args,[[id]]);return {rows:[]}}
    if(statement.includes('clock_timestamp')) return {rows:[{database_now:new Date()}]}
    if(statement.includes('FROM external_platform.provider_calls')) return {rows:[{id:callId,usage_request_id:id,operation:endpoint.operation,
      endpoint_key:endpoint.endpointKey,endpoint_version:endpoint.endpointVersion,contract_version:endpoint.endpointContractVersion,
      outcome:'succeeded',http_status:200,business_code:200,item_count:1,started_at:new Date(),completed_at:new Date(),acquisition_request:snapshot,...archive}]}
    if(statement.includes('AS operational_archive')){assert.match(statement,/mxq\.jobs/);assert.match(statement,/mx-insight-hub:ingest/);return {rows:[{operational_archive:true,archive_objects:1,ingest_job:true}]}}
    return {rows:[]}
  }}
  const report=await diagnoseContentSearch({connect:async()=>client},[identifier])
  assert.equal(report.requests[0].requestId,id);assert.equal(report.requests[0].matchedIdempotencyKey,true)
  assert.equal(report.requests[0].evidence[0].archive.projection.state,'candidate_accepts')
  assert.doesNotMatch(JSON.stringify(report),/private-/)
  assert.match(sql[0],/READ ONLY/)
  assert.ok(sql.every(statement=>/^(?:BEGIN|SET LOCAL|SELECT|ROLLBACK|RELEASE)/.test(statement)))
  await assert.rejects(diagnoseContentSearch({},['invalid']),/invalid_identifiers/)
})
test('PGlite diagnostic reads real schema and limits screenshot followups to the matched calling identity',{skip:!process.env.MX_INSIGHT_TEST_PGLITE_MODULE},async t=>{
  const {pathToFileURL}=await import('node:url')
  const {PGlite}=await import(pathToFileURL(process.env.MX_INSIGHT_TEST_PGLITE_MODULE).href)
  const db=new PGlite();t.after(()=>db.close())
  await db.exec(`CREATE SCHEMA external_platform;CREATE SCHEMA control;CREATE SCHEMA mxq;
    CREATE TABLE usage_requests(id uuid,tenant_id uuid,consumer_id uuid,api_key_id uuid,idempotency_key text,
      platform text,status text,error_code text,response_status int,reserved_at timestamptz,completed_at timestamptz,acquisition_request jsonb);
    CREATE TABLE external_platform.provider_calls(id uuid,usage_request_id uuid,provider_key text,operation text,endpoint_key text,
      endpoint_version text,contract_version text,outcome text,http_status int,business_code int,billed boolean,error_code text,item_count int,started_at timestamptz,completed_at timestamptz);
    CREATE TABLE control.external_platform_restricted_raw_responses(provider_call_id uuid,body_bytes bytea,body_size int,body_sha256 text,captured_at timestamptz);
    CREATE TABLE external_platform.response_archives(provider_call_id uuid);
    CREATE TABLE external_platform.archive_objects(provider_call_id uuid);
    CREATE TABLE mxq.jobs(queue text,dedupe_key text);`)
  const requestId=randomUUID(),idem=randomUUID(),tenantId=randomUUID(),consumerId=randomUUID(),keyId=randomUUID(),callId=randomUUID()
  const seed=async(id,key,platform,query)=>db.query(`INSERT INTO usage_requests VALUES($1,$2,$3,$4,$5,$6,'unknown',NULL,NULL,now(),now(),$7)`,
    [id,tenantId,consumerId,key,idem,platform,JSON.stringify({path:'/api/v1/data/search',body:{platform,query,pageSize:20}})])
  await seed(requestId,keyId,'kuaishou','private-query')
  const ownWeibo=randomUUID();await seed(ownWeibo,keyId,'weibo','王一博')
  await seed(randomUUID(),randomUUID(),'weibo','王一博')
  const ownDouyin=randomUUID(),ownBilibili=randomUUID(),ownZhihu=randomUUID()
  await seed(ownDouyin,keyId,'douyin','深夜热舞')
  await seed(ownBilibili,keyId,'bilibili','private-bilibili-query')
  await seed(ownZhihu,keyId,'zhihu','private-zhihu-query')
  const endpoint=normalizeTikHubContentSearchRequest({platform:'kuaishou',query:'fixture'}),archive=archiveFor({code:200,data:{has_more:false,mixFeeds:[{photoId:'id',caption:'private-content'}]}})
  await db.query(`INSERT INTO external_platform.provider_calls VALUES($1,$2,'tikhub',$3,$3,$4,$5,'succeeded',200,200,true,NULL,1,now(),now())`,[callId,requestId,endpoint.endpointKey,endpoint.endpointVersion,endpoint.endpointContractVersion])
  await db.query(`INSERT INTO control.external_platform_restricted_raw_responses VALUES($1,$2,$3,$4,$5)`,[callId,archive.body_bytes,archive.body_size,archive.body_sha256,archive.captured_at])
  const pool={connect:async()=>({query:(sql,args)=>db.query(sql,args),release(){}})}
  const report=await diagnoseContentSearch(pool,[requestId,ownBilibili,ownZhihu])
  assert.equal(report.diagnosticRevision,'content-search-diagnostic.v7')
  assert.deepEqual(new Set(report.requests.map(row=>row.requestId)),new Set([requestId,ownWeibo,ownDouyin,ownBilibili,ownZhihu]))
  assert.deepEqual(new Set(report.requests.map(row=>row.platform)),new Set(['kuaishou','zhihu','douyin','weibo','bilibili']))
  assert.equal(report.requests.find(row=>row.requestId===requestId).evidence[0].archive.projection.state,'candidate_accepts')
  assert.equal(report.requests.find(row=>row.requestId===ownWeibo).recentSameKeyCandidate,true)
  assert.equal(report.requests.find(row=>row.requestId===ownDouyin).recentSameKeyCandidate,true)
  assert.doesNotMatch(JSON.stringify(report),/private-/)
  assert.equal((await db.query('SELECT count(*)::int AS n FROM usage_requests')).rows[0].n,6)
})


test('diagnostic failures preserve only fixed safe stage/type/SQLSTATE and never raw messages',async()=>{
  for (const failAt of ['connect','lookup_provider_calls','read_persistence_status']) {
    const requestId=randomUUID(),callId=randomUUID(),privateError=new TypeError('private://credentials/query/body')
    const client={release(){},async query(sql){
      if(sql.includes('idempotency_key = ANY')) return {rows:[{id:requestId,platform:'douyin',reserved_at:new Date(),acquisition_request:{body:{query:'private-query'}}}]}
      if(sql.includes('clock_timestamp')) return {rows:[{database_now:new Date()}]}
      if(sql.includes('FROM external_platform.provider_calls')) {
        if(failAt==='lookup_provider_calls') throw privateError
        return {rows:[{id:callId}]}
      }
      if(sql.includes('AS operational_archive')&&failAt==='read_persistence_status') throw privateError
      return {rows:[]}
    }}
    let failure
    try { await diagnoseContentSearch({connect:async()=>{if(failAt==='connect') throw privateError;return client}},[requestId]) }
    catch(error){failure=error}
    const report=contentDiagnosticFailure(failure)
    assert.equal(report.stage,failAt)
    assert.equal(report.errorType,'TypeError')
    assert.equal(report.sqlState,null)
    assert.equal(report.requestId,failAt==='connect'?null:requestId)
    assert.doesNotMatch(JSON.stringify(report),/private|credentials|query\/body/)
  }
  const error=Object.assign(new Error('private SQL payload'),{code:'42703'})
  assert.equal(contentDiagnosticFailure(error).sqlState,'42703')
  assert.doesNotMatch(JSON.stringify(contentDiagnosticFailure(error)),/private/)
})

test('invalid captured timestamps produce a bounded projection result rather than aborting the batch',()=>{
  const archive=archiveFor({code:200,data:{has_more:false,mixFeeds:[]}})
  const report=inspectContentArchive({...archive,captured_at:'infinity'}, {path:'/api/v1/data/search',body:{platform:'kuaishou',query:'private-query'}},'kuaishou')
  assert.equal(report.projection.state,'candidate_rejects')
  assert.equal(report.projection.reason,'invalid_content_search_capture_time')
})

test('Douyin v3 coverage locates the rejected eighth fixed-array row without exposing content or changing evidence',()=>{
  const capturedAt=new Date().toISOString(),request=normalizeTikHubContentSearchRequest({platform:'douyin',query:'private-query'})
  const post=index=>({aweme_id:`private-id-${index}`,desc:`private-body-${index}`,author:{uid:'private-author'},
    statistics:{digg_count:0},video:{play_addr:{url_list:['https://private.example/video?token=private-token']}}})
  const rows=Array.from({length:7},(_,index)=>({type:1,aweme_info:post(index)}))
  rows.push({type:99,aweme_info:{desc:'private-last-body',author:{uid:'private-last-author'}}})
  const payload={code:200,data:{data:rows,aweme_list:null,has_more:1,cursor:20,
    log_pb:{impr_id:'private-session'},backtrace:'private-trace'}}
  const original=structuredClone(payload),coverage=inspectDouyinEntryCoverage(payload,request,capturedAt)
  assert.equal(coverage.available,true)
  assert.equal(coverage.entryCount,8)
  assert.equal(coverage.examined,8)
  assert.equal(coverage.truncated,false)
  assert.equal(coverage.entries.findIndex(entry=>entry.projection.state==='candidate_rejects'),7)
  assert.ok(coverage.entries.slice(0,7).every(entry=>entry.projection.itemCount===1&&entry.projection.postgresSafeItems===true))
  assert.deepEqual(coverage.entries[7].projection,{state:'candidate_rejects',reason:'invalid_content_search_identity'})
  assert.equal(coverage.entries[7].selected.aweme_id,'missing')
  assert.equal(coverage.entries[7].wrapper.aweme_info,'object')
  assert.equal(coverage.entries[7].type,99,'numeric card types are reported structurally, not interpreted as a runtime skip rule')
  assert.doesNotMatch(JSON.stringify(coverage),/private-|private\.example/)
  assert.deepEqual(payload,original)
  const report=inspectContentArchive(archiveFor(payload),{path:'/api/v1/data/search',body:{platform:'douyin',query:'private-query',pageSize:20}},'douyin')
  assert.equal(report.hashVerified,true)
  assert.equal(report.projection.reason,'invalid_content_search_identity')
  assert.equal(report.entryCoverage.entries[7].index,7)
  assert.doesNotMatch(JSON.stringify(report),/private-/)
})

test('Douyin v3 identity states and known wrapper paths preserve safe numeric IDs and expose no identity values',()=>{
  const request=normalizeTikHubContentSearchRequest({platform:'douyin',query:'private-query'}),capturedAt=new Date().toISOString()
  const payload={data:{data:[
    {type:1,aweme_info:{aweme_id:'private-direct',desc:'private-text'}},
    {type:2,data:{aweme_info:{aweme_id:1234567,desc:'private-nested'}}},
    {type:3,data:{aweme_id:'private-data-id',desc:'private-data-text'}},
    {type:4,awemeId:'private-camel-id',desc:'private-camel-text'},
    {type:5,aweme_info:{aweme_id:Number.MAX_SAFE_INTEGER+2,desc:'private-unsafe'}},
    {type:6,aweme_info:{aweme_id:null}},
    {type:7,aweme_info:{aweme_id:''}},
    {type:8,aweme_info:{aweme_id:true}},
    {type:'related_search',privateNested:{aweme_id:'private-never-collect'}},
    {type:9,aweme_info:{aweme_id:'private-'+ 'x'.repeat(257)}},
    {type:10,aweme_info:{aweme_id:'private-\u0000-id'}},
    {type:11,aweme_info:{aweme_id:1.5}},
  ],aweme_list:null,has_more:false}}
  const coverage=inspectDouyinEntryCoverage(payload,request,capturedAt),entries=coverage.entries
  assert.equal(entries[0].selected.aweme_id,'valid_string')
  assert.equal(entries[1].selected.aweme_id,'safe_positive_integer')
  assert.equal(entries[1].wrapper['data.aweme_info'],'object')
  assert.equal(entries[2].selected.aweme_id,'valid_string')
  assert.equal(entries[3].selected.awemeId,'valid_string')
  assert.ok(entries.slice(0,4).every(entry=>entry.projection.state==='candidate_accepts'&&entry.projection.itemCount===1))
  assert.equal(entries[4].selected.aweme_id,'unsafe_integer')
  assert.equal(entries[5].selected.aweme_id,'null')
  assert.equal(entries[6].selected.aweme_id,'invalid_string')
  assert.equal(entries[7].selected.aweme_id,'invalid_type')
  assert.ok(entries.slice(4,8).every(entry=>entry.projection.reason==='invalid_content_search_identity'))
  assert.deepEqual(entries[8].projection,{state:'candidate_accepts',itemCount:0,nonPostCount:1,postgresSafeItems:true})
  assert.equal(entries[9].selected.aweme_id,'invalid_string')
  assert.equal(entries[10].selected.aweme_id,'invalid_string')
  assert.equal(entries[11].selected.aweme_id,'invalid_number')
  assert.ok(entries.slice(9).every(entry=>entry.projection.reason==='invalid_content_search_identity'))
  assert.doesNotMatch(JSON.stringify(coverage),/private-|1234567|9007199254740992/)
})

test('Douyin v3 coverage bounds rows and card enums and reports invalid timestamps without throwing',()=>{
  const request=normalizeTikHubContentSearchRequest({platform:'douyin',query:'private-query'})
  const payload={data:{data:Array.from({length:70},(_,index)=>({type:index===0?'private-type':index===1?999999:index===2?-1:1,
    itemType:'private-item-type',aweme_info:{aweme_id:`private-${index}`,desc:'private-body'}})),aweme_list:null,has_more:false}}
  const original=structuredClone(payload),coverage=inspectDouyinEntryCoverage(payload,request,new Date().toISOString())
  assert.equal(coverage.entryCount,70)
  assert.equal(coverage.examined,50)
  assert.equal(coverage.truncated,true)
  assert.equal(coverage.entries.length,50)
  assert.equal(coverage.entries[0].type,'string')
  assert.equal(coverage.entries[1].type,'other_number')
  assert.equal(coverage.entries[2].type,'other_number')
  assert.ok(coverage.entries.every(entry=>entry.itemType==='string'))
  assert.ok(JSON.stringify(coverage).length<100000)
  assert.doesNotMatch(JSON.stringify(coverage),/private-|999999/)
  assert.deepEqual(payload,original)
  const invalidTime=inspectDouyinEntryCoverage({data:{data:[payload.data.data[0]],has_more:false}},request,'private-invalid-date')
  assert.deepEqual(invalidTime.entries[0].projection,{state:'candidate_rejects',reason:'invalid_content_search_capture_time'})
  for(const value of [null,{}, {data:{data:'private-content'}},{data:{data:[],aweme_list:[]}},{data:{data:[],business_data:[]}}]) {
    assert.deepEqual(inspectDouyinEntryCoverage(value,request,new Date().toISOString()),{available:false})
  }
  const invalidEntry=inspectDouyinEntryCoverage({data:{data:[null],has_more:false}},request,new Date().toISOString())
  assert.equal(invalidEntry.entries[0].wrapper.entry,'null')
  assert.deepEqual(invalidEntry.entries[0].projection,{state:'candidate_rejects',reason:'invalid_content_search_entry'})
})

test('Douyin v4 exposes only fixed outer and inner card field shapes, preserving true nested camel identity',()=>{
  const request=normalizeTikHubContentSearchRequest({platform:'douyin',query:'private-query'}),capturedAt=new Date().toISOString()
  const payload={data:{data:[
    {type:6,data:{cha_info:{cha_id:'private-topic-id',challenge_name:'private-topic',desc:'private-topic-description'},
      query_list:[{query:'private-recommendation'}],'private-key':'private-value'}},
    {type:6,data:{awemeId:'private-real-id',desc:'private-real-content',video:{play_addr:{url_list:['https://private.example/video?token=private-token']}}}},
  ],aweme_list:null,has_more:false}}
  const original=structuredClone(payload),coverage=inspectDouyinEntryCoverage(payload,request,capturedAt)
  const marker=coverage.entries[0],real=coverage.entries[1]
  assert.equal(marker.projection.state,'candidate_rejects','unverified type6 marker is not silently treated as a non-post')
  assert.equal(marker.cardShape.fields.data,'object')
  assert.equal(marker.cardShape.nested.data.ownKeyCount,3)
  assert.equal(marker.cardShape.nested.data.identities.awemeId,'missing')
  assert.equal(marker.cardShape.nested.data.fields.cha_info,'object')
  assert.equal(marker.cardShape.nested.data.fields.query_list,'array')
  assert.equal(marker.cardShape.nested.data.nested.cha_info.fields.challenge_name,'string')
  assert.equal(marker.cardShape.nested.data.nested.query_list.count,1)
  assert.equal(real.selected.awemeId,'valid_string')
  assert.equal(real.cardShape.nested.data.identities.awemeId,'valid_string')
  assert.equal(real.projection.itemCount,1)
  assert.doesNotMatch(JSON.stringify(coverage),/private-|private\.example/)
  assert.deepEqual(payload,original)
})

test('Douyin v4 detailed card shapes have a shared node budget and never print arbitrary field names',()=>{
  const request=normalizeTikHubContentSearchRequest({platform:'douyin',query:'private-query'})
  const payload={data:{data:Array.from({length:70},()=>({type:6,data:{query_list:Array.from({length:100},()=>({query:'private-recommendation','private-key':'private-value'}))}})),has_more:false}}
  const coverage=inspectDouyinEntryCoverage(payload,request,new Date().toISOString())
  assert.equal(coverage.examined,50)
  assert.equal(coverage.truncated,true)
  const nodes=[]
  const visit=value=>{if(value&&typeof value==='object'){if(Object.hasOwn(value,'kind'))nodes.push(value);for(const child of Object.values(value))visit(child)}}
  coverage.entries.forEach(entry=>visit(entry.cardShape))
  assert.ok(nodes.filter(node=>!node.truncated).length<=24)
  assert.ok(nodes.some(node=>node.truncated))
  assert.ok(JSON.stringify(coverage).length<150000)
  assert.doesNotMatch(JSON.stringify(coverage),/private-/)
})

// Synthetic values reproduce only the complete field/type schema reported by
// v6. That report sampled two recommendation rows; v7 must validate all six.
const douyinRecommendationCard=()=>({
  type:6,
  related_word_list:Array.from({length:6},()=>({
    related_word:'private-recommendation',
    word_record:{group_id:'private-group',words_position:0,words_content:'private-word',words_source:'private-source',
      words_image:{url_list:['https://private.example/recommendation?token=private-token']},force_update_rank:false,product_id:'private-product'},
    related_img:'https://private.example/image?token=private-token',rand_num:0,
    extra_info:{words_type:'private-word-type'},
  })),
  words_query_record:{info:'{}',words_source:'private-source',query_id:'private-query-id'},
  card_info:{index:0,fingerprint:'private-fingerprint',double_n:0,pos:0,first_pos:0},
  doc_type:0,sub_card_list:null,ui_info:{quality_style_corner_type:0,is_waterfall_layout:0},
  provider_doc_id:0,provider_doc_id_str:'private-document-id',tab:null,show_tab:null,debug_diff_info:{},aweme_list:null,
  send_back:'private-send-back',card_type:9,card_style_type:0,ecom_goods_list:null,music_info_list:null,
  debug_data:{filter_debug_info_list:null},card_type_name:'private-card-name',ops:null,card_id:'private-card-id',
  qishui_music_list:null,shoot_position_list:null,
  data:{card_tags:null,rs_extra_info:{hide_related_words:null,impr_extra:'{}',hide_related_words_id:null,query_id:'private-query-id'},
    hotspot_tab_config:null,common_tab_config:null},
})

test('Douyin v7 verifies the full recommendation-card candidate while preserving all eight source rows and private values',()=>{
  const rows=Array.from({length:7},(_,index)=>({type:1,aweme_info:{aweme_id:`private-${index}`,desc:'private-body'}}))
  rows.splice(4,0,douyinRecommendationCard())
  const payload={code:200,data:{data:rows,aweme_list:null,has_more:1,cursor:20,backtrace:'private-token',log_pb:{impr_id:'private-session'}}}
  const snapshot={path:'/api/v1/data/search',body:{platform:'douyin',query:'private-query',pageSize:20}}
  const original=structuredClone(payload),archive=archiveFor(payload),bytes=Buffer.from(archive.body_bytes)
  const report=inspectContentArchive(archive,snapshot,'douyin')
  assert.equal(report.hashVerified,true)
  assert.equal(report.projection.state,'candidate_accepts')
  assert.equal(report.projection.itemCount,7)
  assert.equal(report.projection.nonPostCount,1)
  assert.equal(report.projection.duplicateCount,0)
  assert.equal(report.projection.hasMore,true)
  assert.equal(report.projection.postgresSafeItems,true)
  assert.equal(report.entryCoverage.entryCount,8)
  const card=report.entryCoverage.entries[4]
  assert.deepEqual(card.projection,{state:'candidate_accepts',itemCount:0,nonPostCount:1,postgresSafeItems:true})
  assert.equal(card.compatibility.relatedWordsCard,true)
  assert.deepEqual(card.compatibility.relatedWordsCoverage,{metadataAccepted:true,relatedWordCount:6,
    inspectedCount:6,invalidIndexes:[],truncated:false})
  assert.equal(card.compatibility.cardType,'safe_nonnegative_integer')
  assert.deepEqual(card.compatibility.dataValueKinds,{null:3,array:0,object:1,string:0,number:0,boolean:0,other:0})
  assert.deepEqual(card.compatibility.outerOtherValueKinds,{null:9,array:1,object:5,string:4,number:5,boolean:0,other:0})
  assert.doesNotMatch(JSON.stringify(report),/private-|private\.example/)
  assert.deepEqual(payload,original)
  assert.equal(payload.data.data.length,8)
  assert.deepEqual(archive.body_bytes,bytes)
  assert.equal(digest(archive.body_bytes),archive.body_sha256)
})

test('Douyin v7 candidate checks the sixth recommendation rather than trusting the two schema samples',()=>{
  const variants=[
    row=>{row.word_record.aweme_info={aweme_id:'private-hidden-id',desc:'private-hidden-body'}},
    row=>{row.word_record.words_content={aweme_id:'private-hidden-id',desc:'private-hidden-body'}},
    row=>{row.extra_info.unknownComposite={aweme_id:'private-hidden-id',desc:'private-hidden-body'}},
    (row,card)=>{card.related_word_list[5]={aweme_id:'private-hidden-id',desc:'private-hidden-body'}},
  ]
  for(const change of variants){
    const card=douyinRecommendationCard()
    change(card.related_word_list[5],card)
    const payload={code:200,data:{data:[card],aweme_list:null,has_more:false}}
    const snapshot={path:'/api/v1/data/search',body:{platform:'douyin',query:'private-query',pageSize:20}}
    const original=structuredClone(payload),report=inspectContentArchive(archiveFor(payload),snapshot,'douyin')
    assert.equal(report.projection.state,'candidate_rejects')
    assert.equal(report.projection.reason,'invalid_content_search_identity')
    assert.equal(report.entryCoverage.entries[0].compatibility.relatedWordsCard,false)
    assert.deepEqual(report.entryCoverage.entries[0].compatibility.relatedWordsCoverage,{metadataAccepted:true,
      relatedWordCount:6,inspectedCount:6,invalidIndexes:[5],truncated:false})
    assert.doesNotMatch(JSON.stringify(report),/private-|private\.example/)
    assert.deepEqual(payload,original)
  }
})

test('Douyin v7 rejects nonempty or invalid JSON inside the observed empty encoded metadata fields',()=>{
  for(const field of ['impr_extra','info'])for(const value of [
    JSON.stringify({aweme_info:{aweme_id:'private-hidden-id',desc:'private-hidden-body'}}),
    JSON.stringify([{aweme_id:'private-hidden-id'}]),
    '{private-invalid-json',
  ]){
    const card=douyinRecommendationCard()
    if(field==='impr_extra')card.data.rs_extra_info.impr_extra=value
    else card.words_query_record.info=value
    const payload={code:200,data:{data:[card],aweme_list:null,has_more:false}}
    const snapshot={path:'/api/v1/data/search',body:{platform:'douyin',query:'private-query',pageSize:20}}
    const original=structuredClone(payload),report=inspectContentArchive(archiveFor(payload),snapshot,'douyin')
    assert.equal(report.projection.state,'candidate_rejects')
    assert.equal(report.projection.reason,'invalid_content_search_identity')
    assert.equal(report.entryCoverage.entries[0].compatibility.relatedWordsCard,false)
    assert.equal(report.entryCoverage.entries[0].compatibility.relatedWordsCoverage.metadataAccepted,false)
    assert.doesNotMatch(JSON.stringify(report),/private-|private\.example/)
    assert.deepEqual(payload,original)
  }
})

const schemaNodes=root=>{
  const nodes=[]
  const visit=shape=>{nodes.push(shape);for(const field of shape.fields||[])visit(field.shape);for(const sample of shape.samples||[])visit(sample.shape);if(shape.encodedJsonSchema)visit(shape.encodedJsonSchema)}
  visit(root);return nodes
}

test('v6 single-card schema reports structural names only and hashes dynamic or reserved keys without mutation',()=>{
  const card=JSON.parse('{"constructor":{"value":"private-constructor"},"__proto__":{"value":"private-prototype"}}')
  card.data={component:{privateId:'private-identity',url:'https://private.example/?token=private-token',count:1234567890},
    list:[{text:'private-first'},{text:'private-second'},{text:'private-third'}],
    'https://private.example/map-key':'private-map-value',user123456789:'private-dynamic-value',Qp7Ab9Cd2Ef4:'private-short-dynamic-value',['a'.repeat(65)]:'private-long-key-value'}
  const original=structuredClone(card),report=inspectSingleCardSchema(card),encoded=JSON.stringify(report)
  assert.equal(report.mode,'single_card_schema_only')
  assert.equal(report.schema.fields[0].key,'data')
  assert.equal(report.schema.ownKeyCount,3)
  for(const key of ['constructor','__proto__'])assert.ok(report.schema.fields.some(field=>field.keySha256===digest(Buffer.from(key))))
  const data=report.schema.fields[0].shape
  for(const key of ['https://private.example/map-key','user123456789','Qp7Ab9Cd2Ef4','a'.repeat(65)])assert.ok(data.fields.some(field=>field.keySha256===digest(Buffer.from(key))))
  const component=data.fields.find(field=>field.key==='component').shape
  assert.deepEqual(component.fields.find(field=>field.key==='count').shape,{kind:'number'})
  const list=data.fields.find(field=>field.key==='list').shape
  assert.equal(list.count,3)
  assert.deepEqual(list.samples.map(sample=>sample.index),[0,1])
  assert.equal(list.truncated,'array_sampling')
  assert.ok(report.redactedFieldNames>=6)
  assert.doesNotMatch(encoded,/private-|private\.example|user123456789|Qp7Ab9Cd2Ef4|1234567890/)
  assert.deepEqual(card,original)
  assert.equal(Object.getPrototypeOf(card),Object.prototype)
  assert.equal(Object.hasOwn(Object.prototype,'value'),false)
})

test('v6 single-card schema visits data first and enforces shared depth/node/array budgets with explicit omissions',()=>{
  const card=Object.fromEntries(Array.from({length:500},(_,index)=>[`meta${index}`,'private-meta']))
  let deep={leaf:'private-too-deep'}
  for(let index=0;index<12;index++)deep={nested:deep}
  card.data={deep,rows:Array.from({length:100},()=>({text:'private-row'}))}
  const original=structuredClone(card),report=inspectSingleCardSchema(card)
  assert.deepEqual(report.limits,{maxDepth:8,maxNodes:300,arraySamples:2,maxEncodedJsonBytes:65536})
  assert.equal(report.schema.fields[0].key,'data')
  assert.equal(report.nodesVisited,300)
  assert.equal(schemaNodes(report.schema).length,report.nodesVisited,'no extra sentinel nodes escape the shared budget')
  assert.ok(report.truncationReasons.includes('node_limit'))
  assert.ok(report.truncationReasons.includes('depth_limit'))
  assert.ok(report.truncationReasons.includes('array_sampling'))
  assert.equal(report.truncated,true)
  assert.ok(report.schema.omittedFields>0)
  assert.ok(JSON.stringify(report).length<100000)
  assert.doesNotMatch(JSON.stringify(report),/private-/)
  assert.deepEqual(card,original)
})

test('v6 encoded JSON remains schema-only and shares limits without parsing oversized or invalid strings',()=>{
  let nested='private-final-value'
  for(let index=0;index<12;index++)nested=JSON.stringify({encoded:nested})
  const card={data:{encoded:JSON.stringify({searchComponent:{items:[{id:'private-id',url:'https://private.example/private-token'}]}}),
    deep:nested,oversized:JSON.stringify({text:'private-oversized'.repeat(5000)}),invalid:'{private-invalid-json'}}
  const original=structuredClone(card),report=inspectSingleCardSchema(card),data=report.schema.fields[0].shape
  const encoded=data.fields.find(field=>field.key==='encoded').shape
  assert.equal(encoded.kind,'string')
  assert.equal(encoded.encodedJsonSchema.kind,'object')
  assert.equal(encoded.encodedJsonSchema.fields[0].key,'searchComponent')
  assert.equal(data.fields.find(field=>field.key==='oversized').shape.truncated,'encoded_json_limit')
  assert.deepEqual(data.fields.find(field=>field.key==='invalid').shape,{kind:'string'})
  assert.ok(report.truncationReasons.includes('depth_limit'))
  assert.equal(schemaNodes(report.schema).length,report.nodesVisited)
  assert.ok(report.nodesVisited<=300)
  assert.doesNotMatch(JSON.stringify(report),/private-|private\.example/)
  assert.deepEqual(card,original)
})

test('v6 incident schema never expands arbitrary archives or trusts a forged pinned digest',()=>{
  const endpoint=normalizeTikHubContentSearchRequest({platform:'douyin',query:'fixture'})
  const rows=Array.from({length:8},(_,index)=>index===4?{type:6,data:{arbitrarySchemaName:{text:'private-card'}}}:{type:1,aweme_info:{aweme_id:String(index+1),desc:'private-post'}})
  const payload={code:200,data:{data:rows,aweme_list:null,has_more:false}}
  const snapshot={path:'/api/v1/data/search',body:{platform:'douyin',query:'private-query',pageSize:20}}
  const archive={...archiveFor(payload),id:'bc969a1f-d327-411d-aef5-4b4c927c4124',usage_request_id:'ae37ff0f-3e29-4ed7-a4e7-4178779d8cc4',provider_key:'tikhub',operation:endpoint.operation,
    endpoint_key:endpoint.endpointKey,endpoint_version:endpoint.endpointVersion,contract_version:endpoint.endpointContractVersion}
  archive.body_bytes=Buffer.concat([archive.body_bytes,Buffer.alloc(348957-archive.body_bytes.length,0x20)])
  archive.body_size=archive.body_bytes.length
  archive.body_sha256=digest(archive.body_bytes)
  for(const options of [undefined,{incidentSchema:true}]) {
    const report=inspectContentArchive(archive,snapshot,'douyin',options)
    assert.equal(report.hashVerified,true)
    assert.equal(Object.hasOwn(report,'incidentCardSchema'),false)
    assert.doesNotMatch(JSON.stringify(report),/arbitrarySchemaName|private-/)
  }
  const forged={...archive,body_sha256:'19edfbe3c7044f4c081a724efe45ad2532cd3f21bc651be351996226c426f102',body_size:348957}
  assert.deepEqual(inspectContentArchive(forged,snapshot,'douyin',{incidentSchema:true}),{state:'archive_integrity_failed'})
})

test('v6 incident source metadata pin uses the actual native endpoint key and requires every saved identity/version/shape',()=>{
  const endpoint=normalizeTikHubContentSearchRequest({platform:'douyin',query:'fixture'})
  const source={id:'bc969a1f-d327-411d-aef5-4b4c927c4124',usage_request_id:'ae37ff0f-3e29-4ed7-a4e7-4178779d8cc4',
    body_sha256:'19edfbe3c7044f4c081a724efe45ad2532cd3f21bc651be351996226c426f102',body_size:348957,provider_key:'tikhub',
    operation:endpoint.operation,endpoint_key:endpoint.endpointKey,endpoint_version:endpoint.endpointVersion,contract_version:endpoint.endpointContractVersion}
  const payload={data:{data:Array.from({length:8},(_,index)=>({type:index===4?6:1}))}}
  assert.equal(isDouyinIncidentCardSource(source,payload),true,'endpointKey includes native.t, matching persisted provider calls')
  for(const [key,value] of Object.entries({id:randomUUID(),usage_request_id:randomUUID(),body_sha256:'0'.repeat(64),body_size:348956,
    provider_key:'other',operation:'other',endpoint_key:'t.douyin_search_fetch_video_search_v1',endpoint_version:'other',contract_version:'other'})) {
    assert.equal(isDouyinIncidentCardSource({...source,[key]:value},payload),false,key)
  }
  for(const changed of [null,{data:{data:payload.data.data.slice(0,7)}},{data:{data:payload.data.data.map((row,index)=>index===4?{type:'6'}:row)}}]) {
    assert.equal(isDouyinIncidentCardSource(source,changed),false)
  }
})

const zhihuFillFixture=({overlap=false,firstCount=18}={})=>{
  const page=(start,count,offset)=>({code:200,data:{data:Array.from({length:count},(_,index)=>({type:'search_result',object:{
    id:`private-post-${start+index}`,type:'article',title:'private-title',content:'private-full-body',
    author:{id:'private-author'},url:'https://private.example/article'}})),
    paging:{is_end:false,next:`https://api.zhihu.com/search_v3?offset=${offset}&search_hash_id=private-session`}}})
  const first={...archiveFor(page(0,firstCount,18)),outcome:'succeeded',started_at:new Date(Date.now()-2000).toISOString()}
  const second={...archiveFor(page(overlap?10:18,18,36)),outcome:'succeeded',started_at:new Date(Date.now()-1000).toISOString()}
  return {calls:[first,second],snapshot:{path:'/api/v1/data/search',body:{platform:'zhihu',query:'private-query',pageSize:20}}}
}

test('v3 offline fill follows chronological Zhihu pages and identifies aliased minimal buffer state without exposing content',()=>{
  const {calls,snapshot}=zhihuFillFixture(),reversed=[calls[1],calls[0]]
  const original=calls.map(call=>({...call,body_bytes:Buffer.from(call.body_bytes)}))
  const report=inspectContentFillCoverage(reversed,snapshot,'zhihu')
  assert.equal(report.available,true)
  assert.equal(report.mode,'offline_consumption_simulation')
  assert.equal(report.manifestChecks,'minimal_cursor_state_only')
  assert.equal(report.sourcePageCount,2)
  assert.equal(report.acquiredCount,36)
  assert.equal(report.uniqueAcquiredCount,36)
  assert.equal(report.deliveredCount,20)
  assert.equal(report.bufferedSourceRows,16)
  assert.equal(report.bufferedUniqueUndelivered,16)
  assert.equal(report.legacyManifestJsonSafe,false)
  assert.equal(report.copiedManifestJsonSafe,true)
  assert.deepEqual(report.pages,[{acquiredCount:18,consumedSourceRows:18,nonPostCount:0,postgresSafeItems:true},
    {acquiredCount:18,consumedSourceRows:2,nonPostCount:0,postgresSafeItems:true}])
  assert.doesNotMatch(JSON.stringify(report),/private-|https:\/\//)
  assert.deepEqual(calls,original)
  assert.deepEqual(reversed,[calls[1],calls[0]],'input receipt order is not mutated while sorting')
})

test('v3 offline fill deduplicates overlapping source pages without discarding their remaining unique rows',()=>{
  const {calls,snapshot}=zhihuFillFixture({overlap:true})
  const report=inspectContentFillCoverage(calls,snapshot,'zhihu')
  assert.equal(report.available,true)
  assert.equal(report.acquiredCount,36)
  assert.equal(report.uniqueAcquiredCount,28)
  assert.equal(report.deliveredCount,20)
  assert.equal(report.pages[1].consumedSourceRows,10)
  assert.equal(report.bufferedSourceRows,8)
  assert.equal(report.bufferedUniqueUndelivered,8)
  assert.equal(report.legacyManifestJsonSafe,false)
  assert.equal(report.copiedManifestJsonSafe,true)
  assert.doesNotMatch(JSON.stringify(report),/private-/)
})

test('v3 offline fill preserves subsecond order when PostgreSQL returns Date objects',()=>{
  const {calls,snapshot}=zhihuFillFixture()
  calls[0].started_at=new Date('2026-10-15T00:00:00.501Z')
  calls[1].started_at=new Date('2026-10-15T00:00:00.502Z')
  const report=inspectContentFillCoverage([calls[1],calls[0]],snapshot,'zhihu')
  assert.equal(report.available,true)
  assert.equal(report.sourcePageCount,2)
  assert.equal(report.deliveredCount,20)
  assert.equal(report.bufferedSourceRows,16)
  assert.equal(report.legacyManifestJsonSafe,false)
  assert.equal(report.copiedManifestJsonSafe,true)
})

test('v3 offline fill refuses unverifiable receipts, unknown acquisitions, continuations and out-of-budget source sets',()=>{
  const {calls,snapshot}=zhihuFillFixture()
  for(const changed of [{...calls[0],body_sha256:'0'.repeat(64)},{...calls[0],body_size:calls[0].body_size+1}]) {
    assert.deepEqual(inspectContentFillCoverage([changed,calls[1]],snapshot,'zhihu'),{available:false,reason:'requires_verified_archives'})
  }
  assert.deepEqual(inspectContentFillCoverage([calls[0],{...calls[1],outcome:'unknown'}],snapshot,'zhihu'),{available:false})
  assert.deepEqual(inspectContentFillCoverage([...calls,...calls],snapshot,'zhihu'),{available:false})
  assert.deepEqual(inspectContentFillCoverage([],snapshot,'zhihu'),{available:false})
  for(const body of [{...snapshot.body,cursor:'private-native-cursor'},{...snapshot.body,cursor:'mxds1.private-signed-state'},
    {...snapshot.body,page:2},{...snapshot.body,params:{offset:18}},{...snapshot.body,params:{cursor:'mxds1.private-signed-state'}}]) {
    assert.equal(inspectContentFillCoverage(calls,{...snapshot,body},'zhihu').available,false)
  }
  assert.deepEqual(inspectContentFillCoverage(calls,{...snapshot,path:'/api/v1/search/raw'},'zhihu'),{available:false})
  const stalled={code:200,data:{data:[{type:'search_result',object:{id:'private-id',type:'article',content:'private-body'}}],
    paging:{is_end:false,next:'https://api.zhihu.com/search_v3?offset=18&search_hash_id=private-session'}}}
  const repeated=inspectContentFillCoverage([calls[0],{...calls[1],...archiveFor(stalled)}],snapshot,'zhihu')
  assert.equal(repeated.available,false)
  assert.equal(repeated.reason,'invalid_content_search_continuation')
})

test('v3 offline fill refuses extra receipts after the requested page already filled from an oversized source',()=>{
  const {calls,snapshot}=zhihuFillFixture({firstCount:24})
  const single=inspectContentFillCoverage([calls[0]],snapshot,'zhihu')
  assert.equal(single.available,true)
  assert.equal(single.deliveredCount,20)
  assert.equal(single.bufferedSourceRows,4)
  for(const second of [calls[1],{...calls[1],body_sha256:'0'.repeat(64)}]) {
    assert.equal(inspectContentFillCoverage([calls[0],second],snapshot,'zhihu').available,false,
      'a diagnostic cannot silently ignore a later saved receipt or its integrity')
  }
})

test('v3 offline fill does not reinterpret a saved native or signed Kuaishou continuation as a first-page search',()=>{
  const call={...archiveFor({code:200,data:{mixFeeds:[{photoId:'private-photo',caption:'private-body'}],has_more:false}}),
    outcome:'succeeded',started_at:new Date().toISOString()}
  const snapshot={path:'/api/v1/data/search',body:{platform:'kuaishou',query:'private-query',pageSize:20}}
  assert.equal(inspectContentFillCoverage([call],snapshot,'kuaishou').available,true)
  for(const pcursor of ['private-native','mxds1.private-signed-state']) {
    assert.deepEqual(inspectContentFillCoverage([call],{...snapshot,body:{...snapshot.body,params:{pcursor}}},'kuaishou'),{available:false})
  }
  const {calls,snapshot:zhihu}=zhihuFillFixture()
  const invalidTime=inspectContentFillCoverage([{...calls[0],captured_at:'infinity'}],zhihu,'zhihu')
  assert.deepEqual(invalidTime,{available:false,reason:'invalid_content_search_capture_time'})
})
