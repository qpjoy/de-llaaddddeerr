import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { diagnoseAuth } from "../scripts/auth-diagnostics.mjs";

const profile = {
  appId: "mx-harbor",
  issuer: "https://private-issuer.example.test/identity",
  origin: "https://private-application.example.test",
  clientId: "private-client-id",
  clientSecret: "private-client-secret",
  audience: "private-audience",
  sessionKey: "k".repeat(43),
};
const capabilities = {
  nativeForm: true, appId: profile.appId, origin: profile.origin, audience: profile.audience,
};
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
function fixture(transport, settings = profile) {
  let closed = false;
  const requests = [];
  const dispatcher = { close: async () => { closed = true; } };
  return {
    requests,
    closed: () => closed,
    run: () => diagnoseAuth({
      env: { MX_HARBOR_SSO_PROFILE: "/private-mounted-profile.json" },
      readProfile: (file) => { assert.equal(file, "/private-mounted-profile.json"); return settings; },
      createDispatcher: (value) => { assert.equal(value, settings); return dispatcher; },
      fetch: async (url, options) => {
        assert.equal(options.dispatcher, dispatcher);
        assert.equal(options.redirect, "manual");
        assert.ok(options.signal instanceof AbortSignal);
        requests.push({ url, options });
        return transport(url, options, requests.length);
      },
    }),
  };
}
function noSecrets(result) {
  const output = JSON.stringify(result);
  for (const value of [profile.issuer, profile.origin, profile.clientId, profile.clientSecret, profile.audience,
    profile.sessionKey, "/private-mounted-profile.json", "raw-private-error", "secret-cookie",
    Buffer.from(`${profile.clientId}:${profile.clientSecret}`).toString("base64")]) {
    assert.ok(!output.includes(value), `Diagnostic output exposed fixture secret`);
  }
}

test("successful diagnostics use only fixed discovery and authenticated read-only capabilities", async () => {
  const f = fixture((_url, _options, count) => count === 1
    ? json({ issuer: profile.issuer, token_endpoint: "https://untrusted.example.test/token" }) : json(capabilities));
  const result = await f.run();
  assert.equal(result.ok, true);
  assert.equal(result.discovery.issuerMatches, true);
  assert.equal(result.capabilities.category, "ok");
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[0].url, `${profile.issuer}/.well-known/openid-configuration`);
  assert.equal(f.requests[0].options.method, "GET");
  assert.equal(f.requests[0].options.headers, undefined);
  assert.equal(f.requests[1].url, `${profile.issuer}/app-account`);
  assert.equal(f.requests[1].options.method, "POST");
  assert.deepEqual(JSON.parse(f.requests[1].options.body), { action: "capabilities", input: {} });
  assert.equal(f.requests[1].options.headers.authorization,
    `Basic ${Buffer.from(`${profile.clientId}:${profile.clientSecret}`).toString("base64")}`);
  assert.equal(f.requests[1].options.headers.cookie, undefined);
  assert.equal(f.closed(), true);
  noSecrets(result);
});

test("HTML 502 retains the HTTP status for both probes without parsing or exposing its body", async () => {
  const f = fixture(() => new Response(`<html>${profile.clientSecret} raw-private-error</html>`, {
    status: 502, headers: { "set-cookie": "secret-cookie" },
  }));
  const result = await f.run();
  assert.equal(result.ok, false);
  for (const name of ["discovery", "capabilities"]) {
    assert.deepEqual(result[name], { status: 502, category: "upstream_http_error" });
  }
  assert.equal(f.requests.length, 2);
  noSecrets(result);
});

test("capability rejection preserves 401 without leaking the response", async () => {
  const result = await fixture((_url, _options, count) => count === 1
    ? json({ issuer: profile.issuer }) : json({ message: profile.clientSecret }, 401)).run();
  assert.equal(result.ok, false);
  assert.deepEqual(result.capabilities, { status: 401, category: "http_error" });
  noSecrets(result);
});

test("profile and server disagreements are reported only as booleans", async () => {
  const result = await fixture((_url, _options, count) => count === 1
    ? json({ issuer: "https://unexpected-issuer.example.test" })
    : json({ nativeForm: false, appId: "another-app", origin: "https://other.example.test", audience: "other" })).run();
  assert.equal(result.ok, false);
  assert.equal(result.discovery.category, "configuration_mismatch");
  assert.equal(result.discovery.issuerMatches, false);
  assert.deepEqual(result.capabilities, {
    status: 200, category: "configuration_mismatch", jsonValid: true,
    nativeForm: false, appIdMatches: false, originMatches: false, audienceMatches: false,
  });
  noSecrets(result);
});

test("redirect targets are never followed and malformed success bodies remain diagnosable", async () => {
  const f = fixture((_url, _options, count) => count === 1
    ? new Response(null, { status: 302, headers: { location: "https://other.example.test" } })
    : new Response("raw-private-error", { status: 200 }));
  const result = await f.run();
  assert.deepEqual(result.discovery, { status: 302, category: "redirect_refused" });
  assert.deepEqual(result.capabilities, { status: 200, category: "invalid_json", jsonValid: false });
  assert.equal(f.requests.length, 2);
  noSecrets(result);
});

test("network errors use an allowlist and never expose arbitrary codes or messages", async () => {
  for (const [code, category] of [["ENOTFOUND", "dns_error"], ["CERT_HAS_EXPIRED", "tls_error"],
    ["UND_ERR_CONNECT_TIMEOUT", "timeout"], ["ECONNREFUSED", "connection_error"],
    [profile.clientSecret, "network_error"]]) {
    const f = fixture(() => {
      throw Object.assign(Error(`raw-private-error ${profile.issuer}`), {
        cause: Object.assign(Error(profile.clientSecret), { code }),
      });
    });
    const result = await f.run();
    assert.equal(result.ok, false);
    assert.deepEqual(result.discovery, { status: null, category });
    assert.deepEqual(result.capabilities, { status: null, category });
    assert.equal(f.closed(), true);
    noSecrets(result);
  }
});

test("missing or invalid DataPort profiles make no network requests", async () => {
  for (const settings of [null, { ...profile, appId: "mx-h2i" }]) {
    const f = fixture(() => { throw Error("unexpected request"); }, settings);
    const result = await f.run();
    assert.equal(result.ok, false);
    assert.equal(result.profile.valid, false);
    assert.equal(result.profile.category, settings ? "invalid" : "missing");
    assert.equal(f.requests.length, 0);
    noSecrets(result);
  }
});

test("stdin CLI uses production profile validation and emits only sanitized JSON", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "dataport-auth-diagnostic-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "profile.json");
  writeFileSync(file, JSON.stringify({ ...profile, issuer: `http://invalid/${profile.clientSecret}` }), { mode: 0o600 });
  const child = spawnSync(process.execPath, ["--input-type=module"], {
    cwd: new URL("..", import.meta.url),
    input: readFileSync(new URL("../scripts/auth-diagnostics.mjs", import.meta.url), "utf8"),
    env: { ...process.env, MX_HARBOR_SSO_PROFILE: file }, encoding: "utf8",
  });
  assert.equal(child.status, 1);
  assert.equal(child.stderr, "");
  const result = JSON.parse(child.stdout);
  assert.equal(result.profile.category, "invalid");
  noSecrets(result);
});
