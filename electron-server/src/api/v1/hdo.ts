import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, resolve } from 'node:path';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { attachUser, requireAuth, requireRole } from '../../auth/middleware.js';
import { toPublic } from '../../auth/types.js';
import { auditStore, hdoStore, usersStore } from '../../data/index.js';
import type {
  HdoArtifactKind,
  HdoDeviceMeshStateRow,
  HdoDeviceMeshStateStatus,
  HdoDeviceRow,
  HdoDeviceTaskKind,
  HdoDeviceTaskStatus,
  HdoMeshGroupRow,
  HdoMeshMembershipRole,
  HdoMeshMembershipRow,
  HdoMeshMembershipStatus,
  HdoNodeKind,
  HdoNodeRow,
  HdoNodeStatus,
  HdoProfileMode,
  HdoRateLimitSubjectType,
  HdoServiceRow,
  HdoServiceProtocol
} from '../../data/storage-types.js';

const NODE_KINDS: readonly HdoNodeKind[] = ['domestic', 'home', 'oversea'];
const NODE_STATUSES: readonly HdoNodeStatus[] = ['pending', 'online', 'offline', 'error'];
const SERVICE_PROTOCOLS: readonly HdoServiceProtocol[] = ['tcp', 'udp', 'http', 'https'];
const HDO_SERVICE_PROBE_PORTS = [
  22,
  80,
  443,
  3000,
  3306,
  5173,
  5432,
  6379,
  8000,
  8080,
  8443,
  9000,
  9090
] as const;
const HDO_SERVICE_PROBE_TIMEOUT_MS = 700;
const HDO_DEVICE_ONLINE_WINDOW_MS = 10 * 60 * 1000;
const HDO_WG_OBSERVED_ENDPOINT_TTL_MS = 10 * 60 * 1000;
const PROFILE_MODES: readonly HdoProfileMode[] = [
  'home-only',
  'home-foreign',
  'domestic-global'
];
const RATE_LIMIT_SUBJECTS: readonly HdoRateLimitSubjectType[] = [
  'user',
  'device',
  'profile',
  'node'
];
const ARTIFACT_KINDS: readonly HdoArtifactKind[] = ['manifest', 'mihomo-yaml', 'wg-profile'];
const MEMBERSHIP_ROLES: readonly HdoMeshMembershipRole[] = ['member', 'admin', 'support'];
const MEMBERSHIP_STATUSES: readonly HdoMeshMembershipStatus[] = [
  'active',
  'suspended',
  'revoked'
];
const DEVICE_MESH_STATE_STATUSES: readonly HdoDeviceMeshStateStatus[] = [
  'active',
  'disabled',
  'kicked'
];
const DEVICE_TASK_KINDS: readonly HdoDeviceTaskKind[] = [
  'install-plugin',
  'uninstall-plugin',
  'activate-plugin',
  'deactivate-plugin',
  'apply-hdo-profile',
  'notify'
];
const DEVICE_TASK_STATUSES: readonly HdoDeviceTaskStatus[] = [
  'pending',
  'claimed',
  'done',
  'failed',
  'cancelled'
];
const HDO_DEPLOYMENT_KINDS = [
  'deploy-domestic',
  'sync-domestic-peers',
  'sync-and-repair-domestic',
  'repair-domestic-routes',
  'deploy-domestic-mihomo-wireguard',
  'deploy-oversea-mihomo-hysteria2',
  'status'
] as const;
const HDO_DEFAULT_ADDRESS_PLAN = {
  homeCidr: '100.88.0.0/16',
  userCidr: '100.89.0.0/16',
  serviceCidr: '100.90.0.0/16',
  domesticIp: '100.88.0.1',
  routeCidrs: ['100.88.0.0/16', '100.89.0.0/16', '100.90.0.0/16']
} as const;
const HDO_ADDRESS_PLAN_MIN = ipv4ToNumber('100.80.0.0') ?? 0;
const HDO_ADDRESS_PLAN_MAX = ipv4ToNumber('100.99.255.255') ?? 0;
const HDO_DEFAULT_WG_PORT = 51888;
const HDO_DEPLOYMENT_OUTPUT_LIMIT = 80_000;
const HDO_DEPLOYMENT_TIMEOUT_MS = 20 * 60 * 1000;
const HDO_RUNNER_HEALTH_TIMEOUT_MS = 1200;
const HDO_AUTO_SYNC_RETRY_MS = 30_000;

type HdoDeploymentKind = (typeof HDO_DEPLOYMENT_KINDS)[number];
type HdoDeploymentStatus = 'running' | 'succeeded' | 'failed';

interface HdoMeshAddressPlan {
  homeCidr: string;
  userCidr: string;
  serviceCidr: string;
  domesticIp: string;
  routeCidrs: string[];
}

interface HdoDeploymentJob {
  id: string;
  kind: HdoDeploymentKind;
  status: HdoDeploymentStatus;
  command: string;
  args: string[];
  scriptPath: string;
  cwd: string;
  output: string;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  error: string | null;
}

interface HdoDeploymentInvocation {
  args: string[];
  serverUrl: string;
}

const hdoDeploymentJobs = new Map<string, HdoDeploymentJob>();
let hdoDomesticSyncTimer: NodeJS.Timeout | null = null;
let hdoDomesticSyncPendingReason: string | null = null;
let hdoDomesticSyncBearerToken: string | null = null;

