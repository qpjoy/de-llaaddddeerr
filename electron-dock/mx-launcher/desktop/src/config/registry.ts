import { launcherProducts } from '../catalog.js';
import type { MxProductConfigDefinition, MxProductConfigRecord } from '../contracts/mx.js';

export function listProductConfigDefinitions(productId: string): MxProductConfigDefinition[] {
  const product = launcherProducts.find((row) => row.id === productId);
  return product?.config ?? [];
}

export function createDefaultProductConfig(productId: string, now = new Date().toISOString()): MxProductConfigRecord[] {
  return listProductConfigDefinitions(productId)
    .filter((definition) => definition.defaultValue !== undefined)
    .map((definition) => ({
      productId,
      key: definition.key,
      scope: definition.scope,
      value: definition.defaultValue,
      source: 'default',
      updatedAt: now
    }));
}
