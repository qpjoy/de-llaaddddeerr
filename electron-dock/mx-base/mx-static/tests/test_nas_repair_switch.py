import contextlib
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts/nas'))
import catalog
import cutover
import cutover_prepare as prep
import manage
import precopy
from projects import infra_repair as planning
from projects import infra_repair_copy as copying
from projects import infra_repair_switch as switch
from test_nas_cutover_prepare import fixtures


def local_json(fd, name):
    # Fixture reports are owned by the non-root test user; production read_json
    # retains its root/private/no-follow checks (covered by cutover tests).
    leaf = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd)
    with os.fdopen(leaf) as stream: return json.load(stream)


class LocalFiles(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source, self.job, self.output = [self.root / n for n in ('ssd', 'job', 'report')]
        for p in (self.source, self.job, self.output): p.mkdir(mode=0o700)
        self.target = self.job / 'media'; self.target.mkdir()
        self.fds = [os.open(str(p), copying.DIR_FLAGS) for p in (self.source, self.target, self.job, self.output)]
        self.addCleanup(lambda: [os.close(fd) for fd in reversed(self.fds)])
        self.src, self.dst, self.jobfd, self.out = self.fds
        output = contextlib.redirect_stdout(io.StringIO()); output.__enter__()
        self.addCleanup(output.__exit__, None, None, None)

    def put(self, root, path, data=b'x' * 2048, mode=0o600, when=1000000000):
        file = root / path; file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(data); file.chmod(mode); os.utime(str(file), (when, when))
        return file

    def final_operation(self):
        op = mock.Mock(source=self.src, target=self.dst, job=self.jobfd, output=self.out,
                       path=str(self.output), state={'phase': 'repair_finalizing', 'reclaim_ready': False})
        def checkpoint(phase, **values): op.state.update(phase=phase, **values)
        op.checkpoint.side_effect = checkpoint
        return op


class FinalUnionTests(LocalFiles):
    def prepare_files(self):
        self.put(self.source, 'video/new.mp4')
        self.put(self.source, 'video/raw-media-x.tmp', mode=0o644)
        self.put(self.target, 'video/raw-media-x.tmp', mode=0o600)
        self.put(self.source, 'video/mtime.mp4')
        self.put(self.target, 'video/mtime.mp4', when=1000000002)
        self.put(self.target, 'video/nas-only.mp4', b'nas-authority')

    def run_final(self, op):
        with mock.patch.object(switch, 'writer_guard'), mock.patch.object(switch, 'media_guard'):
            switch.final_union(op)

    def test_stopped_union_adds_missing_and_retains_every_existing_nas_inode_and_attribute(self):
        self.prepare_files()
        source = {str(p): copying.stamp(p.stat()) for p in self.source.rglob('*')}
        retained = {str(p): copying.stamp(p.stat()) for p in self.target.rglob('*') if p.is_file()}
        op = self.final_operation(); self.run_final(op)
        self.assertEqual(op.state['phase'], 'repair_final_passed')
        self.assertTrue(op.state['final_sync_passed']); self.assertFalse(op.state['reclaim_ready'])
        self.assertEqual((self.target / 'video/new.mp4').read_bytes(), b'x' * 2048)
        for path, expected in source.items(): self.assertEqual(copying.stamp(Path(path).stat()), expected)
        for path, expected in retained.items(): self.assertEqual(copying.stamp(Path(path).stat()), expected)
        result_dir = Path(op.state['final_review'])
        result = json.loads((result_dir / 'result.json').read_text())
        self.assertEqual(result['source_manifest_sha256'], hashlib.sha256((result_dir / 'files.jsonl').read_bytes()).hexdigest())
        self.assertEqual(result['groups']['nas_only']['files'], 1)
        self.assertEqual(result['groups']['permissions_only']['files'], 1)
        self.assertEqual(result['groups']['shared_hash_same']['files'], 1)
        self.assertFalse(result['live_snapshot']); self.assertFalse(result['stopped_writer_recheck_required'])
        self.assertEqual(list(self.job.iterdir()), [self.target])
        op.command.assert_not_called(); op.stop.assert_not_called(); op.start.assert_not_called()
        op.sync.assert_not_called(); op.final_sync.assert_not_called()

    def test_external_ssd_change_during_copy_blocks_final_pass_without_deleting_additions(self):
        self.prepare_files(); op = self.final_operation(); original = copying.copy_one
        def changed(*args):
            result = original(*args)
            (self.source / 'video/raw-media-x.tmp').chmod(0o600)
            return result
        with mock.patch.object(copying, 'copy_one', side_effect=changed), self.assertRaisesRegex(RuntimeError, 'SSD changed'):
            self.run_final(op)
        op.checkpoint.assert_not_called(); op.command.assert_not_called()
        self.assertTrue((self.target / 'video/new.mp4').exists())
        self.assertEqual((self.target / 'video/nas-only.mp4').read_bytes(), b'nas-authority')

    def test_content_conflict_blocks_copy_before_staging(self):
        self.prepare_files(); self.put(self.target, 'video/mtime.mp4', b'y' * 2048, when=1000000002)
        with mock.patch.object(copying, 'copy_one') as copied, self.assertRaisesRegex(RuntimeError, 'conflicts'):
            self.run_final(self.final_operation())
        copied.assert_not_called()
        self.assertFalse((self.target / 'video/new.mp4').exists())

    def test_online_union_budget_and_missing_parents_fail_before_copy(self):
        self.put(self.source, 'new-dir/new.mp4')
        with self.assertRaisesRegex(RuntimeError, 'parent directory'):
            switch.union_plan(self.src, self.dst, self.out)
        second = self.root / 'second'; second.mkdir(); (self.target / 'new-dir').mkdir()
        fd = os.open(str(second), copying.DIR_FLAGS); self.addCleanup(os.close, fd)
        with mock.patch.object(copying, 'MAX_BYTES', 1), self.assertRaisesRegex(RuntimeError, 'budget'):
            switch.union_plan(self.src, self.dst, fd)
        self.assertFalse((self.target / 'new-dir/new.mp4').exists())


class ReceiptTests(LocalFiles):
    def setUp(self):
        super().setUp()
        self.name = 'copy-' + 'b' * 32
        self.attempt = self.output / self.name; self.attempt.mkdir(mode=0o700)
        self.path = str(self.attempt)
        self.plan = {'report_directory': str(self.output), 'manifest_sha256': 'original',
                     'groups': {'ssd_only': {'files': 5289, 'logical_bytes': 2892300834}}}
        self.result = {'phase': 'manifest_copy_complete', 'report_directory': str(self.output),
                       'attempt_directory': self.path, 'copied': 181, 'already_present': 5108,
                       'logical_bytes': 2892300834, 'production_restart': False, 'source_deleted': False, 'reclaim_ready': False}
        (self.attempt / 'started.json').write_text(json.dumps({'manifest_sha256': 'original',
                                   'report': str(self.output), 'candidates': 5289}))

    def receipt(self):
        (self.attempt / 'result.json').write_text(json.dumps(self.result))
        actual = os.fstat
        def private_root(fd):
            st = actual(fd)
            return SimpleNamespace(**dict({k: getattr(st, k) for k in dir(st) if k.startswith('st_')}, st_uid=0))
        with mock.patch.object(switch.os, 'fstat', side_effect=private_root), mock.patch.object(cutover, 'read_json', side_effect=local_json):
            return switch.completed_copy(self.out, self.name, self.path, self.plan)

    def test_exact_successful_attempt_accepted(self):
        self.assertEqual(self.receipt(), self.result)

    def test_partial_counts_different_attempt_and_changed_manifest_are_refused(self):
        original = dict(self.result)
        for change in ({'already_present': 5107}, {'copied': True}, {'logical_bytes': 0},
                       {'attempt_directory': self.path + '-other'}, {'source_deleted': True}, {'reclaim_ready': True}):
            self.result = dict(original, **change)
            with self.assertRaisesRegex(RuntimeError, 'completion receipt'): self.receipt()
        self.result = original; self.plan['manifest_sha256'] = 'changed'
        with self.assertRaisesRegex(RuntimeError, 'completion receipt'): self.receipt()

    def test_ambiguous_success_and_failure_is_not_accepted(self):
        (self.attempt / 'failed.json').write_text('{}')
        with self.assertRaisesRegex(RuntimeError, 'failure receipt'): self.receipt()

    def test_failed_or_arbitrary_attempt_path_cannot_be_selected(self):
        good = planning.REPORT_ROOT + '/infra-' + 'a' * 32 + '/' + self.name
        self.assertEqual(switch.split_attempt(good)[1], self.name)
        for path in (good + '/', good + '/../copy-' + 'c' * 32, '/tmp/' + self.name, good.rsplit('/', 1)[0]):
            with self.assertRaises(RuntimeError): switch.split_attempt(path)


class PreparationTests(LocalFiles):
    def test_new_report_uses_current_images_and_keeps_old_reports_and_auth_unchanged(self):
        profile = manage.profiles()['part1']
        history = self.root / 'history'; history.mkdir()
        (history / 'execution.json').write_text('historical immutable evidence')
        history_bytes = (history / 'execution.json').read_bytes()
        consumers, original = fixtures()
        for name, c in consumers.items():
            c['Image'] = planning.GATEWAY_IMAGE if name == 'gateway' else planning.APP_IMAGE
            c['HostConfig'] = {'RestartPolicy': {'Name': 'unless-stopped'}}
            c['State']['Health'] = {'Status': 'healthy'}
        fingerprint, records = precopy.check_consumers(prep.VOLUME, list(consumers.values()), True)
        baseline = {'config_files_sha256': {'config': 'current'}, 'consumer_fingerprint': fingerprint,
                    'consumers': records, 'databases': {'postgres': 'pg', 'redis': 'rd'}}
        repair_path = planning.REPORT_ROOT + '/infra-' + 'a' * 32
        marker = {'job_id': 'historic-job', 'target_inode': os.fstat(self.dst).st_ino,
                  'source_identity': precopy.source_identity(self.src), 'phase': 'cutover_running_on_nas',
                  'cutover_report': profile['report']}
        state = {'schema': 1, 'phase': 'running_on_nas', 'volume': prep.VOLUME, 'report_directory': profile['report'],
                 'nas_may_have_writes': True, 'reclaim_ready': False, 'final_sync_passed': True,
                 'new_ids': {n: 'historical-' + n for n in prep.SERVICES}, 'databases': baseline['databases']}
        plan = {'schema': 1, 'phase': 'prepared', 'report_directory': repair_path, 'historical_report': profile['report'],
                'volume': prep.VOLUME, 'nfs_volume': prep.NFS_VOLUME, 'application_image': planning.APP_IMAGE,
                'gateway_image': planning.GATEWAY_IMAGE, 'execution_allowed': False, 'reclaim_ready': False,
                'nas_marker': marker, 'historical_execution': state, 'manifest_sha256': 'original'}
        for name, value in (('repair-plan.json', plan), ('deployment-baseline.private.json', baseline)):
            prep.private_write(self.out, name, value)
        old = mock.Mock(path=profile['report'], old=copy.deepcopy(consumers), state=state,
                        source=self.src, target=self.dst, job=self.jobfd)
        report_root = self.root / 'cutovers'; report_root.mkdir()
        old_constructor = cutover.Cutover; calls = []
        def operation(path, fd):
            if path == profile['report']: return old
            return old_constructor(path, fd)
        def read(fd, name):
            if name == 'execution.json' and fd == old.output: return copy.deepcopy(state)
            return local_json(fd, name)
        def open_history(path):
            fd = os.open(str(history), copying.DIR_FLAGS); old.output = fd; return fd
        def run(args, **kw):
            calls.append(args)
            if args[0] == 'findmnt': return 'xfs'
            if args[:2] == ['docker', 'run']:
                return json.dumps({'docker_nfs_mount': True, 'same_target_inode': True, 'root_4k_write_read': True})
            if args[:2] == ['docker', 'exec']: return json.dumps(prep.SCRIPT_HASHES)
            if args[:2] == ['docker', 'diff']: return ''
            if args[:2] == ['docker', 'compose']:
                if '--hash' in args: return '\n'.join(n + ' fixture-hash' for n in prep.SERVICES)
                if any(a.endswith('compose.nas.candidate.json') for a in args):
                    overlay = prep.candidate(consumers); merged = copy.deepcopy(original)
                    merged['volumes'].update(overlay['volumes'])
                    for n, change in overlay['services'].items():
                        merged['services'][n]['image'] = change['image']
                        merged['services'][n]['volumes'] += change['volumes']
                        if 'environment' in change: merged['services'][n]['environment'].update(change['environment'])
                        if 'command' in change: merged['services'][n]['command'] = change['command']
                    return json.dumps(merged)
                return json.dumps(original)
            self.fail('Unexpected command: ' + repr(args))
        seals = []
        with contextlib.ExitStack() as stack:
            patches = [(copying, 'open_report', {'side_effect': lambda p: os.dup(self.out)}),
                       (copying, 'read_manifest', {'return_value': ({}, {}, [])}),
                       (switch, 'completed_copy', {'return_value': {'phase': 'manifest_copy_complete'}}),
                       (copying, 'deployment_guard', {}), (switch, 'writer_guard', {}),
                       (switch, 'union_plan', {'return_value': ({'groups': {}}, {}, {}, [])}),
                       (cutover, 'open_report', {'side_effect': open_history}),
                       (cutover, 'read_json', {'side_effect': read}),
                       (cutover, 'Cutover', {'side_effect': operation}),
                       (old_constructor, 'config_guard', {}),
                       (old_constructor, 'seal', {'side_effect': lambda phase: seals.append(phase)}),
                       (manage, 'secure_directory', {'side_effect': lambda p: os.open(str(report_root), copying.DIR_FLAGS)}),
                       (manage, 'run', {'side_effect': run}),
                       (prep, 'file_hashes', {'return_value': baseline['config_files_sha256']}),
                       (precopy, 'inspect_containers', {'return_value': list(consumers.values())})]
            for obj, name, kwargs in patches: stack.enter_context(mock.patch.object(obj, name, **kwargs))
            current, fd = switch.make_operation(manage, profile, repair_path + '/copy-' + 'b' * 32)
            try:
                self.assertNotEqual(current.path, profile['report'])
                self.assertEqual(current.state['databases'], {'postgres': 'pg', 'redis': 'rd'})
                self.assertTrue(current.state['nas_may_have_writes']); self.assertFalse(current.state['reclaim_ready'])
                self.assertEqual(current.state['phase'], 'repair_prepared')
                self.assertEqual(current.overlay['services']['web']['image'], planning.APP_IMAGE)
                self.assertEqual(current.merged['services']['web']['environment'], original['services']['web']['environment'])
                self.assertEqual(current.merged['services']['postgres'], original['services']['postgres'])
                self.assertEqual(current.overlay['services']['web']['command'][0], 'gunicorn')
                self.assertEqual(local_json(fd, 'repair-lineage.json')['previous_nas_marker'], marker)
                self.assertEqual(seals, ['cutover_in_progress'])
            finally: current.close(); os.close(fd)
        self.assertEqual((history / 'execution.json').read_bytes(), history_bytes)
        old.stop.assert_not_called(); old.start.assert_not_called(); old.seal.assert_not_called()
        self.assertFalse(any(c[:2] in (['docker', 'stop'], ['docker', 'start']) or 'up' in c for c in calls))


class SwitchControlTests(unittest.TestCase):
    def setUp(self):
        self.rows = {n: {'Id': n, 'State': {'Running': False, 'StartedAt': '0001-01-01T00:00:00Z'}} for n in prep.SERVICES}
        self.op = mock.Mock(path='/review', state={'phase': 'repair_prepared', 'reclaim_ready': False})
        self.op.mounted_services.return_value = self.rows
        self.op.start.return_value = self.rows
        self.events = []
        def checkpoint(phase, **values):
            self.events.append(phase); self.op.state.update(phase=phase, **values)
        self.op.checkpoint.side_effect = checkpoint
        self.op.stop.side_effect = lambda rows: self.events.append('stop')
        self.op.command.side_effect = lambda *a, **kw: self.events.append('create')
        self.op.start.side_effect = lambda *a: self.events.append('start') or self.rows
        self.stack = contextlib.ExitStack(); self.addCleanup(self.stack.close)
        self.stack.enter_context(mock.patch.object(switch, 'writer_guard', return_value=self.rows))
        self.stack.enter_context(mock.patch.object(switch, 'media_guard'))
        self.final = self.stack.enter_context(mock.patch.object(switch, 'final_union', side_effect=self.finalized))
        self.finish = self.stack.enter_context(mock.patch.object(switch, 'finish'))

    def finalized(self, op):
        self.events.append('final-union'); op.state['final_sync_passed'] = True

    def test_recreate_only_after_stopped_recheck_and_never_start_dependencies_or_pull(self):
        switch.continue_switch(manage, {}, self.op)
        self.assertEqual(self.events, ['repair_stopping', 'stop', 'repair_finalizing', 'final-union',
                                      'creating_nas_containers', 'create', 'nas_containers_created', 'start'])
        command = self.op.command.call_args[0][0]
        for flag in ('--no-deps', '--no-build', '--no-start', '--force-recreate', '--remove-orphans=false'): self.assertIn(flag, command)
        self.assertEqual(command[command.index('--pull') + 1], 'never')
        self.assertEqual(set(command[-10:]), prep.SERVICES)
        self.assertNotIn('postgres', command); self.assertNotIn('redis', command)
        self.assertEqual(self.op.state['new_ids'], {n: n for n in prep.SERVICES})
        self.finish.assert_called_once()

    def test_final_comparison_failure_cannot_create_start_or_fallback(self):
        self.final.side_effect = RuntimeError('conflict')
        with self.assertRaisesRegex(RuntimeError, 'conflict'): switch.continue_switch(manage, {}, self.op)
        self.op.command.assert_not_called(); self.op.start.assert_not_called(); self.finish.assert_not_called()
        self.assertEqual(self.op.state['phase'], 'repair_finalizing')

    def test_partial_unregistered_creation_requires_review(self):
        self.op.state['phase'] = 'creating_nas_containers'
        with self.assertRaisesRegex(RuntimeError, 'partial'): switch.continue_switch(manage, {}, self.op)
        self.op.stop.assert_not_called(); self.final.assert_not_called(); self.op.command.assert_not_called()

    def test_resume_known_nas_containers_never_recopies_or_recreates(self):
        self.op.state.update(phase='nas_starting', final_sync_passed=True, new_ids={n: n for n in prep.SERVICES})
        switch.continue_switch(manage, {}, self.op)
        self.op.mounted_services.assert_called_once_with(True, expected_ids=self.op.state['new_ids'])
        self.op.stop.assert_not_called(); self.final.assert_not_called(); self.op.command.assert_not_called()
        self.op.start.assert_called_once_with(self.rows, True)

    def test_auto_started_recreated_container_blocks_start_and_further_copy(self):
        self.rows['web']['State']['StartedAt'] = '2026-09-24T00:00:00Z'
        with self.assertRaisesRegex(RuntimeError, 'started unexpectedly'): switch.continue_switch(manage, {}, self.op)
        self.op.start.assert_not_called(); self.assertNotIn('new_ids', self.op.state)
        self.assertEqual(self.op.state['phase'], 'creating_nas_containers')


class SwitchPublicTests(unittest.TestCase):
    def test_flags_route_and_background_protection(self):
        path = planning.REPORT_ROOT + '/infra-' + 'a' * 32 + '/copy-' + 'b' * 32
        for flags in ([], ['--maintenance'], ['--write-test']):
            args = manage.parser().parse_args(['repair-switch', 'part1', path] + flags)
            with self.assertRaisesRegex(RuntimeError, '--maintenance --write-test'):
                manage.task_command('repair-switch', manage.profiles()['part1'], args)
        route = catalog.route(['infra', 'repair', 'switch', path, '--maintenance', '--write-test'], manage.CONFIG)
        self.assertEqual(route, ['repair-switch', 'part1', path, '--maintenance', '--write-test'])
        args = manage.parser().parse_args(route)
        with contextlib.redirect_stdout(io.StringIO()), mock.patch.object(manage, 'run', return_value='') as run:
            manage.launch(args.action, manage.profiles()['part1'], args)
        command = run.call_args[0][0]
        self.assertIn('--property=ReadOnlyPaths=/data', command)
        self.assertIn('--property=TimeoutStopSec=infinity', command)
        self.assertIn('_execute-repair-switch', command)
        self.assertNotIn('--bwlimit', ' '.join(command))
        with self.assertRaisesRegex(RuntimeError, 'only reviewed for infra'):
            catalog.route(['delta', 'repair', 'switch', path, '--maintenance', '--write-test'], manage.CONFIG)

    def test_actual_nas_failure_cannot_emit_completion_or_run_write_probes(self):
        op = mock.Mock()
        with mock.patch.object(switch.infra_storage, 'check', return_value=False), self.assertRaisesRegex(RuntimeError, 'kernel NAS'):
            switch.finish(manage, {}, op, {})
        op.seal.assert_not_called(); op.checkpoint.assert_not_called(); op.command.assert_not_called()

    def test_application_probes_use_existing_default_users_and_keep_gateway_readonly(self):
        op = mock.Mock(saved={'precopy_state': {'target_inode': 100}}, state={'reclaim_ready': False})
        op.command.return_value = json.dumps(dict.fromkeys(('effective_read', 'effective_write', 'effective_search',
                                                           'write_read_rename_passed', 'cleanup_passed'), True))
        rows = {n: {'Id': n, 'State': {'Running': True, 'Health': {'Status': 'healthy'}}} for n in prep.SERVICES}
        op.mounted_services.return_value = rows
        def checkpoint(phase, **values): op.state.update(phase=phase, **values)
        op.checkpoint.side_effect = checkpoint
        with mock.patch.object(switch.infra_storage, 'check', return_value=True), mock.patch.object(switch, 'media_guard'), contextlib.redirect_stdout(io.StringIO()):
            switch.finish(manage, {}, op, rows)
        self.assertEqual(op.command.call_count, 9)
        for call in op.command.call_args_list:
            args = call[0][0]
            self.assertEqual(args[:2], ['docker', 'exec'])
            self.assertNotEqual(args[2], 'gateway'); self.assertNotIn('--user', args)
        self.assertTrue(op.state['recovery_registration_pending']); self.assertTrue(op.state['business_acceptance_pending'])
        self.assertFalse(op.state['reclaim_ready'])

    def test_unreviewed_bind_to_either_nas_path_is_rejected(self):
        op = mock.Mock(); op.originals.return_value = {'web': {'Id': 'web'}}
        for root in (precopy.MEDIA_ROOT, '/data/docker/volumes/' + prep.NFS_VOLUME + '/_data'):
            with mock.patch.object(precopy, 'inspect_containers', return_value=[{'Id': 'other', 'Mounts': [{'Type': 'bind', 'Source': root}]}]), \
                    self.assertRaisesRegex(RuntimeError, 'unreviewed media consumer'):
                switch.writer_guard(op, stopped=True)