export async function hdoRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', attachUser);

  app.get('/api/v1/hdo/readiness', { preHandler: requireAuth }, async (req) => {
    await hdoStore.ensureDefaultProfiles();
    return buildReadiness(req.currentUser!.id);
  });

  app.get('/api/v1/hdo/devices', { preHandler: requireAuth }, async (req) => {
    return hdoStore.listDevicesForUser(req.currentUser!.id);
  });

  app.post('/api/v1/hdo/devices/register', { preHandler: requireAuth }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const id = normalizeDeviceId(asOptionalString(body.id)) ?? `hdo-dev-${randomUUID()}`;
    const existing = await hdoStore.findDevice(id);
    if (existing && existing.userId !== req.currentUser!.id) {
      reply.code(409);
      return { error: 'device id already belongs to another user' };
    }
    const label = asOptionalString(body.label) ?? 'HDO client';
    const publicKey = asOptionalString(body.publicKey) ?? existing?.publicKey ?? null;
    const [devices, meshGroups, memberships, deviceMeshStates] = await Promise.all([
      hdoStore.listAllDevices(),
      hdoStore.listMeshGroups(),
      hdoStore.listMeshMemberships(),
      hdoStore.listDeviceMeshStates()
    ]);
    const baseMeshAccess = resolveMeshAccess(req.currentUser!.id, meshGroups, memberships);
    const deviceMeshAccess = resolveMeshAccess(
      req.currentUser!.id,
      meshGroups,
      memberships,
      deviceMeshStates,
      id
    );
    if (existing && baseMeshAccess.active && !deviceMeshAccess.active) {
      reply.code(403);
      return { error: 'device is disabled or kicked from all active mesh groups' };
    }
    let overlayIp = asOptionalString(body.overlayIp) ?? existing?.overlayIp ?? null;
    if (!overlayIp && publicKey) {
      overlayIp = allocateDeviceOverlayIp(devices, id, addressPlanForMeshAccess(deviceMeshAccess).userCidr);
    }
    const metadataInput = asPlainObject(body.metadata);
    const metadata = metadataInput ? { ...(existing?.metadata ?? {}), ...metadataInput } : existing?.metadata ?? null;
    const device = await hdoStore.upsertDevice({
      id,
      userId: req.currentUser!.id,
      label,
      platform: asOptionalString(body.platform),
      publicKey,
      overlayIp,
      status: pick(body.status, NODE_STATUSES) ?? 'online',
      metadata
    });
    await ensureDeviceMeshStatesForDevice(device, meshGroups, memberships, deviceMeshStates, {
      touch: true
    });
    await auditStore.insert({
      actorUserId: req.currentUser!.id,
      actorIp: req.ip,
      action: 'hdo.device.register',
      targetKind: 'hdo_device',
      targetId: device.id,
      meta: { label: device.label, platform: device.platform }
    });
    const plugins = asPluginStates(body.plugins);
    if (plugins.length > 0) {
      await hdoStore.upsertDevicePluginStates(device.id, plugins);
    }
    if (device.publicKey && device.overlayIp && deviceMeshAccess.active) {
      scheduleHdoDomesticSync('device-register', adminBearerTokenFromRequest(req), {
        deviceId: device.id,
        userId: device.userId,
        overlayIp: device.overlayIp
      });
    }
    reply.code(201);
    return device;
  });

  app.post<{ Params: { deviceId: string } }>(
    '/api/v1/hdo/devices/:deviceId/plugin-states',
    { preHandler: requireAuth },
    async (req, reply) => {
      const device = await requireReadableDevice(req, reply, req.params.deviceId);
      if (!device) return;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const plugins = asPluginStates(body.plugins);
      const rows = await hdoStore.upsertDevicePluginStates(device.id, plugins);
      return rows;
    }
  );

  app.post<{ Params: { deviceId: string } }>(
    '/api/v1/hdo/devices/:deviceId/services',
    { preHandler: requireAuth },
    async (req, reply) => {
      const device = await requireReadableDevice(req, reply, req.params.deviceId);
      if (!device) return;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const targetPort = toPort(body.targetPort ?? body.port);
      if (!targetPort) {
        reply.code(400);
        return { error: 'valid targetPort required' };
      }
      const targetHost = normalizeOverlayIp(device.overlayIp);
      if (!targetHost) {
        reply.code(409);
        return { error: 'device overlayIp is required before publishing services' };
      }
      const [meshGroups, memberships, deviceMeshStates, services] = await Promise.all([
        hdoStore.listMeshGroups(),
        hdoStore.listMeshMemberships(),
        hdoStore.listDeviceMeshStates(),
        hdoStore.listServices()
      ]);
      const meshAccess = resolveMeshAccess(
        device.userId,
        meshGroups,
        memberships,
        deviceMeshStates,
        device.id
      );
      if (!meshAccess.active) {
        reply.code(403);
        return { error: 'device is not active in any mesh group' };
      }
      const existing = services.find((row) => isDevicePublishedService(row, device.id, targetPort));
      const existingNames = new Set(services.map((row) => row.name));
      const name = existing?.name ?? uniqueServiceName(
        serviceNameFromInput(body.name, `${device.label}-${targetPort}`),
        existingNames
      );
      const row = await hdoStore.upsertService({
        id: existing?.id ?? asOptionalString(body.id) ?? undefined,
        name,
        nodeId: null,
        targetHost,
        targetPort,
        protocol: pick(body.protocol, SERVICE_PROTOCOLS) ?? serviceProtocolForPort(targetPort),
        domains: asStringArray(body.domains),
        enabled: asOptionalBoolean(body.enabled) ?? true,
        metadata: {
          ...(existing?.metadata ?? {}),
          ...(asPlainObject(body.metadata) ?? {}),
          source: 'device-published',
          deviceId: device.id,
          userId: device.userId,
          meshGroupIds: [...meshAccess.groupIds],
          publishedAt: new Date().toISOString()
        }
      });
      await auditStore.insert({
        actorUserId: req.currentUser?.id ?? null,
        actorIp: req.ip,
        action: 'hdo.device_service.publish',
        targetKind: 'hdo_service',
        targetId: row.id,
        meta: { deviceId: device.id, targetHost: row.targetHost, targetPort: row.targetPort }
      });
      return row;
    }
  );

  app.get('/api/v1/hdo/device-tasks', { preHandler: requireAuth }, async (req) => {
    const url = new URL(req.url, 'http://localhost');
    const deviceId = url.searchParams.get('deviceId') || undefined;
    const status = pick(url.searchParams.get('status') ?? undefined, DEVICE_TASK_STATUSES);
    return hdoStore.listDeviceTasks({
      userId: req.currentUser!.id,
      deviceId,
      status: status ?? undefined
    });
  });

  app.post<{ Params: { id: string } }>(
    '/api/v1/hdo/device-tasks/:id/claim',
    { preHandler: requireAuth },
    async (req, reply) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const task = (await hdoStore.listDeviceTasks({ userId: req.currentUser!.id })).find(
        (row) => row.id === req.params.id
      );
      if (!task) {
        reply.code(404);
        return { error: 'task not found' };
      }
      if (task.status !== 'pending') {
        reply.code(409);
        return { error: `task is ${task.status}` };
      }
      const requestedDeviceId = asOptionalString(body.deviceId) ?? task.deviceId;
      let deviceId: string | null = null;
      if (requestedDeviceId) {
        const device = await requireReadableDevice(req, reply, requestedDeviceId);
        if (!device) return;
        if (task.deviceId && task.deviceId !== device.id) {
          reply.code(409);
          return { error: 'task is assigned to another device' };
        }
        deviceId = device.id;
      }
      const claimed = await hdoStore.claimDeviceTask(req.params.id, {
        deviceId,
        result: {
          claimedAt: new Date().toISOString(),
          claimedByDeviceId: deviceId
        }
      });
      if (!claimed) {
        reply.code(409);
        return { error: 'task already claimed' };
      }
      return claimed;
    }
  );

  app.post<{ Params: { id: string } }>(
    '/api/v1/hdo/device-tasks/:id/complete',
    { preHandler: requireAuth },
    async (req, reply) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const status = pick(body.status, DEVICE_TASK_STATUSES);
      if (!status || !['done', 'failed', 'cancelled'].includes(status)) {
        reply.code(400);
        return { error: 'terminal task status required' };
      }
      const task = (await hdoStore.listDeviceTasks({ userId: req.currentUser!.id })).find(
        (row) => row.id === req.params.id
      );
      if (!task) {
        reply.code(404);
        return { error: 'task not found' };
      }
      return hdoStore.completeDeviceTask(req.params.id, {
        status,
        result: asPlainObject(body.result)
      });
    }
  );

  app.get<{ Params: { deviceId: string } }>(
    '/api/v1/hdo/manifest/:deviceId',
    { preHandler: requireAuth },
    async (req, reply) => {
      const device = await requireReadableDevice(req, reply, req.params.deviceId);
      if (!device) return;
      const manifest = await buildManifest(device);
      const content = JSON.stringify(manifest, null, 2) + '\n';
      await hdoStore.saveArtifact({
        deviceId: device.id,
        kind: 'manifest',
        generation: manifest.generation,
        checksum: checksum(content),
        content,
        contentType: 'application/json'
      });
      return manifest;
    }
  );

  app.get<{ Params: { deviceId: string } }>(
    '/api/v1/hdo/subscriptions/:deviceId/mihomo.yaml',
    { preHandler: requireAuth },
    async (req, reply) => {
      const device = await requireReadableDevice(req, reply, req.params.deviceId);
      if (!device) return;
      const manifest = await buildManifest(device);
      const content = renderMihomoYaml(manifest);
      await hdoStore.saveArtifact({
        deviceId: device.id,
        kind: 'mihomo-yaml',
        generation: manifest.generation,
        checksum: checksum(content),
        content,
        contentType: 'text/yaml'
      });
      reply.type('text/yaml; charset=utf-8');
      return content;
    }
  );

  const adminOnly = { preHandler: requireRole('admin') };

  app.get('/api/v1/hdo/admin/overview', adminOnly, async () => {
    const [
      users,
      meshGroups,
      memberships,
      nodes,
      devices,
      deviceMeshStates,
      services,
      profiles,
      rateLimits,
      pluginStates,
      tasks
    ] = await Promise.all([
      usersStore.list(),
      hdoStore.listMeshGroups(),
      hdoStore.listMeshMemberships(),
      hdoStore.listNodes(),
      hdoStore.listAllDevices(),
      hdoStore.listDeviceMeshStates(),
      hdoStore.listServices(),
      hdoStore.ensureDefaultProfiles(),
      hdoStore.listRateLimits(),
      hdoStore.listDevicePluginStates(),
      hdoStore.listDeviceTasks()
    ]);
    const now = Date.now();
    const effectiveDevices = devices.map((row) => hdoDeviceWithOnlineWindow(row, now));
    return {
      users: users.map(toPublic),
      meshGroups,
      memberships,
      nodes,
      devices: effectiveDevices,
      deviceMeshStates,
      services,
      profiles,
      rateLimits,
      pluginStates,
      tasks
    };
  });

  app.get('/api/v1/hdo/admin/deployments', adminOnly, async () => {
    return {
      runner: await inspectHdoDeploymentRunner(),
      jobs: listHdoDeploymentJobs()
    };
  });

  app.post('/api/v1/hdo/admin/deployments', adminOnly, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const kind = pick(body.kind, HDO_DEPLOYMENT_KINDS);
    if (!kind) {
      reply.code(400);
      return { error: 'valid HDO deployment kind required' };
    }
    const runningJob = listHdoDeploymentJobs().find((job) => job.status === 'running');
    if (runningJob) {
      reply.code(409);
      return {
        error: `HDO deployment already running: ${runningJob.kind}`,
        job: runningJob
      };
    }
    const runnerUrl = resolveHdoGatewayRunnerUrl();
    const runnerToken = resolveHdoGatewayRunnerToken();
    const script = runnerUrl ? null : resolveHdoGatewayScript();
    if (runnerUrl && !runnerToken) {
      reply.code(409);
      return {
        error: 'HDO gateway runner token is not configured',
        detail: 'Start the stack with electron-server/scripts/manage.sh up or redeploy so the host runner token is exported into Docker Compose.'
      };
    }
    if (!runnerUrl && !script) {
      reply.code(409);
      return {
        error: 'HDO gateway runner is not available to electron-server',
        detail:
          'Set HDO_GATEWAY_RUNNER_URL/HDO_GATEWAY_RUNNER_TOKEN for the host runner, or set HDO_GATEWAY_SCRIPT when running electron-server directly on the host.'
      };
    }
    if (runnerUrl && runnerToken) {
      const runnerHealth = await probeHdoGatewayRunner(runnerUrl, runnerToken);
      if (!runnerHealth.ok) {
        reply.code(409);
        return {
          error: runnerHealth.error,
          detail: runnerHealth.detail
        };
      }
    }
    const deploymentBody = {
      ...body,
      serverUrl: asOptionalString(body.serverUrl) ?? requestBaseUrl(req) ?? undefined
    };
    const job = startHdoDeploymentJob({
      kind,
      body: deploymentBody,
      scriptPath: script,
      runnerUrl,
      bearerToken: bearerTokenFromRequest(req)
    });
    await auditStore.insert({
      actorUserId: req.currentUser?.id ?? null,
      actorIp: req.ip,
      action: 'hdo.deployment.start',
      targetKind: 'hdo_deployment',
      targetId: job.id,
      meta: { kind: job.kind, command: job.command }
    });
    reply.code(202);
    return job;
  });

  app.get('/api/v1/hdo/admin/mesh-groups', adminOnly, async () => hdoStore.listMeshGroups());

  app.post('/api/v1/hdo/admin/mesh-groups', adminOnly, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = asRequiredString(body.name);
    const slug = normalizeSlug(asOptionalString(body.slug) ?? name);
    if (!name || !slug) {
      reply.code(400);
      return { error: 'name and slug required' };
    }
    let metadata: Record<string, unknown> | null = null;
    try {
      metadata = normalizeMeshMetadata(asPlainObject(body.metadata));
    } catch (err) {
      reply.code(400);
      return { error: err instanceof Error ? err.message : String(err) };
    }
    const row = await hdoStore.upsertMeshGroup({
      id: asOptionalString(body.id) ?? undefined,
      name,
      slug,
      description: asOptionalString(body.description),
      defaultProfileId: asOptionalString(body.defaultProfileId),
      enabled: asOptionalBoolean(body.enabled) ?? true,
      metadata
    });
    await auditStore.insert({
      actorUserId: req.currentUser?.id ?? null,
      actorIp: req.ip,
      action: 'hdo.mesh_group.upsert',
      targetKind: 'hdo_mesh_group',
      targetId: row.id,
      meta: { name: row.name, slug: row.slug, enabled: row.enabled }
    });
    return row;
  });

  app.get('/api/v1/hdo/admin/memberships', adminOnly, async (req) => {
    const url = new URL(req.url, 'http://localhost');
    return hdoStore.listMeshMemberships(url.searchParams.get('meshGroupId') || undefined);
  });

  app.post('/api/v1/hdo/admin/memberships', adminOnly, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const meshGroupId = asRequiredString(body.meshGroupId);
    const userId = asRequiredString(body.userId);
    if (!meshGroupId || !userId) {
      reply.code(400);
      return { error: 'meshGroupId and userId required' };
    }
    const [groups, targetUser] = await Promise.all([
      hdoStore.listMeshGroups(),
      usersStore.findById(userId)
    ]);
    if (!targetUser) {
      reply.code(404);
      return { error: 'user not found' };
    }
    if (!groups.some((row) => row.id === meshGroupId)) {
      reply.code(404);
      return { error: 'mesh group not found' };
    }
    const row = await hdoStore.upsertMeshMembership({
      id: asOptionalString(body.id) ?? undefined,
      meshGroupId,
      userId,
      role: pick(body.role, MEMBERSHIP_ROLES) ?? 'member',
      status: pick(body.status, MEMBERSHIP_STATUSES) ?? 'active',
      profileId: asOptionalString(body.profileId),
      metadata: asPlainObject(body.metadata)
    });
    await auditStore.insert({
      actorUserId: req.currentUser?.id ?? null,
      actorIp: req.ip,
      action: 'hdo.mesh_membership.upsert',
      targetKind: 'hdo_mesh_membership',
      targetId: row.id,
      meta: { meshGroupId: row.meshGroupId, userId: row.userId, role: row.role, status: row.status }
    });
    if (row.status === 'active') {
      scheduleHdoDomesticSync('mesh-membership-active', adminBearerTokenFromRequest(req), {
        meshGroupId: row.meshGroupId,
        userId: row.userId
      });
    }
    return row;
  });

  app.get('/api/v1/hdo/admin/device-mesh-states', adminOnly, async (req) => {
    const url = new URL(req.url, 'http://localhost');
    return hdoStore.listDeviceMeshStates({
      meshGroupId: url.searchParams.get('meshGroupId') || undefined,
      deviceId: url.searchParams.get('deviceId') || undefined,
      userId: url.searchParams.get('userId') || undefined
    });
  });

  app.post('/api/v1/hdo/admin/device-mesh-states', adminOnly, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const meshGroupId = asRequiredString(body.meshGroupId);
    const deviceId = asRequiredString(body.deviceId);
    const status = pick(body.status, DEVICE_MESH_STATE_STATUSES);
    if (!meshGroupId || !deviceId || !status) {
      reply.code(400);
      return { error: 'meshGroupId, deviceId and valid status required' };
    }
    const [groups, device] = await Promise.all([
      hdoStore.listMeshGroups(),
      hdoStore.findDevice(deviceId)
    ]);
    if (!groups.some((row) => row.id === meshGroupId)) {
      reply.code(404);
      return { error: 'mesh group not found' };
    }
    if (!device) {
      reply.code(404);
      return { error: 'device not found' };
    }
    const row = await hdoStore.upsertDeviceMeshState({
      id: asOptionalString(body.id) ?? undefined,
      meshGroupId,
      deviceId,
      userId: device.userId,
      status,
      note: asOptionalString(body.note),
      metadata: asPlainObject(body.metadata),
      createdByUserId: req.currentUser?.id ?? null
    });
    await auditStore.insert({
      actorUserId: req.currentUser?.id ?? null,
      actorIp: req.ip,
      action: 'hdo.device_mesh_state.upsert',
      targetKind: 'hdo_device_mesh_state',
      targetId: row.id,
      meta: { meshGroupId: row.meshGroupId, deviceId: row.deviceId, status: row.status }
    });
    scheduleHdoDomesticSync('device-mesh-state-change', adminBearerTokenFromRequest(req), {
      meshGroupId: row.meshGroupId,
      deviceId: row.deviceId,
      status: row.status
    });
    return row;
  });

  app.get('/api/v1/hdo/admin/device-plugin-states', adminOnly, async (req) => {
    const url = new URL(req.url, 'http://localhost');
    return hdoStore.listDevicePluginStates(url.searchParams.get('deviceId') || undefined);
  });

  app.get('/api/v1/hdo/admin/device-tasks', adminOnly, async (req) => {
    const url = new URL(req.url, 'http://localhost');
    return hdoStore.listDeviceTasks({
      userId: url.searchParams.get('userId') || undefined,
      deviceId: url.searchParams.get('deviceId') || undefined,
      status: pick(url.searchParams.get('status') ?? undefined, DEVICE_TASK_STATUSES) ?? undefined
    });
  });

  app.post('/api/v1/hdo/admin/device-tasks', adminOnly, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const userId = asRequiredString(body.userId);
    const kind = pick(body.kind, DEVICE_TASK_KINDS);
    if (!userId || !kind) {
      reply.code(400);
      return { error: 'userId and valid task kind required' };
    }
    const targetUser = await usersStore.findById(userId);
    if (!targetUser) {
      reply.code(404);
      return { error: 'user not found' };
    }
    const deviceId = asOptionalString(body.deviceId);
    if (deviceId) {
      const device = await hdoStore.findDevice(deviceId);
      if (!device || device.userId !== userId) {
        reply.code(400);
        return { error: 'deviceId must belong to userId' };
      }
    }
    const row = await hdoStore.createDeviceTask({
      userId,
      deviceId,
      pluginId: asOptionalString(body.pluginId),
      kind,
      payload: asPlainObject(body.payload),
      createdByUserId: req.currentUser?.id ?? null
    });
    await auditStore.insert({
      actorUserId: req.currentUser?.id ?? null,
      actorIp: req.ip,
      action: 'hdo.device_task.create',
      targetKind: 'hdo_device_task',
      targetId: row.id,
      meta: { userId: row.userId, deviceId: row.deviceId, kind: row.kind, pluginId: row.pluginId }
    });
    return row;
  });

  app.get('/api/v1/hdo/admin/nodes', adminOnly, async () => hdoStore.listNodes());

  app.get('/api/v1/hdo/admin/wireguard/domestic-peers.conf', { preHandler: requireHdoAdminOrRunner }, async (req, reply) => {
    const content = await renderDomesticWireGuardPeers();
    reply.type('text/plain; charset=utf-8');
    return content;
  });

  app.post('/api/v1/hdo/admin/wireguard/peer-endpoints', { preHandler: requireHdoAdminOrRunner }, async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const endpoints = Array.isArray(body.endpoints) ? body.endpoints : [];
    const devices = await hdoStore.listAllDevices();
    const now = new Date().toISOString();
    const updated: Array<{ deviceId: string; endpoint: string }> = [];

    for (const item of endpoints) {
      const row = asPlainObject(item);
      const publicKey = asOptionalString(row?.publicKey);
      const endpoint = normalizeWireGuardEndpoint(asOptionalString(row?.endpoint));
      if (!publicKey || !endpoint) continue;
      const device = devices.find((candidate) => candidate.publicKey === publicKey);
      if (!device) continue;
      const metadata = withObservedWireGuardEndpoint(device.metadata, endpoint, now);
      await hdoStore.upsertDevice({
        id: device.id,
        userId: device.userId,
        label: device.label,
        platform: device.platform,
        publicKey: device.publicKey,
        overlayIp: device.overlayIp,
        status: device.status,
        metadata
      });
      updated.push({ deviceId: device.id, endpoint });
    }

    if (updated.length > 0) {
      await auditStore.insert({
        actorUserId: req.currentUser?.id ?? null,
        actorIp: req.ip,
        action: 'hdo.wireguard.peer_endpoints.observe',
        targetKind: 'hdo_wireguard_peer_endpoints',
        targetId: null,
        meta: { updated: updated.length }
      });
    }
    return { updated };
  });

  app.post('/api/v1/hdo/admin/nodes', adminOnly, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = asRequiredString(body.name);
    const kind = pick(body.kind, NODE_KINDS);
    if (!name || !kind) {
      reply.code(400);
      return { error: 'name and valid kind required' };
    }
    const id =
      asOptionalString(body.id) ??
      (await hdoStore.listNodes()).find((row) => row.kind === kind && row.name === name)?.id;
    const row = await hdoStore.upsertNode({
      id: id ?? undefined,
      name,
      kind,
      publicHost: asOptionalString(body.publicHost),
      overlayIp: asOptionalString(body.overlayIp),
      status: pick(body.status, NODE_STATUSES) ?? 'pending',
      metadata: asPlainObject(body.metadata)
    });
    await auditStore.insert({
      actorUserId: req.currentUser?.id ?? null,
      actorIp: req.ip,
      action: 'hdo.node.upsert',
      targetKind: 'hdo_node',
      targetId: row.id,
      meta: { name: row.name, kind: row.kind, status: row.status }
    });
    return row;
  });

  app.post<{ Params: { id: string } }>(
    '/api/v1/hdo/admin/nodes/:id/heartbeat',
    adminOnly,
    async (req, reply) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const row = await hdoStore.setNodeHeartbeat(req.params.id, {
        status: pick(body.status, NODE_STATUSES) ?? 'online',
        metadata: asPlainObject(body.metadata)
      });
      if (!row) {
        reply.code(404);
        return { error: 'node not found' };
      }
      return row;
    }
  );

  app.get('/api/v1/hdo/admin/services', adminOnly, async () => hdoStore.listServices());

  app.post('/api/v1/hdo/admin/services', adminOnly, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = asRequiredString(body.name);
    const targetHost = asRequiredString(body.targetHost);
    const targetPort = toPort(body.targetPort);
    if (!name || !targetHost || !targetPort) {
      reply.code(400);
      return { error: 'name, targetHost and valid targetPort required' };
    }
    const row = await hdoStore.upsertService({
      id: asOptionalString(body.id) ?? undefined,
      name,
      nodeId: asOptionalString(body.nodeId),
      targetHost,
      targetPort,
      protocol: pick(body.protocol, SERVICE_PROTOCOLS) ?? 'tcp',
      domains: asStringArray(body.domains),
      enabled: asOptionalBoolean(body.enabled) ?? true,
      metadata: asPlainObject(body.metadata)
    });
    await auditStore.insert({
      actorUserId: req.currentUser?.id ?? null,
      actorIp: req.ip,
      action: 'hdo.service.upsert',
      targetKind: 'hdo_service',
      targetId: row.id,
      meta: { name: row.name, targetHost: row.targetHost, targetPort: row.targetPort }
    });
    return row;
  });

  app.post('/api/v1/hdo/admin/services/probe', adminOnly, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const ports = asPortArray(body.ports);
    const probePorts = ports.length ? ports : [...HDO_SERVICE_PROBE_PORTS];
    const timeoutMs = clampNumber(
      Number(body.timeoutMs ?? HDO_SERVICE_PROBE_TIMEOUT_MS),
      200,
      3000,
      HDO_SERVICE_PROBE_TIMEOUT_MS
    );
    const meshGroupId = asOptionalString(body.meshGroupId);
    const [nodes, devices, services, meshGroups, memberships, deviceMeshStates] = await Promise.all([
      hdoStore.listNodes(),
      hdoStore.listAllDevices(),
      hdoStore.listServices(),
      hdoStore.listMeshGroups(),
      hdoStore.listMeshMemberships(),
      hdoStore.listDeviceMeshStates()
    ]);
    const enabledGroups = meshGroups.filter((row) => row.enabled);
    const targetMeshGroupIds = meshGroupId
      ? new Set(enabledGroups.filter((row) => row.id === meshGroupId).map((row) => row.id))
      : new Set(enabledGroups.map((row) => row.id));
    if (meshGroupId && targetMeshGroupIds.size === 0) {
      reply.code(404);
      return { error: 'mesh group not found or disabled' };
    }

    const targets = serviceProbeTargets(
      nodes,
      devices,
      meshGroups,
      memberships,
      deviceMeshStates,
      targetMeshGroupIds
    );
    const existingNames = new Set(services.map((row) => row.name));
    const checked = await Promise.all(
      targets.flatMap((target) =>
        probePorts.map(async (port) => ({
          target,
          port,
          open: await probeTcpPort(target.host, port, timeoutMs)
        }))
      )
    );
    const openChecks = checked.filter((row) => row.open);
    const upserted: HdoServiceRow[] = [];
    for (const check of openChecks) {
      const existing = services.find((row) => isServerProbedService(row, check.target.host, check.port));
      const name = existing?.name ?? uniqueServiceName(
        serviceNameFromInput(null, `${check.target.label}-${check.port}`),
        existingNames
      );
      const row = await hdoStore.upsertService({
        id: existing?.id,
        name,
        nodeId: check.target.type === 'node' ? check.target.id : null,
        targetHost: check.target.host,
        targetPort: check.port,
        protocol: serviceProtocolForPort(check.port),
        domains: existing?.domains ?? [],
        enabled: true,
        metadata: {
          ...(existing?.metadata ?? {}),
          source: 'server-probe',
          targetType: check.target.type,
          targetId: check.target.id,
          deviceId: check.target.type === 'device' ? check.target.id : undefined,
          userId: check.target.userId ?? undefined,
          meshGroupIds: check.target.meshGroupIds,
          probedAt: new Date().toISOString()
        }
      });
      upserted.push(row);
      existingNames.add(row.name);
    }
    await auditStore.insert({
      actorUserId: req.currentUser?.id ?? null,
      actorIp: req.ip,
      action: 'hdo.service.probe',
      targetKind: 'hdo_service',
      targetId: null,
      meta: {
        ports: probePorts,
        timeoutMs,
        meshGroupId: meshGroupId ?? null,
        checked: checked.length,
        open: upserted.length
      }
    });
    return {
      ports: probePorts,
      timeoutMs,
      targetCount: targets.length,
      checked: checked.length,
      open: openChecks.length,
      services: upserted
    };
  });

  app.get('/api/v1/hdo/admin/profiles', adminOnly, async () => {
    return hdoStore.ensureDefaultProfiles();
  });

  app.post('/api/v1/hdo/admin/profiles', adminOnly, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = asRequiredString(body.name);
    const mode = pick(body.mode, PROFILE_MODES);
    if (!name || !mode) {
      reply.code(400);
      return { error: 'name and valid mode required' };
    }
    const row = await hdoStore.upsertProfile({
      id: asOptionalString(body.id) ?? undefined,
      name,
      mode,
      enabled: asOptionalBoolean(body.enabled) ?? true,
      rules: asPlainObject(body.rules),
      metadata: asPlainObject(body.metadata)
    });
    await auditStore.insert({
      actorUserId: req.currentUser?.id ?? null,
      actorIp: req.ip,
      action: 'hdo.profile.upsert',
      targetKind: 'hdo_profile',
      targetId: row.id,
      meta: { name: row.name, mode: row.mode }
    });
    return row;
  });

  app.get('/api/v1/hdo/admin/rate-limits', adminOnly, async () => hdoStore.listRateLimits());

  app.post('/api/v1/hdo/admin/rate-limits', adminOnly, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const subjectType = pick(body.subjectType, RATE_LIMIT_SUBJECTS);
    const subjectId = asRequiredString(body.subjectId);
    if (!subjectType || !subjectId) {
      reply.code(400);
      return { error: 'subjectType and subjectId required' };
    }
    const row = await hdoStore.upsertRateLimit({
      id: asOptionalString(body.id) ?? undefined,
      subjectType,
      subjectId,
      downRate: asOptionalString(body.downRate),
      downCeil: asOptionalString(body.downCeil),
      upRate: asOptionalString(body.upRate),
      upCeil: asOptionalString(body.upCeil),
      metadata: asPlainObject(body.metadata)
    });
    await auditStore.insert({
      actorUserId: req.currentUser?.id ?? null,
      actorIp: req.ip,
      action: 'hdo.rate_limit.upsert',
      targetKind: 'hdo_rate_limit',
      targetId: row.id,
      meta: {
        subjectType: row.subjectType,
        subjectId: row.subjectId,
        downRate: row.downRate,
        upRate: row.upRate
      }
    });
    return row;
  });

  app.get<{ Params: { deviceId: string; kind: HdoArtifactKind } }>(
    '/api/v1/hdo/admin/artifacts/:deviceId/:kind',
    adminOnly,
    async (req, reply) => {
      const kind = pick(req.params.kind, ARTIFACT_KINDS);
      if (!kind) {
        reply.code(400);
        return { error: 'valid artifact kind required' };
      }
      const row = await hdoStore.latestArtifact(req.params.deviceId, kind);
      if (!row) {
        reply.code(404);
        return { error: 'artifact not found' };
      }
      return row;
    }
  );
}

