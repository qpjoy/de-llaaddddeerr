import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(scriptDir, '..');
const baseUrl = (process.argv.slice(2).find((arg) => arg !== '--') || process.env.MX_INTERNAL_BASE_URL || 'http://127.0.0.1:18090').replace(/\/+$/, '');
const startedAt = new Date().toISOString();
const runStamp = startedAt.replace(/[:.]/g, '-');
const releaseId = process.env.MX_INTERNAL_SHADOW_RELEASE_ID || `rel_internal_shadow_${runStamp}`;
const outputDir = resolve(process.env.MX_INTERNAL_SHADOW_GATE_OUTPUT_DIR || join(serverRoot, 'artifacts', 'internal-shadow-gates'));
const requireK8sFiles = process.env.MX_INTERNAL_SHADOW_GATE_REQUIRE_K8S_FILES === '1';
const requireManualEvidence = process.env.MX_INTERNAL_SHADOW_REQUIRE_MANUAL_EVIDENCE === '1';

mkdirSync(outputDir, { recursive: true });

const recordedSteps = [];
let run = null;
let gate = null;
let releasePlan = null;

try {
  run = (await fetchJson('/internal/v1/test/runs', {
    method: 'POST',
    body: {
      suiteId: 'internal-shadow-gate',
      releaseId,
      productId: 'mx-launcher',
      topology: 'h-d-i-o-shadow',
      sites: ['internal-main', 'domestic-main', 'oversea-main']
    }
  })).run;

  await recordFileEvidenceStep({
    caseId: 'internal-shadow:k8s-rollout',
    message: 'K8s rollout and workload snapshot',
    filePath: process.env.MX_INTERNAL_SHADOW_GATE_K8S_STATUS_FILE,
    required: requireK8sFiles
  });
  await recordFileEvidenceStep({
    caseId: 'internal-shadow:db-summary',
    message: 'PostgreSQL shadow record summary',
    filePath: process.env.MX_INTERNAL_SHADOW_GATE_DB_SUMMARY_FILE,
    required: requireK8sFiles
  });
  await recordArtifactInventoryStep();
  await recordHttpSmokeStep();
  await recordAdminApiStep();
  await recordManualEvidenceStep();

  gate = (await fetchJson('/internal/v1/test/gates/evaluate', {
    method: 'POST',
    body: {
      gateId: 'gate_internal_shadow',
      releaseId,
      runIds: [run.testRunId]
    }
  })).verdict;
  releasePlan = await recordReleaseManagementPlan();

  const reportPath = writeReport();
  console.log(JSON.stringify({
    ok: gate.verdict === 'passed',
    gate,
    releasePlan,
    testRunId: run.testRunId,
    reportPath,
    baseUrl
  }, null, 2));
  if (gate.verdict !== 'passed') process.exitCode = 1;
} catch (error) {
  const reportPath = writeReport(error);
  console.error(error?.stack || error?.message || String(error));
  console.error(`internal shadow gate report: ${reportPath}`);
  process.exitCode = 1;
}

async function recordHttpSmokeStep() {
  const env = {
    ...process.env,
    MX_SMOKE_BASE_URL: baseUrl
  };
  if (process.env.MX_INTERNAL_SHADOW_GATE_EXPECT_K8S_APPLY === '1' || process.env.MX_SMOKE_EXPECT_K8S_APPLY === '1') {
    env.MX_SMOKE_EXPECT_K8S_APPLY = '1';
  }
  const result = await runCommand({
    command: process.execPath,
    args: [join(scriptDir, 'http-smoke.mjs'), baseUrl],
    cwd: serverRoot,
    env
  });
  const okLines = result.stdout.split('\n').filter((line) => line.startsWith('OK '));
  await recordStep({
    caseId: 'internal-shadow:http-smoke',
    status: result.ok ? 'passed' : 'failed',
    message: result.ok ? `HTTP smoke passed with ${okLines.length} checks` : 'HTTP smoke failed',
    evidence: {
      command: result.command,
      exitCode: result.exitCode,
      okCount: okLines.length,
      okLines,
      stdoutTail: tailText(result.stdout),
      stderrTail: tailText(result.stderr)
    }
  });
}

