#!/usr/bin/env node
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElectronLauncherSystemDomainProxy } from '../dist/system-domain-proxy.js';
import {
  currentDarwinExternalApplyPhase,
  currentDarwinResolverDomains,
  darwinExternalApplyAbortAllowed,
  darwinPacVerificationRowsReady,
  intersectDarwinManagedServiceNames,
  mergeDarwinPreviousState
} from '../dist/darwin-system-domain-proxy-state.js';

assert.equal(currentDarwinExternalApplyPhase('prepared'), 'prepared');
assert.equal(currentDarwinExternalApplyPhase('privileged-handoff'), 'privileged-handoff');
assert.equal(currentDarwinExternalApplyPhase('readback-started'), 'readback-started');
assert.equal(currentDarwinExternalApplyPhase('unknown'), null);
assert.equal(darwinExternalApplyAbortAllowed('prepared'), true);
assert.equal(darwinExternalApplyAbortAllowed('privileged-handoff'), false);
assert.equal(darwinExternalApplyAbortAllowed('readback-started'), false);
assert.equal(darwinExternalApplyAbortAllowed('privileged-handoff', 'authorization-canceled'), true);
assert.equal(darwinExternalApplyAbortAllowed('readback-started', 'authorization-canceled'), false);

if (process.platform === 'darwin') {
  const tempDir = mkdtempSync(join(tmpdir(), 'system-domain-proxy-handoff-'));
  const statePath = join(tempDir, 'state.json');
  const manager = createElectronLauncherSystemDomainProxy({
    userDataDir: tempDir,
    statePath
  });
  try {
    const prepared = await manager.prepareExternalApply?.({
      enabled: true,
      domains: ['h2i.mxinfo-inc.cn'],
      pacUrl: 'http://127.0.0.1:44444/proxy.pac',
      systemResolver: false
    });
    assert.equal(prepared?.externalApplyPhase, 'prepared');
    assert.ok(prepared?.transactionToken);
    chmodSync(tempDir, 0o500);
    assert.throws(
      () => manager.markExternalApplyHandoff?.(prepared.transactionToken),
      'a durable handoff write failure must synchronously stop osascript'
    );
    chmodSync(tempDir, 0o700);
    const aborted = await manager.abortExternalApply?.(prepared.transactionToken, {
      execution: 'not-started',
      reason: 'test-handoff-write-failed'
    });
    assert.equal(aborted?.skipReason, 'external-apply-aborted-before-system-write');
    assert.equal(existsSync(statePath), false);
  } finally {
    chmodSync(tempDir, 0o700);
    await manager.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

const previous = {
  services: [
    { name: 'Wi-Fi', url: 'http://previous/proxy.pac', enabled: true },
    { name: 'deleted-test-service', url: null, enabled: false }
  ]
};
const current = {
  services: [
    { name: 'Wi-Fi', url: 'http://127.0.0.1:2053/proxy.pac', enabled: true },
    { name: 'USB Ethernet', url: null, enabled: false },
    { name: 'Renamed Wi-Fi', url: 'http://127.0.0.1:2053/proxy.pac', enabled: true }
  ]
};
const merged = mergeDarwinPreviousState(
  previous,
  current,
  'http://127.0.0.1:2053/proxy.pac'
);
assert.deepEqual(merged.services, [
  { name: 'Wi-Fi', url: 'http://previous/proxy.pac', enabled: true },
  { name: 'deleted-test-service', url: null, enabled: false },
  { name: 'USB Ethernet', url: null, enabled: false }
], 'a renamed service carrying the MX PAC must not become restore state');
assert.deepEqual(merged.cleanupOnlyServices, [
  { name: 'Renamed Wi-Fi', pacUrl: 'http://127.0.0.1:2053/proxy.pac' }
], 'a renamed service carrying the MX PAC must remain eligible for ownership-checked cleanup');
const externallyReplaced = mergeDarwinPreviousState(merged, {
  services: [
    { name: 'Renamed Wi-Fi', url: 'http://127.0.0.1:7890/proxy.pac', enabled: true }
  ]
}, 'http://127.0.0.1:2053/proxy.pac');
assert.deepEqual(
  externallyReplaced.cleanupOnlyServices,
  [],
  'cleanup-only ownership must be released when another PAC takes over the renamed service'
);
assert.equal(
  externallyReplaced.services.some((service) => service.name === 'Renamed Wi-Fi'),
  false,
  'an external takeover observed after MX apply must not be invented as a pre-MX restore snapshot'
);
assert.deepEqual(
  intersectDarwinManagedServiceNames(
    ['AX88179A', 'Wi-Fi', 'Thunderbolt Bridge', 'deleted-test-service'],
    ['AX88179A', 'Wi-Fi', 'Thunderbolt Bridge', 'new-service']
  ),
  ['AX88179A', 'Wi-Fi', 'Thunderbolt Bridge'],
  'apply and verify must use the live intersection without adopting an unsnapshotted service'
);
assert.deepEqual(
  intersectDarwinManagedServiceNames(['deleted-test-service'], []),
  [],
  'an empty live intersection must remain blocked instead of becoming vacuously ready'
);
assert.deepEqual(
  currentDarwinResolverDomains([
    'mxinfo-inc.cn',
    'h2i.mxinfo-inc.cn',
    'MXINFO-INC.CN.',
    'invalid domain'
  ]),
  ['mxinfo-inc.cn', 'h2i.mxinfo-inc.cn'],
  'a V2 child zone must remain available to outrank a foreign V1 parent resolver'
);
assert.equal(darwinPacVerificationRowsReady([]), false);
assert.equal(
  darwinPacVerificationRowsReady([{ applied: true, ignored: true }]),
  false,
  'all targets disappearing during verification must not become vacuously ready'
);
assert.equal(
  darwinPacVerificationRowsReady([
    { applied: true },
    { applied: true, ignored: true }
  ]),
  true,
  'a verified live service may coexist with a confirmed disappeared service'
);
assert.equal(
  darwinPacVerificationRowsReady([{ applied: true }, { applied: false, unmanaged: true }]),
  false,
  'a newly enabled service without a pre-MX snapshot must keep readiness blocked'
);

const sourcePath = fileURLToPath(new URL('../src/system-domain-proxy.ts', import.meta.url));
const source = readFileSync(sourcePath, 'utf8');
for (const name of [
  'darwinPlatformAndSystemApplyShell',
  'applyDarwinPac',
  'verifyDarwinPac'
]) {
  assert.match(
    functionSource(source, name),
    /liveDarwinNetworkServices\(previous\)/,
    `${name} must operate on the current macOS service inventory`
  );
}
const resumeStart = source.indexOf('async resumeDarwinLocalEdge(');
const resumeEnd = source.indexOf('async refreshWindowsContinuation(', resumeStart);
assert.ok(resumeStart >= 0 && resumeEnd > resumeStart, 'missing Darwin local-edge resume method');
const resumeSource = source.slice(resumeStart, resumeEnd);
assert.match(
  resumeSource,
  /verifyPlatformPac[\s\S]*verifySystemResolvers[\s\S]*startLocalEdge: false[\s\S]*darwinLocalEdgeMatchesStoredState[\s\S]*resolvePacSource\(policy, existing\.previous, \{ allowShared: false \}\)[\s\S]*currentVerifiedStatus/,
  'cold start must verify live state and strictly match a side-effect-free candidate before binding the resumed relay'
);
assert.doesNotMatch(
  resumeSource,
  /runDarwinPrivilegedShell|applyPlatformPacAndSystemResolvers|writeState\(|removeState\(/,
  'cold-start local-edge resume must not write system configuration or durable ownership state'
);
assert.match(
  functionSource(source, 'applyDarwinPacAndDynamicResolvers'),
  /!forceRefresh[\s\S]*runDarwinPrivilegedShell/,
  'manual repair must be able to bypass a metadata-only fast path and flush macOS DNS'
);
assert.match(
  source,
  /function platformStatesForApply[\s\S]*mergeDarwinPreviousState\(existing\.previous, current, existing\.pacUrl\)/,
  'new live services must be added without overwriting the original restore snapshot'
);
assert.match(
  functionSource(source, 'liveDarwinNetworkServices'),
  /intersectDarwinManagedServiceNames\(baseline, listed\)[\s\S]*-getautoproxyurl[\s\S]*The service was removed/,
  'a stale durable service name must be ignored after a read probe fails'
);
assert.match(
  functionSource(source, 'runDarwinNetworksetupSetBatch'),
  /darwinGuardedNetworksetupMutation\(service, args\)/,
  'the privileged PAC-only fallback must ignore a service removed after preflight'
);
assert.match(
  functionSource(source, 'darwinGuardedNetworksetupMutation'),
  /if ! \$\{mutation\}[\s\S]*if \$\{probe\}[\s\S]*darwinNetworkServiceReadFailureGuard/,
  'a mutation/read failure must use live inventory to distinguish deletion from a still-live service'
);
assert.match(
  functionSource(source, 'darwinNetworkServiceReadFailureGuard'),
  /listallnetworkservices[\s\S]*sed 's\/\^\\\\\*\/\/'[\s\S]*grep -Fqx[\s\S]*exit 1/,
  'a failed service read is ignored only after a successful inventory proves the service disappeared'
);
assert.match(
  functionSource(source, 'verifyDarwinPac'),
  /darwinNetworkServiceExists\(name\)[\s\S]*unmanaged[\s\S]*darwinPacVerificationRowsReady\(rows\)/,
  'verification must ignore a confirmed removal, reject unmanaged services, and require a live row'
);
const restoreSource = functionSource(source, 'darwinPlatformAndSystemRestoreShell');
assert.match(
  restoreSource,
  /darwinAutoProxyRestoreCommands[\s\S]*darwinLiveOwnedPacCleanupCommand/,
  'disconnect must restore snapshots and sweep renamed services in the same transaction'
);
assert.doesNotMatch(
  functionSource(source, 'restoreDarwinPlatformAndSystemState'),
  /restoreDarwinState|restoreSystemResolvers/,
  'a failed/canceled combined restore must preserve state instead of opening fallback authorization dialogs'
);
const snapshotRestoreSource = functionSource(source, 'darwinAutoProxyRestoreCommands');
assert.match(
  snapshotRestoreSource,
  /darwinGuardedNetworksetupMutation[\s\S]*darwinNetworkServiceReadFailureGuard[\s\S]*grep -Fqx[\s\S]*Enabled: Yes/,
  'snapshot restore must fail closed on CAS read errors, use guarded mutations, and skip an external takeover'
);
const liveCleanupSource = functionSource(source, 'darwinLiveOwnedPacCleanupCommand');
assert.ok(
  liveCleanupSource.includes('service=${service#\\\\*}'),
  'disabled service names must be normalized and included in the owned-PAC sweep'
);
assert.match(
  liveCleanupSource,
  /network_services=\$\(\/usr\/sbin\/networksetup -listallnetworkservices\) \|\| exit 1[\s\S]*service-read-failed[\s\S]*grep -Fqx[\s\S]*done \| \/usr\/bin\/grep -q \.[\s\S]*exit 1/,
  'renamed cleanup must fail closed on inventory/readback errors or an enabled exact owned PAC'
);
assert.match(
  functionSource(source, 'darwinPlatformAndSystemApplyShell'),
  /darwinGuardedNetworksetupMutation[\s\S]*dscacheutil -flushcache[\s\S]*mDNSResponder/,
  'the privileged transaction must recheck live services and flush stale DNS answers'
);
assert.match(
  source,
  /function verifyLocalDnsRelay[\s\S]*routes\.find\([\s\S]*h2i[\s\S]*exactH2iDomain[\s\S]*route\?\.host \|\| exactH2iDomain/,
  'local DNS relay readiness must prefer the exact H2I hostname over a parent resolver apex'
);
const externalPrepareSource = functionSource(source, 'prepareExternalApplyTransaction');
assert.match(
  externalPrepareSource,
  /beforeState\?\.sharedLocalPac[\s\S]*external-apply-shared-edge-rollback-unsafe[\s\S]*randomUUID\(\)[\s\S]*allowSharedLocalEdge: false[\s\S]*externalTransactionToken: token[\s\S]*darwinPlatformAndSystemApplyShell[\s\S]*transactionToken: token/,
  'external prepare must issue a token, persist it with pending state, and refuse shared-edge mutation'
);
const externalAbortSource = functionSource(source, 'abortExternalApplyTransaction');
assert.match(
  externalAbortSource,
  /not-started[\s\S]*authorization-canceled[\s\S]*transaction\.token !== token[\s\S]*current\.externalTransactionToken !== token[\s\S]*current\.sharedLocalPac[\s\S]*restoreExternalApplyLocalEdge[\s\S]*writeState\(statePath, transaction\.beforeState\)[\s\S]*rmSync\(statePath, \{ force: true \}\)/,
  'abort must require proof of non-execution plus the exact in-memory and durable transaction token before local-only rollback'
);
assert.match(
  externalAbortSource,
  /externalApplyTransactionPhase\(transaction, current\)[\s\S]*darwinExternalApplyAbortAllowed\(phase, abortOptions\.execution\)[\s\S]*external-apply-abort-after-handoff/,
  'abort must reject both in-memory and durable evidence that privileged handoff already happened'
);
assert.doesNotMatch(
  externalAbortSource,
  /releaseSharedOwnerForState|releaseSharedLocalPacServer|restorePlatformAndSystemState|runDarwinPrivilegedShell/,
  'abort must never mutate macOS system state or release another process shared-edge owner'
);
const externalCompleteSource = functionSource(source, 'completeExternalApplyTransaction');
assert.match(
  externalCompleteSource,
  /existing\.pending !== true[\s\S]*existing\.externalTransactionToken !== token[\s\S]*externalTransactionPhase: 'readback-started'[\s\S]*writeState\(statePath, readbackState\)[\s\S]*verifySystemResolvers[\s\S]*verifyPlatformPac[\s\S]*delete next\.pending[\s\S]*delete next\.externalTransactionToken[\s\S]*delete next\.externalTransactionPhase[\s\S]*writeState\(statePath, next\)/,
  'complete must consume the exact durable token and only finalize from live readback'
);
assert.match(
  functionSource(source, 'markExternalApplyHandoffTransaction'),
  /externalTransactionPhase: 'privileged-handoff'[\s\S]*writeState\(statePath, next\)[\s\S]*transaction\.phase = 'privileged-handoff'/,
  'the synchronous handoff hook must durably mark the transaction before the caller starts osascript'
);
assert.doesNotMatch(
  externalCompleteSource,
  /restorePlatformAndSystemState|runDarwinPrivilegedShell|releaseSharedOwnerForState/,
  'complete after executed or uncertain shell state must remain read-only apart from durable finalization'
);
assert.match(
  functionSource(source, 'restoreExternalApplyLocalEdge'),
  /localPacServer !== before\.server[\s\S]*refusing an unsafe rollback[\s\S]*if \(localPacServer \|\| localDnsServer\) await closeLocalPacServer\(\)/,
  'local-edge abort must fail closed on concurrent replacement and only close an edge created by the transaction'
);
assert.match(
  source,
  /prepareExternalApply: prepareExternalApplyTransaction[\s\S]*abortExternalApply: abortExternalApplyTransaction[\s\S]*markExternalApplyHandoff: markExternalApplyHandoffTransaction[\s\S]*darwinPrepareApply: prepareExternalApplyTransaction[\s\S]*completeExternalApply: completeExternalApplyTransaction/,
  'the manager must expose tokenized prepare/abort/complete with the legacy Darwin prepare alias'
);
assert.match(
  functionSource(source, 'requiresManagedRelease'),
  /if \(!ownerId\) return claims\.length > 0 \|\| registeredOwnerIds\.length > 0/,
  'a released local owner with remaining registry claims must keep managed no-restore semantics'
);
const foreignHdoResolver = '# Generated by HDO\nnameserver 100.88.0.1\n';
assert.equal(
  foreignHdoResolver.includes('MX_ELECTRON_LAUNCHER_RESOLVER'),
  false,
  'the V1 HDO resolver fixture must not carry the V2 ownership marker'
);
for (const name of [
  'darwinStaleResolverFileRemovalCommands',
  'darwinOwnedResolverFileRemovalCommands'
]) {
  assert.match(
    functionSource(source, name),
    /DARWIN_RESOLVER_MARKER/,
    `${name} must leave a foreign HDO resolver untouched`
  );
}

function functionSource(text, name) {
  const start = text.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing function ${name}`);
  const declaration = text.slice(start);
  const bodyLine = declaration.match(/^[^\n]*\)\s*(?::[^\n]*)?\s*\{\s*$/m);
  assert.ok(bodyLine, `missing body for function ${name}`);
  const bodyStart = start + bodyLine.index + bodyLine[0].lastIndexOf('{');
  let depth = 0;
  for (let index = bodyStart; index < text.length; index += 1) {
    if (text[index] === '{') depth += 1;
    if (text[index] !== '}') continue;
    depth -= 1;
    if (depth === 0) return text.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

console.log('macOS system domain proxy stale-service tests passed');
