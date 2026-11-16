import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = join(dirname(fileURLToPath(import.meta.url)), 'k8s-oversea-recover.sh');
const runbook = join(dirname(fileURLToPath(import.meta.url)), '../docs/63-oversea-service-recovery.md');
const SITE = 'mx-oversea-us01';
const HOST = '34.218.136.162';
const SECRET = 'fixture-secret-must-not-be-printed';

function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mx-oversea-recovery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const configPath = join(root, 'config.json');
  const logPath = join(root, 'http.jsonl');
  const kubectlLog = join(root, 'kubectl.jsonl');
  const accountNames = [SITE + '-internal', SITE + '-domestic', SITE + '-subscriptions',
    ...Array.from({ length: 9 }, (_, i) => SITE + '-internal' + String(i + 1).padStart(2, '0'))];
  const config = {
    profile: { profileId: 'sshprof_' + SITE, siteId: SITE, kind: 'oversea', status: 'active', host: HOST, sshUser: 'root', sshPort: 22, strictHostKeyChecking: 'yes', batchMode: 'yes', serverPorts: '51288', exportPort: 3434, secret: SECRET },
    site: { siteId: SITE, status: 'active', publicHost: HOST, serverPorts: '51288', secret: SECRET },
    accounts: accountNames.map((username, index) => ({ username, status: 'active', authToken: 'account-secret-' + index })),
    terminal: { status: 'passed', exitCode: 0, stdout: 'MX_RECOVERY_USER=root\nMX_RECOVERY_HOSTNAME=replacement\nMX_RECOVERY_DOCKER=missing\nMX_RECOVERY_COMPOSE=missing\nMX_RECOVERY_RSYNC=ready\nMX_RECOVERY_STACK=missing\nMX_RECOVERY_TLS_CERT=missing\nMX_RECOVERY_TLS_KEY=missing\nMX_RECOVERY_HEALTH_HTTP=000\nMX_RECOVERY_COMPLETE=1\n' + SECRET, stderr: SECRET },
    terminalFinal: { status: 'passed', exitCode: 0, stdout: 'MX_RECOVERY_DOCKER=ready\nMX_RECOVERY_COMPOSE=ready\nMX_RECOVERY_RSYNC=ready\nMX_RECOVERY_STACK=present\nMX_RECOVERY_TLS_CERT=present\nMX_RECOVERY_TLS_KEY=present\nMX_RECOVERY_HEALTH_HTTP=200\nMX_RECOVERY_COMPLETE=1\n' },
    rsyncInstall: { status: 'passed', exitCode: 0, stdout: 'MX_RECOVERY_RSYNC=ready\nMX_RECOVERY_COMPLETE=1\n' },
    ensure: { status: 'installed', planId: 'plan_1', jobId: 'job_1', reportId: 'report_1',
      steps: [{ stepId: 'remote-worker-run', status: 'passed', objectId: 'report_1', command: SECRET }],
      workerRun: { stdout: SECRET }, blockedReasons: [] },
    ...overrides
  };
  writeFileSync(configPath, JSON.stringify(config));
  const fakeKubectl = join(bin, 'kubectl');
  writeFileSync(fakeKubectl, [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '[[ "$1" == -n && "$3" == exec && "$4" == -i && "$5" == deployment/mx-launcher-internal && "$6" == -c && "$7" == internal-api && "$8" == -- ]] || exit 98',
    'printf "%s\\n" "$*" >> "$RECOVERY_KUBECTL_LOG"',
    'while [[ "$1" != -- ]]; do shift; done',
    'shift',
    'exec "$@"'
  ].join('\n'));
  chmodSync(fakeKubectl, 0o755);
  const mock = join(root, 'mock-http.mjs');
  writeFileSync(mock, [
    "import http from 'node:http';",
    "import childProcess from 'node:child_process';",
    "import { syncBuiltinESMExports } from 'node:module';",
    "import { EventEmitter } from 'node:events';",
    "import { appendFileSync, readFileSync } from 'node:fs';",
    "const config = JSON.parse(readFileSync(process.env.RECOVERY_TEST_CONFIG, 'utf8'));",
    "let terminalCalls = 0;",
    "let accountReads = 0, profileReads = 0, planReads = 0, freshPlan;",
    "childProcess.execFile = (file, args, options, callback) => {",
    "  if (file !== 'ssh' || args[0] !== '-G' || args[1] !== '-F' || args[3] !== '-p') throw new Error('Unexpected executable');",
    "  const hostname = config.sshHostname ?? args.at(-1).split('@').at(-1);",
    "  queueMicrotask(() => callback(null, 'hostname ' + hostname + '\\nproxycommand ' + config.profile.secret + '\\n', ''));",
    "  return new EventEmitter();",
    "};",
    "http.request = (url, options, callback) => {",
    "  url = new URL(url);",
    "  if (url.origin !== 'http://127.0.0.1:18090') throw new Error('Unexpected origin');",
    "  if (options.headers['x-mx-ops-token'] !== process.env.MX_INTERNAL_OPS_TOKEN) throw new Error('Ops token missing');",
    "  const req = new EventEmitter();",
    "  req.setTimeout = (ms, fn) => { req.timeoutMs = ms; req.timeoutFn = fn; return req; };",
    "  req.destroy = error => { queueMicrotask(() => req.emit('error', error)); return req; };",
    "  req.end = data => {",
    "    const body = data ? JSON.parse(data) : null;",
    "    appendFileSync(process.env.RECOVERY_TEST_LOG, JSON.stringify({ path: url.pathname, method: options.method, timeoutMs: req.timeoutMs, body }) + '\\n');",
    "    queueMicrotask(() => {",
    "      let kind;",
    "      if (url.pathname.includes('/site-slot-ssh-profiles/site/')) kind = 'profile';",
    "      else if (url.pathname.includes('/mihomo/sites/')) kind = 'site';",
    "      else if (url.pathname.endsWith('/access-accounts')) kind = 'accounts';",
    "      else if (url.pathname.endsWith('/site-slots/plans')) kind = body ? 'createPlan' : 'plans';",
    "      else if (url.pathname.endsWith('/terminal')) kind = body.command.includes('apt-get install -y rsync') ? 'rsyncInstall' : 'terminal';",
    "      else if (url.pathname.endsWith('/ensure')) kind = 'ensure';",
    "      else throw new Error('Unexpected endpoint');",
    "      if (config.timeoutAt === kind) { req.timeoutFn(); return; }",
    "      const res = new EventEmitter();",
    "      res.statusCode = config.httpFailAt === kind ? 403 : 200;",
    "      callback(res);",
    "      if (kind === 'terminal') terminalCalls += 1;",
    "      if (kind === 'accounts') accountReads += 1;",
    "      if (kind === 'profile') profileReads += 1;",
    "      let value = kind === 'terminal' && terminalCalls > 1 ? config.terminalFinal : config[kind];",
    "      if (kind === 'accounts' && accountReads > 1 && config.accountsAfter) value = config.accountsAfter;",
    "      if (kind === 'accounts' && accountReads > 2 && config.accountsBeforeEnsure) value = config.accountsBeforeEnsure;",
    "      if (kind === 'profile' && profileReads > 1 && config.profileAfter) value = config.profileAfter;",
    "      if (kind === 'createPlan') {",
    "        const state = { node: { publicHost: body.host }, accounts: (config.planAccounts ?? config.accounts).filter(a => a.status === 'active') };",
    "        freshPlan = { planId: 'plan_1', createdAt: '2026-11-16T10:00:00Z', kind: 'oversea', siteId: body.siteId, host: config.planHost ?? body.host, ssh: { profileId: body.sshProfileId, user: body.sshUser, port: body.sshPort }, status: 'ready', runtime: { oversea: { workerInternalBaseUrl: body.workerInternalBaseUrl, overseaCallbackBaseUrl: body.overseaCallbackBaseUrl, serverPorts: body.serverPorts, exportPort: body.exportPort } }, deploymentPhases: [{ phaseId: 'configure-oversea-access', commands: ['printf \"%s\" ' + Buffer.from(JSON.stringify(state)).toString('base64') + ' | base64 -d > /opt/mx/site-agent/.tunnel-state.json.tmp'] }] };",
    "        value = freshPlan;",
    "      }",
    "      if (kind === 'plans') { planReads += 1; value = planReads > 1 && config.plansBeforeEnsure ? config.plansBeforeEnsure : config.plans ?? [freshPlan]; }",
    "      const payload = res.statusCode === 200 ? { [kind === 'createPlan' ? 'plan' : kind === 'rsyncInstall' ? 'terminal' : kind]: value, oversea: { token: config.profile.secret } } : { message: config.profile.secret };",
    "      res.emit('data', Buffer.from(JSON.stringify(payload)));",
    "      res.emit('end');",
    "    });",
    "  };",
    "  return req;",
    "};",
    "syncBuiltinESMExports();"
  ].join('\n'));
  const env = {
    ...process.env, PATH: bin + ':' + process.env.PATH,
    NODE_OPTIONS: '--import=' + mock,
    MX_INTERNAL_OPS_TOKEN: SECRET, RECOVERY_TEST_CONFIG: configPath,
    RECOVERY_TEST_LOG: logPath, RECOVERY_KUBECTL_LOG: kubectlLog
  };
  return {
    config,
    run(args = [], extraEnv = {}) {
      writeFileSync(configPath, JSON.stringify(config));
      return spawnSync('bash', [script, ...args], { encoding: 'utf8', env: { ...env, ...extraEnv } });
    },
    runProgram(program) {
      writeFileSync(configPath, JSON.stringify(config));
      return spawnSync('node', ['--input-type=module', '-', 'apply', SITE, HOST], { encoding: 'utf8', env, input: program });
    },
    requests() { return existsSync(logPath) ? readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []; },
    kubectlArgs() { return existsSync(kubectlLog) ? readFileSync(kubectlLog, 'utf8') : ''; }
  };
}

