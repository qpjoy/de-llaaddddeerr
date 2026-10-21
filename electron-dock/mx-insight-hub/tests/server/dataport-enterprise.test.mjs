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
  requireOwner,
  validatePermissions,
} from "../../server/portal/dataport-policy.mjs";
import {
  authorizeLegacyPortal,
  dataportRouteAllowed,
  dataportRoute,
} from "../../server/portal/dataport-routes.mjs";
import { capabilitiesForRole } from "../../server/identity/index.mjs";
import { createServer } from "node:http";
import { createHarborPortal } from "../../server/portal/harbor.mjs";
import { createApp } from "../../server/app.mjs";
import { HubService } from "../../server/hub-service.mjs";
import { MemoryStore } from "../../server/stores/memory-store.mjs";
import { createHarborApp } from "../../../mx-dataport/apps/server/app.mjs";
import { paymentTimedOutSql } from "../../server/commerce/order-state.mjs";

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
  for (const prefix of ["001_", "007_", "149_", "159_"])
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
  await pool.query("ALTER TABLE public.usage_requests ADD COLUMN IF NOT EXISTS acquisition_request jsonb");
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
  const store = new DataportStore(pool, {credentialPepper:"local-fixture-retained-pepper-32-characters"});
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
    [billing, pending],
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
    `/enterprises/${id}/challenge`,
    `/enterprises/${id}/members/owner`,
    "/runtime",
  ])
    assert.ok(!dataportRouteAllowed("POST", path));
});

test("retired owner codes do not gate tenant permissions or grant employee ownership", () => {
  const tenant = randomUUID(), other = randomUUID();
  const owner = { memberships: [{ tenantId: tenant, role: "owner", status: "active",
    dataport: { permissions: ["members.read"], ownerChallengeRequired: true } }] };
  assert.doesNotThrow(() => requireOwner(owner, tenant));
  assert.doesNotThrow(() => requireDataportAccess(owner, tenant, "members.read"));
  assert.throws(() => requireDataportAccess(owner, other), { code: "tenant_not_permitted" });
  assert.throws(() => requireDataportAccess(owner, tenant, "keys.create"), { code: "insufficient_permission" });
  const employee = { memberships: [{ ...owner.memberships[0], role: "analyst" }] };
  assert.throws(() => requireOwner(employee, tenant), { code: "owner_required" });
  const suspended = { memberships: [{ ...owner.memberships[0], status: "suspended" }] };
  assert.throws(() => requireOwner(suspended, tenant), { code: "tenant_not_permitted" });
});

test(
  "MX owners enter without codes across sessions; live tenant/member checks and legacy data remain intact",
  { skip: !connectionString },
  async (t) => {
    const f = await fixture(t);
    for (const session of [undefined, "", digest("session-A"), digest("new-login")]) {
      const owner = await f.principal(f.owner, session);
      assert.equal(owner.memberships[0].dataport.ownerChallengeRequired, false);
      assert.doesNotThrow(() => requireDataportAccess(owner, f.tenant, "query.execute"));
      assert.doesNotThrow(() => requireOwner(owner, f.tenant));
      assert.throws(() => requireDataportAccess(owner, f.other), { code: "tenant_not_permitted" });
    }
    assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM dataport.owner_codes")).rows[0].n, 0);
    assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM dataport.owner_sessions")).rows[0].n, 0);
    await f.pool.query("INSERT INTO dataport.owner_codes(tenant_id,member_id,digest) VALUES($1,$2,'retained-legacy-digest')", [f.tenant,f.owner]);
    const before = await f.pool.query("SELECT * FROM dataport.owner_codes");
    const current = await f.principal();
    requireOwner(current, f.tenant);
    assert.deepEqual((await f.pool.query("SELECT * FROM dataport.owner_codes")).rows, before.rows);
    const employee = await f.principal(f.analyst);
    assert.throws(() => requireOwner(employee, f.tenant), { code: "owner_required" });
    await f.pool.query("UPDATE iam.tenant_memberships SET status='suspended' WHERE tenant_id=$1 AND member_id=$2", [f.tenant,f.owner]);
    assert.deepEqual((await f.principal()).memberships, []);
    await f.pool.query("UPDATE iam.tenant_memberships SET status='active' WHERE tenant_id=$1 AND member_id=$2", [f.tenant,f.owner]);
    await f.pool.query("UPDATE tenants SET status='suspended' WHERE id=$1", [f.tenant]);
    assert.deepEqual((await f.principal()).memberships, []);
    await f.pool.query("UPDATE tenants SET status='active' WHERE id=$1", [f.tenant]);
    await f.pool.query("UPDATE iam.members SET status='suspended' WHERE id=$1", [f.owner]);
    assert.deepEqual((await f.principal()).memberships, []);
  },
);

