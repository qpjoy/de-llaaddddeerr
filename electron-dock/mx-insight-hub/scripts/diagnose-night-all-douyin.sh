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
  echo 'Usage: bash diagnose-night-all-douyin.sh [--with-env|--from-api-process]' >&2
  exit 1
fi
"${NODE_BIN:-node}" <<'NODE'
const { Client } = require('pg');
const { getDatabaseUrl } = require('./lib/infra/config/database-url');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const report = {
  diagnosticVersion: 4,
  checkedAt: new Date().toISOString(),
  databaseConfigSource: 'none',
  envFilePresent: fs.existsSync('.env'),
  hubRequestId: '37bf1066-508d-47c9-9c54-2d572e03a0a5',
  nightAllRequestId: 'req_mucj2atg_dab35701',
  correlation: 'Only exact request/trace ID matches establish correlation; nearby calls are candidates, not proof.',
};
(async () => {
  let client;
  try {
    const connectionString = getDatabaseUrl();
    report.databaseConfigSource = connectionString
      ? (process.env.DATABASE_URL ? 'DATABASE_URL' : 'config.json') : 'none';
    if (connectionString && process.env.DIAGNOSTIC_DB_FROM_API === '1') {
      report.databaseConfigSource = 'api_process_DATABASE_URL';
    }
    if (!connectionString) {
      report.hint = 'No usable connection configuration in this process. Use --with-env for the trusted service .env, or run in the actual service environment. Do not paste credentials.';
      throw Object.assign(new Error(), { code: 'DATABASE_URL_missing' });
    }
    client = new Client({ connectionString, connectionTimeoutMillis: 5000,
      options: '-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=1000' });
    await client.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    async function section(name, sql, params, project = row => row) {
      await client.query('SAVEPOINT diagnostic_section');
      try {
        const rows = (await client.query(sql, params)).rows;
        report[name] = { truncated: rows.length > 50, rows: rows.slice(0, 50).map(project) };
      } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT diagnostic_section');
        report[name] = { error: { code: error.code || 'query_failed' } };
      }
      await client.query('RELEASE SAVEPOINT diagnostic_section');
    }
    await section('exactRequest', `SELECT id, request_id, platform, provider, endpoint,
      status, http_status, error_code, result_count, upstream_call_count, created_at, finished_at
      FROM public.data_api_requests WHERE request_id = $1 ORDER BY created_at LIMIT 51`,
      [report.nightAllRequestId]);
    const callColumns = `SELECT id, provider, platform, capability, endpoint_id,
      method, trace_id, status, http_status, duration_ms, created_at, finished_at,
      request_keyword = $3 AS keyword_matches, request_page, request_cursor,
      NULLIF(request_search_id, '') IS NOT NULL AS has_search_id,
      request_params->>'count' AS requested_count,
      request_params->>'offset' AS requested_offset,
      raw_saved, raw_response_ref IS NOT NULL AS has_raw_response_ref
      FROM public.source_call_logs`;
    const projectCall = ({ request_cursor: cursor, requested_count: count, requested_offset: offset, ...row }) => ({
      ...row,
      requested_count: /^\d{1,12}$/.test(count || '') ? count : null,
      requested_offset: /^\d{1,12}$/.test(offset || '') ? offset : null,
      cursor: cursor == null ? null : { length: String(cursor).length,
        numericValue: /^\d{1,16}$/.test(String(cursor)) ? String(cursor) : null,
        sha256: createHash('sha256').update(String(cursor)).digest('hex') },
    });
    const windowParams = ['2026-09-22T10:22:00Z', '2026-09-22T10:28:00Z', '受害企业 赔偿回收率'];
    await section('nearbyDouyinCalls', `${callColumns}
      WHERE platform = 'douyin' AND created_at BETWEEN $1::timestamptz AND $2::timestamptz
      ORDER BY created_at, id LIMIT 51`, windowParams, projectCall);
    await section('traceCalls', `${callColumns}
      WHERE created_at BETWEEN $1::timestamptz AND $2::timestamptz AND trace_id = $4
      ORDER BY created_at, id LIMIT 51`,
      [...windowParams, 'ebf5a392b67ce29affdaa64ae4a4f809'], projectCall);
    await section('recentDouyinCalls', `SELECT id, provider, platform, capability,
      endpoint_id, status, http_status, created_at, finished_at
      FROM public.source_call_logs WHERE provider = 'tikhub' AND platform = 'douyin'
      ORDER BY created_at DESC LIMIT 5`, []);
    await client.query('ROLLBACK');
  } catch (error) {
    report.error = { name: error.name, code: error.code || 'diagnostic_failed' };
    process.exitCode = 1;
  } finally { if (client) await client.end().catch(() => {}); }
  console.log(JSON.stringify(report, null, 2));
})();
NODE
