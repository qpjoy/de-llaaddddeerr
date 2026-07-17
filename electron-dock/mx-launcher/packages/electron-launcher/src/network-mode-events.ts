import { mkdirSync, readFileSync, renameSync, watchFile, unwatchFile, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type ElectronLauncherNetworkMode = 'visit' | 'staff';
export type ElectronLauncherNetworkModeEventName =
  | 'visit:connect'
  | 'visit:disconnect'
  | 'staff:connect'
  | 'staff:disconnect';
export type ElectronLauncherNetworkModeEventPhase =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'skipped'
  | 'failed';

export interface ElectronLauncherNetworkModeEventInput {
  name: ElectronLauncherNetworkModeEventName;
  phase: ElectronLauncherNetworkModeEventPhase;
  productId: string;
  instanceId?: string | null;
  leaseIp?: string | null;
  reason?: string | null;
  transitionId?: string | null;
  occurredAt?: string | null;
}

export interface ElectronLauncherNetworkModeEvent extends ElectronLauncherNetworkModeEventInput {
  sequence: number;
  instanceId: string | null;
  leaseIp: string | null;
  reason: string | null;
  transitionId: string | null;
  occurredAt: string;
}

export interface ElectronLauncherNetworkModeEventState {
  version: 1;
  sequence: number;
  activeMode: ElectronLauncherNetworkMode | null;
  current: ElectronLauncherNetworkModeEvent | null;
  history: ElectronLauncherNetworkModeEvent[];
  updatedAt: string;
}

export interface ElectronLauncherNetworkModeEventPublishOptions {
  statePath?: string | null;
  historyLimit?: number;
}

export function defaultElectronLauncherNetworkModeEventStatePath(): string {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'QPJoy', 'Electron Launcher', 'network-mode-events.json');
  }
  if (process.platform === 'win32') {
    return join(process.env.APPDATA || homedir(), 'QPJoy', 'Electron Launcher', 'network-mode-events.json');
  }
  return join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'qpjoy-electron-launcher', 'network-mode-events.json');
}

export function readElectronLauncherNetworkModeEventState(
  statePath?: string | null
): ElectronLauncherNetworkModeEventState {
  const path = statePath || defaultElectronLauncherNetworkModeEventStatePath();
  try {
    return normalizeState(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return emptyState();
  }
}

export function publishElectronLauncherNetworkModeEvent(
  input: ElectronLauncherNetworkModeEventInput,
  options: ElectronLauncherNetworkModeEventPublishOptions = {}
): ElectronLauncherNetworkModeEventState {
  const path = options.statePath || defaultElectronLauncherNetworkModeEventStatePath();
  const previous = readElectronLauncherNetworkModeEventState(path);
  const sequence = previous.sequence + 1;
  const event: ElectronLauncherNetworkModeEvent = {
    name: input.name,
    phase: input.phase,
    productId: requiredString(input.productId, 'productId'),
    instanceId: optionalString(input.instanceId),
    leaseIp: optionalString(input.leaseIp),
    reason: optionalString(input.reason),
    transitionId: optionalString(input.transitionId),
    occurredAt: optionalString(input.occurredAt) || new Date().toISOString(),
    sequence
  };
  const historyLimit = Number.isInteger(options.historyLimit) && Number(options.historyLimit) > 0
    ? Number(options.historyLimit)
    : 32;
  const next: ElectronLauncherNetworkModeEventState = {
    version: 1,
    sequence,
    activeMode: nextActiveMode(previous.activeMode, event),
    current: event,
    history: [event, ...previous.history].slice(0, historyLimit),
    updatedAt: event.occurredAt
  };
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${sequence}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  renameSync(temporaryPath, path);
  return next;
}

export function subscribeElectronLauncherNetworkModeEvents(
  listener: (state: ElectronLauncherNetworkModeEventState) => void,
  options: { statePath?: string | null; intervalMs?: number; emitCurrent?: boolean } = {}
): () => void {
  const path = options.statePath || defaultElectronLauncherNetworkModeEventStatePath();
  if (options.emitCurrent !== false) listener(readElectronLauncherNetworkModeEventState(path));
  let lastSequence = readElectronLauncherNetworkModeEventState(path).sequence;
  const handler = () => {
    const state = readElectronLauncherNetworkModeEventState(path);
    if (state.sequence === lastSequence) return;
    lastSequence = state.sequence;
    listener(state);
  };
  watchFile(path, { interval: options.intervalMs ?? 250, persistent: false }, handler);
  return () => unwatchFile(path, handler);
}

function nextActiveMode(
  current: ElectronLauncherNetworkMode | null,
  event: ElectronLauncherNetworkModeEvent
): ElectronLauncherNetworkMode | null {
  const mode = event.name.startsWith('staff:') ? 'staff' : 'visit';
  if (event.name.endsWith(':connect') && event.phase === 'connected') return mode;
  if (event.name.endsWith(':disconnect') && event.phase === 'disconnected' && current === mode) return null;
  return current;
}

function normalizeState(input: unknown): ElectronLauncherNetworkModeEventState {
  const row = objectValue(input);
  const history = Array.isArray(row.history)
    ? row.history.map(normalizeEvent).filter((event): event is ElectronLauncherNetworkModeEvent => Boolean(event)).slice(0, 32)
    : [];
  const current = normalizeEvent(row.current) || history[0] || null;
  return {
    version: 1,
    sequence: Number.isInteger(row.sequence) && Number(row.sequence) >= 0 ? Number(row.sequence) : current?.sequence ?? 0,
    activeMode: row.activeMode === 'visit' || row.activeMode === 'staff' ? row.activeMode : null,
    current,
    history,
    updatedAt: optionalString(row.updatedAt) || current?.occurredAt || new Date(0).toISOString()
  };
}

function normalizeEvent(input: unknown): ElectronLauncherNetworkModeEvent | null {
  const row = objectValue(input);
  const name = row.name;
  const phase = row.phase;
  if (!['visit:connect', 'visit:disconnect', 'staff:connect', 'staff:disconnect'].includes(String(name))) return null;
  if (!['connecting', 'connected', 'disconnected', 'skipped', 'failed'].includes(String(phase))) return null;
  const productId = optionalString(row.productId);
  const sequence = Number(row.sequence);
  if (!productId || !Number.isInteger(sequence) || sequence < 1) return null;
  return {
    name: name as ElectronLauncherNetworkModeEventName,
    phase: phase as ElectronLauncherNetworkModeEventPhase,
    productId,
    instanceId: optionalString(row.instanceId),
    leaseIp: optionalString(row.leaseIp),
    reason: optionalString(row.reason),
    transitionId: optionalString(row.transitionId),
    occurredAt: optionalString(row.occurredAt) || new Date(0).toISOString(),
    sequence
  };
}

function emptyState(): ElectronLauncherNetworkModeEventState {
  return {
    version: 1,
    sequence: 0,
    activeMode: null,
    current: null,
    history: [],
    updatedAt: new Date(0).toISOString()
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function requiredString(value: unknown, name: string): string {
  const normalized = optionalString(value);
  if (!normalized) throw new Error(`Electron Launcher network mode event ${name} is required`);
  return normalized;
}
