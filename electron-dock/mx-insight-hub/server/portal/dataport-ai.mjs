import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { AppError } from '../core/errors.mjs';
import { requireDataportAccess, legacyPermissions } from './dataport-policy.mjs';
import { uuid } from './dataport-store.mjs';

const targets = {
  prod: ['http://delta.mxinfo-inc.cn', 'd59e1ef9-6aeb-477a-acc0-dac46715a334'],
  dev: ['http://dev.delta.mxinfo-inc.cn', '92cb5e1d-1183-492b-9a2e-f7a9c1e129aa'],
};
const active = new Set(['created','queued','running','retrying','resuming','pausing']);
const terminal = new Set(['succeeded','failed','canceled','stale','paused']);
const fingerprint = token => createHash('sha256').update(token).digest('hex');
const failure = code => Object.assign(Error(code), { code });
export function aiConfig(env = process.env, read = readFileSync) {
  try {
    const environment = env.MX_DATAPORT_AI_ENV || 'prod';
    if (!Object.hasOwn(targets, environment)) return null;
    const token = read(env.MX_DATAPORT_AI_TOKEN_FILE || '/run/dataport-ai/token', 'utf8').trim();
    if (!token || token.length > 4096 || /\s/.test(token)) return null;
    return { environment, token, fingerprint: fingerprint(token) };
  } catch { return null; }
}

// Preserve the complete delivered contract, including unknown fields and nulls.
// Only persisted, successful deliveries can become Agent input.
export function assessmentInput(payload) {
  const response = payload?.response;
  return Number(payload?.status) >= 200 && Number(payload?.status) < 300 &&
    response && typeof response === 'object' && !Array.isArray(response) &&
    ['success','partial','no_data'].includes(response.data?.status) &&
    response.data?.data && typeof response.data.data === 'object' && !Array.isArray(response.data.data)
    ? response : null;
}
export function assessmentView(row, configured = true) {
  if (!row) return { status: configured ? 'not_requested' : 'not_configured', text: null };
  const uncertain = row.status === 'submitting' && Date.now() - new Date(row.created_at).getTime() > 60000;
  return {
    status: uncertain ? 'submission_unknown' : row.status,
    text: row.status === 'succeeded' ? row.result_text : null,
    canPoll: Boolean(row.run_key),
    error: row.error_code || null,
    updatedAt: row.updated_at,
    retryAfterMs: Math.max(1500, Math.min(30000, new Date(row.poll_after).getTime() - Date.now() || 0)),
  };
}
async function boundedJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw failure('invalid_response');
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 512 * 1024) throw failure('invalid_response');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) { await reader.cancel().catch(()=>{}); throw error; }
}

