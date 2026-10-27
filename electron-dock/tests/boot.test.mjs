import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const source = new URL('../scripts/boot.py', import.meta.url).pathname
// The harness imports the real command and substitutes every host boundary.
// No subprocess, systemd, kubectl, network or production path is reachable.
const harness = String.raw`
import importlib.util, json, os, pathlib, sys, types
root=pathlib.Path(sys.argv[2]); options=json.loads(sys.argv[3]); calls=[]
spec=importlib.util.spec_from_file_location('boot', sys.argv[1]); b=importlib.util.module_from_spec(spec); spec.loader.exec_module(b)
for name in ('ACTIVE','RESOLVER','STORAGE_GUARD','ETCD_GUARD','ETCD_RECORD','CHECKPOINT','OPERATIONS','INSTALL','UNIT'):
    setattr(b,name,root/name)
b.UNIT=root/'units/mx-boot-verify.service'; b.UNIT.parent.mkdir()
b.SOURCE=root/'source'; b.SOURCE.mkdir()
(b.SOURCE/'boot.py').write_bytes(pathlib.Path(sys.argv[1]).read_bytes())
(b.SOURCE/'readiness.py').write_text('# isolated readiness fixture\n')
b.ACTIVE.write_text(json.dumps({'phase':'active','service':'mx-k8s-containerd.service','hostname':'mx-internal-server'}))
b.CHECKPOINT.write_text(json.dumps({'clusterUid':'original-cluster'}))
if options.get('foreignUnit'): b.UNIT.write_text('[Service]\nExecStart=/unrelated\n')
if options.get('operation'):
    b.OPERATIONS.mkdir(); (b.OPERATIONS/'task.json').write_text(json.dumps({'status':options['operation']}))
if options.get('receipt'):
    b.OPERATIONS.mkdir(exist_ok=True); (b.OPERATIONS/'receipt.json').write_text(json.dumps(options['receipt']))
os.environ['MX_MANAGE_STATE_DIR']=str(root/'local-state')
os.environ['MX_WAIT_TIMEOUT']='1'; os.environ['MX_WAIT_INTERVAL']='1'
if options.get('pgService'): os.environ['MX_HOST_PG_SERVICE']=options['pgService']
b.platform.system=lambda:options.get('platform','Linux'); b.os.geteuid=lambda:0
def trust(path, allow_missing=False):
    if options.get('unsafeHelper') and path==b.STORAGE_GUARD: raise b.Refuse('untrusted helper')
b.protected=trust
class ReadyError(Exception): pass
def dependency(name):
    def check(env,timeout=None):
        calls.append(['dependency',name]); assert timeout > 0
        if options.get('dependencyFail')==name: raise ReadyError('dependency unavailable')
        return {'status':'ready'}
    return check
b.readiness=lambda:types.SimpleNamespace(wait_host_postgres=dependency('postgres'),wait_hanlp=dependency('hanlp'),ReadinessError=ReadyError)
enabled={}; clock=[0.0]
b.time.monotonic=lambda:clock[0]
b.time.sleep=lambda seconds:clock.__setitem__(0,clock[0]+seconds)
def fake(args,env,timeout=15):
    calls.append(args)
    if args[0]=='systemctl':
        verb,name=args[1],args[2] if len(args)>2 else ''
        if verb=='daemon-reload': return ''
        if verb=='enable':
            if options.get('enableFail')==name: raise b.Pending('enable rejected; raw output hidden')
            enabled[name]='enabled'; return ''
        assert verb=='show',args
        absent=name in ('mihomo.service','mihomo-client.service','mx-internal-egress.service')
        state={'LoadState':'not-found' if absent else 'loaded','ActiveState':'active',
               'UnitFileState':enabled.get(name,options.get('enabled','enabled')),
               'FragmentPath':str(root/'original.service'),'ExecStartPre':'','After':'','Requires':'','RequiresMountsFor':''}
        if name=='kubelet.service': state.update(ExecStartPre=str(b.STORAGE_GUARD)+' '+str(b.ETCD_GUARD),After='mx-k8s-containerd.service',Requires='mx-k8s-containerd.service',RequiresMountsFor='/var/lib/etcd')
        if name=='mx-k8s-containerd.service': state['ExecStartPre']=str(b.STORAGE_GUARD)
        if options.get('missingGuard') and name=='kubelet.service': state['ExecStartPre']=''
        if options.get('inactive')==name: state['ActiveState']='inactive'
        return '\n'.join(key+'='+value for key,value in state.items())
    if str(b.RESOLVER) in args:
        return 'mx-k8s-containerd.service' if 'service' in args else 'unix:///run/mx-k8s-containerd/containerd.sock'
    if str(b.STORAGE_GUARD) in args or str(b.ETCD_GUARD) in args: return ''
    if args[0]=='kubectl':
        assert '--kubeconfig=/etc/kubernetes/admin.conf' in args
        if any('/readyz' in v for v in args): return 'readyz check passed'
        if 'namespace' in args: return options.get('clusterUid','original-cluster')
        if 'nodes' in args: return json.dumps({'items':[{'metadata':{'name':'mx-internal-server'},'status':{'conditions':[{'type':name,'status':'True' if name=='Ready' else 'False'} for name in ('Ready','MemoryPressure','DiskPressure','PIDPressure')]}}]})
        ns=args[args.index('-n')+1]; rows=[]
        for name in sorted(b.REQUIRED[ns]):
            if options.get('missingWorkload')==name: continue
            desired=0 if options.get('paused')==name else 1
            ready=0 if options.get('notReady')==name else 1
            rows.append({'kind':'Deployment','metadata':{'name':name,'generation':1},'spec':{'replicas':desired,'template':{'spec':{'containers':[{'image':'qpjoy/example:retained','imagePullPolicy':'Never'}]}}},'status':{'readyReplicas':ready,'observedGeneration':1}})
            if name=='mx-identity-public': rows[-1]['spec']['template']['spec']['containers'][0]['readinessProbe']={'httpGet':{'httpHeaders':[{'name':'Host','value':'auth.example.test'}]}}
        if options.get('lock')==ns: rows.append({'kind':'ConfigMap','metadata':{'name':'mx-harbor-deploy-lock'}})
        if options.get('job')==ns: rows.append({'kind':'Job','metadata':{'name':'mx-harbor-migrate-abc'},'status':{}})
        if options.get('unmanagedWorkloads') and ns=='mx-insight-hub':
            for name,desired in (('mx-insight-hub-postgres',0),('old-helper',1)):
                rows.append({'kind':'StatefulSet','metadata':{'name':name,'generation':2},
                    'spec':{'replicas':desired,'template':{'spec':{'containers':[{'image':'legacy/not-cached:old','imagePullPolicy':'Never'}]}}},
                    'status':{'readyReplicas':0,'observedGeneration':1}})
        return json.dumps({'items':rows})
    if args[0]=='crictl':
        assert args[2]=='unix:///run/mx-k8s-containerd/containerd.sock'
        return json.dumps({'images':[] if options.get('missingImage') else [{'repoTags':['docker.io/qpjoy/example:retained']}]})
    if args[0]=='curl':
        assert '--noproxy' in args and '--output' in args
        if options.get('hostileCurlrc') and args[1]!='-q': raise b.Pending('inherited curlrc changed the probe')
        if 'http://10.88.88.88:18444/healthz' in args: assert 'Host: auth.example.test' in args
        if options.get('entryFail'): raise b.Pending('entry unavailable')
        return ''
    raise AssertionError('unexpected command '+repr(args))
b.run=fake
exit_code=0
try:
    for _ in range(options.get('repeat',1)): b.main([options.get('action','audit')])
except (b.Refuse,OSError,ValueError,KeyError) as error:
    exit_code=1; print('REFUSED: '+str(error))
(root/'calls.json').write_text(json.dumps(calls))
(root/'result.json').write_text(json.dumps({'enabled':enabled,'unit':b.UNIT.read_text() if b.UNIT.exists() else None,'elapsed':clock[0]}))
sys.exit(exit_code)
`

