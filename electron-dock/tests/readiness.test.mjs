import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

const modulePath = new URL('../scripts/readiness.py', import.meta.url).pathname
// Python owns the production polling and validation; every executable lookup,
// subprocess and clock is replaced. No test can contact a host service/cluster.
const runner = `
import importlib.util, json, subprocess, sys
from unittest.mock import patch
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('readiness', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
scenario = json.loads(sys.argv[2])
clock = [0.0]
calls = []
counts = {}
def which(name, path=None):
    return None if name in scenario.get('missing', []) else '/fixture/bin/' + name
def sleep(seconds):
    clock[0] += seconds
def run(args, **options):
    kind = ('postgres' if args[0].endswith('pg_isready') else
            'proxy' if args[0].endswith('curl') else
            'health' if 'exec' in args else 'deployment' if 'deployment' in args else 'endpoints')
    calls.append({'args':args, 'stdin':options.get('input'), 'timeout':options['timeout'],
                  'env': options['env']})
    rows = scenario.get('responses', {}).get(kind, [{}])
    position = counts.get(kind, 0)
    counts[kind] = position + 1
    row = rows[min(position, len(rows)-1)]
    if row.get('timeout'):
        clock[0] += options['timeout']
        raise subprocess.TimeoutExpired(args, options['timeout'], output='sensitive-command-output')
    clock[0] += min(0.01, options['timeout'])
    output = row.get('stdout', '')
    if not isinstance(output, str):
        output = json.dumps(output)
    return subprocess.CompletedProcess(args, row.get('code', 0), output,
                                       row.get('stderr', 'sensitive-command-output'))
env = {'PATH':'/fixture/bin', 'MX_WAIT_TIMEOUT':'2', 'MX_WAIT_INTERVAL':'0.1'}
env.update(scenario.get('env', {}))
original = dict(env)
with patch.object(module.shutil, 'which', which), \\
     patch.object(module, '_PG_ISREADY_CANDIDATES', tuple(scenario.get('candidates', []))), \\
     patch.object(module.os.path, 'isfile', lambda path: path in scenario.get('existingCandidates', [])), \\
     patch.object(module.os, 'access', lambda path, mode: path in scenario.get('existingCandidates', [])), \\
     patch.object(module.subprocess, 'run', run), patch.object(module.time, 'monotonic', lambda: clock[0]), \\
     patch.object(module.time, 'sleep', sleep):
    try:
        value = getattr(module, scenario['method'])(env, timeout=scenario.get('timeout'))
        result = {'ok':True, 'value':value}
    except module.ReadinessError as error:
        result = {'ok':False, 'error':str(error)}
result.update({'calls':calls, 'elapsed':clock[0], 'envUnchanged':env == original})
print(json.dumps(result))
`

function run(scenario) {
  const result = spawnSync('python3', ['-I', '-c', runner, modulePath, JSON.stringify(scenario)], {
    encoding: 'utf8', timeout: 10000,
  })
  assert.equal(result.status, 0, result.stderr + result.stdout)
  const output = JSON.parse(result.stdout)
  assert.equal(output.envUnchanged, true)
  return { ...output, stderr: result.stderr }
}

const deployment = {
  metadata: { generation: 3 }, spec: { replicas: 1 },
  status: { observedGeneration: 3, readyReplicas: 1 },
}
const endpoints = { subsets: [{ addresses: [{ targetRef: {
  kind: 'Pod', namespace: 'mx-common', name: 'mx-common-hanlp-test',
} }] }] }
const health = { httpStatus: 200, body: { status: 'ready', model: 'COARSE_ELECTRA_SMALL_ZH' } }
function hanlp(overrides = {}, env = {}) {
  return run({ method: 'wait_hanlp', env, responses: {
    deployment: [{ stdout: deployment }], endpoints: [{ stdout: endpoints }], health: [{ stdout: health }],
    ...overrides,
  } })
}

test('host PostgreSQL readiness uses the PostgreSQL protocol and cannot inherit another host', () => {
  const result = run({ method: 'wait_host_postgres', env: {
    PGHOSTADDR: 'unrelated-host', PGSERVICE: 'other', PGSERVICEFILE: '/other',
  }, responses: { postgres: [{ code: 1 }, { code: 0 }] } })
  assert.equal(result.ok, true)
  assert.equal(result.calls.length, 2)
  assert.deepEqual(result.calls[1].args.slice(1), ['-h', '127.0.0.1', '-p', '5432', '-t', '5'])
  assert.equal(result.calls[1].env.PGHOSTADDR, undefined)
  assert.equal(result.calls[1].env.PGSERVICE, undefined)
  assert.equal(result.value.port, 5432)
})

