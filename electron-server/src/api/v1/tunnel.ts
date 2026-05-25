import { randomBytes } from 'node:crypto';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { attachUser, requireAuth, requireRole } from '../../auth/middleware.js';
import { hashPassword, validatePassword } from '../../auth/passwords.js';
import { toPublic } from '../../auth/types.js';
import type { UserRow } from '../../auth/types.js';
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

  const openProvisionHandler = (req: FastifyRequest, reply: FastifyReply) => {
    return provisionOpenTunnelUser(req, reply);
  };
  app.post('/api/v1/tunnel/open/provision', adminOnly, openProvisionHandler);
  app.post('/api/v1/tunnel/open/users/provision', adminOnly, openProvisionHandler);

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
      const result = await reconcileTunnelNodeForRequest(req, node);
      if (!result.ok) {
        reply.code(result.status);
        return { error: result.error, detail: result.detail };
      }
      return result.payload;
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

async function provisionOpenTunnelUser(req: FastifyRequest, reply: FastifyReply) {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const provider = requiredString(body.provider);
  const externalUserId = requiredString(body.externalUserId);
  if (!provider || !externalUserId) {
    reply.code(400);
    return { error: 'provider and externalUserId required' };
  }

  const userInput = plainObject(body.user) ?? body;
  const accountInput = plainObject(body.account) ?? body;
  const providerSubject = `${provider}:${externalUserId}`;
  const accounts = await tunnelStore.listAccounts();
  const boundAccount = findProviderAccount(accounts, provider, externalUserId);
  const userResult = await ensureProviderUser({ provider, externalUserId, userInput, boundAccount, req });
  if (!userResult.ok) {
    reply.code(userResult.status);
    return { error: userResult.error, detail: userResult.detail };
  }
  if (userResult.user.role === 'banned') {
    reply.code(403);
    return { error: 'HDO user is banned' };
  }

  const userAccounts = accounts.filter((row) => row.userId === userResult.user.id);
  const existingAccount =
    boundAccount ??
    userAccounts.find((row) => row.status === 'active') ??
    userAccounts[0] ??
    null;
  const policy = await resolveProvisionPolicy(accountInput, existingAccount);
  if (!policy) {
    reply.code(404);
    return { error: 'policy not found' };
  }
  const node = await resolveProvisionNode(accountInput, existingAccount);
  if (!node) {
    reply.code(409);
    return { error: 'tunnel node is not configured' };
  }
  if (!node.runnerUrl || !node.runnerToken) {
    reply.code(409);
    return { error: 'node runnerUrl/runnerToken is not configured' };
  }

  const accountUsername =
    existingAccount?.username ??
    optionalString(accountInput.username) ??
    userResult.user.username ??
    safeAccountName(`${provider}_${externalUserId}`);
  const accountMetadata = {
    ...(existingAccount?.metadata ?? {}),
    ...(plainObject(accountInput.metadata) ?? {}),
    provider,
    externalUserId,
    providerSubject,
    source: 'tunnel-open-provision'
  };
  const hasUsableAccount =
    existingAccount?.status === 'active' &&
    existingAccount.nodeId === node.id &&
    existingAccount.policyId === policy.id &&
    optionalString(plainObject(existingAccount.metadata)?.providerSubject) === providerSubject;
  const row = hasUsableAccount
    ? existingAccount
    : await tunnelStore.upsertAccount({
        id: existingAccount?.id,
        userId: userResult.user.id,
        nodeId: node.id,
        policyId: policy.id,
        username: safeAccountName(accountUsername),
        status: 'active',
        downRate: optionalString(accountInput.downRate) ?? existingAccount?.downRate ?? null,
        upRate: optionalString(accountInput.upRate) ?? existingAccount?.upRate ?? null,
        metadata: accountMetadata
      });

  if (!hasUsableAccount) {
    await auditStore.insert({
      actorUserId: req.currentUser?.id ?? null,
      actorIp: req.ip,
      action: 'tunnel.open.provision',
      targetKind: 'tunnel_account',
      targetId: row.id,
      meta: {
        provider,
        externalUserId,
        providerSubject,
        userId: userResult.user.id,
        username: row.username,
        nodeId: row.nodeId,
        createdUser: userResult.createdUser,
        createdAccount: !existingAccount
      }
    });
  }

  const reconcile = await reconcileTunnelNodeForRequest(req, node);
  if (!reconcile.ok) {
    reply.code(reconcile.status);
    return {
      error: reconcile.error,
      detail: reconcile.detail,
      account: accountWithSubscriptionUrl(req, row)
    };
  }

  const account = accountWithSubscriptionUrl(req, row);
  const publicNode = reconcile.payload.node ?? redactNodeToken(node);
  return {
    ok: true,
    provider,
    externalUserId,
    createdUser: userResult.createdUser,
    createdAccount: !existingAccount,
    existingAccount: Boolean(existingAccount),
    user: toPublic(userResult.user),
    account,
    node: publicNode,
    policy,
    config: { account, node: publicNode, policy },
    managedConfig: managedTunnelConfig(account, policy),
    reconcile: reconcile.payload
  };
}

