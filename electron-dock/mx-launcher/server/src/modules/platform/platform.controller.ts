import { Body, Controller, Get, Inject, Post, ServiceUnavailableException } from '@nestjs/common';

import { asRecord, numberRecord, stringArray, stringValue } from '../../lib/http.js';
import { ReadinessGate } from '../../lib/readiness-gate.js';
import type { PlatformStore } from '../../store/platform-store.js';
import { PLATFORM_STORE, RUNTIME_CONFIG } from '../../tokens.js';
import type { RuntimeConfig, SiteRole } from '../../types.js';

@Controller()
export class PlatformController {
  // The kubelet readiness probe allows 3 seconds; answer well inside it.
  private readonly readiness = new ReadinessGate(() => this.store.ready(), { waitMs: 1000, graceMs: 60_000 });

  constructor(
    @Inject(PLATFORM_STORE) private readonly store: PlatformStore,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig
  ) {}

  @Get('healthz')
  healthz() {
    return { ok: true, service: 'mx-launcher-server', framework: 'nestjs', ts: new Date().toISOString() };
  }

  @Get('readyz')
  async readyz() {
    const { ready, degraded } = await this.readiness.state();
    if (!ready) throw new ServiceUnavailableException('Platform store is unavailable');
    return {
      ok: true,
      ...(degraded ? { degraded: true } : {}),
      environment: this.config.environment,
      siteId: this.config.siteId,
      siteRole: this.config.siteRole,
      enabledModules: this.config.enabledModules,
      storeDriver: this.config.storeDriver,
      publicBaseUrl: this.config.publicBaseUrl,
      internalBaseUrl: this.config.internalBaseUrl
    };
  }

  @Get('internal/v1/platform/overview')
  async overview() {
    return this.store.overview();
  }

  @Get('internal/v1/platform-kernel/smoke')
  async platformKernelSmoke() {
    return this.store.runPlatformKernelSmoke();
  }

  @Get('internal/v1/sites')
  async sites() {
    return { sites: await this.store.listSites() };
  }

  @Post('internal/v1/sites/heartbeat')
  async heartbeat(@Body() rawBody: unknown) {
    const body = asRecord(rawBody);
    const heartbeat = await this.store.upsertSiteHeartbeat({
      siteId: stringValue(body.siteId, this.config.siteId),
      siteRole: siteRole(body.siteRole, this.config.siteRole),
      kind: siteKind(body.kind),
      version: stringValue(body.version, 'unknown'),
      capabilities: stringArray(body.capabilities),
      metrics: numberRecord(body.metrics)
    });
    return { heartbeat };
  }
}

function siteKind(value: unknown) {
  const raw = typeof value === 'string' ? value : 'unknown';
  if (raw === 'internal' || raw === 'domestic-edge' || raw === 'oversea-access' || raw === 'h-endpoint') {
    return raw;
  }
  return 'unknown';
}

function siteRole(value: unknown, fallback: SiteRole): SiteRole {
  const raw = typeof value === 'string' ? value : fallback;
  if (raw === 'internal' || raw === 'domestic' || raw === 'oversea' || raw === 'h-endpoint-dev') {
    return raw;
  }
  return fallback;
}