async function inspectHdoDeploymentRunner() {
  const runnerUrl = resolveHdoGatewayRunnerUrl();
  const runnerToken = resolveHdoGatewayRunnerToken();
  if (runnerUrl) {
    if (!runnerToken) {
      return {
        available: false,
        mode: 'host-runner',
        scriptPath: runnerUrl,
        cwd: null,
        kinds: HDO_DEPLOYMENT_KINDS,
        note: 'HDO_GATEWAY_RUNNER_URL is set, but HDO_GATEWAY_RUNNER_TOKEN is missing. Start through electron-server/scripts/manage.sh.'
      };
    }
    const health = await probeHdoGatewayRunner(runnerUrl, runnerToken);
    return {
      available: health.ok,
      mode: 'host-runner',
      scriptPath: runnerUrl,
      cwd: null,
      kinds: HDO_DEPLOYMENT_KINDS,
      note: health.ok
        ? 'HDO deployment runner calls the host gateway runner for whitelisted actions.'
        : `${health.error}: ${health.detail}`
    };
  }
  const scriptPath = resolveHdoGatewayScript();
  return {
    available: Boolean(scriptPath),
    mode: 'local-script',
    scriptPath,
    cwd: scriptPath ? resolve(dirname(scriptPath), '../..') : null,
    kinds: HDO_DEPLOYMENT_KINDS,
    note: scriptPath
      ? 'HDO deployment runner can execute whitelisted gateway actions.'
      : 'HDO gateway script is not visible from electron-server. Set HDO_GATEWAY_RUNNER_URL/TOKEN for Docker, or HDO_GATEWAY_SCRIPT for direct host runs.'
  };
}