function noSecrets(result) { assert.doesNotMatch(result.stdout + result.stderr, new RegExp(SECRET + '|account-secret-')); }

test('default inspect uses saved targets and fixed read-only terminal without ensure or credential output', t => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"docker": "missing"/);
  assert.deepEqual(f.requests().map(r => r.method), ['GET', 'GET', 'POST']);
  const terminal = f.requests().at(-1);
  assert.ok(terminal.path.endsWith('/' + SITE + '/terminal'));
  assert.equal(terminal.body.confirmRemoteExecution, true);
  assert.equal(terminal.body.confirmManualCommand, true);
  assert.doesNotMatch(terminal.body.command, /fingerprint:|systemctl|mkdir|rm -|apt-get|authorized_keys|cat .*server\.key/);
  assert.match(terminal.body.command, /127\.0\.0\.1:3434\/healthz/);
  assert.doesNotMatch(f.kubectlArgs(), /apply|rollout|set env/);
  noSecrets(result);
});

test('apply uses only legacy ensure after successful inspection and permits Docker-missing recovery', t => {
  const f = fixture(t);
  const result = f.run(['apply', SITE, HOST]);
  assert.equal(result.status, 0, result.stderr);
  const calls = f.requests();
  const ensure = calls.find(call => call.path.endsWith('/ensure'));
  assert.ok(ensure);
  assert.deepEqual(Object.keys(ensure.body).sort(), ['confirmInstall', 'executeRemote', 'force', 'requestId', 'requestedBy']);
  assert.equal(ensure.body.force, true);
  assert.equal(ensure.body.executeRemote, true);
  assert.equal(ensure.body.confirmInstall, true);
  assert.ok(ensure.timeoutMs > 15 * 60_000);
  assert.ok(calls.at(-1).path.endsWith('/terminal'));
  assert.equal(calls.filter(call => call.path.endsWith('/site-slots/plans') && call.method === 'POST').length, 1);
  assert.match(result.stdout, /"reportId": "report_1"/);
  assert.match(result.stdout, /runtime-ready/);
  noSecrets(result);
});

