import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DataportAccountsClient } from "../../server/portal/dataport-accounts.mjs";
import pg from "pg";
import { DataportSupport } from "../../server/portal/dataport-support.mjs";
import { CustomerMessages } from "../../server/commerce/messages.mjs";
import { DataportStore, digest } from "../../server/portal/dataport-store.mjs";
import {
  BUILTIN_ROLES,
  requireDataportAccess,
  validatePermissions,
} from "../../server/portal/dataport-policy.mjs";
import {
  authorizeLegacyPortal,
  dataportRouteAllowed,
  dataportRoute,
} from "../../server/portal/dataport-routes.mjs";
import { capabilitiesForRole } from "../../server/identity/index.mjs";

const connectionString = process.env.MX_DATAPORT_TEST_DATABASE_URL;
async function fixture(t) {
  const url = new URL(connectionString);
  assert.ok(
    ["localhost", "127.0.0.1"].includes(url.hostname) &&
      url.pathname.includes("test"),
  );
  const admin = new pg.Pool({ connectionString }),
    name = `dataport_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE DATABASE ${name}`);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.href, max: 8 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  const dir = new URL("../../migrations/", import.meta.url),
    files = await readdir(dir);
  for (const prefix of ["001_", "007_", "149_"])
    await pool.query(
      await readFile(
        new URL(
          files.find((f) => f.startsWith(prefix)),
          dir,
        ),
        "utf8",
      ),
    );
  await pool.query(`CREATE SCHEMA external_platform; CREATE TABLE external_platform.ipsearch_batches(id uuid PRIMARY KEY,tenant_id uuid,consumer_id uuid,api_key_id uuid,idempotency_key text,response jsonb,created_at timestamptz DEFAULT now());
    CREATE SCHEMA hub_commerce;CREATE TABLE hub_commerce.orders(id uuid PRIMARY KEY,tenant_id uuid,consumer_id uuid,environment text DEFAULT 'live',intent jsonb,payment jsonb,payment_id uuid,receipt jsonb,created_at timestamptz DEFAULT now(),delivered_at timestamptz);`);
  await pool.query(`CREATE TABLE hub_commerce.subscriptions(id uuid PRIMARY KEY);
    CREATE FUNCTION hub_commerce.immutable() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'immutable'; END$$;`);
  await pool.query(await readFile(new URL("../../migrations/144_customer_subscription_messages.sql",import.meta.url),"utf8"));
  await pool.query(await readFile(new URL("../../migrations/154_dataport_support.sql",import.meta.url),"utf8"));
  const tenant = randomUUID(),
    other = randomUUID(),
    owner = randomUUID(),
    analyst = randomUUID(),
    adminMember = randomUUID(),
    viewer = randomUUID();
  for (const id of [tenant, other])
    await pool.query(
      "INSERT INTO tenants(id,name) VALUES($1,'Fixture enterprise')",
      [id],
    );
  for (const [id, role] of [
    [owner, "owner"],
    [analyst, "analyst"],
    [adminMember, "admin"],
    [viewer, "viewer"],
  ]) {
    await pool.query("INSERT INTO iam.members(id,display_name) VALUES($1,$2)", [
      id,
      role,
    ]);
    await pool.query(
      "INSERT INTO iam.tenant_memberships(id,member_id,tenant_id,role) VALUES($1,$2,$3,$4)",
      [randomUUID(), id, tenant, role],
    );
    if (role !== "owner")
      await pool.query(
        "INSERT INTO dataport.member_roles(tenant_id,member_id,role_id) VALUES($1,$2,$3)",
        [tenant, id, role],
      );
  }
  const store = new DataportStore(pool);
  store.requestId = "fixture-request";
  async function principal(id = owner, session = digest("session-A")) {
    const memberships = (
      await pool.query(
        "SELECT tenant_id AS \"tenantId\",role,status FROM iam.tenant_memberships WHERE member_id=$1 AND status='active'",
        [id],
      )
    ).rows.map((m) => ({ ...m, capabilities: capabilitiesForRole(m.role) }));
    return store.enrich(
      {
        kind: "launcher-user",
        memberId: id,
        displayName: "Fixture",
        issuer: "mx-user-center:test",
        subject: `user:${id}`,
        memberships,
        tenantIds: memberships.map((m) => m.tenantId),
        portalOrigin: "https://dataport.example.test",
      },
      session,
    );
  }
  async function verified() {
    await store.configureOwnerCode(
      tenant,
      owner,
      "Fixture-owner-code-123",
      "test-operator",
    );
    await store.ownerChallenge(
      await principal(),
      tenant,
      "Fixture-owner-code-123",
    );
    return principal();
  }
  return {
    pool,
    store,
    tenant,
    other,
    owner,
    analyst,
    adminMember,
    viewer,
    principal,
    verified,
  };
}