function listHdoDeploymentJobs(): HdoDeploymentJob[] {
  return [...hdoDeploymentJobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

function scheduleHdoDomesticSync(
  reason: string,
  bearerToken: string | null,
  meta: Record<string, unknown>
): void {
  if (process.env.HDO_AUTO_SYNC_DOMESTIC === 'false') return;
  if (!hdoGatewayRunnerAvailable()) return;
  hdoDomesticSyncPendingReason = reason;
  hdoDomesticSyncBearerToken = bearerToken ?? hdoDomesticSyncBearerToken;
  if (hdoDomesticSyncTimer) clearTimeout(hdoDomesticSyncTimer);
  hdoDomesticSyncTimer = setTimeout(() => {
    hdoDomesticSyncTimer = null;
    void startQueuedHdoDomesticSync(meta);
  }, 1500);
}

async function startQueuedHdoDomesticSync(
  meta: Record<string, unknown>
): Promise<HdoDeploymentJob | null> {
  if (listHdoDeploymentJobs().some((job) => job.status === 'running')) {
    if (!hdoDomesticSyncTimer) {
      hdoDomesticSyncTimer = setTimeout(() => {
        hdoDomesticSyncTimer = null;
        void startQueuedHdoDomesticSync({ ...meta, delayed: true });
      }, 5000);
    }
    return null;
  }
  const runnerUrl = resolveHdoGatewayRunnerUrl();
  const runnerToken = resolveHdoGatewayRunnerToken();
  const script = runnerUrl ? null : resolveHdoGatewayScript();
  if ((runnerUrl && !runnerToken) || (!runnerUrl && !script)) return null;
  const bearerToken = hdoDomesticSyncBearerToken;
  if (!bearerToken && !runnerToken) return null;
  const reason = hdoDomesticSyncPendingReason ?? 'auto';
  if (runnerUrl && runnerToken) {
    const runnerHealth = await probeHdoGatewayRunner(runnerUrl, runnerToken);
    if (!runnerHealth.ok) {
      hdoDomesticSyncPendingReason = reason;
      hdoDomesticSyncBearerToken = bearerToken ?? hdoDomesticSyncBearerToken;
      if (!hdoDomesticSyncTimer) {
        hdoDomesticSyncTimer = setTimeout(() => {
          hdoDomesticSyncTimer = null;
          void startQueuedHdoDomesticSync({
            ...meta,
            delayed: true,
            runnerUnavailable: true
          });
        }, HDO_AUTO_SYNC_RETRY_MS);
      }
      return null;
    }
  }
  hdoDomesticSyncPendingReason = null;
  const job = startHdoDeploymentJob({
    kind: 'sync-and-repair-domestic',
    body: {
      reason,
      auto: true,
      meta
    },
    scriptPath: script,
    runnerUrl,
    bearerToken
  });
  hdoDomesticSyncBearerToken = null;
  void auditStore.insert({
    actorUserId: null,
    actorIp: null,
    action: 'hdo.deployment.auto_start',
    targetKind: 'hdo_deployment',
    targetId: job.id,
    meta: { kind: job.kind, reason, ...meta }
  });
  return job;
}

function hdoGatewayRunnerAvailable(): boolean {
  const runnerUrl = resolveHdoGatewayRunnerUrl();
  if (runnerUrl) return Boolean(resolveHdoGatewayRunnerToken());
  return Boolean(resolveHdoGatewayScript());
}

function resolveHdoGatewayScript(): string | null {
  const configured = asOptionalString(process.env.HDO_GATEWAY_SCRIPT);
  const candidates = configured
    ? [configured]
    : [
        resolve(process.cwd(), '../docker/hdo-gateway-stack/manage.sh'),
        resolve(process.cwd(), 'docker/hdo-gateway-stack/manage.sh'),
        resolve(process.cwd(), '../../docker/hdo-gateway-stack/manage.sh')
      ];
  for (const candidate of candidates) {
    const scriptPath = resolve(candidate);
    if (existsSync(scriptPath)) return scriptPath;
  }
  return null;
}

function resolveHdoGatewayRunnerUrl(): string | null {
  const configured = asOptionalString(process.env.HDO_GATEWAY_RUNNER_URL);
  if (!configured) return null;
  try {
    const url = new URL(configured);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function resolveHdoGatewayRunnerToken(): string | null {
  return asOptionalString(process.env.HDO_GATEWAY_RUNNER_TOKEN);
}

function resolveHdoGatewayServerUrl(): string | null {
  const configured = asOptionalString(process.env.HDO_GATEWAY_SERVER_URL);
  if (!configured) return null;
  try {
    const url = new URL(configured);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

async function probeHdoGatewayRunner(
  runnerUrl: string,
  runnerToken: string
): Promise<{ ok: true } | { ok: false; error: string; detail: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HDO_RUNNER_HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(new URL('/healthz', runnerUrl), {
      headers: {
        authorization: `Bearer ${runnerToken}`
      },
      signal: controller.signal
    });
    const text = await response.text();
    const payload = parseJsonObject(text);
    if (!response.ok) {
      return {
        ok: false,
        error: 'HDO gateway runner health check failed',
        detail: asOptionalString(payload.error) ?? `HTTP ${response.status}`
      };
    }
    if (payload.ok !== true) {
      return {
        ok: false,
        error: 'HDO gateway runner health check failed',
        detail: text || 'healthz did not return ok=true'
      };
    }
    return { ok: true };
  } catch (err) {
    const detail =
      err instanceof Error && err.name === 'AbortError'
        ? `timed out after ${HDO_RUNNER_HEALTH_TIMEOUT_MS}ms`
        : err instanceof Error
          ? err.message
          : String(err);
    return {
      ok: false,
      error: 'HDO gateway runner is not reachable from electron-server',
      detail:
        `${detail}. Run ./scripts/manage.sh server gateway-runner-status on the host; ` +
        'if electron-server runs in Docker, the runner must listen on an address reachable from host.docker.internal.'
    };
  } finally {
    clearTimeout(timeout);
  }
}

function startHdoDeploymentJob(input: {
  kind: HdoDeploymentKind;
  body: Record<string, unknown>;
  scriptPath: string | null;
  runnerUrl: string | null;
  bearerToken: string | null;
}): HdoDeploymentJob {
  const invocation = buildHdoDeploymentInvocation(input.kind, input.body);
  const cwd = input.scriptPath ? resolve(dirname(input.scriptPath), '../..') : 'host-gateway-runner';
  const scriptPath = input.scriptPath ?? input.runnerUrl ?? '';
  const id = `hdo-deploy-${randomUUID()}`;
  const job: HdoDeploymentJob = {
    id,
    kind: input.kind,
    status: 'running',
    command: input.runnerUrl
      ? formatCommand(['hdo-gateway-runner', input.runnerUrl, ...invocation.args])
      : formatCommand(['bash', scriptPath, ...invocation.args]),
    args: invocation.args,
    scriptPath,
    cwd,
    output: '',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    error: null
  };
  hdoDeploymentJobs.set(job.id, job);
  pruneHdoDeploymentJobs();

  if (input.runnerUrl) {
    void runHdoGatewayRunnerJob(job, input.runnerUrl, invocation, input.bearerToken);
    return job;
  }

  if (!input.scriptPath) {
    job.status = 'failed';
    job.error = 'HDO gateway script is not configured';
    job.finishedAt = new Date().toISOString();
    return job;
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HDO_SERVER_URL: invocation.serverUrl
  };
  if (input.bearerToken) {
    env.HDO_TOKEN = input.bearerToken;
  }

  const child = spawn('bash', [input.scriptPath, ...invocation.args], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const timeout = setTimeout(() => {
    if (job.finishedAt) return;
    job.status = 'failed';
    job.error = `command timed out after ${Math.round(HDO_DEPLOYMENT_TIMEOUT_MS / 60000)} minutes`;
    job.finishedAt = new Date().toISOString();
    child.kill('SIGTERM');
  }, HDO_DEPLOYMENT_TIMEOUT_MS);

  child.stdout.on('data', (chunk) => appendDeploymentOutput(job, chunk));
  child.stderr.on('data', (chunk) => appendDeploymentOutput(job, chunk));
  child.on('error', (err) => {
    clearTimeout(timeout);
    job.status = 'failed';
    job.error = err.message;
    job.finishedAt = new Date().toISOString();
  });
  child.on('close', (code) => {
    clearTimeout(timeout);
    if (job.finishedAt) return;
    job.exitCode = code;
    job.status = code === 0 ? 'succeeded' : 'failed';
    job.finishedAt = new Date().toISOString();
    if (code !== 0 && !job.error) job.error = `command exited with ${code ?? 'unknown status'}`;
  });

  return job;
}

async function runHdoGatewayRunnerJob(
  job: HdoDeploymentJob,
  runnerUrl: string,
  invocation: HdoDeploymentInvocation,
  bearerToken: string | null
): Promise<void> {
  const runnerToken = resolveHdoGatewayRunnerToken();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HDO_DEPLOYMENT_TIMEOUT_MS);
  try {
    if (!runnerToken) {
      throw new Error('HDO_GATEWAY_RUNNER_TOKEN is not configured');
    }
    const response = await fetch(new URL('/run', runnerUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${runnerToken}`
      },
      body: JSON.stringify({
        args: invocation.args,
        serverUrl: invocation.serverUrl,
        bearerToken
      }),
      signal: controller.signal
    });
    const text = await response.text();
    const payload = parseJsonObject(text);
    const output = asOptionalString(payload.output) ?? text;
    if (output) appendDeploymentOutput(job, output);
    const exitCode =
      typeof payload.exitCode === 'number' && Number.isFinite(payload.exitCode)
        ? payload.exitCode
        : response.ok
          ? 0
          : 1;
    job.exitCode = exitCode;
    job.status = response.ok && exitCode === 0 ? 'succeeded' : 'failed';
    job.error =
      job.status === 'succeeded'
        ? null
        : asOptionalString(payload.error) ?? `HDO gateway runner returned HTTP ${response.status}`;
  } catch (err) {
    const message =
      err instanceof Error && err.name === 'AbortError'
        ? `HDO gateway runner timed out after ${Math.round(HDO_DEPLOYMENT_TIMEOUT_MS / 60000)} minutes`
        : err instanceof Error
          ? err.message
          : String(err);
    appendDeploymentOutput(
      job,
      [
        `HDO gateway runner request failed: ${runnerUrl}`,
        message,
        'If electron-server runs in Docker, the host runner must listen on an address reachable from host.docker.internal.',
        'This is a private host/Docker control port; do not open port 18081 in the cloud security group.',
        'On the host, run: ./electron-server/scripts/manage.sh gateway-runner-status'
      ].join('\n') + '\n'
    );
    job.status = 'failed';
    job.error = message;
  } finally {
    clearTimeout(timeout);
    job.finishedAt = new Date().toISOString();
  }
}

function appendDeploymentOutput(job: HdoDeploymentJob, chunk: Buffer | string): void {
  const next = job.output + chunk.toString();
  job.output =
    next.length > HDO_DEPLOYMENT_OUTPUT_LIMIT
      ? next.slice(next.length - HDO_DEPLOYMENT_OUTPUT_LIMIT)
      : next;
}

function buildHdoDeploymentInvocation(
  kind: HdoDeploymentKind,
  body: Record<string, unknown>
): HdoDeploymentInvocation {
  // The browser-facing control-plane URL can be unroutable from the host runner.
  const serverUrl =
    resolveHdoGatewayServerUrl() ??
    asOptionalString(body.serverUrl) ??
    asOptionalString(process.env.HDO_SERVER_URL) ??
    `http://127.0.0.1:${asOptionalString(process.env.PORT) ?? '8080'}`;
  if (kind === 'deploy-domestic') {
    const args = ['deploy-domestic', '--yes', '--server-url', serverUrl];
    const publicHost = asOptionalString(body.publicHost);
    const port = toPort(body.port) ?? toPort(body.listenPort) ?? HDO_DEFAULT_WG_PORT;
    if (publicHost) args.push('--public-host', publicHost);
    args.push('--port', String(port));
    if (asOptionalBoolean(body.noApply)) args.push('--no-apply');
    if (asOptionalBoolean(body.noEgress)) args.push('--no-egress');
    return { args, serverUrl };
  }
  if (kind === 'sync-domestic-peers') {
    return { args: ['sync-peers', '--server-url', serverUrl], serverUrl };
  }
  if (kind === 'sync-and-repair-domestic') {
    return { args: ['sync-and-repair-domestic', '--server-url', serverUrl], serverUrl };
  }
  if (kind === 'status') {
    return { args: ['status'], serverUrl };
  }
  return { args: [kind], serverUrl };
}

function pruneHdoDeploymentJobs(): void {
  const jobs = listHdoDeploymentJobs();
  for (const job of jobs.slice(20)) {
    if (job.status !== 'running') hdoDeploymentJobs.delete(job.id);
  }
}

function formatCommand(parts: string[]): string {
  return parts.map(shellQuote).join(' ');
}

function shellQuote(value: string): string {
  if (/^[a-zA-Z0-9_./:=@+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function bearerTokenFromRequest(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

function adminBearerTokenFromRequest(req: FastifyRequest): string | null {
  return req.currentUser?.role === 'admin' ? bearerTokenFromRequest(req) : null;
}

async function requireHdoAdminOrRunner(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (req.currentUser?.role === 'admin') return;
  const configured = resolveHdoGatewayRunnerToken();
  const provided = headerString(req.headers['x-hdo-runner-token']);
  if (configured && provided && configured === provided) return;
  reply.code(req.currentUser ? 403 : 401);
  throw new Error('admin or HDO runner token required');
}

function requestBaseUrl(req: FastifyRequest): string | null {
  const host = headerString(req.headers['x-forwarded-host']) ?? headerString(req.headers.host);
  if (!host) return null;
  const proto = headerString(req.headers['x-forwarded-proto']) ?? 'http';
  return `${proto.split(',')[0]?.trim() || 'http'}://${host.split(',')[0]?.trim() || host}`;
}

function headerString(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return asOptionalString(value[0]);
  return asOptionalString(value);
}

async function renderDomesticWireGuardPeers(): Promise<string> {
  const [devices, nodes, meshGroups, memberships, deviceMeshStates] = await Promise.all([
    hdoStore.listAllDevices(),
    hdoStore.listNodes(),
    hdoStore.listMeshGroups(),
    hdoStore.listMeshMemberships(),
    hdoStore.listDeviceMeshStates()
  ]);
  const lines = [
    '# BEGIN_HDO_MANAGED_PEERS',
    '# Generated by electron-server. Manual edits inside this block will be replaced.'
  ];
  const seen = new Set<string>();

  for (const node of nodes.filter((row) => row.kind === 'home')) {
    const publicKey = wireGuardPublicKeyFromMetadata(node.metadata);
    const overlayIp = normalizeOverlayIp(node.overlayIp);
    if (!publicKey || !overlayIp || seen.has(publicKey)) continue;
    seen.add(publicKey);
    lines.push('', `# HDO member ${node.name}`, '[Peer]');
    lines.push(`PublicKey = ${publicKey}`);
    lines.push(`AllowedIPs = ${overlayIp}/32`);
    lines.push('PersistentKeepalive = 25');
  }

  for (const device of devices) {
    const overlayIp = normalizeOverlayIp(device.overlayIp);
    if (!device.publicKey || !overlayIp || seen.has(device.publicKey)) continue;
    const meshAccess = resolveMeshAccess(device.userId, meshGroups, memberships, deviceMeshStates, device.id);
    if (!meshAccess.active) continue;
    seen.add(device.publicKey);
    lines.push('', `# HDO client ${device.label} (${device.id})`, '[Peer]');
    lines.push(`PublicKey = ${device.publicKey}`);
    lines.push(`AllowedIPs = ${overlayIp}/32`);
    lines.push('PersistentKeepalive = 25');
  }

  lines.push('', '# END_HDO_MANAGED_PEERS');
  return lines.join('\n') + '\n';
}

async function buildReadiness(userId: string) {
  let [
    generation,
    nodes,
    devices,
    services,
    profiles,
    rateLimits,
    meshGroups,
    memberships
  ] = await Promise.all([
    hdoStore.getGeneration(),
    hdoStore.listNodes(),
    hdoStore.listDevicesForUser(userId),
    hdoStore.listServices(),
    hdoStore.ensureDefaultProfiles(),
    hdoStore.listRateLimits(),
    hdoStore.listMeshGroups(),
    hdoStore.listMeshMemberships()
  ]);
  const meshAccess = resolveMeshAccess(userId, meshGroups, memberships);
  const enabledServices = services.filter((row) => row.enabled);
  const completed: string[] = [];
  const nextActions: string[] = [];
  const blockers: string[] = [];

  if (meshAccess.active) {
    completed.push(`Mesh license active: ${meshAccess.groups.map((row) => row.name).join(', ')}`);
  } else {
    nextActions.push('Ask an admin to grant this user an active HDO mesh license');
    blockers.push('No active HDO mesh license');
  }

  if (devices.length) completed.push('HDO client device registered');
  else nextActions.push('Open the HDO plugin client and register this device');

  for (const kind of NODE_KINDS) {
    const node = nodes.find((row) => row.kind === kind);
    if (node) completed.push(`${kind} node configured`);
    else {
      nextActions.push(`Add the ${kind} node from the server panel`);
      blockers.push(`${kind} node missing`);
    }
  }

  if (enabledServices.length) completed.push('At least one HDO service configured');
  else nextActions.push('Add H member or oversea services that clients should receive');

  if (profiles.some((row) => row.enabled)) completed.push('Routing profiles are ready');
  else blockers.push('No enabled routing profile');

  if (rateLimits.length) completed.push('Server-side rate limit records configured');
  else nextActions.push('Optionally set per-user or per-device rate limits');

  if (devices[0]) {
    const [manifest, mihomo] = await Promise.all([
      hdoStore.latestArtifact(devices[0].id, 'manifest'),
      hdoStore.latestArtifact(devices[0].id, 'mihomo-yaml')
    ]);
    if (manifest && mihomo) completed.push('Client manifest and subscription have been generated');
    else nextActions.push('Fetch the client manifest and Mihomo subscription once nodes are ready');
  }

  return {
    generation,
    completed,
    nextActions,
    blockers,
    summary: {
      nodes: {
        total: nodes.length,
        domestic: nodes.filter((row) => row.kind === 'domestic').length,
        home: nodes.filter((row) => row.kind === 'home').length,
        oversea: nodes.filter((row) => row.kind === 'oversea').length
      },
      devices: devices.length,
      services: enabledServices.length,
      profiles: profiles.filter((row) => row.enabled).length,
      rateLimits: rateLimits.length,
      mesh: {
        licensed: meshAccess.active,
        groups: meshGroups.length,
        activeGroups: meshAccess.groups.length,
        memberships: meshAccess.memberships.length
      }
    }
  };
}

async function buildManifest(device: HdoDeviceRow) {
  await hdoStore.ensureDefaultProfiles();
  let [
    generation,
    nodes,
    devices,
    services,
    profiles,
    rateLimits,
    meshGroups,
    memberships,
    initialDeviceMeshStates
  ] = await Promise.all([
    hdoStore.getGeneration(),
    hdoStore.listNodes(),
    hdoStore.listAllDevices(),
    hdoStore.listServices(),
    hdoStore.ensureDefaultProfiles(),
    hdoStore.listRateLimits(),
    hdoStore.listMeshGroups(),
    hdoStore.listMeshMemberships(),
    hdoStore.listDeviceMeshStates()
  ]);
  const deviceMeshStates = await ensureDeviceMeshStatesForDevice(
    device,
    meshGroups,
    memberships,
    initialDeviceMeshStates
  );
  generation = await hdoStore.getGeneration();
  const meshAccess = resolveMeshAccess(device.userId, meshGroups, memberships, deviceMeshStates, device.id);
  const addressPlan = addressPlanForMeshAccess(meshAccess);
  const visibleNodes = meshAccess.active
    ? nodes.filter((row) => isVisibleForMesh(row.metadata, meshAccess.groupIds))
    : [];
  const visibleDevices = meshAccess.active
    ? devices.filter((row) => {
        if (row.id === device.id) return true;
        const otherAccess = resolveMeshAccess(row.userId, meshGroups, memberships, deviceMeshStates, row.id);
        return otherAccess.groups.some((group) => meshAccess.groupIds.has(group.id));
      })
    : [];
  const visibleNodeIds = new Set(visibleNodes.map((row) => row.id));
  const visibleServices = meshAccess.active
    ? services.filter(
        (row) =>
          row.enabled &&
          (!row.nodeId || visibleNodeIds.has(row.nodeId)) &&
          isVisibleForMesh(row.metadata, meshAccess.groupIds)
      )
    : [];
  const visibleProfiles = meshAccess.active
    ? pickProfilesForMesh(profiles, meshAccess)
    : [];
  const visibleProfileIds = new Set(visibleProfiles.map((row) => row.id));

  return {
    version: 1,
    generation,
    updatedAt: new Date().toISOString(),
    device,
    license: {
      active: meshAccess.active,
      groups: meshAccess.groups.map((row) => ({
        id: row.id,
        name: row.name,
        slug: row.slug
      })),
      memberships: meshAccess.memberships.map((row) => ({
        id: row.id,
        meshGroupId: row.meshGroupId,
        role: row.role,
        status: row.status,
        profileId: row.profileId
      }))
    },
    mesh: {
      groups: meshAccess.groups,
      memberships: meshAccess.memberships,
      deviceStates: deviceMeshStates.filter((row) => row.deviceId === device.id)
    },
    wireGuard: {
      addressPlan,
      routeCidrs: addressPlan.routeCidrs,
      client: {
        publicKey: device.publicKey,
        overlayIp: device.overlayIp,
        address: device.overlayIp ? wireGuardAddress(device.overlayIp) : null
      },
      domestic: wireGuardNodeSummary(pickDomesticNode(visibleNodes)),
      directPeers: wireGuardDirectPeerSummaries(device, visibleDevices)
    },
    nodes: visibleNodes,
    devices: visibleDevices.map((row) => hdoDeviceWithOnlineWindow(row)).map((row) => ({
      id: row.id,
      userId: row.userId,
      label: row.label,
      platform: row.platform,
      publicKey: row.publicKey,
      overlayIp: row.overlayIp,
      status: row.status,
      lastSeenAt: row.lastSeenAt,
      createdAt: row.createdAt
    })),
    services: visibleServices,
    profiles: visibleProfiles,
    rateLimits: rateLimits.filter(
      (row) =>
        (row.subjectType === 'device' && row.subjectId === device.id) ||
        (row.subjectType === 'user' && row.subjectId === device.userId) ||
        (row.subjectType === 'profile' && visibleProfileIds.has(row.subjectId)) ||
        (row.subjectType === 'node' && visibleNodeIds.has(row.subjectId))
    )
  };
}

function hdoDeviceWithOnlineWindow(row: HdoDeviceRow, nowMs = Date.now()): HdoDeviceRow {
  if (row.status !== 'online') return row;
  const lastSeenMs = row.lastSeenAt ? Date.parse(row.lastSeenAt) : NaN;
  if (Number.isFinite(lastSeenMs) && nowMs - lastSeenMs <= HDO_DEVICE_ONLINE_WINDOW_MS) return row;
  return {
    ...row,
    status: 'offline'
  };
}

function renderMihomoYaml(manifest: Awaited<ReturnType<typeof buildManifest>>): string {
  const domestic = manifest.nodes.find((row) => row.kind === 'domestic');
  const metadataProxy = asPlainObject(domestic?.metadata?.mihomoProxy);
  const proxyName = asOptionalString(metadataProxy?.name) ?? 'HDO-DOMESTIC';
  const proxies = metadataProxy ? [{ ...metadataProxy, name: proxyName }] : [];
  const groupMembers = proxies.length ? [proxyName, 'DIRECT'] : ['DIRECT'];
  const rules = new Set<string>();

  for (const service of manifest.services) {
    for (const domain of service.domains) {
      rules.add(`DOMAIN-SUFFIX,${domain},HDO`);
    }
    if (isIpv4(service.targetHost)) {
      rules.add(`IP-CIDR,${service.targetHost}/32,HDO,no-resolve`);
    }
  }
  rules.add('IP-CIDR,100.88.0.0/16,HDO,no-resolve');
  rules.add('IP-CIDR,100.89.0.0/16,HDO,no-resolve');
  rules.add('IP-CIDR,100.90.0.0/16,HDO,no-resolve');
  rules.add('GEOIP,CN,DIRECT');
  rules.add('MATCH,DIRECT');

  const lines = [
    '# Generated by QPJoy HDO control plane.',
    `# generation: ${manifest.generation}`,
    'mixed-port: 7890',
    'allow-lan: false',
    'mode: rule',
    'log-level: info',
    'dns:',
    '  enable: true',
    '  enhanced-mode: fake-ip',
    '  nameserver:',
    '    - https://223.5.5.5/dns-query'
  ];
  if (proxies.length) {
    lines.push('proxies:');
    for (const proxy of proxies) pushYamlObject(lines, proxy, 2, true);
  } else {
    lines.push('proxies: []');
  }
  lines.push('proxy-groups:');
  pushYamlObject(
    lines,
    {
      name: 'HDO',
      type: 'select',
      proxies: groupMembers
    },
    2,
    true
  );
  lines.push('rules:');
  for (const rule of rules) lines.push(`  - ${rule}`);
  return lines.join('\n') + '\n';
}

async function requireReadableDevice(
  req: FastifyRequest,
  reply: FastifyReply,
  deviceId: string
): Promise<HdoDeviceRow | null> {
  const device = await hdoStore.findDevice(deviceId);
  if (!device) {
    reply.code(404);
    return null;
  }
  const user = req.currentUser!;
  if (user.role !== 'admin' && device.userId !== user.id) {
    reply.code(403);
    return null;
  }
  return device;
}

function checksum(content: string): string {
  return 'sha256:' + createHash('sha256').update(content).digest('hex');
}

function asRequiredString(value: unknown): string {
  return asOptionalString(value) ?? '';
}

function asOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function asOptionalBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => asOptionalString(item))
    .filter((item): item is string => Boolean(item));
}

function asPortArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(
    value
      .map((item) => toPort(item))
      .filter((item): item is number => Boolean(item))
      .map((item) => String(item))
  ).map((item) => Number(item));
}

function asPlainObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return asPlainObject(parsed) ?? {};
  } catch {
    return {};
  }
}

function pick<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && allowed.includes(value as T) ? (value as T) : null;
}

function toPort(value: unknown): number | null {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}

function normalizeDeviceId(value: string | null): string | null {
  if (!value) return null;
  return /^[a-zA-Z0-9._:-]{1,128}$/.test(value) ? value : null;
}

function normalizeSlug(value: string | null): string | null {
  if (!value) return null;
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || null;
}

function normalizeIdentifier(value: string | null): string | null {
  if (!value || value.length > 256) return null;
  return /^[a-zA-Z0-9@._:/-]+$/.test(value) ? value : null;
}

function asPluginStates(value: unknown): Array<{
  pluginId: string;
  npm?: string | null;
  name?: string | null;
  version?: string | null;
  state: string;
  manifest?: Record<string, unknown> | null;
  health?: Record<string, unknown> | null;
}> {
  if (!Array.isArray(value)) return [];
  const out: Array<{
    pluginId: string;
    npm?: string | null;
    name?: string | null;
    version?: string | null;
    state: string;
    manifest?: Record<string, unknown> | null;
    health?: Record<string, unknown> | null;
  }> = [];
  for (const item of value) {
    const row = asPlainObject(item);
    if (!row) continue;
    const manifest = asPlainObject(row.manifest);
    const pluginId = normalizeIdentifier(
      asOptionalString(row.pluginId) ?? asOptionalString(row.id) ?? asOptionalString(manifest?.id)
    );
    if (!pluginId) continue;
    out.push({
      pluginId,
      npm: asOptionalString(row.npm),
      name: asOptionalString(row.name) ?? asOptionalString(manifest?.name),
      version: asOptionalString(row.version) ?? asOptionalString(manifest?.version),
      state: (asOptionalString(row.state) ?? 'unknown').slice(0, 64),
      manifest,
      health: asPlainObject(row.health)
    });
  }
  return out;
}

function resolveMeshAccess(
  userId: string,
  meshGroups: HdoMeshGroupRow[],
  memberships: HdoMeshMembershipRow[],
  deviceMeshStates: HdoDeviceMeshStateRow[] = [],
  deviceId?: string
) {
  const enabledGroups = new Map(meshGroups.filter((row) => row.enabled).map((row) => [row.id, row]));
  const activeMemberships = memberships.filter(
    (row) =>
      row.userId === userId &&
      row.status === 'active' &&
      enabledGroups.has(row.meshGroupId) &&
      deviceMeshStateAllows(deviceMeshStates, row.meshGroupId, deviceId)
  );
  const groupMap = new Map<string, HdoMeshGroupRow>();
  for (const membership of activeMemberships) {
    const group = enabledGroups.get(membership.meshGroupId);
    if (group) groupMap.set(group.id, group);
  }
  const groups = [...groupMap.values()];
  const preferredProfileIds = new Set<string>();
  for (const membership of activeMemberships) {
    if (membership.profileId) preferredProfileIds.add(membership.profileId);
    const group = enabledGroups.get(membership.meshGroupId);
    if (group?.defaultProfileId) preferredProfileIds.add(group.defaultProfileId);
  }
  return {
    active: activeMemberships.length > 0,
    groups,
    memberships: activeMemberships,
    groupIds: new Set(groups.map((row) => row.id)),
    preferredProfileIds
  };
}

async function ensureDeviceMeshStatesForDevice(
  device: HdoDeviceRow,
  meshGroups: HdoMeshGroupRow[],
  memberships: HdoMeshMembershipRow[],
  existingStates: HdoDeviceMeshStateRow[],
  options: { touch?: boolean } = {}
): Promise<HdoDeviceMeshStateRow[]> {
  const enabledGroupIds = new Set(meshGroups.filter((row) => row.enabled).map((row) => row.id));
  const out = [...existingStates];
  const stateKey = (meshGroupId: string) => `${meshGroupId}:${device.id}`;
  const known = new Set(out.map((row) => `${row.meshGroupId}:${row.deviceId}`));
  const now = options.touch ? new Date().toISOString() : null;
  for (const membership of memberships) {
    if (
      membership.userId !== device.userId ||
      membership.status !== 'active' ||
      !enabledGroupIds.has(membership.meshGroupId) ||
      known.has(stateKey(membership.meshGroupId))
    ) {
      continue;
    }
    const row = await hdoStore.upsertDeviceMeshState({
      meshGroupId: membership.meshGroupId,
      deviceId: device.id,
      userId: device.userId,
      status: 'active',
      metadata: { createdFrom: 'device-register' },
      lastSeenAt: now
    });
    out.push(row);
    known.add(stateKey(membership.meshGroupId));
  }
  return out;
}

function deviceMeshStateAllows(
  states: HdoDeviceMeshStateRow[],
  meshGroupId: string,
  deviceId?: string
): boolean {
  if (!deviceId) return true;
  const state = states.find((row) => row.meshGroupId === meshGroupId && row.deviceId === deviceId);
  return !state || state.status === 'active';
}

function isVisibleForMesh(
  metadata: Record<string, unknown> | null,
  activeMeshGroupIds: Set<string>
): boolean {
  const allowed = metadataMeshGroupIds(metadata);
  return allowed.length === 0 || allowed.some((id) => activeMeshGroupIds.has(id));
}

function metadataMeshGroupIds(metadata: Record<string, unknown> | null): string[] {
  if (!metadata) return [];
  return asStringArray(metadata.meshGroupIds ?? metadata.meshGroups);
}

interface HdoServiceProbeTarget {
  id: string;
  type: 'node' | 'device';
  label: string;
  host: string;
  userId: string | null;
  meshGroupIds: string[];
}

function serviceProbeTargets(
  nodes: HdoNodeRow[],
  devices: HdoDeviceRow[],
  meshGroups: HdoMeshGroupRow[],
  memberships: HdoMeshMembershipRow[],
  deviceMeshStates: HdoDeviceMeshStateRow[],
  targetMeshGroupIds: Set<string>
): HdoServiceProbeTarget[] {
  const targets: HdoServiceProbeTarget[] = [];
  const seen = new Set<string>();
  const pushTarget = (target: HdoServiceProbeTarget) => {
    const key = `${target.type}:${target.id}:${target.host}`;
    if (seen.has(key)) return;
    seen.add(key);
    targets.push(target);
  };

  for (const node of nodes) {
    const host = normalizeOverlayIp(node.overlayIp);
    if (!host) continue;
    const meshGroupIds = targetMeshIdsForMetadata(node.metadata, targetMeshGroupIds);
    if (meshGroupIds.length === 0) continue;
    pushTarget({
      id: node.id,
      type: 'node',
      label: node.name,
      host,
      userId: null,
      meshGroupIds
    });
  }

  for (const device of devices) {
    const host = normalizeOverlayIp(device.overlayIp);
    if (!host) continue;
    const access = resolveMeshAccess(device.userId, meshGroups, memberships, deviceMeshStates, device.id);
    const meshGroupIds = [...access.groupIds].filter((id) => targetMeshGroupIds.has(id));
    if (meshGroupIds.length === 0) continue;
    pushTarget({
      id: device.id,
      type: 'device',
      label: device.label,
      host,
      userId: device.userId,
      meshGroupIds
    });
  }

  return targets;
}

function targetMeshIdsForMetadata(
  metadata: Record<string, unknown> | null,
  targetMeshGroupIds: Set<string>
): string[] {
  const explicitIds = metadataMeshGroupIds(metadata).filter((id) => targetMeshGroupIds.has(id));
  return explicitIds.length ? explicitIds : [...targetMeshGroupIds];
}

function isServerProbedService(service: HdoServiceRow, targetHost: string, targetPort: number): boolean {
  return (
    service.targetHost === targetHost &&
    service.targetPort === targetPort &&
    asOptionalString(service.metadata?.source) === 'server-probe'
  );
}

function isDevicePublishedService(
  service: HdoServiceRow,
  deviceId: string,
  targetPort: number
): boolean {
  return (
    service.targetPort === targetPort &&
    asOptionalString(service.metadata?.source) === 'device-published' &&
    asOptionalString(service.metadata?.deviceId) === deviceId
  );
}

function serviceNameFromInput(value: unknown, fallback: string): string {
  const raw = asOptionalString(value) ?? fallback;
  const normalized = raw.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9._:-]+/g, '-');
  return normalized.replace(/^-+|-+$/g, '').slice(0, 80) || 'hdo-service';
}

function uniqueServiceName(base: string, existingNames: Set<string>): string {
  if (!existingNames.has(base)) {
    existingNames.add(base);
    return base;
  }
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!existingNames.has(candidate)) {
      existingNames.add(candidate);
      return candidate;
    }
  }
  const candidate = `${base}-${randomUUID().slice(0, 8)}`;
  existingNames.add(candidate);
  return candidate;
}

function serviceProtocolForPort(port: number): HdoServiceProtocol {
  if (port === 443 || port === 8443) return 'https';
  if ([80, 3000, 5173, 8000, 8080, 9000, 9090].includes(port)) return 'http';
  return 'tcp';
}

async function probeTcpPort(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    let done = false;
    const finish = (open: boolean) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function addressPlanForMeshAccess(meshAccess: ReturnType<typeof resolveMeshAccess>): HdoMeshAddressPlan {
  for (const group of meshAccess.groups) {
    return addressPlanFromMeshGroup(group);
  }
  return defaultAddressPlan();
}

function addressPlanFromMeshGroup(group: HdoMeshGroupRow | null | undefined): HdoMeshAddressPlan {
  const metadata = asPlainObject(group?.metadata);
  return normalizeMeshAddressPlan(meshAddressPlanInput(metadata), false);
}

function normalizeMeshMetadata(metadata: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!metadata) return null;
  const addressPlanInput = meshAddressPlanInput(metadata);
  if (!addressPlanInput) return metadata;
  return {
    ...metadata,
    addressPlan: meshAddressPlanToMetadata(normalizeMeshAddressPlan(addressPlanInput, true))
  };
}

function meshAddressPlanInput(metadata: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!metadata) return null;
  const wireGuard = asPlainObject(metadata.wireGuard);
  return asPlainObject(metadata.addressPlan) ?? asPlainObject(wireGuard?.addressPlan);
}

function defaultAddressPlan(): HdoMeshAddressPlan {
  return {
    homeCidr: HDO_DEFAULT_ADDRESS_PLAN.homeCidr,
    userCidr: HDO_DEFAULT_ADDRESS_PLAN.userCidr,
    serviceCidr: HDO_DEFAULT_ADDRESS_PLAN.serviceCidr,
    domesticIp: HDO_DEFAULT_ADDRESS_PLAN.domesticIp,
    routeCidrs: [...HDO_DEFAULT_ADDRESS_PLAN.routeCidrs]
  };
}

function normalizeMeshAddressPlan(
  input: Record<string, unknown> | null,
  strict: boolean
): HdoMeshAddressPlan {
  const defaults = defaultAddressPlan();
  if (!input) return defaults;
  const homeCidr = normalizePlanCidr(input.homeCidr, defaults.homeCidr, 'homeCidr', strict);
  const userCidr = normalizePlanCidr(input.userCidr, defaults.userCidr, 'userCidr', strict);
  const serviceCidr = normalizePlanCidr(input.serviceCidr, defaults.serviceCidr, 'serviceCidr', strict);
  const domesticIp = normalizePlanIp(input.domesticIp, defaults.domesticIp, 'domesticIp', strict);
  const routeCidrsInput = asStringArray(input.routeCidrs ?? input.routes);
  const routeCidrs = routeCidrsInput.length
    ? routeCidrsInput
        .map((cidr) => normalizePlanCidr(cidr, '', 'routeCidrs', strict))
        .filter((cidr): cidr is string => Boolean(cidr))
    : [homeCidr, userCidr, serviceCidr];

  return {
    homeCidr,
    userCidr,
    serviceCidr,
    domesticIp,
    routeCidrs: uniqueStrings(routeCidrs.length ? routeCidrs : defaults.routeCidrs)
  };
}

function meshAddressPlanToMetadata(plan: HdoMeshAddressPlan): Record<string, unknown> {
  return {
    homeCidr: plan.homeCidr,
    userCidr: plan.userCidr,
    serviceCidr: plan.serviceCidr,
    domesticIp: plan.domesticIp,
    routeCidrs: plan.routeCidrs
  };
}

function normalizePlanCidr(
  value: unknown,
  fallback: string,
  label: string,
  strict: boolean
): string {
  const text = asOptionalString(value);
  if (!text) return fallback;
  const normalized = normalizeIpv4Cidr(text);
  if (normalized && cidrIsInAddressPlanRange(normalized)) return normalized;
  if (strict) {
    throw new Error(`${label} must be an IPv4 CIDR within 100.80.0.0 - 100.99.255.255`);
  }
  return fallback;
}

function normalizePlanIp(
  value: unknown,
  fallback: string,
  label: string,
  strict: boolean
): string {
  const text = asOptionalString(value);
  if (!text) return fallback;
  const number = ipv4ToNumber(text);
  if (number !== null && number >= HDO_ADDRESS_PLAN_MIN && number <= HDO_ADDRESS_PLAN_MAX) {
    return numberToIpv4(number);
  }
  if (strict) {
    throw new Error(`${label} must be an IPv4 address within 100.80.0.0 - 100.99.255.255`);
  }
  return fallback;
}

function allocateDeviceOverlayIp(devices: HdoDeviceRow[], currentId: string, userCidr: string): string {
  const range = cidrRange(userCidr) ?? cidrRange(HDO_DEFAULT_ADDRESS_PLAN.userCidr);
  if (!range) return '100.89.0.10';
  const used = new Set(
    devices
      .filter((row) => row.id !== currentId)
      .map((row) => normalizeOverlayIp(row.overlayIp))
      .filter((row): row is string => Boolean(row))
  );
  const start = Math.min(range.end, range.start + 10);
  const end = Math.max(start, range.end - 1);
  for (let value = start; value <= end; value += 1) {
    const candidate = numberToIpv4(value);
    if (!used.has(candidate)) return candidate;
  }
  return numberToIpv4(start);
}

function wireGuardAddress(value: string): string {
  return value.includes('/') ? value : `${value}/32`;
}

function normalizeOverlayIp(value: string | null): string | null {
  if (!value) return null;
  return value.split('/')[0] || null;
}

function normalizeIpv4Cidr(value: string): string | null {
  const [address, prefixText] = value.trim().split('/');
  const prefix = prefixText === undefined ? 32 : Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  const addressNumber = ipv4ToNumber(address);
  if (addressNumber === null) return null;
  const size = 2 ** (32 - prefix);
  const start = Math.floor(addressNumber / size) * size;
  return `${numberToIpv4(start)}/${prefix}`;
}

function cidrRange(value: string): { start: number; end: number } | null {
  const normalized = normalizeIpv4Cidr(value);
  if (!normalized) return null;
  const [address, prefixText] = normalized.split('/');
  const prefix = Number(prefixText);
  const start = ipv4ToNumber(address);
  if (start === null) return null;
  return { start, end: start + 2 ** (32 - prefix) - 1 };
}

function cidrIsInAddressPlanRange(value: string): boolean {
  const range = cidrRange(value);
  return Boolean(range && range.start >= HDO_ADDRESS_PLAN_MIN && range.end <= HDO_ADDRESS_PLAN_MAX);
}

function ipv4ToNumber(value: string | undefined): number | null {
  if (!value) return null;
  const parts = value.trim().split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => Number(part));
  if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return ((octets[0] * 256 + octets[1]) * 256 + octets[2]) * 256 + octets[3];
}