test('expected-host mismatch stops before remote inspection or any ensure', t => {
  const f = fixture(t);
  const result = f.run(['apply', SITE, '34.218.136.163']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not exactly match/);
  assert.equal(f.requests().length, 1);
});

test('paused, Domestic or wrong-site profiles are rejected before remote calls', t => {
  for (const change of [{ status: 'paused' }, { kind: 'domestic' }, { siteId: 'another-site' }]) {
    const f = fixture(t, { profile: { siteId: SITE, status: 'active', kind: 'oversea', host: HOST, ...change } });
    const result = f.run(['apply']);
    assert.notEqual(result.status, 0);
    assert.equal(f.requests().length, 1);
  }
});

test('archived and unregistered sites cannot be implicitly recreated', t => {
  for (const site of [{ siteId: SITE, status: 'archived', publicHost: HOST }, null]) {
    const f = fixture(t, { site });
    const result = f.run(['apply']);
    assert.notEqual(result.status, 0);
    assert.equal(f.requests().length, 2);
  }
});

test('apply refuses address switching before old ensure could publish it', t => {
  const f = fixture(t, { site: { siteId: SITE, status: 'active', publicHost: '203.0.113.11' } });
  const result = f.run(['apply']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /delayed publication/);
  assert.equal(f.requests().length, 2);
});

