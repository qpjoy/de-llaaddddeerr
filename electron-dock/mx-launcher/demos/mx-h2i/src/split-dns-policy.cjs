function normalizeDnsDomain(value) {
  return typeof value === 'string'
    ? value.trim().toLowerCase().replace(/^\.+|\.+$/g, '')
    : '';
}

function resolverRootCoversDomain(expectedDomain, resolverRoot) {
  const domain = normalizeDnsDomain(expectedDomain);
  const root = normalizeDnsDomain(resolverRoot);
  return Boolean(
    domain
    && root
    && (domain === root || domain.endsWith(`.${root}`))
  );
}

function resolverRootsCoverDomains(expectedDomains, resolverRoots) {
  if (!Array.isArray(expectedDomains) || expectedDomains.length === 0) return false;
  if (!Array.isArray(resolverRoots) || resolverRoots.length === 0) return false;
  return expectedDomains.every((domain) =>
    resolverRoots.some((root) => resolverRootCoversDomain(domain, root))
  );
}

function firstResolverCoveredHost(resolverRoots, candidates) {
  const roots = uniqueDnsDomains(resolverRoots);
  const hosts = uniqueDnsDomains(candidates);
  const covered = hosts.filter((host) =>
    roots.some((root) => resolverRootCoversDomain(host, root))
  );
  // Prefer a strict child. It receives a longer macOS supplemental-resolver
  // match than a still-active V1 /etc/resolver parent, so Clash dns-hijack on
  // that foreign port-53 resolver cannot win the same-name race.
  return covered.find((host) => !roots.includes(host)
    && roots.some((root) => resolverRootCoversDomain(host, root)))
    || covered[0]
    || null;
}

function darwinSplitDnsStatusReady(status, expectedDomains) {
  if (!Array.isArray(expectedDomains) || expectedDomains.length === 0) return true;
  return status?.applied === true
    && status?.verified === true
    && status?.resolverApplied === true
    && status?.systemResolverMode === 'dynamic'
    && status?.systemResolution?.ready === true
    && status?.systemResolution?.proof === 'system-dns-lookup'
    && darwinSystemResolutionResultReady(status.systemResolution)
    && !status?.error
    && !status?.resolverError
    && resolverRootsCoverDomains(expectedDomains, status?.resolverDomains);
}

function darwinSystemResolutionResultReady(result) {
  const addresses = Array.isArray(result?.addresses) ? result.addresses : [];
  const expectedTargets = new Set((Array.isArray(result?.expectedInternalTargets)
    ? result.expectedInternalTargets
    : [])
    .map((value) => typeof value === 'string' ? value.trim() : '')
    .filter((value) => isIP(value) === 4));
  return result?.ok === true
    && expectedTargets.size > 0
    && addresses.length > 0
    && addresses.every((row) => row?.classification === 'expected-internal-target'
      && expectedTargets.has(row?.address));
}

function darwinSystemResolutionExpectedTargets(host, reverseProxyRoutes, fallbackTarget) {
  const normalizedHost = normalizeDnsDomain(host);
  const routes = Array.isArray(reverseProxyRoutes) ? reverseProxyRoutes : [];
  const productTarget = typeof fallbackTarget === 'string' ? fallbackTarget.trim() : '';
  if (isIP(productTarget) !== 4) return [];
  const exactRoute = routes.find((route) => route?.enabled !== false
    && normalizeDnsDomain(route?.host) === normalizedHost
    && isIP(typeof route?.dnsTarget === 'string' ? route.dnsTarget.trim() : '') === 4);
  if (exactRoute) {
    const routeTarget = exactRoute.dnsTarget.trim();
    // A route entry is not itself authority for ProductNetwork ownership. It
    // must still resolve to the MX-H2I control target selected by routePlan;
    // otherwise a Luopan or stale V2 VIP could falsely promote this product.
    return routeTarget === productTarget ? [routeTarget] : [];
  }
  return [productTarget];
}

function invalidatePersistedDarwinSplitDnsProof(status, platform) {
  if (!status || typeof status !== 'object' || platform !== 'darwin') return status;
  return {
    ...status,
    // PAC and DNS relay verification is process-local: the listeners from the
    // process that wrote this runtime snapshot no longer prove current health.
    verified: false
  };
}

function macBackgroundSystemDomainProxyRepairEnabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(
    typeof value === 'string' ? value.trim().toLowerCase() : ''
  );
}

function systemDomainProxyDomains(configuredDomains, diagnosticHost, routeHosts) {
  const configured = uniqueDnsDomains(configuredDomains);
  const diagnostic = normalizeDnsDomain(diagnosticHost);
  const coveredDiagnostic = diagnostic
    && configured.some((root) => resolverRootCoversDomain(diagnostic, root))
    ? [diagnostic]
    : [];
  return uniqueDnsDomains([
    ...configured,
    ...coveredDiagnostic,
    ...(Array.isArray(routeHosts) ? routeHosts : [])
  ]);
}

function uniqueDnsDomains(domains) {
  return [...new Set((Array.isArray(domains) ? domains : [])
    .map(normalizeDnsDomain)
    .filter(Boolean))];
}

module.exports = {
  darwinSplitDnsStatusReady,
  darwinSystemResolutionExpectedTargets,
  darwinSystemResolutionResultReady,
  invalidatePersistedDarwinSplitDnsProof,
  macBackgroundSystemDomainProxyRepairEnabled,
  firstResolverCoveredHost,
  resolverRootCoversDomain,
  resolverRootsCoverDomains,
  systemDomainProxyDomains
};
const { isIP } = require('node:net');
