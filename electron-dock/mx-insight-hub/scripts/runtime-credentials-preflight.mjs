#!/usr/bin/env node
// No secret values, hashes, connection strings or subprocess output are logged.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const decode = (secret, key) => Buffer.from(secret?.data?.[key] ?? '', 'base64').toString('utf8');
const requireMatch = (ok, message) => { if (!ok) throw new Error(message); };

export function validateCredentials(hub, product, desired) {
  if (!hub) {
    requireMatch(!product, 'Hub Secret is missing while its product credential remains; restore the original Hub Secret/.env.internal before deploying');
    return;
  }
  requireMatch(decode(hub, 'MX_INSIGHT_API_KEY_PEPPER') === desired.pepper && desired.pepper,
    'API-key pepper differs from the retained deployment; automatic rotation refused');
  requireMatch(product, 'retained Hub product database Secret is missing; automatic password generation refused');
  const password = decode(product, 'password');
  requireMatch(password && decode(product, 'database') === 'mx_insight_hub'
    && decode(product, 'username') === 'mx_insight_hub', 'invalid Hub product database credential metadata');
  let dsn;
  try { dsn = new URL(decode(hub, 'DATABASE_URL')); } catch { throw new Error('invalid retained Hub database URL'); }
  requireMatch(['postgres:', 'postgresql:'].includes(dsn.protocol)
    && dsn.hostname === 'mx-common-postgres.mx-common.svc.cluster.local' && (!dsn.port || dsn.port === '5432')
    && dsn.username === 'mx_insight_hub' && dsn.pathname === '/mx_insight_hub'
    && decodeURIComponent(dsn.password) === password, 'Hub and mx-common database credentials disagree; explicit reconciliation required');
  requireMatch(!desired.password || desired.password === password,
    'MX_INSIGHT_POSTGRES_PASSWORD differs from the retained credential; deploy cannot rotate it');
}
function secret(namespace, name) {
  let result;
  try {
    result = execFileSync('kubectl', ['--request-timeout=20s', '-n', namespace, 'get', 'secret', name, '--ignore-not-found', '-o', 'json'],
      { encoding: 'utf8', timeout: 25000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch { throw new Error('could not inspect retained credentials; deployment refused'); }
  return result.trim() ? JSON.parse(result) : null;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    validateCredentials(secret('mx-insight-hub', 'mx-insight-hub-secrets'), secret('mx-common', 'mx-common-db-mx-insight-hub'), {
      pepper: process.env.MX_INSIGHT_API_KEY_PEPPER, password: process.env.MX_INSIGHT_POSTGRES_PASSWORD,
    });
    console.log('[mx-insight-hub] retained credential continuity verified (or confirmed first install)');
  } catch (error) { console.error(`[mx-insight-hub] ${error.message}`); process.exitCode = 78; }
}