test(
  "custom role revisions, immediate revocation, escalation and owner protections",
  { skip: !connectionString },
  async (t) => {
    const f = await fixture(t),
      owner = await f.principal(),
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
      owner = await f.principal(),
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
    assert.match(
      (
        await f.store.initialPassword(
          owner,
          f.tenant,
          created.memberId,
          accounts,
        )
      ).password,
      /^[A-Za-z0-9_-]{24}$/,
    );
    assert.equal(commands,0,"new child creation and password reads never call MX Auth");
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
      owner = await f.principal(),
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

test("audit and billing calendar filters use Beijing midnight independent of database timezone", { skip: !connectionString }, async (t) => {
  const f = await fixture(t), owner = await f.principal();
  const dates = [
    "2026-10-17T15:59:59.999Z", // Just before Oct 18 in Beijing.
    "2026-10-17T16:00:00Z",
    "2026-10-18T15:59:59.999999Z",
    "2026-10-18T16:00:00Z", // Oct 19 must not appear in Oct 18.
  ];
  const ids = dates.map(() => randomUUID());
  for (const tenant of [f.tenant, f.other]) {
    for (let n = 0; n < dates.length; n++) {
      await f.pool.query("INSERT INTO dataport.events(tenant_id,actor,action,target,status,created_at) VALUES($1,$2,'boundary',$3,200,$4)", [tenant, f.owner, `boundary:${n}`, dates[n]]);
      await f.pool.query("INSERT INTO hub_commerce.orders(id,tenant_id,intent,payment,created_at) VALUES($1,$2,$3,$4,$5)", [tenant === f.tenant ? ids[n] : randomUUID(), tenant, { product: { name: `boundary:${n}`, amountMinor: 100 } }, { status: "paid" }, dates[n]]);
    }
  }
  const client = await f.pool.connect();
  try {
    const scopedStore = new DataportStore(client);
    for (const zone of ["UTC", "Asia/Shanghai", "America/Los_Angeles"]) {
      await client.query("SELECT set_config('TimeZone',$1,false)", [zone]);
      for (const [range, expected] of [
        ["from=2026-10-18&to=2026-10-18", [1, 2]],
        ["from=2026-10-18", [1, 2, 3]],
        ["to=2026-10-18", [0, 1, 2]],
        ["from=2026-10-19&to=2026-10-19", [3]],
      ]) {
        const audit = await scopedStore.audit(owner, f.tenant, new URLSearchParams(`q=boundary&${range}`));
        assert.deepEqual(audit.items.map(r => Number(r.target.split(":")[1])).sort(), expected, `audit ${zone} ${range}`);
        assert.equal(audit.total, expected.length);
        let billing;
        await dataportRoute({
          request: { method: "GET" }, response: {},
          path: `/enterprises/${f.tenant}/billing`,
          searchParams: new URLSearchParams(`q=boundary&${range}`),
          principal: owner, dataport: scopedStore,
          sendJson(_r, _s, payload) { billing = payload.data; },
        });
        assert.deepEqual(billing.orders.map(r => r.id).sort(), expected.map(n => ids[n]).sort(), `billing ${zone} ${range}`);
        assert.equal(billing.pagination.orders.total, expected.length);
      }
    }
  } finally {
    client.release();
  }
});

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
      owner = await f.principal(),
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
      owner = await f.principal(),
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
 const f=await fixture(t),owner=await f.principal(),analyst=await f.principal(f.analyst),viewer=await f.principal(f.viewer),support=new DataportSupport(f.store),messages=new CustomerMessages(f.pool);
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
 const f=await fixture(t),owner=await f.principal(),analyst=await f.principal(f.analyst);
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
 assert.equal(calls.length,0);assert.equal((await f.pool.query("SELECT auth_mode FROM dataport.managed_accounts WHERE member_id=$1",[f.viewer])).rows[0].auth_mode,"local");
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

test('local employee credentials, sessions and first password change never create MX bindings', {skip:!connectionString}, async t => {
  const f=await fixture(t), owner=await f.principal(), local=f.store.localAccounts;
  const body={operation:'create',commandId:randomUUID(),account:'LocalEmployee',displayName:'Local employee',roleId:'analyst'};
  const created=await f.store.memberCommand(owner,f.tenant,body,{execute(){throw Error('MX must not be called')}},'mx-insight-hub');
  const initial=await local.initial(owner,f.tenant,created.memberId);
  const metadata={portalOrigin:'https://dataport.example.test',portalAudience:'mx-insight-hub'};
  const first=await local.login({account:'LOCALEMPLOYEE',password:initial.password});
  let p=await local.principal(first.token,metadata);
  assert.equal(p.kind,'dataport-user');assert.equal(p.mustChangePassword,true);assert.equal(p.platformAdmin,false);
  assert.deepEqual(p.tenantIds,[f.tenant]);assert.equal(p.memberships[0].role,'viewer');
  assert.equal((await f.pool.query('SELECT 1 FROM iam.external_identity_bindings WHERE member_id=$1',[created.memberId])).rowCount,0);
  const saved=(await f.pool.query('SELECT * FROM dataport.local_credentials WHERE member_id=$1',[created.memberId])).rows[0];
  assert.ok(!JSON.stringify(saved).includes(initial.password));
  assert.ok(!JSON.stringify((await f.pool.query('SELECT * FROM dataport.local_sessions')).rows).includes(first.token));
  await assert.rejects(local.account(first.token,metadata,{action:'profile',displayName:'Blocked',currentPassword:initial.password}),{code:'password_change_required'});
  await assert.rejects(local.account(first.token,metadata,{action:'password',currentPassword:initial.password,password:'too-short'}),{code:'invalid_password'});
  const change=await local.account(first.token,metadata,{action:'password',currentPassword:initial.password,password:'Fixture-new-password-123'});
  assert.equal(change.signedOut,true);
  await assert.rejects(local.principal(first.token,metadata),{status:401});
  await assert.rejects(local.initial(owner,f.tenant,created.memberId),{status:404});
  await assert.rejects(local.login({account:created.account,password:initial.password}),{status:401});
  const second=await local.login({account:created.account,password:'Fixture-new-password-123'});
  p=await f.store.enrich(await local.principal(second.token,metadata),digest(second.csrf));
  assert.equal(p.mustChangePassword,false);requireDataportAccess(p,f.tenant,'query.execute');
  assert.throws(()=>requireDataportAccess(p,f.other,'query.execute'),{status:403});
  await f.store.updateMember(owner,f.tenant,created.memberId,{roleId:'viewer'});
  p=await f.store.enrich(await local.principal(second.token,metadata),digest(second.csrf));
  assert.throws(()=>requireDataportAccess(p,f.tenant,'query.execute'),{status:403});
  await f.store.updateMember(owner,f.tenant,created.memberId,{status:'suspended'});
  await assert.rejects(local.principal(second.token,metadata),{status:401});
  await f.store.updateMember(owner,f.tenant,created.memberId,{status:'active'});
  await assert.rejects(local.principal(second.token,metadata),{status:401});
  const third=await local.login({account:created.account,password:'Fixture-new-password-123'});
  await local.account(third.token,metadata,{action:'profile',currentPassword:'Fixture-new-password-123',displayName:'Local display name'});
  assert.equal((await local.account(third.token,metadata)).displayName,'Local display name');
  await local.account(third.token,metadata,{action:'revoke',target:'all',currentPassword:'Fixture-new-password-123'});
  await assert.rejects(local.principal(third.token,metadata),{status:401});
  const fourth=await local.login({account:created.account,password:'Fixture-new-password-123'});
  await local.logout(fourth.token);await assert.rejects(local.principal(fourth.token,metadata),{status:401});
});

test('legacy managed MX conversion is explicit, tenant-scoped and idempotent; existing MX members cannot be reset', {skip:!connectionString}, async t=>{
  const f=await fixture(t),owner=await f.principal(),local=f.store.localAccounts;
  const before=(await f.pool.query('SELECT * FROM iam.members WHERE id=$1',[f.viewer])).rows[0];
  await f.pool.query("INSERT INTO dataport.managed_accounts(tenant_id,member_id,user_id,account,managed) VALUES($1,$2,'original-mx-user','LegacyEmployee',true)",[f.tenant,f.viewer]);
  const command={commandId:randomUUID()};
  assert.equal((await f.principal(f.viewer)).memberships.length,1);
  await f.store.resetPassword(owner,f.tenant,f.viewer,command,{execute(){throw Error('No MX mutation')}});
  const first=(await local.initial(owner,f.tenant,f.viewer)).password;
  await f.store.resetPassword(owner,f.tenant,f.viewer,command,{});
  assert.equal((await local.initial(owner,f.tenant,f.viewer)).password,first);
  assert.deepEqual((await f.pool.query('SELECT * FROM iam.members WHERE id=$1',[f.viewer])).rows[0],before);
  assert.equal((await f.principal(f.viewer)).memberships.length,0,'MX login cannot regain the converted enterprise membership');
  const session=await local.login({account:'legacyemployee',password:first});
  assert.equal((await local.principal(session.token,{})).memberId,f.viewer);
  // An old MX member can also belong to a different enterprise. Suspending
  // that unrelated membership must not revoke this enterprise's local session.
  await f.pool.query("INSERT INTO iam.tenant_memberships(id,tenant_id,member_id,role) VALUES($1,$2,$3,'viewer')",[randomUUID(),f.other,f.viewer]);
  const otherOwner={...owner,memberships:[{tenantId:f.other,role:'owner',dataport:{permissions:['members.disable']}}]};
  await f.store.updateMember(otherOwner,f.other,f.viewer,{status:'suspended'});
  assert.equal((await local.principal(session.token,{})).memberId,f.viewer);
  await f.store.resetPassword(owner,f.tenant,f.viewer,{commandId:randomUUID()},{});
  await assert.rejects(local.principal(session.token,{}),{status:401});
  await assert.rejects(local.login({account:'legacyemployee',password:first}),{status:401});
  await assert.rejects(f.store.resetPassword(owner,f.tenant,f.analyst,{commandId:randomUUID()},{}),{code:'managed_account_required'});
  await assert.rejects(local.initial(await f.principal(f.analyst),f.tenant,f.viewer),{status:403});
  await f.pool.query("UPDATE dataport.local_credentials SET initial_expires_at=now()-interval '1 second' WHERE member_id=$1",[f.viewer]);
  await assert.rejects(local.initial(owner,f.tenant,f.viewer),{status:404});
});

test('local account names do not merge identities; commands are atomic and password attempts are limited', {skip:!connectionString}, async t=>{
  const f=await fixture(t),owner=await f.principal(),local=f.store.localAccounts;
  const body={operation:'create',commandId:randomUUID(),account:'AtomicEmployee',displayName:'Atomic',roleId:'analyst'};
  f.pool.options.max=2; // A queued command must not need another pooled connection to recheck authority.
  const pair=await Promise.all([f.store.memberCommand(owner,f.tenant,body,{},''),f.store.memberCommand(owner,f.tenant,body,{},'')]);
  assert.equal(pair[0].memberId,pair[1].memberId);
  await assert.rejects(f.store.memberCommand(owner,f.tenant,{...body,commandId:randomUUID(),account:'ATOMICEMPLOYEE'},{},''),{code:'local_account_exists'});
  assert.equal((await f.pool.query("SELECT 1 FROM iam.members WHERE display_name='Atomic'")).rowCount,1);
  const unknown='missingemployee';
  for(let i=0;i<10;i++)await assert.rejects(local.login({account:unknown,password:'wrong-password'}),{code:'local_login_failed'});
  await assert.rejects(local.login({account:unknown,password:'wrong-password'}),{status:429});
  await assert.rejects(f.store.memberCommand(owner,f.tenant,{...body,commandId:randomUUID(),roleId:'owner'},{},''),{status:403});
  const pending={...body,commandId:randomUUID(),account:'OldPending'};
  await f.pool.query("INSERT INTO dataport.member_commands(id,tenant_id,actor,operation,fingerprint) VALUES($1,$2,$3,'create','old-auth-command')",[pending.commandId,f.tenant,f.owner]);
  await assert.rejects(f.store.memberCommand(owner,f.tenant,pending,{},''),{code:'member_command_conflict'});
});

async function listen(t,app) {
  const server=createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections()}));
  return `http://127.0.0.1:${server.address().port}`;
}

