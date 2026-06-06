import type { RuntimeConfig } from '../types.js';
import { MemoryStore } from './memory.js';
import type { PlatformStore } from './platform-store.js';
import { PostgresStore } from './postgres.js';

export async function createPlatformStore(config: RuntimeConfig): Promise<PlatformStore> {
  if (config.storeDriver === 'postgres') {
    return PostgresStore.create(config);
  }
  return new MemoryStore(config);
}
