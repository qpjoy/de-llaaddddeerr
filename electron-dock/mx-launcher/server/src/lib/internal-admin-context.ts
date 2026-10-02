import { AsyncLocalStorage } from 'node:async_hooks';

// Only the same-origin SSO BFF sets this after checking session, local account,
// current mx-admin role and CSRF. Legacy /internal requests never set it.
export const internalAdminContext = new AsyncLocalStorage<{ userId: string; requestId: string }>();
