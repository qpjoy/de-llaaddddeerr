function windowsLocalEdgePrerequisitesReady(connection = {}) {
  return connection?.health?.wireGuard === 'ready'
    && connection?.health?.internalApi === 'ready'
    && connection?.diagnostics?.windowsNrpt?.ready === true;
}

function windowsSystemDnsDataPlaneReady(connection = {}) {
  return windowsLocalEdgePrerequisitesReady(connection)
    && connection?.diagnostics?.windowsDnsResolution?.ready === true;
}

function standaloneOwnershipReady(connection = {}) {
  const diagnostics = connection?.diagnostics || {};
  const ownership = diagnostics.standaloneOwnershipRegistry
    || diagnostics.standaloneOwnership;
  return ownership?.ok === true;
}

function windowsBrowserPromotionPrerequisitesReady(connection = {}) {
  return windowsLocalEdgePrerequisitesReady(connection)
    && standaloneOwnershipReady(connection);
}

function windowsBrowserFallbackState(input = {}) {
  const connection = input.connection || {};
  const browserReady = input.browserReady === true;
  const systemDnsReady = windowsSystemDnsDataPlaneReady(connection);
  const localEdgePrerequisitesReady =
    windowsLocalEdgePrerequisitesReady(connection);
  const promotionPrerequisitesReady =
    windowsBrowserPromotionPrerequisitesReady(connection);
  const systemDnsDegraded = localEdgePrerequisitesReady && !systemDnsReady;
  return {
    active: input.connected === true
      && browserReady
      && promotionPrerequisitesReady
      && systemDnsDegraded,
    browserReady,
    systemDnsReady,
    nonPacProgramsReady: systemDnsReady,
    reason: systemDnsDegraded
      ? 'system DNS did not resolve the Internal target; verified PAC/local edge carries browser traffic'
      : null
  };
}

function windowsSplitDnsPathReady(input = {}) {
  return input.nrptReady === true
    && (input.systemDnsReady === true || input.browserReady === true);
}

function postConnectDataPlaneReady(input = {}) {
  if (input.wireGuardReady === true) return true;
  return input.platform === 'win32'
    && windowsBrowserPromotionPrerequisitesReady(input.connection);
}

module.exports = {
  postConnectDataPlaneReady,
  standaloneOwnershipReady,
  windowsBrowserFallbackState,
  windowsBrowserPromotionPrerequisitesReady,
  windowsLocalEdgePrerequisitesReady,
  windowsSplitDnsPathReady,
  windowsSystemDnsDataPlaneReady
};
