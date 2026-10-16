import { resolve } from 'node:path';

import { expect, test } from '@playwright/test';

import { artifactRoot, recordCaseEvidence } from './evidence.js';
import {
  closeCompass,
  launchCompass,
  writeDiagnostics,
  type LaunchedCompass
} from './helpers.js';

async function captureBootstrapScreenshot(
  instance: LaunchedCompass | null,
  relativePath: string,
  warnings: string[]
): Promise<void> {
  if (!instance) return;
  try {
    await instance.window.screenshot({ path: resolve(artifactRoot(), relativePath), fullPage: true });
  } catch {
    warnings.push('The final renderer screenshot could not be captured.');
  }
}

test('CPS-EL-BOOT-001 packaged Compass cold-starts into a real renderer', async () => {
  const caseId = 'CPS-EL-BOOT-001';
  const screenshotPath = `screenshots/${caseId}-cold-start.png`;
  const tracePath = `traces/${caseId}.zip`;
  const videoPath = `videos/${caseId}.webm`;
  let instance: LaunchedCompass | null = null;
  let diagnosticsPath: string | undefined;
  let warnings: string[] = [];
  try {
    instance = await launchCompass({ videoCaseId: caseId, traceName: caseId });
    await expect(instance.window.locator('body')).toBeVisible();
    expect(['login', 'home']).toContain(instance.rendererSurface);
    expect(instance.runtime.isPackaged).toBe(true);
  } finally {
    await captureBootstrapScreenshot(instance, screenshotPath, warnings);
    warnings.push(...(await closeCompass(instance)));
    if (instance) diagnosticsPath = await writeDiagnostics(instance, caseId);
    await recordCaseEvidence({
      caseId,
      coverageMode: 'automated-renderer',
      diagnosticsPath,
      runtime: instance?.runtime,
      warnings,
      artifacts: [
        { role: 'screenshot', path: screenshotPath, sensitivity: 'internal' },
        { role: 'trace', path: tracePath, sensitivity: 'internal' },
        { role: 'video', path: videoPath, sensitivity: 'internal' },
        { role: 'runtime-metadata', path: 'logs/electron-metadata.json', sensitivity: 'internal' },
        ...(diagnosticsPath
          ? [{ role: 'diagnostics', path: diagnosticsPath, sensitivity: 'internal' as const }]
          : [])
      ]
    });
  }
});

test('CPS-EL-BOOT-002 renderer has no uncaught error after readiness', async () => {
  const caseId = 'CPS-EL-BOOT-002';
  const screenshotPath = `screenshots/${caseId}-renderer.png`;
  const tracePath = `traces/${caseId}.zip`;
  let instance: LaunchedCompass | null = null;
  let diagnosticsPath: string | undefined;
  let warnings: string[] = [];
  try {
    instance = await launchCompass({ traceName: caseId });
    await instance.window.waitForTimeout(3_000);
    expect(
      instance.pageErrors,
      `uncaught renderer errors: ${instance.pageErrors.join(' | ')}`
    ).toEqual([]);
    expect(
      instance.severeConsole,
      `renderer console errors: ${instance.severeConsole.join(' | ')}`
    ).toEqual([]);
  } finally {
    await captureBootstrapScreenshot(instance, screenshotPath, warnings);
    warnings.push(...(await closeCompass(instance)));
    if (instance) diagnosticsPath = await writeDiagnostics(instance, caseId);
    await recordCaseEvidence({
      caseId,
      coverageMode: 'automated-renderer',
      diagnosticsPath,
      runtime: instance?.runtime,
      warnings,
      artifacts: [
        { role: 'screenshot', path: screenshotPath, sensitivity: 'internal' },
        { role: 'trace', path: tracePath, sensitivity: 'internal' },
        { role: 'runtime-metadata', path: 'logs/electron-metadata.json', sensitivity: 'internal' },
        ...(diagnosticsPath
          ? [{ role: 'diagnostics', path: diagnosticsPath, sensitivity: 'internal' as const }]
          : [])
      ]
    });
  }
});
