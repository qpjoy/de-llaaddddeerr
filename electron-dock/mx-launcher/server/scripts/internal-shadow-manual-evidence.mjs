import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(scriptDir, '..');
const status = process.argv[2] || process.env.MX_INTERNAL_SHADOW_MANUAL_STATUS || 'passed';
const notes = process.argv.slice(3).join(' ') || process.env.MX_INTERNAL_SHADOW_MANUAL_NOTES || null;
const validStatuses = new Set(['passed', 'failed', 'blocked']);

if (!validStatuses.has(status)) {
  console.error('Usage: node scripts/internal-shadow-manual-evidence.mjs [passed|failed|blocked] [notes]');
  process.exit(1);
}

const now = new Date().toISOString();
const stamp = now.replace(/[:.]/g, '-');
const outputPath = resolve(
  process.env.MX_INTERNAL_SHADOW_MANUAL_EVIDENCE_OUTPUT
    || join(serverRoot, 'artifacts', 'internal-shadow-gates', 'manual', `manual-browser-evidence-${stamp}.json`)
);
const screenshotPaths = csv(process.env.MX_INTERNAL_SHADOW_SCREENSHOTS);
const checkedBy = process.env.MX_INTERNAL_SHADOW_CHECKED_BY || process.env.USER || 'manual-operator';
const browserUrl = process.env.MX_INTERNAL_SHADOW_BROWSER_URL || 'http://127.0.0.1:18110/index.html';
const internalBaseUrl = process.env.MX_INTERNAL_BASE_URL || 'http://127.0.0.1:18090';

const evidence = {
  kind: 'internal-shadow-manual-browser-evidence',
  version: 1,
  status,
  checkedBy,
  createdAt: now,
  browserUrl,
  internalBaseUrl,
  notes,
  context: {
    selectedPlanId: process.env.MX_INTERNAL_SHADOW_SELECTED_PLAN_ID || null,
    selectedTimelineEntryId: process.env.MX_INTERNAL_SHADOW_SELECTED_TIMELINE_ENTRY_ID || null,
    testRunId: process.env.MX_INTERNAL_SHADOW_TEST_RUN_ID || null
  },
  checklist: checklistItems().map((item) => ({
    ...item,
    status
  })),
  screenshots: screenshotPaths.map((path) => {
    const resolved = resolve(path);
    return {
      path: resolved,
      exists: existsSync(resolved),
      bytes: existsSync(resolved) ? statSync(resolved).size : 0
    };
  })
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);

console.log(JSON.stringify({
  ok: true,
  status,
  evidencePath: outputPath,
  checklistItems: evidence.checklist.length,
  screenshots: evidence.screenshots
}, null, 2));

function checklistItems() {
  return [
    {
      id: 'server-url',
      label: 'Server URL is http://127.0.0.1:18090'
    },
    {
      id: 'app-center-hdi',
      label: 'App Center loads HDI without console errors'
    },
    {
      id: 'admin-refresh',
      label: 'Admin view refreshes successfully'
    },
    {
      id: 'admin-dashboard',
      label: 'Dashboard metrics, topology, action list, and site-slot pipelines render'
    },
    {
      id: 'ssh-profile-plan',
      label: 'SSH Profile can be reused to create a site-slot plan'
    },
    {
      id: 'pipeline-actions',
      label: 'Preflight, Apply, Runner, Worker Job, and plan-only/dry-run worker actions run'
    },
    {
      id: 'evidence-drawer',
      label: 'Evidence Drawer shows execution, runner, worker job, and report details'
    }
  ];
}

function csv(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}
