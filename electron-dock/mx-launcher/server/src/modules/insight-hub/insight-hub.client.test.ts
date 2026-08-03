import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchInsightHubOverview } from './insight-hub.client.js';
import type { InsightHubClient } from './insight-hub.client.js';
import { InsightHubController } from './insight-hub.controller.js';
import { builtinAppCenterApps, MX_INSIGHT_HUB_APP_ID } from '../../store/domain.js';

test('queries readiness and dashboard with the server-side admin token', async () => {
  const requests: Array<{ url: string; headers: Headers }> = [];
  let clock = 1_000;
  const overview = await fetchInsightHubOverview({
    adminUrl: 'http://insight.internal.mx:18151/',
    adminToken: 'hub-admin-secret',
    now: () => ++clock,
    fetchImplementation: async (input, init) => {
      const url = String(input);
      requests.push({ url, headers: new Headers(init?.headers) });
      if (url.endsWith('/health/ready')) {
        return Response.json({ data: { status: 'ready' } });
      }
      return Response.json({
        data: {
          tenants: 2,
          consumers: 3,
          activeApiKeys: 4,
          requests: 5,
          units: 6,
          averageUpstreamLatencyMs: 17
        }
      });
    }
  });

  assert.equal(overview.status, 'online');
  assert.equal('data' in overview.dashboard, false);
  assert.deepEqual(overview.metrics, {
    tenants: 2,
    consumers: 3,
    activeApiKeys: 4,
    requests: 5,
    units: 6,
    averageUpstreamLatencyMs: 17
  });
  assert.deepEqual(requests.map((request) => request.url), [
    'http://insight.internal.mx:18151/health/ready',
    'http://insight.internal.mx:18151/internal/v1/admin/dashboard'
  ]);
  assert.equal(requests[0].headers.has('x-mx-insight-admin-token'), false);
  assert.equal(requests[1].headers.get('x-mx-insight-admin-token'), 'hub-admin-secret');
});

test('fails closed without an admin token and does not contact the hub', async () => {
  let fetchCount = 0;
  const overview = await fetchInsightHubOverview({
    adminUrl: 'http://insight.internal.mx:18151',
    adminToken: '',
    fetchImplementation: async () => {
      fetchCount += 1;
      return Response.json({});
    }
  });

  assert.equal(fetchCount, 0);
  assert.equal(overview.status, 'offline');
  assert.match(overview.message, /ADMIN_TOKEN/);
});

test('returns an offline summary instead of throwing when the hub is unavailable', async () => {
  const overview = await fetchInsightHubOverview({
    adminUrl: 'http://insight.internal.mx:18151',
    adminToken: 'hub-admin-secret',
    fetchImplementation: async () => {
      throw new Error('connection refused');
    }
  });

  assert.equal(overview.status, 'offline');
  assert.equal(overview.ready.ok, false);
  assert.equal(overview.dashboard.ok, false);
  assert.match(overview.message, /connection refused/);
});

test('overview controller requires the launcher ops token before calling the hub', async (context) => {
  const previous = process.env.MX_INTERNAL_OPS_TOKEN;
  process.env.MX_INTERNAL_OPS_TOKEN = 'launcher-ops-secret';
  context.after(() => {
    if (previous === undefined) delete process.env.MX_INTERNAL_OPS_TOKEN;
    else process.env.MX_INTERNAL_OPS_TOKEN = previous;
  });
  let calls = 0;
  const client = {
    overview: async () => {
      calls += 1;
      return { status: 'online' };
    }
  } as unknown as InsightHubClient;
  const controller = new InsightHubController(client);

  await assert.rejects(controller.overview(undefined), /valid Internal ops token/);
  assert.equal(calls, 0);
  assert.deepEqual(await controller.overview('launcher-ops-secret'), {
    insightHub: { status: 'online' }
  });
  assert.equal(calls, 1);
});

test('AppCenter exposes only a configured safe admin entrypoint', (context) => {
  const previous = process.env.MX_INSIGHT_HUB_ADMIN_ENTRYPOINT;
  context.after(() => {
    if (previous === undefined) delete process.env.MX_INSIGHT_HUB_ADMIN_ENTRYPOINT;
    else process.env.MX_INSIGHT_HUB_ADMIN_ENTRYPOINT = previous;
  });

  process.env.MX_INSIGHT_HUB_ADMIN_ENTRYPOINT = 'javascript:alert(1)';
  assert.deepEqual(
    builtinAppCenterApps().find((app) => app.appId === MX_INSIGHT_HUB_APP_ID)?.entrypoints,
    {}
  );

  process.env.MX_INSIGHT_HUB_ADMIN_ENTRYPOINT = 'http://insight.mxinfo-inc.cn';
  assert.deepEqual(
    builtinAppCenterApps().find((app) => app.appId === MX_INSIGHT_HUB_APP_ID)?.entrypoints,
    { admin: 'http://insight.mxinfo-inc.cn/' }
  );
});