async function recordAdminApiStep() {
  try {
    const dashboard = await fetchJson('/internal/v1/admin/dashboard');
    const actions = await fetchJson('/internal/v1/admin/actions');
    const pipelines = await fetchJson('/internal/v1/admin/site-slots/pipelines');
    const actionIds = (actions.actionPolicy?.actions || []).map((action) => action.actionId);
    const requiredActionIds = [
      'site-slot.worker-run.artifact-push-dry-run',
      'site-slot.worker-run.artifact-push-remote-ssh-plan',
      'site-slot.worker-run.remote-ssh-readonly-probe',
      'site-slot.worker-run.remote-ssh-execute'
    ];
    const missingActionIds = requiredActionIds.filter((actionId) => !actionIds.includes(actionId));
    const pipelineCount = Array.isArray(pipelines.pipelines) ? pipelines.pipelines.length : 0;
    const overview = dashboard.overview || {};
    const passed = missingActionIds.length === 0
      && Array.isArray(actions.actionPolicy?.actions)
      && Array.isArray(pipelines.pipelines)
      && typeof overview.siteSlotPlans === 'number';
    await recordStep({
      caseId: 'internal-shadow:admin-control-plane',
      status: passed ? 'passed' : 'failed',
      message: passed ? 'Admin dashboard, actions, and site-slot pipelines are renderable' : 'Admin API contract is incomplete',
      evidence: {
        overview: {
          storeDriver: overview.storeDriver,
          siteSlotPlans: overview.siteSlotPlans,
          releaseManagementPlans: overview.releaseManagementPlans,
          testRuns: overview.testRuns
        },
        pipelineCount,
        requiredActionIds,
        missingActionIds
      }
    });
  } catch (error) {
    await recordStep({
      caseId: 'internal-shadow:admin-control-plane',
      status: 'failed',
      message: 'Admin API contract check failed',
      evidence: {
        error: error?.stack || error?.message || String(error)
      }
    });
  }
}

async function recordReleaseManagementPlan() {
  try {
    const response = await fetchJson('/internal/v1/release-management/plans', {
      method: 'POST',
      body: {
        releaseId,
        channel: 'shadow',
        productId: 'mx-launcher',
        appId: 'h2o',
        launcherCurrentVersion: process.env.MX_INTERNAL_SHADOW_LAUNCHER_CURRENT_VERSION || '0.1.0',
        launcherTargetVersion: process.env.MX_INTERNAL_SHADOW_LAUNCHER_TARGET_VERSION || '0.1.1',
        appCurrentVersion: process.env.MX_INTERNAL_SHADOW_APP_CURRENT_VERSION || '0.1.0',
        appTargetVersion: process.env.MX_INTERNAL_SHADOW_APP_TARGET_VERSION || '0.1.1',
        suiteId: 'internal-shadow-gate',
        topology: 'h-d-i-o-shadow',
        sites: ['internal-main', 'domestic-main', 'oversea-main'],
        e2eResult: gate?.verdict || 'blocked',
        createdBy: 'internal-shadow-gate',
        requestId: `internal-shadow-release-gate-${runStamp}`
      }
    });
    await recordStep({
      caseId: 'internal-shadow:release-management-plan',
      status: response.plan?.test?.gate?.verdict === gate?.verdict ? 'passed' : 'failed',
      message: 'Release Center shadow gate evidence was recorded',
      evidence: {
        planId: response.plan?.planId,
        releaseId: response.plan?.releaseId,
        gateVerdict: response.plan?.test?.gate?.verdict,
        decisions: response.plan?.decisions
      }
    });
    return response.plan;
  } catch (error) {
    await recordStep({
      caseId: 'internal-shadow:release-management-plan',
      status: 'failed',
      message: 'Release Center shadow gate evidence failed to record',
      evidence: {
        error: error?.stack || error?.message || String(error)
      }
    });
    return null;
  }
}

async function recordArtifactInventoryStep() {
  const artifactsDir = resolve(process.env.SITE_SLOT_ARTIFACT_BASE_DIR || join(serverRoot, 'artifacts', 'site-slots'));
  const inventory = existsSync(artifactsDir) ? inventoryFiles(artifactsDir) : [];
  const paths = inventory.map((item) => item.path);
  const requiredPaths = [
    'domestic/manifest.json',
    'oversea/manifest.json',
    'domestic/mx-domestic-services.tar.gz',
    'oversea/mx-oversea-services.tar.gz'
  ];
  const missingPaths = requiredPaths.filter((item) => !paths.includes(item));
  await recordStep({
    caseId: 'internal-shadow:artifact-inventory',
    status: missingPaths.length === 0 ? 'passed' : 'failed',
    message: missingPaths.length === 0 ? 'Domestic/Oversea site-slot artifacts are present' : 'Required site-slot artifacts are missing',
    evidence: {
      artifactsDir,
      requiredPaths,
      missingPaths,
      inventory
    }
  });
}

async function recordManualEvidenceStep() {
  const manualStatus = process.env.MX_INTERNAL_SHADOW_MANUAL_STATUS;
  const evidencePath = process.env.MX_INTERNAL_SHADOW_MANUAL_EVIDENCE_PATH;
  if (!manualStatus && !evidencePath && !requireManualEvidence) return;
  const parsedEvidence = evidencePath ? readEvidenceFile(evidencePath) : null;
  const derivedStatus = manualEvidenceStatus(parsedEvidence);
  const status = chooseManualStatus(manualStatus, derivedStatus);
  const evidence = {
    statusSource: manualStatus ? 'env' : 'default',
    evidencePath: evidencePath || null,
    summary: manualEvidenceSummary(parsedEvidence),
    evidence: parsedEvidence,
    notes: process.env.MX_INTERNAL_SHADOW_MANUAL_NOTES || null
  };
  await recordStep({
    caseId: 'internal-shadow:manual-browser-evidence',
    status,
    message: status === 'passed'
      ? 'Manual browser and Evidence Drawer verification attached'
      : 'Manual browser and Evidence Drawer verification is required',
    evidence
  });
}

