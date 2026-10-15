import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import { createPlatformDataSource } from "../db/data-source.js";
import { IdentityRepository } from "../identity/repository.js";
import {
  DataportAccounts,
  DataportAccountsController,
} from "./dataport-accounts.js";
import { RegistrationRepository } from "./repository.js";
import { builtinUserCenterRoles } from "../store/domain.js";
import { canAccessIdentityApplication } from "../identity/application-access.js";

const databaseUrl = process.env.MX_SSO_TEST_DATABASE_URL;
test(
  "DataPort managed accounts use MX identity, encrypt initial credentials, recover commands and preserve existing users",
  { skip: !databaseUrl },
  async () => {
    const url = new URL(databaseUrl!);
    assert.ok(
      ["127.0.0.1", "localhost"].includes(url.hostname) &&
        url.pathname.includes("sso_test"),
    );
    const environment = `dataport-${randomUUID()}`,
      config = {
        ...loadConfig(),
        databaseUrl: databaseUrl!,
        environment,
        storeDriver: "postgres" as const,
      };
    const db = createPlatformDataSource(config);
    await db.initialize();
    await db.runMigrations();
    const key = randomBytes(32),
      repo = new DataportAccounts(databaseUrl!, environment, "test", key),
      identity = new IdentityRepository(
        databaseUrl!,
        environment,
        environment,
        "test",
      ),
      registration = new RegistrationRepository(
        databaseUrl!,
        environment,
        "launcher",
        "test",
      );
    await identity.initialize();
    const input = {
      operation: "create" as const,
      requestId: randomUUID(),
      tenantId: randomUUID(),
      actor: randomUUID(),
      account: "EnterpriseEmployee",
      displayName: "员工",
    };
    try {
      const [created, concurrentReplay] = await Promise.all([
        repo.execute(input),
        repo.execute(input),
      ]);
      assert.deepEqual(concurrentReplay, created);
      assert.deepEqual(await repo.execute(input), created);
      const user = await identity.account(created.userId);
      assert.equal(user?.account, input.account);
      assert.deepEqual(user?.roleIds, ["mx-user"]);
      assert.deepEqual(user?.appAccess.allowedAppIds, ["mx-harbor"]);
      for (const app of ["mx-h2i", "luopan"])
        assert.equal(canAccessIdentityApplication(user, app), false);
      const statusCommand = {operation:"platform-admin-status" as const,requestId:randomUUID(),tenantId:input.tenantId,actor:input.actor,userId:created.userId};
      assert.equal((await repo.execute(statusCommand)).active,false);
      const role=builtinUserCenterRoles().find(r=>r.roleId==="mx-dataport-admin")!;
      await db.query("INSERT INTO mx_platform_records(environment,kind,id,site_id,data) VALUES($1,'iam-role',$2,'test',$3)",[environment,role.roleId,role]);
      await db.query("UPDATE mx_platform_records SET data=jsonb_set(data,'{roleIds}',$3::jsonb) WHERE environment=$1 AND kind='iam-user' AND id=$2",[environment,created.userId,JSON.stringify(["mx-user","mx-dataport-admin"])]);
      assert.equal((await repo.execute(statusCommand)).active,true);
      assert.equal((await repo.execute(statusCommand)).issuer,`mx-user-center:${environment}`);
      await db.query("UPDATE mx_platform_records SET data=jsonb_set(data,'{roleIds}',$3::jsonb) WHERE environment=$1 AND kind='iam-user' AND id=$2",[environment,created.userId,JSON.stringify(["mx-user"])]);
      assert.equal((await repo.execute(statusCommand)).active,false,"same request ID cannot cache an administrator grant after revocation");
      const plain = await repo.execute({
        operation: "initial-password",
        requestId: randomUUID(),
        tenantId: input.tenantId,
        actor: input.actor,
        userId: created.userId,
      });
      assert.ok(plain.password.length >= 20);
      assert.equal(
        (await identity.authenticate(input.account, plain.password))?.userId,
        created.userId,
      );
      assert.equal(
        (
          await repo.execute({
            operation: "initial-password",
            requestId: randomUUID(),
            tenantId: input.tenantId,
            actor: input.actor,
            userId: created.userId,
          })
        ).password,
        plain.password,
      );
      const rows = await db.query(
        "SELECT data FROM mx_platform_records WHERE environment=$1",
        [environment],
      );
      assert.ok(
        !JSON.stringify(rows).includes(plain.password),
        "no clear initial password stored in any record, audit or command",
      );
      await assert.rejects(repo.execute({ ...input, account: "Other" }), {
        status: 409,
      });
      await assert.rejects(
        repo.execute({ ...input, requestId: randomUUID() }),
        { code: "account_exists" },
      );
      await assert.rejects(
        repo.execute({
          operation: "initial-password",
          requestId: randomUUID(),
          tenantId: randomUUID(),
          actor: input.actor,
          userId: created.userId,
        }),
        { status: 404 },
      );
      const before = await identity.account(created.userId),
        credentialBefore = await db.query(
          "SELECT data FROM mx_platform_records WHERE environment=$1 AND kind='iam-user-credential'",
          [environment],
        );
      const invited = await repo.execute({
        ...input,
        operation: "invite",
        requestId: randomUUID(),
      });
      assert.equal(invited.userId, created.userId);
      assert.ok(!("password" in invited));
      assert.deepEqual(
        await db.query(
          "SELECT data FROM mx_platform_records WHERE environment=$1 AND kind='iam-user-credential'",
          [environment],
        ),
        credentialBefore,
      );
      assert.deepEqual(
        (await identity.account(created.userId))?.profile,
        before?.profile,
      );
      await registration.updateAccount("password", {
        userId: created.userId,
        currentPassword: plain.password,
        password: "NewEmployeePassword123!",
      });
      await assert.rejects(
        repo.execute({
          operation: "initial-password",
          requestId: randomUUID(),
          tenantId: input.tenantId,
          actor: input.actor,
          userId: created.userId,
        }),
        { code: "initial_password_changed" },
      );
      assert.equal(
        (await identity.authenticate(input.account, "NewEmployeePassword123!"))
          ?.userId,
        created.userId,
      );
      const source = {
        issuer: "https://auth.example.test/identity",
        clientId: "harbor",
        appId: "mx-harbor",
        appOrigin: "https://harbor.example.test",
      };
      await assert.rejects(
        registration.register({
          transactionId: randomUUID(),
          clientId: "launcher",
          policyVersion: 0,
          account: "NoPublicSignup",
          password: "FixturePassword123!",
          source,
        }),
        { code: "dataport_managed_accounts" },
      );
      assert.equal((await registration.policy(source)).mode, "closed");
      await repo.close();
      const restarted = new DataportAccounts(
        databaseUrl!,
        environment,
        "test",
        key,
      );
      try {
        assert.deepEqual(await restarted.execute(input), created);
      } finally {
        await restarted.close();
      }
    } finally {
      await repo.close();
      await identity.close();
      await registration.close();
      await db.query("DELETE FROM mx_platform_records WHERE environment=$1", [
        environment,
      ]);
      await db.query("DELETE FROM mx_identity_records WHERE scope=$1", [
        environment,
      ]);
      await db.destroy();
    }
  },
);

