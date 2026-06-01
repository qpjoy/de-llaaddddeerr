import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { DATA_ROOT } from './storage.js';

export type ReleaseTargetKind = 'market' | 'plugin' | 'game';
export type ReleaseMode = 'manual' | 'notify' | 'auto' | 'force' | 'silent';
export type RestartPolicy = 'none' | 'plugin' | 'app' | 'system';
export type ReleasePlanState = 'draft' | 'active' | 'paused' | 'completed' | 'rolled_back';
export type UpdateActionStatus =
  | 'seen'
  | 'applied'
  | 'failed'
  | 'skipped'
  | 'restart_required'
  | 'awaiting_grant';

export interface ReleaseRolloutRule {
  percentage: number;
  seed?: string | null;
  userIds?: string[];
  deviceIds?: string[];
  installIds?: string[];
  platforms?: string[];
  archs?: string[];
  currentVersions?: string[];
}

export interface ReleasePlan {
  id: string;
  name: string;
  targetKind: ReleaseTargetKind;
  targetId: string;
  npm: string | null;
  targetVersion: string;
  fallbackVersion: string | null;
  channel: string;
  mode: ReleaseMode;
  restartPolicy: RestartPolicy;
  state: ReleasePlanState;
  rollout: ReleaseRolloutRule;
  autoGrant: boolean | 'manifest' | string[] | null;
  autoActivate: boolean;
  notes: string | null;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReleaseAssignment {
  id: string;
  planId: string;
  subject: string;
  installId: string | null;
  deviceId: string | null;
  userId: string | null;
  targetVersion: string;
  assignedAt: string;
  updatedAt: string;
}

export interface UpdateReport {
  id: string;
  planId: string;
  actionId: string | null;
  targetId: string;
  targetKind: ReleaseTargetKind;
  installId: string | null;
  deviceId: string | null;
  userId: string | null;
  fromVersion: string | null;
  toVersion: string;
  status: UpdateActionStatus;
  error: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

interface ReleaseFile {
  plans: ReleasePlan[];
  assignments: ReleaseAssignment[];
  reports: UpdateReport[];
}

const RELEASES_PATH = join(DATA_ROOT, 'release-policies.json');
const REPORT_LIMIT = 5000;

function nowIso(): string {
  return new Date().toISOString();
}

function readFile(): ReleaseFile {
  if (!existsSync(RELEASES_PATH)) return { plans: [], assignments: [], reports: [] };
  try {
    const parsed = JSON.parse(readFileSync(RELEASES_PATH, 'utf8')) as Partial<ReleaseFile>;
    return {
      plans: Array.isArray(parsed.plans) ? parsed.plans.map(normalizePlan).filter(Boolean) as ReleasePlan[] : [],
      assignments: Array.isArray(parsed.assignments) ? parsed.assignments.map(normalizeAssignment).filter(Boolean) as ReleaseAssignment[] : [],
      reports: Array.isArray(parsed.reports) ? parsed.reports.map(normalizeReport).filter(Boolean) as UpdateReport[] : []
    };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[release-storage] bad release-policies.json:', err);
    return { plans: [], assignments: [], reports: [] };
  }
}

function writeFile(file: ReleaseFile): void {
  writeFileSync(RELEASES_PATH, JSON.stringify(file, null, 2) + '\n', 'utf8');
}

function normalizeString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeString).filter((item): item is string => Boolean(item));
}

function normalizePercentage(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 100;
  return Math.max(0, Math.min(100, n));
}

function normalizeRollout(value: unknown): ReleaseRolloutRule {
  const row = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    percentage: normalizePercentage(row.percentage ?? 100),
    seed: normalizeString(row.seed),
    userIds: normalizeStringArray(row.userIds),
    deviceIds: normalizeStringArray(row.deviceIds),
    installIds: normalizeStringArray(row.installIds),
    platforms: normalizeStringArray(row.platforms),
    archs: normalizeStringArray(row.archs),
    currentVersions: normalizeStringArray(row.currentVersions)
  };
}