test("fixed roles and exact customer routes preserve independent billing, query and Key authority", () => {
  const permissions = (id) =>
    BUILTIN_ROLES.find((r) => r.id === id).permissions;
  assert.ok(permissions("analyst").includes("query.execute"));
  assert.ok(!permissions("analyst").includes("keys.read"));
  assert.ok(permissions("billing").includes("subscriptions.buy"));
  assert.ok(!permissions("billing").includes("query.execute"));
  assert.ok(!permissions("admin").includes("billing.read"));
  assert.ok(!permissions("viewer").includes("history.export"));
  assert.deepEqual(validatePermissions(["keys.create"]), [
    "keys.create",
    "keys.read",
  ]);
  assert.throws(() => validatePermissions(["platform.admin"]), { status: 400 });
  const id = randomUUID();
  const billing = randomUUID(),
    pending = randomUUID(),
    mixed = {
      memberships: [
        { tenantId: billing, dataport: { permissions: ["billing.read"] } },
        {
          tenantId: pending,
          role: "owner",
          dataport: {
            permissions: ["billing.read"],
            ownerChallengeRequired: true,
          },
        },
      ],
    };
  assert.deepEqual(
    authorizeLegacyPortal(
      mixed,
      "GET",
      "/payments/return-order",
      new URLSearchParams(),
    ).tenantIds,
    [billing],
  );
  for (const path of [
    `/enterprises/${id}/roles`,
    `/enterprises/${id}/history`,
    `/joins/${"a".repeat(43)}`,
  ])
    assert.ok(dataportRouteAllowed("GET", path));
  for (const path of [
    `/enterprises/${id}/keys/${id}/reveal`,
    `/enterprises/${id}/runtime`,
    `/enterprises/${id}/members/owner`,
    "/runtime",
  ])
    assert.ok(!dataportRouteAllowed("POST", path));
});

test(
  "owner permit is session-bound, rotated and rate-limited across sessions",
  { skip: !connectionString },
  async (t) => {
    const f = await fixture(t);
    let owner = await f.principal();
    assert.throws(
      () => requireDataportAccess(owner, f.tenant, "query.execute"),
      { code: "owner_challenge_required" },
    );
    owner = await f.verified();
    assert.doesNotThrow(() =>
      requireDataportAccess(owner, f.tenant, "query.execute"),
    );
    assert.equal(
      (await f.principal(f.owner, digest("new-login"))).memberships[0].dataport
        .ownerChallengeRequired,
      true,
    );
    await f.store.configureOwnerCode(
      f.tenant,
      f.owner,
      "Rotated-owner-code-123",
      "operator",
    );
    assert.equal(
      (await f.principal()).memberships[0].dataport.ownerChallengeRequired,
      true,
    );
    const pending = await f.principal();
    for (let i = 0; i < 5; i++)
      await assert.rejects(
        f.store.ownerChallenge(
          { ...pending, dataportSession: digest(`session${i}`) },
          f.tenant,
          "wrong-code",
        ),
        { status: 403 },
      );
    await assert.rejects(
      f.store.ownerChallenge(pending, f.tenant, "Rotated-owner-code-123"),
      { status: 429 },
    );
    const codes = (
      await f.pool.query("SELECT digest FROM dataport.owner_codes")
    ).rows;
    assert.ok(!codes[0].digest.includes("Rotated"));
    assert.ok(
      !(await f.pool.query("SELECT detail FROM dataport.events")).rows.some(
        (r) => JSON.stringify(r).includes("wrong-code"),
      ),
    );
  },
);

