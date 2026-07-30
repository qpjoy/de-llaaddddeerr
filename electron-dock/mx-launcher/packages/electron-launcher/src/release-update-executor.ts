import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';

import {
  downloadElectronLauncherReleaseArtifactToFile,
  type ElectronLauncherReleaseArtifactRef,
  type ElectronLauncherReleaseUpdater,
  type ElectronLauncherUpdateCheckResult
} from './release-updater.js';

/**
 * Update executor for standalone launcher products (docs/17 state machine,
 * docs/19 §5 pipelines). Electron-free: the product injects the callbacks that
 * touch its runtime (reload renderer, apply config, open the installer).
 *
 *   idle -> checking -> downloading -> verifying -> staged -> activating -> reported
 *
 * Activation never runs while the product network is connecting, recovering,
 * or waiting for a permission prompt; installer activation is always manual.
 */

export type ElectronLauncherUpdateExecutorPhase =
  | 'idle' | 'checking' | 'downloading' | 'verifying' | 'staged' | 'activating' | 'reported' | 'failed';

export type ElectronLauncherNetworkGateState =
  | 'idle' | 'connected' | 'connecting' | 'recovering' | 'permission-required';

export type ElectronLauncherUpdateArtifactClass =
  | 'config' | 'renderer' | 'npm-package' | 'asar' | 'installer' | 'unknown';

export interface ElectronLauncherUpdateExecutorOptions {
  updater: ElectronLauncherReleaseUpdater;
  /** Product data dir, e.g. Electron `app.getPath('userData')`. */
  baseDir: string;
  installId?: string | null;
  /** Blocks activation while the connection path is busy. Default: always idle. */
  networkGate?: () => ElectronLauncherNetworkGateState | Promise<ElectronLauncherNetworkGateState>;
  onPhase?: (phase: ElectronLauncherUpdateExecutorPhase, detail: Record<string, unknown>) => void;
  /** Push a newly activated config/feature-flag snapshot into the runtime. */
  applyConfig?: (activePath: string) => void | Promise<void>;
  /** Reload the renderer from the newly activated bundle path. */
  applyRenderer?: (activePath: string) => void | Promise<void>;
  /** Open a downloaded installer through the OS (e.g. shell.openPath). */
  openInstaller?: (filePath: string) => void | Promise<void>;
}

export interface ElectronLauncherArtifactExecution {
  artifactId: string;
  artifactClass: ElectronLauncherUpdateArtifactClass;
  phase: ElectronLauncherUpdateExecutorPhase;
  stagedPath: string | null;
  activated: boolean;
  deferredReason: string | null;
  error: string | null;
}

export interface ElectronLauncherUpdateExecutionResult {
  releaseId: string | null;
  executed: boolean;
  reason: string;
  artifacts: ElectronLauncherArtifactExecution[];
}

interface SlotPointer {
  version: string;
  path: string;
  activatedAt: string;
}

const SLOTS_DIR = 'update-slots';
const STAGING_DIR = 'updates';

export function classifyElectronLauncherUpdateArtifact(kind: string | null | undefined): ElectronLauncherUpdateArtifactClass {
  const value = (kind || '').toLowerCase();
  if (!value) return 'unknown';
  if (/installer|dmg|msi|exe-full/.test(value)) return 'installer';
  if (/config|feature-flag|snapshot/.test(value)) return 'config';
  if (/renderer|ui-bundle/.test(value)) return 'renderer';
  if (/asar/.test(value)) return 'asar';
  if (/npm|launcher-package|package-dist/.test(value)) return 'npm-package';
  return 'unknown';
}

export interface ElectronLauncherArtifactActivation {
  artifactClass: ElectronLauncherUpdateArtifactClass;
  activated: boolean;
  deferredReason: string | null;
  activePath: string | null;
}