function normalizeTargetKind(value: unknown): ReleaseTargetKind {
  return value === 'market' || value === 'game' ? value : 'plugin';
}

function normalizeMode(value: unknown): ReleaseMode {
  return value === 'manual' || value === 'notify' || value === 'force' || value === 'silent'
    ? value
    : 'auto';
}

function normalizeRestartPolicy(value: unknown): RestartPolicy {
  return value === 'plugin' || value === 'app' || value === 'system' ? value : 'none';
}

function normalizeState(value: unknown): ReleasePlanState {
  return value === 'draft' || value === 'paused' || value === 'completed' || value === 'rolled_back'
    ? value
    : 'active';
}

function normalizeAutoGrant(value: unknown): boolean | 'manifest' | string[] | null {
  if (value === true || value === false || value === 'manifest') return value;
  const items = normalizeStringArray(value);
  return items.length > 0 ? items : null;
}

function normalizePlan(value: unknown): ReleasePlan | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const targetId = normalizeString(row.targetId);
  const targetVersion = normalizeString(row.targetVersion);
  if (!targetId || !targetVersion) return null;
  const createdAt = normalizeString(row.createdAt) ?? nowIso();
  return {
    id: normalizeString(row.id) ?? randomUUID(),
    name: normalizeString(row.name) ?? `${targetId}@${targetVersion}`,
    targetKind: normalizeTargetKind(row.targetKind),
    targetId,
    npm: normalizeString(row.npm),
    targetVersion,
    fallbackVersion: normalizeString(row.fallbackVersion),
    channel: normalizeString(row.channel) ?? 'stable',
    mode: normalizeMode(row.mode),
    restartPolicy: normalizeRestartPolicy(row.restartPolicy),
    state: normalizeState(row.state),
    rollout: normalizeRollout(row.rollout),
    autoGrant: normalizeAutoGrant(row.autoGrant),
    autoActivate: row.autoActivate === true,
    notes: normalizeString(row.notes),
    createdByUserId: normalizeString(row.createdByUserId),
    createdAt,
    updatedAt: normalizeString(row.updatedAt) ?? createdAt
  };
}

function normalizeAssignment(value: unknown): ReleaseAssignment | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const planId = normalizeString(row.planId);
  const subject = normalizeString(row.subject);
  const targetVersion = normalizeString(row.targetVersion);
  if (!planId || !subject || !targetVersion) return null;
  const assignedAt = normalizeString(row.assignedAt) ?? nowIso();
  return {
    id: normalizeString(row.id) ?? randomUUID(),
    planId,
    subject,
    installId: normalizeString(row.installId),
    deviceId: normalizeString(row.deviceId),
    userId: normalizeString(row.userId),
    targetVersion,
    assignedAt,
    updatedAt: normalizeString(row.updatedAt) ?? assignedAt
  };
}

function normalizeReport(value: unknown): UpdateReport | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const planId = normalizeString(row.planId);
  const targetId = normalizeString(row.targetId);
  const toVersion = normalizeString(row.toVersion);
  const status = normalizeString(row.status) as UpdateActionStatus | null;
  if (!planId || !targetId || !toVersion || !status) return null;
  return {
    id: normalizeString(row.id) ?? randomUUID(),
    planId,
    actionId: normalizeString(row.actionId),
    targetId,
    targetKind: normalizeTargetKind(row.targetKind),
    installId: normalizeString(row.installId),
    deviceId: normalizeString(row.deviceId),
    userId: normalizeString(row.userId),
    fromVersion: normalizeString(row.fromVersion),
    toVersion,
    status,
    error: normalizeString(row.error),
    metadata: row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
      ? row.metadata as Record<string, unknown>
      : null,
    createdAt: normalizeString(row.createdAt) ?? nowIso()
  };
}

export function assignmentSubject(input: {
  installId?: string | null;
  deviceId?: string | null;
  userId?: string | null;
}): string {
  return input.installId || input.deviceId || input.userId || 'anonymous';
}

