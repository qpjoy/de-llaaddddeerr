import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { deployIdentity, NS } from './identity-deploy.mjs';
import { initializeProfile, savePrivate } from './identity-profile.mjs';
import { createPublicEntry } from './identity-public-profile.mjs';

const moduleUrl = new URL('./identity-deploy.mjs', import.meta.url).href;
const privateOutput = 'PRIVATE_KUBECTL_STDOUT';
const privateError = 'PRIVATE_KUBECTL_STDERR';
const progress = 'Waiting for deployment "mx-identity-public" rollout to finish';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'mx identity progress '));
  const calls = join(dir, 'calls.jsonl'), gate = join(dir, 'release');
  writeFileSync(join(dir, 'kubectl'), `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(process.env.MX_TEST_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n');
const rollout = process.argv.includes('rollout') && process.argv.includes('status');
process.stdout.write((rollout ? ${JSON.stringify(progress)} : ${JSON.stringify(privateOutput)}) + '\\n');
process.stderr.write(${JSON.stringify(privateError)} + '\\n');
if (process.env.MX_TEST_WAIT === '1') {
  const timer = setInterval(() => {
    if (fs.existsSync(process.env.MX_TEST_GATE)) { clearInterval(timer); process.exit(0); }
  }, 10);
  setTimeout(() => process.exit(90), 5000);
} else process.exit(Number(process.env.MX_TEST_EXIT || 0));
`, { mode: 0o755 });
  return { dir, calls, gate };
}