export interface ElectronLauncherReleaseUpdateExecutor {
  execute(check: ElectronLauncherUpdateCheckResult): Promise<ElectronLauncherUpdateExecutionResult>;
  /**
   * Activate an artifact that was already downloaded and digest-verified by
   * the product's own download path. Applies the same gate and slot rules as
   * `execute`; installer-class artifacts always defer to manual confirmation.
   */
  activateStaged(
    artifact: ElectronLauncherReleaseArtifactRef,
    stagedPath: string,
    context?: { releaseId?: string | null }
  ): Promise<ElectronLauncherArtifactActivation>;
  /** Manual confirmation step for installer-class artifacts. */
  openStagedInstaller(artifact: ElectronLauncherReleaseArtifactRef): Promise<string>;
  /** Roll the given slot back to its previous pointer. */
  rollback(slot: 'config' | 'renderer'): Promise<SlotPointer | null>;
}

export function createElectronLauncherReleaseUpdateExecutor(
  options: ElectronLauncherUpdateExecutorOptions
): ElectronLauncherReleaseUpdateExecutor {
  const baseDir = options.baseDir;
  if (!baseDir?.trim()) throw new Error('release update executor requires baseDir');
  const phase = (value: ElectronLauncherUpdateExecutorPhase, detail: Record<string, unknown> = {}) => {
    options.onPhase?.(value, detail);
  };
  const report = async (status: string, metadata: Record<string, unknown>) => {
    try {
      await options.updater.report({ status, installId: options.installId ?? null, metadata });
    } catch {
      // Reporting must never break the update path; Internal aggregates gaps as missing evidence.
    }
  };
  const gateState = async (): Promise<ElectronLauncherNetworkGateState> =>
    options.networkGate ? options.networkGate() : 'idle';
  const activationBlocked = async (): Promise<string | null> => {
    const state = await gateState();
    return state === 'connecting' || state === 'recovering' || state === 'permission-required'
      ? `network state is ${state}`
      : null;
  };

  async function stageArtifact(
    releaseId: string,
    artifact: ElectronLauncherReleaseArtifactRef,
    artifactBaseUrl: string
  ): Promise<string> {
    const fileName = artifact.fileName
      ? basename(artifact.fileName)
      : artifact.url
        ? basename(new URL(artifact.url, `${artifactBaseUrl.replace(/\/+$/, '')}/`).pathname) || artifact.artifactId
        : artifact.artifactId;
    const targetPath = join(baseDir, STAGING_DIR, releaseId, fileName);
    phase('downloading', { artifactId: artifact.artifactId, targetPath });
    await report('download-started', { artifactId: artifact.artifactId, releaseId });
    phase('verifying', { artifactId: artifact.artifactId });
    await downloadElectronLauncherReleaseArtifactToFile({
      artifact,
      targetPath,
      baseUrl: artifactBaseUrl
    });
    return targetPath;
  }

  async function activateSlot(
    slot: 'config' | 'renderer',
    artifact: ElectronLauncherReleaseArtifactRef,
    stagedPath: string
  ): Promise<string> {
    const slotDir = join(baseDir, SLOTS_DIR, slot);
    await mkdir(slotDir, { recursive: true });
    const activePath = join(slotDir, `active-${artifact.version}-${basename(stagedPath)}`);
    const tempPath = `${activePath}.next`;
    await copyFile(stagedPath, tempPath);
    await rm(activePath, { force: true });
    await rename(tempPath, activePath);
    const current = await readPointer(join(slotDir, 'current.json'));
    if (current) await writePointer(join(slotDir, 'previous.json'), current);
    await writePointer(join(slotDir, 'current.json'), {
      version: artifact.version,
      path: activePath,
      activatedAt: new Date().toISOString()
    });
    return activePath;
  }

  async function performActivation(
    artifact: ElectronLauncherReleaseArtifactRef,
    stagedPath: string,
    releaseId: string | null
  ): Promise<ElectronLauncherArtifactActivation> {
    const artifactClass = classifyElectronLauncherUpdateArtifact(artifact.kind);
    const result: ElectronLauncherArtifactActivation = {
      artifactClass,
      activated: false,
      deferredReason: null,
      activePath: null
    };
    if (artifactClass === 'installer') {
      result.deferredReason = 'installer activation is manual';
      return result;
    }
    const blocked = await activationBlocked();
    if (blocked) {
      result.deferredReason = blocked;
      await report('artifact-activation-deferred', { artifactId: artifact.artifactId, releaseId, reason: blocked });
      return result;
    }
    phase('activating', { artifactId: artifact.artifactId, artifactClass });
    if (artifactClass === 'config') {
      result.activePath = await activateSlot('config', artifact, stagedPath);
      await options.applyConfig?.(result.activePath);
      result.activated = true;
      await report('artifact-applied', { artifactId: artifact.artifactId, releaseId, artifactClass, path: result.activePath });
    } else if (artifactClass === 'renderer') {
      result.activePath = await activateSlot('renderer', artifact, stagedPath);
      await options.applyRenderer?.(result.activePath);
      result.activated = true;
      await report('artifact-applied', { artifactId: artifact.artifactId, releaseId, artifactClass, path: result.activePath });
    } else if (artifactClass === 'npm-package' || artifactClass === 'asar') {
      const pendingDir = join(baseDir, 'launcher-packages', artifact.componentId || 'unknown', artifact.version);
      await mkdir(pendingDir, { recursive: true });
      const packagePath = join(pendingDir, basename(stagedPath));
      await copyFile(stagedPath, packagePath);
      await writePointer(join(baseDir, 'launcher-packages', `${artifact.componentId || 'unknown'}.pending.json`), {
        version: artifact.version,
        path: packagePath,
        activatedAt: 'next-start'
      } as unknown as SlotPointer);
      result.activePath = packagePath;
      result.deferredReason = artifact.restartRequired ? 'restart required' : 'applies on next start';
      await report('artifact-staged-pending-restart', {
        artifactId: artifact.artifactId,
        releaseId,
        componentId: artifact.componentId,
        version: artifact.version
      });
    } else {
      result.deferredReason = `unknown artifact kind ${artifact.kind}`;
    }
    return result;
  }

  return {
    async execute(check) {
      phase('checking', { status: check.status });
      if (check.status !== 'update-available' || !check.plan) {
        phase('idle', { reason: check.reason });
        return { releaseId: check.plan?.releaseId ?? null, executed: false, reason: check.reason, artifacts: [] };
      }
      const releaseId = check.plan.releaseId;
      const executions: ElectronLauncherArtifactExecution[] = [];
      for (const artifact of check.artifacts) {
        const artifactClass = classifyElectronLauncherUpdateArtifact(artifact.kind);
        const execution: ElectronLauncherArtifactExecution = {
          artifactId: artifact.artifactId,
          artifactClass,
          phase: 'idle',
          stagedPath: null,
          activated: false,
          deferredReason: null,
          error: null
        };
        executions.push(execution);
        try {
          const stagedPath = await stageArtifact(releaseId, artifact, check.baseUrl);
          execution.stagedPath = stagedPath;
          execution.phase = 'staged';
          await report(artifactClass === 'installer' ? 'installer-downloaded' : 'artifact-staged', {
            artifactId: artifact.artifactId,
            releaseId,
            artifactClass,
            path: stagedPath
          });

          if (artifactClass === 'installer') continue; // installer activation is always manual

          if (!artifact.autoApply) {
            execution.deferredReason = 'manual activation required';
            continue;
          }
          const activation = await performActivation(artifact, stagedPath, releaseId);
          execution.activated = activation.activated;
          execution.deferredReason = activation.deferredReason;
          execution.phase = 'reported';
        } catch (error) {
          execution.phase = 'failed';
          execution.error = error instanceof Error ? error.message : String(error);
          await report('download-failed', { artifactId: artifact.artifactId, releaseId, error: execution.error });
        }
      }
      phase('reported', { releaseId });
      return { releaseId, executed: true, reason: check.reason, artifacts: executions };
    },

    async activateStaged(artifact, stagedPath, context) {
      if (!existsSync(stagedPath)) throw new Error(`staged artifact not found: ${stagedPath}`);
      return performActivation(artifact, stagedPath, context?.releaseId ?? null);
    },

    async openStagedInstaller(artifact) {
      const fileName = artifact.url ? basename(new URL(artifact.url).pathname) || artifact.artifactId : artifact.artifactId;
      const candidates = [join(baseDir, STAGING_DIR)];
      // staged as updates/<releaseId>/<file>; find the newest match
      const path = await findStagedFile(candidates[0], fileName);
      if (!path) throw new Error(`installer not staged: ${fileName}`);
      await options.openInstaller?.(path);
      await report('installer-opened', { artifactId: artifact.artifactId, path });
      return path;
    },

    async rollback(slot) {
      const slotDir = join(baseDir, SLOTS_DIR, slot);
      const previous = await readPointer(join(slotDir, 'previous.json'));
      if (!previous) return null;
      const current = await readPointer(join(slotDir, 'current.json'));
      await writePointer(join(slotDir, 'current.json'), previous);
      if (current) await writePointer(join(slotDir, 'previous.json'), current);
      if (slot === 'config') await options.applyConfig?.(previous.path);
      if (slot === 'renderer') await options.applyRenderer?.(previous.path);
      await report('artifact-rolled-back', { slot, version: previous.version, path: previous.path });
      return previous;
    }
  };
}

