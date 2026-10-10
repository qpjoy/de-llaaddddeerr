import { readApplicationSsoProfile } from "@qpjoy/mx-common/identity/profile";
function parseConfig(env) {
  const preview = env.MX_HARBOR_PREVIEW === "1",
    port = Number(env.MX_HARBOR_PORT || 18220);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw Error("MX_HARBOR_PORT must be a port number");
  if (preview) return { preview, port, host: "127.0.0.1" };
  const sso = readApplicationSsoProfile(env.MX_HARBOR_SSO_PROFILE);
  if (sso?.appId !== "mx-harbor") throw Error("Harbor SSO profile is required");
  const databaseUrl = env.MX_HARBOR_DATABASE_URL,
    db = new URL(databaseUrl);
  if (
    !["postgres:", "postgresql:"].includes(db.protocol) ||
    !/^\/mx_harbor(?:_test)?$/.test(db.pathname)
  )
    throw Error("Harbor requires its own mx_harbor database");
  const upstream = new URL(env.MX_HARBOR_HUB_ADMIN_ORIGIN);
  if (
    !["http:", "https:"].includes(upstream.protocol) ||
    upstream.username ||
    upstream.password ||
    upstream.origin !== env.MX_HARBOR_HUB_ADMIN_ORIGIN
  )
    throw Error("Invalid fixed customer-service upstream");
  const gatewayToken = env.MX_HARBOR_GATEWAY_TOKEN;
  if (!gatewayToken || gatewayToken.length < 32)
    throw Error("Dedicated Harbor gateway credential required");
  return {
    preview: false,
    port,
    host: "0.0.0.0",
    sso,
    databaseUrl,
    upstream: upstream.origin,
    gatewayToken,
  };
}

export function readConfig(env = process.env) {
  try {
    return parseConfig(env);
  } catch {
    throw new Error(
      "Invalid Harbor configuration; check the private SSO profile, dedicated database, fixed Hub origin, gateway credential and numeric port (values hidden)",
    );
  }
}