test('a stale SSH config HostName is blocked before terminal or ensure even when the profile address matches', t => {
  const f = fixture(t, { sshHostname: '203.0.113.99' });
  const result = f.run(['apply']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Effective SSH HostName does not match/);
  assert.equal(f.requests().length, 2);
  noSecrets(result);
});

test('failed SSH inspection never starts ensure and does not print raw terminal output', t => {
  const f = fixture(t, { terminal: { status: 'failed', exitCode: 255, stdout: SECRET, stderr: SECRET, gateFailures: [SECRET] } });
  const result = f.run(['apply']);
  assert.notEqual(result.status, 0);
  assert.equal(f.requests().length, 3);
  noSecrets(result);
});

test('passing terminal without complete evidence cannot start ensure', t => {
  const f = fixture(t, { terminal: { status: 'passed', exitCode: 0, stdout: '' } });
  const result = f.run(['apply']);
  assert.notEqual(result.status, 0);
  assert.equal(f.requests().length, 3);
  assert.match(result.stderr, /did not complete/);
});

test('existing Docker without Compose is blocked instead of implicitly upgrading the engine', t => {
  const f = fixture(t);
  f.config.terminal.stdout = f.config.terminal.stdout.replace('DOCKER=missing', 'DOCKER=ready');
  // fixture configuration is read by the child process.
  const result = f.run(['apply']);
  assert.notEqual(result.status, 0);
  assert.equal(f.requests().length, 3);
  assert.match(result.stderr, /implicit Docker engine upgrade/);
});

test('changed HY2 ports are blocked before remote calls', t => {
  const f = fixture(t, { site: { siteId: SITE, status: 'active', publicHost: HOST, serverPorts: '51289' } });
  const result = f.run(['apply']);
  assert.notEqual(result.status, 0);
  assert.equal(f.requests().length, 2);
  assert.match(result.stderr, /HY2 ports differ/);
});

test('worker success still requires fresh Docker, stack and health evidence', t => {
  const f = fixture(t, { terminalFinal: { status: 'passed', exitCode: 0,
    stdout: 'MX_RECOVERY_DOCKER=ready\nMX_RECOVERY_COMPOSE=ready\nMX_RECOVERY_RSYNC=ready\nMX_RECOVERY_STACK=present\nMX_RECOVERY_TLS_CERT=present\nMX_RECOVERY_TLS_KEY=present\nMX_RECOVERY_HEALTH_HTTP=503\nMX_RECOVERY_COMPLETE=1\n' } });
  const result = f.run(['apply']);
  assert.notEqual(result.status, 0);
  assert.ok(f.requests().at(-1).path.endsWith('/terminal'));
  assert.match(result.stderr, /runtime verification failed/);
  assert.doesNotMatch(result.stdout, /runtime-ready/);
});

test('HTTP errors are summarized without body disclosure or retries', t => {
  const f = fixture(t, { httpFailAt: 'profile' });
  const result = f.run(['apply']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /HTTP 403/);
  assert.equal(f.requests().length, 1);
  noSecrets(result);
});

