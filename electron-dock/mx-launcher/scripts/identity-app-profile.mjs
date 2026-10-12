import { createHash } from 'node:crypto';

// Shared by deployment and its earlier recovery gate. Only an explicit offline
// Harbor -> DataPort migration may change this public client's origin/name.
export function isDataPortOriginMigration(current, desired, proof) {
  return current?.appId === 'mx-harbor' && current.origin === 'https://harbor.minsight-ai.com'
    && proof?.previousClientHash === createHash('sha256').update(JSON.stringify(current)).digest('hex')
    && JSON.stringify({ ...current, origin: 'https://dataport.minsight-ai.com', displayName: '数港 DataPort' }) === JSON.stringify(desired);
}

export function validApplicationList(apps, reservedClientId, validateOrigin) {
  if (!Array.isArray(apps) || apps.length > 64) return false;
  const clients = new Set(), ids = new Set();
  return apps.every(app => {
    try {
      const url = new URL(app.origin);
      if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(app.appId) || !/^[A-Za-z0-9_-]{1,160}$/.test(app.clientId)
        || app.clientId === reservedClientId || clients.has(app.clientId) || ids.has(app.appId)
        || !/^[A-Za-z0-9_-]{43}$/.test(app.clientSecret) || typeof app.audience !== 'string' || !app.audience || app.audience.length > 256
        || url.protocol !== 'https:' || url.origin !== app.origin || url.username || url.password) return false;
      validateOrigin?.(app.origin); clients.add(app.clientId); ids.add(app.appId); return true;
    } catch { return false; }
  });
}
