import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { randomBytes, createHash } from "node:crypto";
import pg from "pg";
import { MemoryStore, PgStore } from "../server/store.mjs";
import { register } from "../server/model.mjs";
import { configureLoops } from "../server/loop-policy.mjs";
import { DEFAULT_POOL_POLICY } from "../server/pool-policy.mjs";
import {
  BUILTIN_RULE_DEFINITIONS,
  BUILTIN_STRATEGY_DEFINITIONS,
  strategyStatus,
} from "../server/strategy-catalog.mjs";
import {
  listRules,
  listStrategies,
  resolveRule,
  resolveStrategy,
  saveRule,
  saveStrategy,
  archiveRule,
  archiveStrategy,
  applyStrategy,
} from "../server/strategy-registry.mjs";

const ruleBody = (row, override = {}) => ({
  code: row.code,
  name: row.name,
  description: row.description,
  kind: row.kind,
  config: row.config,
  expectedVersion: row.version,
  ...override,
});
const strategyBody = (row, override = {}) => ({
  code: row.code,
  name: row.name,
  description: row.description,
  rules: row.rules.map(({ code, version }) => ({ code, version })),
  expectedVersion: row.version,
  ...override,
});

test("rule CRUD appends immutable versions with CAS, archive tombstones and restore", () => {
  const s = new MemoryStore().state;
  const original = resolveRule(s, "placement.adaptive");
  const saved = saveRule(
    s,
    1000,
    "sim",
    ruleBody(original, {
      config: { ...original.config, idleSpreadThresholdPct: 65 },
    }),
  );
  assert.equal(saved.version, 2);
  assert.equal(resolveRule(s, original.code).config.idleSpreadThresholdPct, 65);
  assert.deepEqual(resolveRule(s, original.code, { version: 1 }), original);
  saved.config.strategy = "corrupt";
  assert.equal(resolveRule(s, original.code).config.strategy, "adaptive");
  assert.throws(() => saveRule(s, 1000, "sim", ruleBody(original)), {
    status: 409,
  });
  assert.throws(
    () => archiveRule(s, 1001, "sim", original.id, { expectedVersion: 2 }),
    { status: 409 },
  );
  const archived = archiveRule(s, 1002, "sim", saved.id, {
    expectedVersion: 2,
  });
  assert.equal(archived.version, 3);
  assert.equal(resolveRule(s, original.code), null);
  assert.equal(
    listRules(s).some((row) => row.code === original.code),
    false,
  );
  assert.equal(
    listRules(s, { history: true, includeArchived: true }).filter(
      (row) => row.code === original.code,
    ).length,
    3,
  );
  assert.throws(
    () => archiveRule(s, 1003, "sim", archived.id, { expectedVersion: 3 }),
    { status: 409 },
  );
  const restored = saveRule(s, 1004, "sim", ruleBody(archived));
  assert.equal(restored.version, 4);
  assert.equal(resolveRule(s, original.code).archived, false);
  assert.deepEqual(resolveRule(s, original.id), original);
});

