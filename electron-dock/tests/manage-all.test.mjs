import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const source = new URL('../scripts/manage.py', import.meta.url).pathname
const order = ['mx-launcher', 'mx-pay', 'mx-hanlp', 'mx-insight-hub', 'mx-dataport']
const recorder = String.raw`
import json, os, pathlib, sys
root=pathlib.Path(os.environ['FIXTURE_ROOT'])
name=pathlib.Path.cwd().name
if name=='mx-common': name='mx-hanlp'
keys=('KUBECONFIG','MX_PAY_KUBE_CONTEXT','MX_PAY_NAMESPACE','MX_PAY_DEPLOY_DRIVER',
      'MX_HARBOR_KUBE_CONTEXT','MX_HARBOR_NODE','CONTEXT','KUBE_CONTEXT','PROXY',
      'MX_LAUNCHER_BUILD_PROXY','MX_PAY_BUILD_PROXY','MX_INSIGHT_BUILD_PROXY','MX_HARBOR_BUILD_PROXY',
      'MX_INSIGHT_HUB_DEPLOY','MX_INSIGHT_SYNC_LAUNCHER','MX_SMOKE_DATA',
      'MX_K8S_OS_HOSTNAME','MX_K8S_APISERVER_ADVERTISE_ADDRESS')
with (root/'events.jsonl').open('a') as stream:
    stream.write(json.dumps({'type':'child','project':name,'args':sys.argv[1:],'cwd':str(pathlib.Path.cwd()),
                             'env':{key:os.environ.get(key) for key in keys}})+'\n')
if os.environ.get('FIXTURE_DRIFT_AFTER')==name:
    (root/'cluster.json').write_text(json.dumps({'context':'internal-context','uid':'different-cluster'}))
sys.exit(23 if os.environ.get('FIXTURE_CHILD_FAIL')==name else 0)
`
const harness = String.raw`
import importlib.util, json, os, pathlib, signal, sys, types
root=pathlib.Path(sys.argv[2]); options=json.loads(sys.argv[3])
spec=importlib.util.spec_from_file_location('manage',sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.ROOT=root; m.ADMIN_CONFIG=root/'admin.conf'; m.ADMIN_CONFIG.write_text('fixture only')
m.ACTIVE_RUNTIME=root/'active.json'; m.RUNTIME_RESOLVER=root/'resolver.py'; m.CHECKPOINT=root/'checkpoint.json'
m.APISERVER_MANIFEST=root/'kube-apiserver.yaml'
m.APISERVER_MANIFEST.write_text('spec:\n  containers:\n    - command:\n      - --advertise-address='+options.get('apiAddress','192.0.2.20')+'\n')
host=os.uname().nodename
m.ACTIVE_RUNTIME.write_text(json.dumps({'phase':'active','service':'mx-k8s-containerd.service','hostname':host}))
m.CHECKPOINT.write_text(json.dumps({'clusterUid':options.get('checkpointUid','original-cluster')}))
(root/'cluster.json').write_text(json.dumps({'context':'internal-context','uid':'original-cluster'}))
scripts=root/'scripts'; scripts.mkdir()
m.DB_PROFILES=scripts/'postgres-runtime.json'
m.DB_PROFILES.write_text(json.dumps({'projects':{name:[] for name in m.ALL_PROJECTS if name!='mx-hanlp'}}))
for name in m.ALL_PROJECTS:
    directory=root/m.PROJECTS[name][0]; (directory/'scripts').mkdir(parents=True,exist_ok=True)
    (directory/'scripts/manage.sh').write_text('#!/usr/bin/env bash\nexec "$FIXTURE_PYTHON" -I "$FIXTURE_RECORDER" "$@"\n')
pay=root/'mx-base/mx-pay/.deploy/target.json'; pay.parent.mkdir()
pay.write_text(json.dumps({'clusterUID':options.get('payUid','original-cluster'),'context':options.get('payContext','internal-context'),'namespace':'mx-pay'}))
dataport=root/'mx-dataport/secrets/operations.json'; dataport.parent.mkdir()
dataport.write_text(json.dumps({'clusterUid':options.get('dataportUid','original-cluster'),'context':options.get('dataportContext','internal-context'),'node':host}))
for field,path in (('hubEnv',root/'mx-insight-hub/.env.internal'),('payEnv',root/'mx-base/mx-pay/.env')):
    if field in options: path.write_text(options[field])
os.environ.update(FIXTURE_ROOT=str(root),FIXTURE_PYTHON=sys.executable,FIXTURE_RECORDER=str(root/'record.py'),
                  FIXTURE_CHILD_FAIL=options.get('childFail',''),FIXTURE_DRIFT_AFTER=options.get('driftAfter',''),
                  MX_MANAGE_STATE_DIR=str(root/'state'),PROXY=options.get('proxy','127.0.0.1:7788'))
os.environ.update(options.get('env',{}))
def event(value):
    with (root/'events.jsonl').open('a') as stream: stream.write(json.dumps(value)+'\n')
def target(): return json.loads((root/'cluster.json').read_text())
def read(command,env,timeout=20):
    event({'type':'read','args':command,'kubeconfig':env.get('KUBECONFIG')})
    if str(m.RUNTIME_RESOLVER) in command: return options.get('runtime','mx-k8s-containerd.service')
    if 'current-context' in command: return target()['context']
    if 'view' in command:
        return json.dumps({'current-context':'internal-context','contexts':[{'name':'internal-context','context':{'cluster':'fixture','user':'fixture'}}]})
    if 'nodes' in command:
        return json.dumps({'items':[{'metadata':{'name':host},'status':{'addresses':[{'type':'InternalIP','address':'192.0.2.20'}]}}]})
    if 'kube-system' in command: return target()['uid']
    raise AssertionError('unexpected read command '+repr(command))
m.read_command=read
def cluster_check(env):
    event({'type':'cluster','env':{key:env.get(key) for key in ('KUBECONFIG','CONTEXT','KUBE_CONTEXT')}})
    return {'context':target()['context'],'clusterUID':target()['uid']}
m.cluster_check=cluster_check
class ReadinessError(Exception): pass
def dependency(name):
    def check(env,timeout=None):
        event({'type':'dependency','name':name,'kubeconfig':env.get('KUBECONFIG'),
               'snapshotCount':len(list((root/'state').glob('db-target-*.kubeconfig')))})
        if options.get('dependencySignal')==name: os.kill(os.getpid(),signal.SIGTERM)
        if options.get('dependencyFail')==name: raise ReadinessError(name+' fixture not ready')
        return {'status':'ready'}
    return check
m.readiness=lambda:types.SimpleNamespace(ReadinessError=ReadinessError,wait_proxy=dependency('proxy'),wait_host_postgres=dependency('postgres'),wait_hanlp=dependency('hanlp'))
def db_runtime(action,names,summary=None,env=None,lock_fd=None):
    config=pathlib.Path(env['KUBECONFIG'])
    event({'type':'db','project':names[0],'action':action,'kubeconfig':str(config),
           'mode':config.stat().st_mode & 0o777,'snapshot':json.loads(config.read_text()),
           'lockOpen':lock_fd is not None and os.fstat(lock_fd).st_size>=0})
    if not options.get('dbMissingSummary'): summary.write_text(json.dumps({'targets':[]}))
    return 7 if options.get('dbFail')==names[0] else 0
m.db_runtime=db_runtime
code=1
try: code=m.main(['plan','all'] if options.get('plan') else ['deploy','all'])
except m.Stop as error: print('REFUSED: '+str(error))
records=[]
if (root/'state').exists():
    records=[json.loads(path.read_text()) for path in sorted((root/'state').glob('all-*.json'))]
(root/'result.json').write_text(json.dumps({'records':records,'admin':str(m.ADMIN_CONFIG),'host':host,
                                         'stateExists':(root/'state').exists(),
                                         'snapshotsRemain':list(map(str,(root/'state').glob('db-target-*.kubeconfig')))}))
sys.exit(code)
`

