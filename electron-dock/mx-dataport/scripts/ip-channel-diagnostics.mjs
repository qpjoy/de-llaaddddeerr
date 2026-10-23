import pg from 'pg';
import { fileURLToPath } from 'node:url';

const defaults = [
  ['febff105-3b2f-4e9d-9ef5-a186d4b74d9b', 'e1b94f14-0b3f-4b9d-ba25-0e9a441e52e2'],
  ['1c2d79f0-bede-4f6e-ab40-25351da10302', '43f3c15a-6976-441b-8735-644743307ebf'],
];
const uuid = value => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
export function upstreamMetadata(row) {
  const { diagnostic_body, ...metadata } = row;
  if (diagnostic_body) {
    try {
      const code = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(diagnostic_body))?.ret_data?.code;
      metadata.businessCode = code != null && /^-?\d{1,12}$/.test(String(code)) ? Number(code) : null;
    } catch { metadata.bodyNotJson = true; }
  }
  return metadata;
}

export async function collectIpChannelDiagnostics(client, targets = defaults) {
  if (!targets.length || targets.length > 5 || targets.some(pair => pair.length !== 2 || !pair.every(uuid)))
    throw Object.assign(new Error('Expected request/query UUID pairs'), { code: 'invalid_diagnostic_target' });
  const report = { targets, sections: {} };
  const section = async (name, run) => {
    await client.query('SAVEPOINT diagnostic_section');
    try { report.sections[name] = await run(); }
    catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT diagnostic_section');
      report.sections[name] = { unavailable: true, code: error.code || 'diagnostic_failed' };
    }
    await client.query('RELEASE SAVEPOINT diagnostic_section');
  };
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    report.clock = (await client.query(`SELECT now() AS checked_at,
      now() AT TIME ZONE 'Asia/Shanghai' AS beijing_time,
      current_setting('transaction_read_only') AS read_only`)).rows[0];
    await section('delivery', async () => (await client.query(
      "SELECT channel,revision FROM hub_commerce.product_delivery WHERE product='ip_risk'"
    )).rows);
    await section('channel', async () => (await client.query(`SELECT id,revision,enabled,daily_limit,spacing_ms,
      tokens,refill_at,day,calls,next_at,cooldown_until,last_status,last_observed_at,
      cooldown_until>now() AS cooling,
      greatest(0,extract(epoch FROM cooldown_until-now())) AS cooldown_seconds_remaining,
      least(10,tokens+greatest(0,extract(epoch FROM now()-refill_at))/60) AS effective_tokens,
      CASE WHEN day=(now() AT TIME ZONE 'Asia/Shanghai')::date THEN calls ELSE 0 END AS calls_today
      FROM hub_commerce.ip_channel WHERE id='baidu-v2'`)).rows);
    await section('providerState', async () => (await client.query(`SELECT provider_key,consecutive_failures,
      circuit_open_until,last_success_at,last_failure_at,last_error_code
      FROM external_platform.provider_state WHERE provider_key IN ('baidu-ip','ipsearch')`)).rows);
    await section('queries', async () => (await client.query(`SELECT id,created_at,status,
      payload->>'requestId' AS request_id,payload #>> '{response,requestId}' AS response_request_id,
      payload #>> '{error,code}' AS error_code,payload #>> '{response,error,code}' AS response_error_code,
      payload->>'batchId' AS batch_id
      FROM dataport.queries WHERE id=ANY($1::uuid[])`, [targets.map(pair => pair[1])])).rows);
    await section('usage', async () => (await client.query(`SELECT id,status,error_code,response_status,
      units_reserved,units_actual,reserved_at,completed_at,response_body #>> '{error,code}' AS response_error_code
      FROM usage_requests WHERE id=ANY($1::uuid[])`, [targets.map(pair => pair[0])])).rows);
    await section('providerCalls', async () => (await client.query(`SELECT id,usage_request_id,provider_key,
      outcome,http_status,business_code,error_code,started_at,completed_at
      FROM external_platform.provider_calls WHERE usage_request_id=ANY($1::uuid[])`, [targets.map(pair => pair[0])])).rows);
    await section('upstreamCalls', async () => (await client.query(`SELECT id,request_id,endpoint,status,outcome,
      created_at,completed_at,CASE WHEN octet_length(body)<=1048576 THEN body END AS diagnostic_body
      FROM hub_commerce.ip_upstream_calls WHERE request_id=ANY($1::uuid[])
      ORDER BY created_at LIMIT 20`, [targets.map(pair => pair[0])])).rows.map(upstreamMetadata));
    // Channel-wide metadata only: no IPs, tenant identities, credentials or raw responses.
    await section('recentUpstream', async () => (await client.query(`SELECT endpoint,status,outcome,created_at,
      completed_at,CASE WHEN octet_length(body)<=1048576 THEN body END AS diagnostic_body
      FROM hub_commerce.ip_upstream_calls WHERE created_at>=now()-interval '24 hours'
      ORDER BY created_at DESC LIMIT 20`)).rows.map(upstreamMetadata));
  } finally { await client.query('ROLLBACK'); }
  return report;
}

if (process.argv[1] === '-' || process.argv[1] === fileURLToPath(import.meta.url)) {
  let client;
  try {
    const args = process.argv.slice(2);
    if (args.length && args.length !== 2) throw Object.assign(new Error(), { code: 'expected_request_and_query_UUID' });
    if (!process.env.DATABASE_URL) throw Object.assign(new Error(), { code: 'DATABASE_URL_missing' });
    client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000,
      application_name: 'ip-channel-readonly-diagnostic',
      options: '-c default_transaction_read_only=on -c statement_timeout=8000 -c lock_timeout=2000' });
    await client.connect();
    console.log(JSON.stringify(await collectIpChannelDiagnostics(client, args.length ? [args] : defaults), null, 2));
  } catch (error) {
    console.log(JSON.stringify({ fatal: { code: error.code || 'diagnostic_failed' } }));
    process.exitCode = 1;
  } finally { await client?.end().catch(() => {}); }
}
