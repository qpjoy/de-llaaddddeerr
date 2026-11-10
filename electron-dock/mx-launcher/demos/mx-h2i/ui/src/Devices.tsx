import { useEffect, useState } from 'react';
import { view, type Snapshot } from './bridge';
import monitor from './assets/monitor.svg';

export interface AccountDevice {
  deviceId: string;
  deviceLabel: string | null;
  platform: string | null;
  deviceModel: string | null;
  osVersion: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  lastVirtualIp: string | null;
}
export type DeviceResult =
  | { ok: true; value: { userId: string; devices: AccountDevice[] } }
  | { ok: false; error: { code: string; message: string } };

export default function Devices({ snapshot }: { snapshot: Snapshot }) {
  const owner = snapshot.access.userId;
  const [attempt, retry] = useState(0);
  const [state, setState] = useState<{ devices?: AccountDevice[]; error?: boolean }>({});
  useEffect(() => {
    let active = true;
    let request = 0;
    const load = async () => {
      const sequence = ++request;
      try {
        const result = await view.devices();
        if (!active || sequence !== request) return;
        if (!result.ok || result.value.userId !== owner) setState({ error: true });
        else setState({ devices: result.value.devices });
      } catch {
        if (active && sequence === request) setState({ error: true });
      }
    };
    setState({});
    void load();
    window.addEventListener('focus', load);
    return () => { active = false; window.removeEventListener('focus', load); };
  }, [owner, attempt]);

  if (!state.devices) return (
    <section className="mincave-panel mincave-device-state" aria-live="polite">
      <p role={state.error ? 'alert' : 'status'}>{state.error ? '暂时无法获取设备' : '正在获取设备…'}</p>
      {state.error && <button className="mincave-button" onClick={() => retry(attempt + 1)}>重试</button>}
    </section>
  );
  if (!state.devices.length) return <section className="mincave-panel mincave-device-state" role="status">暂无设备记录</section>;
  const currentId = snapshot.runtime.installation?.deviceId;
  const devices = [...state.devices].sort((a, b) =>
    Number(b.deviceId === currentId) - Number(a.deviceId === currentId) ||
    b.lastSeenAt.localeCompare(a.lastSeenAt) || a.deviceId.localeCompare(b.deviceId));
  return <div className="mincave-devices" aria-label="账号设备">
    {devices.map(device => {
      const current = device.deviceId === currentId;
      const connected = current && snapshot.connected;
      const address = current ? (connected ? snapshot.runtime.connection?.localIp || '—' : '未连接') : device.lastVirtualIp || '—';
      return <section className="mincave-panel mincave-device" key={device.deviceId}>
        <span className="mincave-device-illustration" aria-hidden="true"><img src={monitor} alt="" /></span>
        <div className="mincave-device-identity">
          <h2>{device.deviceLabel || device.deviceModel || ({ darwin: 'macOS 设备', win32: 'Windows 设备', linux: 'Linux 设备' }[device.platform || '']) || '已登录设备'}</h2>
          <p>{current ? '当前设备' : '历史设备'}</p>
          <span className={`mincave-status ${connected ? 'green' : 'gray'}`}><i />{current ? (connected ? '已连接' : '未连接') : '已绑定'}</span>
        </div>
        <div className="mincave-device-address"><small>{current ? '虚拟地址' : '最近虚拟地址'}</small><strong>{address}</strong></div>
      </section>;
    })}
  </div>;
}