test(
  "custom role revisions, immediate revocation, escalation and owner protections",
  { skip: !connectionString },
  async (t) => {
    const f = await fixture(t),
      owner = await f.verified(),
      admin = await f.principal(f.adminMember);
    const role = await f.store.saveRole(owner, f.tenant, {
      name: "API 集成",
      permissions: ["keys.read"],
    });
    await f.store.updateMember(owner, f.tenant, f.viewer, { roleId: role.id });
    assert.ok(
      (
        await f.principal(f.viewer)
      ).memberships[0].dataport.permissions.includes("keys.read"),
    );
    await assert.rejects(
      f.store.saveRole(owner, f.tenant, {
        ...role,
        name: "Changed",
        permissions: [],
        revision: 0,
      }),
      { status: 409 },
    );
    await assert.rejects(
      f.store.saveRole(owner, f.tenant, { ...role, archived: true }),
      { code: "role_in_use" },
    );
    await f.store.saveRole(owner, f.tenant, { ...role, permissions: [] });
    await f.store.updateMember(owner, f.tenant, f.viewer, {
      displayName: "Enterprise alias",
    });
    assert.equal(
      (await f.store.members(owner, f.tenant)).items.find(
        (m) => m.id === f.viewer,
      ).displayName,
      "Enterprise alias",
    );
    assert.equal(
      (
        await f.pool.query("SELECT display_name FROM iam.members WHERE id=$1", [
          f.viewer,
        ])
      ).rows[0].display_name,
      "viewer",
    );
    assert.ok(
      !(
        await f.principal(f.viewer)
      ).memberships[0].dataport.permissions.includes("keys.read"),
    );
    await assert.rejects(
      f.store.updateMember(admin, f.tenant, f.analyst, { roleId: "billing" }),
      { code: "role_exceeds_authority" },
    );
    await assert.rejects(
      f.store.updateMember(owner, f.tenant, f.owner, { roleId: "viewer" }),
      { code: "member_protected" },
    );
    await assert.rejects(
      f.store.updateMember(owner, f.other, f.viewer, { status: "suspended" }),
      { status: 403 },
    );
    await f.store.updateMember(owner, f.tenant, f.analyst, {
      status: "suspended",
    });
    assert.deepEqual((await f.principal(f.analyst)).memberships, []);
    await f.pool.query(
      "UPDATE iam.tenant_memberships SET role='viewer' WHERE member_id=$1",
      [f.owner],
    );
    const downgraded = await f.store.enrich(owner, owner.dataportSession);
    assert.ok(
      !downgraded.memberships[0].dataport.permissions.includes("query.execute"),
    );
    assert.ok(
      !downgraded.memberships[0].dataport.permissions.includes("billing.read"),
    );
    await f.pool.query("UPDATE tenants SET status='suspended' WHERE id=$1", [
      f.tenant,
    ]);
    assert.deepEqual((await f.principal()).memberships, []);
  },
);

test(
  "enterprise history is shared, paged at five, includes old product results and never dispatches on replay",
  { skip: !connectionString },
  async (t) => {
    const f = await fixture(t),
      p = await f.principal(f.analyst);
    let calls = 0,
      release;
    const gate = new Promise((r) => (release = r)),
      intent = randomUUID(),
      body = { ip: "8.8.8.8" };
    const first = f.store.query(p, f.tenant, body, intent, async () => {
      calls++;
      await gate;
      return {
        status: 200,
        body: {
          batchId: randomUUID(),
          data: [
            {
              ip: body.ip,
              status: 200,
              response: {
                data: {
                  status: "success",
                  data: { risk_level: "中风险", risk_score: null },
                },
              },
            },
          ],
        },
      };
    });
    while (!calls) await new Promise((r) => setImmediate(r));
    await assert.rejects(
      f.store.query(p, f.tenant, body, intent, () => {
        calls++;
      }),
      { code: "query_outcome_unknown" },
    );
    release();
    await first;
    assert.equal(
      (
        await f.store.query(p, f.tenant, body, intent, () => {
          calls++;
        })
      ).replayed,
      true,
    );
    assert.equal(calls, 1);
    await assert.rejects(
      f.store.query(p, f.tenant, { ip: "1.1.1.1" }, intent, () => {}),
      { code: "query_intent_conflict" },
    );
    for (let i = 0; i < 6; i++)
      await f.store.query(
        p,
        f.tenant,
        { ip: `192.0.2.${i}` },
        randomUUID(),
        async () => ({
          status: 200,
          body: { data: [{ ip: `192.0.2.${i}`, status: 200 }] },
        }),
      );
    const old = randomUUID();
    await f.pool.query(
      "INSERT INTO external_platform.ipsearch_batches(id,tenant_id,response) VALUES($1,$2,$3)",
      [
        old,
        f.tenant,
        {
          contractVersion: "mx-insight-hub.ip-risk.subscription.v1",
          data: [{ ip: "203.0.113.9", status: 200 }],
        },
      ],
    );
    const viewer = await f.principal(f.viewer),
      page1 = await f.store.history(viewer, f.tenant, new URLSearchParams()),
      page2 = await f.store.history(
        viewer,
        f.tenant,
        new URLSearchParams("page=2"),
      );
    assert.equal(page1.items.length, 5);
    assert.equal(page1.total, 8);
    assert.equal(page2.items.length, 3);
    assert.equal(calls, 1);
    const legacy = await f.store.history(
      viewer,
      f.tenant,
      new URLSearchParams("q=203.0.113"),
    );
    assert.equal(legacy.items[0].actor, null);
    const failed = await f.store.query(
      p,
      f.tenant,
      { ip: "203.0.113.88" },
      randomUUID(),
      async () => {
        throw Error("private-database-sentinel");
      },
    );
    assert.equal(failed.error.code, "query_outcome_unknown");
    assert.ok(!JSON.stringify(failed).includes("private-database-sentinel"));
    await assert.rejects(
      f.store.history(viewer, f.tenant, new URLSearchParams("export=1")),
      { status: 403 },
    );
    await assert.rejects(
      f.store.history(viewer, f.other, new URLSearchParams()),
      { status: 403 },
    );
    assert.throws(
      () =>
        authorizeLegacyPortal(
          viewer,
          "POST",
          "/demo-credentials",
          new URLSearchParams(),
        ),
      { status: 404 },
    );
  },
);