test('ensure timeout is an unknown outcome with query guidance, never an automatic replay', t => {
  const f = fixture(t, { timeoutAt: 'ensure' });
  const result = f.run(['apply']);
  assert.notEqual(result.status, 0);
  assert.equal(f.requests().filter(r => r.path.endsWith('/ensure')).length, 1);
  assert.match(result.stdout, /result-unknown/);
  assert.match(result.stderr, /worker-reports\?jobId/);
  assert.match(result.stderr, /Do not rerun apply automatically/);
  noSecrets(result);
});

test('blocked ensure reports step IDs and failure status without raw diagnostics', t => {
  const f = fixture(t, { ensure: { status: 'blocked', jobId: 'job_2', blockedReasons: [SECRET],
    steps: [{ stepId: 'artifacts', status: 'blocked', objectId: 'manifest', command: SECRET }] } });
  const result = f.run(['apply']);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /"stepId": "artifacts"/);
  assert.equal(f.requests().filter(call => call.path.endsWith('/ensure')).length, 1);
  noSecrets(result);
});

test('missing ops token and invalid arguments do not issue HTTP requests', t => {
  const f = fixture(t);
  const noToken = f.run(['apply'], { MX_INTERNAL_OPS_TOKEN: '' });
  assert.notEqual(noToken.status, 0);
  assert.match(noToken.stderr, /MX_INTERNAL_OPS_TOKEN is missing/);
  const badArgument = f.run(['apply', 'bad/site', HOST]);
  assert.notEqual(badArgument.status, 0);
  assert.equal(f.requests().length, 0);
});

test('apply rejects permissive host checking or interactive batch mode before remote execution', t => {
  for (const change of [{ strictHostKeyChecking: 'no' }, { batchMode: 'no' }]) {
    const f = fixture(t);
    Object.assign(f.config.profile, change);
    const result = f.run(['apply']);
    assert.notEqual(result.status, 0);
    assert.equal(f.requests().length, 1);
  }
});

test('missing, paused or tokenless default/system accounts block legacy issuance', t => {
  for (const change of ['missing', 'paused', 'tokenless']) {
    const f = fixture(t);
    if (change === 'missing') f.config.accounts.splice(2, 1);
    if (change === 'paused') f.config.accounts[2].status = 'paused';
    if (change === 'tokenless') f.config.accounts[2].authToken = '';
    const result = f.run(['apply']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /before legacy issueDefaults/);
    assert.equal(f.requests().filter(r => r.path.endsWith('/plans') && r.method === 'POST').length, 0);
    assert.equal(f.requests().filter(r => r.path.endsWith('/ensure')).length, 0);
    noSecrets(result);
  }
});

test('fresh plan rejects old tokens, omitted active accounts and deleted extra users before ensure', t => {
  for (const change of ['token', 'omitted', 'extra']) {
    const f = fixture(t);
    f.config.planAccounts = structuredClone(f.config.accounts);
    if (change === 'token') f.config.planAccounts[0].authToken = 'obsolete-secret';
    if (change === 'omitted') f.config.planAccounts.pop();
    if (change === 'extra') f.config.planAccounts.push({ username: 'deleted-user', status: 'active', authToken: 'obsolete-secret' });
    const result = f.run(['apply']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /complete current active account set/);
    assert.equal(f.requests().filter(r => r.path.endsWith('/ensure')).length, 0);
    noSecrets(result);
    assert.doesNotMatch(result.stdout + result.stderr, /obsolete-secret/);
  }
});

test('fresh plan target mismatch and competing newer plan block ensure', t => {
  for (const override of [{ planHost: '203.0.113.99' }, { plans: [{ planId: 'concurrent-plan', kind: 'oversea', siteId: SITE, ssh: { profileId: 'sshprof_' + SITE }, status: 'ready', createdAt: '2099-01-01T00:00:00Z' }] }]) {
    const f = fixture(t, override);
    const result = f.run(['apply']);
    assert.notEqual(result.status, 0);
    assert.equal(f.requests().filter(r => r.path.endsWith('/ensure')).length, 0);
    noSecrets(result);
  }
});