test("strategy compilation freezes rule versions, rejects conflicts and preserves snapshots after rule archival", () => {
  const s = new MemoryStore().state;
  s.devices.push({ mode: "sim", rack: "test-rack" });
  const seed = resolveStrategy(s, "pool.balanced");
  const original = resolveRule(s, "placement.adaptive");
  const changed = saveRule(
    s,
    1000,
    "sim",
    ruleBody(original, {
      config: { ...original.config, idleSpreadThresholdPct: 72 },
    }),
  );
  const body = strategyBody(seed, {
    code: "custom.pool",
    name: "自定义组合",
    expectedVersion: 0,
    rules: [
      { code: changed.code },
      { code: "budget.default" },
      { code: "queue.bounded" },
      { code: "budget.pdd" },
    ],
  });
  const created = saveStrategy(s, 1001, "sim", body);
  assert.equal(created.rules[0].version, 2);
  assert.equal(created.policy.idleSpreadThresholdPct, 72);
  assert.equal(created.policy.appPolicies.pdd.maxRuns, 2);
  assert.equal(created.policy.enabled, true);
  assert.deepEqual(seed.policy, DEFAULT_POOL_POLICY);
  assert.equal(
    resolveStrategy(s, "pool.balanced").policy.idleSpreadThresholdPct,
    50,
  );
  archiveRule(s, 1002, "sim", changed.id, { expectedVersion: 2 });
  assert.throws(() => saveStrategy(s, 1003, "sim", strategyBody(created)), {
    status: 400,
  });
  // Ref.code must name the logical rule: accepting an exact historic ID here
  // would bypass the latest archived tombstone through resolveRule's history API.
  for (const code of [original.id, changed.id])
    assert.throws(
      () =>
        saveStrategy(
          s,
          1003,
          "sim",
          strategyBody(created, {
            rules: [
              { code, version: 1 },
              { code: "queue.bounded" },
              { code: "budget.default" },
            ],
          }),
        ),
      { status: 400 },
    );
  const applied = applyStrategy(s, 1004, "sim", {
    rack: "test-rack",
    revision: 0,
    strategyId: created.id,
  });
  assert.equal(applied.scheduler.idleSpreadThresholdPct, 72);
  assert.equal(applied.strategySnapshot.rules[0].definition.archived, false);
  assert.throws(
    () =>
      saveStrategy(
        s,
        1005,
        "sim",
        strategyBody(seed, {
          code: "missing.rule",
          expectedVersion: 0,
          rules: seed.rules.slice(1).map(({ code }) => ({ code })),
        }),
      ),
    { status: 400 },
  );
  for (const extra of [
    { code: "placement.spread" },
    { code: "queue.bounded" },
    { code: "budget.default" },
    { code: "budget.pdd" },
  ]) {
    const refs = [
      { code: "placement.spread" },
      { code: "queue.bounded" },
      { code: "budget.default" },
      { code: "budget.pdd" },
      extra,
    ];
    assert.throws(
      () =>
        saveStrategy(s, 1005, "sim", {
          code: "invalid.conflict",
          name: "重复规则",
          rules: refs,
          expectedVersion: 0,
        }),
      { status: 400 },
    );
  }
  const secondPdd = saveRule(
    s,
    1006,
    "sim",
    ruleBody(resolveRule(s, "budget.pdd"), {
      code: "budget.pdd.second",
      expectedVersion: 0,
    }),
  );
  assert.throws(
    () =>
      saveStrategy(
        s,
        1007,
        "sim",
        strategyBody(seed, {
          code: "invalid.app",
          expectedVersion: 0,
          rules: [
            { code: "placement.spread" },
            { code: "queue.bounded" },
            { code: "budget.default" },
            { code: "budget.pdd" },
            { code: secondPdd.code },
          ],
        }),
      ),
    { status: 400 },
  );
});

test("strategy CRUD uses immutable versions; archiving blocks new applications but not installed rack snapshots", () => {
  const s = new MemoryStore().state;
  s.devices.push({ mode: "sim", rack: "test-rack" });
  const first = resolveStrategy(s, "pool.balanced");
  const second = saveStrategy(
    s,
    1000,
    "sim",
    strategyBody(first, { name: "均衡 v2" }),
  );
  assert.equal(second.recommended, true);
  assert.throws(() => saveStrategy(s, 1000, "sim", strategyBody(first)), {
    status: 409,
  });
  const applied = applyStrategy(s, 1001, "sim", {
    rack: "test-rack",
    revision: 0,
    strategyId: second.id,
  });
  const tombstone = archiveStrategy(s, 1002, "sim", second.id, {
    expectedVersion: 2,
  });
  assert.equal(resolveStrategy(s, first.code), null);
  assert.equal(
    listStrategies(s).some((row) => row.code === first.code),
    false,
  );
  assert.deepEqual(s.loopPolicies[0], applied);
  assert.equal(strategyStatus(s.loopPolicies[0]).state, "applied");
  assert.throws(
    () =>
      applyStrategy(s, 1003, "sim", {
        rack: "test-rack",
        revision: 1,
        strategyId: first.id,
      }),
    { status: 404 },
  );
  const restored = saveStrategy(s, 1004, "sim", strategyBody(tombstone));
  assert.equal(restored.version, 4);
  assert.equal(
    listStrategies(s, { history: true, includeArchived: true }).filter(
      (row) => row.code === first.code,
    ).length,
    4,
  );
  assert.deepEqual(resolveStrategy(s, first.id), first);
});

