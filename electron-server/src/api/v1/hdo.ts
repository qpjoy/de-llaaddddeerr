import { createHash, randomUUID } from 'node:crypto';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { attachUser, requireAuth, requireRole } from '../../auth/middleware.js';
import { auditStore, hdoStore } from '../../data/index.js';
import type {
  HdoArtifactKind,
  HdoDeviceRow,
  HdoNodeKind,
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
    const label = asOptionalString(body.label) ?? 'HDO client';
    const device = await hdoStore.upsertDevice({
      id,
      userId: req.currentUser!.id,
      label,
      platform: asOptionalString(body.platform),
      publicKey: asOptionalString(body.publicKey),
      overlayIp: asOptionalString(body.overlayIp),
      status: pick(body.status, NODE_STATUSES) ?? 'online',
      metadata: asPlainObject(body.metadata)
    });
    await auditStore.insert({
      actorUserId: req.currentUser!.id,
      actorIp: req.ip,
      action: 'hdo.device.register',
      targetKind: 'hdo_device',
      targetId: device.id,
      meta: { label: device.label, platform: device.platform }
    });
    reply.code(201);
    return device;
  });

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
  const [generation, nodes, devices, services, profiles, rateLimits] = await Promise.all([
    hdoStore.getGeneration(),
    hdoStore.listNodes(),
    hdoStore.listDevicesForUser(userId),
    hdoStore.listServices(),
    hdoStore.ensureDefaultProfiles(),
    hdoStore.listRateLimits()
  ]);
  const enabledServices = services.filter((row) => row.enabled);
  const completed: string[] = [];
  const nextActions: string[] = [];
  const blockers: string[] = [];

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
      rateLimits: rateLimits.length
    }
  };
}

async function buildManifest(device: HdoDeviceRow) {
  await hdoStore.ensureDefaultProfiles();
  const [generation, nodes, services, profiles, rateLimits] = await Promise.all([
    hdoStore.getGeneration(),
    hdoStore.listNodes(),
    hdoStore.listServices(),
    hdoStore.ensureDefaultProfiles(),
    hdoStore.listRateLimits()
  ]);
  return {
    version: 1,
    generation,
    updatedAt: new Date().toISOString(),
    device,
    nodes,
    services: services.filter((row) => row.enabled),
    profiles: profiles.filter((row) => row.enabled),
    rateLimits: rateLimits.filter(
      (row) =>
        (row.subjectType === 'device' && row.subjectId === device.id) ||
        (row.subjectType === 'user' && row.subjectId === device.userId) ||
        row.subjectType === 'profile' ||
        row.subjectType === 'node'
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
