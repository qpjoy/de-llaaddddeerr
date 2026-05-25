import { randomBytes } from 'node:crypto';

import type { FastifyInstance, FastifyRequest } from 'fastify';

import { attachUser, requireAuth, requireRole } from '../../auth/middleware.js';
import { toPublic } from '../../auth/types.js';
import { auditStore, tunnelStore, usersStore } from '../../data/index.js';
import type {
  TunnelAccountRow,
  TunnelAccountStatus,
  TunnelNodeRow,
  TunnelNodeStatus,
  TunnelPolicyRow,
  TunnelRoutingMode,
  TunnelRuntimeMode
} from '../../data/storage-types.js';

const TUNNEL_RECONCILE_TIMEOUT_MS = 2 * 60 * 1000;

export async function tunnelRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', attachUser);
  const adminOnly = { preHandler: requireRole('admin') };

  app.get('/api/v1/tunnel/admin/overview', adminOnly, async (req) => {
    const [users, nodes, policies, accounts] = await Promise.all([
      usersStore.list(),
      tunnelStore.listNodes(),
      tunnelStore.listPolicies(),
      tunnelStore.listAccounts()
    ]);
    return {
      users: users.map(toPublic),
      nodes: nodes.map(redactNodeToken),
      policies,
      accounts: accounts.map((row) => accountWithSubscriptionUrl(req, row))
    };
  });

  app.post('/api/v1/tunnel/admin/nodes', adminOnly, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = requiredString(body.name);
    const publicHost = requiredString(body.publicHost);
    if (!name || !publicHost) {
      reply.code(400);
      return { error: 'name and publicHost required' };
    }
    const row = await tunnelStore.upsertNode({
      id: optionalString(body.id) ?? undefined,
      name,
      publicHost,
      runnerUrl: optionalStringField(body, 'runnerUrl'),
      runnerToken: optionalStringField(body, 'runnerToken'),
      status: (pick(body.status, ['pending', 'online', 'offline', 'error']) ?? 'pending') as TunnelNodeStatus,
      serverPorts: optionalStringField(body, 'serverPorts'),
      subscriptionBaseUrl: optionalStringField(body, 'subscriptionBaseUrl'),
      metadata: plainObjectField(body, 'metadata')
    });
    await auditStore.insert({
      actorUserId: req.currentUser?.id ?? null,
      actorIp: req.ip,
      action: 'tunnel.node.upsert',
      targetKind: 'tunnel_node',
      targetId: row.id,
      meta: { name: row.name, publicHost: row.publicHost }
    });
    return redactNodeToken(row);
  });

  app.post('/api/v1/tunnel/admin/policies', adminOnly, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = requiredString(body.name);
    if (!name) {
      reply.code(400);
      return { error: 'name required' };
    }
    const row = await tunnelStore.upsertPolicy({
      id: optionalString(body.id) ?? undefined,
      name,
      routingMode: (pick(body.routingMode, ['cn-direct', 'global']) ?? undefined) as TunnelRoutingMode | undefined,
      runtimeMode: (pick(body.runtimeMode, ['system-tun', 'app-global', 'app-rule']) ?? undefined) as TunnelRuntimeMode | undefined,
      enabled: optionalBoolean(body.enabled),
      isDefault: optionalBoolean(body.isDefault),
      rules: plainObjectField(body, 'rules'),
      metadata: plainObjectField(body, 'metadata')
    });
    await auditStore.insert({
      actorUserId: req.currentUser?.id ?? null,
      actorIp: req.ip,
      action: 'tunnel.policy.upsert',
      targetKind: 'tunnel_policy',
      targetId: row.id,
      meta: { name: row.name, routingMode: row.routingMode, runtimeMode: row.runtimeMode }
    });
    return row;
  });

  app.post('/api/v1/tunnel/admin/accounts/provision', adminOnly, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const userId = requiredString(body.userId);
    if (!userId) {
      reply.code(400);
      return { error: 'userId required' };
    }
    const user = await usersStore.findById(userId);
    if (!user) {
      reply.code(404);
      return { error: 'user not found' };
    }
    const policy = optionalString(body.policyId)
      ? await tunnelStore.listPolicies().then((rows) => rows.find((row) => row.id === optionalString(body.policyId)) ?? null)
      : await tunnelStore.ensureDefaultPolicy();
    if (!policy) {
      reply.code(404);
      return { error: 'policy not found' };
    }
    const username =
      optionalString(body.username) ??
      user.username ??
      user.email?.split('@')[0] ??
      `user-${user.id.slice(0, 8)}`;
    const nodeId = optionalString(body.nodeId) ?? (await tunnelStore.listNodes())[0]?.id ?? null;
    if (nodeId && !(await tunnelStore.findNode(nodeId))) {
      reply.code(404);
      return { error: 'node not found' };
    }
    const row = await tunnelStore.upsertAccount({
      id: optionalString(body.id) ?? undefined,
      userId: user.id,
      nodeId,
      policyId: policy.id,
      username: safeAccountName(username),
      status: (pick(body.status, ['active', 'disabled', 'revoked']) ?? 'active') as TunnelAccountStatus,
      downRate: optionalString(body.downRate),
      upRate: optionalString(body.upRate),
      metadata: plainObjectField(body, 'metadata')
    });
    await auditStore.insert({
      actorUserId: req.currentUser?.id ?? null,
      actorIp: req.ip,
      action: 'tunnel.account.provision',
      targetKind: 'tunnel_account',
      targetId: row.id,
      meta: { userId: row.userId, username: row.username, nodeId: row.nodeId }
    });
    return accountWithSubscriptionUrl(req, row);
  });

  app.get('/api/v1/tunnel/admin/accounts', adminOnly, async (req) => {
    const query = (req.query ?? {}) as Record<string, unknown>;
    const accounts = await tunnelStore.listAccounts({
      userId: optionalString(query.userId) ?? undefined,
      nodeId: optionalString(query.nodeId) ?? undefined,
      status: (pick(query.status, ['active', 'disabled', 'revoked']) ?? undefined) as TunnelAccountStatus | undefined
    });
    return accounts.map((row) => accountWithSubscriptionUrl(req, row));
  });

  app.post<{ Params: { id: string } }>(
    '/api/v1/tunnel/admin/accounts/:id/rotate-token',
    adminOnly,
    async (req, reply) => {
      const current = await tunnelStore.findAccount(req.params.id);
      if (!current) {
        reply.code(404);
        return { error: 'account not found' };
      }
      const rotated = await tunnelStore.upsertAccount({
        id: current.id,
        userId: current.userId,
        nodeId: current.nodeId,
        policyId: current.policyId,
        username: current.username,
        status: current.status,
        authToken: randomHexToken(),
        subscriptionToken: randomHexToken(),
        downRate: current.downRate,
        upRate: current.upRate,
        metadata: current.metadata
      });
      await auditStore.insert({
        actorUserId: req.currentUser?.id ?? null,
        actorIp: req.ip,
        action: 'tunnel.account.rotate_token',
        targetKind: 'tunnel_account',
        targetId: rotated.id,
        meta: { userId: rotated.userId, username: rotated.username }
      });
      return accountWithSubscriptionUrl(req, rotated);
    }
  );

  app.post<{ Params: { id: string } }>(
    '/api/v1/tunnel/admin/nodes/:id/reconcile',
    adminOnly,
    async (req, reply) => {
      const node = await tunnelStore.findNode(req.params.id);
      if (!node) {
        reply.code(404);
        return { error: 'node not found' };
      }
      if (!node.runnerUrl || !node.runnerToken) {
        reply.code(409);
        return { error: 'node runnerUrl/runnerToken is not configured' };
      }
      const [policies, accounts] = await Promise.all([
        tunnelStore.listPolicies(),
        tunnelStore.listAccounts({ nodeId: node.id })
      ]);
      const activeAccounts = accounts.filter((row) => row.status === 'active');
      const revision = Math.max(
        node.desiredRevision,
        1,
        ...activeAccounts.map((row) => row.desiredRevision)
      );
      const result = await runTunnelNodeReconcile(node, activeAccounts, policies, revision);
      if (!result.ok) {
        reply.code(502);
        await auditStore.insert({
          actorUserId: req.currentUser?.id ?? null,
          actorIp: req.ip,
          action: 'tunnel.node.reconcile_failed',
          targetKind: 'tunnel_node',
          targetId: node.id,
          meta: { error: result.error, detail: result.detail }
        });
        return { error: result.error, detail: result.detail };
      }
      const updatedNode = await tunnelStore.setNodeAppliedRevision(node.id, {
        appliedRevision: revision,
        status: 'online',
        metadata: { ...(node.metadata ?? {}), lastReconcile: result.payload }
      });
      await Promise.all(activeAccounts.map((row) => tunnelStore.setAccountAppliedRevision(row.id, revision)));
      await auditStore.insert({
        actorUserId: req.currentUser?.id ?? null,
        actorIp: req.ip,
        action: 'tunnel.node.reconcile',
        targetKind: 'tunnel_node',
        targetId: node.id,
        meta: { revision, accounts: activeAccounts.length }
      });
      return {
        node: updatedNode ? redactNodeToken(updatedNode) : null,
        revision,
        accounts: activeAccounts.length,
        runner: result.payload
      };
    }
  );

  app.get('/api/v1/tunnel/me/subscription', { preHandler: requireAuth }, async (req, reply) => {
    const accounts = await tunnelStore.listAccounts({ userId: req.currentUser!.id, status: 'active' });
    const account = accounts[0];
    if (!account) {
      reply.code(404);
      return { error: 'no active tunnel account' };
    }
    return accountWithSubscriptionUrl(req, account);
  });

  app.get('/api/v1/tunnel/me/config', { preHandler: requireAuth }, async (req, reply) => {
    const accounts = await tunnelStore.listAccounts({ userId: req.currentUser!.id, status: 'active' });
    const account = accounts[0];
    if (!account) {
      reply.code(404);
      return { error: 'no active tunnel account' };
    }
    const [nodes, policies] = await Promise.all([
      tunnelStore.listNodes(),
      tunnelStore.listPolicies()
    ]);
    const node = account.nodeId
      ? nodes.find((row) => row.id === account.nodeId) ?? null
      : nodes.find((row) => row.status !== 'error') ?? null;
    const policy = account.policyId
      ? policies.find((row) => row.id === account.policyId) ?? null
      : policies.find((row) => row.isDefault) ?? policies[0] ?? null;
    return {
      account: accountWithSubscriptionUrl(req, account),
      node: node ? redactNodeToken(node) : null,
      policy
    };
  });

  app.get<{ Params: { token: string } }>(
    '/api/v1/tunnel/subscriptions/:token/mihomo.yaml',
    async (req, reply) => {
      const account = await tunnelStore.findAccountBySubscriptionToken(req.params.token);
      if (!account || account.status !== 'active') {
        reply.code(404);
        return { error: 'subscription not found' };
      }
      const user = await usersStore.findById(account.userId);
      if (!user || user.role === 'banned') {
        reply.code(403);
        return { error: 'subscription disabled' };
      }
      const [nodes, policies] = await Promise.all([
        tunnelStore.listNodes(),
        tunnelStore.listPolicies()
      ]);
      const node = account.nodeId
        ? nodes.find((row) => row.id === account.nodeId) ?? null
        : nodes.find((row) => row.status !== 'error') ?? null;
      const policy = account.policyId
        ? policies.find((row) => row.id === account.policyId) ?? null
        : policies.find((row) => row.isDefault) ?? policies[0] ?? null;
      if (!node || !policy) {
        reply.code(409);
        return { error: 'tunnel node or policy is not configured' };
      }
      const yaml = renderTunnelMihomoYaml(account, node, policy);
      reply.type('text/yaml; charset=utf-8');
      reply.header('cache-control', 'no-store');
      return yaml;
    }
  );
}