test("rule declarations are bounded and cannot disable hard constraints, execute code or change real scheduling", () => {
  const s = new MemoryStore().state;
  const rule = resolveRule(s, "placement.adaptive");
  for (const override of [
    { id: "forged" },
    { recommended: true },
    { kind: "script" },
    { config: { ...rule.config, enabled: false } },
    { config: { ...rule.config, parallelPerDevice: 2 } },
    { config: { ...rule.config, quarantine: false } },
    { config: { ...rule.config, strategy: "eval" } },
    { config: { ...rule.config, idleSpreadThresholdPct: 101 } },
    { config: { ...rule.config, maxAffinityDelayMs: -1 } },
    { config: {} },
    { config: [] },
    { code: "Invalid code" },
    { expectedVersion: undefined },
  ])
    assert.throws(() => saveRule(s, 1000, "sim", ruleBody(rule, override)));
  const budget = resolveRule(s, "budget.default");
  for (const patch of [
    { maxRuns: 0 },
    { cooldownMs: -1 },
    { windowMs: 999 },
    { maxServiceMs: 199 },
    { maxServiceMs: Infinity },
    { shell: "touch /tmp/no" },
  ]) {
    assert.throws(
      () =>
        saveRule(
          s,
          1000,
          "sim",
          ruleBody(budget, { config: { ...budget.config, ...patch } }),
        ),
      { status: 400 },
    );
  }
  const app = resolveRule(s, "budget.pdd");
  for (const config of [
    { appId: "__proto__", policy: {} },
    { appId: "pdd", policy: { enabled: false } },
    { appId: "pdd", policy: { maxRuns: 2 } },
    { appId: "pdd" },
  ]) {
    assert.throws(() => saveRule(s, 1000, "sim", ruleBody(app, { config })), {
      status: 400,
    });
  }
  const strategy = resolveStrategy(s, "pool.balanced");
  assert.throws(
    () =>
      saveStrategy(
        s,
        1000,
        "sim",
        strategyBody(strategy, { policy: { enabled: false } }),
      ),
    { status: 400 },
  );
  assert.throws(
    () =>
      saveStrategy(
        s,
        1000,
        "sim",
        strategyBody(strategy, {
          rules: [{ code: "placement.adaptive", version: 1, definition: rule }],
        }),
      ),
    { status: 400 },
  );
  assert.throws(() => saveRule(s, 1000, "real", ruleBody(rule)), {
    status: 403,
  });
  assert.throws(() => saveStrategy(s, 1000, "real", strategyBody(strategy)), {
    status: 403,
  });
  assert.throws(
    () => archiveRule(s, 1000, "real", rule.id, { expectedVersion: 1 }),
    { status: 403 },
  );
  assert.throws(
    () => archiveStrategy(s, 1000, "real", strategy.id, { expectedVersion: 1 }),
    { status: 403 },
  );
  assert.throws(
    () =>
      applyStrategy(s, 1000, "real", {
        rack: "test",
        revision: 0,
        strategyId: strategy.id,
      }),
    { status: 403 },
  );
});