test("DataPort internal account endpoint accepts only its dedicated credential and fails closed without configuration", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dataport-account-token-")),
    oldToken = process.env.MX_DATAPORT_ACCOUNT_TOKEN_FILE,
    oldKey = process.env.MX_DATAPORT_CREDENTIAL_KEY_FILE;
  try {
    const tokenFile = join(dir, "token"),
      keyFile = join(dir, "key");
    await writeFile(tokenFile, "fixture-dedicated-dataport-token-123456");
    await writeFile(keyFile, randomBytes(32).toString("hex"));
    process.env.MX_DATAPORT_ACCOUNT_TOKEN_FILE = tokenFile;
    process.env.MX_DATAPORT_CREDENTIAL_KEY_FILE = keyFile;
    const controller = new DataportAccountsController(loadConfig());
    await assert.rejects(
      controller.command("platform-operator-token", {} as any),
      (e: any) => e.getStatus() === 401,
    );
    delete process.env.MX_DATAPORT_ACCOUNT_TOKEN_FILE;
    await assert.rejects(
      controller.command("fixture-dedicated-dataport-token-123456", {} as any),
      (e: any) => e.getStatus() === 503,
    );
  } finally {
    if (oldToken === undefined)
      delete process.env.MX_DATAPORT_ACCOUNT_TOKEN_FILE;
    else process.env.MX_DATAPORT_ACCOUNT_TOKEN_FILE = oldToken;
    if (oldKey === undefined)
      delete process.env.MX_DATAPORT_CREDENTIAL_KEY_FILE;
    else process.env.MX_DATAPORT_CREDENTIAL_KEY_FILE = oldKey;
    await rm(dir, { recursive: true, force: true });
  }
});
