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
import precopy


def fixtures():
    consumers = {}
    services = {}
    for name in prepare.SERVICES:
        consumers[name] = {'Id': name, 'Mounts': [
            {'Name': prepare.VOLUME, 'Destination': '/app/media'},
            {'Name': 'fixture_static', 'Destination': '/app/staticfiles'}], 'Image': 'sha256:' + 'a' * 64, 'State': {'Running': True},
                          'Config': {'Env': ['MX_WEB_WORKERS=4', 'KEEP_SECRET=literal$value'], 'Labels': {
                              'com.docker.compose.project': 'mx_data',
                              'com.docker.compose.service': name,
                              'com.docker.compose.config-hash': 'fixture-hash',
                              'com.docker.compose.project.working_dir': prepare.DEPLOY,
                              'com.docker.compose.project.config_files': ','.join(prepare.FILES),
                              'com.docker.compose.project.environment_file': prepare.ENV_FILE}}}
        services[name] = {'image': 'old:tag', 'environment': {'KEEP_SECRET': 'literal$value'},
                          'volumes': [{'type': 'volume', 'source': 'media_data', 'target': '/app/media'}]}
    services['postgres'] = {'image': 'postgres:16', 'environment': {'PASSWORD': 'private'}}
    config = {'name': 'mx_data', 'services': services, 'volumes': {'media_data': {'name': prepare.VOLUME}}}
    return consumers, config