test("applying a strategy preserves running attempts and earned cooldowns; manual policy drift is visible", () => {
  const s = new MemoryStore().state;
  s.devices.push({
    id: "device",
    mode: "sim",
    rack: "test-rack",
    state: "running",
    activeAttemptId: "attempt",
  });
  s.apps.push({
    id: "app",
    mode: "sim",
    cooldownUntil: 90000,
    poolRestUntil: 90000,
    poolRuns: [
      {
        attemptId: "attempt",
        finishedAt: null,
        policySnapshot: { maxRuns: 3, cooldownMs: 5000 },
      },
    ],
  });
  s.jobs.push({
    id: "job",
    mode: "sim",
    status: "running",
    deviceId: "device",
  });
  s.attempts.push({
    id: "attempt",
    mode: "sim",
    status: "running",
    deviceId: "device",
  });
  s.commands.push({
    id: "command",
    mode: "sim",
    status: "running",
    attemptId: "attempt",
  });
  const preserved = structuredClone({
    devices: s.devices,
    apps: s.apps,
    jobs: s.jobs,
    attempts: s.attempts,
    commands: s.commands,
  });
  assert.equal(strategyStatus().state, "unmanaged");
  const strategy = resolveStrategy(s, "pool.balanced");
  let row = applyStrategy(s, 1000, "sim", {
    rack: "test-rack",
    revision: 0,
    strategyId: strategy.id,
  });
  assert.equal(strategyStatus(row).state, "applied");
  row.strategySnapshot.rules[0].definition.name = "client changed";
  assert.notEqual(
    s.loopPolicies[0].strategySnapshot.rules[0].definition.name,
    "client changed",
  );
  assert.throws(
    () =>
      applyStrategy(s, 1001, "sim", {
        rack: "test-rack",
        revision: 0,
        strategyId: strategy.id,
      }),
    { status: 409 },
  );
  row = configureLoops(s, 1002, "sim", {
    rack: "test-rack",
    revision: 1,
    scheduler: { idleSpreadThresholdPct: 75 },
  });
  assert.equal(strategyStatus(row).state, "modified");
  assert.equal(row.strategySnapshot.policy.idleSpreadThresholdPct, 50);
  row = applyStrategy(s, 1003, "sim", {
    rack: "test-rack",
    revision: 2,
    strategyId: resolveStrategy(s, "pool.spread").id,
  });
  assert.equal(row.scheduler.strategy, "spread");
  assert.equal(strategyStatus(row).state, "applied");
  assert.deepEqual(
    {
      devices: s.devices,
      apps: s.apps,
      jobs: s.jobs,
      attempts: s.attempts,
      commands: s.commands,
    },
    preserved,
  );
  const policyKeysReordered = {
    ...row,
    scheduler: Object.fromEntries(Object.entries(row.scheduler).reverse()),
  };
  assert.equal(strategyStatus(policyKeysReordered).state, "applied");
  assert.equal(
    strategyStatus({ ...row, scheduler: undefined }).state,
    "modified",
  );
});

test("migration seeds match memory catalogs and never apply strategies or create real rules", async () => {
  const sql = await readFile(
    new URL("../migrations/008_scheduling_strategies.sql", import.meta.url),
    "utf8",
  );
  const documents = [...sql.matchAll(/'((?:[^']|'')*)'::jsonb/g)].map((match) =>
    JSON.parse(match[1].replaceAll("''", "'")),
  );
  assert.deepEqual(
    documents.filter((row) => row.kind),
    BUILTIN_RULE_DEFINITIONS,
  );
  assert.deepEqual(
    documents.filter((row) => row.rules),
    BUILTIN_STRATEGY_DEFINITIONS,
  );
  const store = new MemoryStore();
  assert.equal(store.state.loopPolicies.length, 0);
  const real = await store.snapshot("real");
  assert.equal(real.ruleDefinitions.length, 0);
  assert.equal(real.strategyDefinitions.length, 0);
});

