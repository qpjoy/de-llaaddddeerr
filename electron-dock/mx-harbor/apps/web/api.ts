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
  let result;
  try {
    result = await response.json();
  } catch {
    throw Object.assign(new Error("服务响应异常，请稍后重试。"), {
      status: response.status,
      code: "invalid_response",
      requestId: response.headers.get("x-request-id"),
    });
  }
  if (!response.ok)
    throw Object.assign(
      new Error(
        result.message || result.error?.message || "服务暂不可用，请稍后重试",
      ),
      {
        status: response.status,
        code: result.code || result.error?.code,
        requestId: result.requestId || response.headers.get("x-request-id"),
      },
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
