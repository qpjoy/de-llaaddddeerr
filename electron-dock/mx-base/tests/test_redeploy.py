import importlib.util
import json
import os
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

BASE = Path(__file__).parents[1]
spec = importlib.util.spec_from_file_location('retire', BASE/'scripts/retire-container.py')
retire = importlib.util.module_from_spec(spec)
spec.loader.exec_module(retire)


class RedeployTests(unittest.TestCase):
    def test_retire_is_repeatable_graceful_and_ownership_scoped(self):
        c = {'Id': 'owned-id', 'Name': '/mx-ocr-api', 'State': {'Running': True},
             'Config': {'Labels': {'com.mx-base.app': 'mx-ocr'}}}
        present, changes = [True], []
        def output(args, universal_newlines=False, timeout=None):
            if args[1] == 'ps': return 'owned-id' if present[0] else ''
            return json.dumps([c])
        def mutate(args, timeout=None):
            changes.append(args)
            if args[1] == 'rm': present[0] = False
        with patch.object(retire.subprocess, 'check_output', output), patch.object(retire.subprocess, 'check_call', mutate):
            retire.retire('mx-ocr', 'mx-ocr-api')
            retire.retire('mx-ocr', 'mx-ocr-api')
            self.assertEqual(changes, [['docker', 'stop', '--time', '40', 'owned-id'], ['docker', 'rm', 'owned-id']])
            present[0] = True
            c['Config']['Labels'] = {}
            with self.assertRaises(ValueError): retire.retire('mx-ocr', 'mx-ocr-api')
            with self.assertRaises(ValueError): retire.retire('mx-ocr', 'knock-ocr-api')
            self.assertEqual(len(changes), 2)

    def test_image_preparation_failure_keeps_old_service(self):
        source = (BASE/'mx-ocr/scripts/upstream-manage.sh').read_text()
        function = source.split('cmd_deploy() {', 1)[1].split('\n}\n', 1)[0]
        script = '''set -euo pipefail
ROOT=/repo/mx-base/mx-ocr; C_API=mx-ocr-api; C_VLLM=mx-ocr-vllm
cmd_preflight() { echo preflight; }
cmd_pull() { echo pull; }
cmd_build() { echo build; [ "${FAIL_BUILD:-0}" = 0 ]; }
ensure_net() { echo network; }
uses_vllm() { return 1; }
python3() { echo "verified-action $*" >&2; }
start_api() { echo start-api; }
wait_ready() { echo healthy; }
cmd_status() { :; }
print_endpoints() { :; }
cmd_deploy() {''' + function + '\n}\ncmd_deploy\ncmd_deploy\n'
        failed = subprocess.run(['bash', '-c', script], env={**os.environ, 'FAIL_BUILD': '1'},
                                universal_newlines=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.assertNotEqual(failed.returncode, 0)
        self.assertNotIn('retire-container', failed.stdout)
        self.assertNotIn('start-api', failed.stdout)
        succeeded = subprocess.check_output(['bash', '-c', script], env={**os.environ, 'FAIL_BUILD': '0'}, universal_newlines=True, stderr=subprocess.STDOUT)
        self.assertEqual(succeeded.count('start-api'), 2)
        self.assertLess(succeeded.index('build'), succeeded.index('retire-container'))
        self.assertLess(succeeded.index('gpu-check.py'), succeeded.index('retire-container'))