function run(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mx-boot-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'harness.py'), harness)
  const result = spawnSync('python3', ['-I', join(root, 'harness.py'), source, root, JSON.stringify(options)], {
    encoding: 'utf8', timeout: 10000,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('MX_'))),
  })
  assert.equal(result.signal, null, result.stderr)
  return { ...result, calls: JSON.parse(readFileSync(join(root, 'calls.json'))), result: JSON.parse(readFileSync(join(root, 'result.json'))) }
}

function readOnly(result) {
  assert.equal(result.calls.some(args => ['enable', 'daemon-reload', 'start', 'restart', 'scale', 'apply', 'patch', 'delete', 'deploy', 'migrate'].some(word => args.includes(word))), false)
}

test('audit verifies the retained target, correct CRI, normalized image cache, dependencies and actual entries without mutations', t => {
  const result = run(t)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  readOnly(result)
  assert.deepEqual(result.calls.filter(args => args[0] === 'dependency').map(args => args[1]), ['postgres', 'hanlp'])
  assert.equal(result.calls.filter(args => args[0] === 'curl').length, 4)
  assert.equal(result.result.unit, null)
})

test('unmanaged historical workloads are retained without blocking required startup checks', t => {
  const result = run(t, { unmanagedWorkloads: true })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /mx-insight-hub-postgres 保留；不属于本次开机纳管工作负载/)
  assert.match(result.stdout, /old-helper 保留；不属于本次开机纳管工作负载/)
  readOnly(result)
  const requiredPaused = run(t, { unmanagedWorkloads: true, paused: 'mx-common-postgres' })
  assert.equal(requiredPaused.status, 1)
  assert.match(requiredPaused.stdout, /mx-common-postgres desired=0/)
  readOnly(requiredPaused)
})

