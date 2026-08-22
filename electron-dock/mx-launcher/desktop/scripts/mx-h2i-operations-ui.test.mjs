import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const rendererSource = readFileSync(fileURLToPath(new URL('../renderer.js', import.meta.url)), 'utf8');
const stylesSource = readFileSync(fileURLToPath(new URL('../styles.css', import.meta.url)), 'utf8');
const indexSource = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
const packageSource = readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8');

assert.match(rendererSource, /const MX_H2I_TOPOLOGY_CLIENT_LIMIT = 8;/);
assert.match(rendererSource, /const MX_H2I_LEASE_PAGE_SIZE = 100;/);
assert.match(rendererSource, /const LAUNCHER_NETWORK_LEASE_TTL_MS = 180 \* 24 \* 60 \* 60 \* 1000;/);

function functionSource(source, name) {
  const candidates = [`async function ${name}(`, `function ${name}(`];
  const start = candidates
    .map((prefix) => source.indexOf(prefix))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];
  assert.ok(Number.isInteger(start), `${name} must exist`);
  const parametersStart = source.indexOf('(', start);
  let parametersDepth = 0;
  let parametersEnd = -1;
  for (let index = parametersStart; index < source.length; index += 1) {
    if (source[index] === '(') parametersDepth += 1;
    if (source[index] === ')') parametersDepth -= 1;
    if (parametersDepth === 0) {
      parametersEnd = index;
      break;
    }
  }
  const bodyStart = source.indexOf('{', parametersEnd);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`${name} is not balanced`);
}

const normalizePolicy = Function(
  'MX_H2I_PRODUCT_ID',
  `${functionSource(rendererSource, 'anonymousEnrollmentPolicyForProduct')}
${functionSource(rendererSource, 'anonymousUiVisibilityForProduct')}
return { anonymousEnrollmentPolicyForProduct, anonymousUiVisibilityForProduct };`
)('mx-h2i');

assert.equal(normalizePolicy.anonymousEnrollmentPolicyForProduct({ productId: 'mx-h2i' }), 'enabled');
assert.equal(normalizePolicy.anonymousUiVisibilityForProduct({ productId: 'mx-h2i' }), 'advanced');
assert.equal(normalizePolicy.anonymousUiVisibilityForProduct({ productId: 'luopan' }), 'primary');
assert.equal(normalizePolicy.anonymousEnrollmentPolicyForProduct({ anonymousEnrollmentPolicy: 'drain' }), 'drain');
assert.equal(normalizePolicy.anonymousUiVisibilityForProduct({ anonymousUiVisibility: 'hidden' }), 'hidden');

const leaseObservation = Function(
  `${functionSource(rendererSource, 'mxH2iLeaseSourceIp')}
${functionSource(rendererSource, 'mxH2iLeaseObservedAt')}
${functionSource(rendererSource, 'mxH2iLeaseRecordUpdatedAt')}
return { mxH2iLeaseSourceIp, mxH2iLeaseObservedAt, mxH2iLeaseRecordUpdatedAt };`
)();
assert.equal(leaseObservation.mxH2iLeaseSourceIp({ sourceIp: '203.0.113.7' }), '203.0.113.7');
assert.equal(leaseObservation.mxH2iLeaseSourceIp({}), 'not recorded');
assert.equal(leaseObservation.mxH2iLeaseObservedAt({ updatedAt: '2026-01-01T00:00:00Z' }), null, 'record updates are not invented as last-seen telemetry');
assert.equal(leaseObservation.mxH2iLeaseRecordUpdatedAt({ updatedAt: '2026-01-01T00:00:00Z' }), '2026-01-01T00:00:00Z');

const leaseLooksGeneratedBySmoke = Function(
  `${functionSource(rendererSource, 'leaseLooksGeneratedBySmoke')}
return leaseLooksGeneratedBySmoke;`
)();
assert.equal(
  leaseLooksGeneratedBySmoke({ deviceId: 'dev_mx_h2i_4a6d28', installId: 'inst_mx_h2i_a2f904' }),
  false,
  'real MX-H2I runtime IDs must remain visible in operations'
);
assert.equal(leaseLooksGeneratedBySmoke({ deviceId: 'desktop-admin-smoke-1' }), true);
assert.equal(leaseLooksGeneratedBySmoke({ installId: 'http-smoke-mx-h2i' }), true);

