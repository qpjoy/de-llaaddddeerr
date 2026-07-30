const fs = require('node:fs');
const path = require('node:path');

const POINTER_DIR = 'launcher-packages';

function selectMxH2IAsar(input) {
  const baseDir = requiredText(input?.baseDir, 'baseDir');
  const componentId = safeComponentId(input?.componentId || 'mx-h2i');
  const baseVersion = requiredText(input?.baseVersion, 'baseVersion');
  const pid = Number.isInteger(input?.pid) ? input.pid : process.pid;
  const processAlive = typeof input?.processAlive === 'function' ? input.processAlive : isProcessAlive;
  const files = pointerFiles(baseDir, componentId);
  fs.mkdirSync(files.dir, { recursive: true });

  let current = readPointer(files.current);
  const previous = readPointer(files.previous);
  const marker = readJson(files.launching);
  if (
    marker
    && current
    && marker.path === current.path
    && marker.pid !== pid
    && !processAlive(marker.pid)
  ) {
    recordFailedPointer(files, current, 'previous launch did not reach ready');
    current = usablePointer(previous, baseVersion);
    if (current) writeJsonAtomic(files.current, current);
    else removeFile(files.current);
    removeFile(files.launching);
  }

  const pending = readPointer(files.pending);
  const usablePending = usablePointer(pending, baseVersion);
  if (usablePending) {
    if (current && current.path !== usablePending.path && usablePointer(current, baseVersion)) {
      writeJsonAtomic(files.previous, current);
    }
    current = {
      ...usablePending,
      activatedAt: new Date().toISOString()
    };
    writeJsonAtomic(files.current, current);
    removeFile(files.pending);
  } else if (pending) {
    removeFile(files.pending);
  }

  current = usablePointer(current, baseVersion);
  if (!current) {
    removeFile(files.current);
    removeFile(files.launching);
    return {
      active: false,
      path: null,
      version: baseVersion,
      baseVersion,
      source: 'base'
    };
  }

  const liveMarkerForSameAsar = marker
    && marker.path === current.path
    && marker.pid !== pid
    && processAlive(marker.pid);
  if (!liveMarkerForSameAsar) {
    writeJsonAtomic(files.launching, {
      version: current.version,
      path: current.path,
      pid,
      baseVersion,
      startedAt: new Date().toISOString()
    });
  }
  return {
    active: true,
    path: current.path,
    version: current.version,
    baseVersion,
    source: usablePending ? 'pending' : 'current'
  };
}

function confirmMxH2IAsarLaunch(input) {
  const activePath = optionalText(input?.activePath || process.env.MX_H2I_ACTIVE_ASAR);
  if (!activePath) return false;
  const files = pointerFiles(
    requiredText(input?.baseDir, 'baseDir'),
    safeComponentId(input?.componentId || 'mx-h2i')
  );
  const marker = readJson(files.launching);
  if (!marker || marker.path !== activePath) return false;
  writeJsonAtomic(files.healthy, {
    version: marker.version,
    path: marker.path,
    baseVersion: marker.baseVersion,
    confirmedAt: new Date().toISOString()
  });
  removeFile(files.launching);
  return true;
}

function markMxH2IAsarLaunchFailed(input) {
  const activePath = optionalText(input?.activePath);
  if (!activePath) return false;
  const baseVersion = requiredText(input?.baseVersion, 'baseVersion');
  const files = pointerFiles(
    requiredText(input?.baseDir, 'baseDir'),
    safeComponentId(input?.componentId || 'mx-h2i')
  );
  const current = readPointer(files.current);
  if (!current || current.path !== activePath) return false;
  recordFailedPointer(files, current, optionalText(input?.reason) || 'ASAR entry failed to load');
  const previous = usablePointer(readPointer(files.previous), baseVersion);
  if (previous) writeJsonAtomic(files.current, previous);
  else removeFile(files.current);
  removeFile(files.launching);
  return true;
}

function runningMxH2IVersion(baseVersion) {
  return optionalText(process.env.MX_H2I_ACTIVE_ASAR_VERSION) || baseVersion;
}

function pointerFiles(baseDir, componentId) {
  const dir = path.join(baseDir, POINTER_DIR);
  return {
    dir,
    pending: path.join(dir, `${componentId}.pending.json`),
    current: path.join(dir, `${componentId}.current.json`),
    previous: path.join(dir, `${componentId}.previous.json`),
    launching: path.join(dir, `${componentId}.launching.json`),
    healthy: path.join(dir, `${componentId}.healthy.json`),
    failed: path.join(dir, `${componentId}.failed.json`)
  };
}

function usablePointer(pointer, baseVersion) {
  if (!pointer || compareReleaseVersions(pointer.version, baseVersion) <= 0) return null;
  try {
    const stat = fs.statSync(pointer.path);
    if (!stat.isFile() || path.extname(pointer.path).toLowerCase() !== '.asar') return null;
  } catch {
    return null;
  }
  return pointer;
}

function readPointer(filePath) {
  const value = readJson(filePath);
  const version = optionalText(value?.version);
  const artifactPath = optionalText(value?.path);
  if (!version || !artifactPath || !path.isAbsolute(artifactPath)) return null;
  return {
    version,
    path: artifactPath,
    activatedAt: optionalText(value.activatedAt) || 'unknown'
  };
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.next`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function recordFailedPointer(files, pointer, reason) {
  writeJsonAtomic(files.failed, {
    ...pointer,
    reason,
    failedAt: new Date().toISOString()
  });
}

function removeFile(filePath) {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // A stale marker is safe; the next launch retries the same recovery.
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function compareReleaseVersions(left, right) {
  if (left === right) return 0;
  const leftParts = numericVersionParts(left);
  const rightParts = numericVersionParts(right);
  if (!leftParts || !rightParts) return String(left).localeCompare(String(right));
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function numericVersionParts(value) {
  const match = String(value || '').trim().match(/^v?(\d+(?:\.\d+)*)(?:[-+].*)?$/i);
  return match ? match[1].split('.').map(Number) : null;
}

function safeComponentId(value) {
  const componentId = requiredText(value, 'componentId').toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(componentId)) {
    throw new Error(`Invalid ASAR componentId: ${value}`);
  }
  return componentId;
}

function requiredText(value, name) {
  const text = optionalText(value);
  if (!text) throw new Error(`ASAR bootstrap requires ${name}`);
  return text;
}

function optionalText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

module.exports = {
  compareReleaseVersions,
  confirmMxH2IAsarLaunch,
  markMxH2IAsarLaunchFailed,
  runningMxH2IVersion,
  selectMxH2IAsar
};
