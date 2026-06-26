import 'reflect-metadata';

import { loadConfig } from './config.js';
import { createPlatformDataSource } from './db/data-source.js';
import { PlatformRecordEntity } from './db/entities.js';
import { GATEWAY_RUNTIME_CONFIG_ID, builtinGatewayRuntimeConfig } from './store/domain.js';

const config = loadConfig();
const dataSource = createPlatformDataSource({
  ...config,
  storeDriver: 'postgres'
});

try {
  await dataSource.initialize();
  const migrations = await dataSource.runMigrations({ transaction: 'all' });
  const records = dataSource.getRepository(PlatformRecordEntity);
  const existingGatewayRuntime = await records.findOne({
    where: {
      kind: 'gateway-runtime-config',
      id: GATEWAY_RUNTIME_CONFIG_ID,
      environment: config.environment
    }
  });
  let seededGatewayRuntimeConfig = false;
  if (!existingGatewayRuntime) {
    const gatewayRuntimeConfig = builtinGatewayRuntimeConfig(config, new Date().toISOString(), 'migration-seed');
    await records.save({
      kind: 'gateway-runtime-config',
      id: gatewayRuntimeConfig.configId,
      environment: gatewayRuntimeConfig.environment,
      siteId: gatewayRuntimeConfig.siteId,
      data: gatewayRuntimeConfig as unknown as Record<string, unknown>
    });
    seededGatewayRuntimeConfig = true;
  }
  console.log(JSON.stringify({
    ok: true,
    action: 'migrate:up',
    migrations: migrations.map((migration) => migration.name),
    seededGatewayRuntimeConfig
  }, null, 2));
} finally {
  if (dataSource.isInitialized) {
    await dataSource.destroy();
  }
}
