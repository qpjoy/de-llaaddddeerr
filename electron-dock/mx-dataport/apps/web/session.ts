export type SessionIssue = {
  message: string;
  code?: string;
  requestId?: string;
};
export type HarborSession = {
  active: boolean | null;
  csrf: string;
  customer: any | null;
  issue: SessionIssue | null;
};
export const emptySession: HarborSession = {
  active: null,
  csrf: "",
  customer: null,
  issue: null,
};
const issueFor = (error: any): SessionIssue => ({
  message: error.name === "TimeoutError"
    ? "登录状态确认超时，请重试连接。"
    : error.message || "服务暂不可用，请稍后重试。",
  code: error.name === "TimeoutError" ? "session_timeout" : error.code,
  requestId: error.requestId,
});

// Authentication and customer permissions are separate reads. A customer
// service outage must not turn a verified identity into an anonymous visitor.
export async function loadHarborSession(
  read: (path: string, options?: RequestInit) => Promise<any>,
): Promise<HarborSession> {
  // Bound the entire identity + permissions refresh, including refreshes after
  // local login. A stalled read must resolve to the existing retry UI.
  const signal = AbortSignal.timeout(15000);
  let identity;
  try {
    identity = await read("/auth/sso/session", { signal });
    if (typeof identity.active !== "boolean") throw Error("登录状态响应无效。");
  } catch (error) {
    return { ...emptySession, issue: issueFor(error) };
  }
  const result = {
    ...emptySession,
    active: identity.active,
    csrf: identity.csrf || "",
  };
  if (!identity.active) return result;
  try {
    const { data, requestId } = await read("/bff/v1/session", { signal });
    if (
      !data ||
      !Array.isArray(data.tenantIds) ||
      !Array.isArray(data.memberships)
    )
      throw Error("空间权限响应无效，请重试。");
    // Older Hub sessions contain tenant roles/capabilities but no DataPort
    // permissions. Treat an incomplete deployment as a dependency failure,
    // never fabricate customer permissions from a verified identity alone.
    if (
      data.memberships.some((member: any) =>
        !member ||
        typeof member.tenantId !== "string" ||
        !Array.isArray(member.dataport?.permissions) ||
        !member.dataport.permissions.every((permission: unknown) => typeof permission === "string")
      ) ||
      data.tenantIds.some((tenant: unknown) =>
        typeof tenant !== "string" ||
        !data.memberships.some((member: any) => member.tenantId === tenant)
      )
    )
      throw Object.assign(
        Error("企业权限服务尚未就绪，请联系管理员完成服务更新。"),
        { code: "customer_permissions_unavailable", requestId },
      );
    return { ...result, customer: data };
  } catch (error: any) {
    // Only an explicit local/session rejection expires authentication. A Portal
    // gateway error is not proof that the browser's login has expired.
    if (
      [
        "login_required",
        "sso_session_invalid",
        "sso_identity_invalid",
      ].includes(error.code)
    )
      return { ...emptySession, active: false, issue: issueFor(error) };
    return { ...result, issue: issueFor(error) };
  }
}