function numberToIpv4(value: number): string {
  const safe = Math.max(0, Math.min(0xffffffff, Math.floor(value)));
  return [
    Math.floor(safe / 16777216) % 256,
    Math.floor(safe / 65536) % 256,
    Math.floor(safe / 256) % 256,
    safe % 256
  ].join('.');
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function wireGuardNodeSummary(node: HdoNodeRow | undefined) {
  if (!node) return null;
  const metadata = asPlainObject(node.metadata);
  const wireGuard = asPlainObject(metadata?.wireGuard) ?? asPlainObject(metadata?.wg);
  const publicKey = asOptionalString(wireGuard?.publicKey);
  const host =
    asOptionalString(wireGuard?.endpointHost) ??
    asOptionalString(wireGuard?.host) ??
    publicHostWithoutPort(node.publicHost);
  const port = toPort(wireGuard?.listenPort) ?? toPort(wireGuard?.port) ?? HDO_DEFAULT_WG_PORT;
  return {
    nodeId: node.id,
    publicKey,
    endpointHost: host,
    listenPort: port,
    endpoint: publicKey && host ? `${host}:${port}` : null,
    overlayIp: node.overlayIp
  };
}

function wireGuardDirectPeerSummaries(current: HdoDeviceRow, devices: HdoDeviceRow[]) {
  const currentWireGuard = wireGuardMetadataFromDevice(current);
  const currentPrefersDirect = asOptionalBoolean(currentWireGuard?.preferDirectPeers) === true;
  if (!currentPrefersDirect) return [];

  return devices
    .filter((row) => row.id !== current.id)
    .map((row) => {
      const publicKey = row.publicKey;
      const overlayIp = normalizeOverlayIp(row.overlayIp);
      if (!publicKey || !overlayIp) return null;
      const wireGuard = wireGuardMetadataFromDevice(row);
      const endpoint = wireGuardEndpointFromMetadata(wireGuard);
      const peerPrefersDirect = asOptionalBoolean(wireGuard?.preferDirectPeers) === true;
      const peerCanDirect =
        Boolean(endpoint) &&
        (
          peerPrefersDirect ||
          asOptionalBoolean(wireGuard?.acceptDirectPeers) === true ||
          asOptionalBoolean(wireGuard?.directListener) === true
        );
      if (!peerCanDirect) return null;
      return {
        id: row.id,
        label: row.label,
        publicKey,
        overlayIp,
        allowedIps: [`${overlayIp}/32`],
        endpoint,
        direct: true
      };
    })
    .filter((row): row is NonNullable<typeof row> => Boolean(row));
}

function wireGuardPublicKeyFromMetadata(metadata: Record<string, unknown> | null): string | null {
  const data = asPlainObject(metadata);
  const wireGuard = asPlainObject(data?.wireGuard) ?? asPlainObject(data?.wg);
  return asOptionalString(wireGuard?.publicKey);
}

function wireGuardMetadataFromDevice(device: HdoDeviceRow): Record<string, unknown> | null {
  const data = asPlainObject(device.metadata);
  return asPlainObject(data?.wireGuard) ?? asPlainObject(data?.wg);
}

function wireGuardEndpointFromMetadata(wireGuard: Record<string, unknown> | null): string | null {
  const explicit = asOptionalString(wireGuard?.endpoint);
  if (explicit) return explicit;
  const host =
    asOptionalString(wireGuard?.endpointHost) ??
    asOptionalString(wireGuard?.host) ??
    asOptionalString(wireGuard?.publicHost);
  const port = toPort(wireGuard?.listenPort) ?? toPort(wireGuard?.port);
  if (host && port) return `${host}:${port}`;
  const observedAt = asOptionalString(wireGuard?.observedEndpointAt);
  const observedFresh = observedAt ? Date.now() - Date.parse(observedAt) <= HDO_WG_OBSERVED_ENDPOINT_TTL_MS : false;
  return observedFresh ? normalizeWireGuardEndpoint(asOptionalString(wireGuard?.observedEndpoint)) : null;
}

function withObservedWireGuardEndpoint(
  metadata: Record<string, unknown> | null,
  endpoint: string,
  observedAt: string
): Record<string, unknown> {
  const root = { ...(metadata ?? {}) };
  const wireGuard = {
    ...(asPlainObject(root.wireGuard) ?? asPlainObject(root.wg) ?? {}),
    observedEndpoint: endpoint,
    observedEndpointAt: observedAt,
    observedEndpointSource: 'domestic-wg'
  };
  root.wireGuard = wireGuard;
  return root;
}

function normalizeWireGuardEndpoint(value: string | null): string | null {
  if (!value || value === '(none)') return null;
  const trimmed = value.trim();
  const index = trimmed.lastIndexOf(':');
  if (index <= 0 || index === trimmed.length - 1) return null;
  const host = trimmed.slice(0, index).replace(/^\[|\]$/g, '');
  const port = toPort(trimmed.slice(index + 1));
  if (!host || !port) return null;
  return `${host}:${port}`;
}

function pickDomesticNode(nodes: HdoNodeRow[]): HdoNodeRow | undefined {
  const domesticNodes = nodes.filter((row) => row.kind === 'domestic');
  return (
    domesticNodes.find((row) => {
      const metadata = asPlainObject(row.metadata);
      const wireGuard = asPlainObject(metadata?.wireGuard) ?? asPlainObject(metadata?.wg);
      return Boolean(asOptionalString(wireGuard?.publicKey));
    }) ?? domesticNodes[0]
  );
}

function publicHostWithoutPort(value: string | null): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.hostname || null;
  } catch {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('[')) return trimmed.replace(/^\[|\].*$/g, '');
    const parts = trimmed.split(':');
    return parts.length > 1 ? parts[0] : trimmed;
  }
}