class CutoverPrepareTests(unittest.TestCase):

    def run_preparation(self, container_change=False, file_change=False):
        # Run the complete control flow with real private report files and fd
        # guards, but mocked Docker/NFS. No daemon or production path access.
        from types import SimpleNamespace
        consumers, original = fixtures()
        overlay = prepare.candidate(consumers)
        merged = copy.deepcopy(original)
        merged['volumes'].update(overlay['volumes'])
        for name, change in overlay['services'].items():
            merged['services'][name]['image'] = change['image']
            merged['services'][name]['volumes'] += change['volumes']
            if 'environment' in change: merged['services'][name]['environment'].update(change['environment'])
            if 'command' in change: merged['services'][name]['command'] = change['command']
        before = list(consumers.values())
        after = copy.deepcopy(before[::-1])
        for c in after: c['Mounts'].reverse()
        if container_change:
            next(c for c in after if c['Id'] == 'web')['Id'] = 'recreated-web'
        probe = {'docker_nfs_mount': True, 'same_target_inode': True, 'root_4k_write_read': True}
        def docker(args, **kwargs):
            if args[:2] == ['docker', 'compose']:
                if '--hash' in args:
                    return '\n'.join(name + ' fixture-hash' for name in prepare.SERVICES)
                return json.dumps(merged if any(arg.endswith('/compose.nas.override.json') for arg in args) else original)
            if args[:2] == ['docker', 'diff']: return ''
            if args[:2] == ['docker', 'exec']: return json.dumps(prepare.SCRIPT_HASHES)
            if args[:3] == ['docker', 'volume', 'ls']: return prepare.NFS_VOLUME
            if args[:3] == ['docker', 'volume', 'inspect']:
                return json.dumps([{'Name': prepare.NFS_VOLUME, 'Driver': 'local', 'Options': prepare.OPTIONS}])
            if args[:2] == ['docker', 'run']: return json.dumps(probe)
            self.fail('Unexpected Docker operation: ' + repr(args[:3]))
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); (root/'var/lib').mkdir(parents=True)
            source = root/'source'; source.mkdir()
            real_open, real_stat, real_fstat = os.open, os.stat, os.fstat
            def opened(path, *args, **kw):
                if path == '/': path = str(root)
                if path == '/run/lock/mx-static-nas-sample.lock': path = str(root/'lock')
                return real_open(path, *args, **kw)
            def inspected(path, *args, **kw):
                if path == '/dev/nvme0n1p1': return SimpleNamespace(st_rdev=real_stat(str(source)).st_dev)
                return real_stat(path, *args, **kw)
            def fd_info(fd):
                info = real_fstat(fd)
                fields = {key: getattr(info, key) for key in dir(info) if key.startswith('st_')}
                fields['st_uid'] = 0
                return SimpleNamespace(**fields)
            def job(*args, **kw):
                return (real_open(str(source), prepare.DIR_FLAGS), real_open(str(source), prepare.DIR_FLAGS),
                        {'phase': 'precopy_pass_complete', 'last_exit_code': 0, 'target_inode': real_stat(str(source)).st_ino})
            first_files = {prepare.ENV_FILE: 'initial-secret-hash'}
            final_files = {prepare.ENV_FILE: 'changed-secret-hash'} if file_change else dict(first_files)
            output = io.StringIO()
            with contextlib.ExitStack() as stack:
                patches = [(prepare.sys, 'argv', ['prepare.py', prepare.VOLUME, '--prepare']),
                           (prepare.sys, 'platform', 'linux')]
                for obj, name, value in patches: stack.enter_context(patch.object(obj, name, value))
                patches = [(prepare, 'check_host', {'return_value': None}),
                           (prepare, 'checked_root', {'return_value': str(source)}),
                           (prepare, 'inspect_containers', {'return_value': before}),
                           (precopy, 'inspect_containers', {'return_value': after}),
                           (prepare, 'open_parent', {'side_effect': lambda: real_open(str(source), prepare.DIR_FLAGS)}),
                           (prepare, 'open_job', {'side_effect': job}),
                           (prepare, 'file_hashes', {'side_effect': [first_files, final_files]}),
                           (prepare.os, 'geteuid', {'return_value': 0}),
                           (prepare.os, 'open', {'side_effect': opened}),
                           (prepare.os, 'stat', {'side_effect': inspected}),
                           (prepare.os, 'fstat', {'side_effect': fd_info}),
                           (prepare, 'run', {'side_effect': docker})]
                for obj, name, kw in patches: stack.enter_context(patch.object(obj, name, **kw))
                stack.enter_context(contextlib.redirect_stdout(output))
                status = prepare.main()
            report = next((root/'var/lib/mx-static/nas-cutover').iterdir())
            artifacts = {p.name: json.loads(p.read_text()) for p in report.iterdir()}
            self.assertEqual(artifacts['docker-nfs-probe.json'], probe)
            self.assertIn('review-items.json', artifacts)
            self.assertIn('deployment-before.private.json', artifacts)
            return status, [json.loads(line) for line in output.getvalue().splitlines()], artifacts

    def test_complete_prepare_accepts_mount_order_changes(self):
        status, events, artifacts = self.run_preparation()
        self.assertEqual(status, 0)
        self.assertEqual(events[-1]['event'], 'cutover_prepare_result')
        self.assertEqual(events[-1]['review_items'], [])
        self.assertFalse(events[-1]['production_stopped'])
        self.assertFalse(events[-1]['cutover_ready'])
        self.assertFalse(events[-1]['reclaim_ready'])
        self.assertEqual(artifacts['deployment-check.json'], {'config_files_changed': [], 'consumers_changed': []})

    def test_complete_prepare_reports_real_consumer_drift(self):
        status, events, artifacts = self.run_preparation(container_change=True)
        self.assertEqual(status, 1)
        self.assertEqual(events[-1]['event'], 'cutover_prepare_failed')
        drift = next(e for e in events if e['event'] == 'cutover_deployment_changed')
        self.assertEqual(drift['consumers_changed'], [{'service': 'web', 'fields': ['id']}])
        self.assertEqual(drift['config_files_changed'], [])
        self.assertNotIn('prepare-result.json', artifacts)

    def test_complete_prepare_reports_config_drift_without_values(self):
        status, events, artifacts = self.run_preparation(file_change=True)
        self.assertEqual(status, 1)
        drift = next(e for e in events if e['event'] == 'cutover_deployment_changed')
        self.assertEqual(drift['config_files_changed'], [prepare.ENV_FILE])
        self.assertEqual(drift['consumers_changed'], [])
        self.assertNotIn('secret', json.dumps(events))
        self.assertNotIn('prepare-result.json', artifacts)

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
