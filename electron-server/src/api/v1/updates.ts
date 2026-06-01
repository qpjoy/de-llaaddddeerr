import type { FastifyInstance } from 'fastify';

import { attachUser, requireRole } from '../../auth/middleware.js';
import { auditStore, entitlementsStore } from '../../data/index.js';
import {
  assignmentSubject,
  releaseStorage,
  rolloutBucket,
  type ReleaseMode,
  type ReleasePlan,
  type ReleasePlanState,
  type ReleaseTargetKind,
  type RestartPolicy,
  type UpdateActionStatus
} from '../../data/release-storage.js';
import { storage } from '../../data/storage.js';
import type { PluginDetailDTO, PluginVersionDTO } from '../../data/types.js';

interface ClientPluginState {
  id: string;
  npm?: string | null;
  name?: string | null;
  version?: string | null;
  state?: string | null;
  manifest?: Record<string, unknown> | null;
  health?: Record<string, unknown> | null;
}

interface UpdateCheckBody {
  installId?: string | null;
  deviceId?: string | null;
  platform?: string | null;
  arch?: string | null;
  capabilities?: string[];
  app?: {
    name?: string | null;
    version?: string | null;
    isPackaged?: boolean | null;
  } | null;
  market?: {
    version?: string | null;
  } | null;
  plugins?: ClientPluginState[];
}

interface UpdateAction {
  actionId: string;
  planId: string;
  targetKind: ReleaseTargetKind;
  targetId: string;
  pluginId: string | null;
  npm: string | null;
  fromVersion: string | null;
  toVersion: string;
  mode: ReleaseMode;
  restartPolicy: RestartPolicy;
  channel: string;
  tarballUrl: string | null;
  manifestChecksum: string | null;
  tarballChecksum: string | null;
  autoGrant: boolean | 'manifest' | string[] | null;
  autoActivate: boolean;
  force: boolean;
  reason: string;
}

export async function updateRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', attachUser);
  const adminOnly = { preHandler: requireRole('admin') };

  app.post('/api/v1/updates/check', async (req) => {
    const body = (req.body ?? {}) as UpdateCheckBody;
    const actions: UpdateAction[] = [];
    const plans = releaseStorage.listPlans().filter((plan) => plan.state === 'active');
    const subject = assignmentSubject({
      installId: cleanString(body.installId),
      deviceId: cleanString(body.deviceId),
      userId: req.currentUser?.id ?? null
    });

    for (const plan of plans) {
      const action = await resolveActionForPlan(plan, body, req.currentUser, subject);
      if (action) actions.push(action);
    }

    return {
      serverTime: new Date().toISOString(),
      subject,
      actions
    };
  });

  app.post('/api/v1/updates/report', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const planId = cleanString(body.planId);
    const targetId = cleanString(body.targetId);
    const toVersion = cleanString(body.toVersion);
    const status = cleanStatus(body.status);
    if (!planId || !targetId || !toVersion || !status) {
      reply.code(400);
      return { error: 'planId, targetId, toVersion and status are required' };
    }
    const row = releaseStorage.recordReport({
      planId,
      actionId: cleanString(body.actionId),
      targetId,
      targetKind: cleanTargetKind(body.targetKind),
      installId: cleanString(body.installId),
      deviceId: cleanString(body.deviceId),
      userId: req.currentUser?.id ?? cleanString(body.userId),
      fromVersion: cleanString(body.fromVersion),
      toVersion,
      status,
      error: cleanString(body.error),
      metadata: plainObject(body.metadata)
    });
    return row;
  });

  app.get('/api/v1/admin/release-plans', adminOnly, async () => {
    return {
      plans: releaseStorage.listPlans(),
      reports: releaseStorage.listReports({ limit: 100 })
    };
  });

  app.post('/api/v1/admin/release-plans', adminOnly, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const targetId = cleanString(body.targetId);
    const targetVersion = cleanString(body.targetVersion);
    if (!targetId || !targetVersion) {
      reply.code(400);
      return { error: 'targetId and targetVersion are required' };
    }
    const plan = releaseStorage.upsertPlan({
      id: cleanString(body.id) ?? undefined,
      name: cleanString(body.name) ?? undefined,
      targetKind: cleanTargetKind(body.targetKind),
      targetId,
      npm: cleanString(body.npm),
      targetVersion,
      fallbackVersion: cleanString(body.fallbackVersion),
      channel: cleanString(body.channel) ?? 'stable',
      mode: cleanMode(body.mode),
      restartPolicy: cleanRestartPolicy(body.restartPolicy),
      state: cleanPlanState(body.state),
      rollout: plainObject(body.rollout) as never,
      autoGrant: cleanAutoGrant(body.autoGrant),
      autoActivate: body.autoActivate === true,
      notes: cleanString(body.notes),
      createdByUserId: req.currentUser?.id ?? null
    });
    await auditStore.insert({
      actorUserId: req.currentUser?.id ?? null,
      actorIp: req.ip,
      action: body.id ? 'admin.release_plan.update' : 'admin.release_plan.create',
      targetKind: 'release_plan',
      targetId: plan.id,
      meta: { targetId: plan.targetId, targetVersion: plan.targetVersion, mode: plan.mode }
    });
    return plan;
  });

  app.post<{ Params: { id: string } }>(
    '/api/v1/admin/release-plans/:id/state',
    adminOnly,
    async (req, reply) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const state = cleanPlanState(body.state);
      const plan = releaseStorage.setPlanState(req.params.id, state);
      if (!plan) {
        reply.code(404);
        return { error: 'release plan not found' };
      }
      await auditStore.insert({
        actorUserId: req.currentUser?.id ?? null,
        actorIp: req.ip,
        action: 'admin.release_plan.state',
        targetKind: 'release_plan',
        targetId: plan.id,
        meta: { state }
      });
      return plan;
    }
  );

  app.get('/api/v1/admin/release-reports', adminOnly, async (req) => {
    const url = new URL(req.url, 'http://localhost');
    return releaseStorage.listReports({
      planId: url.searchParams.get('planId') || undefined,
      targetId: url.searchParams.get('targetId') || undefined,
      limit: Math.min(1000, Number(url.searchParams.get('limit') ?? 200))
    });
  });
}