test('PostgreSQL rejecting/no-response statuses time out without treating TCP as ready', () => {
  for (const code of [1, 2, 3]) {
    const result = run({ method: 'wait_host_postgres', timeout: 0.25, responses: { postgres: [{ code }] } })
    assert.equal(result.ok, false)
    assert.match(result.error, /timed out.*not accepting/)
    assert.ok(result.elapsed <= 0.25 + 1e-9)
    assert.doesNotMatch(result.error + result.stderr, /sensitive-command-output/)
  }
})

test('a missing PostgreSQL tool fails explicitly without socket fallback', () => {
  const result = run({ method: 'wait_host_postgres', missing: ['pg_isready'] })
  assert.equal(result.ok, false)
  assert.match(result.error, /pg_isready is required/)
  assert.deepEqual(result.calls, [])
})

test('PostgreSQL 16 tool is found outside PATH using its common server installation path', () => {
  const candidate = '/usr/pgsql-16/bin/pg_isready'
  const result = run({ method: 'wait_host_postgres', missing: ['pg_isready'],
    candidates: [candidate], existingCandidates: [candidate] })
  assert.equal(result.ok, true)
  assert.equal(result.calls[0].args[0], candidate)
})

test('a hung subprocess cannot exceed the total readiness deadline', () => {
  const result = run({ method: 'wait_host_postgres', timeout: 0.15,
    responses: { postgres: [{ timeout: true }] } })
  assert.equal(result.ok, false)
  assert.match(result.error, /timed out: probe timeout/)
  assert.equal(result.calls[0].timeout, 0.15)
  assert.equal(result.elapsed, 0.15)
})

test('readiness polling logs at most once per 15 seconds', () => {
  const result = run({ method: 'wait_host_postgres', timeout: 46,
    env: { MX_WAIT_INTERVAL: '1' }, responses: { postgres: [{ code: 2 }] } })
  assert.equal(result.ok, false)
  assert.equal(result.stderr.trim().split('\n').length, 3)
  assert.ok(result.calls.every(call => call.timeout <= 10))
})

test('HanLP uses a ready endpoint Pod and verifies the actual loaded model', () => {
  const result = hanlp({}, { KUBECONFIG: '/fixture/kubeconfig', CONTEXT: 'retained-cluster' })
  assert.equal(result.ok, true)
  assert.equal(result.value.modelLoaded, true)
  assert.equal(result.value.pod, 'mx-common-hanlp-test')
  for (const call of result.calls) {
    assert.ok(call.args.includes('--context'))
    assert.ok(call.args.includes('retained-cluster'))
    assert.equal(call.env.KUBECONFIG, '/fixture/kubeconfig')
    assert.equal(call.args.some(arg => ['apply', 'scale', 'delete', 'rollout', 'run', 'create'].includes(arg)), false)
  }
  const exec = result.calls.find(call => call.args.includes('exec'))
  assert.ok(exec.args.includes('pod/mx-common-hanlp-test'))
  assert.match(exec.args.at(-1), /127\.0\.0\.1:8000\/health/)
  assert.match(exec.args.at(-1), /ProxyHandler\(\{\}\)/)
  assert.match(exec.args.at(-1), /timeout=5/)
})

test('HanLP KUBE_CONTEXT is supported and conflicting context is rejected', () => {
  assert.equal(hanlp({}, { KUBE_CONTEXT: 'retained' }).calls[0].args[2], 'retained')
  const result = hanlp({}, { CONTEXT: 'one', KUBE_CONTEXT: 'two' })
  assert.equal(result.ok, false)
  assert.match(result.error, /disagree/)
  assert.deepEqual(result.calls, [])
})

test('missing or disabled HanLP fails without deploying or scaling', () => {
  for (const value of ['', { ...deployment, spec: { replicas: 0 } }]) {
    const result = hanlp({ deployment: [{ stdout: value }] })
    assert.equal(result.ok, false)
    assert.match(result.error, /missing|disabled/)
    assert.equal(result.calls.length, 1)
  }
})

