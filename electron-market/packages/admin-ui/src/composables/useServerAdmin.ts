/**
 * REST helpers for server-admin pages. Only meaningful in server mode
 * (i.e. when the SPA is served by electron-server at `/admin/`); routes
 * that need these tabs hide themselves in local mode via a router guard.
 */
import { Notify } from 'quasar';

import { getServerToken, useMode } from 'src/composables/useMode';
import type { PublicUser } from 'src/composables/useAuth';

export interface EntitlementRow {
  id: string;
  userId: string;
  pluginId: string;
  kind: 'free' | 'paid' | 'trial';
  grantedAt: string;
  expiresAt: string | null;
}

export interface AuditEntry {
  id: number;
  actorUserId: string | null;
  actorIp: string | null;
  action: string;
  targetKind: string | null;
  targetId: string | null;
  meta: Record<string, unknown> | null;
  createdAt: string;
}

export interface SyncReport {
  release: string;
  scannedPackages: number;
  acceptedPlugins: number;
  rejected: Array<{ name: string; reason: string }>;
  durationMs: number;
}

export interface SchedulerStatus {
  enabled: boolean;
  running: boolean;
  intervalMs: number;
  jitterMs: number;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastReport: SyncReport | null;
  lastError: string | null;
  nextRunAt: string | null;
}

