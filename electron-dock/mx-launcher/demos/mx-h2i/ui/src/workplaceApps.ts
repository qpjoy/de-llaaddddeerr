import type { CatalogApp } from './bridge';

// Real web entry points supplied for the employee workbench. These are links,
// independent of the installed AppCenter/H2O plugin catalog.
export const workplaceApps: CatalogApp[] = ([
  { id: 'web-delta', name: 'Delta', url: 'http://delta.mxinfo-inc.cn/web/data-hub', category: '中台应用', icon: 'triangle', color: 'purple' },
  { id: 'web-hub', name: 'Hub', url: 'https://hub.minsight-ai.com/admin/?admin=1#/dataport/support', category: '中台应用', icon: 'layers', color: 'blue' },
  { id: 'web-night-all', name: 'Night-All', url: 'http://10.88.88.88:13141/console/platform', category: '中台应用', icon: 'moon', color: 'indigo' },
  { id: 'web-compass', name: 'Compass', url: 'http://10.88.88.88:55855/', category: '产品应用', icon: 'compass', color: 'mint' },
  { id: 'web-argus', name: 'Argus', url: 'https://inhouse.arguseek.com/research/new', category: '产品应用', icon: 'search', color: 'blue' },
  { id: 'web-compass-admin', name: 'Compass管理后台', url: 'http://10.88.88.88:55866/admin', category: '管理后台', icon: 'shield', color: 'purple' },
] as const).map((app) => ({ ...app, installed: false, running: false, description: '', action: { action: '', label: '打开', disabled: false } }));
