"""Lifecycle regression with a fake Docker daemon; no host containers are touched."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


MOCK = '''#!/usr/bin/env python3
import json,os,pathlib,sys
args=sys.argv[1:]; tool=pathlib.Path(sys.argv[0]).name
with open(os.environ['CALLS'],'a') as f: f.write(tool+' '+ ' '.join(args)+'\\n')
if tool=='flock': sys.exit(0)
if tool=='nvidia-smi':
 if args[0].startswith('--query-gpu='):
  flag='Enabled' if os.environ.get('DISPLAY_BUSY') else 'Disabled'
  print(f'0,GPU-0,Disabled,Disabled\\n1,GPU-1,{flag},Disabled\\n2,GPU-2,Disabled,Disabled\\n3,GPU-3,Enabled,Enabled')
 sys.exit(0)
if args[0]=='context': print('unix:///var/run/docker.sock'); sys.exit(0)
if args[0]=='info':
 if os.environ.get('OFFLINE'): sys.exit(1)
 print('linux'); sys.exit(0)
app=os.environ.get('TEST_APP','mx-embedding')
gpu='GPU-1' if app=='mx-embedding' else 'GPU-2'
if os.environ.get('SAVED_WRONG'): gpu='GPU-0'
c={'Id':'cid', 'Name':'/'+app+'-api','State':{'Running':True},'Config':{'Labels':{'com.mx-base.app':app}},'HostConfig':{'DeviceRequests':[{'DeviceIDs':[gpu],'Count':0}]}}
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

    def run_manager(self, action, app='mx-embedding', answer='yes\n'):
        self.env['TEST_APP'] = app
        return subprocess.run(['bash', str(self.root/'scripts/manage.sh'), action, app],
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


if __name__ == '__main__': unittest.main()
