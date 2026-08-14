import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('../renderer.js', import.meta.url)), 'utf8');

function functionSource(name) {
  const syncStart = source.indexOf(`function ${name}(`);
  const asyncStart = source.indexOf(`async function ${name}(`);
  const start = syncStart >= 0 ? syncStart : asyncStart;
  assert.ok(start >= 0, `${name} must exist`);
  const bodyStart = source.indexOf('{', source.indexOf(')', start));
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`${name} is not balanced`);
}

const accessActionState = Function(`
function asArray(value) { return Array.isArray(value) ? value : []; }
${functionSource('uniqueStringList')}
${functionSource('userOverseaAccessActionState')}
return userOverseaAccessActionState;
`)();

assert.deepEqual(
  accessActionState([], []),
  { updateDisabled: true, updateLabel: 'Select a site', disableDisabled: true },
  'a disabled user must be prompted to select a site, not offered a misleading Disable action'
);
assert.deepEqual(
  accessActionState([], ['mx-oversea-jp01']),
  { updateDisabled: false, updateLabel: 'Enable Access (1)', disableDisabled: true },
  'selecting JP01 must expose a clear re-enable action'
);
assert.deepEqual(
  accessActionState(['mx-oversea-hk01'], ['mx-oversea-jp01']),
  { updateDisabled: false, updateLabel: 'Update Access (1)', disableDisabled: false },
  'an active assignment can be updated explicitly'
);
assert.deepEqual(
  accessActionState(['mx-oversea-hk01'], []),
  { updateDisabled: true, updateLabel: 'Select a site', disableDisabled: false },
  'unchecking every site cannot silently turn Update into a destructive action'
);

const authoritySites = Function(`
const state = {
  overseaOverview: {
    sites: [
      { siteId: 'mx-oversea-jp01', status: 'installed' },
      { siteId: 'mx-oversea-hk01', status: 'archived' },
      { siteId: 'oversea-sg-1', status: 'installed', archived: true },
      { siteId: 'oversea-draft', status: 'needs-ssh-profile' }
    ]
  },
  dashboard: { siteSlotPipelines: [{ kind: 'oversea', siteId: 'mx-oversea-hk01' }] }
};
function asArray(value) { return Array.isArray(value) ? value : []; }
${functionSource('uniqueStringList')}
${functionSource('overseaAuthoritySites')}
return overseaAuthoritySites;
`)();
assert.deepEqual(authoritySites(), ['mx-oversea-jp01'], 'only an installed, non-archived site is an access-assignment target');

const migrationSites = Function(`
const state = {
  userCenter: {
    overseaEntitlements: [
      { siteIds: ['mx-oversea-hk01'] },
      { siteIds: ['mx-oversea-hk01', 'mx-oversea-jp01'] }
    ]
  }
};
function asArray(value) { return Array.isArray(value) ? value : []; }
${functionSource('uniqueStringList')}
${functionSource('overseaMigrationSourceSiteIds')}
${functionSource('overseaMigrationTargetSiteIds')}
return {
  sources: overseaMigrationSourceSiteIds,
  targets: overseaMigrationTargetSiteIds
};
`)();
const onlyLiveJp = [{ siteId: 'mx-oversea-jp01', status: 'installed' }];
assert.deepEqual(
  migrationSites.sources(onlyLiveJp),
  ['mx-oversea-hk01', 'mx-oversea-jp01'],
  'a stopped HK01 remains a migration source through its Internal entitlements'
);
assert.deepEqual(
  migrationSites.targets(onlyLiveJp),
  ['mx-oversea-jp01'],
  'only the passing live JP01 is offered as a migration target'
);

const renderMigration = Function(`
const state = {
  selectedSiteId: 'mx-oversea-jp01',
  overseaMigration: {},
  userCenter: {
    overseaEntitlements: [{ userId: 'user-a', siteIds: ['mx-oversea-hk01'], accounts: [] }]
  }
};
function asArray(value) { return Array.isArray(value) ? value : []; }
function escapeHtml(value) { return String(value ?? ''); }
${functionSource('uniqueStringList')}
${functionSource('overseaMigrationTargetSyncSummary')}
${functionSource('overseaMigrationSourceUserIds')}
${functionSource('overseaMigrationTargetSyncProofValid')}
${functionSource('renderOverseaMigration')}
return renderOverseaMigration;
`)();
const defaultAlreadyJp = renderMigration(
  ['mx-oversea-hk01', 'mx-oversea-jp01'],
  ['mx-oversea-jp01'],
  'mx-oversea-jp01'
);
assert.match(
  defaultAlreadyJp,
  /data-oversea-migrate-from[\s\S]*?value="mx-oversea-hk01" selected/,
  'setting JP01 as the new default must not reverse the migration source and target'
);
assert.match(
  defaultAlreadyJp,
  /data-oversea-migrate-to[\s\S]*?value="mx-oversea-jp01" selected/,
  'the selected installed JP01 remains the migration target after Set Default'
);

