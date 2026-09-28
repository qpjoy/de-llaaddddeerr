"""Real immutable copy receipts; isolated Docker/Compose boundary, no server."""
import ast
import copy
import io
import json
import os
from pathlib import Path
import unittest
from unittest import mock

import test_nas_delta_copy as fixtures
from projects import delta_copy as copying
from projects import delta_migration as migration
import catalog
import cutover_prepare as prep
import manage
import precopy
import release


class DeltaMigrationTests(unittest.TestCase):
    def setUp(self):
        # Reuse the real local media/copy fixture, without inheriting its tests.
        self.fixture = fixtures.DeltaContinuationTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)
        f = self.fixture
        self.manager, self.profile = f.manager, f.profile
        self.manager.CONFIG = manage.CONFIG
        self.rows, self.model = self.deployment()
        f.baseline['consumer_fingerprint'] = precopy.check_consumers(copying.VOLUME, self.rows)
        self.report = f.prepare()
        self.receipt = copying.execute(self.manager, self.profile, self.report)
        self.attempt = self.receipt['attempt_directory']
        self.originals = {p: p.read_bytes() for p in Path(self.report).rglob('*') if p.is_file()}
        self.reports = f.root / 'migration'; self.reports.mkdir()
        f.stack.enter_context(mock.patch.object(migration, 'ROOT', str(self.reports)))
        f.stack.enter_context(mock.patch.object(precopy, 'inspect_containers', side_effect=lambda: copy.deepcopy(self.rows)))
        self.input_hashes = f.stack.enter_context(mock.patch.object(migration, 'inputs', return_value={'env': 'a' * 64}))
        f.stack.enter_context(mock.patch.object(migration, 'local_file', return_value=b'compose mx-nas-mode\ncompose mx-nas-check\n'))
        self.reference = migration.definition(self.manager, self.profile)
        self.commands = []
        self.changed_script = False
        self.drift_merged = False
        self.manager.run.side_effect = self.fake_run
        self.output = io.StringIO()
        f.stack.enter_context(mock.patch.object(migration, 'emit', side_effect=lambda event, **v: self.output.write(json.dumps(dict(v, event=event))+'\n')))

    def deployment(self):
        rows = []
        model = {'name': copying.PROJECT, 'services': {}, 'volumes': {
            'media_data': {'name': copying.VOLUME},
            'postgres_data': {'name': 'delta_59202_postgres_data'},
            'redis_data': {'name': 'delta_59202_redis_data'}}}
        for i, name in enumerate(sorted(precopy.SERVICES | set(migration.DEPENDENCIES))):
            media = name in precopy.SERVICES
            volume = copying.VOLUME if media else 'delta_59202_' + name + '_data'
            target = '/app/media' if media else migration.DEPENDENCIES[name]
            script = 'run_worker.sh' if name.startswith('worker') else 'run_' + name.replace('-', '_') + '.sh'
            cmd = ['nginx', '-g', 'daemon off;'] if name == 'gateway' else ['/app/scripts/' + script]
            labels = {'com.docker.compose.project': copying.PROJECT, 'com.docker.compose.service': name,
                      'com.docker.compose.project.working_dir': migration.APP_ROOT,
                      'com.docker.compose.project.config_files': ','.join(migration.APP_ROOT + '/' + p for p in migration.COMPOSE_FILES),
                      'com.docker.compose.project.environment_file': migration.APP_ROOT + '/' + migration.ENV_FILE,
                      'com.docker.compose.config-hash': 'hash-' + name}
            rows.append({'Id': ('%064x' % (i+1)), 'Name': '/delta_59202-' + name + '-1', 'Image': 'sha256:' + name,
                         'Config': {'Labels': labels, 'Env': ['SECRET=private-value'], 'Cmd': cmd,
                                    'Entrypoint': ['/docker-entrypoint.sh'] if name == 'gateway' else None,
                                    'WorkingDir': '/app'}, 'HostConfig': {},
                         'State': {'Running': True, 'Health': {'Status': 'healthy'}, 'Pid': i+100, 'StartedAt': 'today'},
                         'Mounts': [{'Type': 'volume', 'Name': volume, 'Source': '/data/docker/volumes/' + volume + '/_data',
                                     'Destination': target, 'RW': name != 'gateway'}]})
            model['services'][name] = {'image': 'image:' + name, 'command': cmd,
                                       'environment': {'SECRET': 'private-value'},
                                       'volumes': [{'type': 'volume', 'source': 'media_data' if media else name + '_data',
                                                    'target': target, 'read_only': name == 'gateway'}]}
        return rows, model

    def fake_run(self, args):
        self.commands.append(args)
        if args == ['findmnt', '-rn', '-T', str(self.reports), '-o', 'FSTYPE']: return 'xfs'
        prefix = migration.command()
        if args[:len(prefix)] == prefix:
            tail = args[len(prefix):]
            if tail == ['config', '--hash', '*']:
                return '\n'.join(n+' hash-'+n for n in self.model['services'])
            if tail == ['config', '--format', 'json']: return json.dumps(self.model)
            if tail[0] == '-f' and tail[2:] == ['config', '--format', 'json']:
                overlay = json.loads(Path(tail[1]).read_text())
                merged = copy.deepcopy(self.model)
                merged['volumes'].update(overlay['volumes'])
                for name, change in overlay['services'].items():
                    svc = merged['services'][name]
                    svc['image'] = change['image']
                    svc['volumes'] += change['volumes']
                    svc['environment'].update(change.get('environment', {}))
                    if 'command' in change: svc['command'] = change['command']
                if self.drift_merged: merged['services']['postgres']['environment']['SECRET'] = 'reset'
                return json.dumps(merged)
        if args[:3] == ['docker', 'image', 'inspect']:
            return json.dumps([{'Id': 'sha256:' + args[3].split(':')[1], 'Config': {}}])
        if args[:2] == ['docker', 'exec'] and args[3:6] == ['python', '-B', '-c']:
            self.assertEqual(args[6], migration.script_probe(migration.SCRIPT_NAMES))
            values = dict(self.reference['startup_scripts_sha256'])
            if self.changed_script: values['scripts/run_web.sh'] = 'f' * 64
            return json.dumps(values)
        if args[:2] == ['docker', 'diff']: return ''
        raise AssertionError('Unexpected command, possibly mutating: ' + repr(args))

    def prepare(self):
        return migration.prepare(self.manager, self.profile, self.attempt)

    def add_websearch(self):
        row = copy.deepcopy(self.rows[0])
        row.update(Id='e' * 64, Name='/delta_59202-websearch-1', Image='sha256:websearch', Mounts=[])
        row['Config']['Labels'].update({'com.docker.compose.service': 'websearch',
                                       'com.docker.compose.config-hash': 'hash-websearch'})
        row['Config']['Cmd'] = ['websearch']
        self.rows.append(row)
        self.model['services']['websearch'] = {'image': 'image:websearch', 'command': ['websearch'],
                                             'environment': {'SECRET': 'private-value'}}
        return row

    def test_mountless_websearch_is_recorded_but_never_added_to_media_override(self):
        row = self.add_websearch()
        result = self.prepare()
        self.assertTrue(result['deployment_review_passed'])
        self.assertEqual(result['auxiliary_services'], [{'service': 'websearch', 'id': row['Id'][:12],
                                                        'mounts': [], 'tmpfs': {}, 'preserved': True}])
        folder = Path(result['report_directory'])
        candidate = json.loads((folder / 'compose.nas.candidate.json').read_text())
        merged = json.loads((folder / 'compose.nas.candidate.private.json').read_text())
        self.assertNotIn('websearch', candidate['services'])
        self.assertEqual(merged['services']['websearch'], self.model['services']['websearch'])
        self.assertTrue(all(row['Id'] not in cmd for cmd in self.commands))
        self.assertFalse(result['execution_allowed'])

    def test_auxiliary_actual_mount_or_host_access_is_not_silently_accepted(self):
        row = self.add_websearch()
        for mount in ({'Type': 'volume', 'Name': copying.VOLUME, 'Destination': '/app/media'},
                      {'Type': 'bind', 'Source': '/data', 'Destination': '/host'},
                      {'Type': 'bind', 'Source': '/var/run/docker.sock', 'Destination': '/var/run/docker.sock'}):
            with self.subTest(mount=mount):
                row['Mounts'] = [mount]
                with self.assertRaisesRegex(RuntimeError, 'mount/access review: websearch'):
                    migration.select(self.rows)
        row['Mounts'] = []
        for host in ({'Privileged': True}, {'VolumesFrom': ['other']}, {'PidMode': 'host'},
                     {'CapAdd': ['SYS_ADMIN']}, {'Binds': ['/data:/host']}):
            with self.subTest(host=host):
                row['HostConfig'] = host
                with self.assertRaisesRegex(RuntimeError, 'mount/access review: websearch'):
                    migration.select(self.rows)

    def test_application_session_volume_and_gateway_bind_are_preserved(self):
        self.add_websearch()
        self.model['volumes']['claude_sessions'] = {'name': 'delta_59202_claude_sessions'}
        for row in self.rows:
            name = row['Config']['Labels']['com.docker.compose.service']
            if name == 'web' or name.startswith('worker'):
                row['Mounts'].append({'Type': 'volume', 'Name': 'delta_59202_claude_sessions',
                                     'Source': '/data/docker/volumes/delta_59202_claude_sessions/_data',
                                     'Destination': '/root/.claude/projects', 'RW': True})
                self.model['services'][name]['volumes'].append({'type': 'volume', 'source': 'claude_sessions',
                                                               'target': '/root/.claude/projects'})
            if name == 'gateway':
                # Bind mounts need not contain Docker's volume-only Name key.
                row['Mounts'].append({'Type': 'bind', 'Source': migration.APP_ROOT + '/nginx.conf',
                                     'Destination': '/etc/nginx/conf.d/default.conf', 'RW': False})
                self.model['services'][name]['volumes'].append({'type': 'bind', 'source': migration.APP_ROOT + '/nginx.conf',
                                                               'target': '/etc/nginx/conf.d/default.conf', 'read_only': True})
        self.fixture.baseline['consumer_fingerprint'] = precopy.check_consumers(copying.VOLUME, self.rows)
        result = self.prepare()
        self.assertTrue(result['deployment_review_passed'])
        merged = json.loads((Path(result['report_directory']) / 'compose.nas.candidate.private.json').read_text())
        for name in ('gateway', 'web', 'worker'):
            self.assertEqual([m for m in merged['services'][name]['volumes'] if m['target'] != copying.RAW],
                             self.model['services'][name]['volumes'])
    def test_auxiliary_model_mount_added_after_deployment_is_a_review_item(self):
        self.add_websearch()
        self.model['services']['websearch']['volumes'] = [{'type': 'volume', 'source': 'media_data', 'target': '/app/media'}]
        result = self.prepare()
        self.assertFalse(result['deployment_review_passed'])
        self.assertIn({'service': 'websearch', 'reason': 'auxiliary_mount_or_access_needs_review',
                       'fields': ['volumes']}, result['review_items'])

    def test_websearch_private_tmpfs_from_server_receipt_is_preserved(self):
        row = self.add_websearch()
        tmpfs = {'/tmp': 'size=64m,noexec,nosuid'}
        row['HostConfig']['Tmpfs'] = dict(tmpfs)
        self.model['services']['websearch']['tmpfs'] = ['/tmp:size=64m,noexec,nosuid']
        original = copy.deepcopy(self.model['services']['websearch'])
        result = self.prepare()
        self.assertTrue(result['deployment_review_passed'])
        self.assertEqual(result['review_items'], [])
        self.assertEqual(result['auxiliary_services'][0]['tmpfs'], tmpfs)
        merged = json.loads((Path(result['report_directory']) / 'compose.nas.candidate.private.json').read_text())
        self.assertEqual(merged['services']['websearch'], original)
        self.assertEqual(row['HostConfig']['Tmpfs'], tmpfs)
        self.assertFalse(result['execution_allowed'])
        self.assertTrue(all(row['Id'] not in cmd for cmd in self.commands))

    def test_auxiliary_tmpfs_media_overlap_remains_a_review_item(self):
        row = self.add_websearch()
        for target in ('/', '/app', '/app/media', copying.RAW, copying.RAW + '/video'):
            with self.subTest(target=target):
                self.model['services']['websearch']['tmpfs'] = [target + ':size=64m']
                row['HostConfig']['Tmpfs'] = {target: 'size=64m'}
                result = self.prepare()
                self.assertFalse(result['deployment_review_passed'])
                self.assertIn('auxiliary_tmpfs_overlaps_media', {r['reason'] for r in result['review_items']})

    def test_auxiliary_tmpfs_requires_both_declarations_to_match(self):
        row = self.add_websearch()
        for declared, actual in ((['/tmp:size=64m'], {}), ([], {'/tmp': 'size=64m'}),
                                 (['/tmp:size=64m,noexec,nosuid'], {'/tmp': 'size=128m,noexec,nosuid'}),
                                 (['/tmp:size=64m'], {'/cache': 'size=64m'})):
            with self.subTest(declared=declared, actual=actual):
                row['HostConfig']['Tmpfs'] = actual
                self.model['services']['websearch']['tmpfs'] = declared
                result = self.prepare()
                self.assertFalse(result['deployment_review_passed'])
                self.assertIn('auxiliary_tmpfs_differs_from_live', {r['reason'] for r in result['review_items']})

    def test_auxiliary_tmpfs_rejects_ambiguous_or_malformed_paths(self):
        for declared, actual in ((['/tmp', '/tmp'], {}), (['tmp:size=64m'], {}),
                                 (['/cache/../tmp:size=64m'], {}), (['//tmp:size=64m'], {}),
                                 ([{'target': '/tmp'}], {}), ({'/tmp': ''}, {}),
                                 ([], {'/tmp': None}), ([], ['/tmp'])):
            with self.subTest(declared=declared, actual=actual):
                self.assertEqual(migration.auxiliary_tmpfs_review({'tmpfs': declared}, {'HostConfig': {'Tmpfs': actual}}),
                                 'auxiliary_tmpfs_invalid_declaration')

    def test_tmpfs_does_not_override_persistent_mount_or_host_access_guards(self):
        row = self.add_websearch()
        row['HostConfig']['Tmpfs'] = {'/tmp': 'size=64m,noexec,nosuid'}
        self.model['services']['websearch']['tmpfs'] = ['/tmp:size=64m,noexec,nosuid']
        self.model['services']['websearch']['privileged'] = True
        result = self.prepare()
        self.assertFalse(result['deployment_review_passed'])
        self.assertIn({'service': 'websearch', 'reason': 'auxiliary_mount_or_access_needs_review',
                       'fields': ['privileged']}, result['review_items'])
        row['HostConfig']['Privileged'] = True
        with self.assertRaisesRegex(RuntimeError, 'mount/access review: websearch'): self.prepare()

    def test_auxiliary_availability_does_not_gate_media_preparation(self):
        row = self.add_websearch()
        row['State'].update(Running=False, Pid=0)
        row['State']['Health']['Status'] = 'unhealthy'
        result = self.prepare()
        self.assertTrue(result['deployment_review_passed'])
        self.assertTrue(all(row['Id'] not in cmd for cmd in self.commands))

    def test_auxiliary_change_during_preparation_cannot_publish_success(self):
        row = self.add_websearch()
        original = self.fake_run
        def drift(args):
            result = original(args)
            if args[:len(migration.command())] == migration.command() and '/compose.nas.candidate.json' in ' '.join(args):
                row['State']['Pid'] += 1
            return result
        self.manager.run.side_effect = drift
        with self.assertRaisesRegex(RuntimeError, 'changed while preparing'): self.prepare()
        self.assertFalse(list(self.reports.glob('*/review.json')))

    def test_unreviewed_duplicate_or_oneoff_service_error_identifies_object_without_env(self):
        row = self.add_websearch()
        for service, oneoff, extra, reason in [('unknown', 'False', [], 'unreviewed_service'),
                                              ('websearch', 'True', [], 'one_off'),
                                              ('websearch', 'False', [row], 'duplicate_service')]:
            with self.subTest(reason=reason):
                row['Config']['Labels'].update({'com.docker.compose.service': service,
                                               'com.docker.compose.oneoff': oneoff})
                with self.assertRaises(RuntimeError) as error: migration.select(self.rows + extra)
                self.assertIn(reason, str(error.exception))
                self.assertIn(row['Id'][:12], str(error.exception))
                self.assertNotIn('private-value', str(error.exception))

    def test_auxiliary_present_does_not_allow_missing_gateway_or_database(self):
        self.add_websearch()
        for service in ('gateway', 'postgres', 'redis'):
            with self.subTest(service=service):
                rows = [c for c in self.rows if c['Config']['Labels']['com.docker.compose.service'] != service]
                with self.assertRaisesRegex(RuntimeError, 'Missing required delta services: ' + service):
                    migration.select(rows)

    def test_read_only_preparation_preserves_receipts_and_database_config(self):
        result = self.prepare()
        self.assertTrue(result['deployment_review_passed'])
        self.assertTrue(result['candidate_merge_verified'])
        for key in ('execution_allowed', 'reclaim_ready', 'source_deleted', 'production_changed', 'nas_walk'):
            self.assertFalse(result[key])
        folder = Path(result['report_directory'])
        candidate = json.loads((folder / 'compose.nas.candidate.json').read_text())
        self.assertEqual(candidate['volumes']['mx_static_raw_media_nfs']['name'], copying.NFS_VOLUME)
        self.assertEqual(set(candidate['services']), precopy.SERVICES)
        self.assertEqual(candidate['services']['web']['command'][0], 'gunicorn')
        for name, service in candidate['services'].items():
            self.assertTrue(service['volumes'][0]['volume']['nocopy'])
            self.assertEqual(service['volumes'][0]['read_only'], name == 'gateway')
        for file in folder.iterdir(): self.assertEqual(file.stat().st_mode & 0o777, 0o600)
        for file, data in self.originals.items(): self.assertEqual(file.read_bytes(), data)
        self.assertEqual((self.fixture.job / precopy.MARKER).read_bytes(), self.fixture.before)
        self.assertTrue(self.fixture.candidate.exists())
        self.assertNotIn('private-value', self.output.getvalue())
        self.assertFalse(result['release_hook']['delta_nas_release_adapter_available'])

    def test_changed_startup_scripts_and_environment_are_review_items(self):
        self.changed_script = True
        self.model['services']['web']['environment']['SECRET'] = 'different-private-value'
        result = self.prepare()
        reasons = {r['reason'] for r in result['review_items']}
        self.assertIn('startup_scripts_changed', reasons)
        self.assertIn('environment_differs', reasons)
        self.assertFalse(result['deployment_review_passed'])
        self.assertNotIn('private-value', self.output.getvalue())

    def test_candidate_cannot_change_database_or_account_environment(self):
        self.drift_merged = True
        with self.assertRaisesRegex(RuntimeError, 'unrelated fields'): self.prepare()
        self.assertTrue(list(self.reports.glob('*/failed.json')))
        self.assertFalse(list(self.reports.glob('*/review.json')))

    def test_deployment_drift_during_read_does_not_publish_success(self):
        self.input_hashes.side_effect = [{'env': 'a'}, {'env': 'b'}]
        with self.assertRaisesRegex(RuntimeError, 'changed while preparing'): self.prepare()
        self.assertFalse(list(self.reports.glob('*/review.json')))

    def test_existing_database_identity_and_health_required(self):
        for mutate in (lambda c: c['Mounts'][0].update(Name='po_infra_postgres_data'),
                       lambda c: c['State']['Health'].update(Status='unhealthy'),
                       lambda c: c['State'].update(Running=False)):
            rows = copy.deepcopy(self.rows)
            mutate(next(c for c in rows if c['Config']['Labels']['com.docker.compose.service'] == 'postgres'))
            with self.assertRaises(RuntimeError): migration.select(rows)
        with self.assertRaises(RuntimeError): migration.select(self.rows + [self.rows[0]])

    def test_failed_partial_or_tampered_copy_receipt_is_not_adopted(self):
        file = Path(self.attempt) / 'result.json'
        original = file.read_bytes()
        for key, value in (('copied', 0), ('logical_bytes', 0), ('source_deleted', True),
                           ('phase', 'failed'), ('volume', 'po_infra_media_data')):
            receipt = json.loads(original); receipt[key] = value
            file.write_text(json.dumps(receipt))
            with self.assertRaises(RuntimeError): migration.completed_copy(self.attempt)
        file.write_bytes(original)
        started = Path(self.attempt) / 'started.json'
        data = json.loads(started.read_text()); data['plan_sha256'] = 'f' * 64
        started.write_text(json.dumps(data))
        with self.assertRaises(RuntimeError): migration.completed_copy(self.attempt)

    def test_missing_success_file_or_symlink_is_refused(self):
        file = Path(self.attempt) / 'result.json'
        saved = file.with_name('saved.json'); file.rename(saved)
        with self.assertRaises(FileNotFoundError): migration.completed_copy(self.attempt)
        file.symlink_to(saved)
        with self.assertRaises(OSError): migration.completed_copy(self.attempt)

    def test_infra_and_unreviewed_deployment_locator_are_refused(self):
        with self.assertRaises(RuntimeError): migration.definition(self.manager, manage.profiles()['part1'])
        with self.assertRaises(RuntimeError): migration.definition(self.manager, dict(self.profile, deployment_file='part1.deployment.json'))
        with self.assertRaises(RuntimeError): migration.completed_copy(self.attempt + '/../' + Path(self.attempt).name)

    def test_only_delta_read_only_route_added_and_deployment_locator_installed(self):
        self.assertEqual(catalog.route(['delta', 'migration', 'prepare', self.attempt], manage.CONFIG),
                         ['delta-migration-prepare', 'part2', self.attempt])
        with self.assertRaises(RuntimeError): catalog.route(['infra', 'migration', 'prepare', self.attempt], manage.CONFIG)
        self.assertIn('part2.deployment.json', [p.name for p in catalog.installed_files(manage.CONFIG)])
        _, mode = release.select({'parts': manage.profiles()}, self.model)
        self.assertEqual(mode, 'local')

    def test_changed_media_identity_does_not_adopt_old_copy(self):
        with mock.patch.object(copying, 'identity', return_value={'different': True}):
            with self.assertRaisesRegex(RuntimeError, 'identities/legacy marker changed'): self.prepare()
        self.assertEqual(list(self.reports.iterdir()), [])

    def test_stable_snapshot_ignores_probe_history_but_not_restarts(self):
        rows = migration.select(self.rows)
        changed = copy.deepcopy(rows)
        changed['gateway']['State']['Health']['Log'] = [{'ExitCode': 0}]
        self.assertEqual(migration.runtime_snapshot(rows), migration.runtime_snapshot(changed))
        changed['gateway']['State']['Pid'] += 1
        self.assertNotEqual(migration.runtime_snapshot(rows), migration.runtime_snapshot(changed))

    def test_probe_is_python36_compatible_and_contains_no_application_import(self):
        code = migration.script_probe(migration.SCRIPT_NAMES)
        ast.parse(code, feature_version=(3, 6))
        self.assertNotIn('django', code)
        self.assertNotIn('migrate', code)


if __name__ == '__main__': unittest.main()
