import 'reflect-metadata';

import { loadConfig } from './config.js';
import { createPlatformDataSource } from './db/data-source.js';

const config = loadConfig();
const dataSource = createPlatformDataSource({
  ...config,
  storeDriver: 'postgres'
});

try {
  await dataSource.initialize();
  const migrations = await dataSource.runMigrations({ transaction: 'all' });
  console.log(JSON.stringify({
    ok: true,
    action: 'migrate:up',
    migrations: migrations.map((migration) => migration.name)
  }, null, 2));
} finally {
  if (dataSource.isInitialized) {
    await dataSource.destroy();
  }
}