async function resolveActionForPlan(
  plan: ReleasePlan,
  body: UpdateCheckBody,
  user: { id: string; role: 'user' | 'admin' | 'banned' } | null | undefined,
  subject: string
): Promise<UpdateAction | null> {
  if (!clientMatchesPlan(plan, body, user?.id ?? null, subject)) return null;

  const current = currentStateForPlan(plan, body);
  if (current.version === plan.targetVersion) return null;

  if (plan.targetKind !== 'market' && !canApplyPluginAction(plan, body)) {
    if (plan.mode !== 'manual') return null;
  }

  const plugin = plan.targetKind === 'market' ? null : storage.getPlugin(plan.targetId);
  if (plugin && !(await pluginVisible(plugin, user ?? null))) return null;
  const version = plugin ? findPluginVersion(plugin, plan.targetVersion) : null;
  if (plugin && !version) return null;
  if (version?.yanked) return null;

  releaseStorage.ensureAssignment(plan, {
    installId: cleanString(body.installId),
    deviceId: cleanString(body.deviceId),
    userId: user?.id ?? null
  });

  return {
    actionId: `${plan.id}:${plan.targetVersion}`,
    planId: plan.id,
    targetKind: plan.targetKind,
    targetId: plan.targetId,
    pluginId: plan.targetKind === 'market' ? null : plan.targetId,
    npm: plan.npm ?? plugin?.npm ?? current.npm ?? null,
    fromVersion: current.version,
    toVersion: plan.targetVersion,
    mode: plan.mode,
    restartPolicy: plan.restartPolicy,
    channel: plan.channel,
    tarballUrl: version?.tarballUrl ?? plugin?.tarballUrl ?? null,
    manifestChecksum: version?.manifestChecksum ?? null,
    tarballChecksum: version?.tarballChecksum ?? null,
    autoGrant: plan.autoGrant,
    autoActivate: plan.autoActivate,
    force: plan.mode === 'force',
    reason: current.version
      ? `switch ${plan.targetId} from ${current.version} to ${plan.targetVersion}`
      : `install ${plan.targetId}@${plan.targetVersion}`
  };
}

