import * as fs from 'node:fs';
import * as path from 'node:path';

const POINTER_DIR = 'launcher-packages';

export interface ElectronLauncherAsarPointer {
  version: string;
  path: string;
  activatedAt: string;
}

export interface ElectronLauncherAsarSelection {
  active: boolean;
  path: string | null;
  version: string;
  baseVersion: string;
  source: 'base' | 'current' | 'pending';
}

export interface ElectronLauncherAsarSelectionInput {
  baseDir: string;
  componentId: string;
  baseVersion: string;
  pid?: number;
  processAlive?: (pid: number) => boolean;
}

export interface ElectronLauncherAsarLaunchInput {
  baseDir: string;
  componentId: string;
  activePath?: string | null;
}

export interface ElectronLauncherAsarFailureInput extends ElectronLauncherAsarLaunchInput {
  baseVersion: string;
  reason?: string | null;
}

export function selectElectronLauncherAsar(
  input: ElectronLauncherAsarSelectionInput
): ElectronLauncherAsarSelection {
  const baseDir = requiredText(input?.baseDir, 'baseDir');
  const componentId = safeComponentId(input?.componentId);
  const baseVersion = requiredText(input?.baseVersion, 'baseVersion');
  const pid = Number.isInteger(input?.pid) ? Number(input.pid) : process.pid;
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
    && typeof marker.pid === 'number'
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
    && typeof marker.pid === 'number'
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

export function confirmElectronLauncherAsarLaunch(
  input: ElectronLauncherAsarLaunchInput
): boolean {
  const activePath = optionalText(input?.activePath)
    || optionalText(process.env.MX_LAUNCHER_ACTIVE_ASAR);
  if (!activePath) return false;
  const files = pointerFiles(
    requiredText(input?.baseDir, 'baseDir'),
    safeComponentId(input?.componentId)
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

export function markElectronLauncherAsarLaunchFailed(
  input: ElectronLauncherAsarFailureInput
): boolean {
  const activePath = optionalText(input?.activePath);
  if (!activePath) return false;
  const baseVersion = requiredText(input?.baseVersion, 'baseVersion');
  const files = pointerFiles(
    requiredText(input?.baseDir, 'baseDir'),
    safeComponentId(input?.componentId)
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

export function runningElectronLauncherVersion(baseVersion: string): string {
  return optionalText(process.env.MX_LAUNCHER_ACTIVE_ASAR_VERSION) || baseVersion;
}

export function compareElectronLauncherReleaseVersions(left: string, right: string): number {
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

function pointerFiles(baseDir: string, componentId: string) {
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

function usablePointer(
  pointer: ElectronLauncherAsarPointer | null,
  baseVersion: string
): ElectronLauncherAsarPointer | null {
  if (!pointer || compareElectronLauncherReleaseVersions(pointer.version, baseVersion) <= 0) return null;
  try {
    const stat = withElectronAsarDisabled(() => fs.statSync(pointer.path));
    if (!stat.isFile() || path.extname(pointer.path).toLowerCase() !== '.asar') return null;
  } catch {
    return null;
  }
  return pointer;
}

function withElectronAsarDisabled<T>(operation: () => T): T {
  const runtimeProcess = process as NodeJS.Process & { noAsar?: boolean };
  const hadNoAsar = Object.prototype.hasOwnProperty.call(runtimeProcess, 'noAsar');
  const previous = runtimeProcess.noAsar;
  runtimeProcess.noAsar = true;
  try {
    return operation();
  } finally {
    if (hadNoAsar) runtimeProcess.noAsar = previous;
    else delete runtimeProcess.noAsar;
  }
}

function readPointer(filePath: string): ElectronLauncherAsarPointer | null {
  const value = readJson(filePath);
  const version = optionalText(value?.version);
  const artifactPath = optionalText(value?.path);
  if (!version || !artifactPath || !path.isAbsolute(artifactPath)) return null;
  return {
    version,
    path: artifactPath,
    activatedAt: optionalText(value?.activatedAt) || 'unknown'
  };
}

function readJson(filePath: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return value && typeof value === 'object' ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.next`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function recordFailedPointer(
  files: ReturnType<typeof pointerFiles>,
  pointer: ElectronLauncherAsarPointer,
  reason: string
): void {
  writeJsonAtomic(files.failed, {
    ...pointer,
    reason,
    failedAt: new Date().toISOString()
  });
}

function removeFile(filePath: string): void {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // A stale marker is safe; the next launch retries the same recovery.
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

function numericVersionParts(value: string): number[] | null {
  const match = String(value || '').trim().match(/^v?(\d+(?:\.\d+)*)(?:[-+].*)?$/i);
  return match ? match[1].split('.').map(Number) : null;
}

function safeComponentId(value: unknown): string {
  const componentId = requiredText(value, 'componentId').toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(componentId)) {
    throw new Error(`Invalid ASAR componentId: ${String(value)}`);
  }
  return componentId;
}

function requiredText(value: unknown, name: string): string {
  const text = optionalText(value);
  if (!text) throw new Error(`ASAR bootstrap requires ${name}`);
  return text;
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
