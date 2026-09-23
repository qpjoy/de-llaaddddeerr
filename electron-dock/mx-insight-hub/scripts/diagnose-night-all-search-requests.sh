#!/usr/bin/env bash
# Run from the actual Night-All project root, using its Node environment.
# Only reads the historical TikHub call ledger; sends no supplier requests.
set -euo pipefail
if [[ "${1:-}" == '--from-api-process' ]]; then
  set +x
  exec python3 - "$0" <<'PY'
import os
from pathlib import Path
import subprocess
import sys

def stop(message):
    print(message, file=sys.stderr)
    sys.exit(1)

try:
    pid = Path('logs/runtime/api.pid').read_text().strip()
    if not pid.isdecimal() or int(pid) <= 1:
        stop('Invalid API PID file; no query executed.')
    proc = Path('/proc') / pid
    if (proc / 'cwd').resolve(strict=True) != Path.cwd().resolve():
        stop('API process belongs to another directory; no query executed.')
    args = (proc / 'cmdline').read_bytes().split(b'\0')
    if not any(Path(os.fsdecode(arg)).name == 'server.js' for arg in args if arg):
        stop('PID does not identify the expected API server.js; no query executed.')
    entries = (proc / 'environ').read_bytes().split(b'\0')
    value = next((item.split(b'=', 1)[1] for item in entries
                  if item.startswith(b'DATABASE_URL=')), b'')
    if not value:
        stop('Running API has no DATABASE_URL in its startup environment; no query executed.')
    env = os.environ.copy()
    env['DATABASE_URL'] = os.fsdecode(value)
    env['DIAGNOSTIC_DB_FROM_API'] = '1'
    result = subprocess.run(['bash', str(Path(sys.argv[1]).resolve())], env=env)
    sys.exit(result.returncode)
except OSError as error:
    stop('Cannot access local API process (errno=%s). Run as the service user, inside its Linux environment. No query executed.' % error.errno)
PY
elif [[ "${1:-}" == '--with-env' ]]; then
  # Match start-node.sh's trusted shell-format .env, without running startup actions.
  set +x
  if [[ ! -f .env ]]; then
    echo 'No .env in current directory; run from the actual Night-All root or its service container.' >&2
    exit 1
  fi
  set -a
  . ./.env
  set +a