function clientMatchesPlan(
  plan: ReleasePlan,
  body: UpdateCheckBody,
  userId: string | null,
  subject: string
): boolean {
  const rollout = plan.rollout;
  const platform = cleanString(body.platform);
  const arch = cleanString(body.arch);
  const deviceId = cleanString(body.deviceId);
  const installId = cleanString(body.installId);
  const current = currentStateForPlan(plan, body);
  if (rollout.platforms && rollout.platforms.length > 0 && (!platform || !rollout.platforms.includes(platform))) {
    return false;
  }
  if (rollout.archs && rollout.archs.length > 0 && (!arch || !rollout.archs.includes(arch))) {
    return false;
  }
  if (
    rollout.currentVersions &&
    rollout.currentVersions.length > 0 &&
    (!current.version || !rollout.currentVersions.includes(current.version))
  ) {
    return false;
  }
  if (
    userId && rollout.userIds?.includes(userId) ||
    deviceId && rollout.deviceIds?.includes(deviceId) ||
    installId && rollout.installIds?.includes(installId)
  ) {
    return true;
  }
  const existing = releaseStorage.getAssignment(plan.id, subject);
  if (existing) return true;
  return rolloutBucket(subject, plan) < Math.round((rollout.percentage ?? 100) * 100);
}

function currentStateForPlan(plan: ReleasePlan, body: UpdateCheckBody): { version: string | null; npm: string | null } {
  if (plan.targetKind === 'market') {
    return { version: cleanString(body.market?.version), npm: plan.npm };
  }
  const plugins = Array.isArray(body.plugins) ? body.plugins : [];
  const row = plugins.find((plugin) =>
    plugin.id === plan.targetId ||
    (plan.npm && plugin.npm === plan.npm)
  );
  return {
    version: cleanString(row?.version),
    npm: cleanString(row?.npm) ?? plan.npm
  };
}

function canApplyPluginAction(plan: ReleasePlan, body: UpdateCheckBody): boolean {
  if (plan.mode === 'manual' || plan.mode === 'notify') return true;
  return Array.isArray(body.capabilities) && body.capabilities.includes('plugin:apply-version');
}

async function pluginVisible(
  plugin: PluginDetailDTO,
  user: { id: string; role: 'user' | 'admin' | 'banned' } | null
): Promise<boolean> {
  switch (plugin.visibility) {
    case 'public':
      return true;
    case 'free':
      return Boolean(user);
    case 'paid':
      if (!user) return false;
      if (user.role === 'admin') return true;
      return Boolean(await entitlementsStore.forUserAndPlugin(user.id, plugin.id));
    case 'private':
      return user?.role === 'admin';
    default:
      return true;
  }
}

function findPluginVersion(plugin: PluginDetailDTO, version: string): PluginVersionDTO | null {
  return plugin.versions.find((row) => row.version === version) ?? null;
}

function cleanString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function plainObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function cleanTargetKind(value: unknown): ReleaseTargetKind {
  return value === 'market' || value === 'game' ? value : 'plugin';
}

function cleanMode(value: unknown): ReleaseMode {
  return value === 'manual' || value === 'notify' || value === 'force' || value === 'silent'
    ? value
    : 'auto';
}

function cleanRestartPolicy(value: unknown): RestartPolicy {
  return value === 'plugin' || value === 'app' || value === 'system' ? value : 'none';
}

function cleanPlanState(value: unknown): ReleasePlanState {
  return value === 'draft' || value === 'paused' || value === 'completed' || value === 'rolled_back'
    ? value
    : 'active';
}

function cleanStatus(value: unknown): UpdateActionStatus | null {
  if (
    value === 'seen' ||
    value === 'applied' ||
    value === 'failed' ||
    value === 'skipped' ||
    value === 'restart_required' ||
    value === 'awaiting_grant'
  ) {
    return value;
  }
  return null;
}

function cleanAutoGrant(value: unknown): boolean | 'manifest' | string[] | null {
  if (value === true || value === false || value === 'manifest') return value;
  if (!Array.isArray(value)) return null;
  const items = value.map(cleanString).filter((item): item is string => Boolean(item));
  return items.length > 0 ? items : null;
}
