import { readFileSync } from "node:fs";

export const DEFAULT_HUB_ORIGIN =
  "http://mx-insight-hub-admin.mx-insight-hub.svc.cluster.local:18151";

// Only Harbor's own database and listener are startup requirements.
export function readConfig(env = process.env) {
  try {
    const preview = env.MX_HARBOR_PREVIEW === "1",
      port = Number(env.MX_HARBOR_PORT || 18220);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error();
    if (preview) return { preview, port, host: "127.0.0.1" };
    const databaseUrl = env.MX_HARBOR_DATABASE_URL,
      db = new URL(databaseUrl);
    if (
      !["postgres:", "postgresql:"].includes(db.protocol) ||
      !/^\/mx_harbor(?:_test)?$/.test(db.pathname)
    )
      throw Error();
    return { preview: false, port, host: "0.0.0.0", databaseUrl };
  } catch {
    throw new Error(
      "Invalid Harbor database or listener configuration (values hidden)",
    );
  }
}

// Re-read projected Secret files on requests; Kubernetes can publish enrollment later.
// Missing/invalid integrations never become a preview user or bypass authorization.
export function readDependencies(env, readProfile) {
  let sso = null,
    gatewayToken = null,
    upstream = null;
  const dependencies = { auth: "pending", hub: "pending" };
  try {
    const profile = readProfile(env.MX_HARBOR_SSO_PROFILE);
    if (profile) {
      if (profile.appId !== "mx-harbor") throw Error();
      sso = profile;
      dependencies.auth = "configured";
    }
  } catch (error) {
    dependencies.auth = error.code === "ENOENT" ? "pending" : "invalid";
  }
  try {
    const origin = env.MX_HARBOR_HUB_ADMIN_ORIGIN || DEFAULT_HUB_ORIGIN;
    const url = new URL(origin);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.origin !== origin
    )
      throw Error();
    upstream = origin;
    const token = env.MX_HARBOR_GATEWAY_TOKEN_FILE
      ? readFileSync(env.MX_HARBOR_GATEWAY_TOKEN_FILE, "utf8").trim()
      : env.MX_HARBOR_GATEWAY_TOKEN;
    if (token) {
      if (token.length < 32) throw Error();
      gatewayToken = token;
      dependencies.hub = "configured";
    }
  } catch (error) {
    dependencies.hub = error.code === "ENOENT" ? "pending" : "invalid";
  }
  return { sso, gatewayToken, upstream, dependencies };
}