export function rolloutBucket(subject: string, plan: ReleasePlan): number {
  const seed = plan.rollout.seed || plan.id;
  const hex = createHash('sha256').update(`${seed}:${plan.targetId}:${subject}`).digest('hex').slice(0, 8);
  return parseInt(hex, 16) % 10000;
}

export const releaseStorage = {
  listPlans(): ReleasePlan[] {
    return readFile().plans.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  },

  getPlan(id: string): ReleasePlan | null {
    return readFile().plans.find((plan) => plan.id === id) ?? null;
  },

  upsertPlan(input: Partial<ReleasePlan> & Pick<ReleasePlan, 'targetId' | 'targetVersion'>): ReleasePlan {
    const file = readFile();
    const now = nowIso();
    const existing = input.id ? file.plans.find((plan) => plan.id === input.id) : null;
    const base = existing ?? {
      id: input.id ?? randomUUID(),
      name: '',
      targetKind: 'plugin' as ReleaseTargetKind,
      targetId: input.targetId,
      npm: null,
      targetVersion: input.targetVersion,
      fallbackVersion: null,
      channel: 'stable',
      mode: 'auto' as ReleaseMode,
      restartPolicy: 'none' as RestartPolicy,
      state: 'active' as ReleasePlanState,
      rollout: { percentage: 100 },
      autoGrant: null,
      autoActivate: false,
      notes: null,
      createdByUserId: input.createdByUserId ?? null,
      createdAt: now,
      updatedAt: now
    };
    const next = normalizePlan({
      ...base,
      ...input,
      id: base.id,
      createdAt: base.createdAt,
      updatedAt: now
    });
    if (!next) throw new Error('invalid release plan');
    const idx = file.plans.findIndex((plan) => plan.id === next.id);
    if (idx >= 0) file.plans[idx] = next;
    else file.plans.push(next);
    writeFile(file);
    return next;
  },

  setPlanState(id: string, state: ReleasePlanState): ReleasePlan | null {
    const plan = this.getPlan(id);
    if (!plan) return null;
    return this.upsertPlan({ ...plan, state });
  },

  getAssignment(planId: string, subject: string): ReleaseAssignment | null {
    return readFile().assignments.find((row) => row.planId === planId && row.subject === subject) ?? null;
  },

  ensureAssignment(plan: ReleasePlan, input: {
    installId?: string | null;
    deviceId?: string | null;
    userId?: string | null;
  }): ReleaseAssignment {
    const file = readFile();
    const subject = assignmentSubject(input);
    const existing = file.assignments.find((row) => row.planId === plan.id && row.subject === subject);
    const now = nowIso();
    if (existing) {
      existing.updatedAt = now;
      writeFile(file);
      return existing;
    }
    const row: ReleaseAssignment = {
      id: randomUUID(),
      planId: plan.id,
      subject,
      installId: input.installId ?? null,
      deviceId: input.deviceId ?? null,
      userId: input.userId ?? null,
      targetVersion: plan.targetVersion,
      assignedAt: now,
      updatedAt: now
    };
    file.assignments.push(row);
    writeFile(file);
    return row;
  },

  recordReport(input: Omit<UpdateReport, 'id' | 'createdAt'>): UpdateReport {
    const file = readFile();
    const row: UpdateReport = {
      ...input,
      id: randomUUID(),
      createdAt: nowIso()
    };
    file.reports.push(row);
    if (file.reports.length > REPORT_LIMIT) {
      file.reports = file.reports.slice(file.reports.length - REPORT_LIMIT);
    }
    writeFile(file);
    return row;
  },

  listReports(filter: { planId?: string; targetId?: string; limit?: number } = {}): UpdateReport[] {
    let rows = readFile().reports;
    if (filter.planId) rows = rows.filter((row) => row.planId === filter.planId);
    if (filter.targetId) rows = rows.filter((row) => row.targetId === filter.targetId);
    return rows
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, filter.limit ?? 200);
  }
};
