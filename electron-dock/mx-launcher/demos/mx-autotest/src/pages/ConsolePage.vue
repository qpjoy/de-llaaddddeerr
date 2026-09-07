<template>
  <main class="autotest-shell">
    <header class="topbar">
      <div class="brand">
        <div class="brand-mark">MX</div>
        <div>
          <p class="eyebrow">QUALITY OPERATIONS</p>
          <h1>AutoTest Console</h1>
        </div>
      </div>
      <div class="status-pill" :class="`status-pill--${statusTone}`">
        <span class="status-dot" />
        {{ runtime?.connection.status || 'loading' }}
      </div>
    </header>

    <section class="hero-grid">
      <article class="qp-card surface-card connection-card">
        <div class="section-heading">
          <div>
            <p class="eyebrow">STANDALONE CHANNEL</p>
            <h2>Internal connection</h2>
          </div>
          <q-icon name="hub" size="28px" />
        </div>
        <p class="message">{{ runtime?.connection.message || 'Reading desktop runtime…' }}</p>
        <dl class="facts">
          <div><dt>Product</dt><dd>{{ runtime?.appId || 'mx-autotest' }}</dd></div>
          <div><dt>Lease IP</dt><dd>{{ runtime?.connection.leaseIp || '—' }}</dd></div>
          <div><dt>Service VIP</dt><dd>{{ runtime?.connection.serviceVip || '—' }}</dd></div>
          <div><dt>Route claims</dt><dd>{{ runtime?.connection.routeCidrs.join(', ') || 'none' }}</dd></div>
        </dl>
        <div class="actions">
          <q-btn
            color="primary"
            unelevated
            label="Connect Internal"
            :loading="busy === 'connect'"
            :disable="isBusy"
            @click="connectInternal"
          />
          <q-btn
            outline
            color="grey-5"
            label="Disconnect"
            :loading="busy === 'disconnect'"
            :disable="isBusy || runtime?.connection.status === 'idle'"
            @click="disconnect"
          />
        </div>
        <p class="guardrail">Route-only · no DNS/PAC ownership · product-scoped cleanup</p>
      </article>

      <article class="qp-card surface-card login-card">
        <div class="section-heading">
          <div>
            <p class="eyebrow">USER CENTER</p>
            <h2>{{ runtime?.identity.kind === 'user' ? runtime.identity.displayName : 'Sign in after connect' }}</h2>
          </div>
          <q-icon name="verified_user" size="28px" />
        </div>
        <template v-if="runtime?.identity.kind !== 'user'">
          <q-input v-model="account" dark outlined dense label="Account" autocomplete="username" />
          <q-input
            v-model="password"
            dark
            outlined
            dense
            type="password"
            label="Password"
            autocomplete="current-password"
            @keyup.enter="login"
          />
          <q-btn
            color="primary"
            unelevated
            label="Sign in through own VIP"
            :loading="busy === 'login'"
            :disable="isBusy || runtime?.connection.status !== 'network-ready'"
            @click="login"
          />
        </template>
        <template v-else>
          <dl class="facts identity-facts">
            <div><dt>User</dt><dd>{{ runtime.identity.userId }}</dd></div>
            <div><dt>Scopes</dt><dd>{{ runtime.identity.scopes.join(', ') }}</dd></div>
            <div><dt>Token in renderer</dt><dd>never exposed</dd></div>
          </dl>
          <q-btn
            outline
            color="grey-5"
            label="Log out and disconnect"
            :loading="busy === 'logout'"
            :disable="isBusy"
            @click="logout"
          />
        </template>
      </article>
    </section>

    <section class="workspace-grid">
      <article class="qp-card surface-card run-card">
        <div class="section-heading">
          <div>
            <p class="eyebrow">TEST OPERATIONS</p>
            <h2>Choose a plan and run it</h2>
          </div>
          <q-icon name="play_circle" size="28px" />
        </div>

        <div class="platform-metrics">
          <div>
            <span>Your role</span>
            <strong>{{ memberRoleLabel }}</strong>
          </div>
          <div>
            <span>Test plans</span>
            <strong>{{ platformSnapshot?.tasks.length ?? '—' }}</strong>
          </div>
          <div>
            <span>Runners online</span>
            <strong>{{ runnerSummary }}</strong>
          </div>
        </div>

        <div v-if="platformReady && memberRole === 'viewer'" class="permission-note">
          <q-icon name="visibility" size="18px" />
          <span>You can inspect quality results. Ask an MX AutoTest admin to promote you to <b>operator</b> before running a plan.</span>
        </div>

        <div class="form-grid">
          <q-select
            v-model="taskId"
            dark
            outlined
            dense
            emit-value
            map-options
            :options="taskOptions"
            label="Test plan"
            :disable="!platformReady || isBusy"
            :hint="selectedTaskHint"
          />
          <q-input v-model="caseFilter" dark outlined dense label="Optional case filter" />
        </div>
        <div class="actions">
          <q-btn
            color="primary"
            unelevated
            label="Run task"
            :loading="busy === 'run'"
            :disable="!canRun || !taskId || isBusy"
            @click="dispatchTask"
          />
          <q-btn
            flat
            color="grey-5"
            label="Refresh platform"
            :loading="busy === 'snapshot'"
            :disable="!platformReady || isBusy"
            @click="refreshPlatform"
          />
        </div>
        <p class="operation-message">{{ resultMessage }}</p>
        <details v-if="resultText" class="response-details">
          <summary>Technical response</summary>
          <pre class="result-view">{{ resultText }}</pre>
        </details>
      </article>

      <article class="qp-card surface-card evidence-card">
        <div class="section-heading">
          <div>
            <p class="eyebrow">QUALITY SIGNALS</p>
            <h2>Recent runs</h2>
          </div>
          <q-icon name="fact_check" size="28px" />
        </div>
        <ol class="run-list">
          <li v-for="run in recentRuns" :key="stringField(run, 'id')">
            <div>
              <strong>{{ taskName(stringField(run, 'taskId')) }}</strong>
              <span>{{ formatTime(stringField(run, 'queuedAt')) }}</span>
            </div>
            <span class="run-status" :class="`run-status--${statusClass(stringField(run, 'status'))}`">
              {{ stringField(run, 'status') || 'unknown' }}
            </span>
          </li>
          <li v-if="!recentRuns.length" class="empty-run">No test runs yet.</li>
        </ol>

        <div class="subsection-heading">
          <p class="eyebrow">DESKTOP DIAGNOSTICS</p>
          <h3>Local lifecycle</h3>
        </div>
        <ol class="event-list">
          <li v-for="event in runtime?.events || []" :key="event">{{ event }}</li>
          <li v-if="!runtime?.events.length" class="empty-event">No events yet.</li>
        </ol>
      </article>
    </section>
  </main>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useQuasar } from 'quasar';

