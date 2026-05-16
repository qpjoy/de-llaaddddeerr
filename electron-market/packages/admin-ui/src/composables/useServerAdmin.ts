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
    }
  };
}
