"""Real union/file receipts with an isolated Docker boundary. No server access."""
import copy
import json
import os
from pathlib import Path
import unittest
from unittest import mock

import test_nas_delta_migration as fixtures
import catalog
import cutover
import manage
import precopy
import recovery
import release
from projects import delta_copy as media
from projects import delta_migration as review
from projects import delta_runtime as runtime
from projects import delta_switch as switch
from projects import infra_deploy, infra_services, infra_storage


class DeltaSwitchTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.DeltaMigrationTests(); self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        f = self.fixture; self.media = f.fixture
        self.manager, self.profile = f.manager, f.profile
        self.stack = self.media.stack
        for c in f.rows:
            c['HostConfig']['RestartPolicy'] = {'Name': 'unless-stopped', 'MaximumRetryCount': 0}
            # Official nginx images use QUIT; Python images leave the Docker
            # default TERM unset. Exercise actual inspect-style metadata.
            if self.name(c) == 'gateway': c['Config']['StopSignal'] = 'SIGQUIT'
        websearch = f.add_websearch()
        websearch['HostConfig']['Tmpfs'] = {'/tmp': 'size=64m,noexec,nosuid'}
        f.model['services']['websearch']['tmpfs'] = ['/tmp:size=64m,noexec,nosuid']
        self.stack.enter_context(mock.patch.object(review, 'local_file', return_value=(
            b'/usr/local/lib/mx-static-nas/current/scripts/nas/release.py\ncompose mx-nas-mode\n'
            b'compose mx-nas-check\nfind /app/media -path /app/media/data_hub_raw_media -prune\n')))
        self.prepared = f.prepare()['report_directory']
        self.prepared_bytes = {p: p.read_bytes() for p in Path(self.prepared).iterdir()}
        self.orig = copy.deepcopy(f.rows)
        self.commands = []
        self.root = self.media.root / 'switch'; self.root.mkdir()
        self.auto = self.media.root / 'auto'; self.auto.mkdir(mode=0o700)
        self.manager.AUTO_DIR = str(self.auto)
        self.manager.recovery_control = recovery
        self.policy = {'schema': 1, 'mode': 'migrated', 'enabled_parts': [], 'disabled_parts': [], 'suspended': False}
        self.manager.auto_config.side_effect = lambda: dict(self.policy)
        self.stack.enter_context(mock.patch.object(switch, 'ROOT', str(self.root)))
        self.stack.enter_context(mock.patch.object(runtime, 'REPORT_ROOT', str(self.root)))
        self.stack.enter_context(mock.patch.object(recovery, 'installed_current', return_value=True))
        self.stack.enter_context(mock.patch.object(infra_services.socket, 'create_connection'))
        self.stack.enter_context(mock.patch.object(infra_storage, 'collect', side_effect=self.inspection))
        self.create = self.stack.enter_context(mock.patch.object(infra_deploy, 'run_logged', side_effect=self.create_containers))
        self.http = self.stack.enter_context(mock.patch.object(cutover.Cutover, 'http_probe'))
        self.manager.run.side_effect = self.fake_run
        self.volumes = {m['Name']: {'Name': m['Name'], 'Driver': 'local', 'Options': None}
                        for c in f.rows for m in c['Mounts'] if m['Type'] == 'volume'}
        self.nfs = {'Name': media.NFS_VOLUME, 'Driver': 'local', 'Options': infra_storage.storage_spec(self.profile)[2]}
        # New media created since online copy must join the stopped-writer sync.
        self.late = self.media.source / 'video/late.mp4'; self.late.write_bytes(b'media' * 2048)

    def name(self, c): return c['Config']['Labels']['com.docker.compose.service']

    def inspection(self, manager, profile, containers=None):
        rows = copy.deepcopy(self.fixture.rows if containers is None else containers)
        table = {}
        for c in rows:
            if self.name(c) in precopy.SERVICES and c['State']['Running']:
                table[c['Id']] = ('1 0 0:1 / / rw - overlay overlay rw\n'
                    '3 1 0:700 / {} {} - nfs {} rw,hard,vers=3,addr=192.168.1.3\n').format(
                        media.RAW, 'ro' if self.name(c) == 'gateway' else 'rw', self.nfs['Options']['device'])
        return rows, self.volumes.get(media.NFS_VOLUME), table

    def fake_run(self, args, **kwargs):
        self.commands.append(args)
        if args == ['findmnt', '-rn', '-T', str(self.root), '-o', 'FSTYPE']: return 'xfs'
        if args[:3] == ['docker', 'volume', 'ls']: return '\n'.join(self.volumes)
        if args[:3] == ['docker', 'volume', 'inspect']: return json.dumps([self.volumes[n] for n in args[3:]])
        if args[:3] == ['docker', 'volume', 'create']:
            self.assertEqual(args[-1], media.NFS_VOLUME)
            self.assertIn('device=' + self.nfs['Options']['device'], args)
            self.volumes[media.NFS_VOLUME] = self.nfs
            return media.NFS_VOLUME
        if args[:2] == ['docker', 'run']:
            self.assertIn('--network=none', args); self.assertIn('--entrypoint', args)
            self.assertIn('sha256:web', args)
            if 'root_4k_write_read' in args[-2]:
                return json.dumps({'docker_nfs_mount': True, 'same_target_inode': True, 'root_4k_write_read': True})
            return '{"nfs_identity_passed":true}'
        if args[:2] == ['docker', 'stop']:
            record = runtime.read_record(self.manager)
            self.assertEqual(record['phase'], 'maintenance')  # Must persist BEFORE the first stop.
            self.assertEqual(args[2:4], ['-t', '-1'])
            for cid in args[4:]:
                c = next(c for c in self.fixture.rows if c['Id'] == cid)
                self.assertIn(self.name(c), precopy.SERVICES)
                c['State'].update(Running=False, Pid=0, ExitCode=0)
            return ''
        if args[:2] == ['docker', 'start']:
            record = runtime.read_record(self.manager)
            checkpoint = json.loads((Path(record['source_report']) / 'execution.json').read_text())
            self.assertTrue(checkpoint['nas_may_have_writes'])
            for cid in args[2:]:
                c = next(c for c in self.fixture.rows if c['Id'] == cid)
                self.assertIn(self.name(c), precopy.SERVICES)
                c['State'].update(Running=True, Pid=900 + len(self.commands), StartedAt='new')
                c['State']['Health'] = {'Status': 'healthy'}
            return ''
        if args[:2] == ['docker', 'exec'] and 'write_read_rename_passed' in args[6]:
            self.assertNotIn('-u', args)  # Application default identity, never root substitution.
            return json.dumps({k: True for k in ('effective_read', 'effective_write', 'effective_search',
                                                'write_read_rename_passed', 'cleanup_passed')})
        return self.fixture.fake_run(args)

    def create_containers(self, command, output, name):
        self.commands.append(command)
        self.assertEqual(set(command[-10:]), precopy.SERVICES)
        for flag in ('--no-deps', '--no-start', '--no-build', '--force-recreate', '--remove-orphans=false'):
            self.assertIn(flag, command)
        self.assertEqual(command[command.index('-p') + 1], media.PROJECT)
        self.assertNotIn('down', command)
        fd = os.open('compose.nas.override.json', os.O_RDONLY, dir_fd=output)
        with os.fdopen(fd) as stream: overlay = json.load(stream)
        for c in self.fixture.rows:
            n = self.name(c)
            if n not in precopy.SERVICES: continue
            self.assertFalse(c['State']['Running'])
            c['Id'] = 'new-' + n
            c['State'].update(Running=False, Pid=0, StartedAt='0001-01-01T00:00:00Z')
            c['Mounts'].append({'Type': 'volume', 'Name': media.NFS_VOLUME,
                'Source': '/data/docker/volumes/' + media.NFS_VOLUME + '/_data', 'Destination': media.RAW, 'RW': n != 'gateway'})
            c['HostConfig']['Mounts'] = [{'Type': 'volume', 'Source': media.NFS_VOLUME,
                'Target': media.RAW, 'ReadOnly': n == 'gateway', 'VolumeOptions': {'NoCopy': True}}]
            change = overlay['services'][n]
            if 'command' in change: c['Config']['Cmd'] = change['command']
            env = dict(v.split('=', 1) for v in c['Config']['Env']); env.update(change.get('environment', {}))
            c['Config']['Env'] = [k + '=' + v for k, v in env.items()]

    def execute(self, path=None, resume=False):
        return switch.execute(self.manager, self.profile, path or self.prepared, resume)

    def current_report(self): return str(next(self.root.glob('delta-*')))

    def test_end_to_end_preserves_databases_auxiliary_source_and_nas_only_files(self):
        state = self.execute()
        self.assertEqual(state['phase'], 'running_on_nas')
        self.assertTrue(state['nas_may_have_writes']); self.assertTrue(state['final_sync_passed'])
        self.assertFalse(state['source_deleted']); self.assertFalse(state['reclaim_ready'])
        self.assertTrue(state['business_acceptance_pending'])
        self.assertEqual((self.media.target / 'video/late.mp4').read_bytes(), self.late.read_bytes())
        self.assertEqual(self.media.keep.read_bytes(), b'nas-only')
        for c in self.orig:
            if self.name(c) not in precopy.SERVICES:
                self.assertEqual(c, next(r for r in self.fixture.rows if self.name(r) == self.name(c)))
        for p, data in self.prepared_bytes.items(): self.assertEqual(p.read_bytes(), data)
        self.assertEqual((self.media.job / precopy.MARKER).read_bytes(), self.media.before)
        record = runtime.read_record(self.manager)
        self.assertEqual(record['phase'], 'running_on_nas'); self.assertNotIn('maintenance_report', record)
        self.assertNotIn('private-value', json.dumps(record)); self.assertNotIn('new-web', json.dumps(record))
        self.http.assert_called_once()
        self.assertEqual(len([c for c in self.commands if c[:2] == ['docker', 'stop']]), 3)
        self.assertEqual(len([c for c in self.commands if c[:2] == ['docker', 'start']]), 10)
        before = len(self.commands)
        infra_services.recover(self.manager, self.profile)
        self.assertEqual(len(self.commands), before)  # Running services untouched.
        with self.assertRaisesRegex(RuntimeError, 'authority exists'): self.execute()

    def test_mount_list_order_change_between_inspects_allows_complete_switch(self):
        name = 'worker-agent-interactive'
        row = next(c for c in self.fixture.rows if self.name(c) == name)
        volume = media.PROJECT + '_claude_sessions'
        row['Mounts'].append({'Type': 'volume', 'Name': volume,
                             'Source': '/data/docker/volumes/' + volume + '/_data',
                             'Destination': '/root/.claude/projects', 'RW': True})
        self.fixture.model['volumes']['claude_sessions'] = {'name': volume}
        self.fixture.model['services'][name]['volumes'].append(
            {'type': 'volume', 'source': 'claude_sessions', 'target': '/root/.claude/projects'})
        self.volumes[volume] = {'Name': volume, 'Driver': 'local', 'Options': None}
        self.media.baseline['consumer_fingerprint'] = precopy.check_consumers(media.VOLUME, self.fixture.rows)
        self.prepared = self.fixture.prepare()['report_directory']
        before = {p: p.read_bytes() for p in Path(self.prepared).iterdir()}
        row['Mounts'].reverse()
        with mock.patch.object(switch, 'emit') as events:
            result = self.execute()
        self.assertEqual(result['phase'], 'running_on_nas')
        for p, data in before.items(): self.assertEqual(p.read_bytes(), data)
        order_events = [call.kwargs for call in events.call_args_list
                        if call.args[0] == 'nas_delta_mount_order_normalized']
        self.assertTrue(any(e['service'] == name and e['attributes_unchanged'] for e in order_events))
        self.assertTrue(self.late.exists()); self.assertEqual(self.media.keep.read_bytes(), b'nas-only')

    def writer_operation(self):
        op = object.__new__(switch.Switch)
        op.old = {self.name(c): copy.deepcopy(c) for c in self.orig}
        op.state = {}
        rows = copy.deepcopy(op.old)
        op.rows = mock.Mock(return_value=rows)
        return op, rows

    def test_writer_guard_keeps_every_mount_attribute_significant(self):
        for key, value in (('Name', 'other-volume'), ('Source', '/other-ssd'),
                           ('Destination', '/different-target'), ('RW', False), ('Type', 'bind'),
                           ('Mode', 'ro'), ('Propagation', 'rshared'), ('Driver', 'other-driver')):
            with self.subTest(field=key):
                op, rows = self.writer_operation()
                rows['worker-agent-interactive']['Mounts'][0][key] = value
                with mock.patch.object(switch, 'emit') as events:
                    with self.assertRaisesRegex(RuntimeError, 'worker-agent-interactive; fields: Mounts'):
                        op.writer_guard()
                events.assert_called_once_with('nas_delta_writer_changed',
                    service='worker-agent-interactive', changed_fields=['Mounts'], phase='preflight')
        self.assertFalse(self.commands)

    def test_writer_guard_preserves_config_order_and_reports_only_field_names(self):
        for section, field in (('Config', 'Env'), ('Config', 'Cmd'), ('HostConfig', 'Mounts')):
            with self.subTest(section=section, field=field):
                op, rows = self.writer_operation()
                values = ['first-secret-value', 'second-secret-value']
                op.old['worker'][section][field] = values
                rows['worker'][section][field] = list(reversed(values))
                with mock.patch.object(switch, 'emit') as events:
                    with self.assertRaises(RuntimeError) as error: op.writer_guard()
                self.assertIn(section + '.' + field, str(error.exception))
                self.assertNotIn('secret-value', str(error.exception) + repr(events.call_args_list))
                self.assertEqual(events.call_args.kwargs['changed_fields'], [section + '.' + field])
        op, rows = self.writer_operation()
        rows['worker']['Config']['AddedNullField'] = None
        with self.assertRaisesRegex(RuntimeError, 'Config.AddedNullField'): op.writer_guard()

    def test_writer_guard_rejects_duplicate_targets_even_when_both_sides_match(self):
        op, rows = self.writer_operation()
        for view in (op.old, rows):
            view['worker']['Mounts'].append(copy.deepcopy(view['worker']['Mounts'][0]))
        with self.assertRaisesRegex(RuntimeError, 'ambiguous actual mount destinations'): op.writer_guard()

    def test_writer_guard_still_rejects_new_container_image_and_live_restart(self):
        for field in ('Id', 'Image'):
            op, rows = self.writer_operation()
            rows['worker'][field] += '-changed'
            with self.assertRaisesRegex(RuntimeError, 'worker; fields: ' + field): op.writer_guard()
        for field, value in (('Pid', 123456), ('StartedAt', 'restarted')):
            op, rows = self.writer_operation()
            rows['worker']['State'][field] = value
            with self.assertRaisesRegex(RuntimeError, 'Original SSD writer restarted: worker'): op.writer_guard()

    def test_default_and_numeric_signals_are_reviewed_without_mutating_metadata(self):
        rows = {self.name(c): copy.deepcopy(c) for c in self.orig}
        for value in (None, '', 'SIGTERM', '15'):
            with self.subTest(worker_signal=value):
                rows['worker']['Config']['StopSignal'] = value
                before = copy.deepcopy(rows)
                switch.stop_policy(rows)
                self.assertEqual(rows, before)
        rows['gateway']['Config']['StopSignal'] = '3'
        switch.stop_policy(rows)
        self.assertEqual(rows['gateway']['Config']['StopSignal'], '3')

    def test_worker_quit_and_unknown_signals_still_refuse_with_service_diagnostic(self):
        for service, signal in (('worker', 'SIGQUIT'), ('worker-agent-short', '3'),
                                ('web', 'SIGQUIT'), ('gateway', 'SIGKILL'), ('beat', 'SIGUSR1')):
            with self.subTest(service=service, signal=signal):
                rows = {self.name(c): copy.deepcopy(c) for c in self.orig}
                rows[service]['Config']['StopSignal'] = signal
                with self.assertRaises(RuntimeError) as error: switch.stop_policy(rows)
                self.assertIn(service, str(error.exception)); self.assertIn(signal, str(error.exception))
                self.assertNotIn('private-value', str(error.exception))
        rows = {self.name(c): copy.deepcopy(c) for c in self.orig}
        rows['gateway']['Config']['StopSignal'] = 'SIGQUIT'
        rows['gateway']['Config']['Cmd'] = ['another-server']
        with self.assertRaisesRegex(RuntimeError, 'gateway'): switch.stop_policy(rows)

    def test_unreviewed_worker_stop_is_refused_before_nfs_creation_or_service_stop(self):
        next(c for c in self.fixture.rows if self.name(c) == 'worker')['Config']['StopSignal'] = 'SIGQUIT'
        before = copy.deepcopy(self.fixture.rows)
        self.prepared = self.fixture.prepare()['report_directory']
        with mock.patch.object(switch, 'emit') as events:
            with self.assertRaisesRegex(RuntimeError, 'worker.*SIGQUIT'): self.execute()
        failed = next(call.kwargs for call in events.call_args_list if call.args[0] == 'nas_delta_switch_failed')
        self.assertTrue(failed['preflight_only'])
        self.assertEqual(failed['next_action'], 'retry_switch_after_fix')
        self.assertIsNone(failed['report_directory'])
        self.assertFalse((self.auto / runtime.RECORD).exists())
        self.assertNotIn(media.NFS_VOLUME, self.volumes)
        self.assertEqual(self.fixture.rows, before)
        self.assertTrue(all(c['State']['Running'] for c in self.fixture.rows))
        self.assertFalse(any(c[:2] in (['docker', 'stop'], ['docker', 'run']) for c in self.commands))
        self.create.assert_not_called()

    def test_preflight_report_is_not_resumable_and_same_preparation_can_retry_switch(self):
        with mock.patch.object(switch.files, 'union_plan', side_effect=RuntimeError('injected online preflight')), \
                mock.patch.object(switch, 'emit') as events:
            with self.assertRaisesRegex(RuntimeError, 'injected online preflight'): self.execute()
        report = Path(self.current_report())
        saved = {p: p.read_bytes() for p in report.iterdir() if p.is_file()}
        self.assertFalse((report / 'execution.json').exists())
        self.assertFalse((self.auto / runtime.RECORD).exists())
        self.assertEqual(self.fixture.rows, self.orig)
        failed = next(call.kwargs for call in events.call_args_list if call.args[0] == 'nas_delta_switch_failed')
        self.assertEqual(failed['phase'], 'preflight'); self.assertTrue(failed['preflight_only'])
        self.assertEqual(failed['next_action'], 'retry_switch_after_fix')
        with self.assertRaisesRegex(RuntimeError, 'registration missing'): self.execute(str(report), resume=True)
        self.assertEqual(self.execute()['phase'], 'running_on_nas')
        for p, data in saved.items(): self.assertEqual(p.read_bytes(), data)
        for p, data in self.prepared_bytes.items(): self.assertEqual(p.read_bytes(), data)
        self.assertEqual(sum(c[:3] == ['docker', 'volume', 'create'] for c in self.commands), 1)

    def test_partial_registration_write_is_not_labelled_safe_to_repeat_switch(self):
        def begin_then_fail(*args):
            original(*args)
            raise RuntimeError('injected registration fsync uncertainty')
        original = runtime.begin
        with mock.patch.object(runtime, 'begin', side_effect=begin_then_fail), mock.patch.object(switch, 'emit') as events:
            with self.assertRaisesRegex(RuntimeError, 'injected registration'): self.execute()
        failed = next(call.kwargs for call in events.call_args_list if call.args[0] == 'nas_delta_switch_failed')
        self.assertFalse(failed['preflight_only']); self.assertEqual(failed['next_action'], 'inspect_execution')
        self.assertEqual(runtime.read_record(self.manager)['phase'], 'maintenance')
        self.assertEqual(self.fixture.rows, self.orig)
        self.assertEqual(self.execute(self.current_report(), resume=True)['phase'], 'running_on_nas')

    def test_failure_after_stop_blocks_release_and_boot_but_exact_resume_finishes(self):
        with mock.patch.object(switch.files, 'final_union', side_effect=RuntimeError('injected final sync failure')):
            with self.assertRaisesRegex(RuntimeError, 'injected'): self.execute()
        report = self.current_report()
        self.assertEqual(runtime.read_record(self.manager)['phase'], 'maintenance')
        with self.assertRaisesRegex(RuntimeError, 'unfinished'): runtime.maintenance_guard(self.manager)
        with self.assertRaises(RuntimeError): infra_services.recover(self.manager, self.profile)
        self.assertTrue(self.late.exists()); self.create.assert_not_called()
        self.assertEqual(self.execute(report, resume=True)['phase'], 'running_on_nas')

    def test_no_final_ssd_copy_on_resume_after_nas_started(self):
        with mock.patch.object(switch.Switch, 'finish', side_effect=RuntimeError('probe timed out')):
            with self.assertRaisesRegex(RuntimeError, 'probe timed out'): self.execute()
        report = self.current_report()
        with mock.patch.object(switch.files, 'final_union', side_effect=AssertionError('must not recopy live NAS')):
            self.assertEqual(self.execute(report, resume=True)['phase'], 'running_on_nas')

    def test_partial_creation_never_starts_mixed_containers_or_repeats_source_copy(self):
        self.create.side_effect = RuntimeError('partial create')
        with self.assertRaisesRegex(RuntimeError, 'partial create'): self.execute()
        with mock.patch.object(switch.files, 'final_union', side_effect=AssertionError('must not recopy')):
            with self.assertRaisesRegex(RuntimeError, 'Creation may be partial'): self.execute(self.current_report(), resume=True)
        self.assertFalse(any(c[:2] == ['docker', 'start'] for c in self.commands))

    def test_config_drift_rejects_before_any_stop_or_volume_creation(self):
        self.fixture.input_hashes.return_value = {'env': 'changed'}
        with self.assertRaisesRegex(RuntimeError, 'changed after preparation'): self.execute()
        self.assertFalse(any(c[:2] in (['docker', 'stop'], ['docker', 'run']) for c in self.commands))
        self.assertNotIn(media.NFS_VOLUME, self.volumes)

    def test_bad_volume_definition_never_replaced_and_keeps_writers_running(self):
        self.volumes[media.NFS_VOLUME] = dict(self.nfs, Options={})
        with self.assertRaisesRegex(RuntimeError, 'NFS volume differs'): self.execute()
        self.assertTrue(all(c['State']['Running'] for c in self.fixture.rows))
        self.assertFalse((self.auto / runtime.RECORD).exists())

    def test_source_content_conflict_never_overwrites_nas_and_stops_before_maintenance(self):
        (self.media.target / 'video/late.mp4').write_bytes(b'different')
        with self.assertRaises(RuntimeError): self.execute()
        self.assertEqual((self.media.target / 'video/late.mp4').read_bytes(), b'different')
        self.assertFalse((self.auto / runtime.RECORD).exists())
        self.assertFalse(any(c[:2] == ['docker', 'stop'] for c in self.commands))

    def test_missing_registration_no_recovery_or_ssd_release_fallback(self):
        self.assertEqual(release.select({'parts': {'part2': self.profile}}, self.fixture.model)[1], 'nas')
        with self.assertRaisesRegex(RuntimeError, 'registration missing'): infra_services.recover(self.manager, self.profile)
        self.assertFalse(self.commands)
        with self.assertRaises(RuntimeError): runtime.contract(self.manager, manage.profiles()['part1'])
        with self.assertRaises(RuntimeError): catalog.route(['delta', 'cleanup', '--business-accepted'], manage.CONFIG)

    def test_resume_requires_explicit_flags_and_only_exact_delta_paths(self):
        args = manage.parser().parse_args(['delta-migration-switch', 'part2', self.prepared])
        with self.assertRaisesRegex(RuntimeError, '--maintenance --write-test'):
            manage.task_command('delta-migration-switch', self.profile, args)
        for wrong in ('/tmp/anything', self.prepared + '/..', manage.profiles()['part1']['report']):
            with self.assertRaises(RuntimeError): switch.validate_path(wrong)
        self.assertEqual(catalog.route(['delta', 'migration', 'switch', self.prepared, '--maintenance', '--write-test'], manage.CONFIG),
                         ['delta-migration-switch', 'part2', self.prepared, '--maintenance', '--write-test'])

    def test_recreated_mount_or_application_identity_drift_never_starts(self):
        def wrong_user(*args):
            self.create_containers(*args)
            next(c for c in self.fixture.rows if self.name(c) == 'web')['Config']['User'] = 'wrong'
        self.create.side_effect = wrong_user
        with self.assertRaisesRegex(RuntimeError, 'launch/data mounts differ'): self.execute()
        self.assertFalse(any(c[:2] == ['docker', 'start'] for c in self.commands))
        self.assertEqual(runtime.read_record(self.manager)['phase'], 'maintenance')

    def test_database_restart_during_media_start_blocks_remaining_starts(self):
        original = self.fake_run
        def run(args, **kwargs):
            result = original(args, **kwargs)
            if args[:2] == ['docker', 'start']:
                next(c for c in self.fixture.rows if self.name(c) == 'postgres')['State']['Pid'] += 1
            return result
        self.manager.run.side_effect = run
        with self.assertRaisesRegex(RuntimeError, 'Database/queue/auxiliary changed'): self.execute()
        self.assertEqual(len([c for c in self.commands if c[:2] == ['docker', 'start']]), 1)

    def test_current_delta_release_appends_nas_and_allows_new_ordinary_volume(self):
        state = self.execute()
        model = copy.deepcopy(self.fixture.model)
        overlay = json.loads((Path(state['report_directory']) / 'compose.nas.override.json').read_text())
        model['volumes'].update(overlay['volumes'])
        model['volumes']['static_data'] = {'name': 'delta_59202_static_data'}
        self.volumes['delta_59202_static_data'] = {'Name': 'delta_59202_static_data', 'Options': None, 'Driver': 'local'}
        for v in model['volumes'].values(): v['external'] = True
        for n in precopy.SERVICES: model['services'][n]['volumes'] += overlay['services'][n]['volumes']
        model['volumes']['new_session'] = {'name': 'delta_59202_new_session', 'external': False}
        model['services']['web']['volumes'].append({'type': 'volume', 'source': 'new_session', 'target': '/new-session'})
        env = self.media.root / 'env'; env.write_text('PRIVATE=do-not-publish\n')
        comp = self.media.root / 'compose'; comp.write_text('{}')
        options = ['-p', media.PROJECT, '--env-file', str(env), '-f', str(comp)]
        runner = mock.Mock(return_value=0)
        def read(args):
            if args[:2] == ['docker', 'info']: return json.dumps({'Name': 'mx-internal-server', 'DockerRootDir': '/data/docker'})
            if args[:2] == ['docker', 'compose']: return json.dumps(model)
            if args[:3] == ['docker', 'ps', '-aq']: return '\n'.join(c['Id'] for c in self.fixture.rows)
            if args[:2] == ['docker', 'inspect']: return json.dumps(self.fixture.rows)
            return self.fake_run(args)
        with mock.patch.object(manage, 'AUTO_DIR', str(self.auto)), \
                mock.patch.object(release.socket, 'gethostname', return_value='mx-internal-server'):
            self.assertEqual(release.execute(options, ['up', '-d', '--build'], reader=read, runner=runner), 0)
            command = runner.call_args.args[0]
            self.assertIn(str(manage.CONFIG.parent / 'part2.release.json'), command)
            self.assertNotIn(str(manage.CONFIG.parent / 'part1.release.json'), command)
            model['volumes']['postgres_data']['name'] = 'another-empty-database'
            with self.assertRaisesRegex(RuntimeError, 'protected data volume changed'):
                release.execute(options, ['up', '-d'], reader=read, runner=runner)
        self.assertEqual(runner.call_count, 1)

    def test_recovery_after_reboot_uses_current_ids_not_historical_application_files(self):
        self.execute()
        for c in self.fixture.rows:
            c['Id'] += '-redeployed'
            c['Config'].setdefault('Env', []).append('NEW_CONFIG=allowed')
            c['Image'] += '-new'
        web = next(c for c in self.fixture.rows if self.name(c) == 'web')
        web['State'].update(Running=False, Pid=0)
        self.commands.clear()
        with mock.patch.object(review, 'inputs', side_effect=AssertionError('recovery cannot read app env')):
            infra_services.recover(self.manager, self.profile, automatic=True)
        self.assertEqual([c for c in self.commands if c[:2] == ['docker', 'start']], [['docker', 'start', web['Id']]])
        self.assertFalse(any(c[:2] == ['docker', 'compose'] for c in self.commands))

    def test_docker_reinstall_missing_volume_never_creates_local_substitute(self):
        self.execute(); self.commands.clear()
        del self.volumes[media.NFS_VOLUME]
        with self.assertRaises(RuntimeError): infra_services.recover(self.manager, self.profile)
        self.assertFalse(self.commands)


if __name__ == '__main__': unittest.main()