/**
 * Boot-time adoption of npm-package/asar artifacts staged with
 * `activatedAt: next-start`. Call before wiring module paths; returns the
 * packages whose pending pointer was promoted to current.
 */
export async function adoptPendingElectronLauncherPackages(baseDir: string): Promise<SlotPointer[]> {
  const dir = join(baseDir, 'launcher-packages');
  if (!existsSync(dir)) return [];
  const { readdir } = await import('node:fs/promises');
  const adopted: SlotPointer[] = [];
  for (const entry of await readdir(dir)) {
    if (!entry.endsWith('.pending.json')) continue;
    const pendingPath = join(dir, entry);
    const pointer = await readPointer(pendingPath);
    if (!pointer) continue;
    const currentPath = join(dir, entry.replace(/\.pending\.json$/, '.current.json'));
    await writePointer(currentPath, { ...pointer, activatedAt: new Date().toISOString() });
    await rm(pendingPath, { force: true });
    adopted.push(pointer);
  }
  return adopted;
}

/**
 * Closes the installer loop (docs/19 §5 pipeline 4): on startup, compare the
 * running version with the last recorded one; when it changed, report
 * `installer-completed` so Release Center can mark this install as upgraded.
 */
export async function reportElectronLauncherInstallCompletionIfUpgraded(input: {
  updater: ElectronLauncherReleaseUpdater;
  baseDir: string;
  currentVersion: string;
  installId?: string | null;
}): Promise<{ upgraded: boolean; from: string | null; to: string }> {
  const statePath = join(input.baseDir, SLOTS_DIR, 'app-version.json');
  let previous: string | null = null;
  try {
    previous = JSON.parse(await readFile(statePath, 'utf8'))?.version ?? null;
  } catch {
    previous = null;
  }
  await mkdir(join(input.baseDir, SLOTS_DIR), { recursive: true });
  await writeFile(statePath, JSON.stringify({ version: input.currentVersion, recordedAt: new Date().toISOString() }, null, 2));
  if (previous && previous !== input.currentVersion) {
    try {
      await input.updater.report({
        status: 'installer-completed',
        installId: input.installId ?? null,
        metadata: { from: previous, to: input.currentVersion }
      });
    } catch {
      // Missing completion reports surface as gray-health gaps server-side.
    }
    return { upgraded: true, from: previous, to: input.currentVersion };
  }
  return { upgraded: false, from: previous, to: input.currentVersion };
}

async function findStagedFile(stagingRoot: string, fileName: string): Promise<string | null> {
  if (!existsSync(stagingRoot)) return null;
  const { readdir, stat } = await import('node:fs/promises');
  let newest: { path: string; mtime: number } | null = null;
  for (const release of await readdir(stagingRoot)) {
    const candidate = join(stagingRoot, release, fileName);
    if (!existsSync(candidate)) continue;
    const info = await stat(candidate);
    if (!newest || info.mtimeMs > newest.mtime) newest = { path: candidate, mtime: info.mtimeMs };
  }
  return newest?.path ?? null;
}

async function readPointer(path: string): Promise<SlotPointer | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    return parsed && typeof parsed.path === 'string' ? parsed as SlotPointer : null;
  } catch {
    return null;
  }
}

async function writePointer(path: string, pointer: SlotPointer): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify(pointer, null, 2));
}
