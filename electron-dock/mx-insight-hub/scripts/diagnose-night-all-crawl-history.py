#!/usr/bin/env python3
"""Read the fixed Twitter incident from the running host Night-All process's DB (Python 3.5+)."""
import json
import os
from pathlib import Path
import subprocess
import sys

REVISION = "night-all-crawl-history.v1"
NODE = r"""
const { createRequire } = require('node:module');
const localRequire = createRequire(require('node:path').join(process.cwd(), 'package.json'));
const report = { revision: 'night-all-crawl-history.v1', databaseSource: 'process_exec_environment' };
const safe = (value, pattern) => value == null ? null : pattern.test(String(value)) ? String(value) : '[hidden]';
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const identifier = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32}|req_[a-z0-9]{1,16}_[0-9a-f]{8})$/i;
const timestamp = value => value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : null;
(async () => {
  let client;
  try {
    report.stage = 'connect';
    const { Client } = localRequire('pg');
    client = new Client({ connectionString: process.env.DATABASE_URL,
      connectionTimeoutMillis: 3000, query_timeout: 6000,
      options: '-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=1000' });
    await client.connect();
    await client.query('BEGIN TRANSACTION READ ONLY');
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SET LOCAL lock_timeout = '1s'");
    report.stage = 'query';
    const result = await client.query(`
      SELECT id, request_id, endpoint, platform, provider, status, http_status,
             duration_ms, result_count, upstream_call_count, error_code, created_at, finished_at,
             request_params->'__traceContext'->>'traceId' AS trace_id,
             CASE WHEN request_params->>'count' ~ '^[0-9]{1,6}$' THEN (request_params->>'count')::integer END AS requested_count,
             CASE WHEN request_params->>'page' ~ '^[0-9]{1,6}$' THEN (request_params->>'page')::integer END AS requested_page,
             EXISTS (SELECT 1 FROM jsonb_each(request_params) AS entry(key, value)
               WHERE key IN ('username','userId','usernames','userIds','uid','user_id')
                 AND ((jsonb_typeof(value) IN ('string','number') AND btrim(value #>> '{}') <> '')
                   OR (jsonb_typeof(value) = 'array' AND value <> '[]'::jsonb))) AS has_identity
      FROM public.data_api_requests
      WHERE created_at BETWEEN '2026-10-15T15:59:45Z'::timestamptz AND '2026-10-15T16:01:00Z'::timestamptz
        AND endpoint = '/api/v1/search/crawl'
        AND (platform = 'twitter' OR platforms @> ARRAY['twitter']::text[])
      ORDER BY created_at, id LIMIT 31`);
    report.candidates = result.rows.slice(0, 30).map(row => ({
      id: safe(row.id, /^(?:[1-9][0-9]{0,19}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i),
      requestId: safe(row.request_id, identifier), traceId: safe(row.trace_id, /^[0-9a-f]{32}$/i),
      endpoint: '/api/v1/search/crawl', platform: safe(row.platform, /^[a-z][a-z0-9_-]{0,31}$/),
      provider: safe(row.provider, /^[a-z][a-z0-9_-]{0,31}$/), status: safe(row.status, /^(running|success|failed)$/),
      httpStatus: integer(row.http_status), durationMs: integer(row.duration_ms), resultCount: integer(row.result_count),
      upstreamCallCount: integer(row.upstream_call_count), errorCode: safe(row.error_code, /^[A-Za-z][A-Za-z0-9_]{0,63}$/),
      createdAt: timestamp(row.created_at), finishedAt: timestamp(row.finished_at),
      requestedCount: integer(row.requested_count), requestedPage: integer(row.requested_page), hasIdentity: row.has_identity === true
    }));
    report.possiblyTruncated = result.rows.length === 31;
    await client.query('ROLLBACK');
    report.stage = 'complete';
    report.correlation = 'candidates_not_confirmed_identity';
    report.evidenceBoundary = 'Time-window candidates only; not confirmed Hub matches or supplier billing proof.';
  } catch (error) {
    report.errorCode = safe(error.code, /^(?:[0-9A-Z]{5}|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|MODULE_NOT_FOUND)$/) || 'diagnostic_failed';
    process.exitCode = 1;
  } finally { if (client) await client.end().catch(() => {}); }
  console.log(JSON.stringify(report));
})().catch(() => { console.log(JSON.stringify({ revision: report.revision, errorCode: 'diagnostic_failed' })); process.exitCode = 1; });
"""


def fail(code):
    print(json.dumps({"revision": REVISION, "errorCode": code}))
    raise SystemExit(1)


def resolve_existing(path):
    try:
        return path.resolve(strict=True)
    except TypeError:
        # Python 3.5 resolve() is always strict and has no keyword argument.
        return path.resolve()


def main():
    if len(sys.argv) != 2 or not sys.argv[1] or any(c < "0" or c > "9" for c in sys.argv[1]) or int(sys.argv[1]) <= 1:
        fail("usage_python3_diagnose_night_all_crawl_history_py_PID")
    proc = Path("/proc") / sys.argv[1]
    try:
        identity = (proc / "stat").read_text().rsplit(") ", 1)[1].split()[19]
        if any(os.readlink(str(proc / "ns" / kind)) != os.readlink(str(Path("/proc/self/ns") / kind)) for kind in ("net", "mnt")):
            fail("run_on_night_all_host_same_network_and_mount_namespace")
        cwd = resolve_existing(proc / "cwd")
        args = (proc / "cmdline").read_bytes().split(b"\0")
        if len(args) < 2 or args[1].decode() not in ("server.js", str(cwd / "server.js")):
            fail("pid_is_not_night_all_server")
        if json.loads((cwd / "package.json").read_text()).get("name") != "night-all" or not (cwd / "server.js").is_file():
            fail("pid_is_not_night_all_server")
        if resolve_existing(proc / "exe").name not in ("node", "nodejs"):
            fail("pid_executable_is_not_node")
        values = [entry[len(b"DATABASE_URL="):] for entry in (proc / "environ").read_bytes().split(b"\0") if entry.startswith(b"DATABASE_URL=")]
        if len(values) != 1 or not values[0]:
            fail("database_url_missing_from_process_exec_environment")
        if identity != (proc / "stat").read_text().rsplit(") ", 1)[1].split()[19]:
            fail("process_changed_retry_with_current_listener_pid")
        completed = subprocess.run([str(proc / "exe"), "--input-type=commonjs", "-"], input=NODE,
            cwd=str(cwd), env={"DATABASE_URL": values[0].decode(), "PATH": "/usr/bin:/bin", "LANG": "C"},
            universal_newlines=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20, check=False)
        report = json.loads(completed.stdout)
        if report.get("revision") != REVISION:
            fail("unexpected_diagnostic_output")
        print(json.dumps(report, ensure_ascii=True, indent=2))
        raise SystemExit(0 if completed.returncode == 0 else 1)
    except subprocess.TimeoutExpired:
        fail("diagnostic_deadline_exceeded")
    except (OSError, ValueError, IndexError, AttributeError):
        fail("process_or_database_diagnostic_unavailable_no_raw_details")


if __name__ == "__main__":
    main()
