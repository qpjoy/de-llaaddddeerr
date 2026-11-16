import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import test from 'node:test';

import type { SiteSlotAccessAccount, SiteSlotSshProfile } from '../../types.js';
import { probeOverseaRecovery } from './oversea-recovery.js';

const tls = Array(32).fill('AB').join(':');
const accounts = [{ username: 'existing-user', authToken: 'private-token-test', status: 'active' }] as SiteSlotAccessAccount[];
const digest = createHash('sha256').update('existing-user,private-token-test\n').digest('hex');
const profile = {
  profileId: 'sshprof_test', siteId: 'oversea-test', kind: 'oversea', status: 'active',
  host: '192.0.2.20', sshUser: 'root', sshPort: 22, identityFile: process.execPath,
  knownHostsFile: process.execPath, sshConfigFile: null, hostKeyAlias: 'oversea-test',
  strictHostKeyChecking: 'yes', batchMode: 'yes', serverPorts: '51288', exportPort: 3434
} as SiteSlotSshProfile;

function output(changes: Record<string, string> = {}) {
  return Object.entries({
    ssh: 'ok', 'docker-installed': 'yes', docker: 'yes', compose: 'yes', stack: 'yes',
    hysteria: 'yes', outlet: 'yes', health: 'yes', 'advertised-host': "'192.0.2.20'",
    'server-ports': "'51288'", tls, 'mounted-tls': tls, 'applied-tls': tls,
    accounts: digest, 'mounted-accounts': digest,
    'udp-bindings': JSON.stringify({ '51288/udp': [{ HostIp: '0.0.0.0', HostPort: '51288' }] }),
    complete: 'yes', ...changes
  }).map(([key, value]) => `mx-recovery ${key}=${value}`).join('\n');
}

test('probe uses strict pinned SSH, forces saved hostname and returns public live facts only', async () => {
  const calls: string[][] = [];
  let callbackError: unknown;
  const live = await probeOverseaRecovery(profile, accounts, async (args) => {
    try {
    calls.push(args);
    if (args[0] === '-G') return { stdout: `hostname ${profile.host}\n`, stderr: '' };
    const script = args.at(-1)!;
    execFileSync('/bin/bash', ['-n', '-c', script]);
    assert.ok(args.includes(`HostName=${profile.host}`));
    assert.ok(args.includes('StrictHostKeyChecking=yes'));
    assert.ok(args.includes('BatchMode=yes'));
    assert.doesNotMatch(script, /\.\/manage\.sh|source |curl.*get\.docker|docker-compose\s+version|\b(mv|cp|rm|chmod|mkdir)\b/);
    assert.doesNotMatch(script, /private-token-test/);
    return { stdout: `${output()}\nignored-private-output`, stderr: 'ignored-private-stderr' };
    } catch (error) { callbackError = error; throw error; }
  });
  assert.ifError(callbackError);
  assert.equal(calls.length, 2);
  assert.equal(live.healthy, true);
  assert.equal(live.accountsMatch, true);
  assert.equal(live.tlsFingerprint, tls);
  assert.doesNotMatch(JSON.stringify(live), /private|ignored|[a-f0-9]{64}/);
});

test('a stale custom HostName blocks before opening SSH to either machine', async () => {
  let calls = 0;
  const live = await probeOverseaRecovery(profile, accounts, async (args) => {
    calls += 1;
    assert.equal(args[0], '-G');
    return { stdout: 'hostname 192.0.2.99\n', stderr: '' };
  });
  assert.equal(calls, 1);
  assert.equal(live.ssh, false);
  assert.equal(live.category, 'ssh-config-target');
});

test('running containers and matching .env cannot mask missing, remapped or loopback UDP publication', async () => {
  for (const bindings of [null, {}, { '51288/udp': null },
    { '51288/udp': [{ HostIp: '0.0.0.0', HostPort: '60000' }] },
    { '51288/udp': [{ HostIp: '127.0.0.1', HostPort: '51288' }] }]) {
    const live = await probeOverseaRecovery(profile, accounts, async (args) => ({
      stdout: args[0] === '-G' ? `hostname ${profile.host}\n` : output({ 'udp-bindings': JSON.stringify(bindings) }), stderr: ''
    }));
    assert.equal(live.ssh, true);
    assert.equal(live.portsMatch, false);
    assert.equal(live.healthy, false);
  }
});

test('UDP range and comma specifications require every advertised port to be published', async () => {
  for (const spec of ['51288-51289', '51288,51289']) {
    const bindings = { '51288/udp': [{ HostIp: '0.0.0.0', HostPort: '51288' }], '51289/udp': [{ HostIp: '0.0.0.0', HostPort: '51289' }] };
    const live = await probeOverseaRecovery({ ...profile, serverPorts: spec }, accounts, async (args) => ({
      stdout: args[0] === '-G' ? `hostname ${profile.host}\n` : output({ 'server-ports': spec, 'udp-bindings': JSON.stringify(bindings) }), stderr: ''
    }));
    assert.equal(live.healthy, true);
  }
});

test('stale runtime certificate, accounts or host prevent healthy classification', async () => {
  for (const changes of [
    { 'mounted-tls': Array(32).fill('CD').join(':') }, { 'mounted-accounts': 'stale' },
    { 'advertised-host': '192.0.2.21' }, { compose: 'no' }, { health: 'no' }
  ] as Array<Record<string, string>>) {
    const live = await probeOverseaRecovery(profile, accounts, async (args) => ({
      stdout: args[0] === '-G' ? `hostname ${profile.host}\n` : output(changes), stderr: ''
    }));
    assert.equal(live.ssh, true);
    assert.equal(live.healthy, false);
  }
});

test('SSH failures expose only actionable categories, never raw stderr', async () => {
  for (const [message, category] of [
    ['REMOTE HOST IDENTIFICATION HAS CHANGED: private-output', 'host-key'],
    ['Permission denied: private-output', 'auth'], ['connection timed out: private-output', 'connection']
  ]) {
    const live = await probeOverseaRecovery(profile, accounts, async () => { throw new Error(message); });
    assert.equal(live.category, category);
    assert.equal(live.ssh, false);
    assert.doesNotMatch(JSON.stringify(live), /private-output/);
  }
});