test(
  "employee creation recovers with same command, invitation requires addressed account, passwords are owner-only",
  { skip: !connectionString },
  async (t) => {
    const f = await fixture(t),
      owner = await f.verified(),
      records = new Map();
    let commands = 0;
    const accounts = {
      invitation: (id) => digest(id).slice(0, 43),
      async execute(input) {
        commands++;
        if (input.operation === "initial-password")
          return { password: "fixture-initial-only" };
        if (!records.has(input.requestId))
          records.set(input.requestId, {
            userId: `usr_${randomUUID()}`,
            account: input.account,
            displayName: input.displayName || "Linked",
            issuer: "mx-user-center:test",
            subject: `user:usr_${input.requestId}`,
          });
        return records.get(input.requestId);
      },
    };
    const body = {
      operation: "create",
      commandId: randomUUID(),
      account: "Employee01",
      displayName: "Employee",
      roleId: "analyst",
    };
    const created = await f.store.memberCommand(
      owner,
      f.tenant,
      body,
      accounts,
      "mx-insight-hub",
    );
    assert.equal(
      (
        await f.store.memberCommand(
          owner,
          f.tenant,
          body,
          accounts,
          "mx-insight-hub",
        )
      ).memberId,
      created.memberId,
    );
    assert.equal(
      (await f.pool.query("SELECT 1 FROM dataport.managed_accounts")).rowCount,
      1,
    );
    await assert.rejects(
      f.store.memberCommand(
        owner,
        f.tenant,
        { ...body, roleId: "admin" },
        accounts,
        "mx-insight-hub",
      ),
      { status: 409 },
    );
    assert.equal(
      (
        await f.store.initialPassword(
          owner,
          f.tenant,
          created.memberId,
          accounts,
        )
      ).password,
      "fixture-initial-only",
    );
    await assert.rejects(
      f.store.initialPassword(
        await f.principal(f.adminMember),
        f.tenant,
        created.memberId,
        accounts,
      ),
      { status: 403 },
    );
    const invited = await f.store.memberCommand(
      owner,
      f.tenant,
      {
        ...body,
        operation: "invite",
        commandId: randomUUID(),
        account: "Existing",
      },
      accounts,
      "mx-insight-hub",
    );
    await assert.rejects(
      f.store.join(
        await f.principal(f.analyst),
        invited.joinToken,
        true,
        "mx-insight-hub",
      ),
      { code: "join_account_mismatch" },
    );
    const record = [...records.values()].find((r) => r.account === "Existing");
    let linked = {
      ...(await f.principal(f.viewer)),
      issuer: record.issuer,
      subject: record.subject,
    };
    await f.pool.query(
      "INSERT INTO iam.external_identity_bindings(id,member_id,issuer,subject,audience) VALUES($1,$2,$3,$4,$5)",
      [randomUUID(), f.viewer, record.issuer, record.subject, "mx-insight-hub"],
    );
    assert.equal(
      (await f.store.join(linked, invited.joinToken, false, "mx-insight-hub"))
        .consumed,
      false,
    );
    await f.store.join(linked, invited.joinToken, true, "mx-insight-hub");
    assert.ok(
      (await f.store.join(linked, invited.joinToken, false, "mx-insight-hub"))
        .consumed,
    );
    assert.equal(
      (
        await f.pool.query(
          "SELECT managed FROM dataport.managed_accounts WHERE member_id=$1",
          [f.viewer],
        )
      ).rows[0].managed,
      false,
    );
    await assert.rejects(
      f.store.initialPassword(owner, f.tenant, f.viewer, accounts),
      { status: 404 },
    );
  },
);

