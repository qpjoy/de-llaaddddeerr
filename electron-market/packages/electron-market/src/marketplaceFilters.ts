type EntryLike = {
  id?: string | null;
  npm?: string | null;
  category?: string | null;
  metadata?: Record<string, unknown> | null;
};

function internalPackageName(value: string): boolean {
  const name = value.trim().toLowerCase();
  if (!name) return false;
  if (name === '@qpjoy/electron-market') return true;
  if (name.startsWith('@qpjoy/electron-core-')) return true;
  if (name.startsWith('@qpjoy/electron-plugin-tunnel-engine-')) return true;
  if (name.startsWith('@qpjoy/electron-core-wireguard-engine-')) return true;
  return /^@qpjoy\/.+-engine-(darwin|linux|win32)-/.test(name);
}

export function isUserInstallableMarketplaceEntry(entry: EntryLike): boolean {
  const metadata = entry.metadata ?? null;
  if (metadata?.self === true || metadata?.hidden === true || metadata?.internal === true) {
    return false;
  }
  if (entry.category === 'internal') return false;
  return ![entry.id, entry.npm].some((value) => (
    typeof value === 'string' && internalPackageName(value)
  ));
}