function accountWithSubscriptionUrl(req: FastifyRequest, row: TunnelAccountRow) {
  return {
    ...row,
    subscriptionUrl: `${requestBaseUrl(req)}/api/v1/tunnel/subscriptions/${row.subscriptionToken}/mihomo.yaml`
  };
}

function redactNodeToken(row: TunnelNodeRow) {
  return {
    ...row,
    runnerToken: row.runnerToken ? '<configured>' : null
  };
}

async function runTunnelNodeReconcile(
  node: TunnelNodeRow,
  accounts: TunnelAccountRow[],
  policies: TunnelPolicyRow[],
  revision: number
): Promise<{ ok: true; payload: unknown } | { ok: false; error: string; detail: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TUNNEL_RECONCILE_TIMEOUT_MS);
  try {
    const response = await fetch(new URL('/run', node.runnerUrl!), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${node.runnerToken}`
      },
      body: JSON.stringify({
        args: ['tunnel-reconcile-oversea'],
        tunnelState: {
          revision,
          node: {
            id: node.id,
            name: node.name,
            publicHost: node.publicHost,
            serverPorts: node.serverPorts
          },
          accounts: accounts.map((row) => ({
            id: row.id,
            userId: row.userId,
            username: row.username,
            authToken: row.authToken,
            downRate: row.downRate,
            upRate: row.upRate,
            policyId: row.policyId
          })),
          policies
        }
      }),
      signal: controller.signal
    });
    const text = await response.text();
    const payload = parseJsonObject(text) ?? { output: text };
    if (!response.ok) {
      return {
        ok: false,
        error: optionalString(payload.error) ?? `runner HTTP ${response.status}`,
        detail: optionalString(payload.output) ?? text
      };
    }
    return { ok: true, payload };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      detail: `Failed to reach tunnel runner at ${node.runnerUrl}`
    };
  } finally {
    clearTimeout(timeout);
  }
}

function renderTunnelMihomoYaml(
  account: TunnelAccountRow,
  node: TunnelNodeRow,
  policy: TunnelPolicyRow
): string {
  const proxyName = `O-${node.name}`;
  const serverPorts = node.serverPorts ?? '52120';
  const firstPort = Number(String(serverPorts).split(/[,-]/)[0]) || 52120;
  const metadata = plainObject(node.metadata) ?? {};
  const lines = [
    '# Generated by QPJoy Tunnel control plane.',
    `# account: ${account.id}`,
    `# revision: ${account.desiredRevision}`,
    'mixed-port: 7890',
    'allow-lan: false',
    'mode: rule',
    'log-level: info',
    'geodata-mode: true',
    'geo-auto-update: true',
    'geo-update-interval: 24',
    '',
    'proxies:',
    `  - name: "${proxyName}"`,
    '    type: hysteria2',
    `    server: ${node.publicHost}`,
    `    port: ${firstPort}`
  ];
  if (/[,-]/.test(serverPorts)) {
    lines.push(`    ports: "${serverPorts}"`);
    lines.push(`    hop-interval: ${Number(metadata.hopIntervalSeconds ?? 30) || 30}`);
  }
  lines.push(`    password: "${account.authToken}"`);
  if (account.downRate) lines.push(`    down: "${account.downRate}"`);
  if (account.upRate) lines.push(`    up: "${account.upRate}"`);
  const tlsSni = optionalString(metadata.tlsSni);
  if (tlsSni) lines.push(`    sni: "${tlsSni}"`);
  lines.push(`    skip-cert-verify: ${metadata.skipCertVerify === false ? 'false' : 'true'}`);
  const fingerprint = optionalString(metadata.tlsFingerprint);
  if (fingerprint) lines.push(`    fingerprint: "${fingerprint}"`);
  lines.push('    alpn:');
  lines.push('      - h3');
  const obfsPassword = optionalString(metadata.obfsPassword);
  if (obfsPassword) {
    lines.push('    obfs: salamander');
    lines.push(`    obfs-password: "${obfsPassword}"`);
  }
  lines.push('');
  lines.push('proxy-groups:');
  lines.push('  - name: PROXY');
  lines.push('    type: select');
  lines.push('    proxies:');
  lines.push(`      - "${proxyName}"`);
  lines.push('      - DIRECT');
  lines.push('');
  lines.push('rules:');
  for (const rule of policyRules(policy)) lines.push(`  - ${rule}`);
  return lines.join('\n') + '\n';
}

