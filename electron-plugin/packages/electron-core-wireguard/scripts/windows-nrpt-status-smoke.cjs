const assert = require('node:assert/strict');
const {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const {
  buildWireGuardTunnelCommand,
  evaluateWindowsWireGuardNrptStatus,
  getWindowsWireGuardNrptStatus,
  getWindowsWireGuardTunnelStatusByName,
  renderWireGuardInterface
} = require('../dist/index.js');

const expectedRules = [
  { namespace: 'mxinfo-inc.cn', nameServers: ['10.88.88.88'] },
  { namespace: '.mxinfo-inc.cn', nameServers: ['10.88.88.88'] }
];
const currentComment = 'MX-H2I / QPJoy MX-H2I mx-h2i';
const legacyComment = 'MX HDO / QPJoy HDO mx-h2i';

function evaluate(snapshot, tunnelName = 'mx-h2i', desiredRules = expectedRules) {
  return evaluateWindowsWireGuardNrptStatus({
    tunnelName,
    expectedRules: desiredRules,
    snapshot
  });
}

function rules(comment, nameServers = ['10.88.88.88']) {
  return expectedRules.map((rule) => ({
    namespace: rule.namespace,
    nameServers,
    comment,
    displayName: comment
  }));
}

const ready = evaluate({
  queryPolicy: 'QueryBoth',
  enableDaForAllNetworks: 'EnableAlways',
  rules: rules(currentComment)
});
assert.equal(ready.ready, true);
assert.equal(ready.state, 'ready');
assert.equal(ready.totalOwnedRuleCount, expectedRules.length);
assert.deepEqual(ready.unexpectedOwnedNamespaces, []);
assert.deepEqual(ready.missingNamespaces, []);
assert.deepEqual(ready.mismatchedNamespaces, []);

const globalDisabled = evaluate({
  queryPolicy: 'Disable',
  enableDaForAllNetworks: 'Disable',
  rules: rules(currentComment)
});
assert.equal(globalDisabled.ready, false);
assert.equal(globalDisabled.state, 'global-disabled');
assert.equal(globalDisabled.globalReady, false);

const mismatched = evaluate({
  queryPolicy: 'QueryBoth',
  enableDaForAllNetworks: 'EnableAlways',
  rules: rules(currentComment, ['10.88.0.1'])
});
assert.equal(mismatched.ready, false);
assert.equal(mismatched.state, 'name-server-mismatch');
assert.deepEqual(mismatched.mismatchedNamespaces, expectedRules.map((rule) => rule.namespace));

const exactLegacy = evaluate({
  queryPolicy: 'QueryBoth',
  enableDaForAllNetworks: 'EnableAlways',
  rules: rules(legacyComment)
});
assert.equal(exactLegacy.ready, true);
assert.equal(exactLegacy.state, 'ready');

const foreignConflict = evaluate({
  queryPolicy: 'QueryBoth',
  enableDaForAllNetworks: 'EnableAlways',
  rules: [
    ...rules(currentComment),
    ...rules('Other Product', ['10.88.0.1'])
  ]
});
assert.equal(foreignConflict.ready, false);
assert.equal(foreignConflict.state, 'name-server-mismatch');
assert.deepEqual(foreignConflict.mismatchedNamespaces, expectedRules.map((rule) => rule.namespace));

const compatibleForeign = evaluate({
  queryPolicy: 'QueryBoth',
  enableDaForAllNetworks: 'EnableAlways',
  rules: [
    ...rules(currentComment),
    ...rules('Other Product')
  ]
});
assert.equal(compatibleForeign.ready, true);
assert.equal(compatibleForeign.totalOwnedRuleCount, expectedRules.length);

const legacyAmbiguous = evaluate({
  queryPolicy: 'QueryBoth',
  enableDaForAllNetworks: 'EnableAlways',
  rules: [
    ...rules(currentComment),
    {
      namespace: expectedRules[0].namespace,
      nameServers: expectedRules[0].nameServers,
      comment: '',
      displayName: ''
    }
  ]
});
assert.equal(legacyAmbiguous.ready, false);
assert.equal(legacyAmbiguous.state, 'legacy-ambiguous');
assert.equal(legacyAmbiguous.legacyAmbiguousRuleCount, 1);
assert.deepEqual(legacyAmbiguous.legacyAmbiguousNamespaces, [expectedRules[0].namespace]);
assert.equal(
  legacyAmbiguous.totalOwnedRuleCount,
  expectedRules.length,
  'an untagged compatible rule is ambiguous, not owned'
);
const onlyLegacyAmbiguousAfterDisconnect = evaluate({
  queryPolicy: 'QueryBoth',
  enableDaForAllNetworks: 'EnableAlways',
  rules: [{
    namespace: expectedRules[0].namespace,
    nameServers: expectedRules[0].nameServers,
    comment: '',
    displayName: ''
  }]
});
assert.equal(onlyLegacyAmbiguousAfterDisconnect.ready, false);
assert.equal(onlyLegacyAmbiguousAfterDisconnect.state, 'legacy-ambiguous');
assert.equal(onlyLegacyAmbiguousAfterDisconnect.totalOwnedRuleCount, 0);
assert.equal(onlyLegacyAmbiguousAfterDisconnect.legacyAmbiguousRuleCount, 1);

const safelyMigratableLegacyRules = evaluate({
  queryPolicy: 'QueryBoth',
  enableDaForAllNetworks: 'EnableAlways',
  legacyMigrationAuthorized: true,
  rules: rules('')
});
assert.equal(safelyMigratableLegacyRules.ready, true);
assert.equal(safelyMigratableLegacyRules.legacyMigrationAuthorized, true);
assert.equal(safelyMigratableLegacyRules.legacyAmbiguousRuleCount, 0);
assert.equal(safelyMigratableLegacyRules.totalOwnedRuleCount, expectedRules.length);

const legacyNamespace = 'legacy.mxinfo-inc.cn';
const staleOwnedNamespace = evaluate({
  queryPolicy: 'QueryBoth',
  enableDaForAllNetworks: 'EnableAlways',
  rules: [
    ...rules(currentComment),
    {
      namespace: legacyNamespace,
      nameServers: ['10.88.88.88'],
      comment: legacyComment,
      displayName: legacyComment
    }
  ]
});
assert.equal(staleOwnedNamespace.ready, false);
assert.equal(staleOwnedNamespace.state, 'owned-rules-stale');
assert.equal(staleOwnedNamespace.totalOwnedRuleCount, expectedRules.length + 1);
assert.deepEqual(staleOwnedNamespace.unexpectedOwnedNamespaces, [legacyNamespace]);

const emptyProfileWithOwnedRule = evaluate({
  queryPolicy: 'Disable',
  enableDaForAllNetworks: 'Disable',
  rules: [{
    namespace: legacyNamespace,
    nameServers: ['10.88.88.88'],
    comment: currentComment,
    displayName: currentComment
  }]
}, 'mx-h2i', []);
assert.equal(emptyProfileWithOwnedRule.configured, true);
assert.equal(emptyProfileWithOwnedRule.ready, false);
assert.equal(emptyProfileWithOwnedRule.state, 'owned-rules-stale');
assert.equal(emptyProfileWithOwnedRule.totalOwnedRuleCount, 1);
assert.deepEqual(emptyProfileWithOwnedRule.unexpectedOwnedNamespaces, [legacyNamespace]);

const emptyProfileAfterRemove = evaluate({
  queryPolicy: 'Disable',
  enableDaForAllNetworks: 'Disable',
  rules: [{
    namespace: legacyNamespace,
    nameServers: ['192.0.2.53'],
    comment: 'Other Product',
    displayName: 'Other Product'
  }]
}, 'mx-h2i', []);
assert.equal(emptyProfileAfterRemove.configured, false);
assert.equal(emptyProfileAfterRemove.ready, true);
assert.equal(emptyProfileAfterRemove.state, 'not-configured');
assert.equal(emptyProfileAfterRemove.totalOwnedRuleCount, 0);
assert.deepEqual(emptyProfileAfterRemove.unexpectedOwnedNamespaces, []);

const restoreFailurePending = evaluate({
  queryPolicy: 'QueryBoth',
  enableDaForAllNetworks: 'EnableAlways',
  pendingOwners: [currentComment],
  rules: []
}, 'mx-h2i', []);
assert.equal(restoreFailurePending.ready, false);
assert.equal(restoreFailurePending.state, 'global-restore-pending');
assert.equal(restoreFailurePending.globalRestorePending, true);
assert.equal(restoreFailurePending.totalOwnedRuleCount, 0);

const firstOwnerRemovedWhileSecondRemains = evaluate({
  queryPolicy: 'QueryBoth',
  enableDaForAllNetworks: 'EnableAlways',
  pendingOwners: ['MX-H2I / QPJoy MX-H2I mx-h2i-b'],
  rules: []
}, 'mx-h2i', []);
assert.equal(firstOwnerRemovedWhileSecondRemains.ready, true);
assert.equal(firstOwnerRemovedWhileSecondRemains.state, 'not-configured');
assert.equal(firstOwnerRemovedWhileSecondRemains.globalRestorePending, false);

const hdoExpectedRules = [{ namespace: 'hdo.example', nameServers: ['10.77.77.77'] }];
const hdoScopedUntagged = evaluate({
  queryPolicy: 'QueryBoth',
  enableDaForAllNetworks: 'EnableAlways',
  rules: [
    {
      namespace: 'hdo.example',
      nameServers: ['10.77.77.77'],
      comment: '',
      displayName: ''
    },
    {
      namespace: 'corp.local',
      nameServers: ['192.0.2.53'],
      comment: '',
      displayName: ''
    }
  ]
}, 'hdo-client', hdoExpectedRules);
assert.equal(hdoScopedUntagged.ready, false);
assert.equal(hdoScopedUntagged.state, 'legacy-ambiguous');
assert.equal(hdoScopedUntagged.totalOwnedRuleCount, 0);
assert.equal(hdoScopedUntagged.legacyAmbiguousRuleCount, 1);
assert.deepEqual(hdoScopedUntagged.unexpectedOwnedNamespaces, []);

const hdoLedgerBackedUntagged = evaluate({
  queryPolicy: 'QueryBoth',
  enableDaForAllNetworks: 'EnableAlways',
  legacyMigrationAuthorized: true,
  rules: [{
    namespace: 'hdo.example',
    nameServers: ['10.77.77.77'],
    comment: '',
    displayName: ''
  }]
}, 'hdo-client', hdoExpectedRules);
assert.equal(hdoLedgerBackedUntagged.ready, true);
assert.equal(hdoLedgerBackedUntagged.totalOwnedRuleCount, 1);

const legacyOldDnsAmbiguous = evaluate({
  queryPolicy: 'QueryBoth',
  enableDaForAllNetworks: 'EnableAlways',
  legacyMigrationAuthorized: true,
  rules: [{
    namespace: expectedRules[0].namespace,
    nameServers: ['10.88.0.1'],
    comment: '',
    displayName: ''
  }]
});
assert.equal(legacyOldDnsAmbiguous.ready, false);
assert.equal(legacyOldDnsAmbiguous.state, 'legacy-ambiguous');
assert.equal(legacyOldDnsAmbiguous.totalOwnedRuleCount, 0);
assert.equal(legacyOldDnsAmbiguous.legacyAmbiguousRuleCount, 1);

for (const nonOwnedComment of [
  'MX HDO / QPJoy HDO hdo-client',
  'MX HDO / QPJoy HDO mx-h2i-old'
]) {
  const nonOwned = evaluate({
    queryPolicy: 'QueryBoth',
    enableDaForAllNetworks: 'EnableAlways',
    rules: rules(nonOwnedComment)
  });
  assert.equal(nonOwned.ready, false);
  assert.equal(nonOwned.state, 'rules-missing');
  assert.deepEqual(nonOwned.missingNamespaces, expectedRules.map((rule) => rule.namespace));
}

const singletonSnapshot = evaluate({
  queryPolicy: 'QueryBoth',
  enableDaForAllNetworks: 'EnableAlways',
  rules: {
    namespace: expectedRules[0].namespace,
    nameServers: expectedRules[0].nameServers,
    comment: currentComment,
    displayName: currentComment
  }
});
assert.equal(singletonSnapshot.state, 'rules-missing');
assert.deepEqual(singletonSnapshot.missingNamespaces, [expectedRules[1].namespace]);

async function verifyAsyncLiveProbe() {
  const root = mkdtempSync(join(tmpdir(), 'mx-nrpt-probe-'));
  const powerShellDir = join(root, 'System32', 'WindowsPowerShell', 'v1.0');
  const powerShell = join(powerShellDir, 'powershell.exe');
  const probeScriptCapture = join(root, 'nrpt-probe-command.ps1');
  const configPath = join(root, 'mx-h2i.conf');
  const previousSystemRoot = process.env.SystemRoot;
  mkdirSync(powerShellDir, { recursive: true });
  writeFileSync(configPath, renderWireGuardInterface({
    privateKey: 'private-key',
    addresses: ['10.66.0.2/32'],
    hdoDnsServers: ['10.88.88.88'],
    hdoDnsDomains: ['mxinfo-inc.cn'],
    suppressInterfaceDns: true,
    peers: [{
      publicKey: 'public-key',
      allowedIps: ['10.0.0.0/8'],
      endpoint: '203.0.113.10:51820'
    }]
  }));
  const snapshot = JSON.stringify({
    queryPolicy: 'QueryBoth',
    enableDaForAllNetworks: 'EnableAlways',
    rules: rules(currentComment)
  });
  writeFileSync(
    powerShell,
    `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(probeScriptCapture)}, process.argv.at(-1));\nsetTimeout(() => process.stdout.write(${JSON.stringify(snapshot)}), 120);\n`
  );
  chmodSync(powerShell, 0o755);
  process.env.SystemRoot = root;
  const runtime = { platform: 'win32' };
  try {
    let timerFired = false;
    setTimeout(() => {
      timerFired = true;
    }, 10);
    const pending = getWindowsWireGuardNrptStatus({ runtime, configPath, probeTimeoutMs: 3000 });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(timerFired, true, 'live PowerShell probe must not block the Node event loop');
    const live = await pending;
    assert.equal(live.ready, true, JSON.stringify(live));
    assert.equal(live.state, 'ready');
    const probeScript = readFileSync(probeScriptCapture, 'utf8');
    assert.match(probeScript, /Global\\QPJoy\.MXLauncher\.NRPT\.v1/);
    assert.match(
      probeScript,
      /\$hdoNrptMutex = Enter-HdoNrptMutex[\s\S]*try \{[\s\S]*Get-DnsClientNrptRule[\s\S]*finally \{[\s\S]*Exit-HdoNrptMutex/,
      'the live probe must read rules and shared state under the same machine-wide transaction mutex'
    );

    writeFileSync(configPath, renderWireGuardInterface({
      privateKey: 'private-key',
      addresses: ['10.66.0.2/32'],
      suppressInterfaceDns: true,
      peers: [{
        publicKey: 'public-key',
        allowedIps: ['10.0.0.0/8'],
        endpoint: '203.0.113.10:51820'
      }]
    }));
    const residualSnapshot = JSON.stringify({
      queryPolicy: 'Disable',
      enableDaForAllNetworks: 'Disable',
      rules: [{
        namespace: legacyNamespace,
        nameServers: ['10.88.88.88'],
        comment: legacyComment,
        displayName: legacyComment
      }]
    });
    writeFileSync(
      powerShell,
      `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(residualSnapshot)});\n`
    );
    chmodSync(powerShell, 0o755);
    const residual = await getWindowsWireGuardNrptStatus({ runtime, configPath, probeTimeoutMs: 3000 });
    assert.equal(residual.ready, false, JSON.stringify(residual));
    assert.equal(residual.state, 'owned-rules-stale');
    assert.equal(residual.totalOwnedRuleCount, 1);
    assert.deepEqual(residual.unexpectedOwnedNamespaces, [legacyNamespace]);

    const command = buildWireGuardTunnelCommand({
      runtime: {
        platform: 'win32',
        windowsWireGuard: { command: 'wireguard.exe' }
      },
      configPath,
      action: 'down',
      windowsNrptRules: expectedRules
    });
    const wrapper = readFileSync(command.args.at(-1), 'utf8');
    assert.doesNotMatch(
      wrapper,
      /if \(\$null -eq \$svc\) \{ exit 0 \}/,
      'MX-H2I down must not skip elevated cleanup when the profile has no DNS namespaces'
    );
    const scriptDir = join(root, 'scripts');
    const elevatedName = readdirSync(scriptDir)
      .find((name) => name.includes('.down.') && name.endsWith('.elevated.ps1'));
    assert.ok(elevatedName, 'down command should write an elevated reconciliation script');
    const elevated = readFileSync(join(scriptDir, elevatedName), 'utf8');
    assert.match(elevated, /\$hdoNrptRules = @\(.+mxinfo-inc\.cn/s);
    assert.match(elevated, /\$hdoNrptOwnershipEvidenceComplete = \$false/);
    assert.match(elevated, /function Test-HdoNrptRuleTaggedOwner/);
    assert.match(elevated, /Global\\QPJoy\.MXLauncher\.NRPT\.v1/);
    assert.match(
      elevated,
      /function Remove-HdoNrptRules \{[\s\S]*\$mutex = Enter-HdoNrptMutex[\s\S]*try \{ Remove-HdoNrptRulesUnlocked[\s\S]*finally \{ Exit-HdoNrptMutex \$mutex \}/,
      'remove must serialize its entire NRPT read-modify-write transaction'
    );
    assert.match(
      elevated,
      /function Add-HdoNrptRules \{[\s\S]*\$mutex = Enter-HdoNrptMutex[\s\S]*try \{ Add-HdoNrptRulesUnlocked \} finally \{ Exit-HdoNrptMutex \$mutex \}/,
      'add must serialize baseline save, reconciliation, and rule writes'
    );
    assert.match(elevated, /function Test-HdoNrptRuleLegacyMigrationCandidate/);
    assert.match(
      elevated,
      /Test-HdoNrptRuleNameServers \$Rule \$expected\.NameServers/,
      'untagged migration requires the exact current namespace and name-server set'
    );
    assert.match(elevated, /\$matches = @\(Get-HdoOwnedNrptRules\)/);
    assert.match(elevated, /owned NRPT rules remain after remove/);
    assert.match(elevated, /QPJoy\\NRPT\\global-state\.json/);
    assert.match(
      elevated,
      /\$owners = @\(\$owners \+ \$hdoNrptComment \| Sort-Object -Unique\)/,
      'each owner must join the shared state without replacing the first-owner baseline'
    );
    assert.match(
      elevated,
      /if \(\$remainingOwners\.Count -gt 0\)[\s\S]*Write-HdoNrptGlobalState \$queryPolicy \$enableAllText \$remainingOwners[\s\S]*nrpt restore deferred remainingOwners=/,
      'disconnecting either owner first must preserve the baseline for the remaining owner'
    );
    assert.match(
      elevated,
      /\$otherLegacyOwnerKeys = @\(Get-ChildItem[\s\S]*Test-HdoLegacyStateOwnerActive \(\$_.FullName\)/,
      'only a legacy state file backed by a live exact tunnel service may defer global restore'
    );
    assert.match(
      elevated,
      /\$owner\.StartsWith\('legacy-state:'[\s\S]*Test-HdoLegacyStateOwnerActive \(\$owner\.Substring\(13\)\)/,
      'a legacy owner handoff must converge after its exact tunnel service disappears'
    );
    assert.match(
      elevated,
      /\$otherQpjoyOwnerTags = @\([\s\S]*\$owner -match '\^MX[\s\S]*\$keep = \$otherQpjoyOwnerTags -contains \$owner/,
      'a normal shared-state owner tag may defer global restore only while an exact live NRPT rule still carries that tag'
    );
    const restoreFunction = elevated.slice(
      elevated.indexOf('function Restore-HdoNrptGlobalQueryPolicy'),
      elevated.indexOf('function Get-HdoNormalizedNameServers')
    );
    assert.ok(
      restoreFunction.indexOf('$otherQpjoyOwnerTags = @(') < restoreFunction.indexOf('$remainingOwners = @('),
      'live owner tags must be captured before stale shared-state owners are filtered'
    );
    assert.match(elevated, /Get-Content -Path \$hdoNrptLegacyGlobalStatePath/);
    assert.doesNotMatch(
      elevated.slice(
        elevated.indexOf('function Get-HdoLegacyNrptGlobalState'),
        elevated.indexOf('function Test-HdoLegacyStateOwnerActive')
      ),
      /Get-ChildItem/,
      'a product must never adopt another product legacy baseline'
    );
    assert.match(
      elevated,
      /Write-HdoNrptGlobalState \$queryPolicy \$enableAllText \$remainingOwners[\s\S]*if \(Test-Path \$hdoNrptLegacyGlobalStatePath[\s\S]*Remove-Item -Path \$hdoNrptLegacyGlobalStatePath/,
      'the shared handoff must read back successfully before retiring the disconnecting owner legacy state'
    );
    const restoreStart = elevated.indexOf('function Restore-HdoNrptGlobalQueryPolicy');
    const restoreReadBack = elevated.indexOf('$verified = Get-DnsClientNrptGlobal -ErrorAction Stop', restoreStart);
    const restoreStateDelete = elevated.indexOf('Remove-Item -Path $hdoNrptGlobalStatePath', restoreStart);
    assert.ok(restoreReadBack > restoreStart, 'global restore must read back the applied baseline');
    assert.ok(
      restoreStateDelete > restoreReadBack,
      'global baseline state must survive until restore read-back succeeds'
    );
    const restoreBlock = restoreFunction;
    assert.doesNotMatch(
      restoreBlock,
      /if \(\$otherRules\.Count -gt 0\)/,
      'foreign corporate NRPT rules must not prevent the last MX owner from restoring its baseline'
    );
    assert.doesNotMatch(
      restoreBlock,
      /Set-DnsClientNrptGlobal[^\r\n]*-ErrorAction SilentlyContinue/,
      'global restore failure must be observable'
    );

    const removedSnapshot = JSON.stringify({
      queryPolicy: 'Disable',
      enableDaForAllNetworks: 'Disable',
      rules: [{
        namespace: legacyNamespace,
        nameServers: ['192.0.2.53'],
        comment: 'Other Product',
        displayName: 'Other Product'
      }]
    });
    writeFileSync(
      powerShell,
      `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(removedSnapshot)});\n`
    );
    chmodSync(powerShell, 0o755);
    const removed = await getWindowsWireGuardNrptStatus({ runtime, configPath, probeTimeoutMs: 3000 });
    assert.equal(removed.ready, true, JSON.stringify(removed));
    assert.equal(removed.state, 'not-configured');
    assert.equal(removed.totalOwnedRuleCount, 0);

    const pendingRestoreSnapshot = JSON.stringify({
      queryPolicy: 'QueryBoth',
      enableDaForAllNetworks: 'EnableAlways',
      pendingOwners: [currentComment],
      rules: []
    });
    writeFileSync(
      powerShell,
      `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(pendingRestoreSnapshot)});\n`
    );
    chmodSync(powerShell, 0o755);
    const pendingRestore = await getWindowsWireGuardNrptStatus({
      runtime,
      configPath,
      probeTimeoutMs: 3000
    });
    assert.equal(pendingRestore.ready, false, JSON.stringify(pendingRestore));
    assert.equal(pendingRestore.state, 'global-restore-pending');
    assert.equal(pendingRestore.globalRestorePending, true);

    rmSync(configPath);
    writeFileSync(
      powerShell,
      `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(removedSnapshot)});\n`
    );
    chmodSync(powerShell, 0o755);
    const missingProfileNrpt = await getWindowsWireGuardNrptStatus({
      runtime,
      configPath,
      probeTimeoutMs: 3000
    });
    assert.equal(missingProfileNrpt.ready, true, JSON.stringify(missingProfileNrpt));
    assert.equal(missingProfileNrpt.state, 'not-configured');
    assert.equal(missingProfileNrpt.tunnelName, 'mx-h2i');
    assert.equal(missingProfileNrpt.totalOwnedRuleCount, 0);

    writeFileSync(
      powerShell,
      `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify({
          queryPolicy: 'QueryBoth',
          enableDaForAllNetworks: 'EnableAlways',
          legacyMigrationAuthorized: true,
          rules: rules('')
        }))});\n`
    );
    chmodSync(powerShell, 0o755);
    const missingProfileAmbiguousNrpt = await getWindowsWireGuardNrptStatus({
      runtime,
      configPath,
      probeTimeoutMs: 3000
    });
    assert.equal(missingProfileAmbiguousNrpt.ready, false, JSON.stringify(missingProfileAmbiguousNrpt));
    assert.equal(missingProfileAmbiguousNrpt.state, 'global-restore-pending');
    assert.equal(missingProfileAmbiguousNrpt.totalOwnedRuleCount, 0);

    const missingProfileLegacyNrpt = await getWindowsWireGuardNrptStatus({
      runtime,
      configPath,
      probeTimeoutMs: 3000,
      expectedRules
    });
    assert.equal(missingProfileLegacyNrpt.ready, true, JSON.stringify(missingProfileLegacyNrpt));
    assert.equal(missingProfileLegacyNrpt.totalOwnedRuleCount, expectedRules.length);
    assert.equal(missingProfileLegacyNrpt.legacyMigrationAuthorized, true);

    const scriptsBeforeMissingProfileDown = new Set(readdirSync(join(root, 'scripts')));
    const missingProfileDown = buildWireGuardTunnelCommand({
      runtime: {
        platform: 'win32',
        windowsWireGuard: { command: 'wireguard.exe' }
      },
      configPath,
      action: 'down',
      windowsNrptRules: expectedRules
    });
    assert.match(missingProfileDown.displayCommand, /wireguard-uac-wrapper/);
    const missingProfileElevatedName = readdirSync(join(root, 'scripts'))
      .find((name) => (
        !scriptsBeforeMissingProfileDown.has(name)
        && name.includes('.down.')
        && name.endsWith('.elevated.ps1')
      ));
    assert.ok(missingProfileElevatedName, 'missing-profile down must still generate an elevated cleanup script');
    const missingProfileElevated = readFileSync(
      join(root, 'scripts', missingProfileElevatedName),
      'utf8'
    );
    assert.match(missingProfileElevated, /\$hdoNrptRules = @\(.+mxinfo-inc\.cn/s);
    assert.match(missingProfileElevated, /Remove-HdoNrptRules/);
    assert.match(missingProfileElevated, /\/uninstalltunnelservice/);
    assert.match(
      missingProfileElevated,
      /ownership evidence is incomplete and untagged NRPT rules are ambiguous; refusing to delete rollback evidence/i
    );
    assert.match(missingProfileElevated, /\$hdoNrptOwnershipEvidenceComplete = \$false/);

    const missingProfileMachineSnapshot = JSON.stringify({
      serviceState: 'NOT_FOUND',
      adapters: [],
      routes: []
    });
    writeFileSync(
      powerShell,
      `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(missingProfileMachineSnapshot)});\n`
    );
    chmodSync(powerShell, 0o755);
    const missingProfileTunnel = getWindowsWireGuardTunnelStatusByName({
      runtime: {
        platform: 'win32',
        method: 'windows-service'
      },
      configPath
    });
    assert.equal(missingProfileTunnel.ok, true, JSON.stringify(missingProfileTunnel));
    assert.equal(missingProfileTunnel.active, false);
    assert.equal(missingProfileTunnel.serviceState, 'NOT_FOUND');
    assert.equal(missingProfileTunnel.interfaceName, 'mx-h2i');

    const residualAdapterSnapshot = JSON.stringify({
      serviceState: 'NOT_FOUND',
      adapters: ['mx-h2i|if=42|status=Disconnected'],
      routes: ['10.0.0.0/8|if=42|nextHop=0.0.0.0']
    });
    writeFileSync(
      powerShell,
      `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(residualAdapterSnapshot)});\n`
    );
    chmodSync(powerShell, 0o755);
    const residualAdapterTunnel = getWindowsWireGuardTunnelStatusByName({
      runtime: {
        platform: 'win32',
        method: 'windows-service'
      },
      configPath
    });
    assert.equal(residualAdapterTunnel.ok, true);
    assert.equal(residualAdapterTunnel.active, false);
    assert.match(residualAdapterTunnel.ifconfig, /mx-h2i/);
    assert.equal(residualAdapterTunnel.routes.length, 1);

    writeFileSync(powerShell, '#!/usr/bin/env node\nsetTimeout(() => {}, 1000);\n');
    chmodSync(powerShell, 0o755);
    const startedAt = Date.now();
    const timedOut = await getWindowsWireGuardNrptStatus({
      runtime,
      configPath,
      probeTimeoutMs: 50
    });
    assert.equal(timedOut.ready, false);
    assert.equal(timedOut.state, 'probe-failed');
    assert.ok(Date.now() - startedAt < 600, 'NRPT probe timeout should be bounded');
  } finally {
    if (previousSystemRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = previousSystemRoot;
    rmSync(root, { recursive: true, force: true });
  }
}

verifyAsyncLiveProbe()
  .then(() => console.log('windows NRPT live-status smoke passed'))
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