test('local HTTP probes disable inherited curl configuration before all other curl options', t => {
  const result = run(t, { hostileCurlrc: true })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  const probes = result.calls.filter(args => args[0] === 'curl')
  assert.equal(probes.length, 4)
  assert.ok(probes.every(args => args[1] === '-q'))
  readOnly(result)
})

test('non-Linux invocation refuses before any host or cluster command', t => {
  const result = run(t, { platform: 'Darwin' })
  assert.equal(result.status, 1)
  assert.deepEqual(result.calls, [])
})

test('completed child_succeeded receipts are history, while unfinished receipts block startup verification', t => {
  const completed = run(t, { receipt: { phase: 'child_succeeded', exitCode: 0, finishedAt: '2026-10-27T00:00:00Z' } })
  assert.equal(completed.status, 0, completed.stdout + completed.stderr)
  const unfinished = run(t, { receipt: { phase: 'child_succeeded' } })
  assert.equal(unfinished.status, 1)
  readOnly(completed)
  readOnly(unfinished)
})

for (const [name, options] of Object.entries({
  guard: { missingGuard: true }, target: { clusterUid: 'another-cluster' }, workload: { missingWorkload: 'mx-identity' },
  pause: { paused: 'mx-insight-hub-ingest' }, lock: { lock: 'mx-harbor' }, migration: { job: 'mx-harbor' },
  operation: { operation: 'needs_reconciliation' }, image: { missingImage: true }, dependency: { dependencyFail: 'hanlp' },
  unit: { enabled: 'disabled' }, helper: { unsafeHelper: true },
})) {
  test(`audit fails closed on ${name} without repair, task replay or scale`, t => {
    const result = run(t, options)
    assert.equal(result.status, 1, result.stdout + result.stderr)
    readOnly(result)
  })
}