const migrationSyncSummary = Function(`
const state = {
  userCenter: {
    overseaEntitlements: [
      {
        siteIds: ['mx-oversea-hk01', 'mx-oversea-jp01'],
        accounts: [{ siteId: 'mx-oversea-jp01', status: 'active', runtimeSync: { status: 'synced' } }]
      },
      {
        siteIds: ['mx-oversea-hk01', 'mx-oversea-jp01'],
        accounts: [{ siteId: 'mx-oversea-jp01', status: 'active', runtimeSync: { status: 'pending-sync' } }]
      },
      { siteIds: ['unrelated'], accounts: [] }
    ]
  }
};
function asArray(value) { return Array.isArray(value) ? value : []; }
${functionSource('overseaMigrationTargetSyncSummary')}
return overseaMigrationTargetSyncSummary;
`)();
assert.deepEqual(
  migrationSyncSummary('mx-oversea-hk01', 'mx-oversea-jp01'),
  { total: 2, synced: 1, ready: false },
  'Cut Over stays locked until every source user is synced on JP01'
);

const targetSyncProofValid = Function(`
function asArray(value) { return Array.isArray(value) ? value : []; }
${functionSource('uniqueStringList')}
${functionSource('overseaMigrationTargetSyncProofValid')}
return overseaMigrationTargetSyncProofValid;
`)();
const proofNow = Date.parse('2026-08-14T17:30:00.000Z');
const sourceUserIds = ['user-a', 'user-b'];
const validProof = {
  targetSyncProof: {
    status: 'passed',
    fromSiteId: 'mx-oversea-hk01',
    toSiteId: 'mx-oversea-jp01',
    userIds: ['user-b', 'user-a'],
    passedAt: proofNow - 60_000
  }
};
assert.equal(
  targetSyncProofValid(validProof, 'mx-oversea-hk01', 'mx-oversea-jp01', sourceUserIds, proofNow),
  true,
  'a fresh proof for the exact pair and source-user set unlocks Cut Over'
);
assert.equal(
  targetSyncProofValid({}, 'mx-oversea-hk01', 'mx-oversea-jp01', sourceUserIds, proofNow),
  false,
  'historical runtime sync without a page-local proof never unlocks Cut Over'
);
assert.equal(
  targetSyncProofValid({
    targetSyncProof: { ...validProof.targetSyncProof, passedAt: proofNow - (15 * 60 * 1000) - 1 }
  }, 'mx-oversea-hk01', 'mx-oversea-jp01', sourceUserIds, proofNow),
  false,
  'a proof older than the freshness window is rejected'
);
assert.equal(
  targetSyncProofValid(validProof, 'other-source', 'mx-oversea-jp01', sourceUserIds, proofNow),
  false,
  'a proof cannot be reused for a different source/target pair'
);
assert.equal(
  targetSyncProofValid(validProof, 'mx-oversea-hk01', 'other-target', sourceUserIds, proofNow),
  false,
  'a proof cannot be reused for a different target'
);
assert.equal(
  targetSyncProofValid(validProof, 'mx-oversea-hk01', 'mx-oversea-jp01', ['user-a'], proofNow),
  false,
  'a proof is invalid as soon as the source-user set changes'
);

const openDrawer = functionSource('openUserEditorDrawer');
assert.match(openDrawer, /overseaSiteIds: user \? asArray\(entitlement\?\.siteIds\) : \[\]/, 'drawer persists access choices before async metadata loads');
assert.match(functionSource('renderUserOverseaEditor'), /state\.userCenter\.drawer\.overseaSiteIds/, 'drawer re-renders from the unsaved access draft');
assert.match(functionSource('bindUserEditorDrawerControls'), /\[data-oversea-site\][\s\S]*?updateUserOverseaAccessActions/, 'checkbox changes refresh the access action state');
assert.match(functionSource('disableUserOverseaFromAdmin'), /window\.confirm[\s\S]*?siteIds: \[\]/, 'Disable Access is separate and requires confirmation');

const migration = functionSource('runOverseaMigration');
assert.match(migration, /const mode = migration\.mode === 'replace' \? 'replace' : 'add'/, 'safe Add Target is the default migration phase');
assert.match(migration, /mode,\s*confirm:/, 'the selected migration phase reaches the existing API');
assert.match(migration, /userIds: confirm \? previewUserIds : undefined/, 'Apply is frozen to the users shown by Preview');
assert.doesNotMatch(migration, /mode: 'replace'/, 'migration is no longer hard-coded to immediate cutover');
assert.match(
  migration,
  /result\?\.applied && mode === 'add'\) migration\.targetSyncProof = null/,
  'Add Target clears any earlier proof because it changes the source-user account material'
);
assert.match(functionSource('renderOverseaMigration'), /data-oversea-migrate-sync-target/, 'migration can sync its target without a shell command');
assert.match(functionSource('syncOverseaMigrationTarget'), /await ensureSelectedOversea\(\)/, 'Sync Target reuses the normal Oversea Install\/Sync path');
assert.match(
  functionSource('renderOverseaWorkbench'),
  /field !== 'mode'\) state\.overseaMigration\.targetSyncProof = null/,
  'changing or losing either site invalidates a proof captured for the old pair'
);

const isolatedSources = [
  functionSource('runOverseaMigration'),
  functionSource('syncOverseaMigrationTarget'),
  functionSource('assignUserOverseaFromAdmin'),
  functionSource('disableUserOverseaFromAdmin')
].join('\n');
assert.doesNotMatch(
  isolatedSources,
  /domestic-wg|internal-service-peer|host-runner|materialize-domestic/i,
  'Oversea entitlement and migration UI never calls a Domestic/Internal WG mutation'
);

console.log('OK Oversea access can be re-enabled and migrations stay two-phase, preview-scoped, and WG-isolated');
