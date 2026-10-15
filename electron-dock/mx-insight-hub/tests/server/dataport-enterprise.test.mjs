import test from "node:test";
import { DataportPlatform, requireDataportPlatformAdmin, platformRouteAllowed } from "../../server/portal/dataport-platform.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DataportAccountsClient } from "../../server/portal/dataport-accounts.mjs";
import pg from "pg";
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
  for (const prefix of ["001_", "007_", "149_", "151_dataport_"])
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


test('platform administration rejects enterprise owners, names, generic Hub admin and wrong routes', async()=>{
  for(const value of [null,{kind:'admin-token',dataportPlatformAdmin:true},{kind:'launcher-user',platformAdmin:true},{kind:'launcher-user',displayName:'taku'},{kind:'launcher-user',memberships:[{role:'owner'}]}])assert.throws(()=>requireDataportPlatformAdmin(value),{code:'dataport_platform_admin_required'});
  const id=randomUUID();
  for(const [method,path] of [['GET','/platform/enterprises'],['POST',`/platform/enterprises/${id}/owners`],['POST',`/platform/enterprises/${id}/owners/${id}/code`]])assert.equal(platformRouteAllowed(method,path),true);
  for(const [method,path] of [['GET',`/platform/enterprises/${id}/owners`],['DELETE','/platform/enterprises'],['POST','/platform/admin-token'],['POST',`/platform/enterprises/${id}/members`]])assert.equal(platformRouteAllowed(method,path),false);
});

test('platform enterprise enrollment, owner creation/invitation, code hashing and revocation use isolated PostgreSQL', {skip:!connectionString}, async t=>{
  const f=await fixture(t), principal={...await f.principal(f.viewer),dataportPlatformAdmin:true};
  let enabled=true,calls=0;
  const identities=new Map();
  const accounts={
    isPlatformAdmin:async()=>enabled,
    invitation:(id)=>digest(id).slice(0,43),
    execute:async input=>{calls++;if(input.operation==='initial-password')return {password:'fixture-secret'};
      if(!identities.has(input.requestId))identities.set(input.requestId,{userId:`usr_${randomUUID()}`,subject:`user:usr_${randomUUID()}`,issuer:principal.issuer,account:input.account,displayName:input.displayName||input.account});return identities.get(input.requestId);}
  };
  const service=new DataportPlatform(f.store,accounts),id=randomUUID();
  await assert.rejects(service.create(await f.principal(),{commandId:id,name:'New enterprise'}),{code:'dataport_platform_admin_required'});
  const enterprise=await service.create(principal,{commandId:id,name:'New enterprise'});
  assert.deepEqual(await service.create(principal,{commandId:id,name:'New enterprise'}),enterprise);
  await assert.rejects(service.create(principal,{commandId:id,name:'Other enterprise'}),{code:'platform_command_conflict'});
  const body={commandId:randomUUID(),operation:'create',account:'owner-fixture',displayName:'New owner'};
  const created=await service.owner(principal,id,body,'mx-insight-hub');
  assert.deepEqual(await service.owner(principal,id,body,'mx-insight-hub'),created);
  assert.equal((await f.pool.query('SELECT role FROM iam.tenant_memberships WHERE tenant_id=$1 AND member_id=$2',[id,created.memberId])).rows[0].role,'owner');
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM iam.tenant_memberships WHERE tenant_id=$1',[id])).rows[0].n,1,'the operator does not become a tenant owner');
  await f.store.configureOwnerCode(id,created.memberId,'fixture-owner-code-platform',principal.memberId);
  const listed=await service.list(principal,new URLSearchParams('q=New enterprise'));
  assert.equal(listed.items[0].owners[0].codeConfigured,true);assert.equal(JSON.stringify(listed).includes('fixture-owner-code-platform'),false);
  const stored=(await f.pool.query('SELECT digest FROM dataport.owner_codes WHERE tenant_id=$1',[id])).rows[0];assert.notEqual(stored.digest,'fixture-owner-code-platform');
  const audit=(await f.pool.query("SELECT actor,detail FROM dataport.events WHERE tenant_id=$1 AND action='owner.code.configured'",[id])).rows[0];assert.equal(audit.actor,principal.memberId);assert.equal(JSON.stringify(audit).includes('fixture-owner-code-platform'),false);
  assert.deepEqual(await service.password(principal,id,created.memberId),{password:'fixture-secret'});
  const invite={commandId:randomUUID(),operation:'invite',account:'existing-fixture'};
  const invitation=await service.owner(principal,id,invite,'mx-insight-hub'), identity=identities.get(invite.commandId);
  const invited={...principal,dataportPlatformAdmin:false,subject:identity.subject,issuer:identity.issuer};
  enabled=false;
  await assert.rejects(f.store.join(invited,invitation.joinToken,true,'mx-insight-hub',accounts),{code:'join_revoked'});
  enabled=true;
  const preview=await f.store.join(invited,invitation.joinToken,false,'mx-insight-hub',accounts);assert.equal(preview.roleId,'owner');
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM iam.tenant_memberships WHERE tenant_id=$1',[id])).rows[0].n,1);
  const realInvited={...invited,memberId:randomUUID()};
  await f.pool.query('INSERT INTO iam.members(id,display_name) VALUES($1,$2)',[realInvited.memberId,'Existing user']);
  await f.pool.query('INSERT INTO iam.external_identity_bindings(id,member_id,issuer,subject,audience) VALUES($1,$2,$3,$4,$5)',[randomUUID(),realInvited.memberId,identity.issuer,identity.subject,'mx-insight-hub']);
  await f.store.join(realInvited,invitation.joinToken,true,'mx-insight-hub',accounts);
  assert.equal((await f.pool.query('SELECT role FROM iam.tenant_memberships WHERE tenant_id=$1 AND member_id=$2',[id,realInvited.memberId])).rows[0].role,'owner');
  enabled=false;
  await assert.rejects(service.owner(principal,id,{commandId:randomUUID(),operation:'invite',account:'revoked-fixture'},'mx-insight-hub'),{code:'dataport_platform_admin_required'});
});
