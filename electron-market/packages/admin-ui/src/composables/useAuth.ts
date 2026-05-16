import { ref } from 'vue';
import { Notify } from 'quasar';

import {
  detectMode,
  getServerRefreshToken,
  getServerToken,
  setServerRefreshToken,
  setServerToken,
  useMode
} from 'src/composables/useMode';

export interface PublicUser {
  id: string;
  username: string | null;
  email: string | null;
  phone: string | null;
  displayName: string | null;
  role: 'user' | 'admin' | 'banned';
  emailVerified: boolean;
  phoneVerified: boolean;
  createdAt: string;
}

export interface AuthState {
  configured: boolean;
  user: PublicUser | null;
  accessExpiresAt: string | null;
  refreshExpiresAt: string | null;
}

interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string;
  refreshExpiresAt: string;
}

const state = ref<AuthState>({
  configured: false,
  user: null,
  accessExpiresAt: null,
  refreshExpiresAt: null
});
const busy = ref(false);

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(init.headers as Record<string, string> | undefined)
  };
  const tok = getServerToken();
  if (tok) headers.authorization = `Bearer ${tok}`;

  const res = await fetch(path, { ...init, headers });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let msg = `${res.status} ${res.statusText}`;
    try {
      msg = JSON.parse(body).error ?? msg;
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

function persistTokens(t: AuthTokens): void {
  setServerToken(t.accessToken);
  setServerRefreshToken(t.refreshToken);
}

export function useAuth() {
  const { mode, apiBase } = useMode();

  async function refresh(): Promise<void> {
    try {
      if (mode === 'local') {
        state.value = await api<AuthState>('/api/auth/state');
        return;
      }
      const tok = getServerToken();
      if (!tok) {
        state.value = { configured: true, user: null, accessExpiresAt: null, refreshExpiresAt: null };
        return;
      }
      try {
        const me = await api<PublicUser>(`${apiBase}/auth/me`);
        state.value = { configured: true, user: me, accessExpiresAt: null, refreshExpiresAt: null };
      } catch {
        state.value = { configured: true, user: null, accessExpiresAt: null, refreshExpiresAt: null };
      }
    } catch {
      state.value = { configured: false, user: null, accessExpiresAt: null, refreshExpiresAt: null };
    }
  }

  async function login(identifier: string, password: string): Promise<boolean> {
    busy.value = true;
    try {
      if (mode === 'local') {
        const next = await api<AuthState>('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({ identifier, password })
        });
        state.value = { ...next, configured: true };
      } else {
        const out = await api<{ user: PublicUser; tokens: AuthTokens }>(
          `${apiBase}/auth/login`,
          { method: 'POST', body: JSON.stringify({ identifier, password }) }
        );
        persistTokens(out.tokens);
        state.value = {
          configured: true,
          user: out.user,
          accessExpiresAt: out.tokens.accessExpiresAt,
          refreshExpiresAt: out.tokens.refreshExpiresAt
        };
      }
      toast(`欢迎回来，${state.value.user?.displayName ?? state.value.user?.username ?? '用户'}`);
      return true;
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'negative');
      return false;
    } finally {
      busy.value = false;
    }
  }

  async function register(input: {
    username?: string;
    email?: string;
    phone?: string;
    password: string;
    displayName?: string;
    verificationCode?: string;
  }): Promise<boolean> {
    busy.value = true;
    try {
      if (mode === 'local') {
        const next = await api<AuthState>('/api/auth/register', {
          method: 'POST',
          body: JSON.stringify(input)
        });
        state.value = { ...next, configured: true };
      } else {
        const out = await api<{ user: PublicUser; tokens: AuthTokens }>(
          `${apiBase}/auth/register`,
          { method: 'POST', body: JSON.stringify(input) }
        );
        persistTokens(out.tokens);
        state.value = {
          configured: true,
          user: out.user,
          accessExpiresAt: out.tokens.accessExpiresAt,
          refreshExpiresAt: out.tokens.refreshExpiresAt
        };
      }
      toast('注册成功');
      return true;
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'negative');
      return false;
    } finally {
      busy.value = false;
    }
  }

  async function logout(): Promise<void> {
    busy.value = true;
    try {
      if (mode === 'local') {
        await api<{ ok: true }>('/api/auth/logout', { method: 'POST' });
      } else {
        const refreshToken = getServerRefreshToken();
        await api<{ ok: true }>(`${apiBase}/auth/logout`, {
          method: 'POST',
          body: JSON.stringify({ refreshToken })
        }).catch(() => undefined);
        setServerToken(null);
        setServerRefreshToken(null);
      }
      state.value = { configured: state.value.configured, user: null, accessExpiresAt: null, refreshExpiresAt: null };
      toast('已退出');
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'negative');
    } finally {
      busy.value = false;
    }
  }

  async function requestCode(payload: {
    channel: 'email' | 'sms';
    destination: string;
    purpose: 'register' | 'login' | 'reset';
  }): Promise<boolean> {
    try {
      const path = mode === 'local' ? '/api/auth/code' : `${apiBase}/auth/code`;
      await api<{ delivered: string }>(path, {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      toast('验证码已发送（开发环境请看服务端控制台）');
      return true;
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'negative');
      return false;
    }
  }

  return { state, busy, refresh, login, register, logout, requestCode, mode: detectMode() };
}
