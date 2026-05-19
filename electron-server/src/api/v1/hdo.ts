import { createHash, randomUUID } from 'node:crypto';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { attachUser, requireAuth, requireRole } from '../../auth/middleware.js';
import { toPublic } from '../../auth/types.js';
import { auditStore, hdoStore, usersStore } from '../../data/index.js';
import type {
  HdoArtifactKind,
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
  HdoServiceProtocol
} from '../../data/storage-types.js';

const NODE_KINDS: readonly HdoNodeKind[] = ['domestic', 'home', 'oversea'];
const NODE_STATUSES: readonly HdoNodeStatus[] = ['pending', 'online', 'offline', 'error'];
const SERVICE_PROTOCOLS: readonly HdoServiceProtocol[] = ['tcp', 'udp', 'http', 'https'];
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
const DEVICE_TASK_KINDS: readonly HdoDeviceTaskKind[] = [
  'install-plugin',
  'uninstall-plugin',
  'activate-plugin',
  'deactivate-plugin',
  'apply-hdo-profile'
];
const DEVICE_TASK_STATUSES: readonly HdoDeviceTaskStatus[] = [
  'pending',
  'claimed',
  'done',
  'failed',
  'cancelled'
];
const HDO_MESH_ROUTE_CIDRS = ['100.88.0.0/16', '100.89.0.0/16', '100.90.0.0/16'];
const HDO_DEFAULT_DEVICE_PREFIX = '100.89.0.';
const HDO_DEFAULT_WG_PORT = 51888;

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
    const overlayIp =
      asOptionalString(body.overlayIp) ??
      existing?.overlayIp ??
      (publicKey ? allocateDeviceOverlayIp(await hdoStore.listAllDevices(), id) : null);
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
      hdoStore.listServices(),
      hdoStore.ensureDefaultProfiles(),
      hdoStore.listRateLimits(),
      hdoStore.listDevicePluginStates(),
      hdoStore.listDeviceTasks()
    ]);
    return {
      users: users.map(toPublic),
      meshGroups,
      memberships,
      nodes,
      devices,
      services,
      profiles,
      rateLimits,
      pluginStates,
      tasks
    };
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
    const row = await hdoStore.upsertMeshGroup({
      id: asOptionalString(body.id) ?? undefined,
      name,
      slug,
      description: asOptionalString(body.description),
      defaultProfileId: asOptionalString(body.defaultProfileId),
      enabled: asOptionalBoolean(body.enabled) ?? true,
      metadata: asPlainObject(body.metadata)
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

  app.post('/api/v1/hdo/admin/nodes', adminOnly, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = asRequiredString(body.name);
    const kind = pick(body.kind, NODE_KINDS);
    if (!name || !kind) {
      reply.code(400);
      return { error: 'name and valid kind required' };
    }
    const row = await hdoStore.upsertNode({
      id: asOptionalString(body.id) ?? undefined,
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

async function buildReadiness(userId: string) {
  const [
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
  else nextActions.push('Add home or oversea services that clients should receive');

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
  const [generation, nodes, services, profiles, rateLimits, meshGroups, memberships] = await Promise.all([
    hdoStore.getGeneration(),
    hdoStore.listNodes(),
    hdoStore.listServices(),
    hdoStore.ensureDefaultProfiles(),
    hdoStore.listRateLimits(),
    hdoStore.listMeshGroups(),
    hdoStore.listMeshMemberships()
  ]);
  const meshAccess = resolveMeshAccess(device.userId, meshGroups, memberships);
  const visibleNodes = meshAccess.active
    ? nodes.filter((row) => isVisibleForMesh(row.metadata, meshAccess.groupIds))
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
      memberships: meshAccess.memberships
    },
    wireGuard: {
      routeCidrs: HDO_MESH_ROUTE_CIDRS,
      client: {
        publicKey: device.publicKey,
        overlayIp: device.overlayIp,
        address: device.overlayIp ? wireGuardAddress(device.overlayIp) : null
      },
      domestic: wireGuardNodeSummary(visibleNodes.find((row) => row.kind === 'domestic'))
    },
    nodes: visibleNodes,
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

function asPlainObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
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
  memberships: HdoMeshMembershipRow[]
) {
  const enabledGroups = new Map(meshGroups.filter((row) => row.enabled).map((row) => [row.id, row]));
  const activeMemberships = memberships.filter(
    (row) => row.userId === userId && row.status === 'active' && enabledGroups.has(row.meshGroupId)
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

function allocateDeviceOverlayIp(devices: HdoDeviceRow[], currentId: string): string {
  const used = new Set(
    devices
      .filter((row) => row.id !== currentId)
      .map((row) => normalizeOverlayIp(row.overlayIp))
      .filter((row): row is string => Boolean(row))
  );
  for (let n = 10; n < 250; n += 1) {
    const candidate = `${HDO_DEFAULT_DEVICE_PREFIX}${n}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${HDO_DEFAULT_DEVICE_PREFIX}${250 + Math.floor(Math.random() * 5)}`;
}

function wireGuardAddress(value: string): string {
  return value.includes('/') ? value : `${value}/32`;
}

function normalizeOverlayIp(value: string | null): string | null {
  if (!value) return null;
  return value.split('/')[0] || null;
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
