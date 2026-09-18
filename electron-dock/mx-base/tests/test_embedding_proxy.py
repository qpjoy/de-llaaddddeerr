import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

BASE = Path(__file__).parents[1]


class EmbeddingProxyTests(unittest.TestCase):
    def test_download_settings_precedence_including_explicit_empty_proxy(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'scripts').mkdir()
            app = root / 'mx-embedding'
            (app / 'scripts').mkdir(parents=True)
            shutil.copy(BASE / 'mx-embedding/scripts/manage.sh', app / 'scripts')
            (root / 'scripts/gpu-common.sh').write_text('gpu_config() { :; }\n')
            (root / 'scripts/deploy-confirm.sh').write_text('')
            (app / '.env').write_text(
                'MX_EMBEDDING_PROXY=http://saved:7788\n'
                'MX_EMBEDDING_PIP_INDEX=https://saved/simple\n')
            docker = root / 'docker'
            docker.write_text(
                '#!/usr/bin/env bash\n'
                'printf "%s\\n%s\\n" "$MX_EMBEDDING_PROXY" "$MX_EMBEDDING_PIP_INDEX"\n')
            docker.chmod(0o755)
            env = {k: v for k, v in os.environ.items()
                   if k not in ('MX_EMBEDDING_PROXY', 'MX_EMBEDDING_PIP_INDEX')}
            env['PATH'] = str(root) + os.pathsep + env['PATH']

            def run():
                return subprocess.check_output(
                    ['bash', str(app / 'scripts/manage.sh'), 'logs'],
                    env=env, universal_newlines=True).splitlines()

            self.assertEqual(run(), ['http://saved:7788', 'https://saved/simple'])
            env['MX_EMBEDDING_PROXY'] = 'http://192.168.1.2:7788'
            env['MX_EMBEDDING_PIP_INDEX'] = 'https://explicit/simple'
            self.assertEqual(run(), ['http://192.168.1.2:7788', 'https://explicit/simple'])
            env['MX_EMBEDDING_PROXY'] = ''
            self.assertEqual(run(), ['', 'https://explicit/simple'])
