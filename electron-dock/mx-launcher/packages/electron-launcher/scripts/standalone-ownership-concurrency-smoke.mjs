import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const launcherModuleUrl = new URL('../dist/index.js', import.meta.url).href;
const {
  buildElectronLauncherNetworkOwnershipRegistry,
  buildElectronLauncherStandaloneOwnershipClaim,
  claimElectronLauncherStandaloneOwnershipClaim,
  readElectronLauncherStandaloneOwnershipState,
  upsertElectronLauncherStandaloneOwnershipClaim
} = await import(launcherModuleUrl);

const childSource = `
const [launcherModuleUrl, operation, statePath, ownerId, routeCidr] = process.argv.slice(1);
const launcher = await import(launcherModuleUrl);
if (operation === 'release') {
  launcher.releaseElectronLauncherStandaloneOwnershipClaim(ownerId, statePath);
} else {
  launcher.upsertElectronLauncherStandaloneOwnershipClaim({
    ownerId,
    productId: 'ownership-smoke',
    instanceId: ownerId,
    state: 'active',
    routeCidrs: [routeCidr],
    updatedAt: new Date().toISOString()
  }, statePath);
}
`;

const temporaryDirectory = await mkdtemp(join(tmpdir(), 'mx-standalone-ownership-'));
const statePath = join(temporaryDirectory, 'standalone-ownership.json');
const lockPath = `${statePath}.lock`;