test('enterprise history reads old Hub v1/v2 batches and standalone deliveries without copying or dispatching', {skip:!connectionString}, async t => {
  const f=await fixture(t), viewer=await f.principal(f.viewer), consumer=randomUUID(), key=randomUUID();
  await f.pool.query("INSERT INTO consumers(id,tenant_id,name,business_id) VALUES($1,$2,'Legacy fixture',$3)",[consumer,f.tenant,consumer]);
  await f.pool.query("INSERT INTO api_keys(id,tenant_id,consumer_id,name,key_digest,key_prefix,last_four) VALUES($1,$2,$3,'Legacy fixture',$4,'fixture','0000')",[key,f.tenant,consumer,'a'.repeat(64)]);
  const envelope=ip=>({contractVersion:'mx-insight-hub.ip-risk.v1',requestId:randomUUID(),data:{ip,status:'success',data:{risk_level:'高风险'}}});
  const batch1=randomUUID(),batch2=randomUUID();
  for(const [id,version,ips] of [[batch1,'v1',['198.51.100.1','198.51.100.1']],[batch2,'v2',['198.51.100.2']]]) {
    await f.pool.query('INSERT INTO external_platform.ipsearch_batches(id,tenant_id,consumer_id,api_key_id,response) VALUES($1,$2,$3,$4,$5)',[id,f.tenant,consumer,key,{contractVersion:`mx-insight-hub.ip-risk.${version}`,data:ips.map(ip=>({ip,status:200,response:envelope(ip)}))}]);
  }
  const singles=[];
  for(const [ip,status,response,platform,intent] of [
    ['198.51.100.3','committed',envelope('198.51.100.3'),'ip_risk','standalone-success'],
    ['198.51.100.4','unknown',null,'ip_risk','standalone-unknown'],
    ['198.51.100.2','committed',envelope('198.51.100.2'),'ip_risk',`ip-batch-${batch2}-0`],
    ['198.51.100.5','committed',envelope('198.51.100.5'),'facebook','unrelated-platform'],
  ]) {
    const id=randomUUID();singles.push(id);
    await f.pool.query('INSERT INTO usage_requests(id,tenant_id,consumer_id,api_key_id,idempotency_key,fingerprint,platform,status,response_status,response_body,acquisition_request) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[id,f.tenant,consumer,key,intent,'b'.repeat(64),platform,status,response?200:null,response,{body:{ip}}]);
  }
  await f.pool.query('INSERT INTO external_platform.ipsearch_batches(id,tenant_id,response) VALUES($1,$2,$3)',[randomUUID(),f.other,{contractVersion:'mx-insight-hub.ip-risk.v1',data:[{ip:'198.51.100.99',status:200,response:envelope('198.51.100.99')}]}]);
  const before=(await f.pool.query('SELECT id,status,response_body FROM usage_requests ORDER BY id')).rows;
  const history=await f.store.history(viewer,f.tenant,new URLSearchParams('pageSize=100'));
  assert.equal(history.total,5);
  assert.equal(history.items.filter(r=>r.ip==='198.51.100.1').length,2,'repeated inputs remain separate original deliveries');
  assert.equal(history.items.filter(r=>r.ip==='198.51.100.2').length,1,'batch child is not duplicated');
  assert.equal(history.items.find(r=>r.ip==='198.51.100.3').payload.response.data.data.risk_level,'高风险');
  assert.equal(history.items.find(r=>r.ip==='198.51.100.4').payload.error.code,'query_outcome_unknown');
  assert.ok(history.items.every(r=>r.ip!=='198.51.100.99'&&r.ip!=='198.51.100.5'));
  const filtered=await f.store.history(viewer,f.tenant,new URLSearchParams('q=198.51.100.3'));
  assert.equal(filtered.total,1);assert.equal(filtered.items[0].id,singles[0]);
  await assert.rejects(f.store.history(viewer,f.other,new URLSearchParams()),{status:403});
  await assert.rejects(f.store.history(viewer,f.tenant,new URLSearchParams('export=1')),{status:403});
  assert.deepEqual((await f.pool.query('SELECT id,status,response_body FROM usage_requests ORDER BY id')).rows,before);
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM dataport.queries')).rows[0].n,0);
});

test('history projects the exact original batch completion over a stale uncertain query without rewriting its record', {skip:!connectionString}, async t => {
  const f=await fixture(t), p=await f.principal(f.analyst), ip='223.160.165.241';
  const record=await f.store.query(p,f.tenant,{ip},randomUUID(),async()=>{throw Error('fixture transport interruption')});
  assert.equal(record.error.code,'query_outcome_unknown');
  const before=(await f.pool.query('SELECT * FROM dataport.queries WHERE id=$1',[record.id])).rows;
  const response={contractVersion:'mx-insight-hub.ip-risk.subscription.v1',data:[{ip,status:200,response:{requestId:randomUUID(),data:{ip,status:'success',data:{risk_level:'高风险'}}}}]};
  await f.pool.query('INSERT INTO external_platform.ipsearch_batches(id,tenant_id,idempotency_key,response) VALUES($1,$2,$3,$4)',[randomUUID(),f.other,`dataport-${record.id}`,response]);
  let history=await f.store.history(p,f.tenant,new URLSearchParams());
  assert.equal(history.items[0].payload.error.code,'query_outcome_unknown','other tenant evidence cannot settle this record');
  await f.pool.query('INSERT INTO external_platform.ipsearch_batches(id,tenant_id,idempotency_key,response) VALUES($1,$2,$3,$4)',[randomUUID(),f.tenant,`dataport-${record.id}`,response]);
  history=await f.store.history(p,f.tenant,new URLSearchParams());
  assert.equal(history.total,1);assert.equal(history.items[0].status,200);
  assert.equal(history.items[0].payload.response.data.status,'success');
  assert.equal(history.items[0].payload.response.data.data.risk_level,'高风险');
  assert.equal(history.items[0].payload.error,undefined);
  assert.deepEqual((await f.pool.query('SELECT * FROM dataport.queries WHERE id=$1',[record.id])).rows,before);
  const settled=await f.store.query(p,f.tenant,{ip:'198.51.100.20'},randomUUID(),async()=>({status:200,body:{data:[{ip:'198.51.100.20',status:200,response:{data:{status:'success',data:{risk_level:'低风险'}}}}]}}));
  await f.pool.query('INSERT INTO external_platform.ipsearch_batches(id,tenant_id,idempotency_key,response) VALUES($1,$2,$3,$4)',[randomUUID(),f.tenant,`dataport-${settled.id}`,{contractVersion:'mx-insight-hub.ip-risk.subscription.v1',data:[{ip:'198.51.100.20',status:409,error:{code:'query_pending'}}]}]);
  const stable=await f.store.history(p,f.tenant,new URLSearchParams('q=198.51.100.20'));
  assert.equal(stable.items[0].payload.response.data.status,'success','a less certain batch cannot downgrade a settled original result');
});
test('real BFF + Portal + local PG login enforces gateway, origin, CSRF, password gate and public-listener isolation without Auth', {skip:!connectionString}, async t=>{
  const f=await fixture(t),owner=await f.principal(),pepper='local-fixture-retained-pepper-32-characters';
  const child=await f.store.memberCommand(owner,f.tenant,{operation:'create',commandId:randomUUID(),account:'HttpEmployee',displayName:'HTTP',roleId:'analyst'},{},'');
  const initial=await f.store.initialPassword(owner,f.tenant,child.memberId,{});
  const root=await mkdtemp(join(tmpdir(),'dataport-local-http-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const profileFile=join(root,'profile.json'),gateway='fixture-dedicated-gateway-32-characters';
  const origin='https://dataport.example.test',issuer='https://auth.invalid/identity';
  await writeFile(profileFile,JSON.stringify({appId:'mx-harbor',origin,issuer,audience:'mx-harbor',clientId:'fixture',clientSecret:'s'.repeat(43),sessionKey:'k'.repeat(43)}),{mode:0o600});
  const store=new MemoryStore();store.pool=f.pool;
  const service=new HubService({store,adapter:{},apiKeyPepper:pepper});
  const portal=createHarborPortal({pool:f.pool,store,profileFile,token:gateway,hubSettings:{issuer,audience:'mx-insight-hub',legacyIssuer:'mx-user-center:test'}});
  const hub=await listen(t,createApp({store,service,adapter:{},listenerMode:'admin',harborPortal:portal}));
  const publicHub=await listen(t,createApp({store,service,adapter:{},listenerMode:'public',harborPortal:portal}));
  assert.equal((await fetch(publicHub+'/internal/v1/portal/local/login',{method:'POST',body:'{}'})).status,404);
  assert.equal((await fetch(hub+'/internal/v1/portal/local/login',{method:'POST',body:'{}'})).status,401);
  let ssoCalls=0;const calls=[];
  const bff=await listen(t,createHarborApp({config:{upstream:hub,gatewayToken:gateway,sso:{origin}},
    sso:{sessionFor(){ssoCalls++;throw Error('Unexpected MX request')},verifySession(){ssoCalls++;throw Error('Unexpected MX request')}},
    fetch:(url,options)=>{calls.push({url,headers:options.headers});return fetch(url,options)}}));
  const post=(path,body,extra={})=>fetch(bff+path,{method:'POST',headers:{origin,'content-type':'application/json',...extra},body:JSON.stringify(body)});
  assert.equal((await post('/auth/local/login',{account:child.account,password:initial.password},{origin:'https://evil.example'})).status,403);
  const login=await post('/auth/local/login',{account:child.account,password:initial.password});
  assert.equal(login.status,200,JSON.stringify(await login.clone().json()));
  assert.ok(!JSON.stringify(await login.json()).includes('token'));
  const rawCookie=login.headers.getSetCookie().find(v=>v.startsWith('__Host-mx_dataport_local='));
  assert.match(rawCookie,/HttpOnly; Secure; SameSite=Lax/);const cookie=rawCookie.split(';')[0];
  const identity=await (await fetch(bff+'/auth/sso/session',{headers:{cookie}})).json();assert.equal(identity.active,true);
  let session=await (await fetch(bff+'/bff/v1/session',{headers:{cookie}})).json();assert.equal(session.data.identityProvider,'dataport-local');assert.equal(session.data.mustChangePassword,true);
  const history=`/bff/v1/enterprises/${f.tenant}/history`;
  assert.equal((await fetch(bff+history,{headers:{cookie}})).status,403);
  assert.equal((await post('/auth/sso/account',{action:'password',currentPassword:initial.password,password:'Fixture-HTTP-password-123'},{cookie})).status,403);
  assert.equal((await post('/auth/sso/account',{action:'password',currentPassword:initial.password,password:'Fixture-HTTP-password-123'},{cookie,'x-mx-csrf':identity.csrf})).status,200);
  assert.equal((await fetch(bff+history,{headers:{cookie}})).status,401);
  const next=await post('/auth/local/login',{account:child.account,password:'Fixture-HTTP-password-123'});
  const nextCookie=next.headers.getSetCookie().find(v=>v.startsWith('__Host-mx_dataport_local=')).split(';')[0];
  session=await (await fetch(bff+'/bff/v1/session',{headers:{cookie:nextCookie}})).json();assert.equal(session.data.mustChangePassword,false);
  assert.equal((await fetch(bff+history,{headers:{cookie:nextCookie}})).status,200);
  assert.equal((await fetch(bff+`/bff/v1/enterprises/${f.other}/history`,{headers:{cookie:nextCookie}})).status,403);
  assert.equal((await fetch(bff+`/bff/v1/enterprises/${f.tenant}/members`,{headers:{cookie:nextCookie}})).status,403);
  const token=nextCookie.split('=')[1];
  assert.notEqual((await fetch(hub+'/internal/v1/admin/session',{headers:{authorization:`Bearer ${token}`}})).status,200);
  const identity2=await (await fetch(bff+'/auth/sso/session',{headers:{cookie:nextCookie}})).json();
  assert.equal((await post('/auth/sso/logout',{}, {cookie:nextCookie,'x-mx-csrf':identity2.csrf})).status,200);
  assert.equal((await fetch(bff+history,{headers:{cookie:nextCookie}})).status,401);
  assert.equal(ssoCalls,0);assert.ok(calls.every(c=>c.url.startsWith(hub)));assert.ok(calls.every(c=>!c.headers.authorization));
});

test("verified MX Portal owner receives usable permissions without a code; retired endpoints cannot write", {skip:!connectionString}, async t => {
  const f = await fixture(t);
  const store = new MemoryStore(); store.pool = f.pool;
  const service = new HubService({store, adapter:{}, apiKeyPepper:"local-fixture-retained-pepper-32-characters"});
  // Stand in for the existing MX verifier; real tenant/role enrichment and routes run below.
  const portal = { resolve: async request => {
    assert.equal(request.headers["x-mx-harbor-gateway"], "fixture-verified-gateway");
    return f.principal();
  } };
  const hub = await listen(t, createApp({store,service,adapter:{},listenerMode:"admin",harborPortal:portal,adminToken:"fixture-admin-token"}));
  const headers = {"x-mx-harbor-gateway":"fixture-verified-gateway"};
  const session = await fetch(hub+"/internal/v1/portal/session", {headers});
  assert.equal(session.status,200);
  const owner = (await session.json()).data;
  assert.equal(owner.memberships[0].dataport.ownerChallengeRequired,false);
  assert.ok(owner.memberships[0].dataport.permissions.includes("members.read"));
  for (const resource of ["members","roles","history"]) {
    assert.equal((await fetch(hub+`/internal/v1/portal/enterprises/${f.tenant}/${resource}`, {headers})).status,200);
  }
  assert.equal((await fetch(hub+`/internal/v1/portal/enterprises/${f.other}/members`, {headers})).status,403);
  for (const [path, auth] of [
    [`/internal/v1/portal/enterprises/${f.tenant}/challenge`, headers],
    ["/internal/v1/admin/dataport/owner-code", {"x-mx-insight-admin-token":"fixture-admin-token"}],
  ]) {
    const response = await fetch(hub+path, {method:"POST",headers:{...auth,"content-type":"application/json"},body:JSON.stringify({tenantId:f.tenant,memberId:f.owner,code:"retired-fixture-code"})});
    assert.equal(response.status,404);
  }
  assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM dataport.owner_codes")).rows[0].n,0);
  assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM dataport.owner_sessions")).rows[0].n,0);
});
test('payment timeout is a read-only tenant projection shared by billing filters, pagination and exports', {skip:!connectionString}, async t=>{
  const f=await fixture(t),owner=await f.principal();
  const past=new Date(Date.now()-45*60000).toISOString(),recent=new Date().toISOString(),expiredIds=[];
  async function insert(payment,tenant=f.tenant,delivered=null) {
    const id=randomUUID();
    await f.pool.query('INSERT INTO hub_commerce.orders(id,tenant_id,intent,payment,created_at,delivered_at) VALUES($1,$2,$3,$4,$5,$6)',[id,tenant,{product:{name:'Timeout fixture',sku:'fixture',amountMinor:399900}},payment,'2026-01-01',delivered]);
    return id;
  }
  for(let i=0;i<24;i++)expiredIds.push(await insert({provider:'alipay',status:'pending',createdAt:past}));
  const freshId=await insert({provider:'alipay',status:'pending',createdAt:recent});
  const paidId=await insert({provider:'alipay',status:'paid',createdAt:past});
  const deliveredId=await insert({provider:'alipay',status:'paid',createdAt:past},f.tenant,recent);
  const unknownIds=[];
  for(const payment of [null,{provider:'mock',status:'pending',createdAt:past},{provider:'alipay',status:'pending'},
    {provider:'alipay',status:'pending',createdAt:'invalid'},{provider:'alipay',status:'pending',createdAt:'2026-02-31T00:00:00.000Z'}])unknownIds.push(await insert(payment));
  const otherId=await insert({provider:'alipay',status:'pending',createdAt:past},f.other);
  const before=(await f.pool.query('SELECT id,payment FROM hub_commerce.orders ORDER BY id')).rows;
  async function read(search='') {
    let result;
    await dataportRoute({request:{method:'GET'},response:{},path:`/enterprises/${f.tenant}/billing`,searchParams:new URLSearchParams(search),principal:owner,dataport:f.store,
      sendJson(_res,_status,payload){result=payload.data}});
    return result;
  }
  const ids=[];
  for(let page=1;page<=2;page++) {
    const result=await read(`status=payment_timeout&pageSize=20&page=${page}&export=1`);
    assert.equal(result.pagination.orders.total,24);
    assert.ok(result.orders.every(order=>order.status==='payment_timeout'&&order.paymentStatus==='pending'&&order.checkoutAvailable===false));
    ids.push(...result.orders.map(order=>order.id));
  }
  assert.deepEqual(new Set(ids),new Set(expiredIds));assert.equal(ids.includes(otherId),false);
  const pending=await read('status=pending&pageSize=100');
  assert.deepEqual(new Set(pending.orders.map(order=>order.id)),new Set([freshId,...unknownIds]));
  const paid=await read('status=paid&pageSize=100');
  assert.deepEqual(new Set(paid.orders.map(order=>order.id)),new Set([paidId,deliveredId]));
  assert.equal((await read('status=delivered')).orders[0].id,deliveredId);
  const all=await read('pageSize=100'),sql=(await f.pool.query(`SELECT id,coalesce(${paymentTimedOutSql},false) AS timed_out FROM hub_commerce.orders WHERE tenant_id=$1`,[f.tenant])).rows;
  for(const row of sql)assert.equal(all.orders.find(order=>order.id===row.id).status==='payment_timeout',row.timed_out);
  assert.deepEqual((await f.pool.query('SELECT id,payment FROM hub_commerce.orders ORDER BY id')).rows,before,'reads do not close or rewrite payment records');
  await f.pool.query("UPDATE hub_commerce.orders SET payment=jsonb_set(payment,'{status}','\"paid\"') WHERE id=$1",[expiredIds[0]]);
  assert.equal((await read(`q=${expiredIds[0]}`)).orders[0].status,'delivering','late verified payment takes priority over the checkout timeout');
});