test(
  "tickets isolate own and company reads; billing filters and exports enforce live authority",
  { skip: !connectionString },
  async (t) => {
    const f = await fixture(t),
      owner = await f.verified(),
      p = await f.principal(f.analyst),
      v = await f.principal(f.viewer);
    await f.store.createTicket(p, f.tenant, { content: "Technical issue" });
    await f.store.createTicket(v, f.tenant, { content: "Account issue" });
    assert.equal(
      (await f.store.tickets(p, f.tenant, new URLSearchParams())).total,
      1,
    );
    assert.equal(
      (await f.store.tickets(owner, f.tenant, new URLSearchParams())).total,
      2,
    );
    await assert.rejects(f.store.audit(p, f.tenant, new URLSearchParams()), {
      status: 403,
    });
    assert.ok(
      (await f.store.audit(owner, f.tenant, new URLSearchParams())).items.every(
        (r) => r.detail.requestId === "fixture-request",
      ),
    );
    const order = randomUUID();
    await f.pool.query(
      "INSERT INTO hub_commerce.orders(id,tenant_id,intent,payment) VALUES($1,$2,$3,$4)",
      [
        order,
        f.tenant,
        { product: { name: "Fixture plan", amountMinor: 12300 } },
        { status: "paid" },
      ],
    );
    async function billing(principal, search) {
      let result;
      await dataportRoute({
        request: { method: "GET" },
        response: {},
        path: `/enterprises/${f.tenant}/billing`,
        searchParams: new URLSearchParams(search),
        principal,
        dataport: f.store,
        sendJson(_r, _s, p) {
          result = p.data;
        },
      });
      return result;
    }
    assert.equal(
      (await billing(owner, "q=Fixture&status=paid")).orders[0].id,
      order,
    );
    assert.equal((await billing(owner, "status=pending")).orders.length, 0);
    await assert.rejects(billing(p, ""), { status: 403 });
  },
);

test("account bridge configuration accepts only dedicated credentials and fixed secure/internal origins", async (t) => {
  const folder = await mkdtemp(join(tmpdir(), "dataport-bridge-")),
    previousOrigin = process.env.MX_DATAPORT_ACCOUNT_ORIGIN,
    previousFile = process.env.MX_DATAPORT_ACCOUNT_TOKEN_FILE;
  t.after(async () => {
    if (previousOrigin === undefined)
      delete process.env.MX_DATAPORT_ACCOUNT_ORIGIN;
    else process.env.MX_DATAPORT_ACCOUNT_ORIGIN = previousOrigin;
    if (previousFile === undefined)
      delete process.env.MX_DATAPORT_ACCOUNT_TOKEN_FILE;
    else process.env.MX_DATAPORT_ACCOUNT_TOKEN_FILE = previousFile;
    await rm(folder, { recursive: true, force: true });
  });
  process.env.MX_DATAPORT_ACCOUNT_TOKEN_FILE = join(folder, "token");
  await writeFile(
    process.env.MX_DATAPORT_ACCOUNT_TOKEN_FILE,
    "fixture-dedicated-account-service-token-1234",
  );
  const client = new DataportAccountsClient();
  for (const origin of [
    "https://auth.example.test",
    "http://127.0.0.1:18090",
    "http://auth.namespace.svc.cluster.local:18090",
  ]) {
    process.env.MX_DATAPORT_ACCOUNT_ORIGIN = origin;
    assert.equal(client.config().origin, origin);
  }
  for (const origin of [
    "http://public.example.test",
    "ftp://127.0.0.1",
    "https://auth.example.test/other",
    "https://user:secret@auth.example.test",
  ]) {
    process.env.MX_DATAPORT_ACCOUNT_ORIGIN = origin;
    assert.throws(() => client.config(), { status: 503 });
  }
  process.env.MX_DATAPORT_ACCOUNT_ORIGIN = "http://127.0.0.1";
  await writeFile(process.env.MX_DATAPORT_ACCOUNT_TOKEN_FILE, "short");
  assert.throws(() => client.config(), { status: 503 });
});