const activeClientRecord = Function(
  'LAUNCHER_NETWORK_LEASE_TTL_MS',
  `function launcherLeaseIsStandalone(lease) { return lease?.launcherMode !== 'embed'; }
function leaseLooksGeneratedBySmoke(lease) { return lease?.smoke === true; }
${functionSource(rendererSource, 'launcherLeaseIsActiveClientRecord')}
return launcherLeaseIsActiveClientRecord;`
)(180 * 24 * 60 * 60 * 1000);
const activeNow = new Date('2026-08-22T00:00:00.000Z');
const baseActiveLease = { launcherMode: 'standalone', leaseId: 'lease-1', leaseIp: '10.89.0.1', status: 'active' };
assert.equal(activeClientRecord({ ...baseActiveLease, expiresAt: '2026-08-23T00:00:00.000Z' }, activeNow), true);
assert.equal(activeClientRecord({ ...baseActiveLease, expiresAt: '2026-08-21T00:00:00.000Z' }, activeNow), false, 'expired leases are excluded even when status remains active');
assert.equal(activeClientRecord({ ...baseActiveLease, updatedAt: '2026-08-21T00:00:00.000Z' }, activeNow), true, 'legacy leases use the 180-day update fallback');
assert.equal(activeClientRecord({ ...baseActiveLease, updatedAt: '2026-01-01T00:00:00.000Z' }, activeNow), false, 'legacy leases older than the 180-day fallback are excluded');
assert.equal(activeClientRecord({ ...baseActiveLease, createdAt: '2026-08-20T00:00:00.000Z' }, activeNow), true, 'createdAt is the final legacy TTL fallback');
assert.equal(activeClientRecord(baseActiveLease, activeNow), true, 'fully legacy timestamps retain server compatibility');
assert.equal(activeClientRecord({ ...baseActiveLease, status: 'released' }, activeNow), false);

const leasePaginator = Function(
  'MX_H2I_LEASE_PAGE_SIZE',
  `function asArray(value) { return Array.isArray(value) ? value : []; }
${functionSource(rendererSource, 'mxH2iLeaseIdentityGroup')}
${functionSource(rendererSource, 'mxH2iLeaseIdentityLabel')}
${functionSource(rendererSource, 'mxH2iLeaseSubject')}
${functionSource(rendererSource, 'mxH2iLeaseSourceIp')}
${functionSource(rendererSource, 'mxH2iLeaseDevice')}
${functionSource(rendererSource, 'mxH2iLeasePlatform')}
${functionSource(rendererSource, 'mxH2iLeaseSearchText')}
${functionSource(rendererSource, 'mxH2iLeasePage')}
return mxH2iLeasePage;`
)(100);
const leaseInventory = Array.from({ length: 250 }, (_, index) => ({
  leaseId: `lease-${index}`,
  leaseIp: `10.89.${index % 200}.${index + 1}`,
  identityKind: index % 2 ? 'anonymous' : 'user',
  userId: `employee-${index}`,
  deviceId: `device-${index}`,
  sourceIp: `203.0.113.${index + 1}`
}));
const firstLeasePage = leasePaginator(leaseInventory, { identity: 'all', page: 1 });
assert.equal(firstLeasePage.rows.length, 100, 'only one 100-row DOM window is prepared');
assert.equal(firstLeasePage.filteredCount, 250);
assert.equal(firstLeasePage.totalCount, 250);
assert.equal(firstLeasePage.totalPages, 3);
const anonymousLeasePage = leasePaginator(leaseInventory, { identity: 'anonymous', page: 2 });
assert.equal(anonymousLeasePage.filteredCount, 125, 'identity filtering covers the complete inventory');
assert.equal(anonymousLeasePage.rows.length, 25);
const tailSearchPage = leasePaginator(leaseInventory, { query: '203.0.113.250', identity: 'all', page: 1 });
assert.equal(tailSearchPage.filteredCount, 1, 'search reaches records beyond the first rendered page');
assert.equal(tailSearchPage.rows[0].leaseId, 'lease-249');

