import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collectEnrollmentLeaseCapabilities,
  isLeaseCapability,
  mintLeaseCapability
} from '../src-electron/lease-capability-policy.mjs';

const productId = 'mx-autotest';
const installId = 'mxat_inst_test';
const publicKey = 'public-key';
const token = (character) => `mxlc1.${character.repeat(43)}`;

test('new capabilities use the Launcher protocol format', () => {
  const capability = mintLeaseCapability();
  assert.equal(isLeaseCapability(capability), true);
  assert.equal(capability.length, 49);
  assert.equal(isLeaseCapability(capability.slice(6)), false);
});

test('first enrollment sends its crash-safe pending capability', () => {
  const pending = token('a');
  assert.equal(collectEnrollmentLeaseCapabilities({
    credentials: {},
    pendingCapabilities: { anonymous: pending },
    identityKind: 'anonymous',
    userId: null,
    productId,
    installId,
    publicKey
  }), pending);
});

test('anonymous to user handover proves the existing anonymous lease', () => {
  const anonymous = token('a');
  const pendingUser = token('u');
  const unrelated = token('x');
  const candidates = collectEnrollmentLeaseCapabilities({
    credentials: {
      anonymous: {
        capability: anonymous,
        productId,
        installId,
        publicKey,
        identityKind: 'anonymous',
        userId: null,
        updatedAt: '2026-01-01T00:00:00.000Z'
      },
      otherProduct: {
        capability: unrelated,
        productId: 'mx-h2i',
        installId,
        publicKey,
        identityKind: 'anonymous',
        userId: null
      }
    },
    pendingCapabilities: { 'user:user-1': pendingUser },
    identityKind: 'user',
    userId: 'user-1',
    productId,
    installId,
    publicKey
  })?.split(',');

  assert.deepEqual(candidates, [pendingUser, anonymous]);
  assert.equal(candidates?.includes(unrelated), false);
});

test('candidate list is deduplicated and bounded by the server contract', () => {
  const credentials = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [
    `lease-${index}`,
    {
      capability: token(String.fromCharCode(65 + index)),
      productId,
      installId,
      publicKey,
      identityKind: 'anonymous',
      userId: null,
      updatedAt: new Date(index * 1_000).toISOString()
    }
  ]));
  const candidates = collectEnrollmentLeaseCapabilities({
    credentials,
    pendingCapabilities: {},
    identityKind: 'anonymous',
    userId: null,
    productId,
    installId,
    publicKey
  })?.split(',') || [];
  assert.equal(candidates.length, 16);
  assert.equal(new Set(candidates).size, 16);
});
