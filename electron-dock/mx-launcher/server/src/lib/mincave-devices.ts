import { createHash } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import type { LauncherNetworkLease } from '../types.js';

export interface MinCaveDeviceInput {
  deviceId: string;
  deviceLabel: string | null;
  platform: string | null;
  deviceModel: string | null;
  osVersion: string | null;
}
export interface MinCaveDevice extends MinCaveDeviceInput {
  userId: string;
  firstSeenAt: string;
  lastSeenAt: string;
  lastVirtualIp: string | null;
}
export const mincaveDeviceKey = (userId: string, deviceId: string) =>
  createHash('sha256').update(JSON.stringify([userId, deviceId])).digest('hex');

// Device metadata describes the installation, never its owner. The owner comes from the bearer.
export function mincaveSessionDevice(body: unknown): MinCaveDeviceInput | null {
  if (body === undefined || body === null) return null;
  if (typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('设备信息不完整。');
  const value = body as Record<string, unknown>;
  if (Object.keys(value).some(key => key !== 'device')) throw new BadRequestException('不支持的登录信息。');
  if (value.device === undefined) return null; // Older clients have no device registration.
  if (!value.device || typeof value.device !== 'object' || Array.isArray(value.device))
    throw new BadRequestException('设备信息不完整。');
  const device = value.device as Record<string, unknown>;
  const fields = ['deviceId', 'deviceLabel', 'platform', 'deviceModel', 'osVersion'];
  if (Object.keys(device).some(key => !fields.includes(key))) throw new BadRequestException('不支持的设备信息。');
  const result: Record<string, string | null> = {};
  for (const key of fields) {
    const raw = device[key];
    if (raw === undefined || raw === null) { result[key] = null; continue; }
    if (typeof raw !== 'string' || raw.trim().length > 200 || /[\x00-\x1f\x7f]/.test(raw))
      throw new BadRequestException('设备信息格式不正确。');
    result[key] = raw.trim() || null;
  }
  if (!result.deviceId) throw new BadRequestException('缺少设备标识。');
  return result as unknown as MinCaveDeviceInput;
}

// Include released/expired leases as history. A lease is never evidence that a device is online.
export function mergeMinCaveDevices(userId: string, bindings: MinCaveDevice[], leases: LauncherNetworkLease[]): MinCaveDevice[] {
  const devices = new Map<string, MinCaveDevice>();
  const history: MinCaveDevice[] = leases.filter(lease =>
    lease.userId === userId && lease.identityKind === 'user' && lease.productId === 'mx-h2i' &&
    (!lease.appId || lease.appId === 'mx-h2i') && lease.deviceId,
  ).map(lease => ({
    userId, deviceId: lease.deviceId, deviceLabel: lease.deviceLabel,
    platform: lease.platform, deviceModel: lease.deviceModel || null, osVersion: lease.osVersion || null,
    firstSeenAt: lease.createdAt, lastSeenAt: lease.updatedAt, lastVirtualIp: lease.leaseIp || null,
  }));
  // Bindings win ties, so a newly supplied device name is not replaced by an old lease label.
  for (const row of [...history, ...bindings.filter(row => row.userId === userId)]) {
    const previous = devices.get(row.deviceId);
    if (!previous) { devices.set(row.deviceId, { ...row }); continue; }
    const [older, newer] = previous.lastSeenAt > row.lastSeenAt ? [row, previous] : [previous, row];
    devices.set(row.deviceId, {
      ...older, ...newer,
      deviceLabel: newer.deviceLabel || older.deviceLabel,
      platform: newer.platform || older.platform,
      deviceModel: newer.deviceModel || older.deviceModel,
      osVersion: newer.osVersion || older.osVersion,
      lastVirtualIp: newer.lastVirtualIp || older.lastVirtualIp,
      firstSeenAt: previous.firstSeenAt < row.firstSeenAt ? previous.firstSeenAt : row.firstSeenAt,
    });
  }
  return [...devices.values()].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt) || a.deviceId.localeCompare(b.deviceId));
}

export function observeMinCaveDevice(userId: string, device: MinCaveDeviceInput, history: MinCaveDevice[]): MinCaveDevice[] {
  const now = new Date().toISOString();
  return mergeMinCaveDevices(userId, [...history, {
    ...device, userId, firstSeenAt: now, lastSeenAt: now, lastVirtualIp: null,
  }], []);
}
