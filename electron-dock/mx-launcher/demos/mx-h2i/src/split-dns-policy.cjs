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

function darwinSplitDnsStatusReady(status, expectedDomains) {
  if (!Array.isArray(expectedDomains) || expectedDomains.length === 0) return true;
  return status?.applied === true
    && status?.verified === true
    && status?.resolverApplied === true
    && status?.systemResolverMode === 'dynamic'
    && !status?.error
    && !status?.resolverError
    && resolverRootsCoverDomains(expectedDomains, status?.resolverDomains);
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

module.exports = {
  darwinSplitDnsStatusReady,
  invalidatePersistedDarwinSplitDnsProof,
  resolverRootCoversDomain,
  resolverRootsCoverDomains
};
