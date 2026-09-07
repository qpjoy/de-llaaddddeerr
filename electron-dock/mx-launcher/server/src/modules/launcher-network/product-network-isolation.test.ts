import assert from 'node:assert/strict';
import test from 'node:test';
import type { QueryRunner } from 'typeorm';

import { loadConfig } from '../../config.js';
import { LauncherProductServiceVipConstraint1760000000400 } from '../../db/migrations/1760000000400-LauncherProductServiceVipConstraint.js';
import { MemoryStore } from '../../store/memory.js';
import type { LauncherProductNetworkInput } from '../../types.js';

const config = loadConfig();

test('different products cannot claim the same enabled service VIP even with disjoint lease CIDRs', () => {
  const store = new MemoryStore(config);
  const mxH2i = store.getLauncherProductNetwork('mx-h2i');
  assert.ok(mxH2i);

  assert.throws(
    () => store.upsertLauncherProductNetwork(isolatedProduct('vip-conflict', mxH2i.serviceVip)),
    /Launcher product vip-conflict service VIP .* conflicts with mx-h2i/
  );
  assert.equal(store.getLauncherProductNetwork('vip-conflict'), null);
});

test('embed mode and alternate IPv4 spelling cannot bypass service VIP ownership', () => {
  const store = new MemoryStore(config);
  const mxH2i = store.getLauncherProductNetwork('mx-h2i');
  assert.ok(mxH2i);

  assert.throws(
    () => store.upsertLauncherProductNetwork({
      ...isolatedProduct('vip-embed-conflict', '010.088.100.001'),
      mode: 'embed',
      standaloneChannelProductId: 'mx-h2i'
    }),
    /Launcher product vip-embed-conflict service VIP 10\.88\.100\.1 conflicts with mx-h2i/
  );
});

test('the same product can idempotently retain its service VIP', () => {
  const store = new MemoryStore(config);
  const created = store.upsertLauncherProductNetwork(
    isolatedProduct('vip-idempotent', '10.88.100.240')
  );

  const updated = store.upsertLauncherProductNetwork({
    productId: created.productId,
    serviceVip: created.serviceVip,
    requestedBy: 'service-vip-idempotency-test'
  });

  assert.equal(updated.productId, created.productId);
  assert.equal(updated.serviceVip, created.serviceVip);
});

test('a disabled product may reserve a duplicate service VIP but cannot enable it', () => {
  const store = new MemoryStore(config);
  const mxH2i = store.getLauncherProductNetwork('mx-h2i');
  assert.ok(mxH2i);

  const disabled = store.upsertLauncherProductNetwork({
    ...isolatedProduct('vip-disabled', mxH2i.serviceVip),
    enabled: false
  });
  assert.equal(disabled.enabled, false);

  assert.throws(
    () => store.upsertLauncherProductNetwork({
      productId: disabled.productId,
      enabled: true,
      requestedBy: 'service-vip-enable-test'
    }),
    /Launcher product vip-disabled service VIP .* conflicts with mx-h2i/
  );
  assert.equal(store.getLauncherProductNetwork('vip-disabled')?.enabled, false);
});

test('postgres migration installs a numeric IPv4 enabled-only unique constraint without rewriting data', async () => {
  const statements: string[] = [];
  const queryRunner = {
    query: async (statement: string) => {
      statements.push(statement);
      return [];
    }
  } as unknown as QueryRunner;

  await new LauncherProductServiceVipConstraint1760000000400().up(queryRunner);

  const preflight = statements.find((statement) => statement.includes('duplicate enabled service VIP'));
  const ipv4Constraint = statements.find((statement) => statement.includes(
    'ADD CONSTRAINT ck_mx_launcher_enabled_product_service_vip_ipv4'
  ));
  const uniqueIndex = statements.find((statement) => statement.includes(
    'CREATE UNIQUE INDEX uq_mx_launcher_enabled_product_service_vip'
  ));
  assert.ok(preflight);
  assert.ok(ipv4Constraint);
  assert.ok(uniqueIndex);
  assert.doesNotMatch(preflight, /\bUPDATE\b/i);
  assert.match(ipv4Constraint, /ELSE false/);
  assert.match(ipv4Constraint, /BETWEEN 0 AND 255/);
  assert.doesNotMatch(uniqueIndex, /\benvironment\b/i);
  assert.match(preflight, /missing or invalid IPv4 serviceVip/);
  assert.match(preflight, /GROUP BY octet_1, octet_2, octet_3, octet_4/);
  assert.match(uniqueIndex, /split_part\(BTRIM\(data->>'serviceVip'\), '\.', 1\)\)::integer/);
  assert.doesNotMatch(uniqueIndex, /ON mx_platform_records \(\(BTRIM\(data->>'serviceVip'\)\)\)/);
  assert.match(uniqueIndex, /data->>'enabled' IS DISTINCT FROM 'false'/);
});

function isolatedProduct(productId: string, serviceVip: string): LauncherProductNetworkInput {
  return {
    productId,
    mode: 'standalone',
    productIndex: 30,
    serviceVip,
    userCidr: '10.120.0.0/16',
    feishuCidr: '10.120.0.0/16',
    anonymousCidr: '10.120.0.0/16',
    userLeaseStart: '10.120.0.1',
    userLeaseEnd: '10.120.49.254',
    feishuLeaseStart: '10.120.50.1',
    feishuLeaseEnd: '10.120.99.254',
    anonymousLeaseStart: '10.120.100.1',
    anonymousLeaseEnd: '10.120.254.254',
    requestedBy: 'service-vip-isolation-test'
  };
}