try {
  const defaultClaim = buildElectronLauncherStandaloneOwnershipClaim({
    launcherMode: 'standalone',
    productId: 'luopan',
    leaseIp: '10.91.0.2',
    leaseCidr: '10.91.0.0/16',
    serviceVip: '10.88.100.3',
    routeCidrs: ['10.91.0.0/16', '10.88.100.3/32']
  });
  assert.deepEqual(
    defaultClaim.routeCidrs,
    ['10.91.0.0/16', '10.88.100.3/32'],
    'the default claim must mirror every product-scoped route actually present in routePlan.routeCidrs'
  );
  const exactRouteConflict = buildElectronLauncherNetworkOwnershipRegistry([
    {
      ownerId: 'higher-priority-owner',
      priority: 100,
      routeCidrs: ['10.88.100.3/32']
    },
    {
      ownerId: 'lower-priority-owner',
      priority: 90,
      routeCidrs: ['10.88.100.3/32']
    }
  ]);
  assert.equal(
    exactRouteConflict.conflicts.some(
      (conflict) => conflict.resource === 'route-cidr' && conflict.key === '10.88.100.3/32'
    ),
    true,
    'route priority cannot make two OS-level owners of the exact same CIDR safe'
  );

  await Promise.all(Array.from({ length: 24 }, (_, index) => runChild(
    'upsert',
    `owner-${index}`,
    `10.120.${index}.0/24`
  )));
  assertOwnerIds(
    Array.from({ length: 24 }, (_, index) => `owner-${index}`),
    'parallel first claims must not overwrite one another'
  );

  await Promise.all([
    ...Array.from({ length: 8 }, (_, index) => runChild('release', `owner-${index}`, '-')),
    ...Array.from({ length: 8 }, (_, index) => runChild(
      'upsert',
      `owner-${index + 24}`,
      `10.121.${index}.0/24`
    ))
  ]);
  assertOwnerIds(
    [
      ...Array.from({ length: 16 }, (_, index) => `owner-${index + 8}`),
      ...Array.from({ length: 8 }, (_, index) => `owner-${index + 24}`)
    ],
    'parallel release/upsert transactions must preserve unrelated claims'
  );

  const deadProcess = spawn(process.execPath, ['--eval', '']);
  const deadPid = deadProcess.pid;
  assert.equal(typeof deadPid, 'number');
  await childExit(deadProcess);
  await writeFile(lockPath, JSON.stringify({
    version: 1,
    pid: deadPid,
    token: 'dead-process-lock',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  }), { mode: 0o600 });
  upsertElectronLauncherStandaloneOwnershipClaim({
    ownerId: 'owner-after-stale-lock',
    productId: 'ownership-smoke',
    state: 'active',
    routeCidrs: ['10.122.0.0/24']
  }, statePath);
  assert(
    readElectronLauncherStandaloneOwnershipState(statePath).claims.some(
      (claim) => claim.ownerId === 'owner-after-stale-lock'
    ),
    'a lock owned by a dead process must be recovered'
  );

  await writeFile(lockPath, JSON.stringify({
    version: 1,
    pid: deadPid,
    token: 'dead-process-lock-for-concurrent-recovery',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  }), { mode: 0o600 });
  await Promise.all(Array.from({ length: 16 }, (_, index) => runChild(
    'upsert',
    `owner-after-concurrent-stale-recovery-${index}`,
    `10.126.${index}.0/24`
  )));
  const concurrentRecoveryOwners = readElectronLauncherStandaloneOwnershipState(statePath).claims;
  for (let index = 0; index < 16; index += 1) {
    assert(
      concurrentRecoveryOwners.some(
        (claim) => claim.ownerId === `owner-after-concurrent-stale-recovery-${index}`
      ),
      `concurrent stale recovery must not lose owner ${index}`
    );
  }

  const queuePath = `${lockPath}.queue`;
  await mkdir(queuePath, { recursive: true });
  await writeFile(join(queuePath, `${deadPid}-dead-queue-owner.json`), JSON.stringify({
    version: 1,
    pid: deadPid,
    token: 'dead-queue-owner',
    ticket: 1,
    choosing: false,
    metadata: { statePath },
    createdAt: new Date().toISOString()
  }), { mode: 0o600 });
  await runChild('upsert', 'owner-after-dead-queue-candidate', '10.127.0.0/24');
  assert(
    readElectronLauncherStandaloneOwnershipState(statePath).claims.some(
      (claim) => claim.ownerId === 'owner-after-dead-queue-candidate'
    ),
    'a dead unique queue candidate must be safely removed without deleting a new live owner'
  );

  await writeFile(lockPath, JSON.stringify({
    version: 1,
    pid: process.pid,
    token: 'live-process-lock',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() - 1).toISOString()
  }), { mode: 0o600 });
  const waitStartedAt = Date.now();
  assert.throws(
    () => upsertElectronLauncherStandaloneOwnershipClaim({
      ownerId: 'must-not-write-through-live-lock',
      productId: 'ownership-smoke',
      state: 'active',
      routeCidrs: ['10.123.0.0/24']
    }, statePath),
    /Timed out acquiring standalone ownership lock/,
    'a live owner lock must fail closed after a bounded wait'
  );
  const waitedMs = Date.now() - waitStartedAt;
  assert(waitedMs < 5_000, `legacy live-lock failure was not bounded as expected (${waitedMs}ms)`);
  await unlink(lockPath);

  const persisted = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(persisted.version, 1);
  assert(Array.isArray(persisted.claims));
  assert(
    !persisted.claims.some((claim) => claim.ownerId === 'must-not-write-through-live-lock'),
    'the timed-out writer must not modify ownership state'
  );

  const corruptStatePath = join(temporaryDirectory, 'corrupt-ownership.json');
  await writeFile(corruptStatePath, '{"version":1,"claims":', { mode: 0o600 });
  assert.throws(
    () => upsertElectronLauncherStandaloneOwnershipClaim({
      ownerId: 'must-not-replace-corrupt-state',
      productId: 'ownership-smoke',
      state: 'active'
    }, corruptStatePath),
    /Cannot safely update standalone ownership state/,
    'invalid ownership state must fail closed instead of being replaced with a partial registry'
  );
  assert.equal(
    await readFile(corruptStatePath, 'utf8'),
    '{"version":1,"claims":',
    'a failed-closed update must leave corrupt evidence untouched for repair'
  );

  const conflictStatePath = join(temporaryDirectory, 'conflict-ownership.json');
  upsertElectronLauncherStandaloneOwnershipClaim({
    ownerId: 'retained-owner',
    productId: 'ownership-smoke',
    state: 'active',
    routeCidrs: ['10.124.0.0/24']
  }, conflictStatePath);
  upsertElectronLauncherStandaloneOwnershipClaim({
    ownerId: 'other-owner',
    productId: 'ownership-smoke',
    state: 'active',
    routeCidrs: ['10.125.0.0/24']
  }, conflictStatePath);
  const rejectedReplacement = claimElectronLauncherStandaloneOwnershipClaim({
    ownerId: 'retained-owner',
    productId: 'ownership-smoke',
    state: 'connecting',
    routeCidrs: ['10.125.0.128/25']
  }, { statePath: conflictStatePath });
  assert.equal(rejectedReplacement.claimed, false);
  assert(rejectedReplacement.registry.conflicts.length > 0);
  const claimsAfterRejectedReplacement = readElectronLauncherStandaloneOwnershipState(conflictStatePath).claims;
  assert.deepEqual(
    claimsAfterRejectedReplacement.find((claim) => claim.ownerId === 'retained-owner')?.routeCidrs,
    ['10.124.0.0/24'],
    'a rejected reconnect claim must retain the previous live claim instead of replacing or releasing it'
  );

  const leftovers = (await readdir(temporaryDirectory)).filter(
    (name) => name.endsWith('.tmp') || name.endsWith('.lock') || name.endsWith('.recovery')
  );
  assert.deepEqual(leftovers, [], 'atomic transactions must not leave temporary or lock files behind');

  console.log('standalone ownership concurrency smoke passed');
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

function runChild(operation, ownerId, routeCidr) {
  const child = spawn(process.execPath, [
    '--input-type=module',
    '--eval',
    childSource,
    launcherModuleUrl,
    operation,
    statePath,
    ownerId,
    routeCidr
  ], {
    stdio: ['ignore', 'ignore', 'pipe']
  });
  return childExit(child);
}

function childExit(child) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`child exited with code=${code} signal=${signal || 'none'}${stderr ? `: ${stderr.trim()}` : ''}`));
    });
  });
}

function assertOwnerIds(expectedOwnerIds, message) {
  const actualOwnerIds = readElectronLauncherStandaloneOwnershipState(statePath).claims
    .map((claim) => claim.ownerId)
    .sort();
  assert.deepEqual(actualOwnerIds, [...expectedOwnerIds].sort(), message);
}