async function recordFileEvidenceStep({ caseId, message, filePath, required }) {
  if (!filePath && !required) return;
  const resolved = filePath ? resolve(filePath) : null;
  const exists = Boolean(resolved && existsSync(resolved));
  const content = exists ? readFileSync(resolved, 'utf8') : '';
  await recordStep({
    caseId,
    status: exists && content.trim() ? 'passed' : required ? 'blocked' : 'passed',
    message: exists ? message : `${message} was not provided`,
    evidence: {
      filePath: resolved,
      bytes: exists ? Buffer.byteLength(content) : 0,
      sha256: exists ? sha256(Buffer.from(content)) : null,
      preview: content ? tailText(content, 12000) : null
    }
  });
}

async function recordStep(input) {
  const response = await fetchJson(`/internal/v1/test/runs/${encodeURIComponent(run.testRunId)}/steps`, {
    method: 'POST',
    body: input
  });
  run = response.run;
  recordedSteps.push(input);
  return response;
}

async function fetchJson(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method || 'GET',
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Non-JSON response from ${path}: ${text}`);
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${path}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function runCommand({ command, args, cwd, env }) {
  const commandLine = [command, ...args].join(' ');
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd,
      env,
      maxBuffer: 24 * 1024 * 1024
    });
    return {
      ok: true,
      command: commandLine,
      exitCode: 0,
      stdout,
      stderr
    };
  } catch (error) {
    return {
      ok: false,
      command: commandLine,
      exitCode: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout || '',
      stderr: error.stderr || error.message || ''
    };
  }
}

function inventoryFiles(root) {
  const rows = [];
  walk(root, rows);
  return rows
    .sort((a, b) => a.path.localeCompare(b.path))
    .slice(0, 200);
}

function walk(dir, rows) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      walk(path, rows);
      continue;
    }
    const bytes = readFileSync(path);
    rows.push({
      path: relative(resolve(process.env.SITE_SLOT_ARTIFACT_BASE_DIR || join(serverRoot, 'artifacts', 'site-slots')), path),
      bytes: stat.size,
      sha256: sha256(bytes)
    });
  }
}

function readEvidenceFile(path) {
  const content = readFileSync(resolve(path), 'utf8');
  try {
    return JSON.parse(content);
  } catch {
    return {
      raw: content
    };
  }
}

function manualEvidenceStatus(evidence) {
  if (!evidence || typeof evidence !== 'object') return null;
  if (evidence.status === 'failed' || evidence.status === 'blocked' || evidence.status === 'passed') {
    return evidence.status;
  }
  const checklist = Array.isArray(evidence.checklist) ? evidence.checklist : [];
  if (checklist.some((item) => item?.status === 'failed')) return 'failed';
  if (checklist.some((item) => item?.status === 'blocked')) return 'blocked';
  if (checklist.length > 0 && checklist.every((item) => item?.status === 'passed')) return 'passed';
  return null;
}

function chooseManualStatus(manualStatus, derivedStatus) {
  if (manualStatus === 'passed' || manualStatus === 'failed' || manualStatus === 'blocked') return manualStatus;
  if (derivedStatus) return derivedStatus;
  return requireManualEvidence ? 'blocked' : 'passed';
}

function manualEvidenceSummary(evidence) {
  if (!evidence || typeof evidence !== 'object') {
    return {
      checklistItems: 0,
      passed: 0,
      failed: 0,
      blocked: 0,
      screenshots: 0
    };
  }
  const checklist = Array.isArray(evidence.checklist) ? evidence.checklist : [];
  return {
    kind: evidence.kind || null,
    checkedBy: evidence.checkedBy || null,
    createdAt: evidence.createdAt || null,
    checklistItems: checklist.length,
    passed: checklist.filter((item) => item?.status === 'passed').length,
    failed: checklist.filter((item) => item?.status === 'failed').length,
    blocked: checklist.filter((item) => item?.status === 'blocked').length,
    screenshots: Array.isArray(evidence.screenshots) ? evidence.screenshots.length : 0
  };
}

function writeReport(error = null) {
  const report = {
    kind: 'internal-shadow-gate-report',
    baseUrl,
    releaseId,
    startedAt,
    finishedAt: new Date().toISOString(),
    run,
    gate,
    releasePlan,
    recordedSteps,
    error: error ? (error.stack || error.message || String(error)) : null
  };
  const reportPath = join(outputDir, `internal-shadow-gate-${runStamp}.json`);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return reportPath;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function tailText(value, maxLength = 16000) {
  if (!value) return '';
  return value.length > maxLength ? value.slice(value.length - maxLength) : value;
}
