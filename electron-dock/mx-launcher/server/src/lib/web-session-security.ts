import { createHash } from 'node:crypto';

export interface WebSessionProof { authTime: number; sessionUid?: string; issuer: string }
export const identityScope = (environment: string, issuer: string) => createHash('sha256').update(`${environment}:${issuer}`).digest('hex');
export const webSecurityScope = (environment: string) => `web-security:${environment}`;
export const webDeviceId = (scope: string, uid: string) => createHash('sha256').update(`${scope}:${uid}`).digest('hex');
export function passwordSessionActive(user: { webSessionsInvalidBefore?: string }, authTime: number) {
  return Number.isFinite(authTime) && (!user.webSessionsInvalidBefore || authTime * 1000 > Date.parse(user.webSessionsInvalidBefore));
}

// Shared by the local BFF and Identity. No SDK tokens, leases or peers are read or changed.
export async function webSessionActive(
  query: (sql: string, values: unknown[]) => Promise<Array<{ data: Record<string, unknown> }>>,
  environment: string, userId: string, proof: WebSessionProof, scope = identityScope(environment, proof.issuer)
) {
  const ids = [`all:${userId}`, ...(proof.sessionUid ? [`device:${userId}:${webDeviceId(scope, proof.sessionUid)}`] : [])];
  const rows = await query("SELECT data FROM mx_identity_records WHERE scope=$1 AND kind='BrowserRevocation' AND id=ANY($2::text[]) AND expires_at>now()", [webSecurityScope(environment), ids]);
  return rows.every(row => Number(row.data.before) < proof.authTime * 1000);
}
