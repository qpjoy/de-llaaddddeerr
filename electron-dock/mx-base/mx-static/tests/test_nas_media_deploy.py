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
from projects import infra_deploy as deploy
from projects import infra_runtime as runtime
from projects import infra_services
import test_nas_media_runtime


class MediaDeploymentTests(unittest.TestCase):
    patch = test_nas_media_runtime.MediaRuntimeTests.patch
    register = test_nas_media_runtime.MediaRuntimeTests.register
    start = test_nas_media_runtime.MediaRuntimeTests.start

    def setUp(self):
        test_nas_media_runtime.MediaRuntimeTests.setUp(self)
        self.register()
        self.dep = {'schema': 1, 'directory': '/app/source', 'env_file': 'deploy/.env.ghcr',
                    'compose_files': ['docker-compose.ghcr.yml', 'docker-compose.local-build.yml'],
                    'startup_scripts_sha256': {'scripts/run_worker.sh': 'reviewed'}}
        self.model = {'name': self.profile['project'], 'services': {}, 'volumes': {
            'media_data': {'name': self.profile['volume']},
            'postgres_data': {'name': 'database-data'}, 'redis_data': {'name': 'queue-data'},
            'static_data': {'name': 'static-data'},
            'mx_static_raw_media_nfs': {'name': self.profile['nfs_volume'], 'external': True}}}
        declaration = json.loads((ROOT / 'deploy/nas/part1.storage.json').read_text())
        for name, media in declaration['services'].items():
            script = 'run_web.sh' if name == 'web' else 'run_worker.sh' if name.startswith('worker') else 'run_beat.sh' if name == 'beat' else 'run_chat_gateway.sh'
            self.model['services'][name] = {'image': 'gateway:now' if name == 'gateway' else 'app:now',
                'command': ['/app/scripts/' + script],
                'environment': {'MODEL_TOKEN': 'private-$token', 'MX_WEB_WORKERS': '4', 'MX_SECRET_KEY': 'keep-existing'},
                'volumes': [{'type': 'volume', 'source': 'media_data', 'target': '/app/media'}] + copy.deepcopy(media['volumes'])}
        for name in ('postgres', 'redis'):
            self.model['services'][name] = {'image': name, 'volumes': [{'type': 'volume', 'source': name + '_data', 'target': '/data'}]}
            self.rows.append({'Id': name + '-current', 'Config': {'Labels': {
                'com.docker.compose.project': self.profile['project'], 'com.docker.compose.service': name}},
                'State': {'Running': True, 'Health': {'Status': 'healthy'}}, 'Mounts': []})

    def test_does_not_include_databases_in_media_selection(self):
        rows, databases = deploy.current(manage, self.profile)
        self.assertEqual(len(rows), 10); self.assertEqual(set(databases), {'postgres', 'redis'})

    def test_current_model_allows_new_env_and_image_but_rejects_wrong_storage(self):
        model = copy.deepcopy(self.model)
        model['services']['web']['environment']['NEW_SETTING'] = 'new-value'
        model['services']['web']['image'] = 'app:next'
        deploy.model_guard(manage, self.profile, model)
        model['services']['web']['volumes'][1]['source'] = 'media_data'
        with self.assertRaises(RuntimeError): deploy.model_guard(manage, self.profile, model)

    def test_mount_override_tmpfs_and_extra_consumer_are_rejected(self):
        changes = [lambda m: m['services']['web'].update(tmpfs=[runtime.infra_storage.RAW]),
                   lambda m: m['services'].update(extra=copy.deepcopy(m['services']['web'])),
                   lambda m: m['services']['web']['volumes'][1].update(volume={'nocopy': True, 'subpath': 'wrong'}),
                   lambda m: m['services']['web'].update(post_start=[{'command': 'initialize'}])]
        for change in changes:
            model = copy.deepcopy(self.model); change(model)
            with self.assertRaises(RuntimeError): deploy.model_guard(manage, self.profile, model)

    def test_launch_keeps_auth_env_but_skips_bootstrap_migrate_and_task_requeue(self):
        result = deploy.launch_policy(self.model)
        web = result['services']['web']
        self.assertEqual(web['environment'], self.model['services']['web']['environment'])
        self.assertEqual(web['command'][:2], ['gunicorn', 'mx_data.wsgi:application'])
        self.assertEqual(web['command'][web['command'].index('--workers') + 1], '4')
        self.assertEqual(result['services']['worker']['environment']['MX_RECOVER_STALE_AGENT_RUNS'], '0')
        for name in ('postgres', 'redis'): self.assertEqual(result['services'][name], self.model['services'][name])
        self.assertTrue(all(v['external'] for v in result['volumes'].values()))
        self.assertNotIn('bootstrap_admin', json.dumps(result))
        self.assertNotIn('run_web.sh', json.dumps(result))

    def test_unknown_startup_refused_before_any_container_change(self):
        for field, value in [('command', ['python', 'manage.py', 'bootstrap_admin']), ('entrypoint', ['/unknown'])]:
            model = copy.deepcopy(self.model); model['services']['web'][field] = value
            with self.assertRaises(RuntimeError): deploy.launch_policy(model)

    def test_down_v_missing_data_volume_never_becomes_an_empty_database(self):
        run = self.patch(manage, 'run', return_value=self.profile['nfs_volume'] + '\n' + self.profile['volume'])
        with self.assertRaisesRegex(RuntimeError, 'down -v'): deploy.data_volumes(manage, self.profile, self.model)
        self.assertEqual(run.call_count, 1)

    def test_missing_media_can_be_created_but_missing_database_cannot(self):
        self.rows = [c for c in self.rows if c['Id'] in ('postgres-current', 'redis-current')]
        rows, databases = deploy.current(manage, self.profile)
        self.assertEqual(rows, {})
        self.rows.pop()
        with self.assertRaisesRegex(RuntimeError, '数据库/队列'): deploy.current(manage, self.profile)

    def test_build_image_probe_has_no_media_mount_or_network_and_pins_this_operation_only(self):
        model = deploy.launch_policy(self.model)
        def command(args, **kwargs):
            if args[:3] == ['docker', 'image', 'inspect']:
                return json.dumps([{'Id': 'sha256:' + args[3], 'Config': {'Entrypoint': None}}])
            self.assertEqual(args[:3], ['docker', 'run', '--rm'])
            self.assertIn('--network=none', args); self.assertNotIn('--mount', args)
            self.assertEqual(args[args.index('--entrypoint') + 1], 'python')
            return json.dumps(self.dep['startup_scripts_sha256'])
        run = self.patch(manage, 'run', side_effect=command)
        deploy.resolve_images(manage, self.dep, model)
        self.assertTrue(model['services']['web']['image'].startswith('sha256:'))
        self.assertEqual(sum(c.args[0][:3] == ['docker', 'run', '--rm'] for c in run.call_args_list), 1)

    def test_image_script_change_stops_before_application_start(self):
        model = deploy.launch_policy(self.model)
        def command(args, **kwargs):
            if args[:3] == ['docker', 'image', 'inspect']: return json.dumps([{'Id': 'sha256:now', 'Config': {}}])
            return '{}'
        self.patch(manage, 'run', side_effect=command)
        with self.assertRaisesRegex(RuntimeError, 'startup scripts changed'): deploy.resolve_images(manage, self.dep, model)

    def simulate(self, build=False, drift=False, missing_media=False, fail_build=False, fail_create=False, pause_after_create=False):
        target = Path(self.tmp.name) / 'deploy-reports'; target.mkdir()
        self.patch(deploy, 'ROOT', str(target))
        self.patch(deploy, 'definition', return_value=self.dep)
        self.patch(infra_services.socket, 'create_connection')
        self.patch(manage.recovery_control, 'installed_current', return_value=True)
        if missing_media: self.rows = [c for c in self.rows if c['Id'] in ('postgres-current', 'redis-current')]
        calls = []; renders = [0]
        def run(args, **kwargs):
            calls.append(args)
            if args[:3] == ['docker', 'volume', 'ls']: return '\n'.join(v['name'] for v in self.model['volumes'].values())
            if args[:3] == ['docker', 'volume', 'inspect']: return json.dumps([self.volume])
            if args[:3] == ['docker', 'image', 'inspect']: return json.dumps([{'Id': 'sha256:' + args[3], 'Config': {}}])
            if args[:2] == ['docker', 'run']: return json.dumps(self.dep['startup_scripts_sha256'])
            if args[:2] == ['docker', 'stop']:
                for c in self.rows:
                    if c['Id'] in args[4:]: c['State']['Running'] = False
                return ''
            if args[:2] == ['docker', 'start']: return self.start(args)
            if args[:2] != ['docker', 'compose']: raise AssertionError(args)
            if args[-3:] == ['config', '--format', 'json']:
                renders[0] += 1
                model = copy.deepcopy(self.model)
                if drift and renders[0] > 1: model['services']['web']['image'] = 'unexpected-new-tag'
                return json.dumps(model)
            if 'build' in args:
                if fail_build: raise RuntimeError('Build failed')
                return ''
            if 'up' in args:
                self.assertIn('--no-start', args); self.assertIn('--no-deps', args); self.assertIn('--no-build', args)
                self.assertNotIn('postgres', args); self.assertNotIn('redis', args)
                document = json.loads(Path(args[args.index('-f') + 1]).read_text())
                self.assertTrue(all(v['external'] for v in document['volumes'].values()))
                if fail_create: raise RuntimeError('Interrupted container creation')
                original = test_nas_media_runtime.test_nas_storage.StorageTests(); original.setUp()
                self.rows = [c for c in self.rows if c['Id'] in ('postgres-current', 'redis-current')]
                for c in original.rows:
                    old = c['Id']; c['Id'] = 'created-' + old; c['State']['Running'] = False
                    c['State']['Health'] = {'Status': 'healthy'}
                    self.rows.append(c); self.mountinfo[c['Id']] = original.mountinfo[old]
                if pause_after_create: self.policy['suspended'] = True
                return ''
            raise AssertionError(args)
        self.patch(manage, 'run', side_effect=run)
        self.patch(deploy, 'run_logged', side_effect=lambda args, output, filename: run(args))
        if drift or fail_build or fail_create or pause_after_create:
            with self.assertRaises(RuntimeError): deploy.recreate(manage, self.profile, build=build)
        else: deploy.recreate(manage, self.profile, build=build)
        records = list(target.glob('*/execution.json'))
        self.assertEqual(len(records), 1)
        return calls, json.loads(records[0].read_text())

    def test_controlled_rebuild_only_recreates_media_preserving_existing_databases(self):
        calls, receipt = self.simulate(build=True)
        self.assertEqual(receipt['phase'], 'running_on_nas')
        self.assertTrue(receipt['business_acceptance_pending']); self.assertFalse(receipt['source_deleted'])
        self.assertTrue(any('build' in c for c in calls))
        forbidden = {'down', 'rm', 'prune', 'migrate', 'bootstrap_admin', 'chmod'}
        self.assertFalse(any(forbidden.intersection(c) for c in calls))
        self.assertEqual({c['Id'] for c in self.rows if c['Id'].endswith('-current')}, {'postgres-current', 'redis-current'})

    def test_removed_media_containers_are_recreated_without_starting_a_new_database(self):
        calls, receipt = self.simulate(missing_media=True)
        self.assertEqual(receipt['phase'], 'running_on_nas')
        self.assertFalse(any(c[:2] == ['docker', 'stop'] for c in calls))

    def test_build_failure_does_not_stop_live_services(self):
        calls, receipt = self.simulate(build=True, fail_build=True)
        self.assertFalse(any(c[:2] == ['docker', 'stop'] or 'up' in c for c in calls))
        self.assertEqual(receipt['phase'], 'failed_or_partial')

    def test_image_tag_changed_during_prepare_is_not_silently_adopted(self):
        calls, receipt = self.simulate(drift=True)
        self.assertFalse(any(c[:2] == ['docker', 'stop'] or 'up' in c for c in calls))
        self.assertEqual(receipt['phase'], 'failed_or_partial')

    def test_create_failure_leaves_durable_block_on_boot_recovery(self):
        calls, receipt = self.simulate(fail_create=True)
        self.assertEqual(receipt['failed_phase'], 'creating_media')
        self.assertEqual(runtime.read_record(manage)['maintenance_report'], receipt['report_directory'])
        with self.assertRaisesRegex(RuntimeError, '维护尚未完成'): manage.recover(self.profile, automatic=True)
        self.assertFalse(any(c[:2] == ['docker', 'start'] for c in calls))

    def test_pause_after_creation_blocks_even_the_first_maintenance_start(self):
        calls, receipt = self.simulate(pause_after_create=True)
        self.assertEqual(receipt['failed_phase'], 'media_created')
        self.assertEqual(runtime.read_record(manage)['maintenance_report'], receipt['report_directory'])
        self.assertFalse(any(c[:2] == ['docker', 'start'] for c in calls))

    def test_compose_offline_roundtrip_preserves_literal_dollars_in_private_snapshot(self):
        if not shutil.which('docker'): self.skipTest('Docker Compose CLI unavailable')
        version = subprocess.run(['docker', 'compose', 'version'], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if version.returncode: self.skipTest('Docker Compose CLI unavailable')
        source = Path(self.tmp.name) / 'input.json'
        token = 'secret$$VALUE $${NOT_AN_ENV_REFERENCE} $$$$double'
        for service in self.model['services'].values():
            service.setdefault('environment', {})['MX_SYNTHETIC_TOKEN'] = token
        self.model['services']['gateway']['command'] = ['echo', token]
        source.write_text(json.dumps(self.model))
        def render(path):
            result = subprocess.run(['docker', 'compose', '--project-directory', self.tmp.name,
                '-f', str(path), 'config', '--format', 'json'], check=True,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
            return json.loads(result.stdout)
        self.model = render(source)  # Real Compose normalization, no daemon calls.
        before = copy.deepcopy(self.model)
        calls, receipt = self.simulate()
        after = render(Path(receipt['report_directory']) / 'compose.private.json')
        for name in before['services']:
            self.assertEqual(after['services'][name]['environment']['MX_SYNTHETIC_TOKEN'], token)
        self.assertEqual(after['services']['gateway']['command'], before['services']['gateway']['command'])
        self.assertTrue(all(v['external'] for v in after['volumes'].values()))

    def test_routes_require_maintenance_and_part2_is_not_implicitly_supported(self):
        self.assertEqual(catalog.route(['infra', 'deployment', 'check'], manage.CONFIG), ['media-deploy-check', 'part1'])
        for args in (['infra', 'deployment', 'recreate'], ['infra', 'deployment', 'recreate', '--maintenance', '--build']):
            parsed = manage.parser().parse_args(catalog.route(args, manage.CONFIG))
            if not parsed.maintenance:
                with self.assertRaises(RuntimeError): manage.task_command(parsed.action, self.profile, parsed)
            else:
                command = manage.task_command(parsed.action, self.profile, parsed)
                self.assertEqual(command[-2:], ['--maintenance', '--build'])
        with self.assertRaises(RuntimeError): catalog.route(['delta', 'deployment', 'recreate'], manage.CONFIG)

    def test_build_failure_output_is_kept_private_and_not_lost(self):
        folder = os.open(self.tmp.name, manage.DIR_FLAGS)
        try:
            with self.assertRaisesRegex(RuntimeError, 'build.log'):
                deploy.run_logged([sys.executable, '-c', 'import sys; print("private diagnostic"); sys.exit(1)'], folder, 'build.log')
        finally: os.close(folder)
        path = Path(self.tmp.name) / 'build.log'
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertIn('private diagnostic', path.read_text())


if __name__ == '__main__': unittest.main()