function pickProfilesForMesh(
  profiles: Awaited<ReturnType<typeof hdoStore.ensureDefaultProfiles>>,
  access: ReturnType<typeof resolveMeshAccess>
) {
  const visible = profiles.filter(
    (row) => row.enabled && isVisibleForMesh(row.metadata, access.groupIds)
  );
  if (access.preferredProfileIds.size === 0) return visible;
  const preferred = visible.filter((row) => access.preferredProfileIds.has(row.id));
  return preferred.length > 0 ? preferred : visible;
}

function isIpv4(value: string): boolean {
  const parts = value.split('.');
  return (
    parts.length === 4 &&
    parts.every((part) => {
      const n = Number(part);
      return /^\d+$/.test(part) && n >= 0 && n <= 255;
    })
  );
}

function pushYamlObject(
  lines: string[],
  object: Record<string, unknown>,
  indent: number,
  bullet: boolean
): void {
  const pad = ' '.repeat(indent);
  const childPad = ' '.repeat(indent + 2);
  const itemPad = ' '.repeat(bullet ? indent + 4 : indent + 2);
  const entries = Object.entries(object).filter(([, value]) => value !== undefined);
  entries.forEach(([key, value], index) => {
    const prefix = bullet && index === 0 ? `${pad}- ` : bullet ? childPad : pad;
    if (Array.isArray(value)) {
      lines.push(`${prefix}${key}:`);
      for (const item of value) lines.push(`${itemPad}- ${yamlScalar(item)}`);
      return;
    }
    if (asPlainObject(value)) {
      lines.push(`${prefix}${key}:`);
      pushYamlObject(lines, value as Record<string, unknown>, bullet ? indent + 4 : indent + 2, false);
      return;
    }
    lines.push(`${prefix}${key}: ${yamlScalar(value)}`);
  });
}

function yamlScalar(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(String(value));
}
