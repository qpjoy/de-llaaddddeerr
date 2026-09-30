"""Lifecycle regression with a fake Docker daemon; no host containers are touched."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from test_embedding_keep_gpu import container_fixture


MOCK = '''#!/usr/bin/env python3
import json,os,pathlib,sys
args=sys.argv[1:]; tool=pathlib.Path(sys.argv[0]).name
with open(os.environ['CALLS'],'a') as f: f.write(tool+' '+ ' '.join(args)+'\\n')
if tool=='flock': sys.exit(0)
if tool=='nvidia-smi':
 if args[0].startswith('--query-gpu='):
  flag='Enabled' if os.environ.get('DISPLAY_BUSY') else 'Disabled'
  if 'display_mode' in args[0]: sys.exit(2)  # Removed/deprecated query must not be required.
  print(f'0,GPU-0,Disabled\\n1,GPU-1,{flag}\\n2,GPU-2,Disabled\\n3,GPU-3,Enabled')
 sys.exit(0)
if args[0]=='context': print('unix:///var/run/docker.sock'); sys.exit(0)
if args[0]=='info':
 if os.environ.get('OFFLINE'): sys.exit(1)
 print('linux'); sys.exit(0)
app=os.environ.get('TEST_APP','mx-embedding')
gpu='GPU-1' if app=='mx-embedding' else 'GPU-2'
if os.environ.get('SAVED_WRONG'): gpu='GPU-0'
c={'Id':'cid', 'Name':'/'+app+'-api','State':{'Running':True},'Config':{'Labels':{'com.mx-base.app':app}},'HostConfig':{'DeviceRequests':[{'DeviceIDs':[gpu],'Count':0}]}}
if os.environ.get('KEEP_CONTAINER_FIXTURE'):
 c=json.loads(pathlib.Path(os.environ['KEEP_CONTAINER_FIXTURE']).read_text())
if args[0]=='compose':
 with open(os.environ['CALLS'],'a') as f:
  f.write('effective '+ ' '.join(os.environ.get(k,'') for k in ['GPU_UUID','MX_EMBEDDING_MICRO_BATCH','MX_EMBEDDING_GPU_FRACTION','MX_EMBEDDING_CPUS','MX_EMBEDDING_CPU_THREADS','MX_EMBEDDING_MEMORY'])+'\\n')
 if 'build' in args:
  if os.environ.get('FAIL_BUILD'): sys.exit(1)
  if os.environ.get('CHANGE_INSTANCE_ON_BUILD'):
   c['Id']='changed-container'
   pathlib.Path(os.environ['KEEP_CONTAINER_FIXTURE']).write_text(json.dumps(c))
 sys.exit(0)
if args[0]=='ps':
 if '--format' in args:
  print(app+'-api' if args[-1]=='{{.Names}}' else app+'-api Up (healthy)')
 else: print('cid')
elif args[0]=='inspect':
 if '--format' in args: print(json.dumps({'Running':True,'Health':{'Status':'healthy'}}))
 else: print(json.dumps([c]))
elif args[0]=='top': print('PID\\n123')
'''


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        src = Path(__file__).parents[1]
        shutil.copytree(src/'scripts', self.root/'scripts')
        for app in ('mx-embedding', 'mx-ocr'):
            shutil.copytree(src/app/'scripts', self.root/app/'scripts')
        lock = self.root/'scripts/gpu-common.sh'
        lock.write_text(lock.read_text().replace('/var/lock/mx-base-gpu.lock', str(self.root/'gpu.lock')))
        binaries = self.root/'bin'
        binaries.mkdir()
        for name in ('docker', 'nvidia-smi', 'flock'):
            script = binaries/name
            script.write_text(MOCK)
            script.chmod(0o755)
        self.calls = self.root/'calls'
        self.env = {**os.environ, 'PATH': str(binaries)+':'+os.environ['PATH'], 'CALLS': str(self.calls),
                    'MX_EMBEDDING_MODELS_PATH': str(self.root/'models'), 'DOCKER_HOST': '',
                    'MX_BASE_DISPLAY_GPU': '3', 'MX_BASE_OCR_GPU': '2', 'MX_BASE_EMBEDDING_GPU': '1'}

    def run_manager(self, action, app='mx-embedding', answer='yes\n', extra=()):
        self.env['TEST_APP'] = app
        return subprocess.run(['bash', str(self.root/'scripts/manage.sh'), action, app] + list(extra),
                              env=self.env, text=True, capture_output=True, input=answer)

    def test_deploy_cancellation_does_not_touch_docker_or_gpu(self):
        for app in ('mx-ocr', 'mx-embedding'):
            for answer in ('', 'no\n', 'YES\n'):
                self.calls.write_text('')
                result = self.run_manager('deploy', app, answer=answer)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('已取消', result.stderr)
                self.assertEqual(self.calls.read_text(), '')

    def test_stop_requires_no_gpu_and_does_not_delete_or_stop_neighbors(self):
        for app in ('mx-embedding', 'mx-ocr'):
            self.calls.write_text('')
            self.env['DISPLAY_BUSY'] = '1'
            result = self.run_manager('stop', app)
            self.assertEqual(result.returncode, 0, result.stderr)
            calls = self.calls.read_text()
            self.assertIn('docker stop --time 40', calls)
            self.assertNotIn('nvidia-smi', calls)
            self.assertNotIn('docker rm', calls)
            self.assertNotIn('knock-ocr', calls)

    def test_admission_and_saved_gpu_precede_start(self):
        for app in ('mx-embedding', 'mx-ocr'):
            self.calls.write_text('')
            self.env['SAVED_WRONG'] = '1'
            result = self.run_manager('start', app)
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn('docker start', self.calls.read_text())
            del self.env['SAVED_WRONG']
            result = self.run_manager('start', app)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('healthy', result.stdout)
        self.calls.write_text('')
        self.env['DISPLAY_BUSY'] = '1'
        self.assertNotEqual(self.run_manager('deploy').returncode, 0)
        self.assertNotIn('compose', self.calls.read_text())

    def test_embedding_deploy_preserves_key_and_unknown_status_is_readonly(self):
        first = self.run_manager('deploy')
        self.assertEqual(first.returncode, 0, first.stderr)
        key = self.root/'mx-embedding/secrets/api-key'
        before = key.read_bytes()
        self.assertEqual(self.run_manager('deploy').returncode, 0)
        self.assertEqual(key.read_bytes(), before)
        self.assertEqual(key.stat().st_mode & 0o777, 0o600)
        self.assertNotIn(before.decode().strip(), self.calls.read_text())
        self.calls.write_text('')
        self.env['OFFLINE'] = '1'
        result = self.run_manager('status')
        self.assertIn('UNKNOWN', result.stdout)
        self.assertNotIn('NOT DEPLOYED', result.stdout)
        self.assertNotIn('start', self.calls.read_text())

    def prepare_shared(self):
        c = container_fixture(self.root/'mx-embedding')
        path = self.root/'saved-container.json'
        path.write_text(json.dumps(c))
        self.env['KEEP_CONTAINER_FIXTURE'] = str(path)
        # Changed local settings must not migrate the GPU or raise old limits.
        self.env.update(MX_BASE_EMBEDDING_GPU='1', MX_EMBEDDING_MICRO_BATCH='16',
                        MX_EMBEDDING_GPU_FRACTION='0.8', MX_EMBEDDING_CPUS='8')

    def test_explicit_shared_upgrade_keeps_physical_gpu_limits_and_only_updates_api(self):
        self.prepare_shared()
        result = self.run_manager('deploy', extra=['--keep-gpu'])
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.calls.read_text()
        self.assertIn('effective GPU-3 2 0.15 2.0 3 4294967296', calls)
        self.assertIn('build api', calls)
        self.assertIn('up -d --no-build --no-deps --wait --wait-timeout 1800 api', calls)
        self.assertLess(calls.index('build api'), calls.index('up -d'))
        self.assertNotIn('docker stop', calls)
        self.assertNotIn('docker rm', calls)
        self.assertNotIn('never-print', calls + result.stdout + result.stderr)
        self.assertEqual((self.root/'mx-embedding/secrets/api-key').read_text(), 'never-print-or-replace-this-key')

    def test_shared_upgrade_cancel_build_failure_and_stale_plan_keep_old_instance(self):
        self.prepare_shared()
        result = self.run_manager('deploy', extra=['--keep-gpu'], answer='no\n')
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('compose', self.calls.read_text())
        for failure in ('FAIL_BUILD', 'CHANGE_INSTANCE_ON_BUILD'):
            self.calls.write_text('')
            self.env[failure] = '1'
            result = self.run_manager('deploy', extra=['--keep-gpu'])
            self.assertNotEqual(result.returncode, 0)
            calls = self.calls.read_text()
            self.assertIn('build api', calls)
            self.assertNotIn('up -d', calls)
            self.assertNotIn('docker stop', calls)
            self.assertNotIn('docker rm', calls)
            del self.env[failure]

    def test_keep_gpu_does_not_apply_to_start_or_other_apps(self):
        self.prepare_shared()
        self.assertNotEqual(self.run_manager('start', extra=['--keep-gpu']).returncode, 0)
        self.assertNotEqual(self.run_manager('deploy', app='mx-ocr', extra=['--keep-gpu']).returncode, 0)
        self.assertFalse(self.calls.exists(), 'unsupported flags must not reach Docker')


if __name__ == '__main__': unittest.main()
