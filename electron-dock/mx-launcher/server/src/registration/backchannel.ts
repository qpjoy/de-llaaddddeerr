import { createHmac, timingSafeEqual } from 'node:crypto';
import type { RegistrationInput, RegistrationPolicy } from './repository.js';

export const registrationSignature = (secret: string, body: unknown) =>
  createHmac('sha256', secret).update(`mx-registration-v1:${JSON.stringify(body)}`).digest('hex');
export function verifyRegistrationSignature(secret: string, body: { timestamp?: number } & Record<string, unknown>, signature?: string) {
  if (!secret || !Number.isSafeInteger(body.timestamp) || Math.abs(Date.now() - body.timestamp!) > 30000 || !/^[a-f0-9]{64}$/.test(signature ?? '')) return false;
  return timingSafeEqual(Buffer.from(signature!, 'hex'), Buffer.from(registrationSignature(secret, body), 'hex'));
}
export interface RegistrationClient {
  policy(): Promise<RegistrationPolicy>;
  register(input: Omit<RegistrationInput, 'clientId'>): Promise<{ userId: string }>;
}
export class RegistrationClientError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export function createRegistrationClient(upstream: URL, clientId: string, secret: string): RegistrationClient {
  const call = async (action: string, input: unknown) => {
    const body = { timestamp: Date.now(), clientId, action, input };
    const response = await fetch(new URL('/identity-backend/registration', upstream), { method: 'POST', redirect: 'error',
      signal: AbortSignal.timeout(15000), headers: { 'content-type': 'application/json', 'x-mx-identity-signature': registrationSignature(secret, body) }, body: JSON.stringify(body) });
    const payload = await response.json() as { code?: string; message?: string };
    if (!response.ok) {
      const messages: Record<string, string> = { registration_closed: '暂未开放新账号注册。', policy_changed: '注册策略已更新，请刷新页面重试。',
        account_unavailable: '此账号不可用，请更换账号；已有账号请直接登录。', invitation_unavailable: '邀请码无效、已停用、已到期或名额已用完。',
        registration_conflict: '此注册请求已完成，请使用原账号登录。', invalid_registration: '账号需为 3–64 位字母、数字、点、下划线或短横线，并以字母开头；密码需为 8–128 位。' };
      throw new RegistrationClientError(response.status, messages[payload.code ?? ''] ?? '注册暂不可用，请稍后重试。');
    }
    return payload;
  };
  return { policy: () => call('policy', {}) as Promise<RegistrationPolicy>, register: input => call('register', input) as Promise<{ userId: string }> };
}
