import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

export interface ElectronLauncherProcessLeaseCandidate {
  version: 1;
  pid: number;
  token: string;
  ticket: number;
  choosing: boolean;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface ElectronLauncherProcessLease {
  resourcePath: string;
  directoryPath: string;
  candidatePath: string;
  candidate: ElectronLauncherProcessLeaseCandidate;
}

export interface ElectronLauncherProcessLeaseOptions {
  waitMs?: number;
  retryMs?: number;
  metadata?: Record<string, unknown> | null;
}

export class ElectronLauncherProcessLeaseBusyError extends Error {
  readonly code = 'ELOCKED';
  readonly candidates: ElectronLauncherProcessLeaseCandidate[];

  constructor(resourcePath: string, candidates: ElectronLauncherProcessLeaseCandidate[]) {
    const holder = candidates
      .filter((candidate) => !candidate.choosing)
      .sort(compareProcessLeaseCandidates)[0];
    const holderDescription = holder
      ? ` pid=${holder.pid} metadata=${JSON.stringify(holder.metadata ?? {})}`
      : '';
    super(`Process lease ${resourcePath} is already held.${holderDescription}`);
    this.name = 'ElectronLauncherProcessLeaseBusyError';
    this.candidates = candidates;
  }
}

const PROCESS_LEASE_INVALID_STALE_MS = 15_000;
const PROCESS_LEASE_SLEEP = new Int32Array(new SharedArrayBuffer(4));

export function acquireElectronLauncherProcessLease(
  resourcePath: string,
  options: ElectronLauncherProcessLeaseOptions = {}
): ElectronLauncherProcessLease {
  const directoryPath = `${resourcePath}.queue`;
  mkdirSync(dirname(resourcePath), { recursive: true });
  mkdirSync(directoryPath, { recursive: true });
  const token = randomUUID();
  const candidatePath = `${directoryPath}/${process.pid}-${token}.json`;
  const createdAt = new Date().toISOString();
  const choosing: ElectronLauncherProcessLeaseCandidate = {
    version: 1,
    pid: process.pid,
    token,
    ticket: 0,
    choosing: true,
    metadata: options.metadata && typeof options.metadata === 'object' ? options.metadata : null,
    createdAt
  };
  createProcessLeaseCandidate(candidatePath, choosing);
  try {
    const initial = readProcessLeaseCandidates(directoryPath);
    const ticket = initial.reduce(
      (maximum, candidate) => Math.max(maximum, candidate.choosing ? 0 : candidate.ticket),
      0
    ) + 1;
    const candidate: ElectronLauncherProcessLeaseCandidate = {
      ...choosing,
      ticket,
      choosing: false
    };
    writeProcessLeaseCandidate(candidatePath, candidate);

    const waitMs = Math.max(0, Math.floor(options.waitMs ?? 0));
    const retryMs = Math.max(1, Math.floor(options.retryMs ?? 20));
    const deadline = Date.now() + waitMs;
    while (true) {
      const candidates = readProcessLeaseCandidates(directoryPath);
      const own = candidates.find((row) => row.token === token && row.pid === process.pid);
      if (!own || own.choosing || own.ticket !== ticket) {
        throw new Error(`Process lease candidate ${candidatePath} was lost or changed during acquisition.`);
      }
      const blocked = candidates.some((row) => (
        row.token !== token
        && (
          row.choosing
          || compareProcessLeaseCandidates(row, candidate) < 0
        )
      ));
      if (!blocked) {
        return {
          resourcePath,
          directoryPath,
          candidatePath,
          candidate
        };
      }
      if (Date.now() >= deadline) {
        throw new ElectronLauncherProcessLeaseBusyError(
          resourcePath,
          candidates.filter((row) => (
            row.token !== token
            && (
              row.choosing
              || compareProcessLeaseCandidates(row, candidate) < 0
            )
          ))
        );
      }
      Atomics.wait(
        PROCESS_LEASE_SLEEP,
        0,
        0,
        Math.min(retryMs, Math.max(1, deadline - Date.now()))
      );
    }
  } catch (error) {
    removeProcessLeaseCandidate(candidatePath);
    throw error;
  }
}

export function releaseElectronLauncherProcessLease(
  lease: ElectronLauncherProcessLease
): void {
  let raw: string;
  try {
    raw = readFileSync(lease.candidatePath, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    throw error;
  }
  const current = parseProcessLeaseCandidate(raw);
  if (!current || current.token !== lease.candidate.token || current.pid !== lease.candidate.pid) {
    throw new Error(`Process lease candidate ${lease.candidatePath} no longer belongs to this owner.`);
  }
  unlinkSync(lease.candidatePath);
}

function readProcessLeaseCandidates(
  directoryPath: string
): ElectronLauncherProcessLeaseCandidate[] {
  mkdirSync(directoryPath, { recursive: true });
  const candidates: ElectronLauncherProcessLeaseCandidate[] = [];
  for (const name of readdirSync(directoryPath)) {
    if (!name.endsWith('.json')) continue;
    const candidatePath = `${directoryPath}/${name}`;
    let raw = '';
    try {
      raw = readFileSync(candidatePath, 'utf8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') continue;
      throw error;
    }
    const candidate = parseProcessLeaseCandidate(raw);
    if (candidate && name === `${candidate.pid}-${candidate.token}.json`) {
      if (processExists(candidate.pid)) {
        candidates.push(candidate);
      } else {
        removeProcessLeaseCandidate(candidatePath);
      }
      continue;
    }
    const filePid = Number.parseInt(name.split('-', 1)[0] || '', 10);
    const liveUnknownOwner = Number.isInteger(filePid) && filePid > 0 && processExists(filePid);
    let stale = !liveUnknownOwner;
    if (!stale) {
      try {
        stale = Date.now() - statSync(candidatePath).mtimeMs >= PROCESS_LEASE_INVALID_STALE_MS;
      } catch (error) {
        if (errorCode(error) === 'ENOENT') continue;
        throw error;
      }
    }
    if (stale && !liveUnknownOwner) {
      removeProcessLeaseCandidate(candidatePath);
      continue;
    }
    candidates.push({
      version: 1,
      pid: Number.isInteger(filePid) && filePid > 0 ? filePid : Number.MAX_SAFE_INTEGER,
      token: `invalid:${name}`,
      ticket: Number.MAX_SAFE_INTEGER,
      choosing: true,
      metadata: { invalidCandidate: name },
      createdAt: new Date(0).toISOString()
    });
  }
  return candidates;
}

function compareProcessLeaseCandidates(
  left: ElectronLauncherProcessLeaseCandidate,
  right: ElectronLauncherProcessLeaseCandidate
): number {
  return left.ticket - right.ticket || left.token.localeCompare(right.token);
}

function createProcessLeaseCandidate(
  candidatePath: string,
  candidate: ElectronLauncherProcessLeaseCandidate
): void {
  let descriptor: number | null = null;
  let created = false;
  try {
    descriptor = openSync(candidatePath, 'wx', 0o600);
    created = true;
    writeFileSync(descriptor, JSON.stringify(candidate), { encoding: 'utf8' });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
  } catch (error) {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the original create error.
      }
    }
    if (created) removeProcessLeaseCandidate(candidatePath);
    throw error;
  }
}

