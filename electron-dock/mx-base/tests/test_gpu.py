import importlib.util
from contextlib import redirect_stdout
import io
from pathlib import Path
import json
import os
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('gpu_check', Path(__file__).parents[1] / 'scripts/gpu-check.py')
gpu = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gpu)


class GpuTests(unittest.TestCase):
    def setUp(self):
        self.inventory = '0,GPU-0,Disabled,Disabled\n1,GPU-1,Disabled,Disabled\n2,GPU-2,Disabled,Disabled\n3,GPU-3,Enabled,Enabled'
        self.containers, self.processes = [], ''
        self.env = patch.dict(os.environ, {'DOCKER_HOST': '', 'MX_BASE_DISPLAY_GPU': '3',
            'MX_BASE_OCR_GPU': '2', 'MX_BASE_EMBEDDING_GPU': '1'})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.mock = patch.object(gpu, 'command', self.command)
        self.mock.start()
        self.addCleanup(self.mock.stop)

    def command(self, *args):
        if args[:2] == ('docker', 'context'): return 'unix:///var/run/docker.sock'
        if args[:2] == ('docker', 'info'): return 'linux'
        if args[:2] == ('docker', 'ps'): return '\n'.join(c['Id'] for c in self.containers)
        if args[:2] == ('docker', 'inspect'): return json.dumps(self.containers)
        if args[:2] == ('docker', 'top'): return 'PID\n123'
        if args[0] == 'nvidia-smi':
            return self.processes if args[1].startswith('--query-compute') else self.inventory
        raise AssertionError(args)

    def test_defaults_and_uuid_alias_conflicts(self):
        self.assertEqual(gpu.check('mx-embedding'), 'GPU-1')
        self.assertEqual(gpu.check('mx-ocr'), 'GPU-2')
        os.environ['MX_BASE_EMBEDDING_GPU'] = 'GPU-2'
        with self.assertRaisesRegex(ValueError, '三张不同'): gpu.check('mx-embedding')

    def test_display_unknown_remote_and_busy_fail_closed(self):
        self.inventory = self.inventory.replace('1,GPU-1,Disabled,Disabled', '1,GPU-1,Enabled,Disabled')
        with self.assertRaisesRegex(ValueError, '显示输出'): gpu.check('mx-embedding')
        self.inventory = self.inventory.replace('1,GPU-1,Enabled,Disabled', '1,GPU-1,N/A,N/A')
        with self.assertRaises(ValueError): gpu.check('mx-embedding')
        os.environ['DOCKER_HOST'] = 'ssh://remote'
        with self.assertRaisesRegex(ValueError, '本地执行'): gpu.check('mx-embedding')

    def test_container_and_process_ownership(self):
        c = {'Id': 'a', 'Name': '/other', 'State': {'Running': True}, 'Config': {'Labels': {}},
             'HostConfig': {'DeviceRequests': [{'DeviceIDs': ['GPU-1'], 'Count': 0}]}}
        self.containers = [c]
        with self.assertRaisesRegex(ValueError, '已被容器'): gpu.check('mx-embedding')
        c['Name'] = '/mx-embedding-api'
        with self.assertRaisesRegex(ValueError, '名称'): gpu.check('mx-embedding')
        c['Config']['Labels']['com.mx-base.app'] = 'mx-embedding'
        self.processes = 'GPU-1,123'
        self.assertEqual(gpu.check('mx-embedding'), 'GPU-1')
        self.processes += '\nGPU-1,456'
        with self.assertRaisesRegex(ValueError, '其他计算进程'): gpu.check('mx-embedding')

    def test_query_failure_is_not_interpreted_as_free_gpu(self):
        with patch.object(gpu, 'command', side_effect=subprocess.CalledProcessError(1, 'nvidia-smi')):
            with self.assertRaises(subprocess.CalledProcessError): gpu.check('mx-embedding')

    def test_report_identifies_container_service_without_disclosing_arguments(self):
        self.containers = [{'Id': 'a' * 64, 'Name': '/knock-ocr-api', 'State': {'Running': True},
                            'Config': {'Image': 'knock-ocr/api:fast-gpu', 'Env': ['SECRET=never-print'],
                                       'Cmd': ['--api-key', 'never-print'],
                                       'Labels': {'com.docker.compose.project': 'knock', 'com.docker.compose.service': 'ocr'}}}]
        self.processes = 'GPU-2,123,python,2048'
        output = io.StringIO()
        with patch.object(gpu.Path, 'read_text', return_value='python\n'), redirect_stdout(output):
            gpu.report('2')
        text = output.getvalue()
        self.assertIn('GPU 2', text)
        self.assertNotIn('GPU 1', text)
        self.assertIn('PID 123', text)
        self.assertIn('2048 MiB', text)
        self.assertIn('容器=knock-ocr-api', text)
        self.assertIn('服务=knock/ocr', text)
        self.assertIn('依据=docker top', text)
        self.assertNotIn('never-print', text)

    def test_unknown_process_remains_unknown(self):
        with patch.object(gpu.Path, 'read_text', side_effect=PermissionError()):
            self.assertIn('服务归属未确认', gpu.describe_process('123', []))
        with patch.object(gpu.Path, 'read_text', return_value='0::/system.slice/inference.service\n'):
            self.assertIn('systemd=inference.service', gpu.describe_process('123', []))

    def test_top_multiple_columns_and_cgroup_worker_race(self):
        self.assertEqual(gpu.top_pids('UID PID PPID CMD\nroot 2491332 1 python\n'), {'2491332'})
        self.assertEqual(gpu.top_pids('PID\n  123\n'), {'123'})
        self.assertEqual(gpu.top_pids('UID PPID CMD\nroot 123 python\n'), set())
        cid = 'a' * 64
        self.containers = [{'Id': cid, 'Name': '/mx-ocr-api', 'State': {'Running': True},
                            'Config': {'Labels': {'com.mx-base.app': 'mx-ocr'}},
                            'HostConfig': {'DeviceRequests': [{'DeviceIDs': ['GPU-2'], 'Count': 0}]}}]
        self.processes = 'GPU-2,2491332'
        for cgroup in ('0::/system.slice/docker-{}.scope\n', '1:memory:/docker/{}\n'):
            with patch.object(gpu.Path, 'read_text', return_value=cgroup.format(cid)):
                self.assertEqual(gpu.check('mx-ocr'), 'GPU-2')
        with patch.object(gpu.Path, 'read_text', return_value='0::/system.slice/docker-{}.scope\n'.format('b' * 64)):
            with self.assertRaisesRegex(ValueError, '未证明属于'): gpu.check('mx-ocr')
        with patch.object(gpu.Path, 'read_text', side_effect=PermissionError()):
            with self.assertRaises(ValueError): gpu.check('mx-ocr')


if __name__ == '__main__': unittest.main()
