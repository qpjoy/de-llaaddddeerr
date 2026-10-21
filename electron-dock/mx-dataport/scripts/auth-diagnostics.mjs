import { rootCertificates } from "node:tls";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Agent, fetch as secureFetch } from "undici";
import { readApplicationSsoProfile } from "@qpjoy/mx-common/identity/profile";

// Only these fixed categories may leave the process; errors can contain URLs or credentials.
function networkCategory(error) {
  for (let depth = 0; error && depth < 5; depth++, error = error.cause) {
    if (["ENOTFOUND", "EAI_AGAIN", "EAI_FAIL"].includes(error.code)) return "dns_error";
    if (["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"].includes(error.code)
      || ["TimeoutError", "AbortError"].includes(error.name)) return "timeout";
    if (["CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
      "ERR_TLS_CERT_ALTNAME_INVALID", "ERR_SSL_WRONG_VERSION_NUMBER"].includes(error.code)) return "tls_error";
    if (["ECONNREFUSED", "ECONNRESET", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_SOCKET"].includes(error.code)) return "connection_error";
  }
  return "network_error";
}

async function probe(url, options, transport, check) {
  let response;
  try {
    response = await transport(url, {
      ...options,
      // Preserve the status of redirects without ever following their target.
      redirect: "manual",
      signal: AbortSignal.timeout(options.method === "POST" ? 15000 : 8000),
    });
  } catch (error) {
    return { status: null, category: networkCategory(error) };
  }
  const status = response.status;
  if (!response.ok) {
    try { await response.body?.cancel(); } catch {}
    return {
      status,
      category: status >= 300 && status < 400 ? "redirect_refused"
        : status >= 500 ? "upstream_http_error" : "http_error",
    };
  }
  let body;
  try { body = await response.json(); }
  catch (error) {
    const category = networkCategory(error);
    return { status, category: category === "network_error" ? "invalid_json" : category, jsonValid: false };
  }
  const checks = check(body);
  return {
    status,
    category: Object.values(checks).every(Boolean) ? "ok" : "configuration_mismatch",
    jsonValid: true,
    ...checks,
  };
}

export async function diagnoseAuth({
  env = process.env,
  readProfile = readApplicationSsoProfile,
  fetch: transport = secureFetch,
  createDispatcher = (profile) => new Agent({
    connect: { ca: profile.caCert ? [...rootCertificates, profile.caCert] : rootCertificates },
  }),
} = {}) {
  const result = {
    ok: false,
    profile: { valid: false, category: "missing" },
    discovery: { status: null, category: "not_attempted" },
    capabilities: { status: null, category: "not_attempted" },
  };
  let profile;
  try {
    profile = readProfile(env.MX_HARBOR_SSO_PROFILE);
    if (!profile) return result;
    if (profile.appId !== "mx-harbor") throw Error();
    result.profile = { valid: true, category: "valid", customCaConfigured: Boolean(profile.caCert) };
  } catch (error) {
    result.profile.category = error.code === "ENOENT" ? "missing" : "invalid";
    return result;
  }
  let dispatcher;
  try {
    dispatcher = createDispatcher(profile);
    const issuer = profile.issuer.replace(/\/$/, "");
    // Use only the mounted current issuer; discovery cannot supply another request target.
    result.discovery = await probe(`${issuer}/.well-known/openid-configuration`, {
      method: "GET", dispatcher,
    }, transport, (body) => ({ issuerMatches: body?.issuer === profile.issuer }));
    // This authenticated capability read creates no login transaction, session, or account.
    result.capabilities = await probe(`${issuer}/app-account`, {
      method: "POST", dispatcher,
      headers: {
        "content-type": "application/json",
        authorization: `Basic ${Buffer.from(`${profile.clientId}:${profile.clientSecret}`).toString("base64")}`,
      },
      body: JSON.stringify({ action: "capabilities", input: {} }),
    }, transport, (body) => ({
      nativeForm: body?.nativeForm === true,
      appIdMatches: body?.appId === profile.appId,
      originMatches: body?.origin === profile.origin,
      audienceMatches: body?.audience === profile.audience,
    }));
    result.ok = result.discovery.category === "ok" && result.capabilities.category === "ok";
  } catch {
    result.category = "diagnostic_failed";
  } finally {
    try { await dispatcher?.close(); } catch {}
  }
  return result;
}

// kubectl exec -i ... -- node --input-type=module < scripts/auth-diagnostics.mjs
const stdinEntry = !process.argv[1] && /\/\[eval\d*\]$/.test(import.meta.url);
if (stdinEntry || (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)) {
  try {
    const result = await diagnoseAuth();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.ok ? 0 : 1;
  } catch {
    process.stdout.write('{"ok":false,"category":"diagnostic_failed"}\n');
    process.exitCode = 1;
  }
}