elif [[ $# -gt 0 ]]; then
  echo 'Usage: bash diagnose-night-all-search-requests.sh [--with-env|--from-api-process]' >&2
  exit 1
fi
"${NODE_BIN:-node}" <<'NODE'
const { Client } = require('pg');
const { getDatabaseUrl } = require('./lib/infra/config/database-url');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const readline = require('node:readline');
const queryHash = '161332dd5ba244f14566d9ccfc214dbbd620bcd401cded068fc230e3d4e2815b';
const targets = [
  { hubRequestId: '98a5c405-dbe4-4ccc-bf0a-5e6907ca7320', platform: 'douyin', start: '2026-09-23T05:20:35.770Z', end: '2026-09-23T05:20:41.974Z' },
  { hubRequestId: '43b3dd52-76a3-41a7-b5e3-e3fbad5b06fa', platform: 'kuaishou', start: '2026-09-23T05:21:47.772Z', end: '2026-09-23T05:22:17.785Z' },
  { hubRequestId: '87a2d0c7-ebf6-41bb-b1ee-1bd073a4477b', platform: 'wechat_mp', start: '2026-09-23T05:22:38.370Z', end: '2026-09-23T05:22:38.414Z' },
];
const report = { diagnosticVersion: 2, checkedAt: new Date().toISOString(), databaseConfigSource: 'none',
  correlation: 'Request candidates match platform, start window and query hash; verify IDs/trace before attribution.', targets: [] };
const hash = v => createHash('sha256').update(String(v)).digest('hex');
const matchQuery = v => typeof v === 'string' && hash(v.trim()) === queryHash;
const safe = v => typeof v === 'string' && /^[A-Za-z0-9_.:/-]{1,180}$/.test(v) ? v : null;
const present = v => v != null && v !== '';
const cursorSummary = v => v === '[redacted]' ? { redacted: true, usableForLookup: false }
  : present(v) ? { length: String(v).length, sha256: hash(v),
    numericValue: /^\d{1,16}$/.test(String(v)) ? String(v) : null } : null;
function errorSummary(value, depth = 0) {
  if (depth > 5 || !value || typeof value !== 'object') return null;
  if (Array.isArray(value)) return value.slice(0, 10).map(v => errorSummary(v, depth + 1));
  const output = {};
  for (const key of ['code', 'endpointId', 'platform', 'capability']) if (safe(value[key])) output[key] = safe(value[key]);
  for (const key of ['status', 'statusCode']) if (Number.isInteger(value[key])) output[key] = value[key];
  if (['ready', 'degraded', 'disabled', 'declared', 'catalogued', 'unavailable', 'failed'].includes(value.status)) output.status = value.status;
  for (const key of ['details', 'errors', 'endpointTrace', 'cause']) if (value[key]) output[key] = errorSummary(value[key], depth + 1);
  if (Array.isArray(value.reasons)) output.reasonCodes = value.reasons.map(safe).filter(Boolean).slice(0, 10);
  return output;
}
(async () => {
  let client;
  const logIds = new Set();
  try {
    const connectionString = getDatabaseUrl();
    if (!connectionString) throw Object.assign(new Error(), { code: 'DATABASE_URL_missing' });
    report.databaseConfigSource = process.env.DIAGNOSTIC_DB_FROM_API === '1' ? 'api_process_DATABASE_URL'
      : process.env.DATABASE_URL ? 'DATABASE_URL' : 'config.json';
    client = new Client({ connectionString, connectionTimeoutMillis: 5000,
      options: '-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=1000' });
    await client.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    async function section(output, name, sql, params, project) {
      await client.query('SAVEPOINT diagnostic_section');
      try {
        const rows = (await client.query(sql, params)).rows;
        output[name] = { truncated: rows.length > 50, rows: rows.slice(0, 50).map(project) };
      } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT diagnostic_section');
        output[name] = { error: { code: error.code || 'query_failed' } };
      }
      await client.query('RELEASE SAVEPOINT diagnostic_section');
    }
    for (const target of targets) {
      const output = { ...target };
      report.targets.push(output);
      const from = new Date(Date.parse(target.start) - 2000).toISOString();
      const requestEnd = new Date(Date.parse(target.start) + 10000).toISOString();
      const callsEnd = new Date(Date.parse(target.end) + 120000).toISOString();
      await section(output, 'requests', `SELECT id, request_id, endpoint, platform, provider, status,
        http_status, error_code, result_count, upstream_call_count, duration_ms, created_at, finished_at,
        query_text, request_params->>'cursor' AS cursor,
        request_params #>> '{__traceContext,traceId}' AS trace_id,
        request_params->>'availabilityMode' AS availability_mode
        FROM public.data_api_requests WHERE platform = $1 AND created_at BETWEEN $2::timestamptz AND $3::timestamptz
        AND endpoint = '/api/v1/data/search' ORDER BY created_at, id LIMIT 51`, [target.platform, from, requestEnd],
        ({ query_text, cursor, availability_mode, ...row }) => {
          const matches = matchQuery(query_text);
          if (matches && row.request_id) logIds.add(row.request_id);
          return { ...row, queryMatches: matches, cursor: cursorSummary(cursor), availabilityMode: safe(availability_mode),
            finishedAfterHub: row.finished_at ? new Date(row.finished_at).getTime() > Date.parse(target.end) : null };
        });
      await section(output, 'storedCursors', `SELECT r.request_id, r.query_text,
        r.request_params->>'cursor' = '[redacted]' AS audit_cursor_redacted,
        CASE WHEN r.request_params->>'cursor' = '[redacted]' THEN NULL ELSE c.cursor_token IS NOT NULL END AS found,
        c.platform, c.provider, c.endpoint_id, c.page_index, c.created_at, c.updated_at, c.expires_at,
        c.expires_at <= r.created_at AS expired_at_request,
        c.provider_state->'nextParams' AS params, c.provider_state->>'nextCursor' AS primary_cursor,
        c.provider_state->'hasMore' AS has_more,
        jsonb_array_length(c.buffered_items) AS buffered_count
        FROM public.data_api_requests r LEFT JOIN public.data_search_cursors c
          ON c.cursor_token = NULLIF(r.request_params->>'cursor', '[redacted]')
        WHERE r.platform = $1 AND r.created_at BETWEEN $2::timestamptz AND $3::timestamptz
        AND r.endpoint = '/api/v1/data/search' AND NULLIF(r.request_params->>'cursor', '') IS NOT NULL
        ORDER BY r.created_at, r.id LIMIT 51`, [target.platform, from, requestEnd],
        ({ query_text, params, primary_cursor, ...row }) => ({ ...row, queryMatches: matchQuery(query_text),
          lookupStatus: row.audit_cursor_redacted ? 'audit_cursor_redacted_not_looked_up' : row.found ? 'found' : 'not_found',
          primaryCursor: cursorSummary(primary_cursor), paramsCursor: cursorSummary(params?.cursor),
          hasSearchId: present(params?.search_id), hasBacktrace: present(params?.backtrace),
          hasPcursor: present(params?.pcursor), hasContinuationToken: present(params?.continuation_token) }));
      // Audit deliberately redacts cursor values. These are labelled context
      // candidates, never presented as a token match or proof of historical state.
      await section(output, 'cursorContextCandidates', `SELECT r.request_id, r.query_text,
        c.platform, c.provider, c.endpoint_id, c.page_index, c.created_at, c.updated_at, c.expires_at,
        c.cursor_token, c.provider_state->'nextParams' AS params,
        c.provider_state->>'nextCursor' AS primary_cursor,
        c.provider_state->'hasMore' AS has_more,
        c.updated_at > r.created_at AS changed_since_request
        FROM public.data_api_requests r JOIN public.data_search_cursors c
          ON c.business_id = r.business_id AND c.platform = r.platform
          AND c.request_context->>'query' = r.query_text
          AND c.created_at BETWEEN r.created_at - interval '24 hours' AND r.created_at
          AND c.expires_at > r.created_at
        WHERE r.platform = $1 AND r.created_at BETWEEN $2::timestamptz AND $3::timestamptz
          AND r.endpoint = '/api/v1/data/search'
        ORDER BY r.created_at, c.created_at DESC LIMIT 51`, [target.platform, from, requestEnd],
        ({ query_text, cursor_token, params, primary_cursor, ...row }) => ({ ...row,
          correlation: 'context_only_not_token_match', queryMatches: matchQuery(query_text),
          serverCursorSha256: hash(cursor_token), primaryCursor: cursorSummary(primary_cursor),
          paramsCursor: cursorSummary(params?.cursor), hasSearchId: present(params?.search_id),
          hasBacktrace: present(params?.backtrace) }));
      await section(output, 'supplierCalls', `SELECT id, platform, provider, capability, endpoint_id, trace_id,
        status, http_status, duration_ms, created_at, finished_at, request_keyword, request_cursor,
        NULLIF(request_search_id, '') IS NOT NULL AS has_search_id,
        NULLIF(request_params->>'backtrace', '') IS NOT NULL AS has_backtrace,
        raw_saved, raw_response_ref IS NOT NULL AS has_raw_response
        FROM public.source_call_logs WHERE platform = $1 AND created_at BETWEEN $2::timestamptz AND $3::timestamptz
        ORDER BY created_at, id LIMIT 51`, [target.platform, from, callsEnd],
        ({ request_keyword, request_cursor, ...row }) => ({ ...row, queryMatches: matchQuery(request_keyword),
          cursor: cursorSummary(request_cursor), startedAfterHub: new Date(row.created_at).getTime() > Date.parse(target.end) }));
      if (target.platform === 'wechat_mp') {
        await section(output, 'currentCatalog', `SELECT provider, platform, capability, endpoint_id, status,
          last_success_at, contract_updated_at,
          (last_success_at IS NOT NULL AND contract_updated_at IS NOT NULL AND last_success_at >= contract_updated_at)
            AS meets_timestamp_verification
          FROM public.source_endpoint_catalog WHERE platform = $1 ORDER BY provider, endpoint_id LIMIT 51`,
          [target.platform], row => row);
      }
    }
    await client.query('ROLLBACK');
  } catch (error) {
    report.error = { code: error.code || 'diagnostic_failed' };
    process.exitCode = 1;
  } finally { if (client) await client.end().catch(() => {}); }
  // Read a bounded tail of the existing API log, projecting only structured codes.
  report.logs = { file: 'logs/api.log', requestIds: [...logIds], records: [], tailOnly: false };
  if (logIds.size) {
    try {
      const stat = fs.statSync('logs/api.log');
      const start = Math.max(0, stat.size - 64 * 1024 * 1024);
      report.logs.tailOnly = start > 0;
      const stream = fs.createReadStream('logs/api.log', { start, end: Math.max(0, stat.size - 1) });
      const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
      let first = true;
      try {
        for await (const line of lines) {
          if (first && start > 0) { first = false; continue; }
          first = false;
          if (line.length > 1000000 || ![...logIds].some(id => line.includes(id))) continue;
          let value;
          try { value = JSON.parse(line); } catch { continue; }
          if (!logIds.has(value.requestId)) continue;
          if (report.logs.records.length >= 50) { report.logs.truncated = true; break; }
          report.logs.records.push({ ts: safe(value.ts), requestId: safe(value.requestId), traceId: safe(value.traceId),
            event: ['http_request', 'http_request_failed'].includes(value.message) ? value.message : 'other',
            status: Number.isInteger(value.status) ? value.status : null,
            durationMs: Number.isFinite(value.durationMs) ? value.durationMs : null,
            error: errorSummary(value.error) });
        }
      } finally { lines.close(); stream.destroy(); }
    } catch (error) { report.logs.error = { code: error.code || 'log_read_failed' }; }
  }
  console.log(JSON.stringify(report, null, 2));
})();
NODE