const url = process.env.MX_DEVICE_TEST_DATABASE_URL;
test(
  "Postgres upgrades preserve existing policies and persist rule/strategy CAS, application and archive across restart",
  { skip: !url },
  async () => {
    const target = new URL(url);
    assert(["localhost", "127.0.0.1"].includes(target.hostname));
    const name = `mx_strategies_${randomBytes(5).toString("hex")}`;
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    target.pathname = `/${name}`;
    let a = new PgStore(target.href),
      b = new PgStore(target.href);
    try {
      await a.pool.query("CREATE SCHEMA mx_device");
      await a.pool.query(
        "CREATE TABLE mx_device.schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())",
      );
      const dir = new URL("../migrations/", import.meta.url);
      for (const filename of (await readdir(dir))
        .filter((file) => /^00[1-7]_.*\.sql$/.test(file))
        .sort()) {
        const sql = await readFile(new URL(filename, dir), "utf8");
        await a.pool.query(sql);
        await a.pool.query(
          "INSERT INTO mx_device.schema_migrations(name,checksum) VALUES($1,$2)",
          [filename, createHash("sha256").update(sql).digest("hex")],
        );
      }
      const legacy = {
        id: "00000000-0000-4000-8000-000000000001",
        mode: "sim",
        rack: "legacy-rack",
        revision: 9,
        scheduler: { ...DEFAULT_POOL_POLICY, idleSpreadThresholdPct: 83 },
        commandDelayMs: 2200,
      };
      await a.pool.query(
        "INSERT INTO mx_device.loop_policies VALUES($1,$2,$3,$4)",
        [legacy.id, legacy.mode, legacy.rack, legacy],
      );
      await Promise.all([a.migrate(), b.migrate()]);
      let snap = await a.snapshot("sim");
      assert.deepEqual(snap.loopPolicies[0], legacy);
      assert.deepEqual(listRules(snap), BUILTIN_RULE_DEFINITIONS);
      assert.deepEqual(listStrategies(snap), BUILTIN_STRATEGY_DEFINITIONS);
      const original = resolveRule(snap, "placement.adaptive");
      const edits = await Promise.allSettled(
        Array.from({ length: 6 }, (_, i) =>
          (i % 2 ? a : b).atomic(
            (s, n) =>
              saveRule(
                s,
                n,
                "sim",
                ruleBody(original, {
                  config: { ...original.config, idleSpreadThresholdPct: 61 },
                }),
              ),
            { mode: "sim" },
          ),
        ),
      );
      assert.equal(edits.filter((r) => r.status === "fulfilled").length, 1);
      assert(
        edits
          .filter((r) => r.status === "rejected")
          .every((r) => r.reason.status === 409),
      );
      const strategy = await a.atomic(
        (s, n) =>
          saveStrategy(
            s,
            n,
            "sim",
            strategyBody(resolveStrategy(s, "pool.balanced"), {
              code: "custom.persisted",
              name: "持久化组合",
              expectedVersion: 0,
              rules: [
                { code: "placement.adaptive" },
                { code: "queue.bounded" },
                { code: "budget.default" },
              ],
            }),
          ),
        { mode: "sim" },
      );
      assert.equal(strategy.rules[0].version, 2);
      const concurrentStrategies = await Promise.allSettled(
        [a, b].map((store) =>
          store.atomic(
            (s, n) =>
              saveStrategy(
                s,
                n,
                "sim",
                strategyBody(strategy, { name: "CAS 组合" }),
              ),
            { mode: "sim" },
          ),
        ),
      );
      assert.equal(
        concurrentStrategies.filter((r) => r.status === "fulfilled").length,
        1,
      );
      assert.equal(
        concurrentStrategies.find((r) => r.status === "rejected").reason.status,
        409,
      );
      await a.atomic(
        (s, n) =>
          register(s, n, "sim", {
            name: "test-device",
            adapter: "mock",
            rack: "legacy-rack",
            host: "sim-host",
            simApps: ["xhs", "pdd"],
          }),
        { mode: "sim" },
      );
      await b.atomic(
        (s, n) =>
          applyStrategy(s, n, "sim", {
            rack: "legacy-rack",
            revision: 9,
            strategyId: resolveStrategy(s, strategy.code).id,
          }),
        { mode: "sim" },
      );
      snap = await a.snapshot("sim");
      const installed = snap.loopPolicies[0];
      assert.equal(installed.commandDelayMs, 2200);
      assert.equal(installed.scheduler.idleSpreadThresholdPct, 61);
      assert.equal(installed.strategySnapshot.version, 2);
      const latestRule = resolveRule(snap, original.code);
      await a.atomic(
        (s, n) =>
          archiveRule(s, n, "sim", latestRule.id, { expectedVersion: 2 }),
        { mode: "sim" },
      );
      const latestStrategy = resolveStrategy(snap, strategy.code);
      await b.atomic(
        (s, n) =>
          archiveStrategy(s, n, "sim", latestStrategy.id, {
            expectedVersion: 2,
          }),
        { mode: "sim" },
      );
      await a.close();
      a = new PgStore(target.href);
      await a.migrate();
      snap = await a.snapshot("sim");
      assert.deepEqual(snap.loopPolicies[0], installed);
      assert.equal(strategyStatus(snap.loopPolicies[0]).state, "applied");
      assert.equal(resolveRule(snap, original.code), null);
      assert.equal(resolveStrategy(snap, strategy.code), null);
      assert.equal(resolveStrategy(snap, strategy.id).version, 1);
      assert.equal((await a.snapshot("real")).strategyDefinitions.length, 0);
    } finally {
      await Promise.all([a.close(), b.close()]);
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    }
  },
);
