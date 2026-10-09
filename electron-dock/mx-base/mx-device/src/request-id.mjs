// randomUUID is secure-context-only; getRandomValues also works on HTTP server IPs.
// These IDs are idempotency keys, not authentication credentials.
export function requestId(cryptoApi = globalThis.crypto) {
  if (typeof cryptoApi?.randomUUID === "function")
    return cryptoApi.randomUUID();
  if (typeof cryptoApi?.getRandomValues !== "function")
    throw new Error("浏览器不支持安全随机数，请使用现代浏览器或 HTTPS 访问");
  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
