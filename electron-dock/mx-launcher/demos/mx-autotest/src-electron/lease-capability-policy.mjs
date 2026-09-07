import { randomBytes } from 'node:crypto';

const CAPABILITY_PATTERN = /^mxlc1\.[A-Za-z0-9_-]{43}$/;

export function mintLeaseCapability() {
  return `mxlc1.${randomBytes(32).toString('base64url')}`;
}

export function isLeaseCapability(value) {
  return typeof value === 'string' && CAPABILITY_PATTERN.test(value);
}

export function identityCapabilityKey(identityKind, userId) {
  return identityKind === 'user' ? `user:${userId || 'missing'}` : 'anonymous';
}

export function collectEnrollmentLeaseCapabilities({
  credentials,
  pendingCapabilities,
  identityKind,
  userId,
  productId,
  installId,
  publicKey
}) {
  const currentPending = pendingCapabilities[identityCapabilityKey(identityKind, userId)];
  const existing = Object.values(credentials)
    .filter((credential) => (
      credential.productId === productId
      && credential.installId === installId
      && credential.publicKey === publicKey
      && isLeaseCapability(credential.capability)
    ))
    .sort((left, right) => {
      const leftPriority = left.identityKind === identityKind && left.userId === userId ? 1 : 0;
      const rightPriority = right.identityKind === identityKind && right.userId === userId ? 1 : 0;
      return rightPriority - leftPriority || String(right.updatedAt || '').localeCompare(String(left.updatedAt || ''));
    })
    .map((credential) => credential.capability);
  const capabilities = [...new Set([currentPending, ...existing])]
    .filter(isLeaseCapability)
    .slice(0, 16);
  return capabilities.length ? capabilities.join(',') : undefined;
}