function managedTunnelConfig(account: ReturnType<typeof accountWithSubscriptionUrl>, policy: TunnelPolicyRow) {
  const rules = plainObject(policy.rules) ?? {};
  return {
    subscription: {
      name: account.username,
      url: account.subscriptionUrl
    },
    mode: policy.runtimeMode,
    autoStart: rules.autoStart !== false,
    autoUpdate: rules.autoUpdate !== false,
    allowSystemTunPrivilege: false,
    rules,
    source: 'hdo-tunnel'
  };
}

async function resolveProvisionPolicy(
  input: Record<string, unknown>,
  existingAccount: TunnelAccountRow | null
): Promise<TunnelPolicyRow | null> {
  const requestedPolicyId = optionalString(input.policyId);
  const policies = await tunnelStore.listPolicies();
  if (requestedPolicyId) return policies.find((row) => row.id === requestedPolicyId) ?? null;
  if (existingAccount?.policyId) {
    const existingPolicy = policies.find((row) => row.id === existingAccount.policyId);
    if (existingPolicy) return existingPolicy;
  }
  return tunnelStore.ensureDefaultPolicy();
}

async function resolveProvisionNode(
  input: Record<string, unknown>,
  existingAccount: TunnelAccountRow | null
): Promise<TunnelNodeRow | null> {
  const requestedNodeId = optionalString(input.nodeId);
  const nodes = await tunnelStore.listNodes();
  if (requestedNodeId) return nodes.find((row) => row.id === requestedNodeId) ?? null;
  if (existingAccount?.nodeId) {
    const existingNode = nodes.find((row) => row.id === existingAccount.nodeId);
    if (existingNode) return existingNode;
  }
  return nodes.find((row) => row.status !== 'error') ?? nodes[0] ?? null;
}

function findProviderAccount(
  accounts: TunnelAccountRow[],
  provider: string,
  externalUserId: string
): TunnelAccountRow | null {
  const providerSubject = `${provider}:${externalUserId}`;
  return (
    accounts.find((row) => {
      const metadata = plainObject(row.metadata);
      return (
        optionalString(metadata?.provider) === provider &&
        optionalString(metadata?.externalUserId) === externalUserId
      ) || optionalString(metadata?.providerSubject) === providerSubject;
    }) ?? null
  );
}

async function ensureProviderUser(input: {
  provider: string;
  externalUserId: string;
  userInput: Record<string, unknown>;
  boundAccount: TunnelAccountRow | null;
  req: FastifyRequest;
}): Promise<
  | {
      ok: true;
      user: UserRow;
      createdUser: boolean;
    }
  | { ok: false; status: number; error: string; detail?: unknown }
