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
  message: error.message || "服务暂不可用，请稍后重试。",
  code: error.code,
  requestId: error.requestId,
});

// Authentication and customer permissions are separate reads. A customer
// service outage must not turn a verified identity into an anonymous visitor.
export async function loadHarborSession(
  read: (path: string) => Promise<any>,
): Promise<HarborSession> {
  let identity;
  try {
    identity = await read("/auth/sso/session");
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
    const { data } = await read("/bff/v1/session");
    if (
      !data ||
      !Array.isArray(data.tenantIds) ||
      !Array.isArray(data.memberships)
    )
      throw Error("空间权限响应无效，请重试。");
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
