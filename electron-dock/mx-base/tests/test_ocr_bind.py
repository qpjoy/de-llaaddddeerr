import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

BASE = Path(__file__).parents[1]


class OcrBindTests(unittest.TestCase):
    def test_default_saved_and_explicit_bind_precedence(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root/'scripts').mkdir()
            (root/'mx-ocr/scripts').mkdir(parents=True)
            shutil.copy(BASE/'scripts/gpu-common.sh', root/'scripts')
            shutil.copy(BASE/'scripts/deploy-confirm.sh', root/'scripts')
            shutil.copy(BASE/'mx-ocr/scripts/manage.sh', root/'mx-ocr/scripts')
            (root/'mx-ocr/scripts/upstream-manage.sh').write_text('printf "%s" "$BIND"\n')
            env = {k: v for k, v in os.environ.items() if k != 'BIND'}
            def run():
                return subprocess.check_output(['bash', str(root/'mx-ocr/scripts/manage.sh'), 'logs'],
                                               env=env, universal_newlines=True)
            self.assertEqual(run(), '0.0.0.0')
            (root/'mx-ocr/.env').write_text('BIND=127.0.0.1\n')
            self.assertEqual(run(), '127.0.0.1')
            env['BIND'] = '0.0.0.0'
            self.assertEqual(run(), '0.0.0.0')

    def test_endpoint_output_matches_bind(self):
        source = (BASE/'mx-ocr/scripts/upstream-manage.sh').read_text()
        function = source.split('print_endpoints() {', 1)[1].split('\n}\n', 1)[0]
        script = '''set -euo pipefail
c_grn=; c_off=; PORT=8710
dim() { printf '%s\\n' "$*"; }
hostname() { printf '192.168.1.2 10.0.0.2\\n'; }
print_endpoints() {''' + function + '\n}\nprint_endpoints\n'
        for bind, expected in [('127.0.0.1', '127.0.0.1'), ('0.0.0.0', '192.168.1.2'), ('10.0.0.2', '10.0.0.2')]:
            result = subprocess.check_output(['bash', '-c', script], env={**os.environ, 'BIND': bind}, universal_newlines=True)
            self.assertIn('http://' + expected + ':8710/', result)
            if bind == '127.0.0.1':
                self.assertIn('仅本机访问', result)
                self.assertNotIn('192.168.1.2', result)
