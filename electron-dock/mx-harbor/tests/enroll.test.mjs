import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { enroll, HARBOR_ORIGIN } from "../scripts/enroll.mjs";
const encode = (value) =>
  Buffer.from(
    typeof value === "string" ? value : JSON.stringify(value),
  ).toString("base64");
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "harbor-enroll-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, "secrets");
  const p = {
    version: 1,
    appId: "mx-harbor",
    origin: HARBOR_ORIGIN,
    issuer: "https://auth.example.test/identity",
    audience: "mx-harbor",
    clientId: "mx-harbor-web",
    clientSecret: "c".repeat(43),
    sessionKey: "k".repeat(43),
  };
  const secrets = new Map([
    [
      "mx-harbor/mx-harbor-runtime",
      {
        metadata: { resourceVersion: "1" },
        data: {
          MX_HARBOR_DATABASE_URL: encode("retained-db"),
          OTHER: encode("retained-other"),
        },
      },
    ],
    [
      "mx-insight-hub/mx-insight-hub-browser-sso",
      {
        data: {
          "profile.json": encode({
            issuer: p.issuer,
            audience: "mx-insight-hub",
            legacyIssuer: "mx-user-center:test",
          }),
        },
      },
    ],
  ]);
  const state = { calls: 0, writes: 0, failPortal: false };
  const options = {
    directory,
    applicationFile: join(root, "launcher-profile.json"),
    readSecret: (ns, name) => structuredClone(secrets.get(`${ns}/${name}`)),
    writeSecret: (ns, name, previous, data) => {
      state.writes++;
      if (state.failPortal && name === "mx-harbor-portal")
        throw Error("simulated second write failure");
      secrets.set(`${ns}/${name}`, {
        ...previous,
        data: { ...previous?.data, ...data },
      });
    },
    register: (file) => {
      state.calls++;
      if (!existsSync(file))
        writeFileSync(file, JSON.stringify(p), { mode: 0o600 });
    },
  };
  const write = (file, value) => {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, value, { mode: 0o600 });
  };
  return { root, directory, p, secrets, state, options, write };
}
test("enroll preserves DB, synchronizes credentials, retries and recovers lost local files", (t) => {
  const f = fixture(t);
  assert.deepEqual(enroll(f.options), {
    origin: HARBOR_ORIGIN,
    appId: "mx-harbor",
  });
  const runtime = f.secrets.get("mx-harbor/mx-harbor-runtime");
  const portal = f.secrets.get("mx-insight-hub/mx-harbor-portal");
  assert.equal(runtime.data.MX_HARBOR_DATABASE_URL, encode("retained-db"));
  assert.equal(runtime.data.OTHER, encode("retained-other"));
  assert.equal(runtime.data["profile.json"], portal.data["profile.json"]);
  assert.equal(
    runtime.data.MX_HARBOR_GATEWAY_TOKEN,
    portal.data["gateway-token"],
  );
  const token = readFileSync(join(f.directory, "gateway-token"), "utf8");
  enroll(f.options);
  assert.deepEqual(f.secrets.get("mx-harbor/mx-harbor-runtime"), runtime);
  rmSync(f.directory, { recursive: true });
  enroll(f.options);
  assert.equal(
    JSON.parse(readFileSync(join(f.directory, "identity/profile.json")))
      .sessionKey,
    f.p.sessionKey,
  );
  assert.equal(readFileSync(join(f.directory, "gateway-token"), "utf8"), token);
});
test("partial Secret update retries with the same credentials", (t) => {
  const f = fixture(t);
  f.state.failPortal = true;
  assert.throws(() => enroll(f.options), /second write failure/);
  const retained = structuredClone(
    f.secrets.get("mx-harbor/mx-harbor-runtime"),
  );
  f.state.failPortal = false;
  enroll(f.options);
  assert.deepEqual(f.secrets.get("mx-harbor/mx-harbor-runtime"), retained);
  assert.equal(
    f.secrets.get("mx-insight-hub/mx-harbor-portal").data["gateway-token"],
    retained.data.MX_HARBOR_GATEWAY_TOKEN,
  );
});
test("conflicting profiles or gateway tokens fail before registration or writes", (t) => {
  const f = fixture(t);
  enroll(f.options);
  const portal = f.secrets.get("mx-insight-hub/mx-harbor-portal");
  const saved = structuredClone(portal);
  const calls = f.state.calls,
    writes = f.state.writes;
  portal.data["profile.json"] = encode({ ...f.p, sessionKey: "b".repeat(43) });
  assert.throws(() => enroll(f.options), /配置冲突/);
  f.secrets.set("mx-insight-hub/mx-harbor-portal", saved);
  saved.data["gateway-token"] = encode("x".repeat(43));
  assert.throws(() => enroll(f.options), /凭据冲突/);
  assert.equal(f.state.calls, calls);
  assert.equal(f.state.writes, writes);
});
test("wrong-domain private profile fails without changing registration", (t) => {
  const f = fixture(t);
  f.write(
    join(f.directory, "identity/profile.json"),
    JSON.stringify({ ...f.p, origin: "https://wrong.example.test" }),
  );
  assert.throws(() => enroll(f.options), /正式域名/);
  assert.equal(f.state.calls, 0);
  assert.equal(f.state.writes, 0);
});
test("enrollment requires canonical Hub identity and never invents it", (t) => {
  const f = fixture(t);
  f.secrets.delete("mx-insight-hub/mx-insight-hub-browser-sso");
  assert.throws(() => enroll(f.options), /Hub SSO 尚未接入/);
  assert.equal(f.state.calls, 0);
  assert.equal(f.state.writes, 0);
});

test("real Launcher registration preserves existing clients and reuses session keys on recovery", async (t) => {
  const { initializeProfile, readProfile, savePrivate } = await import(
    "../../mx-launcher/scripts/identity-profile.mjs"
  );
  const { createPublicEntry } = await import(
    "../../mx-launcher/scripts/identity-public-profile.mjs"
  );
  const { registerApplication } = await import(
    "../../mx-launcher/scripts/identity-app.mjs"
  );
  const f = fixture(t),
    file = join(f.root, "launcher/identity.json");
  const original = initializeProfile("https://10.88.88.88:18443", file);
  const publicEntry = createPublicEntry({
    origin: "https://auth.example.test",
    adminOrigin: "https://admin.example.test",
    hubOrigin: "https://hub.example.test",
    audience: "mx-insight-hub",
    privateOrigin: original.origin,
  });
  savePrivate(file, { ...original, publicEntry });
  f.options.register = (appFile) =>
    registerApplication({
      appId: "mx-harbor",
      origin: HARBOR_ORIGIN,
      audience: "mx-harbor",
      entry: "public",
      appFile,
      file,
    });
  enroll(f.options);
  const after = readProfile(file),
    runtime = structuredClone(f.secrets.get("mx-harbor/mx-harbor-runtime"));
  assert.deepEqual(
    { ...after, publicEntry: undefined },
    { ...original, publicEntry: undefined },
  );
  assert.deepEqual(
    { ...after.publicEntry, applications: undefined },
    { ...publicEntry, applications: undefined },
  );
  assert.deepEqual(
    after.publicEntry.applications.slice(0, -1),
    publicEntry.applications,
  );
  rmSync(f.directory, { recursive: true });
  enroll(f.options);
  assert.deepEqual(f.secrets.get("mx-harbor/mx-harbor-runtime"), runtime);
  assert.deepEqual(readProfile(file), after);
});
