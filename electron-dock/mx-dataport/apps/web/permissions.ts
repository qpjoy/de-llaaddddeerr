export const membershipFor = (session: any, tenant: string) =>
  session?.memberships?.find((m: any) => m.tenantId === tenant);
export const hasPermission = (
  session: any,
  tenant: string,
  permission: string,
) => {
  const member = membershipFor(session, tenant);
  return (
    !!member &&
    !member.dataport?.ownerChallengeRequired &&
    member.dataport?.permissions?.includes(permission) === true
  );
};
export const ownerOf = (session: any, tenant: string) =>
  membershipFor(session, tenant)?.role === "owner";
export const pagePermission: Record<string, string> = {
  intelligence: "history.read",
  overview: "usage.read",
  keys: "keys.read",
  services: "subscriptions.read",
  market: "subscriptions.buy",
  orders: "billing.read",
  "docs-ip": "docs.read",
  team: "members.read",
  audit: "audit.read",
  support: "support.read.self",
};
export function canOpenPage(session: any, tenant: string, page: string) {
  if (page === "platform") return session?.dataportPlatformAdmin === true;
  if (membershipFor(session, tenant)?.dataport?.ownerChallengeRequired)
    return false;
  if (page === "intelligence")
    return (
      hasPermission(session, tenant, "query.execute") ||
      hasPermission(session, tenant, "history.read")
    );
  if (page === "support")
    return (
      hasPermission(session, tenant, "support.read.self") ||
      hasPermission(session, tenant, "support.read.tenant") ||
      hasPermission(session, tenant, "support.create")
    );
  if (page === "account" || page === "messages")
    return !!membershipFor(session, tenant);
  return (
    !!pagePermission[page] &&
    hasPermission(session, tenant, pagePermission[page])
  );
}
export const enterpriseUrl = (tenant: string, path: string) =>
  `/bff/v1/enterprises/${tenant}/${path}`;