test(
  "audit finds new and legacy query receipts by both request IDs without rewriting events or crossing tenants",
  { skip: !connectionString },
  async (t) => {
    const f = await fixture(t),
      owner = await f.verified(),
      upstreamId = randomUUID(),
      batchId = randomUUID();
    const result = await f.store.query(
      owner,
      f.tenant,
      { ip: "203.0.113.18" },
      randomUUID(),
      async () => ({
        status: 200,
        body: {
          batchId,
          data: [
            {
              ip: "203.0.113.18",
              status: 200,
              response: {
                requestId: upstreamId,
                data: { privateField: "not-an-audit-field" },
              },
            },
          ],
        },
      }),
    );
    const event = (
      await f.pool.query(
        "SELECT * FROM dataport.events WHERE action='query.executed' AND target=$1",
        [result.id],
      )
    ).rows[0];
    assert.equal(event.detail.requestId, "fixture-request");
    assert.equal(event.detail.queryRequestId, upstreamId);
    assert.equal(event.detail.queryId, result.id);
    assert.equal(event.detail.batchId, batchId);
    await f.pool.query(
      "INSERT INTO dataport.events(tenant_id,actor,action,target,status,detail) VALUES($1,$2,'query.executed',$3,200,$4)",
      [
        f.tenant,
        f.owner,
        result.id,
        { ip: "203.0.113.18", requestId: "old-portal-request" },
      ],
    );
    const legacy = (
      await f.pool.query(
        "SELECT id,detail FROM dataport.events WHERE detail->>'requestId'='old-portal-request'",
      )
    ).rows[0];
    await f.store.event(f.tenant, f.owner, "query.executed", "legacy-non-uuid-target", 503, {});
    for (const q of [upstreamId, batchId, result.id, "203.0.113.18"]) {
      const audit = await f.store.audit(
        owner,
        f.tenant,
        new URLSearchParams({ q, action: "query.executed" }),
      );
      assert.equal(audit.total, 2);
      assert.ok(
        audit.items.every(
          (r) =>
            r.detail.queryRequestId === upstreamId &&
            r.detail.queryId === result.id,
        ),
      );
      assert.doesNotMatch(
        JSON.stringify(audit),
        /not-an-audit-field|privateField/,
      );
    }
    assert.equal(
      (
        await f.store.audit(
          owner,
          f.tenant,
          new URLSearchParams({ q: "old-portal-request" }),
        )
      ).total,
      1,
    );
    assert.deepEqual(
      (
        await f.pool.query("SELECT detail FROM dataport.events WHERE id=$1", [
          legacy.id,
        ])
      ).rows[0].detail,
      legacy.detail,
    );
    await f.store.event(f.other, f.owner, "query.executed", result.id, 200, {
      ip: "198.51.100.2",
    });
    // Same textual target in another enterprise must not borrow A's receipt.
    const adminPrincipal = {
      ...owner,
      tenantIds: [f.other],
      memberships: [
        {
          tenantId: f.other,
          status: "active",
          role: "owner",
          dataport: { permissions: ["audit.read"], ownerVerified: true },
        },
      ],
    };
    assert.equal(
      (
        await f.store.audit(
          adminPrincipal,
          f.other,
          new URLSearchParams({ q: upstreamId }),
        )
      ).total,
      0,
    );
    assert.equal(
      (await f.store.audit(adminPrincipal, f.other, new URLSearchParams()))
        .items[0].detail.queryRequestId,
      undefined,
    );
    await assert.rejects(
      f.store.audit(owner, f.other, new URLSearchParams({ q: upstreamId })),
      { status: 403 },
    );
    assert.equal(
      (
        await f.store.audit(
          owner,
          f.tenant,
          new URLSearchParams({ q: upstreamId }),
        )
      ).total,
      2,
    );
  },
);