test('HanLP does not accept endpoints without a ready Pod or unobserved deployment', () => {
  const noEndpoints = hanlp({ endpoints: [{ stdout: { subsets: [{ notReadyAddresses: endpoints.subsets[0].addresses }] } }] })
  assert.equal(noEndpoints.ok, false)
  assert.match(noEndpoints.error, /no ready Pod endpoint/)
  assert.equal(noEndpoints.calls.some(call => call.args.includes('exec')), false)
  const stale = hanlp({ deployment: [{ stdout: { ...deployment, status: { observedGeneration: 2, readyReplicas: 1 } } }] })
  assert.equal(stale.ok, false)
  assert.match(stale.error, /deployment is not ready/)
})

test('HanLP rejects failed/loading, missing model, non-200 and malformed health responses', () => {
  for (const value of [
    { httpStatus: 503, body: { status: 'loading', model: 'model' } },
    { httpStatus: 200, body: { status: 'failed', model: 'model' } },
    { httpStatus: 200, body: { status: 'ready' } },
    { httpStatus: 200, body: { status: 'ready', model: '' } },
    'not-json', null,
  ]) {
    const result = hanlp({ health: [{ stdout: value }] })
    assert.equal(result.ok, false)
    assert.match(result.error, /model health is not ready/)
  }
})

test('HanLP transient Kubernetes/probe failure can recover within the deadline', () => {
  const result = hanlp({ deployment: [{ code: 1 }, { stdout: deployment }],
    health: [{ code: 1 }, { stdout: health }] })
  assert.equal(result.ok, true)
  assert.ok(result.calls.length > 3)
})

test('proxy check is skipped without an explicit nonempty PROXY', () => {
  for (const env of [{}, { PROXY: '' }, { HTTPS_PROXY: 'http://localhost:7788' }]) {
    const result = run({ method: 'wait_proxy', env })
    assert.equal(result.ok, true)
    assert.equal(result.value.status, 'skipped')
    assert.deepEqual(result.calls, [])
  }
})

test('proxy credentials stay out of argv and registry 401 is a successful TLS reachability check', () => {
  const secret = 'synthetic-password'
  const result = run({ method: 'wait_proxy', env: { PROXY: `http://tester:${secret}@127.0.0.1:7788`, NO_PROXY: '*' },
    responses: { proxy: [{ stdout: '401' }] } })
  assert.equal(result.ok, true)
  const call = result.calls[0]
  assert.deepEqual(call.args.slice(1), ['-q', '--config', '-'])
  assert.doesNotMatch(call.args.join(' '), /synthetic-password/)
  assert.equal(call.env.PROXY, undefined)
  assert.equal(call.env.NO_PROXY, undefined)
  assert.match(call.stdin, /proxy = "http:\/\/tester:synthetic-password@127.0.0.1:7788"/)
  assert.match(call.stdin, /noproxy = ""/)
  assert.match(call.stdin, /https:\/\/registry-1\.docker\.io\/v2\//)
  assert.doesNotMatch(call.stdin, /insecure|location/)
  assert.equal(result.value.registryStatus, 401)
  assert.doesNotMatch(JSON.stringify(result.value) + result.stderr, /synthetic-password/)
})

test('proxy 407, server errors, redirects and curl TLS/connection failures never pass', () => {
  for (const response of [{ stdout: '407' }, { stdout: '503' }, { stdout: '302' }, { stdout: '200', code: 60 }]) {
    const result = run({ method: 'wait_proxy', timeout: 0.25, env: { PROXY: '127.0.0.1:7788' },
      responses: { proxy: [response] } })
    assert.equal(result.ok, false)
    assert.match(result.error, /proxy cannot reach/)
    assert.doesNotMatch(result.error + result.stderr, /sensitive-command-output/)
  }
})

test('invalid proxy and invalid time budgets fail without launching a probe', () => {
  for (const proxy of ['http://user:secret@0.0.0.0:7788', 'http://localhost:7788\nurl=bad', 'socks5://localhost:7788']) {
    const result = run({ method: 'wait_proxy', env: { PROXY: proxy } })
    assert.equal(result.ok, false)
    assert.deepEqual(result.calls, [])
    assert.doesNotMatch(result.error, /secret|url=bad/)
  }
  for (const value of ['nan', 'inf', '0', '-1', 'not-a-number']) {
    const result = run({ method: 'wait_host_postgres', env: { MX_WAIT_TIMEOUT: value } })
    assert.equal(result.ok, false)
    assert.deepEqual(result.calls, [])
  }
})