function invoke(f, args, { wait = false, exit = 0, assertCaptured = false } = {}) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
import { run } from ${JSON.stringify(moduleUrl)};
try {
  const result = run(JSON.parse(process.env.MX_TEST_ARGS), 'PRIVATE_INPUT');
  if (process.env.MX_TEST_WAIT === '1' && result !== '') throw new Error('streamed output should return an empty string');
  if (process.env.MX_TEST_CAPTURE === '1') {
    if (result !== ${JSON.stringify(privateOutput + '\n')} && result !== ${JSON.stringify(progress + '\n')}) throw new Error('output was not returned');
    console.log('captured');
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
`], { env: { ...process.env,
    PATH: `${f.dir}:${dirname(process.execPath)}:${process.env.PATH ?? ''}`,
    MX_TEST_CALLS: f.calls, MX_TEST_GATE: f.gate, MX_TEST_ARGS: JSON.stringify(args),
    MX_TEST_WAIT: wait ? '1' : '0', MX_TEST_EXIT: String(exit), MX_TEST_CAPTURE: assertCaptured ? '1' : '0'
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  const output = { stdout: '', stderr: '' };
  child.stdout.on('data', data => { output.stdout += data; });
  child.stderr.on('data', data => { output.stderr += data; });
  const finished = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ ...output, code, signal }));
  });
  return { child, output, finished };
}

test('identity rollout progress reaches the caller before kubectl exits', async t => {
  for (const deployment of ['mx-identity', 'mx-identity-public']) await t.test(deployment, async () => {
    const f = fixture();
    const run = invoke(f, ['-n', NS, 'rollout', 'status', `deployment/${deployment}`, '--timeout=180s'], { wait: true });
    try {
      await new Promise((resolve, reject) => {
        const deadline = setTimeout(() => { cleanup(); reject(new Error('rollout progress was buffered until exit')); }, 2500);
        const onData = () => { if (run.output.stdout.includes(progress)) { cleanup(); resolve(); } };
        const onExit = () => { cleanup(); reject(new Error('kubectl exited before live progress was observed')); };
        const cleanup = () => { clearTimeout(deadline); run.child.stdout.off('data', onData); run.child.off('exit', onExit); };
        run.child.stdout.on('data', onData); run.child.once('exit', onExit);
        onData();
      });
      assert.equal(run.child.exitCode, null, 'the waiting rollout process must still be running');
      writeFileSync(f.gate, 'release');
      const result = await run.finished;
      assert.equal(result.code, 0, result.stderr);
      assert.ok(!result.stderr.includes(privateError));
      assert.equal(readFileSync(f.calls, 'utf8').trim().split('\n').length, 1);
    } finally { writeFileSync(f.gate, 'release'); await run.finished; rmSync(f.dir, { recursive: true, force: true }); }
  });
});

test('get, apply, exec and unrelated rollout output remain captured', async () => {
  const cases = [
    ['-n', NS, 'get', 'secret', 'mx-identity-runtime', '-o', 'json'],
    ['apply', '--server-side', '--field-manager=mx-identity-deploy', '-f', '-'],
    ['-n', NS, 'exec', 'api-pod', '--', 'node', '-e', 'console.log("private")'],
    ['-n', 'other-namespace', 'rollout', 'status', 'deployment/mx-identity', '--timeout=180s'],
    ['-n', NS, 'rollout', 'status', 'deployment/another-service', '--timeout=180s']
  ];
  for (const args of cases) {
    const f = fixture();
    try {
      const result = await invoke(f, args, { assertCaptured: true }).finished;
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout, 'captured\n', args.join(' '));
      assert.equal(result.stderr, '');
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  }
});

test('failed kubectl calls expose only the safe error, stop nonzero and never retry', async () => {
  for (const args of [
    ['apply', '--server-side', '--field-manager=mx-identity-deploy', '-f', '-'],
    ['-n', NS, 'rollout', 'status', 'deployment/mx-identity-public', '--timeout=180s']
  ]) {
    const f = fixture();
    try {
      const result = await invoke(f, args, { exit: 19 }).finished;
      assert.equal(result.code, 1);
      assert.match(result.stderr, /身份部署 kubectl 操作未确认成功（退出码 19）/);
      assert.ok(!`${result.stdout}${result.stderr}`.includes(privateError));
      assert.ok(!`${result.stdout}${result.stderr}`.includes(privateOutput));
      assert.ok(!`${result.stdout}${result.stderr}`.includes('PRIVATE_INPUT'));
      assert.equal(readFileSync(f.calls, 'utf8').trim().split('\n').length, 1);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  }
});

test('public identity rollout failure preserves the profile and stops before admin SSO activation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mx identity failed rollout ')), file = join(dir, 'profile.json');
  try {
    const p = initializeProfile('https://10.88.88.88:18443', file);
    const publicEntry = createPublicEntry({ origin: 'https://auth.example.com', adminOrigin: 'https://launcher.example.com',
      hubOrigin: 'https://hub.example.com', audience: 'mx-insight-hub', privateOrigin: p.origin });
    savePrivate(file, { ...p, publicEntry });
    const before = readFileSync(file), calls = [], logs = [];
    const failure = new Error('身份部署 kubectl 操作失败；请检查集群与 Pod 状态（不输出凭据）');
    assert.throws(() => deployIdentity({ file, revision: 'a'.repeat(40), log: line => logs.push(line), execute(args, input) {
      calls.push({ args, resource: input ? JSON.parse(input) : null });
      if (args.includes('rollout')) throw failure;
      return '';
    } }), error => error === failure);
    assert.deepEqual(readFileSync(file), before);
    assert.deepEqual(calls.filter(call => call.resource).map(call => call.resource.metadata.name),
      ['mx-identity-runtime', 'mx-identity-ca', 'mx-identity', 'mx-identity-public']);
    assert.deepEqual(calls.at(-1).args, ['-n', NS, 'rollout', 'status', 'deployment/mx-identity-public', '--timeout=180s']);
    assert.equal(calls.filter(call => call.args.includes('rollout')).length, 1);
    assert.ok(logs.some(line => line.startsWith('[identity]')), 'phase progress should be visible');
    assert.ok(!logs.some(line => line.includes('统一身份已就绪')));
    for (const secret of [p.clientSecret, p.tlsKey, publicEntry.clientSecret, publicEntry.ingressToken]) assert.ok(!logs.join('\n').includes(secret));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
