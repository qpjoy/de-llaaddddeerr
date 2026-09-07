export interface LeaseCapabilityCredential {
  capability: string;
  productId: string;
  installId: string;
  publicKey: string;
  identityKind: 'anonymous' | 'user';
  userId: string | null;
  updatedAt?: string | null;
}

export function mintLeaseCapability(): string;
export function isLeaseCapability(value: unknown): value is string;
export function identityCapabilityKey(identityKind: 'anonymous' | 'user', userId: string | null): string;
export function collectEnrollmentLeaseCapabilities(input: {
  credentials: Record<string, LeaseCapabilityCredential>;
  pendingCapabilities: Record<string, string>;
  identityKind: 'anonymous' | 'user';
  userId: string | null;
  productId: string;
  installId: string;
  publicKey: string | null | undefined;
}): string | undefined;
