import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

BASE = Path(__file__).parents[1]
spec = importlib.util.spec_from_file_location('embedding_keep_gpu', BASE/'scripts/embedding-keep-gpu.py')
keep = importlib.util.module_from_spec(spec)
spec.loader.exec_module(keep)


def container_fixture(app_dir):
    (app_dir/'secrets').mkdir(parents=True, exist_ok=True)
    (app_dir/'models').mkdir(parents=True, exist_ok=True)
    (app_dir/'secrets/api-key').write_text('never-print-or-replace-this-key')
    env = dict(MODEL_PATH='Qwen/Qwen3-Embedding-0.6B', MODEL_REVISION='pinned-model-revision',
               DIMENSIONS='512', MAX_LENGTH='2048', MAX_BATCH='16', MICRO_BATCH='2', TOKEN_BUDGET='4096',
               DTYPE='bfloat16', GPU_MEMORY_FRACTION='0.15', CPU_THREADS='3', API_KEY_FILE='/run/secrets/api-key',
               PRIVATE_SENTINEL='never-print-or-replace-this-key')
    return dict(Id='owned-container', Name='/mx-embedding-api', State=dict(Running=True),
                Config=dict(Labels={'com.mx-base.app': 'mx-embedding', 'com.docker.compose.project': 'mx-embedding',
                                    'com.docker.compose.service': 'api'}, Env=[k+'='+v for k, v in env.items()]),
                Mounts=[dict(Type='bind', Source=str(app_dir/'models'), Destination='/models'),
                        dict(Type='bind', Source=str(app_dir/'secrets/api-key'), Destination='/run/secrets/api-key')],
                HostConfig=dict(NanoCpus=2000000000, Memory=4294967296, ShmSize=536870912,
                                DeviceRequests=[dict(Driver='nvidia', Count=0, DeviceIDs=['GPU-3'])],
                                PortBindings={'8000/tcp': [dict(HostIp='192.0.2.8', HostPort='18210')]}))


class KeepGpuTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.app_dir = Path(temporary.name)
        self.container = container_fixture(self.app_dir)
        self.cards = [['1', 'GPU-1', 'Disabled'], ['3', 'GPU-3', 'Enabled']]

    def test_pins_existing_uuid_and_retains_limits_mount_port_model_without_secrets(self):
        state = keep.plan(self.container, self.cards, self.app_dir)
        values = state['values']
        self.assertEqual(values['GPU_UUID'], 'GPU-3')
        self.assertEqual(values['MX_EMBEDDING_MICRO_BATCH'], '2')
        self.assertEqual(values['MX_EMBEDDING_GPU_FRACTION'], '0.15')
        self.assertEqual(values['MX_EMBEDDING_CPUS'], '2.0')
        self.assertEqual(values['MX_EMBEDDING_CPU_THREADS'], '3')
        self.assertEqual(values['MX_EMBEDDING_MEMORY'], '4294967296')
        self.assertEqual(values['MX_EMBEDDING_REVISION'], 'pinned-model-revision')
        self.assertEqual(values['MX_EMBEDDING_BIND'], '192.0.2.8')
        self.assertEqual(values['MX_EMBEDDING_MODELS_PATH'], str(self.app_dir/'models'))
        self.assertNotIn('never-print', json.dumps(state))
        self.cards[1][0] = '0'  # Enumeration changes do not migrate the physical card.
        self.assertEqual(keep.plan(self.container, self.cards, self.app_dir), state)

    def test_unknown_ownership_gpu_or_unbounded_resources_cannot_use_exception(self):
        changes = [lambda c: c['Config']['Labels'].clear(),
                   lambda c: c['Config']['Labels'].update({'com.docker.compose.project': 'other'}),
                   lambda c: c['State'].update(Running=False),
                   lambda c: c['HostConfig']['DeviceRequests'][0].update(Count=-1),
                   lambda c: c['HostConfig']['DeviceRequests'][0].update(DeviceIDs=['3']),
                   lambda c: c['HostConfig']['DeviceRequests'][0].update(DeviceIDs=['GPU-1', 'GPU-3']),
                   lambda c: c['HostConfig'].update(Memory=0),
                   lambda c: c['HostConfig'].update(NanoCpus=0),
                   lambda c: c['Config'].update(Env=[]),
                   lambda c: c.update(Name='/mx-ocr-api')]
        for change in changes:
            altered = copy.deepcopy(self.container)
            change(altered)
            with self.subTest(container=altered['Name']), self.assertRaises(ValueError):
                keep.plan(altered, self.cards, self.app_dir)
        self.cards[1][2] = 'N/A'
        with self.assertRaises(ValueError): keep.plan(self.container, self.cards, self.app_dir)

    def test_key_mount_must_reuse_existing_project_key(self):
        other = self.app_dir/'different-key'
        other.write_text('different')
        self.container['Mounts'][1]['Source'] = str(other)
        with self.assertRaisesRegex(ValueError, 'Key 挂载'): keep.plan(self.container, self.cards, self.app_dir)

    def test_generated_exports_are_literal_and_revalidation_detects_changes(self):
        sentinel = self.app_dir/'must-not-execute'
        self.container['Config']['Env'][0] = 'MODEL_PATH=/models/$(touch {})'.format(sentinel)
        snapshot, values_file = self.app_dir/'plan.json', self.app_dir/'values.sh'
        with patch.object(keep, 'current', side_effect=lambda _: keep.plan(self.container, self.cards, self.app_dir)):
            with patch.object(keep.sys, 'argv', ['keep', 'prepare', str(self.app_dir), str(snapshot), str(values_file)]):
                keep.main()
            self.assertEqual(values_file.stat().st_mode & 0o777, 0o600)
            env = {**os.environ, 'KEEP_TEST_EXPORTS': str(values_file)}
            subprocess.check_call(['bash', '-c', 'source "$KEEP_TEST_EXPORTS"'], env=env)
            self.assertFalse(sentinel.exists())
            with patch.object(keep.sys, 'argv', ['keep', 'check', str(self.app_dir), str(snapshot)]):
                keep.main()
                self.container['Id'] = 'replacement-container'
                with self.assertRaisesRegex(ValueError, '构建期间'): keep.main()


if __name__ == '__main__': unittest.main()
