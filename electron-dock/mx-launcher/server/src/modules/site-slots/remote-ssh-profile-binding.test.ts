import assert from 'node:assert/strict';
import test from 'node:test';

import type { SiteSlotPlan, SiteSlotSshProfile } from '../../types.js';
import { siteSlotSshProfilePlanBindingFailures } from './remote-ssh-gate.js';

function planFixture(): SiteSlotPlan {
  return {
    planId: 'slotplan_oversea_binding',
    siteId: 'mx-oversea-hk01',
    kind: 'oversea',
    host: '203.0.113.21',
    ssh: {
      profileId: 'ssh_oversea_binding',
      profileSource: 'config-center',
      profileStatus: 'active',
      profileWarnings: [],
      user: 'root',
      port: 22,
      rootAccess: true,
      rootRequired: true
    }
  } as unknown as SiteSlotPlan;
}

function profileFixture(): SiteSlotSshProfile {
  return {
    profileId: 'ssh_oversea_binding',
    siteId: 'mx-oversea-hk01',
    kind: 'oversea',
    environment: 'test',
    host: '203.0.113.21',
    sshUser: 'root',
    sshPort: 22,
    identityFile: '/tmp/mx-test-identity',
    knownHostsFile: '/tmp/mx-test-known-hosts',
    sshConfigFile: null,
    hostKeyAlias: null,
    serverPorts: '52120',
    exportPort: 3434,
    workerInternalBaseUrl: null,
    overseaCallbackBaseUrl: null,
    strictHostKeyChecking: 'yes',
    connectTimeoutSeconds: 30,
    batchMode: 'yes',
    status: 'active',
    source: 'config-center',
    warnings: [],
    createdBy: 'test',
    createdAt: '2099-01-01T00:00:00.000Z',
    updatedBy: 'test',
    updatedAt: '2099-01-01T00:00:00.000Z'
  };
}

test('remote SSH plan remains bound to the exact managed profile target', () => {
  const plan = planFixture();
  const profile = profileFixture();

  assert.deepEqual(siteSlotSshProfilePlanBindingFailures(plan, profile), []);
  assert.match(
    siteSlotSshProfilePlanBindingFailures(plan, { ...profile, host: '198.51.100.77' }).join('\n'),
    /plan host 203\.0\.113\.21 does not match current profile host 198\.51\.100\.77/
  );
  assert.match(
    siteSlotSshProfilePlanBindingFailures(plan, { ...profile, sshUser: 'deploy' }).join('\n'),
    /plan user root does not match current profile user deploy/
  );
  assert.match(
    siteSlotSshProfilePlanBindingFailures(plan, { ...profile, sshPort: 2222 }).join('\n'),
    /plan port 22 does not match current profile port 2222/
  );
  assert.match(
    siteSlotSshProfilePlanBindingFailures(plan, { ...profile, strictHostKeyChecking: 'no' }).join('\n'),
    /StrictHostKeyChecking=yes is required/
  );
});
