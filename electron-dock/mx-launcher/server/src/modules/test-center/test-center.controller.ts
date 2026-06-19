import { Body, Controller, Get, Inject, NotFoundException, Param, Post } from '@nestjs/common';

import { asRecord, nullableString, stringArray } from '../../lib/http.js';
import { MX_H2I_PRODUCT_ID } from '../../store/domain.js';
import type { PlatformStore } from '../../store/platform-store.js';
import { PLATFORM_STORE } from '../../tokens.js';

@Controller('internal/v1/test')
export class TestCenterController {
  constructor(@Inject(PLATFORM_STORE) private readonly store: PlatformStore) {}

  @Post('runs')
  async createRun(@Body() rawBody: unknown) {
    const body = asRecord(rawBody);
    return {
      run: await this.store.createTestRun({
        suiteId: nullableString(body.suiteId) ?? 'hdi-shadow-e2e',
        releaseId: nullableString(body.releaseId),
        configSnapshotId: nullableString(body.configSnapshotId),
        installId: nullableString(body.installId),
        deviceId: nullableString(body.deviceId),
        productId: nullableString(body.productId) ?? MX_H2I_PRODUCT_ID,
        topology: nullableString(body.topology) ?? 'h-d-i-shadow',
        sites: stringArray(body.sites)
      })
    };
  }

  @Get('runs/:runId')
  async getRun(@Param('runId') runId: string) {
    const run = await this.store.getTestRun(runId);
    if (!run) throw new NotFoundException('Test run not found');
    return { run };
  }

  @Post('runs/:runId/steps')
  async recordStep(@Param('runId') runId: string, @Body() rawBody: unknown) {
    const body = asRecord(rawBody);
    return {
      run: await this.store.recordTestStep(runId, {
        caseId: nullableString(body.caseId) ?? 'unknown',
        status: nullableString(body.status) ?? 'passed',
        message: nullableString(body.message),
        evidence: asRecord(body.evidence)
      })
    };
  }

  @Post('gates/evaluate')
  async evaluateGate(@Body() rawBody: unknown) {
    const body = asRecord(rawBody);
    return {
      verdict: await this.store.evaluateTestGate({
        gateId: nullableString(body.gateId) ?? 'gate_hdi_shadow_e2e',
        releaseId: nullableString(body.releaseId) ?? 'rel_shadow',
        runIds: stringArray(body.runIds)
      })
    };
  }
}
