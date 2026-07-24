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

module.exports = {
  resolverRootCoversDomain,
  resolverRootsCoverDomains
};
