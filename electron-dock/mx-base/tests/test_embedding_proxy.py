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

    def test_deploy_remembers_flags_and_rejects_loopback(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'scripts').mkdir()
            app = root / 'mx-embedding'
            (app / 'scripts').mkdir(parents=True)
            (app / 'secrets').mkdir()
            (app / 'secrets/api-key').write_text('existing-key')
            shutil.copy(BASE / 'mx-embedding/scripts/manage.sh', app / 'scripts')
            shutil.copy(BASE / 'scripts/deploy-confirm.sh', root / 'scripts')
            (root / 'scripts/gpu-common.sh').write_text(
                'gpu_config() { :; }\ngpu_admit() { export GPU_UUID=test; }\n')
            docker = root / 'docker'
            docker.write_text('#!/usr/bin/env bash\nexit 0\n')
            docker.chmod(0o755)
            env = {k: v for k, v in os.environ.items() if not k.startswith('MX_EMBEDDING_')}
            env.update(PATH=str(root) + os.pathsep + env['PATH'],
                       MX_EMBEDDING_MODELS_PATH=str(root / 'models'))

            def run(args, answer='yes\n'):
                return subprocess.run(
                    ['bash', str(app / 'scripts/manage.sh'), 'deploy'] + args,
                    input=answer, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                    env=env, universal_newlines=True)

            saved = app / '.env.download'
            self.assertNotEqual(run(['--proxy', 'http://192.168.1.2:7788'], 'no\n').returncode, 0)
            self.assertFalse(saved.exists())
            for address in ['http://127.0.0.1:7788', 'http://localhost:7788', 'http://[::1]:7788']:
                self.assertNotEqual(run(['--proxy', address]).returncode, 0)
                self.assertFalse(saved.exists())
            proxy = 'http://192.168.1.2:7788'
            result = run(['--proxy', proxy])
            self.assertEqual(result.returncode, 0, result.stderr)
            first = saved.read_text()
            self.assertIn(proxy, first)
            self.assertEqual(saved.stat().st_mode & 0o777, 0o600)
            (app / '.env').write_text('MX_EMBEDDING_PROXY=http://old:7788\n')
            self.assertEqual(run([]).returncode, 0)
            self.assertEqual(saved.read_text(), first)
            self.assertEqual(run(['--direct']).returncode, 0)
            self.assertNotIn(proxy, saved.read_text())
            env['MX_EMBEDDING_PROXY'] = 'http://environment:7788'
            self.assertEqual(run(['--proxy', proxy]).returncode, 0)
            self.assertIn(proxy, saved.read_text())
            self.assertEqual((app / 'secrets/api-key').read_text(), 'existing-key')