export class DataportAi {
  constructor(pool, { config = aiConfig, fetch: fetcher = fetch } = {}) {
    this.pool = pool; this.config = config; this.fetch = fetcher;
    this.inflight = new Set();
    // Retain accepted handles if a transient DB write fails. Never repeat POST.
    this.accepted = new Map();
  }
  async call(config, path, body) {
    const [origin] = targets[config.environment];
    const response = await this.fetch(origin + path, {
      method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(12000),
      headers: { Authorization: `Token ${config.token}`, Accept: 'application/json', ...(body ? {'content-type':'application/json'} : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (response.status !== (body ? 202 : 200)) {
      await response.body?.cancel().catch(()=>{});
      throw failure(body && [400,401,403,404,429].includes(response.status) ? 'submit_rejected' : body ? 'submission_unknown' : 'poll_unavailable');
    }
    return boundedJson(response);
  }
  async row(tenant, id) {
    return (await this.pool.query('SELECT * FROM dataport.ai_assessments WHERE tenant_id=$1 AND query_id=$2', [tenant,id])).rows[0];
  }
  async ensure(tenant, id) {
    const config = this.config();
    if (!config) return assessmentView(null, false);
    if (this.inflight.size >= 16 || this.accepted.size >= 32) return {status:'unavailable',text:null};
    const query = (await this.pool.query('SELECT actor,payload FROM dataport.queries WHERE tenant_id=$1 AND id=$2', [tenant,id])).rows[0];
    const input = assessmentInput(query?.payload);
    if (!input) return { status:'not_applicable', text:null };
    const claimed = (await this.pool.query(`INSERT INTO dataport.ai_assessments(tenant_id,query_id,actor,environment,credential_fingerprint,input)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING *`, [tenant,id,query.actor,config.environment,config.fingerprint,input])).rows[0];
    if (claimed) {
      const work = this.submit(claimed, config).catch(()=>{}).finally(()=>this.inflight.delete(work));
      this.inflight.add(work);
    }
    return assessmentView(claimed || await this.row(tenant,id));
  }
  async submit(row, config) {
    try {
      const [,agent] = targets[config.environment];
      const value = await this.call(config, `/api/agent/run/by-key/${agent}/`, {
        uid: `dataport:${row.tenant_id}:${row.actor}`, input: JSON.stringify(row.input), async:true, stream:false,
      });
      if (!uuid(value?.run_key)) throw failure('submission_unknown');
      const valid = !value.error && !value.msg && (active.has(value.status) || terminal.has(value.status)) &&
        (!value.poll_path || value.poll_path === `/api/agent-runs/by-key/${value.run_key}/`);
      // poll_url is untrusted and deliberately unused. All polls use a fixed origin/path.
      const accepted = { runKey:value.run_key, status:valid ? active.has(value.status) ? value.status : 'queued' : 'submission_unknown' };
      this.accepted.set(`${row.tenant_id}:${row.query_id}`, accepted);
      await this.saveHandle(row.tenant_id,row.query_id,accepted);
    } catch(error) {
      if (!this.accepted.has(`${row.tenant_id}:${row.query_id}`))
        await this.pool.query(`UPDATE dataport.ai_assessments SET status=$3,error_code=$4,updated_at=now() WHERE tenant_id=$1 AND query_id=$2 AND run_key IS NULL`,
          [row.tenant_id,row.query_id,error.code === 'submit_rejected' ? 'failed' : 'submission_unknown',error.code === 'submit_rejected' ? 'submit_rejected' : 'submission_unknown']);
    }
  }
  async saveHandle(tenant,id,value) {
    await this.pool.query(`UPDATE dataport.ai_assessments SET run_key=$3,status=$4,error_code=$5,updated_at=now() WHERE tenant_id=$1 AND query_id=$2 AND run_key IS NULL`, [tenant,id,value.runKey,value.status,value.status==='submission_unknown'?'submission_unknown':null]);
    this.accepted.delete(`${tenant}:${id}`);
  }
  async read(principal,tenant,id) {
    const membership = requireDataportAccess(principal,tenant);
    if (!uuid(id)) return {status:'not_requested',text:null}; // Legacy history has no automatic AI work.
    const query = (await this.pool.query('SELECT actor FROM dataport.queries WHERE tenant_id=$1 AND id=$2',[tenant,id])).rows[0];
    if (!query) throw new AppError(404,'query_not_found','未找到当前企业的查询记录。');
    const permissions = membership.dataport?.permissions || legacyPermissions(membership);
    if (!permissions.includes('history.read')) {
      requireDataportAccess(principal,tenant,'query.execute');
      if (query.actor !== principal.memberId) throw new AppError(403,'insufficient_permission','无权查看此查询的分析。');
    }
    const accepted = this.accepted.get(`${tenant}:${id}`);
    if (accepted) await this.saveHandle(tenant,id,accepted);
    let row = await this.row(tenant,id);
    if (!row || (!active.has(row.status) && !['paused','submission_unknown'].includes(row.status)) || !row.run_key) return assessmentView(row, Boolean(this.config()));
    const config = this.config();
    if (!config || config.environment !== row.environment || config.fingerprint !== row.credential_fingerprint)
      return { ...assessmentView(row), error:'configuration_unavailable', retryAfterMs:30000 };
    // CAS poll lease coalesces concurrent tabs/replicas; reads never submit a run.
    const lease = (await this.pool.query(`UPDATE dataport.ai_assessments SET poll_after=now()+interval '15 seconds',poll_generation=poll_generation+1
      WHERE tenant_id=$1 AND query_id=$2 AND poll_after<=now() AND status=ANY($3::text[]) RETURNING *`,[tenant,id,[...active,'paused','submission_unknown']])).rows[0];
    if (!lease) return assessmentView(row);
    try {
      const value = await this.call(config, `/api/agent-runs/by-key/${row.run_key}/`);
      if (!active.has(value.status) && !terminal.has(value.status)) throw failure('invalid_response');
      const text = value.result?.result ?? value.run?.output?.result;
      if (value.status === 'succeeded' && (typeof text !== 'string' || !text.trim() || text.length > 30000)) throw failure('invalid_response');
      await this.pool.query(`UPDATE dataport.ai_assessments SET status=$3,result_text=$4,error_code=$5,poll_failures=0,poll_after=now()+interval '2 seconds',updated_at=now() WHERE tenant_id=$1 AND query_id=$2 AND poll_generation=$6`,
        [tenant,id,value.status,value.status==='succeeded'?text:null,['failed','canceled','stale','paused'].includes(value.status)?value.status:null,lease.poll_generation]);
    } catch {
      await this.pool.query(`UPDATE dataport.ai_assessments SET error_code='poll_unavailable',poll_failures=least(poll_failures+1,10),poll_after=now()+least(30,power(2,least(poll_failures+1,5))) * interval '1 second',updated_at=now() WHERE tenant_id=$1 AND query_id=$2 AND poll_generation=$3`,[tenant,id,lease.poll_generation]);
    }
    row = await this.row(tenant,id);
    return assessmentView(row);
  }
}
