import type { PlatformStore } from '../../store/platform-store.js';
import { luopanIdentifiedInstallUsers } from '../../store/user-app-update-policy.js';
import type { ReleaseManagementPlan } from '../../types.js';

/** Old clients report a Java account ID, not an MX subject. Never authorize by it. */
export async function luopanInstallUpdatePolicy(store: PlatformStore, installId: string) {
  const leases = await store.listLauncherNetworkLeasesForInstall('luopan', installId);
  const userId = luopanIdentifiedInstallUsers(leases).get(installId);
  if (!userId) return { identity: 'unconfirmed' as const, updatesBlocked: false };
  const policy = await store.getUserAppUpdatePolicy('luopan', userId);
  return {
    identity: 'identified' as const,
    userId,
    updatesBlocked: policy?.updatesBlocked === true,
    revision: policy?.revision ?? 0
  };
}

/** Bind the restriction to the server-owned plan, never the request's productId. */
export function isLuopanReleasePlan(plan: ReleaseManagementPlan): boolean {
  // The old plan writer defaulted productId to launcherComponentId. Renderer
  // plans therefore persisted this exact alias even for appId=luopan.
  if (plan.productId === 'luopan-renderer') {
    return [plan.components.launcher?.componentId, plan.components.app?.componentId]
      .includes('luopan-renderer');
  }
  if (plan.productId) return plan.productId === 'luopan';
  // Pre-V2 plans did not persist productId. Only the established Luopan
  // component namespace is evidence of ownership; package names are not IDs.
  return [plan.components.launcher?.componentId, plan.components.app?.componentId]
    .some((id) => id === 'luopan' || id?.startsWith('luopan-'));
}