function run(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mx manage all '))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'harness.py'), harness)
  writeFileSync(join(root, 'record.py'), recorder)
  writeFileSync(join(root, 'events.jsonl'), '')
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(MX_|PROXY$|KUBECONFIG$|CONTEXT$|KUBE_CONTEXT$|https?_proxy$|HTTPS?_PROXY$|ALL_PROXY$|all_proxy$|BASH_ENV$|ENV$|TMPDIR$)/.test(key)))
  const result = spawnSync('python3', ['-I', '-B', join(root, 'harness.py'), source, root, JSON.stringify(options)], {
    encoding: 'utf8', timeout: 15000, env,
  })
  assert.equal(result.signal, null, result.stdout + result.stderr)
  assert.ok(existsSync(join(root, 'result.json')), result.stdout + result.stderr)
  const details = JSON.parse(readFileSync(join(root, 'result.json')))
  assert.deepEqual(details.snapshotsRemain, [], 'temporary database kubeconfig must be removed on every outcome')
  const events = readFileSync(join(root, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
  return { ...result, ...details, events, children: events.filter(row => row.type === 'child'), record: details.records.at(-1) }
}

test('plan all is offline, ordered and does not create deployment state', t => {
  const result = run(t, { plan: true })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.deepEqual(result.events, [])
  assert.equal(result.stateExists, false)
  const plan = JSON.parse(result.stdout)
  assert.equal(plan.serial, true)
  assert.deepEqual(plan.steps.map(row => row.project), order)
  assert.deepEqual(plan.steps[2].command, ['bash', 'scripts/manage.sh', 'deploy', 'hanlp'])
})

test('deploy all genuinely delegates five serial child processes with the bound Internal environment', t => {
  const result = run(t)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.deepEqual(result.children.map(row => row.project), order)
  for (const child of result.children) {
    assert.equal(child.env.KUBECONFIG, result.admin)
    for (const key of ['MX_PAY_KUBE_CONTEXT', 'MX_HARBOR_KUBE_CONTEXT', 'CONTEXT', 'KUBE_CONTEXT']) assert.equal(child.env[key], 'internal-context')
    assert.equal(child.env.MX_PAY_NAMESPACE, 'mx-pay')
    assert.equal(child.env.MX_PAY_DEPLOY_DRIVER, 'k8s')
    assert.equal(child.env.MX_HARBOR_NODE, result.host)
    assert.equal(child.env.MX_K8S_OS_HOSTNAME, result.host)
    assert.equal(child.env.MX_K8S_APISERVER_ADVERTISE_ADDRESS, '192.0.2.20')
    assert.equal(child.env.PROXY, 'http://127.0.0.1:7788')
    assert.deepEqual(child.args, child.project === 'mx-hanlp' ? ['deploy', 'hanlp'] :
      child.project === 'mx-pay' ? ['deploy'] : ['ops', 'internal-production', 'deploy'])
  }
  assert.equal(result.children[0].env.MX_INSIGHT_HUB_DEPLOY, '0')
  assert.equal(result.children[3].env.MX_INSIGHT_SYNC_LAUNCHER, '0')
  assert.equal(result.children[3].env.MX_SMOKE_DATA, '0')
  assert.deepEqual(result.events.filter(row => row.type === 'dependency').map(row => row.name), ['proxy', 'postgres', 'postgres', 'hanlp'])
  const databases = result.events.filter(row => row.type === 'db')
  assert.equal(databases.length, 4)
  for (const row of databases) {
    assert.notEqual(row.kubeconfig, result.admin)
    assert.match(row.kubeconfig, /db-target-[a-f0-9]+\.kubeconfig$/)
    assert.equal(row.mode, 0o600)
    assert.equal(row.snapshot['current-context'], 'internal-context')
    assert.equal(row.lockOpen, true)
  }
  assert.equal(new Set(databases.map(row => row.kubeconfig)).size, 1)
  assert.deepEqual(result.snapshotsRemain, [])
  assert.equal(result.record.phase, 'completed')
  assert.deepEqual(result.record.steps.map(row => row.status), order.map(() => 'succeeded'))
})

for (const dependencyFail of ['proxy', 'postgres']) {
  test(`${dependencyFail} preflight failure starts no project`, t => {
    const result = run(t, { dependencyFail })
    assert.equal(result.status, 1, result.stdout + result.stderr)
    assert.deepEqual(result.children, [])
    assert.deepEqual(result.record.steps.map(row => row.status), order.map(() => 'pending'))
  })
}

for (const dependencySignal of ['proxy', 'postgres']) {
  test(`SIGTERM during ${dependencySignal} preflight records interruption and cleans the snapshot`, t => {
    const result = run(t, { dependencySignal })
    assert.equal(result.status, 143, result.stdout + result.stderr)
    assert.deepEqual(result.children, [])
    assert.equal(result.record.phase, 'interrupted')
    assert.equal(result.record.exitCode, 143)
    assert.ok(result.record.finishedAt)
    assert.deepEqual(result.record.steps.map(row => row.status), order.map(() => 'pending'))
    assert.equal(result.events.find(row => row.type === 'dependency' && row.name === dependencySignal).snapshotCount, 1)
    assert.deepEqual(result.snapshotsRemain, [])
  })
}

test('existing apiserver address mismatch refuses instead of repairing the control plane', t => {
  const result = run(t, { apiAddress: '192.0.2.99' })
  assert.equal(result.status, 1)
  assert.deepEqual(result.children, [])
  assert.equal(result.events.some(row => row.type === 'dependency'), false)
  assert.match(result.stdout, /advertise-address/)
  assert.deepEqual(result.record.steps.map(row => row.status), order.map(() => 'pending'))
})

for (const field of ['checkpointUid', 'payUid', 'payContext', 'dataportUid', 'dataportContext']) {
  test(`wrong saved ${field} refuses before dependencies or child scripts`, t => {
    const result = run(t, { [field]: 'another-target' })
    assert.equal(result.status, 1)
    assert.deepEqual(result.children, [])
    assert.equal(result.events.some(row => row.type === 'dependency'), false)
    assert.equal(result.record.phase, 'failed')
  })
}

for (const field of ['hubEnv', 'payEnv']) {
  test(`${field} cannot retarget KUBECONFIG through a sourced configuration file`, t => {
    const result = run(t, { [field]: 'export KUBECONFIG=/unrelated/admin.conf\n' })
    assert.equal(result.status, 1)
    assert.deepEqual(result.children, [])
    assert.match(result.stdout, /KUBECONFIG/)
  })
  test(`${field} refuses commands hidden beside an unrelated assignment`, t => {
    const result = run(t, { [field]: 'APP_LABEL=fixture; export KUBECONFIG=/unrelated/admin.conf\n' })
    assert.equal(result.status, 1)
    assert.deepEqual(result.children, [])
    assert.equal(result.events.some(row => row.type === 'dependency'), false)
    assert.match(result.stdout, /非单一字面赋值/)
  })
  test(`${field} preserves an in-word #suffix and rejects the changed target`, t => {
    const result = run(t, { [field]: 'MX_PAY_NAMESPACE=mx-pay#suffix\n' })
    assert.equal(result.status, 1)
    assert.deepEqual(result.children, [])
    assert.match(result.stdout, /MX_PAY_NAMESPACE/)
  })
  test(`${field} accepts a normal shell inline comment after the correct target`, t => {
    const result = run(t, { [field]: 'export MX_PAY_NAMESPACE="mx-pay" # unchanged namespace\n' })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.deepEqual(result.children.map(row => row.project), order)
    assert.equal(result.record.phase, 'completed')
  })
}

for (const key of ['MX_K8S_OS_HOSTNAME', 'MX_K8S_APISERVER_ADVERTISE_ADDRESS']) {
  test(`explicit ${key} cannot alter the existing Internal identity`, t => {
    const result = run(t, { env: { [key]: key.endsWith('ADDRESS') ? '192.0.2.99' : 'different-host' } })
    assert.equal(result.status, 1)
    assert.deepEqual(result.children, [])
    assert.match(result.stdout, new RegExp(key))
    assert.deepEqual(result.record.steps.map(row => row.status), order.map(() => 'pending'))
  })
}

test('middle child failure preserves completed steps and leaves later steps pending', t => {
  const result = run(t, { childFail: 'mx-hanlp' })
  assert.equal(result.status, 23, result.stdout + result.stderr)
  assert.deepEqual(result.children.map(row => row.project), order.slice(0, 3))
  assert.deepEqual(result.record.steps.map(row => row.status), ['succeeded', 'succeeded', 'failed', 'pending', 'pending'])
  assert.equal(result.record.phase, 'failed')
})

test('database apply failure makes the batch fail and stops subsequent deployment', t => {
  const result = run(t, { dbFail: 'mx-pay' })
  assert.equal(result.status, 7, result.stdout + result.stderr)
  assert.deepEqual(result.children.map(row => row.project), order.slice(0, 2))
  assert.deepEqual(result.record.steps.map(row => row.status), ['succeeded', 'failed', 'pending', 'pending', 'pending'])
})

test('missing database result is a batch failure even when the helper exits zero', t => {
  const result = run(t, { dbMissingSummary: true })
  assert.equal(result.status, 1)
  assert.deepEqual(result.children.map(row => row.project), ['mx-launcher'])
  assert.equal(result.record.steps[0].status, 'failed')
})

test('a target drift after the first real child stops before the next project', t => {
  const result = run(t, { driftAfter: 'mx-launcher' })
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.deepEqual(result.children.map(row => row.project), ['mx-launcher'])
  assert.deepEqual(result.record.steps.map(row => row.status), ['succeeded', 'pending', 'pending', 'pending', 'pending'])
  assert.equal(result.record.phase, 'failed')
})

test('HanLP readiness failure occurs before the Hub child and leaves DataPort pending', t => {
  const result = run(t, { dependencyFail: 'hanlp' })
  assert.equal(result.status, 1)
  assert.deepEqual(result.children.map(row => row.project), order.slice(0, 3))
  assert.deepEqual(result.record.steps.map(row => row.status), ['succeeded', 'succeeded', 'succeeded', 'failed', 'pending'])
})
