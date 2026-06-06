import type { MxLauncherCatalog, MxProductDefinition } from './contracts/mx.js';

export const hdoProduct: MxProductDefinition = {
  id: 'hdo',
  name: 'HDO',
  legacyProductId: 'hdo',
  displayName: 'HDO',
  description: 'MX-managed HDO desktop product compatible with existing HDO APIs.',
  category: 'network',
  channels: ['stable', 'beta', 'internal'],
  platforms: ['darwin', 'win32'],
  capabilities: ['network.mesh', 'wireguard', 'dns', 'route', 'employee-login', 'visitor-access'],
  backend: {
    mxLauncherAdminApi: '/api/v1/mx-launcher/admin/products/hdo',
    legacyApiBase: '/api/v1/hdo',
    configApi: '/api/v1/mx-launcher/admin/products/hdo/config'
  },
  artifacts: {
    resourcesDirectory: 'products/hdo',
    serviceProfile: 'hdo-network'
  },
  config: [
    {
      key: 'serverBaseUrl',
      label: '服务器地址',
      scope: 'install',
      valueType: 'string',
      required: false,
      defaultValue: '',
      description: 'MX Launcher connects HDO to this MX Launcher Server base URL.'
    },
    {
      key: 'defaultMode',
      label: '默认模式',
      scope: 'user',
      valueType: 'string',
      required: true,
      defaultValue: 'visitor',
      description: 'visitor or employee'
    },
    {
      key: 'relayMode',
      label: '中继模式',
      scope: 'product',
      valueType: 'string',
      required: true,
      defaultValue: 'mesh-h2i'
    }
  ]
};

export const launcherProducts: MxProductDefinition[] = [hdoProduct];

export const mxLauncherCatalog: MxLauncherCatalog = {
  schemaVersion: 1,
  platformName: 'MX Launcher',
  products: launcherProducts
};

export function getLauncherProduct(id: string): MxProductDefinition | null {
  return launcherProducts.find((product) => product.id === id) ?? null;
}