function writeProcessLeaseCandidate(
  candidatePath: string,
  candidate: ElectronLauncherProcessLeaseCandidate
): void {
  const temporaryPath = `${candidatePath}.${randomUUID()}.tmp`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporaryPath, 'wx', 0o600);
    writeFileSync(descriptor, JSON.stringify(candidate), { encoding: 'utf8' });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporaryPath, candidatePath);
  } finally {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the original update error.
      }
    }
    removeProcessLeaseCandidate(temporaryPath);
  }
}

function parseProcessLeaseCandidate(raw: string): ElectronLauncherProcessLeaseCandidate | null {
  try {
    const candidate = JSON.parse(raw) as Partial<ElectronLauncherProcessLeaseCandidate>;
    return candidate.version === 1
      && Number.isInteger(candidate.pid)
      && Number(candidate.pid) > 0
      && typeof candidate.token === 'string'
      && Boolean(candidate.token)
      && Number.isInteger(candidate.ticket)
      && Number(candidate.ticket) >= 0
      && typeof candidate.choosing === 'boolean'
      && typeof candidate.createdAt === 'string'
      && Number.isFinite(Date.parse(candidate.createdAt))
      ? candidate as ElectronLauncherProcessLeaseCandidate
      : null;
  } catch {
    return null;
  }
}

function removeProcessLeaseCandidate(candidatePath: string): void {
  try {
    unlinkSync(candidatePath);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== 'ESRCH';
  }
}

function errorCode(error: unknown): string | null {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : null;
}