import type { MxAutotestPlatformSnapshot, MxAutotestRuntimeState } from 'src/types/autotest';

type PlatformRole = 'viewer' | 'operator' | 'admin' | null;

interface PlatformView {
  member: Record<string, unknown> | null;
  apps: Array<Record<string, unknown>>;
  tasks: Array<Record<string, unknown>>;
  runs: Array<Record<string, unknown>>;
  runners: Array<Record<string, unknown>>;
  raw: MxAutotestPlatformSnapshot;
}

const $q = useQuasar();
const runtime = ref<MxAutotestRuntimeState | null>(null);
const platformSnapshot = ref<PlatformView | null>(null);
const busy = ref<'connect' | 'disconnect' | 'login' | 'logout' | 'snapshot' | 'run' | null>(null);
const account = ref('');
const password = ref('');
const taskId = ref('');
const caseFilter = ref('');
const resultMessage = ref('Connect and sign in to load the quality workspace.');
const resultText = ref('');
let unsubscribe: (() => void) | null = null;

const api = computed(() => window.mxAutotest);
const isBusy = computed(() => busy.value !== null);
const platformReady = computed(() => Boolean(
  runtime.value?.platform.configured
  && runtime.value.connection.status === 'network-ready'
  && runtime.value.identity.kind === 'user'
));
const memberRole = computed<PlatformRole>(() => {
  const role = stringField(platformSnapshot.value?.member, 'role');
  return role === 'viewer' || role === 'operator' || role === 'admin' ? role : null;
});
const memberRoleLabel = computed(() => memberRole.value ?? (platformReady.value ? 'loading' : 'sign in'));
const canRun = computed(() => platformReady.value && (memberRole.value === 'operator' || memberRole.value === 'admin'));
const taskOptions = computed(() => (platformSnapshot.value?.tasks ?? []).map((task) => ({
  label: `${stringField(task, 'name') || stringField(task, 'id')} · ${stringField(task, 'profile') || 'default'} / ${stringField(task, 'track') || 'functional'}`,
  value: stringField(task, 'id'),
  disable: task.enabled === false
})).filter((option) => Boolean(option.value)));
const selectedTask = computed(() => platformSnapshot.value?.tasks.find((task) => stringField(task, 'id') === taskId.value));
const selectedTaskHint = computed(() => {
  if (!platformReady.value) return 'Connect and sign in first';
  if (!taskOptions.value.length) return 'No plans are configured yet';
  const task = selectedTask.value;
  if (!task) return 'Select a plan';
  return `${stringField(task, 'runsOn') || 'any runner'} · ${stringField(task, 'scheduleKind') || 'manual'}`;
});
const onlineRunnerCount = computed(() => (platformSnapshot.value?.runners ?? []).filter((runner) => runner.online === true).length);
const runnerSummary = computed(() => platformSnapshot.value
  ? `${onlineRunnerCount.value}/${platformSnapshot.value.runners.length}`
  : '—');
const recentRuns = computed(() => (platformSnapshot.value?.runs ?? []).slice(0, 6));
const statusTone = computed(() => {
  const status = runtime.value?.connection.status;
  if (status === 'network-ready') return 'ok';
  if (status === 'error') return 'error';
  if (status === 'idle') return 'idle';
  return 'pending';
});

