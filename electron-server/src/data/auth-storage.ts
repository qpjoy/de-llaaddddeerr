/**
 * Kept for backwards compatibility — every call site now goes through the
 * backend-agnostic `data/index.ts` proxy. Delete this file once we've
 * migrated all imports.
 */
export {
  usersStore,
  refreshStore,
  entitlementsStore,
  codesStore,
  auditStore
} from './index.js';
