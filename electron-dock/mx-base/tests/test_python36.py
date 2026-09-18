"""Guard the Python 3.6 subprocess API used on the deployment host.

This simulates the old API signature, not a real Python 3.6 interpreter.
"""
import ast
import importlib.util
import json
from pathlib import Path
import runpy
import subprocess
import sys
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).parents[1] / 'scripts'


class Python36HostTests(unittest.TestCase):
    def test_gpu_command_uses_legacy_text_mode(self):
        spec = importlib.util.spec_from_file_location('gpu_compat', SCRIPTS / 'gpu-check.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        original = subprocess.check_output

        # No `text` keyword: introduced in 3.7, rejected by 3.6's Popen.
        def legacy_check_output(args, universal_newlines=False, timeout=None):
            self.assertTrue(universal_newlines)
            return original(args, universal_newlines=universal_newlines, timeout=timeout)

        with patch.object(subprocess, 'check_output', legacy_check_output):
            self.assertEqual(module.command(sys.executable, '-c', 'print("GPU-1")'), 'GPU-1')

    def test_start_and_health_helpers_use_legacy_api(self):
        calls = []

        def legacy_check_output(args, universal_newlines=False, timeout=None):
            self.assertTrue(universal_newlines)
            calls.append(args)
            if '--format' in args:
                return json.dumps({'Running': True, 'Health': {'Status': 'healthy'}})
            return json.dumps([{
                'Config': {'Labels': {'com.mx-base.app': 'mx-embedding'}},
                'HostConfig': {'DeviceRequests': [{'Count': 0, 'DeviceIDs': ['GPU-1']}]},
            }])

        with patch.object(subprocess, 'check_output', legacy_check_output):
            with patch.object(sys, 'argv', ['check-saved-gpu.py', 'mx-embedding', 'GPU-1', 'mx-embedding-api']):
                runpy.run_path(str(SCRIPTS / 'check-saved-gpu.py'), run_name='__main__')
            with patch.object(sys, 'argv', ['wait-healthy.py', 'mx-embedding-api']):
                with self.assertRaises(SystemExit) as result:
                    runpy.run_path(str(SCRIPTS / 'wait-healthy.py'), run_name='__main__')
                self.assertEqual(result.exception.code, 0)
        self.assertEqual(len(calls), 2)

    def test_host_helpers_have_python36_syntax(self):
        for name in ('gpu-check.py', 'check-saved-gpu.py', 'wait-healthy.py'):
            ast.parse((SCRIPTS / name).read_text(), feature_version=(3, 6))
