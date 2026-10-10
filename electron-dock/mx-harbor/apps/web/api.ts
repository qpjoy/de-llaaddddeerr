export const validIpv4 = (value: string) =>
  /^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(value) &&
  value.split(".").every((v) => Number(v) <= 255);
export async function request<T = any>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(path, {
    ...options,
    redirect: "error",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const result = await response.json();
  if (!response.ok)
    throw Object.assign(
      new Error(
        result.message || result.error?.message || "服务暂不可用，请稍后重试",
      ),
      { status: response.status, code: result.code },
    );
  return result;
}
export type AccountOptions = {
  csrf: string;
  formId: string;
  view?: string;
  policy?: { mode: string; version: number };
  admissionRequired?: boolean;
  loginHint?: string;
};
export const startAccountSession = (register = false) =>
  request<{ redirect: string }>(
    `/auth/sso/start?view=${register ? "register" : "login"}`,
    { method: "POST", body: "{}" },
  );