export interface HdoMeshGroupRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  defaultProfileId: string | null;
  enabled: boolean;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface HdoMeshMembershipRow {
  id: string;
  meshGroupId: string;
  userId: string;
  role: 'member' | 'admin' | 'support';
  status: 'active' | 'suspended' | 'revoked';
  profileId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface HdoNodeRow {
  id: string;
  name: string;
  kind: 'domestic' | 'home' | 'oversea';
  publicHost: string | null;
  overlayIp: string | null;
  status: 'pending' | 'online' | 'offline' | 'error';
  metadata: Record<string, unknown> | null;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HdoDeviceRow {
  id: string;
  userId: string;
  label: string;
  platform: string | null;
  publicKey: string | null;
  overlayIp: string | null;
  status: 'pending' | 'online' | 'offline' | 'error';
  metadata: Record<string, unknown> | null;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HdoServiceRow {
  id: string;
  name: string;
  nodeId: string | null;
  targetHost: string;
  targetPort: number;
  protocol: 'tcp' | 'udp' | 'http' | 'https';
  domains: string[];
  enabled: boolean;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface HdoProfileRow {
  id: string;
  name: string;
  mode: 'home-only' | 'home-foreign' | 'domestic-global';
  enabled: boolean;
  rules: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface HdoRateLimitRow {
  id: string;
  subjectType: 'user' | 'device' | 'profile' | 'node';
  subjectId: string;
  downRate: string | null;
  downCeil: string | null;
  upRate: string | null;
  upCeil: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface HdoDevicePluginStateRow {
  id: string;
  deviceId: string;
  pluginId: string;
  npm: string | null;
  name: string | null;
  version: string | null;
  state: string;
  manifest: Record<string, unknown> | null;
  health: Record<string, unknown> | null;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface HdoDeviceTaskRow {
  id: string;
  userId: string;
  deviceId: string | null;
  pluginId: string | null;
  kind:
    | 'install-plugin'
    | 'uninstall-plugin'
    | 'activate-plugin'
    | 'deactivate-plugin'
    | 'apply-hdo-profile';
  status: 'pending' | 'claimed' | 'done' | 'failed' | 'cancelled';
  payload: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export type HdoDeploymentKind =
  | 'deploy-domestic'
  | 'sync-domestic-peers'
  | 'sync-and-repair-domestic'
  | 'repair-domestic-routes'
  | 'deploy-domestic-mihomo-wireguard'
  | 'deploy-oversea-mihomo-hysteria2'
  | 'status';

export interface HdoDeploymentJob {
  id: string;
  kind: HdoDeploymentKind;
  status: 'running' | 'succeeded' | 'failed';
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

export interface HdoDeploymentRunner {
  available: boolean;
  scriptPath: string | null;
  cwd: string | null;
  kinds: HdoDeploymentKind[];
  note: string;
}

export interface HdoDeploymentState {
  runner: HdoDeploymentRunner;
  jobs: HdoDeploymentJob[];
}

export interface HdoOverview {
  users: PublicUser[];
  meshGroups: HdoMeshGroupRow[];
  memberships: HdoMeshMembershipRow[];
  nodes: HdoNodeRow[];
  devices: HdoDeviceRow[];
  services: HdoServiceRow[];
  profiles: HdoProfileRow[];
  rateLimits: HdoRateLimitRow[];
  pluginStates: HdoDevicePluginStateRow[];
  tasks: HdoDeviceTaskRow[];
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { apiBase } = useMode();
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(init.headers as Record<string, string> | undefined)
  };
  const tok = getServerToken();
  if (tok) headers.authorization = `Bearer ${tok}`;
  const res = await fetch(apiBase + path, { ...init, headers });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      msg = (await res.json()).error ?? msg;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

function toast(message: string, color: 'positive' | 'negative' = 'positive'): void {
  Notify.create({ message, color, position: 'top-right', timeout: 2400 });
}

export function useServerAdmin() {
  return {
    async listUsers(): Promise<PublicUser[]> {
      return api<PublicUser[]>('/admin/users');
    },
    async createUser(input: {
      username?: string | null;
      email?: string | null;
      phone?: string | null;
      password: string;
      displayName?: string | null;
      role?: 'user' | 'admin' | 'banned';
    }): Promise<PublicUser> {
      const out = await api<PublicUser>('/admin/users', {
        method: 'POST',
        body: JSON.stringify(input)
      });
      toast(`已创建用户：${out.username ?? out.email ?? out.id}`);
      return out;
    },
    async setUserRole(id: string, role: 'user' | 'admin' | 'banned'): Promise<PublicUser> {
      const out = await api<PublicUser>(`/admin/users/${encodeURIComponent(id)}/role`, {
        method: 'POST',
        body: JSON.stringify({ role })
      });
      toast(`已设置 ${out.username ?? out.id} 为 ${role}`);
      return out;
    },
    async listEntitlements(id: string): Promise<EntitlementRow[]> {
      return api<EntitlementRow[]>(`/admin/users/${encodeURIComponent(id)}/entitlements`);
    },
    async grantEntitlement(
      id: string,
      input: { pluginId: string; kind: 'free' | 'paid' | 'trial'; expiresAt?: string | null }
    ): Promise<EntitlementRow> {
      const out = await api<EntitlementRow>(
        `/admin/users/${encodeURIComponent(id)}/entitlements`,
        { method: 'POST', body: JSON.stringify(input) }
      );
      toast('授权完成');
      return out;
    },
    /**
     * Read the scheduler's last-run state. Anonymous-readable on the
     * server for now (gated to admin), so the SPA shows the lock chip when
     * it 401s.
     */
    async getSyncStatus(): Promise<SchedulerStatus> {
      return api<SchedulerStatus>('/admin/sync');
    },

    /**
     * Force the scheduler to run *now*. Reuses the same mutex as the
     * periodic loop — if a run is already in flight, returns the report
     * for that run instead of starting a second one.
     *
     * Long-running (~30-60s); the caller should show a spinner.
     */
    async triggerSync(): Promise<SyncReport> {
      const out = await api<SyncReport>('/admin/sync', { method: 'POST' });
      toast(`同步完成：接受 ${out.acceptedPlugins}，拒绝 ${out.rejected.length}`);
      return out;
    },

    async listAudit(params: {
      limit?: number;
      before?: number;
      actorUserId?: string;
      action?: string;
      targetId?: string;
    } = {}): Promise<AuditEntry[]> {
      const qs = new URLSearchParams();
      if (params.limit) qs.set('limit', String(params.limit));
      if (params.before) qs.set('before', String(params.before));
      if (params.actorUserId) qs.set('actorUserId', params.actorUserId);
      if (params.action) qs.set('action', params.action);
      if (params.targetId) qs.set('targetId', params.targetId);
      const suffix = qs.toString() ? '?' + qs.toString() : '';
      return api<AuditEntry[]>('/admin/audit' + suffix);
    },

    async getHdoOverview(): Promise<HdoOverview> {
      return api<HdoOverview>('/hdo/admin/overview');
    },

    async getHdoDeployments(): Promise<HdoDeploymentState> {
      return api<HdoDeploymentState>('/hdo/admin/deployments');
    },

    async runHdoDeployment(input: {
      kind: HdoDeploymentKind;
      serverUrl?: string | null;
      publicHost?: string | null;
      port?: number | null;
    }): Promise<HdoDeploymentJob> {
      const out = await api<HdoDeploymentJob>('/hdo/admin/deployments', {
        method: 'POST',
        body: JSON.stringify(input)
      });
      toast('HDO 部署任务已启动');
      return out;
    },

    async upsertHdoMeshGroup(input: {
      id?: string;
      name: string;
      slug?: string | null;
      description?: string | null;
      defaultProfileId?: string | null;
      enabled?: boolean;
      metadata?: Record<string, unknown> | null;
    }): Promise<HdoMeshGroupRow> {
      const out = await api<HdoMeshGroupRow>('/hdo/admin/mesh-groups', {
        method: 'POST',
        body: JSON.stringify(input)
      });
      toast(`已保存 mesh：${out.name}`);
      return out;
    },

    async upsertHdoMembership(input: {
      id?: string;
      meshGroupId: string;
      userId: string;
      role?: HdoMeshMembershipRow['role'];
      status?: HdoMeshMembershipRow['status'];
      profileId?: string | null;
      metadata?: Record<string, unknown> | null;
    }): Promise<HdoMeshMembershipRow> {
      const out = await api<HdoMeshMembershipRow>('/hdo/admin/memberships', {
        method: 'POST',
        body: JSON.stringify(input)
      });
      toast('HDO mesh 许可已保存');
      return out;
    },

    async upsertHdoNode(input: {
      id?: string;
      name: string;
      kind: HdoNodeRow['kind'];
      publicHost?: string | null;
      overlayIp?: string | null;
      status?: HdoNodeRow['status'];
      metadata?: Record<string, unknown> | null;
    }): Promise<HdoNodeRow> {
      const out = await api<HdoNodeRow>('/hdo/admin/nodes', {
        method: 'POST',
        body: JSON.stringify(input)
      });
      toast(`已保存节点：${out.name}`);
      return out;
    },

    async heartbeatHdoNode(id: string): Promise<HdoNodeRow> {
      const out = await api<HdoNodeRow>(`/hdo/admin/nodes/${encodeURIComponent(id)}/heartbeat`, {
        method: 'POST',
        body: JSON.stringify({ status: 'online' })
      });
      toast(`已更新节点在线状态：${out.name}`);
      return out;
    },

    async upsertHdoService(input: {
      id?: string;
      name: string;
      nodeId?: string | null;
      targetHost: string;
      targetPort: number;
      protocol?: HdoServiceRow['protocol'];
      domains?: string[];
      enabled?: boolean;
      metadata?: Record<string, unknown> | null;
    }): Promise<HdoServiceRow> {
      const out = await api<HdoServiceRow>('/hdo/admin/services', {
        method: 'POST',
        body: JSON.stringify(input)
      });
      toast(`已保存服务：${out.name}`);
      return out;
    },

    async upsertHdoProfile(input: {
      id?: string;
      name: string;
      mode: HdoProfileRow['mode'];
      enabled?: boolean;
      rules?: Record<string, unknown> | null;
      metadata?: Record<string, unknown> | null;
    }): Promise<HdoProfileRow> {
      const out = await api<HdoProfileRow>('/hdo/admin/profiles', {
        method: 'POST',
        body: JSON.stringify(input)
      });
      toast(`已保存 profile：${out.name}`);
      return out;
    },

    async upsertHdoRateLimit(input: {
      id?: string;
      subjectType: HdoRateLimitRow['subjectType'];
      subjectId: string;
      downRate?: string | null;
      downCeil?: string | null;
      upRate?: string | null;
      upCeil?: string | null;
      metadata?: Record<string, unknown> | null;
    }): Promise<HdoRateLimitRow> {
      const out = await api<HdoRateLimitRow>('/hdo/admin/rate-limits', {
        method: 'POST',
        body: JSON.stringify(input)
      });
      toast('HDO 限速已保存');
      return out;
    },

    async createHdoDeviceTask(input: {
      userId: string;
      deviceId?: string | null;
      pluginId?: string | null;
      kind: HdoDeviceTaskRow['kind'];
      payload?: Record<string, unknown> | null;
    }): Promise<HdoDeviceTaskRow> {
      const out = await api<HdoDeviceTaskRow>('/hdo/admin/device-tasks', {
        method: 'POST',
        body: JSON.stringify(input)
      });
      toast('已创建 HDO 设备任务');
      return out;
    }
  };
}