onMounted(async () => {
  if (!api.value) {
    notifyError('MX AutoTest desktop bridge is unavailable.');
    return;
  }
  runtime.value = await api.value.getRuntime();
  unsubscribe = api.value.onRuntime((next) => {
    runtime.value = next;
    if (next.identity.kind !== 'user') platformSnapshot.value = null;
  });
  if (platformReady.value) {
    try {
      await loadPlatformSnapshot();
    } catch (error) {
      notifyError(error instanceof Error ? error.message : String(error));
    }
  }
});

onBeforeUnmount(() => unsubscribe?.());

async function connectInternal() {
  await runAction('connect', async () => {
    runtime.value = await requireApi().connectInternal();
    if (platformReady.value) await loadPlatformSnapshot();
  });
}

async function disconnect() {
  await runAction('disconnect', async () => {
    runtime.value = await requireApi().disconnect();
  });
}

async function login() {
  const submittedPassword = password.value;
  password.value = '';
  await runAction('login', async () => {
    runtime.value = await requireApi().login({ account: account.value, password: submittedPassword });
    await loadPlatformSnapshot();
  });
}

async function logout() {
  await runAction('logout', async () => {
    runtime.value = await requireApi().logout();
    platformSnapshot.value = null;
    resultMessage.value = 'Signed out. Local credentials and the product-scoped network lease were released.';
    resultText.value = '';
  });
}

async function refreshPlatform() {
  await runAction('snapshot', async () => {
    await loadPlatformSnapshot();
  });
}

async function dispatchTask() {
  await runAction('run', async () => {
    const response = await requireApi().runTask({
      taskId: taskId.value,
      ...(caseFilter.value.trim() ? { caseFilter: caseFilter.value.trim() } : {})
    });
    resultText.value = pretty(response);
    const run = recordField(response, 'run');
    const runId = stringField(run, 'id');
    resultMessage.value = runId
      ? `Run ${runId} is queued. A compatible online runner will claim it.`
      : 'The test plan was accepted by MX AutoTest.';
    $q.notify({ type: 'positive', message: resultMessage.value, timeout: 5_000 });
    await loadPlatformSnapshot({ preserveResult: true });
  });
}

async function loadPlatformSnapshot(options: { preserveResult?: boolean } = {}) {
  const raw = await requireApi().getPlatformSnapshot();
  platformSnapshot.value = normalizePlatformSnapshot(raw);
  if (!taskOptions.value.some((option) => option.value === taskId.value && !option.disable)) {
    taskId.value = taskOptions.value.find((option) => !option.disable)?.value ?? '';
  }
  if (!options.preserveResult) {
    resultMessage.value = platformSnapshot.value.tasks.length
      ? `${platformSnapshot.value.tasks.length} test plan(s) ready; ${onlineRunnerCount.value} runner(s) online.`
      : 'The workspace is connected, but no test plans are configured yet.';
    resultText.value = pretty(raw);
  }
}

async function runAction(kind: NonNullable<typeof busy.value>, action: () => Promise<void>) {
  if (busy.value) return;
  busy.value = kind;
  try {
    await action();
  } catch (error) {
    notifyError(error instanceof Error ? error.message : String(error));
  } finally {
    busy.value = null;
  }
}

function requireApi() {
  if (!api.value) throw new Error('Desktop bridge is unavailable');
  return api.value;
}

function notifyError(message: string) {
  $q.notify({ type: 'negative', message, timeout: 5_000 });
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function normalizePlatformSnapshot(raw: MxAutotestPlatformSnapshot): PlatformView {
  return {
    member: recordField(raw.me, 'member'),
    apps: recordArray(raw.apps, 'apps'),
    tasks: recordArray(raw.tasks, 'tasks'),
    runs: recordArray(raw.runs, 'runs'),
    runners: recordArray(raw.runners, 'runners'),
    raw
  };
}

function recordArray(value: unknown, key: string): Array<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const candidate = (value as Record<string, unknown>)[key];
  const list = Array.isArray(candidate) ? candidate : [];
  return list.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry));
}

function recordField(value: unknown, key: string): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const field = (value as Record<string, unknown>)[key];
  return field && typeof field === 'object' && !Array.isArray(field) ? field as Record<string, unknown> : null;
}

function stringField(value: unknown, key: string): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' ? field : '';
}

function taskName(id: string): string {
  const task = platformSnapshot.value?.tasks.find((entry) => stringField(entry, 'id') === id);
  return task ? stringField(task, 'name') || id : id || 'Ad-hoc run';
}

function formatTime(value: string): string {
  if (!value) return 'time unavailable';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function statusClass(value: string): string {
  if (['passed', 'succeeded'].includes(value)) return 'passed';
  if (['failed', 'error', 'timeout', 'expired'].includes(value)) return 'failed';
  if (['running'].includes(value)) return 'running';
  if (['blocked', 'pending-runner'].includes(value)) return 'blocked';
  return 'queued';
}
</script>