test(
  "custom buyers can resume their own purchases without reading enterprise billing or other buyers orders",
  { skip: !connectionString },
  async (t) => {
    const f = await fixture(t),
      owner = await f.verified(),
      role = await f.store.saveRole(owner, f.tenant, {
        name: "Purchaser",
        permissions: ["subscriptions.buy"],
      });
    await f.store.updateMember(owner, f.tenant, f.viewer, { roleId: role.id });
    const buyer = await f.principal(f.viewer),
      own = randomUUID(),
      other = randomUUID(),
      trade = "MXP" + randomUUID().replaceAll("-", ""),
      otherTrade = "MXP" + randomUUID().replaceAll("-", "");
    for (const [id, actor, outTradeNo] of [
      [own, f.viewer, trade],
      [other, f.analyst, otherTrade],
    ])
      await f.pool.query(
        "INSERT INTO hub_commerce.orders(id,tenant_id,intent,payment) VALUES($1,$2,$3,$4)",
        [
          id,
          f.tenant,
          {
            createdBy: actor,
            product: { name: "Fixture plan", amountMinor: 9900 },
          },
          { status: "pending", checkout: { outTradeNo } },
        ],
      );
    const commerce = {
      list: async () => ({
        subscriptions: [],
        summary: { pendingSkus: ["fixture"] },
        pagination: { subscriptions: { page: 1, pageSize: 10, total: 0 } },
      }),
      action: async (_tenant, id) => ({ id }),
    };
    async function invoke(path, method = "GET", search = "") {
      let value;
      await dataportRoute({
        request: { method, headers: {} },
        response: {},
        path,
        searchParams: new URLSearchParams(search),
        principal: buyer,
        dataport: f.store,
        commerce,
        readJson: async () => ({}),
        sendJson(_r, _s, p) {
          value = p.data;
        },
      });
      return value;
    }
    assert.equal(
      (await invoke("/payments/return-order", "GET", "trade=" + trade)).id,
      own,
    );
    await assert.rejects(
      invoke("/payments/return-order", "GET", "trade=" + otherTrade),
      { status: 404 },
    );
    const listing = await invoke(`/enterprises/${f.tenant}/subscriptions`);
    assert.deepEqual(
      listing.orders.map((x) => x.id),
      [own],
    );
    assert.deepEqual(listing.summary.pendingSkus, ["fixture"]);
    assert.equal(
      (await invoke(`/enterprises/${f.tenant}/orders/${own}/refresh`, "POST"))
        .id,
      own,
    );
    await assert.rejects(
      invoke(`/enterprises/${f.tenant}/orders/${other}/refresh`, "POST"),
      { status: 404 },
    );
    await assert.rejects(invoke(`/enterprises/${f.tenant}/billing`), {
      status: 403,
    });
  },
);