const topologyGraph = Function(
  'MX_H2I_TOPOLOGY_CLIENT_LIMIT',
  `function asArray(value) { return Array.isArray(value) ? value : []; }
${functionSource(rendererSource, 'mxH2iLeaseIdentityGroup')}
${functionSource(rendererSource, 'mxH2iLeaseDevice')}
${functionSource(rendererSource, 'mxH2iTopologyGraph')}
return mxH2iTopologyGraph;`
)(8);
const graph = topologyGraph(Array.from({ length: 20 }, (_, index) => ({
  leaseId: `lease-${index}`,
  leaseIp: `10.89.0.${index + 1}`,
  identityKind: index % 2 ? 'anonymous' : 'user',
  deviceId: `device-${index}`
})));
assert.equal(graph.nodes.filter((node) => node.id.startsWith('client:')).length, 8, '3D client nodes are capped');
assert.equal(graph.nodes.length, 10, 'the capped client nodes plus Domestic and Internal are the complete graph');
assert.equal(graph.omitted, 12);
assert.ok(graph.links.some((link) => link.from === 'domestic' && link.to === 'internal'));
assert.ok(graph.links.filter((link) => link.from.startsWith('client:')).every((link) => link.to === 'domestic'));
assert.doesNotMatch(JSON.stringify(graph), /oversea/i);

