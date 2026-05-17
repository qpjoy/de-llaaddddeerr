import type { Session } from 'electron';

import type { RuntimeMode, TunnelPorts } from '../types';

export async function applyElectronProxy(session: Session, mode: RuntimeMode, ports: TunnelPorts): Promise<void> {
  if (mode === 'system-tun') {
    await session.setProxy({ mode: 'direct' });
    return;
  }

  const proxyRules = [
    `http=127.0.0.1:${ports.mixed}`,
    `https=127.0.0.1:${ports.mixed}`,
    `socks5=127.0.0.1:${ports.mixed}`
  ].join(';');

  await session.setProxy({
    mode: 'fixed_servers',
    proxyRules,
    proxyBypassRules: '<local>;localhost;127.0.0.1;::1'
  });
}

export function proxyEnv(ports: TunnelPorts): NodeJS.ProcessEnv {
  return {
    http_proxy: `http://127.0.0.1:${ports.mixed}`,
    https_proxy: `http://127.0.0.1:${ports.mixed}`,
    HTTP_PROXY: `http://127.0.0.1:${ports.mixed}`,
    HTTPS_PROXY: `http://127.0.0.1:${ports.mixed}`,
    all_proxy: `socks5h://127.0.0.1:${ports.mixed}`,
    ALL_PROXY: `socks5h://127.0.0.1:${ports.mixed}`
  };
}