function policyRules(policy: TunnelPolicyRow): string[] {
  const custom = Array.isArray(policy.rules?.rules) ? policy.rules.rules.map(String) : [];
  if (custom.length) return custom;
  const base = [
    'DOMAIN-SUFFIX,local,DIRECT',
    'IP-CIDR,127.0.0.0/8,DIRECT,no-resolve',
    'IP-CIDR,10.0.0.0/8,DIRECT,no-resolve',
    'IP-CIDR,172.16.0.0/12,DIRECT,no-resolve',
    'IP-CIDR,192.168.0.0/16,DIRECT,no-resolve',
    'IP-CIDR,169.254.0.0/16,DIRECT,no-resolve'
  ];
  if (policy.routingMode === 'cn-direct') {
    base.push('GEOSITE,CN,DIRECT', 'GEOIP,CN,DIRECT');
  }
  base.push('MATCH,PROXY');
  return base;
}

function requestBaseUrl(req: FastifyRequest): string {
  const host = headerString(req.headers['x-forwarded-host']) ?? headerString(req.headers.host) ?? '127.0.0.1:8080';
  const proto = headerString(req.headers['x-forwarded-proto']) ?? 'http';
  return `${proto.split(',')[0]?.trim() || 'http'}://${host.split(',')[0]?.trim() || host}`;
}

function headerString(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return optionalString(value[0]);
  return optionalString(value);
}

function requiredString(value: unknown): string | null {
  const out = optionalString(value);
  return out && out.length > 0 ? out : null;
}

function optionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function optionalStringField(row: Record<string, unknown>, key: string): string | null | undefined {
  return Object.prototype.hasOwnProperty.call(row, key) ? optionalString(row[key]) : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  return undefined;
}

function plainObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function plainObjectField(row: Record<string, unknown>, key: string): Record<string, unknown> | null | undefined {
  return Object.prototype.hasOwnProperty.call(row, key) ? plainObject(row[key]) : undefined;
}

function pick<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && allowed.includes(value as T) ? (value as T) : null;
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return plainObject(parsed);
  } catch {
    return null;
  }
}

function safeAccountName(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 64) || 'user';
}

function randomHexToken(): string {
  return randomBytes(24).toString('hex');
}
