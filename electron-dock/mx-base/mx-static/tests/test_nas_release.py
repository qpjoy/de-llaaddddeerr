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
        self.application_metadata = {}
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
        if args[:3] == ['docker', 'volume', 'inspect']:
            return json.dumps([self.volume if args[3] == self.profile['nfs_volume']
                               else self.application_metadata[args[3]]])
        if args[:3] == ['docker', 'ps', '-aq']: return '\n'.join(c['Id'] for c in self.rows)
        if args[:2] == ['docker', 'inspect']: return json.dumps(self.rows)
        self.fail('Unexpected admission action: ' + repr(args))

    def execute(self, command=None):
        return release.execute(self.options, command or ['up', '-d', 'web'], self.read, self.runner)

    def application_volume(self, key='claude_sessions', target='/root/.claude/projects', present=False):
        name = 'mx_data_' + key
        self.model['volumes'][key] = {'name': name, 'external': False}
        consumers = ['web', 'worker', 'worker-agent-data-hub', 'worker-agent-interactive',
                     'worker-agent-long', 'worker-agent-short', 'worker-strategy-draft']
        for service in consumers:
            self.model['services'][service]['volumes'].append(
                {'type': 'volume', 'source': key, 'target': target, 'volume': {}})
        self.application_metadata[name] = {'Name': name, 'Driver': 'local', 'Options': None, 'Scope': 'local',
            'Mountpoint': '/data/docker/volumes/' + name + '/_data', 'Labels': {
                'com.docker.compose.project': 'mx_data', 'com.docker.compose.volume': key}}
        if not present:
            self.missing.add(name)
        else:
            for c in self.rows:
                if c['Config']['Labels']['com.docker.compose.service'] in consumers:
                    c['Mounts'].append({'Type': 'volume', 'Name': name, 'Destination': target})
        return name

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

    def test_non_external_error_identifies_only_keys_and_still_blocks_release(self):
        before = copy.deepcopy(self.model)
        def additional_volume(model):
            model['volumes']['new_app_data'] = {'name': 'private-resolved-name',
                'labels': {'credential': 'private-label-value'}}
            model['volumes']['static_data']['external'] = False
        self.merged_mutation = additional_volume
        with self.assertRaisesRegex(RuntimeError, 'Protected data volumes must remain external: static_data') as failure:
            self.execute(['mx-nas-mode'])
        self.assertNotIn('private-resolved-name', str(failure.exception))
        self.assertNotIn('private-label-value', str(failure.exception))
        self.assertEqual(self.model, before)
        self.runner.assert_not_called()
        self.network.assert_not_called()
        self.assertFalse(any(call[:3] == ['docker', 'volume', 'ls'] for call in self.calls))

    def test_new_local_application_volume_does_not_block_readonly_preflight(self):
        name = self.application_volume()
        before = copy.deepcopy(self.model)
        for command in (['mx-nas-mode'], ['mx-nas-check']):
            self.assertEqual(self.execute(command), 0)
        self.assertEqual(self.model, before)
        self.runner.assert_not_called()
        self.assertNotIn(['docker', 'volume', 'inspect', name], self.calls)
        self.assertNotIn(['docker', 'volume', 'create', name], self.calls)

    def test_explicit_release_forwards_new_application_volume_without_creating_it_in_guard(self):
        self.application_volume()
        for command in (['build', 'web'], ['up', '-d', 'web'], ['run', '--rm', 'web', 'python', 'manage.py', 'migrate']):
            self.assertEqual(self.execute(command), 0)
            self.assertEqual(self.runner.call_args.args[0], ['docker', 'compose'] + self.options +
                             ['-f', str(manage.CONFIG.parent / 'part1.release.json')] + command)
        self.assertIs(self.model['volumes']['claude_sessions']['external'], False)
        self.assertFalse(any(c[:3] == ['docker', 'volume', 'create'] for c in self.calls))

    def test_other_new_local_application_volumes_follow_same_rule(self):
        self.application_volume('agent_cache', '/opt/agent-cache')
        self.assertEqual(self.execute(['mx-nas-check']), 0)
        self.runner.assert_not_called()

    def test_existing_compose_owned_application_volume_is_reused(self):
        name = self.application_volume(present=True)
        before = copy.deepcopy(self.rows)
        self.assertEqual(self.execute(), 0)
        self.assertIn(['docker', 'volume', 'inspect', name], self.calls)
        self.assertEqual(self.rows, before)
        self.runner.assert_called_once()

    def test_new_application_volume_does_not_relax_protected_or_external_existence(self):
        name = self.application_volume()
        self.model['volumes']['existing_extra'] = {'name': 'existing-extra', 'external': True}
        for key, value in self.model['volumes'].items():
            if key == 'claude_sessions':
                continue
            with self.subTest(key=key):
                self.missing = {name, value['name']}
                with self.assertRaisesRegex(RuntimeError, 'down -v'): self.execute()
        self.runner.assert_not_called()

    def test_application_volumes_reject_aliases_foreign_names_and_drivers(self):
        self.application_volume()
        original = copy.deepcopy(self.model['volumes']['claude_sessions'])
        for mutation in ({'name': self.profile['volume']}, {'name': self.profile['nfs_volume']},
                         {'name': 'other_project_sessions'}, {'driver': 'nfs'},
                         {'driver_opts': {'type': 'none', 'o': 'bind', 'device': '/data'}}):
            with self.subTest(mutation=mutation):
                self.model['volumes']['claude_sessions'] = dict(original, **mutation)
                with self.assertRaises(RuntimeError): self.execute()
        self.runner.assert_not_called()

    def test_existing_application_volume_identity_and_ownership_are_verified(self):
        name = self.application_volume(present=True)
        original = copy.deepcopy(self.application_metadata[name])
        for mutation in ({'Driver': 'nfs'}, {'Options': {'device': '/data'}}, {'Scope': 'global'},
                         {'Name': 'other-name'}, {'Mountpoint': '/somewhere/else'}, {'Labels': None},
                         {'Labels': {'com.docker.compose.project': 'delta_59202', 'com.docker.compose.volume': 'claude_sessions'}},
                         {'Labels': {'com.docker.compose.project': 'mx_data', 'com.docker.compose.volume': 'other'}}):
            with self.subTest(mutation=mutation):
                self.application_metadata[name] = dict(original, **mutation)
                with self.assertRaisesRegex(RuntimeError, 'identity/ownership'): self.execute()
        self.runner.assert_not_called()

    def test_existing_reference_prevents_replacing_missing_application_volume(self):
        name = self.application_volume(present=True)
        self.missing.add(name)
        with self.assertRaisesRegex(RuntimeError, 'missing despite a container reference'): self.execute()
        self.runner.assert_not_called()

    def test_application_volume_used_by_another_project_is_not_implicitly_adopted(self):
        name = self.application_volume(present=True)
        self.rows.append({'Id': 'other-project', 'Config': {'Labels': {
            'com.docker.compose.project': 'delta_59202', 'com.docker.compose.service': 'other'}},
            'Mounts': [{'Type': 'volume', 'Name': name, 'Destination': '/sessions'}]})
        with self.assertRaisesRegex(RuntimeError, 'shared across projects'): self.execute()
        self.runner.assert_not_called()

    def test_application_target_cannot_mask_protected_storage(self):
        self.application_volume()
        for target in ('/app/media', '/app/media/data_hub_raw_media/new', '/app/staticfiles', '/app', '/',
                       '/root/../app', '//root/sessions', 'sessions'):
            with self.subTest(target=target):
                self.model['services']['web']['volumes'][-1]['target'] = target
                with self.assertRaises(RuntimeError): self.execute()
        self.runner.assert_not_called()

    def test_new_application_mount_does_not_replace_existing_bind_or_anonymous_storage(self):
        self.application_volume()
        web = next(c for c in self.rows if c['Config']['Labels']['com.docker.compose.service'] == 'web')
        original = copy.deepcopy(web['Mounts'])
        for destination in ('/root/.claude/projects', '/root', '/root/.claude/projects/nested'):
            for mount_type in ('bind', 'volume'):
                web['Mounts'] = original + [{'Type': mount_type, 'Destination': destination, 'Name': 'old-data'}]
                with self.assertRaisesRegex(RuntimeError, 'replace or hide an existing mount'): self.execute()
        self.runner.assert_not_called()

    def test_new_application_mount_cannot_overlap_other_model_mounts_or_tmpfs(self):
        self.application_volume()
        web = self.model['services']['web']; original = copy.deepcopy(web)
        for destination in ('/root/.claude/projects', '/root', '/root/.claude/projects/nested'):
            for field, value in (('volumes', original['volumes'] + [{'type': 'bind', 'source': '/old', 'target': destination}]),
                                 ('tmpfs', [destination + ':rw']), ('tmpfs', destination)):
                web.clear(); web.update(copy.deepcopy(original)); web[field] = value
                with self.assertRaisesRegex(RuntimeError, 'overlaps another configured mount'): self.execute()
        self.runner.assert_not_called()

    def test_new_application_volume_cannot_use_subpath_or_replace_database(self):
        self.application_volume()
        mount = self.model['services']['web']['volumes'][-1]
        mount['volume'] = {'subpath': 'sessions'}
        with self.assertRaisesRegex(RuntimeError, 'subpath'): self.execute()
        mount['volume'] = {}
        self.model['services']['postgres']['volumes'] = [dict(mount, target='/data')]
        with self.assertRaisesRegex(RuntimeError, 'named data volume'): self.execute()
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
        self.assertIn(ROOT / 'scripts/nas/projects/infra_release_volumes.py', files)
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
            model['volumes']['claude_sessions'] = {}
            model['services']['web']['volumes'].append('claude_sessions:/root/.claude/projects')
            for name in ('web', 'gateway'):
                model['services'][name]['volumes'].append('static_data:/app/staticfiles')
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
                    child = next(m for m in b['volumes'] if m['target'] == release.infra_storage.RAW)
                    b['volumes'].remove(child)
                    self.assertEqual(child['target'], release.infra_storage.RAW)
                    self.assertTrue(child['volume']['nocopy'])
                    self.assertEqual(child.get('read_only', False), name == 'gateway')
                self.assertEqual(a, b)
            self.assertTrue(all(v['external'] for k, v in merged['volumes'].items() if k != 'claude_sessions'))
            self.assertFalse(merged['volumes']['claude_sessions'].get('external', False))
            self.assertEqual(release.infra_release_volumes.application_volumes(merged),
                             {'claude_sessions': 'mx_data_claude_sessions'})


if __name__ == '__main__': unittest.main()
