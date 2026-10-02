import pg from 'pg'
import { PaymentReportingStore, PaymentReportingWorker, parseReportingSources, reportingMigrationsDir } from '@qpjoy/mx-pay/reporting'
import { PaymentError, requirePayment } from '@qpjoy/mx-pay'
import { runMigrations } from '@qpjoy/mx-common/postgres'
import { requirePlatformAdmin } from '../identity/index.mjs'
import { AppError } from '../core/errors.mjs'

export function reportingConfig(env) {
  return {sourcesJson:env.MX_INSIGHT_PAYMENT_REPORTING_SOURCES || '',databaseUrl:env.MX_INSIGHT_PAYMENT_REPORTING_DATABASE_URL || env.DATABASE_URL || null}
}
export async function migratePaymentReporting(config,logger=console) {
  if(!config?.sourcesJson)return
  if(!parseReportingSources(config.sourcesJson).length)return
  if(!config.databaseUrl)throw Error('Payment reporting PostgreSQL is required')
  await runMigrations({connectionString:config.databaseUrl,migrationsDir:reportingMigrationsDir,logger})
}
export function createPaymentReporting(config,{logger=console}={}) {
  let sources
  try {
    sources=parseReportingSources(config?.sourcesJson)
    if(sources.length && !config.databaseUrl)throw Error()
  } catch {
    // Configuration/dependency failures disable this integration alone.
    logger.error?.('Payment reporting configuration invalid; other Hub services remain available')
    return {available:false,error:'reporting_configuration_invalid'}
  }
  if(!sources.length)return null
  const pool=new pg.Pool({connectionString:config.databaseUrl,max:3,application_name:'hub-payment-reporting',
    connectionTimeoutMillis:2000,statement_timeout:5000,lock_timeout:2000,idle_in_transaction_session_timeout:10000,idleTimeoutMillis:30000})
  pool.on('error',()=>logger.error?.('Payment reporting database unavailable'))
  const store=new PaymentReportingStore(pool),worker=new PaymentReportingWorker(store,sources,{logger})
  return {available:true,sources,store,start:()=>worker.start(),close:async()=>{await worker.close();await pool.end()}}
}

export async function paymentReportingRoute({reporting,request,response,pathname,searchParams,principal,sendJson,requestId}) {
  const root='/internal/v1/admin/payment-reports'
  if(pathname!==root && !pathname.startsWith(`${root}/`))return false
  requirePlatformAdmin(principal)
  if(request.method!=='GET')throw new AppError(405,'method_not_allowed','支付报表接口仅支持读取')
  const reply=data=>{sendJson(response,200,{data,requestId},{'cache-control':'private, no-store'});return true}
  let admitted=false
  try {
    if(reporting?.available) {
      requirePayment((reporting.readers || 0)<2,'reporting_busy','支付报表查询繁忙，请稍后重试',429)
      reporting.readers=(reporting.readers || 0)+1;admitted=true
    }
    if(pathname===`${root}/sources`) {
      requirePayment(!searchParams.size,'invalid_reporting_query','不支持查询参数')
      if(!reporting?.available)return reply({available:false,error:reporting?.error || null,items:[]})
      const rows=await reporting.store.status(reporting.sources.map(s=>s.id))
      return reply({available:true,items:reporting.sources.map(s=>{
        const row=rows.find(r=>r.id===s.id)
        return row ? {...row,bindingMatches:row.appId===s.appId && row.environment===s.environment && (!s.expectedSourceId || !row.sourceId || s.expectedSourceId===row.sourceId)}
          : {id:s.id,appId:s.appId,environment:s.environment,phase:'pending',stale:true,bindingMatches:true}
      })})
    }
    if(!reporting?.available)throw new AppError(503,'reporting_unavailable','支付报表尚未配置')
    const match=new RegExp(`^${root}/([a-zA-Z0-9._-]{1,80})/(orders|daily)$`).exec(pathname)
    if(!match)throw new AppError(404,'not_found','支付报表接口不存在')
    const source=reporting.sources.find(s=>s.id===match[1])
    if(!source)throw new AppError(404,'not_found','支付报表数据源不存在')
    const permitted=match[2]==='orders'?['after','limit']:['from','to']
    requirePayment([...searchParams.keys()].every(k=>permitted.includes(k) && searchParams.getAll(k).length===1),'invalid_reporting_query','不支持或重复的查询参数')
    const freshness=(await reporting.store.status([source.id]))[0] || null
    if(freshness && (freshness.appId!==source.appId || freshness.environment!==source.environment || source.expectedSourceId && freshness.sourceId && source.expectedSourceId!==freshness.sourceId))throw new AppError(409,'reporting_binding_changed','数据源绑定不一致，需要核对配置')
    const data=match[2]==='orders'
      ? await reporting.store.orders(source.id,{after:searchParams.get('after') ?? undefined,limit:Number(searchParams.get('limit') ?? 50)})
      : await reporting.store.daily(source.id,searchParams.get('from'),searchParams.get('to'))
    return reply({...data,source:{id:source.id,appId:source.appId,environment:source.environment},freshness,provisional:!freshness?.caughtUp || freshness.stale})
  } catch(error) {
    if(error instanceof AppError)throw error
    if(error instanceof PaymentError)throw new AppError(error.status,error.code,error.message)
    // Do not expose PG errors, connection details or upstream response text.
    throw new AppError(503,'reporting_unavailable','支付报表暂不可用，现有登录与充值不受此查询影响')
  } finally {if(admitted)reporting.readers-=1}
}
