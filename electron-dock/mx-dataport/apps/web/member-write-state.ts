// A missing response does not prove that a member update was rolled back.
export function memberUpdateUnconfirmedMessage(error: unknown): string | null {
  const failure = error as { status?: number; code?: string; requestId?: string };
  const status = failure?.status;
  if (
    failure?.code !== "invalid_response" &&
    status != null && status !== 0 && status !== 408 && status < 500
  ) return null;
  const trace = typeof failure?.requestId === "string" &&
    /^[0-9a-f-]{36}$/i.test(failure.requestId)
    ? `（请求编号：${failure.requestId}）` : "";
  return `操作结果尚未确认，可能已生效。请先关闭并核对当前设置，勿直接重复保存。${trace}`;
}