test('profile or account changes during preparation block remote execution', t => {
  for (const change of ['profile', 'accounts']) {
    const f = fixture(t);
    if (change === 'profile') f.config.profileAfter = { ...f.config.profile, host: '203.0.113.99' };
    else { f.config.accountsAfter = structuredClone(f.config.accounts); f.config.accountsAfter[0].authToken = 'rotated-secret'; }
    const result = f.run(['apply']);
    assert.notEqual(result.status, 0);
    assert.equal(f.requests().filter(r => r.path.endsWith('/ensure')).length, 0);
    noSecrets(result);
  }
});

test('only missing rsync is installed via the fixed terminal command before legacy ensure', t => {
  const f = fixture(t);
  f.config.terminal.stdout = f.config.terminal.stdout.replace('RSYNC=ready', 'RSYNC=missing');
  const result = f.run(['apply']);
  assert.equal(result.status, 0, result.stderr);
  const installers = f.requests().filter(r => r.body?.command?.includes('apt-get install -y rsync'));
  assert.equal(installers.length, 1);
  assert.doesNotMatch(installers[0].body.command, /docker|curl|authorized_keys/);
  const ensureIndex = f.requests().findIndex(r => r.path.endsWith('/ensure'));
  assert.ok(f.requests().findIndex(r => r.body?.command?.includes('apt-get install -y rsync')) < ensureIndex);
  noSecrets(result);
});

test('failed rsync installation stops before ensure', t => {
  const f = fixture(t, { rsyncInstall: { status: 'failed', exitCode: 1, stdout: SECRET } });
  f.config.terminal.stdout = f.config.terminal.stdout.replace('RSYNC=ready', 'RSYNC=missing');
  const result = f.run(['apply']);
  assert.notEqual(result.status, 0);
  assert.equal(f.requests().filter(r => r.path.endsWith('/ensure')).length, 0);
  noSecrets(result);
});

test('accounts and latest plan are rechecked after a potentially slow rsync install', t => {
  for (const change of ['accounts', 'plan']) {
    const f = fixture(t);
    f.config.terminal.stdout = f.config.terminal.stdout.replace('RSYNC=ready', 'RSYNC=missing');
    if (change === 'accounts') {
      f.config.accountsBeforeEnsure = structuredClone(f.config.accounts);
      f.config.accountsBeforeEnsure[2].status = 'paused';
    } else {
      f.config.plansBeforeEnsure = [{ planId: 'concurrent-plan', kind: 'oversea', siteId: SITE,
        ssh: { profileId: 'sshprof_' + SITE }, status: 'ready', createdAt: '2099-01-01T00:00:00Z' }];
    }
    const result = f.run(['apply']);
    assert.notEqual(result.status, 0);
    assert.equal(f.requests().filter(r => r.body?.command?.includes('apt-get install -y rsync')).length, 1);
    assert.equal(f.requests().filter(r => r.path.endsWith('/ensure')).length, 0);
    noSecrets(result);
  }
});

test('the directly runnable kubectl heredoc uses the same safe legacy API sequence', t => {
  const program = readFileSync(runbook, 'utf8').match(/node --input-type=module - apply mx-oversea-us01 34\.218\.136\.162 <<'NODE'\n([\s\S]*?)\nNODE/)[1];
  const f = fixture(t);
  const result = f.runProgram(program);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.requests().filter(r => r.path.endsWith('/ensure')).length, 1);
  assert.ok(f.requests().find(r => r.path.endsWith('/ensure')).timeoutMs > 15 * 60_000);
  assert.match(result.stdout, /real Hysteria2 client\/network test/);
  noSecrets(result);
});

test('the direct heredoc also blocks stale effective HostName before remote execution', t => {
  const program = readFileSync(runbook, 'utf8').match(/node --input-type=module - apply mx-oversea-us01 34\.218\.136\.162 <<'NODE'\n([\s\S]*?)\nNODE/)[1];
  const f = fixture(t, { sshHostname: '203.0.113.99' });
  const result = f.runProgram(program);
  assert.notEqual(result.status, 0);
  assert.equal(f.requests().length, 2);
  assert.match(result.stderr, /Effective SSH HostName does not match/);
  noSecrets(result);
});
