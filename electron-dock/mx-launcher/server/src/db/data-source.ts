import { DataSource } from 'typeorm';

import { PlatformRecordEntity } from './entities.js';
import { InitPlatformRecords1760000000000 } from './migrations/1760000000000-InitPlatformRecords.js';
import { LauncherNetworkLeaseConstraints1760000000100 } from './migrations/1760000000100-LauncherNetworkLeaseConstraints.js';
import type { RuntimeConfig } from '../types.js';

export function createPlatformDataSource(config: RuntimeConfig): DataSource {
  if (!config.databaseUrl) {
    throw new Error('DATABASE_URL is required when INTERNAL_STORE_DRIVER=postgres');
  }
  return new DataSource({
    type: 'postgres',
    url: config.databaseUrl,
    entities: [PlatformRecordEntity],
    migrations: [InitPlatformRecords1760000000000, LauncherNetworkLeaseConstraints1760000000100],
    migrationsTableName: 'mx_schema_migrations',
    synchronize: false,
    logging: false
  });
}
