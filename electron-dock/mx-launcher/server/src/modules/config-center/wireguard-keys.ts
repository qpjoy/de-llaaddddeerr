import { createPrivateKey, createPublicKey, randomBytes } from 'node:crypto';

export interface WireGuardKeyPair {
  privateKey: string;
  publicKey: string;
}

const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const X25519_SPKI_PREFIX_BYTES = 12;

export function generateWireGuardKeyPair(): WireGuardKeyPair {
  const privateKeyBytes = clampedPrivateKeyBytes();
  return {
    privateKey: privateKeyBytes.toString('base64'),
    publicKey: deriveWireGuardPublicKey(privateKeyBytes)
  };
}

export function deriveWireGuardPublicKey(privateKeyBytes: Buffer): string {
  if (privateKeyBytes.length !== 32) throw new Error('WireGuard private key must be 32 bytes');
  const privateKey = createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, privateKeyBytes]),
    format: 'der',
    type: 'pkcs8'
  });
  const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  return Buffer.from(spki).subarray(X25519_SPKI_PREFIX_BYTES).toString('base64');
}

function clampedPrivateKeyBytes(): Buffer {
  const key = randomBytes(32);
  key[0] &= 248;
  key[31] &= 127;
  key[31] |= 64;
  return key;
}
