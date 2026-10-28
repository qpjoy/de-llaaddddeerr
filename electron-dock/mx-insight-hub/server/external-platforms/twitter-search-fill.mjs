import { currentAdmissionLimits, refreshAdmissionLimits } from './admission-runtime.mjs'
import { openCircuitError, upstreamCapacityError } from './availability-errors.mjs'
import { isHubRateLimitExempt, internalCircuitState } from '../core/internal-traffic-policy.mjs'
import { createHash } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
import { RapidApiUpstreamError } from '../adapters/rapidapi.mjs'
import { normalizeTwitterResponse } from '../contracts/hub-social.mjs'
import { projectTwitterDataSearch } from '../contracts/hub-data-search.mjs'
import { rawSearchRecords } from '../contracts/raw-search.mjs'
import { assertTwitterSearchAvailable } from '../data/twitter-search-availability.mjs'

const MAX_UPSTREAM_PAGES = 15, MAX_BYTES = 12 * 1024 * 1024, MAX_PAGE_BYTES = 4 * 1024 * 1024
const hash = items => createHash('sha256').update(JSON.stringify(items)).digest('hex')
const unavailable = () => new AppError(409, 'search_page_unavailable', 'The saved Twitter page cannot be continued; explicitly restart the search')
const uncertain = message => {
  const error=new AppError(503,'request_outcome_unknown',message)
  Object.defineProperty(error,'preserveReservation',{value:true})
  return error
}
const knownAdmission = error => error instanceof AppError && error.status !== 403 && (
  /^external_platform_(?:operation_|cost_)/u.test(error.code)
  || ['external_admission_policy_unavailable', 'external_platform_not_configured', 'external_platform_circuit_open', 'external_platform_rate_limited',
    'external_platform_subsidy_budget_exhausted', 'external_platform_busy', 'twitter_fill_deadline',
    'strategy_search_paused', 'strategy_search_route_unavailable'].includes(error.code))

function archiveObjects(result, request, callId) {
  if (result.archiveObjects?.length) return result.archiveObjects
  const archive = result.responseArchive
  if (!archive?.payloadSha256) return []
  return [{ kind:'response',marketplace:'twitter',endpointVersion:request.endpointVersion,
    capturedDate:new Date(archive.capturedAt).toISOString().slice(0,10),
    archivePath:`rapidapi/twitter/social.content.search/${callId}`,envelopePointer:'$',sourceKey:callId,
    payloadSha256:archive.payloadSha256,rawPayload:archive.rawPayload }]
}

function upstreamFailure(error) {
  const evidence = error.evidence
  const code = evidence.outcome === 'unknown' ? 'social_upstream_outcome_unknown'
    : evidence.outcome === 'succeeded_unusable' ? 'social_upstream_response_unusable' : 'social_upstream_rejected'
  return new AppError(evidence.httpStatus === 429 ? 429 : evidence.errorCode === 'social_egress_unavailable' ? 503 : 502,
    code, 'External social data request failed; verify its saved outcome before retrying',
    { ...(evidence.httpStatus === 429 ? upstreamCapacityError(evidence).details : {}), upstreamStatus:evidence.httpStatus ?? null,outcome:evidence.outcome,retryable:false })
}

