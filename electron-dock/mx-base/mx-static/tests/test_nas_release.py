import copy
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts/nas'))
import catalog
import manage
import release
from projects import infra_runtime
import test_nas_media_deploy


class ReleaseTests(unittest.TestCase):
    patch = test_nas_media_deploy.MediaDeploymentTests.patch
    register = test_nas_media_deploy.MediaDeploymentTests.register
    start = test_nas_media_deploy.MediaDeploymentTests.start

    def setUp(self):
        test_nas_media_deploy.MediaDeploymentTests.setUp(self)
        self.env = Path(self.tmp.name) / 'env'; self.env.write_text('PRIVATE=value\n')
        self.compose = Path(self.tmp.name) / 'compose.json'; self.compose.write_text('{}')
        self.options = ['-p', 'mx_data', '--env-file', str(self.env), '-f', str(self.compose)]
        for v in self.model['volumes'].values(): v['external'] = True
        for name in ('postgres', 'redis'):
            c = next(c for c in self.rows if c['Id'] == name + '-current')
            c['Mounts'] = [{'Destination': '/data', 'Type': 'volume',
                            'Name': 'database-data' if name == 'postgres' else 'queue-data'}]
        self.patch(release.socket, 'gethostname', return_value='mx-internal-server')
        self.network = self.patch(release.socket, 'create_connection')
        self.calls = []; self.missing = set(); self.runner = mock.Mock(return_value=0)
        self.merged_mutation = lambda model: None

    def read(self, args):
        self.calls.append(args)
        if args[:2] == ['docker', 'info']:
            return json.dumps({'Name': 'mx-internal-server', 'DockerRootDir': '/data/docker'})
        if args[:2] == ['docker', 'compose']:
            model = copy.deepcopy(self.model)
            if any(a.endswith('part1.release.json') for a in args): self.merged_mutation(model)
            return json.dumps(model)
        if args[:3] == ['docker', 'volume', 'ls']:
            return '\n'.join(v['name'] for v in self.model['volumes'].values() if v['name'] not in self.missing)
        if args[:3] == ['docker', 'volume', 'inspect']: return json.dumps([self.volume])
        if args[:3] == ['docker', 'ps', '-aq']: return '\n'.join(c['Id'] for c in self.rows)
        if args[:2] == ['docker', 'inspect']: return json.dumps(self.rows)
        self.fail('Unexpected admission action: ' + repr(args))

    def execute(self, command=None):
        return release.execute(self.options, command or ['up', '-d', 'web'], self.read, self.runner)

    def test_build_up_and_oneoff_keep_current_config_and_append_required_storage(self):
        before = copy.deepcopy(self.model)
        self.model['services']['web']['image'] = 'app:next'
        self.model['services']['web']['environment']['NEW_SETTING'] = 'keep-$literal'
        for command in (['build', 'web'], ['up', '-d', 'web'], ['run', '--rm', 'web', 'python', 'manage.py', 'migrate']):
            self.assertEqual(self.execute(command), 0)
            called = self.runner.call_args.args[0]
            self.assertEqual(called[:2 + len(self.options)], ['docker', 'compose'] + self.options)
            self.assertEqual(called[2 + len(self.options):], ['-f', str(manage.CONFIG.parent / 'part1.release.json')] + command)
        self.assertEqual(self.model['services']['postgres'], before['services']['postgres'])
        self.assertEqual(self.model['services']['web']['environment']['MX_SECRET_KEY'], 'keep-existing')
        self.assertNotIn('PRIVATE', self.output._new_target.getvalue())

    def test_ssd_writer_blocks_even_readonly_preflight_before_release(self):
        self.rows[0]['HostConfig']['Mounts'] = []
        for command in (['mx-nas-mode'], ['up', '-d', 'web'], ['restart', 'web']):
            with self.assertRaisesRegex(RuntimeError, 'reconcile SSD writes'): self.execute(command)
        self.runner.assert_not_called()

    def test_missing_or_wrong_nfs_volume_and_nas_offline_block_execution(self):
        self.missing.add(self.profile['nfs_volume'])
        with self.assertRaises(RuntimeError): self.execute()
        self.missing.clear(); original = self.volume['Options']
        self.volume['Options'] = {}
        with self.assertRaises(RuntimeError): self.execute()
        self.volume['Options'] = original; self.network.side_effect = OSError('offline')
        with self.assertRaises(OSError): self.execute()
        self.runner.assert_not_called()

    def test_missing_database_volume_after_down_v_is_not_created(self):
        self.missing.add('database-data')
        with self.assertRaisesRegex(RuntimeError, 'down -v'): self.execute()
        self.runner.assert_not_called()

    def test_env_cannot_redirect_existing_database_to_another_existing_volume(self):
        self.model['volumes']['postgres_data']['name'] = 'another-database'
        with self.assertRaisesRegex(RuntimeError, 'database/queue volume mapping'): self.execute()
        self.runner.assert_not_called()

    def test_missing_database_container_cannot_start_on_anonymous_or_bind_data(self):
        self.rows[:] = [c for c in self.rows if c['Id'] != 'postgres-current']
        for mount in ({'type': 'bind', 'source': '/empty', 'target': '/data'},
                      {'type': 'volume', 'target': '/data'}):
            self.model['services']['postgres']['volumes'] = [mount]
            with self.assertRaisesRegex(RuntimeError, 'named data volume'): self.execute()
        self.runner.assert_not_called()

    def test_missing_registration_and_pending_maintenance_never_fall_back(self):
        path = self.auto / infra_runtime.RECORD
        saved = path.read_bytes(); path.unlink()
        with self.assertRaises(RuntimeError): self.execute()
        path.write_bytes(saved); path.chmod(0o600)
        record = json.loads(saved); record['maintenance_report'] = '/pending'
        path.write_text(json.dumps(record))
        with self.assertRaisesRegex(RuntimeError, '维护尚未完成'): self.execute()
        self.runner.assert_not_called()

    def test_missing_media_can_be_recreated_but_final_check_requires_every_role(self):
        removed = self.rows.pop(0)
        self.assertEqual(self.execute(['up', '-d', 'web']), 0)
        with self.assertRaises(RuntimeError): self.execute(['mx-nas-check'])
        self.rows.append(removed)
        self.assertEqual(self.execute(['mx-nas-check']), 0)

    def test_merged_mount_shadow_or_non_external_data_stops_before_execution(self):
        for mutation in (lambda m: m['services']['web'].update(tmpfs=[release.infra_storage.RAW]),
                         lambda m: m['volumes']['postgres_data'].pop('external')):
            self.merged_mutation = mutation
            with self.assertRaises(RuntimeError): self.execute()
        self.runner.assert_not_called()

    def test_final_kernel_mismatch_is_reported_without_automatic_rollback(self):
        def changed(args):
            self.rows[0]['HostConfig']['Mounts'] = []
            return 0
        self.runner.side_effect = changed
        with self.assertRaises(RuntimeError): self.execute()
        self.assertEqual(self.runner.call_count, 1)

    def test_environment_edit_during_check_blocks_execution(self):
        self.merged_mutation = lambda model: self.env.write_text('PRIVATE=changed\n')
        with self.assertRaisesRegex(RuntimeError, 'files changed'): self.execute()
        self.runner.assert_not_called()

    def test_delta_remains_local_and_cannot_implicitly_adopt_infra_nas(self):
        self.model['name'] = 'delta_59202'
        self.model['volumes']['media_data']['name'] = 'delta_59202_media_data'
        self.assertEqual(self.execute(), 0)
        self.assertNotIn(str(manage.CONFIG.parent / 'part1.release.json'), self.runner.call_args.args[0])
        self.network.assert_not_called()
        index, _, _ = catalog.load(manage.CONFIG)
        index['parts']['part2']['report'] = '/new-cutover'
        with self.assertRaisesRegex(RuntimeError, 'no SSD fallback'): release.select(index, self.model)

    def test_unknown_project_and_changed_parent_are_refused(self):
        for name, volume in (('new_project', self.profile['volume']), ('mx_data', 'other-media')):
            self.model['name'] = name; self.model['volumes']['media_data']['name'] = volume
            with self.assertRaises(RuntimeError): self.execute()
        self.runner.assert_not_called()

    def test_readonly_preflight_does_not_release_or_restart(self):
        self.assertEqual(self.execute(['mx-nas-check']), 0)
        self.runner.assert_not_called()
        self.assertFalse(any('restart' in c or 'start' in c or 'run' in c for c in self.calls))


