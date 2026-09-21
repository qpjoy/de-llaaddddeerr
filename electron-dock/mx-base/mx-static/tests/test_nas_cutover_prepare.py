import copy
import contextlib
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts/nas'))
import cutover_prepare as prepare


def fixtures():
    consumers = {}
    services = {}
    for name in prepare.SERVICES:
        consumers[name] = {'Image': 'sha256:' + 'a' * 64, 'State': {'Running': True},
                          'Config': {'Env': ['MX_WEB_WORKERS=4', 'KEEP_SECRET=literal$value'], 'Labels': {
                              'com.docker.compose.project.working_dir': prepare.DEPLOY,
                              'com.docker.compose.project.config_files': ','.join(prepare.FILES),
                              'com.docker.compose.project.environment_file': prepare.ENV_FILE}}}
        services[name] = {'image': 'old:tag', 'environment': {'KEEP_SECRET': 'literal$value'},
                          'volumes': [{'type': 'volume', 'source': 'media_data', 'target': '/app/media'}]}
    services['postgres'] = {'image': 'postgres:16', 'environment': {'PASSWORD': 'private'}}
    config = {'name': 'mx_data', 'services': services, 'volumes': {'media_data': {'name': prepare.VOLUME}}}
    return consumers, config


class CutoverPrepareTests(unittest.TestCase):
    def test_wrong_volume_definition_never_accepted(self):
        base = {'Name': prepare.NFS_VOLUME, 'Driver': 'local', 'Options': prepare.OPTIONS}
        prepare.validate_volume(base)
        for key, value in (('Name', 'foreign'), ('Driver', 'other'), ('Options', None),
                           ('Options', dict(prepare.OPTIONS, device=':/wrong'))):
            wrong = dict(base); wrong[key] = value
            with self.assertRaises(RuntimeError): prepare.validate_volume(wrong)

    def test_original_deployment_and_env_drift_report_no_secret_values(self):
        consumers, config = fixtures()
        self.assertEqual(prepare.validate_config(config, consumers), [])
        config['services']['web']['environment']['KEEP_SECRET'] = 'other secret'
        differences = prepare.validate_config(config, consumers)
        self.assertEqual(differences, [{'service': 'web', 'environment_key': 'KEEP_SECRET'}])
        self.assertNotIn('other secret', json.dumps(differences))
        config['volumes']['media_data']['name'] = 'delta_59202_media_data'
        with self.assertRaises(RuntimeError): prepare.validate_config(config, consumers)

    def test_candidate_pins_images_and_only_ten_media_consumers(self):
        consumers, _ = fixtures()
        result = prepare.candidate(consumers)
        self.assertEqual(set(result['services']), prepare.SERVICES)
        self.assertNotIn('postgres', result['services'])
        for name, service in result['services'].items():
            self.assertEqual(service['image'], consumers[name]['Image'])
            mount = service['volumes'][0]
            self.assertEqual(mount['read_only'], name == 'gateway')
            self.assertTrue(mount['volume']['nocopy'])
        self.assertEqual(result['services']['web']['command'],
                         ['gunicorn', 'mx_data.wsgi:application', '--bind', '0.0.0.0:8000', '--workers', '4', '--timeout', '600'])
        self.assertEqual(result['services']['worker']['environment'], {'MX_RECOVER_STALE_AGENT_RUNS': '0'})
        consumers['web']['Config']['Env'] = ['MX_HOST=', 'MX_PORT=', 'MX_WEB_WORKERS=', 'MX_WEB_TIMEOUT=']
        self.assertEqual(prepare.candidate(consumers)['services']['web']['command'],
                         ['gunicorn', 'mx_data.wsgi:application', '--bind', '0.0.0.0:8000', '--workers', '2', '--timeout', '600'])

    def test_merge_preserves_db_parent_mounts_env_and_refuses_surprises(self):
        consumers, original = fixtures()
        overlay = prepare.candidate(consumers)
        merged = copy.deepcopy(original)
        merged['volumes'].update(overlay['volumes'])
        for name, change in overlay['services'].items():
            merged['services'][name]['image'] = change['image']
            merged['services'][name]['volumes'] += change['volumes']
            if 'environment' in change: merged['services'][name]['environment'].update(change['environment'])
            if 'command' in change: merged['services'][name]['command'] = change['command']
        prepare.validate_merged(original, merged, overlay)
        for mutate in (lambda c: c['services']['postgres'].update(image='postgres:99'),
                       lambda c: c['services']['web']['environment'].update(KEEP_SECRET='changed'),
                       lambda c: c['services']['gateway']['volumes'][-1].update(read_only=False),
                       lambda c: c['services']['worker']['volumes'].pop(0)):
            wrong = copy.deepcopy(merged); mutate(wrong)
            with self.assertRaises(RuntimeError): prepare.validate_merged(original, wrong, overlay)

    def test_private_artifact_cannot_overwrite_existing_file(self):
        with tempfile.TemporaryDirectory() as root:
            fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
            try:
                prepare.private_write(fd, 'test.json', {'secret': 'retained'})
                with self.assertRaises(FileExistsError): prepare.private_write(fd, 'test.json', {'secret': 'new'})
                path = Path(root) / 'test.json'
                self.assertEqual(json.loads(path.read_text())['secret'], 'retained')
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            finally:
                os.close(fd)

    def test_cli_rejects_wrong_volume_and_unknown_write_operations(self):
        for args in (['delta_59202_media_data', '--prepare'], ['po_infra_media_data', '--switch'],
                     ['po_infra_media_data', '--prepare', '--delete']):
            result = subprocess.run(['bash', str(ROOT / 'scripts/nas-cutover-prepare.sh')] + args,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            self.assertEqual(result.returncode, 2)

    def test_probe_touches_only_its_new_file_and_requires_nfs_identity(self):
        import builtins
        real_open = builtins.open
        with tempfile.TemporaryDirectory() as root:
            business = Path(root) / 'keep.bin'; business.write_bytes(b'keep')
            code = prepare.PROBE.replace("root='/nas'", 'root=' + repr(root))
            def opened(path, *args, **kwargs):
                if path == '/proc/self/mountinfo':
                    return io.StringIO('1 0 0:1 / '+root+' rw - nfs server:/export rw\n')
                return real_open(path, *args, **kwargs)
            with patch.object(sys, 'argv', ['probe', str(os.stat(root).st_ino)]), \
                    patch.object(builtins, 'open', side_effect=opened), \
                    contextlib.redirect_stdout(io.StringIO()):
                exec(compile(code, '<probe>', 'exec'), {})
            self.assertEqual(list(Path(root).iterdir()), [business])
            self.assertEqual(business.read_bytes(), b'keep')
            with patch.object(sys, 'argv', ['probe', '0']), self.assertRaises(AssertionError):
                exec(compile(code, '<probe>', 'exec'), {})
            self.assertEqual(list(Path(root).iterdir()), [business])


if __name__ == '__main__': unittest.main()