// A single customer intent owns all acquisition steps. Every paid receipt is
// durable before another dispatch; only the final delivery settles the hold.
export async function runTwitterSearchFill({ gateway,context,delivery,request,deadlineAt,signal,
  resolveCredential,enterCapacity,leaveCapacity,revalidateIdentity,providerCostControl,projectDelivery,assertSearchDispatchAllowed,rejectedFallback }, { clock=Date.now }={}) {
  const store=gateway.platformStore, started=performance.now()
  const identity={ tenantId:context.tenant.id,consumerId:context.consumer.id,apiKeyId:context.apiKey.id,
    path:'/api/v1/data/search',query:request.query,pageSize:request.pageSize,type:request.resultType,scopeHash:request.scopeHash }
  const history=await store.twitterDeliveredIdsFor({ ...identity,previousDeliveryId:request.fill?.previousDeliveryId,
    ...(!request.fill && request.buffer ? { sourceCallId:request.buffer.callId } : {}) })
  const seen=new Set(history.ids), items=[], sources=[], tokens=new Set()
  let upstreamPages=request.fill?.upstreamPages ?? Math.max(0,request.page-1)
  let calls=0, bytes=0, duplicateCount=0, discardedCount=0, sourcePartial=false
  let providerCursor=request.providerCursor ?? null, buffer=null, stopReason=null, capturedAt=null
  let ownsLease=false, entered=false, currentCall=null, currentEvidence=null, currentCost=null, settledFailure=false, retainLease=false
  let phase='admission', unknownLogged=false
  const logUnknown=async error=>{
    if(unknownLogged) return
    unknownLogged=true
    let diagnostic
    try {
      const classes=['Error','TypeError','RangeError','SyntaxError','AppError','RapidApiUpstreamError']
      let cause=error, sqlState=null
      // Persistence wrappers may carry the database failure as a cause. Never
      // copy its message, stack, detail, SQL or parameters into ordinary logs.
      for(let depth=0;cause && depth<3;depth++,cause=cause.cause) {
        if(typeof cause.code==='string' && /^[0-9A-Z]{5}$/u.test(cause.code)) { sqlState=cause.code;break }
      }
      diagnostic={callId:currentCall?.id ?? null,phase,errorClass:classes.includes(error?.name)?error.name:'Error',sqlState}
      gateway.logger?.warn?.({event:'twitter_search_outcome_unknown',requestId:delivery.usageRequestId,...diagnostic},
      'Twitter search outcome is unknown')
    } catch { /* Logging cannot change an unknown outcome or its retained hold. */ }
    // Keep the first failure independently of container log retention. Neither
    // this bounded write nor its failure changes the request or billing state.
    if(diagnostic) {
      try { await gateway.usageStore.recordRequestFailure(delivery.usageRequestId,diagnostic) }
      catch { /* The original log and existing unknown settlement remain authoritative. */ }
    }
  }
  const dispatchLease={ consumerId:context.consumer.id,operation:delivery.operation,fingerprint:delivery.fingerprint,
    endpointKey:request.providerRequest.endpointKey,contractVersion:request.providerRequest.endpointContractVersion,
    ownerRequestId:delivery.usageRequestId,expiresAt:new Date(deadlineAt),
    ...(delivery.twitterManualRetry ? { twitterManualRetry: { ...delivery, ...delivery.twitterManualRetry } } : {}) }
  const timeoutMargin=(gateway.config.timeoutMs || 30000)+5000
  const enoughTime=()=>Number.isFinite(deadlineAt) && clock()+timeoutMargin<deadlineAt
  const markUnknown=async()=>{
    try { await gateway.usageStore.markRequestUnknown(delivery.usageRequestId,'external_platform_persistence_unknown'); return }
    catch {
      try {
        const saved=await gateway.usageStore.getRequest(delivery.usageRequestId,delivery.consumerId)
        if(['unknown','committed'].includes(saved?.status)) return
      } catch { /* Keep the existing lease while durable outcome is unavailable. */ }
      retainLease=true
    }
  }
  const authorizeAcquisition=async()=>{
    context=await revalidateIdentity()
    // Historical fresh keys may leave replay and purchase again after their
    // TTL. Preserve that behavior while checking the same cross-supplier
    // query boundary as a new TikHub request, after owning the parent lease.
    // A manual retry exempts only the ancestors its existing protocol verifies.
    const excluded=delivery.twitterManualRetry
      ? (await store.validateTwitterManualRetry(dispatchLease.twitterManualRetry)).ancestorRequestIds : []
    await assertTwitterSearchAvailable({usageStore:gateway.usageStore,context,query:request.query,
      excludeRequestIds:[delivery.usageRequestId,...excluded,...(delivery.acknowledgedRequestIds || [])]})
    await assertSearchDispatchAllowed?.()
    const shared=await store.providerState('rapidapi')
    const state=isHubRateLimitExempt(context)?internalCircuitState(gateway.usageStore,context,shared):shared
    const contract=await store.contractCircuitState?.('rapidapi','twitter')
    const blocked=await openCircuitError({store,state,contract,now:clock(),config:gateway.config,
      message:'External data is temporarily unavailable',marketplace:'twitter'})
    if(blocked) throw blocked
    const credential=await resolveCredential()
    if(!credential.ready) throw new AppError(503,'external_platform_not_configured','External data is unavailable')
    const control=await gateway.operationControlStore.authorizeDispatch('rapidapi',delivery.operation,
      { consumerId:context.consumer.id,config:gateway.config,credentialConfigured:true,credentialRevision:credential.revision })
    const cost=providerCostControl(control?.billing?{billing:control.billing}:gateway.config,request.providerRequest.endpointKey)
    return {credential,control,cost}
  }
  const consume=(publicBody,source,inputCursor,offset=0,expectedHash=null)=>{
    const full=publicBody.data.items
    if (!Array.isArray(full) || full.length>10000) throw unavailable()
    const rowsHash=hash(full)
    if (expectedHash && (expectedHash!==rowsHash || offset<1 || offset>=full.length)
      || !Number.isSafeInteger(offset) || offset<0 || offset>full.length) throw unavailable()
    sources.push({ callId:source.callId,bodySize:source.bodySize,bodySha256:source.bodySha256,
      capturedAt:source.capturedAt,rowsHash })
    capturedAt=source.capturedAt
    discardedCount+=publicBody.data.page?.discardedCount || 0
    sourcePartial ||= publicBody.data.status==='partial'
    let position=offset
    while(position<full.length && items.length<request.pageSize) {
      const item=full[position++]
      if(seen.has(item.id)) { duplicateCount++; continue }
      seen.add(item.id)
      items.push({ ...structuredClone(item),collectedAt:source.capturedAt })
    }
    if(position<full.length) {
      buffer={ callId:source.callId,offset:position,hash:rowsHash }
      providerCursor=inputCursor
    } else {
      buffer=null
      providerCursor=publicBody.providerPage?.nextProviderCursor ?? null
      if(providerCursor && (providerCursor===inputCursor || tokens.has(providerCursor))) {
        providerCursor=null
        stopReason='repeated_cursor'
      }
    }
  }
  try {
    await rejectedFallback?.begin()
    // Delivery-only arbitration protects cached finalization without treating
    // provider quarantine or missing credentials as a reason to lose paid data.
    const claim=await store.acquireTwitterFillDeliveryLease(dispatchLease)
    if(claim!==true && claim?.kind!=='acquired') throw new AppError(409,'request_in_progress','An equal Twitter delivery is in progress')
    ownsLease=true
    // An equal ended delivery no longer blocks; an explicit retry is still revalidated.
    if(delivery.twitterManualRetry) await store.validateTwitterManualRetry(dispatchLease.twitterManualRetry)
    if(request.buffer) {
      const archived=await store.twitterPageFor({ ...identity,callId:request.buffer.callId })
      if(!archived || archived.bodySize>MAX_BYTES) throw unavailable()
      bytes+=archived.bodySize
      const publicBody=normalizeTwitterResponse(archived.payload,request.providerRequest,
        { allowOverflow:true,capturedAt:archived.capturedAt,encodeCursor:()=>null })
      // Verify the complete acquired safe projection before adding IDs or
      // exposing any raw re-projected content, including legacy prefix IDs.
      if(hash(publicBody.data.items)!==request.buffer.hash) throw unavailable()
      if(!request.fill) for(const item of publicBody.data.items.slice(0,request.buffer.offset)) seen.add(item.id)
      consume(publicBody,{...archived,callId:request.buffer.callId},providerCursor,request.buffer.offset,request.buffer.hash)
    }
    while(items.length<request.pageSize && !buffer) {
      if(providerCursor && tokens.has(providerCursor)) { stopReason='repeated_cursor';providerCursor=null;break }
      if(upstreamPages>=MAX_UPSTREAM_PAGES) { stopReason='upstream_page_limit'; break }
      if(sources.length && !providerCursor) break
      if(bytes+MAX_PAGE_BYTES>MAX_BYTES) { stopReason='archive_byte_limit'; break }
      if(!enoughTime()) { stopReason='deadline'; break }
      try {
        phase='admission'
        if(signal?.aborted) throw new AppError(499,'request_cancelled','Request cancelled before dispatch')
        let acquisition=await authorizeAcquisition()
        const lease=await store.acquireDispatchLease({...dispatchLease,ownedDeliveryLease:true})
        if(lease!==true && lease?.kind!=='acquired') {
          const code=lease?.reason==='unknown'?'request_outcome_unknown':lease?.reason==='succeeded_unusable'
            ?'external_platform_response_unusable':'request_in_progress'
          throw new AppError(409,code,'An equal search is pending or has an unresolved result',{upstreamDispatched:false})
        }
        if(entered==='exempt' && !isHubRateLimitExempt(context)) {
          leaveCapacity(entered); entered=false
        }
        if(!entered) {
          if(!(entered=await enterCapacity({lease:{...dispatchLease,ownedDeliveryLease:true},expiresAt:new Date(deadlineAt),signal,
            canWait:!sources.length,revalidate:async()=>{
              acquisition=await authorizeAcquisition()
              return context
            }}))) {
            const active=gateway.active, consumerActive=gateway.activeByConsumer.get(context.consumer.id) || 0
            const reason=active>=currentAdmissionLimits(gateway).maxConcurrency ? 'hub_concurrency_exhausted'
              : consumerActive>=currentAdmissionLimits(gateway).maxConsumerConcurrency ? 'consumer_concurrency_exhausted' : 'concurrency_queue_pending'
            if(!sources.length) await store.rejectWithoutDispatch({delivery,sourceMode:'unavailable',status:503,errorCode:'external_platform_busy'})
            throw new AppError(503,'external_platform_busy','Hub Twitter 数据采集并发名额暂不可用，本次尚未发起采集，请稍后重试。',{
              platform:'twitter',layer:'hub',stage:'concurrency_admission',reason,upstreamDispatched:false,
              retryAfterMs:1000,admissionMode:'immediate',activeConcurrency:active,maxConcurrency:currentAdmissionLimits(gateway).maxConcurrency,
              consumerActiveConcurrency:consumerActive,maxConsumerConcurrency:currentAdmissionLimits(gateway).maxConsumerConcurrency,
              queueDepth:gateway.concurrencyQueue.entries.length,
            })
          }
        }
        const {credential,control,cost}=acquisition
        currentCost=await store.reserveProviderCostWorkflow({ ...delivery,apiKeyId:context.apiKey.id,costControls:[cost] })
        const rate=isHubRateLimitExempt(context)?{allowed:true}:await store.acquireProviderRateLimit({ limit:(await refreshAdmissionLimits(gateway)).maxRequestsPerMinute ?? 90,windowMs:60000 })
        if(!rate.allowed) throw new AppError(429,'external_platform_rate_limited','External data rate limit is exhausted')
        if(!enoughTime()) throw new AppError(503,'twitter_fill_deadline','The bounded search deadline has been reached')
        if(signal?.aborted) throw new AppError(499,'request_cancelled','Request cancelled before dispatch')
        const inputCursor=providerCursor
        const count=Math.min(50,request.pageSize-items.length)
        const step={ ...request.providerRequest,count,providerCursor:inputCursor,
          upstreamQuery:{...request.providerRequest.upstreamQuery,count} }
        delete step.upstreamQuery.cursor
        if(inputCursor) step.upstreamQuery.cursor=inputCursor
        currentEvidence=null
        await assertSearchDispatchAllowed?.()
        phase='begin_call'
        currentCall=await store.beginProviderCall({ ...delivery,apiKeyId:context.apiKey.id,
          contractVersion:step.endpointContractVersion,endpointKey:step.endpointKey,endpointVersion:step.endpointVersion,
          marketplace:'twitter',callOrdinal:calls,callRole:calls?'enrichment':'primary',dispatchFingerprint:delivery.fingerprint,
          ...(delivery.twitterManualRetry && calls===0 ? { retryOfRequestId:delivery.twitterManualRetry.retryOfRequestId } : {}),
          costControl:cost,costReservationId:currentCost.id,operationControl:control })
        calls++;upstreamPages++
        if(inputCursor) tokens.add(inputCursor)
        const callStarted=performance.now()
        let result
        phase='provider_request'
        try { result=await gateway.adapter.execute(step,{credential:credential.credential,encodeCursor:()=>null}) }
        catch(error) {
          if(!(error instanceof RapidApiUpstreamError)) throw error
          const mapped=upstreamFailure(error)
          currentEvidence={ callId:currentCall.id,delivery,outcome:error.evidence.outcome,
            httpStatus:error.evidence.httpStatus,businessCode:error.evidence.businessCode,billed:error.evidence.billed ?? null,
            costMinor:cost.costMinor,costKind:cost.costKind,currency:cost.currency,latencyMs:Math.round(performance.now()-callStarted),
            errorCode:error.evidence.errorCode,affectsCircuit:error.evidence.affectsCircuit!==false,
            responseArchive:error.responseArchive,restrictedResponseArchive:error.restrictedResponseArchive,
            upstreamEvidence:error.upstreamEvidence,archiveObjects:archiveObjects(error,step,currentCall.id) }
          const canHandoff = rejectedFallback && error.evidence.outcome === 'rejected' && error.evidence.httpStatus === 400
            && calls === 1 && !sources.length && !request.providerCursor && !request.buffer && !request.fill
            && request.page === 1 && !delivery.twitterManualRetry
            && await rejectedFallback.allowed().catch(() => false)
          if (canHandoff) {
            // Preserve the rejected procurement receipt, but keep the original
            // customer hold open for one final TikHub delivery. The parent lease
            // remains owned until both suppliers have a durable outcome.
            phase='finish_step'
            await store.finishProviderStep(currentEvidence)
            const callId = currentCall.id
            currentCall = null
            settledFailure = true
            phase='supplier_handoff'
            try {
              await store.releaseProviderCostWorkflow({ reservationId: currentCost.id, usageRequestId: delivery.usageRequestId })
              currentCost = null
              if (entered) { leaveCapacity(entered); entered = false }
              await rejectedFallback.prepare({ delivery, callId })
            } catch(error) {
              await logUnknown(error)
              await markUnknown()
              throw uncertain('The supplier handoff could not be confirmed; verify the saved request before retrying')
            }
            try { return await rejectedFallback.run({ delivery, deadlineAt }) }
            catch (fallbackError) {
              // The TikHub workflow owns any dispatched outcome. If it stopped
              // before dispatch, save that failure once rather than purchasing
              // RapidAPI again on a same-key retry.
              let saved
              try { saved = await gateway.usageStore.getRequest(delivery.usageRequestId, delivery.consumerId) }
              catch { await markUnknown(); throw uncertain('The search outcome could not be confirmed') }
              if (saved?.status === 'reserved') {
                if (!(fallbackError instanceof AppError) || fallbackError.preserveReservation
                  || /unknown|persistence/u.test(fallbackError.code || '')) {
                  await markUnknown()
                  throw uncertain('The fallback search outcome is unknown; verify the saved request before retrying')
                }
                try {
                  await gateway.usageStore.commitRequest(delivery.usageRequestId, {
                    responseStatus: fallbackError.status,
                    responseBody: { error: { code: fallbackError.code, message: fallbackError.message,
                      details: { ...fallbackError.details, requestId: delivery.usageRequestId } }, requestId: delivery.usageRequestId },
                    unitsActual: 0, upstreamLatencyMs: Math.round(performance.now() - started),
                    deliverySourceMode: 'live', capturedAt: new Date().toISOString(),
                  })
                } catch { await markUnknown(); throw uncertain('The fallback delivery could not be confirmed') }
              }
              throw fallbackError
            }
          }
          phase='finish_failure'
          await store.finishFailure({ ...currentEvidence,failureResponseStatus:mapped.status,
            failureResponseBody:{ error:{code:mapped.code,message:mapped.message,details:{...mapped.details,requestId:delivery.usageRequestId}},requestId:delivery.usageRequestId } })
          currentCall=null
          settledFailure=true
          throw mapped
        }
        phase='project_response'
        const receipt=result.restrictedResponseArchive
        currentEvidence={callId:currentCall.id,delivery,outcome:'succeeded',httpStatus:200,businessCode:null,billed:null,
          costMinor:cost.costMinor,costKind:cost.costKind,currency:cost.currency,
          latencyMs:Math.round(performance.now()-callStarted),itemCount:result.publicBody?.data?.items?.length ?? 0,
          responseArchive:result.responseArchive,restrictedResponseArchive:receipt,upstreamEvidence:result.upstreamEvidence,
          archiveObjects:archiveObjects(result,step,currentCall.id),affectsCircuit:false}
        if(!receipt || receipt.bodySize>MAX_PAGE_BYTES || !result.publicBody?.providerPage) throw unavailable()
        bytes+=receipt.bodySize
        const projected=projectTwitterDataSearch(result)
        const records=rawSearchRecords(projected.publicBody,'twitter','rapidapi')
        phase='stage_evidence'
        await store.stageProviderEvidence(currentEvidence)
        phase='finish_step'
        await store.finishProviderStep({...currentEvidence,ingestJob:{payload:{kind:'external-platform-result',providerKey:'rapidapi',
          consumerId:context.consumer.id,datasetId:'night-all.search.v1',platform:'twitter',requestId:delivery.usageRequestId,
          queryFingerprint:delivery.fingerprint,providerCallId:currentCall.id,records},
        dedupeKey:`external-platform:rapidapi:${currentCall.id}`,priority:100}})
        const callId=currentCall.id
        currentCall=null
        phase='assemble_page'
        consume(result.publicBody,{callId,bodySize:receipt.bodySize,bodySha256:receipt.bodySha256,capturedAt:receipt.capturedAt},inputCursor)
      } catch(error) {
        if(currentCall || error?.code==='external_platform_call_persistence_unknown') {
          await logUnknown(error)
          if(currentCall) await store.markPersistenceUnknown({callId:currentCall.id,delivery,...(currentEvidence||{})}).catch(()=>{})
          await markUnknown()
          throw uncertain('The search outcome is unknown; verify the saved request before retrying')
        }
        if(knownAdmission(error) && sources.length) { stopReason=error.code; break }
        throw error
      } finally {
        if(currentCost) {
          const released=await store.releaseProviderCostWorkflow({reservationId:currentCost.id,
            usageRequestId:delivery.usageRequestId,bestEffortRelease:true}).catch(()=>false)
          // Do not enter another budget admission behind the very same busy
          // provider lock. Keep purchased content and its continuation; a full
          // page, buffered overflow or exhausted cursor needs no degradation.
          if(released===false && sources.length && items.length<request.pageSize && !buffer && providerCursor) {
            stopReason='cost_release_pending'
          }
        }
        currentCost=null
      }
      if(stopReason==='cost_release_pending') break
    }
    if(!sources.length) throw new AppError(503,'twitter_fill_deadline','The bounded search could not acquire a page before its limit')
    phase='build_delivery'
    const result=projectDelivery({items,capturedAt,buffer,providerCursor,upstreamPages,upstreamCallCount:calls,
      stopReason,duplicateCount,discardedCount,sourcePartial,previousDeliveryId:delivery.usageRequestId})
    const responseBody={data:result.publicBody.data,requestId:delivery.usageRequestId}
    const sourceMode=calls?'live':clock()-Date.parse(capturedAt)<=gateway.config.freshTtlMs?'fresh_cache':'stored_fallback'
    try {
      phase='commit_delivery'
      await store.commitTwitterFillDelivery({delivery,responseBody,capturedAt,usageUnitsActual:items.length,sourceMode,
        latencyMs:Math.round(performance.now()-started),...identity,
        lineage:{version:'twitter-fill.v1',scopeHash:request.scopeHash,previousDeliveryId:history.previousDeliveryId,upstreamPages},sources})
    } catch(error) {
      await logUnknown(error)
      await markUnknown()
      throw uncertain('The search delivery outcome is unknown; verify the saved request before retrying')
    }
    return {status:200,body:responseBody,requestId:delivery.usageRequestId,replay:false,sourceMode,capturedAt,
      staleAgeSeconds:Math.max(0,Math.floor((clock()-Date.parse(capturedAt))/1000))}
  } catch(error) {
    if(calls && !settledFailure) {
      await logUnknown(error)
      await markUnknown()
      if(error.preserveReservation!==true) throw uncertain('The search outcome is unknown; verify the saved request before retrying')
    }
    throw error
  } finally {
    if(ownsLease && !retainLease) await store.releaseDispatchLease(dispatchLease).catch(()=>{})
    if(entered) leaveCapacity(entered)
  }
}
