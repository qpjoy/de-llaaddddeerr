#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i];
  if (!key.startsWith('--')) die(`unknown argument: ${key}`);
  const value = process.argv[i + 1];
  if (!value || value.startsWith('--')) die(`missing value for ${key}`);
  args.set(key.slice(2), value);
  i += 1;
}

const stateFile = args.get('state-file');
const usersFile = args.get('users-file');
const envFile = args.get('output-env-file');
if (!stateFile || !usersFile || !envFile) {
  die('usage: reconcile-tunnel-state.mjs --state-file PATH --users-file PATH --output-env-file PATH');
}

const state = JSON.parse(readFileSync(stateFile, 'utf8'));
const accounts = Array.isArray(state.accounts) ? state.accounts : [];
const policies = Array.isArray(state.policies) ? state.policies : [];
const defaultPolicy = policies.find((row) => row?.isDefault) ?? policies[0] ?? null;
const policyById = new Map(policies.map((row) => [String(row?.id ?? ''), row]));

const rows = ['name,auth,up,down'];
for (const account of accounts) {
  if (account?.status && account.status !== 'active') continue;
  const username = safeName(account?.username ?? account?.id);
  const authToken = cleanCell(account?.authToken, 'authToken');
  const upRate = cleanCell(account?.upRate ?? '', 'upRate', true);
  const downRate = cleanCell(account?.downRate ?? '', 'downRate', true);
  if (!username || !authToken) continue;
  rows.push([username, authToken, upRate, downRate].join(','));
}

writeFileSync(usersFile, rows.join('\n') + '\n', { mode: 0o600 });

const selectedPolicy = defaultPolicy ?? policyById.get(String(accounts[0]?.policyId ?? '')) ?? null;
const routingMode = ['cn-direct', 'global'].includes(selectedPolicy?.routingMode)
  ? selectedPolicy.routingMode
  : 'cn-direct';

const env = {
  TUNNEL_REVISION: cleanCell(state.revision ?? '', 'revision', true),
  TUNNEL_NODE_PUBLIC_HOST: cleanCell(state.node?.publicHost ?? '', 'publicHost', true),
  TUNNEL_NODE_SERVER_PORTS: cleanCell(state.node?.serverPorts ?? '', 'serverPorts', true),
  TUNNEL_ROUTING_MODE: routingMode,
  TUNNEL_ACCOUNT_COUNT: String(rows.length - 1)
};
writeFileSync(
  envFile,
  Object.entries(env).map(([key, value]) => `${key}=${shellQuote(value)}`).join('\n') + '\n',
  { mode: 0o600 }
);

function safeName(value) {
  return String(value ?? '')
    .trim()
    .replace(/[^a-zA-Z0-9_.-]/g, '_')
    .slice(0, 64);
}

function cleanCell(value, field, optional = false) {
  const out = String(value ?? '').trim();
  if (!out && optional) return '';
  if (!out) die(`missing ${field}`);
  if (/[\r\n,]/.test(out)) die(`${field} cannot contain comma or newline`);
  return out;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function die(message) {
  console.error(`tunnel-state: ${message}`);
  process.exit(1);
}
