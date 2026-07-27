const COMPLETED_INSTALLER_STATES = new Set([
  'installer-opened',
  'ready-to-install'
]);

function reconcileRuntimeUpdateWithInstalledVersion(input, runningVersion) {
  const row = input && typeof input === 'object' ? input : {};
  const running = cleanVersion(runningVersion);
  if (!running) return { ...row };

  const persistedCurrent = cleanVersion(row.currentVersion);
  const versionChanged = Boolean(persistedCurrent && persistedCurrent !== running);
  const persistedLatest = cleanVersion(row.latestVersion);
  const versionRolledBack = Boolean(
    persistedCurrent
    && compareReleaseVersions(running, persistedCurrent) < 0
  );
  const latestVersion = !persistedLatest || compareReleaseVersions(persistedLatest, running) < 0
    ? running
    : persistedLatest;
  const targetInstalled = compareReleaseVersions(latestVersion, running) <= 0;
  const installerLike = COMPLETED_INSTALLER_STATES.has(cleanText(row.status))
    || row.majorUpdateRequiresInstaller === true
    || /(?:app-)?installer|(?:dmg|exe|msi|pkg)$/i.test(cleanText(row.artifactKind));

  const reconciled = {
    ...row,
    currentVersion: running,
    latestVersion
  };
  if (versionRolledBack) {
    return clearCompletedInstallerState(reconciled, {
      latestVersion: running,
      status: 'needs-check'
    });
  }
  if (!versionChanged || !targetInstalled || !installerLike) return reconciled;

  return clearCompletedInstallerState(reconciled, {
    status: 'up-to-date',
  });
}

function clearCompletedInstallerState(row, overrides = {}) {
  return {
    ...row,
    ...overrides,
    updateAvailable: false,
    restartPrompt: false,
    restartRequired: false,
    majorUpdateRequiresInstaller: false,
    stagedPath: null,
    downloadedAt: null,
    downloadedBytes: null,
    downloadedDigest: null,
    installerOpenError: null,
    downloadProgress: null,
    artifactKind: null,
    artifactId: null,
    artifactUrl: null,
    artifactDigest: null,
    artifactSignature: null,
    artifactSizeBytes: null,
    artifactPlatform: null,
    artifactArch: null,
    artifactFileName: null,
    activation: null
  };
}

function compareReleaseVersions(left, right) {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = leftParts[index] || 0;
    const rightValue = rightParts[index] || 0;
    if (leftValue !== rightValue) return leftValue - rightValue;
  }
  return 0;
}

function versionParts(value) {
  const match = cleanVersion(value).match(/^v?(\d+(?:\.\d+)*)/i);
  return match ? match[1].split('.').map(Number) : [0];
}

function cleanVersion(value) {
  return cleanText(value);
}

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

module.exports = {
  compareReleaseVersions,
  reconcileRuntimeUpdateWithInstalledVersion
};
