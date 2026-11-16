import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { loadConfig } from '../config.js';
import { buildSiteSlotPlan } from './domain.js';

const workerSource = readFileSync(new URL('../../scripts/site-slot-worker-run.mjs', import.meta.url), 'utf8');

function functionSource(name: string): string {
  const start = workerSource.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} must exist`);
  const bodyStart = workerSource.indexOf('{', workerSource.indexOf(')', start));
  let depth = 0;
  for (let index = bodyStart; index < workerSource.length; index += 1) {
    if (workerSource[index] === '{') depth += 1;
    if (workerSource[index] === '}') depth -= 1;
    if (depth === 0) return workerSource.slice(start, index + 1);
  }
  throw new Error(`${name} is not balanced`);
}

const expandWorkerCommand = Function('resolve', `
const artifactBaseDir = '/artifact root/site-slots';
const commandCwd = '/worker';
${['shellQuote', 'sshConfigFile', 'sshUsesDefaultIsolatedConfig', 'sshOptionArgs', 'sshOptionFragment',
  'applySshProfile', 'commandKind', 'resolveArtifactReference', 'applyArtifactBaseDir'].map(functionSource).join('\n')}
return (command, profile) => applyArtifactBaseDir(applySshProfile(command, profile));
`)(resolve) as (command: string, profile: Record<string, unknown>) => string;

function transportCommand(kind: 'oversea' | 'domestic'): string {
  const plan = buildSiteSlotPlan(loadConfig(), {
    siteId: `${kind}-transport-test`, kind, host: '192.0.2.21', sshUser: 'root', sshPort: 2222,
    rootAccess: true, hasDocker: true, hasOutboundInternet: true,
    workerInternalBaseUrl: 'http://127.0.0.1:18090'
  }, `plan-${kind}-transport-test`);
  const bundle = kind === 'oversea' ? 'mx-oversea-access-stack.tar.gz' : 'mx-domestic-services.tar.gz';
  const command = plan.deploymentPhases.flatMap(phase => phase.commands ?? [])
    .find(command => command.startsWith('if command -v rsync') && command.includes(bundle));
  assert.ok(command, `generated ${kind} artifact transport must exist`);
  return expandWorkerCommand(command, {
    sshConfigFile: '/managed config/ssh', identityFile: '/managed key/id_rsa',
    knownHostsFile: '/managed known_hosts', hostKeyAlias: `${kind}-transport-test`,
    batchMode: 'yes', strictHostKeyChecking: 'yes', connectTimeoutSeconds: 30
  });
}

function runTransport(kind: 'oversea' | 'domestic', remoteRsync: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'mx-oversea-transport-'));
  try {
    for (const executable of ['ssh', 'rsync', 'scp']) {
      writeFileSync(join(dir, executable), `#!/bin/sh
printf '${executable}\\n' >> "$MX_TEST_TRACE"
printf '%s\\n' "$@" > "$MX_TEST_ARGS/${executable}.args"
${executable === 'ssh' ? '[ "$MX_TEST_REMOTE_RSYNC" = yes ]' : 'exit 0'}
`, { mode: 0o755 });
    }
    const command = transportCommand(kind);
    execFileSync('/bin/bash', ['-n', '-c', command]);
    execFileSync('/bin/bash', ['-c', command], {
      env: { ...process.env, PATH: dir, MX_TEST_TRACE: join(dir, 'trace'), MX_TEST_ARGS: dir, MX_TEST_REMOTE_RSYNC: remoteRsync ? 'yes' : 'no' },
      timeout: 5_000
    });
    const args = (name: string) => existsSync(join(dir, `${name}.args`))
      ? readFileSync(join(dir, `${name}.args`), 'utf8').trimEnd().split('\n') : [];
    return { calls: readFileSync(join(dir, 'trace'), 'utf8').trim().split('\n'), ssh: args('ssh'), rsync: args('rsync'), scp: args('scp') };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('Oversea falls back to scp when only the new remote VM lacks rsync', () => {
  const result = runTransport('oversea', false);
  assert.deepEqual(result.calls, ['ssh', 'scp']);
  assert.equal(result.ssh.at(-1), 'command -v rsync >/dev/null 2>&1');
  for (const args of [result.ssh, result.scp]) {
    assert.ok(args.includes('/managed config/ssh'));
    assert.ok(args.includes('/managed key/id_rsa'));
    assert.ok(args.includes('UserKnownHostsFile=/managed known_hosts'));
    assert.ok(args.includes('StrictHostKeyChecking=yes'));
    assert.ok(args.includes('2222'));
  }
  assert.ok(result.scp.includes('/artifact root/site-slots/oversea/mx-oversea-access-stack.tar.gz'));
  assert.equal(result.scp.at(-1), 'root@192.0.2.21:/opt/mx/incoming/');
});

test('Oversea retains rsync when both Internal and remote VM have it', () => {
  const result = runTransport('oversea', true);
  assert.deepEqual(result.calls, ['ssh', 'rsync']);
  const remoteShell = result.rsync[result.rsync.indexOf('-e') + 1];
  assert.match(remoteShell, /'\/managed config\/ssh'/);
  assert.match(remoteShell, /'StrictHostKeyChecking=yes'/);
  assert.match(remoteShell, /-p 2222/);
  assert.ok(result.rsync.includes('/artifact root/site-slots/oversea/mx-oversea-access-stack.tar.gz'));
});

test('Domestic transport retains its existing local-only rsync selection', () => {
  const result = runTransport('domestic', false);
  assert.deepEqual(result.calls, ['rsync']);
  assert.ok(result.rsync.includes('/artifact root/site-slots/domestic/mx-domestic-services.tar.gz'));
});