> {
  if (input.boundAccount) {
    const user = await usersStore.findById(input.boundAccount.userId);
    if (!user) {
      return {
        ok: false,
        status: 409,
        error: 'provider binding points to a missing HDO user',
        detail: { userId: input.boundAccount.userId, accountId: input.boundAccount.id }
      };
    }
    return { ok: true, user, createdUser: false };
  }

  const explicitUserId = optionalString(input.userInput.userId) ?? optionalString(input.userInput.hdoUserId);
  if (explicitUserId) {
    const user = await usersStore.findById(explicitUserId);
    if (!user) return { ok: false, status: 404, error: 'HDO user not found', detail: { userId: explicitUserId } };
    return { ok: true, user, createdUser: false };
  }

  const explicitUsername = optionalString(input.userInput.username);
  const username = explicitUsername ?? safeAccountName(`${input.provider}_${input.externalUserId}`);
  const email = optionalString(input.userInput.email);
  const phone = optionalString(input.userInput.phone);
  const displayName = optionalString(input.userInput.displayName);
  const identifiers = [username, email, phone].filter(Boolean) as string[];
  const matched = await uniqueUsersByIdentifiers(identifiers);
  if (matched.length > 1) {
    return { ok: false, status: 409, error: 'user identifiers match multiple HDO users' };
  }
  if (matched.length === 1) {
    return { ok: true, user: matched[0]!, createdUser: false };
  }

  const password = optionalString(input.userInput.password) ?? randomHexToken();
  const pw = validatePassword(password);
  if (!pw.ok) {
    return { ok: false, status: 400, error: pw.reason ?? 'invalid password' };
  }
  const user = await usersStore.insert({
    username,
    email,
    phone,
    passwordHash: await hashPassword(password),
    role: 'user',
    displayName: displayName ?? username
  });
  await auditStore.insert({
    actorUserId: input.req.currentUser?.id ?? null,
    actorIp: input.req.ip,
    action: 'tunnel.open.user.create',
    targetKind: 'user',
    targetId: user.id,
    meta: { provider: input.provider, externalUserId: input.externalUserId }
  });
  return { ok: true, user, createdUser: true };
}

async function uniqueUsersByIdentifiers(identifiers: string[]): Promise<UserRow[]> {
  const rows: UserRow[] = [];
  for (const identifier of identifiers) {
    const user = await usersStore.findByIdentifier(identifier);
    if (user && !rows.some((row) => row.id === user.id)) rows.push(user);
  }
  return rows;
}

async function reconcileTunnelNodeForRequest(
  req: FastifyRequest,
  node: TunnelNodeRow
): Promise<
  | { ok: true; payload: { node: ReturnType<typeof redactNodeToken> | null; revision: number; accounts: number; runner: unknown } }
  | { ok: false; status: number; error: string; detail: string }
> {
  if (!node.runnerUrl || !node.runnerToken) {
    return { ok: false, status: 409, error: 'node runnerUrl/runnerToken is not configured', detail: node.id };
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
    await auditStore.insert({
      actorUserId: req.currentUser?.id ?? null,
      actorIp: req.ip,
      action: 'tunnel.node.reconcile_failed',
      targetKind: 'tunnel_node',
      targetId: node.id,
      meta: { error: result.error, detail: result.detail }
    });
    return { ok: false, status: 502, error: result.error, detail: result.detail };
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
    ok: true,
    payload: {
      node: updatedNode ? redactNodeToken(updatedNode) : null,
      revision,
      accounts: activeAccounts.length,
      runner: result.payload
    }
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
  const override = stringList(policy.rules?.rules);
  if (override.length) return override;
  const custom = stringList(policy.rules?.customRules);
  const allowlist = stringList(policy.rules?.allowlist);
  const blocklist = stringList(policy.rules?.blocklist);
  const base = [
    'DOMAIN-SUFFIX,local,DIRECT',
    'IP-CIDR,127.0.0.0/8,DIRECT,no-resolve',
    'IP-CIDR,10.0.0.0/8,DIRECT,no-resolve',
    'IP-CIDR,172.16.0.0/12,DIRECT,no-resolve',
    'IP-CIDR,192.168.0.0/16,DIRECT,no-resolve',
    'IP-CIDR,169.254.0.0/16,DIRECT,no-resolve'
  ];
  for (const domain of blocklist) {
    base.push(`DOMAIN-SUFFIX,${domain},REJECT`);
  }
  for (const domain of allowlist) {
    base.push(`DOMAIN-SUFFIX,${domain},PROXY`);
  }
  if (policy.routingMode === 'cn-direct') {
    base.push('GEOSITE,CN,DIRECT', 'GEOIP,CN,DIRECT');
  }
  base.push(...custom);
  base.push(policy.runtimeMode === 'app-rule' ? 'MATCH,REJECT' : 'MATCH,PROXY');
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

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item).trim())
    .filter(Boolean);
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
