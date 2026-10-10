import type { UserCenterUser } from '../types.js';
export function canAccessIdentityApplication(user: UserCenterUser | undefined, appId: string): boolean {
  return Boolean(user && user.status === 'active' && !user.appAccess?.deniedAppIds?.includes(appId)
    && (appId !== 'mx-harbor' || user.appAccess?.allowedAppIds?.includes(appId)));
}