test('verify waits only for transient readiness and finishes within its budget', t => {
  const result = run(t, { action: 'verify', notReady: 'mx-harbor' })
  assert.equal(result.status, 1)
  assert.equal(result.result.elapsed, 1)
  readOnly(result)
})

test('install accepts healthy disabled units, installs a fixed oneshot copy, and only enables original services', t => {
  const result = run(t, { action: 'install', enabled: 'disabled', pgService: 'postgresql-custom.service' })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.deepEqual(Object.keys(result.result.enabled), ['mx-k8s-containerd.service', 'kubelet.service', 'postgresql-custom.service', 'mx-internal-host-runner.service', 'nginx.service', 'mx-boot-verify.service'])
  assert.match(result.result.unit, /Type=oneshot/)
  assert.match(result.result.unit, /Environment=MX_WAIT_TIMEOUT=900/)
  assert.match(result.result.unit, /TimeoutStartSec=960/)
  assert.match(result.result.unit, /releases\/[a-f0-9]{64}\/boot\.py verify/)
  assert.match(result.result.unit, /Environment=MX_HOST_PG_SERVICE=postgresql-custom.service/)
  assert.doesNotMatch(result.result.unit, /Restart=|Before=|Requires=/)
  assert.equal(result.calls.some(args => ['start', 'restart', 'scale', 'apply', 'deploy'].some(word => args.includes(word))), false)
})

test('install refuses a foreign unit before any write or enable', t => {
  const result = run(t, { action: 'install', foreignUnit: true, enabled: 'disabled' })
  assert.equal(result.status, 1)
  assert.equal(result.result.unit, '[Service]\nExecStart=/unrelated\n')
  assert.deepEqual(result.result.enabled, {})
  readOnly(result)
})

test('repeated installation retains the same fixed unit and does not re-enable healthy units', t => {
  const result = run(t, { action: 'install', enabled: 'disabled', repeat: 2 })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.equal(result.calls.filter(args => args[0] === 'systemctl' && args[1] === 'enable').length, 6)
  assert.equal(result.calls.some(args => ['start', 'restart'].some(word => args.includes(word))), false)
})

test('partial enable failure reports completed changes and never rolls back or starts services', t => {
  const result = run(t, { action: 'install', enabled: 'disabled', enableFail: 'kubelet.service' })
  assert.equal(result.status, 1)
  assert.deepEqual(result.result.enabled, { 'mx-k8s-containerd.service': 'enabled' })
  assert.match(result.stdout, /disabled -> enabled/)
  assert.match(result.stdout, /部分安装可能已完成/)
  assert.equal(result.calls.some(args => ['disable', 'start', 'restart'].some(word => args.includes(word))), false)
})

test('real command runner redacts failed command output and refuses an expired deadline before spawning', () => {
  const code = String.raw`
import importlib.util, sys, types
spec=importlib.util.spec_from_file_location('boot',sys.argv[1]); b=importlib.util.module_from_spec(spec); spec.loader.exec_module(b)
b.subprocess.run=lambda *args,**kwargs:types.SimpleNamespace(returncode=1,stdout='SECRET',stderr='SECRET')
try: b.run(['fixture-command'],{})
except b.Pending as error: print(str(error))
def forbidden(*args,**kwargs): raise AssertionError('deadline spawned a process')
b.subprocess.run=forbidden; b.DEADLINE=b.time.monotonic()-1
try: b.run(['fixture-command'],{})
except b.Pending as error: print(str(error))
helper=b.readiness(); assert callable(helper.wait_host_postgres) and callable(helper.wait_hanlp)
`
  const result = spawnSync('python3', ['-I', '-B', '-c', code, source], { encoding: 'utf8', timeout: 10000 })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.doesNotMatch(result.stdout + result.stderr, /SECRET/)
  assert.match(result.stdout, /总等待时间已到/)
})