class ReleaseBoundaryTests(unittest.TestCase):
    def test_local_daemon_selection_keeps_application_environment(self):
        with mock.patch.dict(os.environ, {'DOCKER_HOST': 'tcp://remote:2375', 'DOCKER_CONTEXT': 'remote',
                                          'MX_SECRET_KEY': 'unchanged-secret'}), \
                mock.patch.object(release.os, 'geteuid', return_value=0), \
                mock.patch.object(manage, 'migration_lock'), \
                mock.patch.object(release, 'execute', return_value=0) as execute:
            self.assertEqual(release.main(['--env-file', '/env', '-f', '/compose', '--', 'up', '-d']), 0)
            self.assertEqual(os.environ['MX_SECRET_KEY'], 'unchanged-secret')
            self.assertNotIn('DOCKER_CONTEXT', os.environ)
            self.assertNotIn('DOCKER_HOST', os.environ)
            execute.assert_called_once()
        self.assertEqual(release.local_command(['docker', 'compose', 'up']),
                         ['docker', '--host', 'unix:///var/run/docker.sock', 'compose', 'up'])

    def test_destroy_and_mount_bypass_commands_are_rejected(self):
        options = ['--env-file', '/env', '-f', '/compose']
        for command in (['down', '-v'], ['rm', '-f'], ['run', '--volume', '/data:/app/media', 'web'],
                        ['run', '--entrypoint', 'sh', 'web'], ['create', 'web']):
            with self.assertRaises(RuntimeError): release.parse(options + ['--'] + command)
        _, command = release.parse(options + ['--', 'run', '--rm', '-e', 'URL=x', 'web', 'python', 'manage.py', 'migrate'])
        self.assertEqual(command[0], 'run')

    def test_busy_repair_cannot_execute_release(self):
        with mock.patch.object(release.os, 'geteuid', return_value=0), \
                mock.patch.object(manage, 'migration_lock', side_effect=BlockingIOError('busy')), \
                mock.patch.object(release, 'execute') as execute:
            with self.assertRaises(BlockingIOError):
                release.main(['--env-file', '/env', '-f', '/compose', '--', 'up', '-d'])
            execute.assert_not_called()

    def test_installed_snapshot_includes_guard_and_release_declaration(self):
        files = manage.runtime_sources()
        self.assertIn(ROOT / 'scripts/nas/release.py', files)
        self.assertIn(ROOT / 'deploy/nas/part1.release.json', files)

    def test_real_compose_merge_preserves_env_commands_and_database_settings(self):
        if not shutil.which('docker'): self.skipTest('Docker Compose unavailable')
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'compose.json'
            model = {'services': {}, 'volumes': {}}
            for name in ('postgres_data', 'redis_data', 'media_data', 'static_data'):
                model['volumes'][name] = {'name': 'po_infra_' + name}
            for name in manage.prep.SERVICES:
                model['services'][name] = {'image': 'example:next', 'command': ['original', 'command'],
                    'environment': {'MX_SECRET_KEY': 'unchanged$$dollar', 'NEW_SETTING': 'value'},
                    'volumes': ['media_data:/app/media']}
            for name in ('postgres', 'redis'):
                model['services'][name] = {'image': name + ':same', 'volumes': [name + '_data:/data']}
            path.write_text(json.dumps(model))
            env = dict(os.environ)
            for key in ('MEDIA_VOLUME_NAME', 'POSTGRES_VOLUME_NAME', 'REDIS_VOLUME_NAME', 'STATIC_VOLUME_NAME'): env.pop(key, None)
            def render(extra):
                result = subprocess.run(['docker', 'compose', '-p', 'mx_data', '-f', str(path)] + extra +
                    ['config', '--format', 'json'], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                    universal_newlines=True, env=env)
                return json.loads(result.stdout)
            base = render([]); merged = render(['-f', str(ROOT / 'deploy/nas/part1.release.json')])
            for name in model['services']:
                a, b = copy.deepcopy(base['services'][name]), copy.deepcopy(merged['services'][name])
                if name in manage.prep.SERVICES:
                    child = b['volumes'].pop()
                    self.assertEqual(child['target'], release.infra_storage.RAW)
                    self.assertTrue(child['volume']['nocopy'])
                    self.assertEqual(child.get('read_only', False), name == 'gateway')
                self.assertEqual(a, b)
            self.assertTrue(all(v['external'] for v in merged['volumes'].values()))


if __name__ == '__main__': unittest.main()
