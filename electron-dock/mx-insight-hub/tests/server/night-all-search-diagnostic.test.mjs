import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

const shell = readFileSync(new URL('../../scripts/diagnose-night-all-search-requests.sh', import.meta.url), 'utf8')
const program = shell.split("<<'NODE'\n")[1].split('\nNODE')[0]

function diagnose({ missingLedger = false, redactedAudit = false } = {}) {
  const stub = `const Client = class {
    constructor(options) { if (!options.options.includes('default_transaction_read_only=on')) throw Error('not_readonly') }
    async connect() {}
    async end() {}
    async query(sql, params) {
      if (/^(BEGIN|ROLLBACK|SAVEPOINT|RELEASE)/.test(sql)) return { rows: [] };
      if (sql.includes('LEFT JOIN public.data_search_cursors')) return { rows: [{
        request_id: 'req_synthetic', query_text: 'synthetic', found: ${redactedAudit ? 'null' : 'true'},
        audit_cursor_redacted: ${redactedAudit},
        primary_cursor: '8', params: { search_id: 'private-search', backtrace: 'private-backtrace' }
      }] };
      if (sql.includes('JOIN public.data_search_cursors')) return { rows: [{
        request_id: 'req_synthetic', query_text: 'synthetic', cursor_token: 'private-server-cursor',
        primary_cursor: '8', params: { search_id: 'private-search' }
      }] };
      if (sql.includes('FROM public.source_endpoint_catalog')) return { rows: [] };
      if (sql.includes('FROM public.source_call_logs')) {
        if (${missingLedger}) throw Object.assign(new Error('private-db-error'), {code:'42501'});
        return { rows: [{ request_keyword: 'synthetic', request_cursor: 'private-cursor', http_status: 400,
          created_at: '2026-09-23T05:23:00.000Z' }] };
      }
      if (sql.includes('FROM public.data_api_requests')) return { rows: [{
        request_id: 'req_synthetic', query_text: 'synthetic', cursor: '${redactedAudit ? '[redacted]' : 'private-server-cursor'}',
        availability_mode: 'ready_only', http_status: 200, finished_at: '2026-09-23T05:23:00.000Z'
      }] };
      throw Error('unexpected_query');
    }
  }`
  const code = program.replace("const { Client } = require('pg');", stub)
    .replace("const { getDatabaseUrl } = require('./lib/infra/config/database-url');", "const getDatabaseUrl = () => 'private-db-url';")
    .replace("const fs = require('node:fs');", "const fs = { statSync() { throw Object.assign(new Error(), {code:'ENOENT'}); } };")
    .replace('161332dd5ba244f14566d9ccfc214dbbd620bcd401cded068fc230e3d4e2815b', createHash('sha256').update('synthetic').digest('hex'))
  const result = spawnSync(process.execPath, [], { input: code, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  for (const privateValue of ['private-db-url', 'private-cursor', 'private-server-cursor', 'private-search', 'private-backtrace', 'private-db-error']) {
    assert.ok(!result.stdout.includes(privateValue), 'no private values in diagnostic output')
  }
  return JSON.parse(result.stdout)
}

test('Night-All search diagnosis shows stored split cursor and post-Hub completion without exposing values', () => {
  const report = diagnose()
  assert.equal(report.targets.length, 3)
  const target = report.targets[0]
  assert.equal(target.requests.rows[0].queryMatches, true)
  assert.equal(target.requests.rows[0].finishedAfterHub, true)
  assert.equal(target.storedCursors.rows[0].primaryCursor.numericValue, '8')
  assert.equal(target.storedCursors.rows[0].paramsCursor, null)
  assert.equal(target.storedCursors.rows[0].hasSearchId, true)
  assert.equal(target.supplierCalls.rows[0].http_status, 400)
  assert.deepEqual(report.logs.error, { code: 'ENOENT' })
})

test('supplier ledger permission error does not masquerade as empty results or hide other targets', () => {
  const report = diagnose({ missingLedger: true })
  for (const target of report.targets) {
    assert.deepEqual(target.supplierCalls.error, { code: '42501' })
    assert.equal(target.requests.rows.length, 1)
  }
})

test('redacted audit cursors are unavailable for lookup, not evidence of missing stored state', () => {
  const report = diagnose({ redactedAudit: true })
  const target = report.targets[0]
  assert.equal(report.diagnosticVersion, 2)
  assert.deepEqual(target.requests.rows[0].cursor, { redacted: true, usableForLookup: false })
  assert.equal(target.storedCursors.rows[0].found, null)
  assert.equal(target.storedCursors.rows[0].lookupStatus, 'audit_cursor_redacted_not_looked_up')
  assert.equal(target.cursorContextCandidates.rows[0].correlation, 'context_only_not_token_match')
  assert.equal(target.cursorContextCandidates.rows[0].serverCursorSha256,
    createHash('sha256').update('private-server-cursor').digest('hex'))
})