test("DataPort support closes the processing loop with tenant/self isolation, CAS, replay and private receipts", {skip:!connectionString},async t=>{
 const f=await fixture(t),owner=await f.verified(),analyst=await f.principal(f.analyst),viewer=await f.principal(f.viewer),support=new DataportSupport(f.store),messages=new CustomerMessages(f.pool);
 const ticket=await f.store.createTicket(analyst,f.tenant,{content:"Fixture request",category:"technical",priority:"normal"});
 assert.equal((await support.detail(analyst,f.tenant,ticket.id)).status,"saved");
 await assert.rejects(support.detail(viewer,f.tenant,ticket.id),{status:404});
 await assert.rejects(support.detail(analyst,f.other,ticket.id),{status:403});
 await assert.rejects(support.update(owner,f.tenant,ticket.id,{}),{code:"admin_token_required"});
 const admin={kind:"admin-token"},command={commandId:randomUUID(),revision:1,status:"processing",reply:"We are reviewing this issue"};
 await support.update(admin,f.tenant,ticket.id,command);
 assert.equal((await support.update(admin,f.tenant,ticket.id,command)).replayed,true);
 await assert.rejects(support.update(admin,f.tenant,ticket.id,{...command,reply:"changed"}),{code:"ticket_command_conflict"});
 await assert.rejects(support.update(admin,f.tenant,ticket.id,{...command,commandId:randomUUID()}),{code:"ticket_revision_conflict"});
 let detail=await support.detail(analyst,f.tenant,ticket.id);assert.equal(detail.revision,2);assert.equal(detail.replies.length,1);
 assert.equal((await support.detail(owner,f.tenant,ticket.id)).replies[0].reply,command.reply);
 const inbox=await messages.list(f.tenant,f.analyst);assert.equal(inbox.items[0].kind,"ticket_updated");assert.equal(inbox.unread,1);
 assert.equal((await messages.list(f.tenant,f.viewer)).items.length,0);
 await assert.rejects(messages.read(f.tenant,f.viewer,inbox.items[0].id),{status:404});
 assert.equal((await messages.readAll(f.tenant,f.analyst)).read,1);assert.equal((await messages.list(f.tenant,f.analyst)).unread,0);
 assert.equal((await messages.readAll(f.other,f.analyst)).read,0);
 await support.update(admin,f.tenant,ticket.id,{commandId:randomUUID(),revision:2,status:"closed",reply:"Resolved"});
 detail=await support.detail(owner,f.tenant,ticket.id);assert.equal(detail.status,"closed");assert.equal(detail.replies.length,2);
 assert.equal((await support.list(admin,new URLSearchParams({tenantId:f.other}))).total,0);
 assert.equal((await support.list(admin,new URLSearchParams({status:"closed"}))).total,1);
});
test("DataPort rename, member pagination, audit IP search and managed reset keep enterprise boundaries",{skip:!connectionString},async t=>{
 const f=await fixture(t),owner=await f.verified(),analyst=await f.principal(f.analyst);
 await f.store.renameEnterprise(owner,f.tenant,{name:"Renamed enterprise"});
 await assert.rejects(f.store.renameEnterprise(analyst,f.tenant,{name:"Forbidden"}),{status:403});
 await assert.rejects(f.store.renameEnterprise(owner,f.other,{name:"Forbidden"}),{status:403});
 const list=await f.store.members(owner,f.tenant,new URLSearchParams({pageSize:"1"}));assert.equal(list.items.length,1);assert.equal(list.total,4);assert.equal(list.summary.employeeCount,3);
 await f.store.event(f.tenant,f.owner,"query.executed",randomUUID(),200,{ip:"203.0.113.17"});
 assert.equal((await f.store.audit(owner,f.tenant,new URLSearchParams({q:"203.0.113.17"}))).total,1);
 await assert.rejects(f.store.resetPassword(analyst,f.tenant,f.viewer,{commandId:randomUUID()},{}),{status:403});
 await assert.rejects(f.store.resetPassword(owner,f.tenant,f.viewer,{commandId:randomUUID()},{}),{code:"managed_account_required"});
 await f.pool.query("INSERT INTO dataport.managed_accounts(tenant_id,member_id,user_id,account,managed) VALUES($1,$2,'usr_fixture','fixture',true)",[f.tenant,f.viewer]);
 const calls=[],accounts={execute:async input=>{calls.push(input);return {reset:true};}},command={commandId:randomUUID()};
 await f.store.resetPassword(owner,f.tenant,f.viewer,command,accounts);await f.store.resetPassword(owner,f.tenant,f.viewer,command,accounts);
 assert.equal(calls.length,1);assert.equal(calls[0].operation,"reset-password");assert.equal(calls[0].tenantId,f.tenant);
 await assert.rejects(f.store.resetPassword(owner,f.other,f.viewer,{commandId:randomUUID()},accounts),{status:403});
 assert.ok(!(await f.pool.query("SELECT document FROM dataport.member_commands")).rows.some(r=>JSON.stringify(r).includes("passwordHash")));
});

test('replacement Key keeps its exact existing scopes and environment, with no automatic revocation',async()=>{
 const tenant=randomUUID(),memberId=randomUUID(),keyId=randomUUID(),consumerId=randomUUID(),calls=[];
 const principal={memberId,memberships:[{tenantId:tenant,role:'owner',dataport:{permissions:['keys.create'],ownerChallengeRequired:false}}]};
 const old={id:keyId,status:'active',environment:'test',expiresAt:'2099-01-01',platforms:['ip_risk'],capabilities:[],webSearchOrder:[]};
 const invoke=replaceFrom=>dataportRoute({request:{method:'POST',headers:{}},response:{},path:`/enterprises/${tenant}/keys`,searchParams:new URLSearchParams(),principal,
  dataport:{available(){},event:async()=>{}},store:{listConsumers:async()=>[{id:consumerId,tenantId:tenant,businessId:`commerce:ip-risk:${tenant}`,status:'active'}]},
  service:{listApiKeys:async()=>[old],createApiKey:async body=>{calls.push(body);return {id:randomUUID(),secret:'synthetic-only'}}},
  readJson:async()=>({name:'replacement',expiresInDays:30,replaceFrom}),sendJson(){}});
 await invoke(keyId);assert.deepEqual(calls[0].platforms,old.platforms);assert.deepEqual(calls[0].capabilities,[]);assert.equal(calls[0].environment,'test');
 await assert.rejects(invoke(randomUUID()),{code:'replacement_key_unavailable'});assert.equal(calls.length,1);
});