const operationsSource = functionSource(rendererSource, 'renderMxH2iOperationsScreen');
assert.match(operationsSource, /Static lease ≠ real-time online/);
assert.match(operationsSource, /sourceIp is the most recent enrollment or renewal HTTP source IP, not a WireGuard endpoint/);
assert.match(operationsSource, /Last seen \/ record/);
assert.match(operationsSource, /renderMxH2iTopologyFallback\(activeLeases, product\)/);
assert.match(operationsSource, /data-mx-h2i-lease-query/);
assert.match(operationsSource, /data-mx-h2i-lease-identity/);
assert.match(operationsSource, /mxH2iLeasePage\(activeLeases, state\.mxH2iLeaseFilter\)/);
assert.match(operationsSource, /leasePage\.rows\.map/);
assert.match(operationsSource, /data-mx-h2i-lease-page="previous"/);
assert.match(operationsSource, /data-mx-h2i-lease-page="next"/);
assert.match(operationsSource, /renderMxH2iBlockedUsersPanel\(\)/);
assert.match(operationsSource, /Lease inventory is unavailable, so no topology is inferred or rendered/);
assert.match(operationsSource, /DATA UNAVAILABLE/);
assert.match(operationsSource, /renderStandaloneAnonymousPolicy\(product/);
assert.doesNotMatch(operationsSource, /online clients|online leases/i);

const policyCardSource = functionSource(rendererSource, 'renderStandaloneAnonymousPolicy');
assert.match(policyCardSource, /data-standalone-anonymous-policy-product/);
assert.match(policyCardSource, /data-standalone-anonymous-policy-save/);
assert.match(policyCardSource, /Embed apps inherit their standalone channel and cannot edit its policy from an embed detail/);
assert.match(policyCardSource, /only a capability-authenticated existing anonymous lease may renew/);
assert.match(policyCardSource, /does not release leases, delete peers, disconnect clients, or alter employee enrollment/);

const renderPolicyCard = Function(
  'MX_H2I_PRODUCT_ID',
  'state',
  `function normalizeLauncherProductId(value) { return String(value || '').trim().toLowerCase(); }
function launcherProductDisplayName(productId, product) { return product?.displayName || productId; }
function escapeHtml(value) { return String(value ?? ''); }
${functionSource(rendererSource, 'anonymousEnrollmentPolicyForProduct')}
${functionSource(rendererSource, 'anonymousUiVisibilityForProduct')}
${policyCardSource}
return renderStandaloneAnonymousPolicy;`
)('mx-h2i', { anonymousPolicyBusyProductId: null, anonymousPolicyFeedback: null });
const luopanPolicyCard = renderPolicyCard({ productId: 'luopan', displayName: 'Luopan' });
assert.match(luopanPolicyCard, /data-standalone-anonymous-policy-product="luopan"/);
assert.match(luopanPolicyCard, /value="primary" selected/);
assert.match(luopanPolicyCard, /Save Luopan policy/);
assert.doesNotMatch(luopanPolicyCard, /MX-H2I default/);
const mxH2iPolicyCard = renderPolicyCard({ productId: 'mx-h2i', displayName: 'MX-H2I' });
assert.match(mxH2iPolicyCard, /value="advanced" selected/);

const selectedDetailSource = functionSource(rendererSource, 'renderSelectedAppDetail');
const disposeIndex = selectedDetailSource.indexOf('disposeMxH2iTopology();');
const replaceIndex = selectedDetailSource.indexOf('appSelectedDetail.innerHTML =');
assert.ok(disposeIndex >= 0 && disposeIndex < replaceIndex, 'old dynamic Three resources are disposed before innerHTML replacement');
assert.match(selectedDetailSource, /state\.mxH2iSurface === 'dashboard'/);
assert.match(selectedDetailSource, /appSelectedDetail\.innerHTML = renderMxH2iDashboard\(product, leases\)/);
assert.match(selectedDetailSource, /bindMxH2iDashboardControls\(appSelectedDetail, leases\)/);
assert.match(selectedDetailSource, /app\.appId === MX_H2I_PRODUCT_ID[\s\S]*launcherLeaseIsActiveClientRecord\(lease\)/);
assert.match(selectedDetailSource, /mode === 'standalone' && app\.appId !== MX_H2I_PRODUCT_ID[\s\S]*renderStandaloneAnonymousPolicy\(product\)/);
assert.match(selectedDetailSource, /if \(mode === 'standalone'\) bindStandaloneAnonymousPolicyControls/);

const dashboardSource = functionSource(rendererSource, 'renderMxH2iDashboard');
assert.match(dashboardSource, /MX-H2I Control Room/);
assert.match(dashboardSource, /data-mx-h2i-anonymous-quick-request/);
assert.match(dashboardSource, /Luopan remains unchanged/);
assert.match(dashboardSource, /Existing leases and WireGuard peers are not removed/);
assert.match(dashboardSource, /launcherProductById\(MX_H2I_PRODUCT_ID\)/);
assert.match(dashboardSource, /productDataAvailable/);
assert.match(dashboardSource, /leaseDataAvailable/);
assert.match(dashboardSource, /Anonymous policy unavailable/);
const dashboardBindingSource = functionSource(rendererSource, 'bindMxH2iDashboardControls');
const canvasIndex = dashboardBindingSource.indexOf("root.querySelector('[data-mx-h2i-topology-canvas]')");
const initIndex = dashboardBindingSource.indexOf('initMxH2iTopology(root, leases)');
assert.ok(canvasIndex >= 0 && initIndex > canvasIndex, 'the dedicated dashboard initializes Three only after resolving its canvas');

const blockedPanelSource = functionSource(rendererSource, 'renderMxH2iBlockedUsersPanel');
assert.match(blockedPanelSource, /data-mx-h2i-blocked-user-open/);
assert.match(blockedPanelSource, /Luopan unaffected/);
assert.match(blockedPanelSource, /inventoryAvailable/);
const operationsBindingSource = functionSource(rendererSource, 'bindMxH2iOperationsControls');
assert.match(operationsBindingSource, /openMxH2iLeaseDrawer/);
assert.match(operationsBindingSource, /openMxH2iBlockedUserDrawer/);

const leaseRowSource = functionSource(rendererSource, 'renderMxH2iLeaseTableRow');
assert.match(leaseRowSource, /data-mx-h2i-lease-open/);
assert.match(leaseRowSource, /tabindex="0"/);

const leaseDrawerSource = functionSource(rendererSource, 'renderMxH2iLeaseDrawer');
assert.match(leaseDrawerSource, /Lease record ≠ live tunnel/);
assert.match(leaseDrawerSource, /MX-H2I User Access/);
assert.match(leaseDrawerSource, /No connection or released lease is inferred/);
assert.match(leaseDrawerSource, /Ban from MX-H2I/);
assert.match(leaseDrawerSource, /Unban from MX-H2I/);
assert.match(leaseDrawerSource, /Luopan and other ProductNetworks are not affected/);
assert.match(leaseDrawerSource, /Reliable single-client ban is not available until peer-safe revoke exists/);
assert.match(leaseDrawerSource, /Runtime peer removal/);
assert.match(leaseDrawerSource, /previousFocusKey/);
const focusTrapSource = functionSource(rendererSource, 'trapMxH2iLeaseDrawerFocus');
assert.match(focusTrapSource, /event\.shiftKey/);
assert.match(focusTrapSource, /event\.preventDefault\(\)/);
const closeDrawerSource = functionSource(rendererSource, 'closeMxH2iLeaseDrawer');
assert.match(closeDrawerSource, /data-mx-h2i-blocked-user-open/);
assert.match(closeDrawerSource, /data-mx-h2i-lease-open/);
assert.match(closeDrawerSource, /data-mx-h2i-jump="connections"/);

const blockedUserWithoutLease = Function(
  'state',
  'MX_H2I_PRODUCT_ID',
  'launcherLeasesForProduct',
  `${functionSource(rendererSource, 'mxH2iLeaseDrawerKey')}
${functionSource(rendererSource, 'mxH2iLeaseForDrawer')}
return mxH2iLeaseForDrawer;`
)(
  {
    mxH2iLeaseDrawer: {
      leaseKey: 'blocked-user:usr-no-lease',
      productUserAccess: {
        productId: 'mx-h2i',
        userId: 'usr-no-lease',
        blocked: true,
        displayName: 'No Lease User',
        lastLease: null
      }
    }
  },
  'mx-h2i',
  () => []
);
assert.deepEqual(
  blockedUserWithoutLease(),
  {
    leaseId: '',
    productId: 'mx-h2i',
    userId: 'usr-no-lease',
    subject: 'No Lease User',
    identityKind: 'user',
    status: 'no lease allocated'
  },
  'a blocked user with no historical lease still gets a drawer model and can be unbanned'
);

const saveProductUserAccessSource = functionSource(rendererSource, 'saveMxH2iProductUserAccess');
assert.match(saveProductUserAccessSource, /products\/\$\{encodeURIComponent\(MX_H2I_PRODUCT_ID\)\}\/users\/\$\{encodeURIComponent\(userId\)\}\/access/);
assert.match(saveProductUserAccessSource, /blocked,[\s\S]*requestedBy: 'desktop-admin'/);
assert.match(saveProductUserAccessSource, /WireGuard peer removal is not claimed/);
assert.match(saveProductUserAccessSource, /const activeDrawer = state\.mxH2iLeaseDrawer\?\.userId === userId/);
assert.ok(
  saveProductUserAccessSource.indexOf('await refreshAppCenterNetwork();') > saveProductUserAccessSource.indexOf('if (activeDrawer)'),
  'a successful product-scoped access mutation refreshes inventory even if its drawer was closed'
);
assert.doesNotMatch(saveProductUserAccessSource, /user-center|user\.status|status:\s*'disabled'/);

const quickPolicySource = functionSource(rendererSource, 'saveMxH2iAnonymousQuickPolicy');
assert.match(quickPolicySource, /products\/\$\{encodeURIComponent\(MX_H2I_PRODUCT_ID\)\}/);
assert.match(quickPolicySource, /anonymousUiVisibility/);
assert.match(quickPolicySource, /const current = launcherProductById\(MX_H2I_PRODUCT_ID\)/);
assert.match(quickPolicySource, /if \(!current \|\| state\.launcherProductsError\)/);
assert.match(quickPolicySource, /Luopan, employee login, existing leases, and WireGuard peers were not changed/);

const opsProtectionSource = functionSource(rendererSource, 'isOpsProtectedInternalRequest');
assert.match(opsProtectionSource, /products\\\/\[\^\/\]\+\\\/user-access/);
assert.match(opsProtectionSource, /products\\\/\[\^\/\]\+\\\/users\\\/\[\^\/\]\+\\\/access/);

const savePolicySource = functionSource(rendererSource, 'saveStandaloneAnonymousPolicy');
assert.match(savePolicySource, /\/internal\/v1\/launcher-network\/products\/\$\{encodeURIComponent\(normalizedProductId\)\}/);
assert.match(savePolicySource, /method: 'POST'/);
assert.match(savePolicySource, /anonymousEnrollmentPolicy,[\s\S]*anonymousUiVisibility,[\s\S]*requestedBy: 'desktop-admin'/);
assert.match(savePolicySource, /\.\.\.current,[\s\S]*productId: normalizedProductId/);
assert.doesNotMatch(savePolicySource, /method: 'DELETE'|\/leases\/|releaseLauncher|deleteLauncher/i);

const initTopologySource = functionSource(rendererSource, 'initMxH2iTopology');
assert.match(initTopologySource, /prefers-reduced-motion: reduce/);
assert.match(initTopologySource, /ResizeObserver/);
assert.match(initTopologySource, /TABLE FALLBACK/);
assert.doesNotMatch(initTopologySource, /preserveDrawingBuffer/);

const animationGuardSource = functionSource(rendererSource, 'mxH2iTopologyCanAnimate');
assert.match(animationGuardSource, /!document\.hidden/);
assert.match(animationGuardSource, /state\.activeView === 'app-center'/);
assert.match(animationGuardSource, /state\.activeAppNode === MX_H2I_PRODUCT_ID/);
assert.match(animationGuardSource, /state\.mxH2iSurface === 'dashboard'/);
assert.match(animationGuardSource, /instance\.canvas\.isConnected/);

const disposeSource = functionSource(rendererSource, 'disposeMxH2iTopologyInstance');
assert.match(disposeSource, /cancelAnimationFrame/);
assert.match(disposeSource, /resizeObserver\?\.disconnect/);
assert.match(disposeSource, /removeEventListener\('visibilitychange'/);
assert.match(disposeSource, /value\?\.isTexture/);
assert.match(disposeSource, /object\.geometry\?\.dispose/);
assert.match(disposeSource, /material\.dispose/);
assert.match(disposeSource, /renderer\?\.dispose/);
assert.match(disposeSource, /forceContextLoss/);

assert.match(stylesSource, /\.mx-h2i-operations-panel\s*\{/);
assert.match(stylesSource, /\.mx-h2i-topology-fallback\s*\{/);
assert.match(stylesSource, /\.mx-h2i-lease-table\s*\{/);
assert.match(stylesSource, /\.mx-h2i-lease-pagination\s*\{/);
assert.match(stylesSource, /\.standalone-anonymous-policy-grid\s*\{/);
assert.match(stylesSource, /\.mx-h2i-dashboard-hero\s*\{/);
assert.match(stylesSource, /\.mx-h2i-banned-user-row\s*\{/);
assert.match(stylesSource, /\.mx-h2i-lease-drawer\s*\{/);
assert.match(indexSource, /id="tab-mx-h2i-dashboard"[\s\S]*data-app-surface="dashboard"/);
assert.match(indexSource, /id="mx-h2i-lease-drawer"/);
assert.match(packageSource, /node scripts\/mx-h2i-operations-ui\.test\.mjs/);

console.log('OK MX-H2I dashboard keeps lease truth bounded, exposes recoverable product-scoped controls, scopes anonymous policy, and disposes Three resources');
