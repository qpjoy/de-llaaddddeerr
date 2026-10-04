import { createHmac } from 'node:crypto';
import { request } from 'node:https';
import type { EnterpriseInvitation } from '../registration/repository.js';

// Only the static OIDC registry chooses the destination and client secret.
export async function resolveHubInvitation(app: { origin: string; clientId: string; clientSecret: string }, issuer: string, handle: string): Promise<EnterpriseInvitation> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(handle)) throw new Error('Invalid invitation context');
  const body = JSON.stringify({ clientId: app.clientId, issuer, handle, timestamp: Date.now() });
  const signature = createHmac('sha256', app.clientSecret).update(`mx-hub-invitation-proof-v1:${body}`).digest('hex');
  return new Promise((resolve, reject) => {
    const req = request(new URL('/auth/sso/invitation-proof', app.origin), { method: 'POST', signal: AbortSignal.timeout(5000),
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-mx-invitation-signature': signature } }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; if (Buffer.byteLength(text) > 4096) res.destroy(new Error('Invitation response too large')); });
      res.on('error', reject);
      res.on('end', () => {
        try {
          const value = JSON.parse(text) as EnterpriseInvitation;
          if (res.statusCode !== 200 || value.issuer !== app.origin || value.clientId !== app.clientId
            || !/^[a-f0-9-]{36}$/i.test(value.invitationId) || !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= Date.now()) throw new Error('Invitation is no longer available');
          resolve(value);
        } catch (error) { reject(error); }
      });
    });
    req.on('error', reject); req.end(body);
  });
}
