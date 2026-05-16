import type { MihomoApiResponse, RuntimeSettings } from '../types';

export class MihomoApi {
  constructor(private readonly getSettings: () => RuntimeSettings) {}

  async request<T = unknown>(path: string, init: RequestInit = {}): Promise<MihomoApiResponse<T>> {
    const settings = this.getSettings();
    const url = `http://127.0.0.1:${settings.ports.controller}${path}`;
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${settings.controllerSecret}`);

    const response = await fetch(url, {
      ...init,
      headers
    });

    const contentType = response.headers.get('content-type') ?? '';
    const data = contentType.includes('application/json')
      ? await response.json() as T
      : await response.text() as T;

    return {
      ok: response.ok,
      status: response.status,
      data
    };
  }

  version(): Promise<MihomoApiResponse> {
    return this.request('/version');
  }

  proxies(): Promise<MihomoApiResponse> {
    return this.request('/proxies');
  }

  connections(): Promise<MihomoApiResponse> {
    return this.request('/connections');
  }

  reloadConfig(configPath: string): Promise<MihomoApiResponse> {
    return this.request('/configs?force=true', {
      method: 'PUT',
      body: JSON.stringify({ path: configPath }),
      headers: {
        'content-type': 'application/json'
      }
    });
  }

  async selectProxy(groupName: string, proxyName: string): Promise<MihomoApiResponse> {
    return this.request(`/proxies/${encodeURIComponent(groupName)}`, {
      method: 'PUT',
      body: JSON.stringify({ name: proxyName }),
      headers: {
        'content-type': 'application/json'
      }
    });
  }
}
