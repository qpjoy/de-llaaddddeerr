import contextlib
import copy
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts/nas'))
import catalog
import cutover
import cutover_prepare as prep
import manage
import precopy
from projects import infra_repair as repair
from verify import Report
from test_nas_cutover_prepare import fixtures


class UnionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source, self.target = self.root / 'ssd', self.root / 'nas'
        self.source.mkdir(); self.target.mkdir()
        self.sfd = os.open(str(self.source), repair.DIR_FLAGS)
        self.tfd = os.open(str(self.target), repair.DIR_FLAGS)
        self.addCleanup(os.close, self.sfd); self.addCleanup(os.close, self.tfd)
        self.log = io.BytesIO(); self.report = Report(self.log)
        self.output = contextlib.redirect_stdout(io.StringIO())
        self.output.__enter__(); self.addCleanup(self.output.__exit__, None, None, None)

    def put(self, root, name, data=b'media', mode=0o600, when=1000000000):
        p = root / name; p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data); p.chmod(mode); os.utime(str(p), (when, when))
        return p

    def compare(self):
        return repair.compare(self.sfd, self.tfd, self.report)

    def test_union_retains_nas_only_and_permission_changes_without_writes(self):
        self.put(self.source, 'video/ssd-only.bin')
        nas_only = self.put(self.target, 'avatar/nas-only.jpg')
        self.put(self.source, 'avatar/raw-media-x.tmp', mode=0o644)
        private = self.put(self.target, 'avatar/raw-media-x.tmp', mode=0o600)
        before = private.stat()
        with mock.patch.object(repair, 'digest', side_effect=AssertionError('no content reads needed')):
            result = self.compare()
        self.assertEqual(result['groups']['ssd_only']['files'], 1)
        self.assertEqual(result['groups']['nas_only']['files'], 1)
        self.assertEqual(result['groups']['permissions_only']['tmp_files'], 1)
        self.assertTrue(result['stopped_writer_recheck_required'])
        self.assertTrue(nas_only.exists())
        self.assertFalse((self.target / 'video/ssd-only.bin').exists())
        self.assertEqual(private.stat().st_mode, before.st_mode)
        self.assertEqual(private.stat().st_mtime_ns, before.st_mtime_ns)
        self.assertEqual(private.read_bytes(), b'media')

    def test_hashes_only_shared_mtime_differences(self):
        for root in (self.source, self.target):
            self.put(root, 'unchanged.bin')
            self.put(root, 'mtime.bin', when=1000000000 + (2 if root == self.target else 0))
        result = self.compare()
        self.assertEqual(result['hash_counts']['hashed_pairs'], 1)
        self.assertEqual(result['groups']['shared_hash_same']['files'], 1)
        self.assertEqual(result['groups']['shared_quick_match']['files'], 1)
        self.assertEqual((self.target / 'mtime.bin').stat().st_mtime, 1000000002)

    def test_shared_size_or_content_conflict_never_overwrites_either_side(self):
        source = self.put(self.source, 'conflict.bin', b'source')
        target = self.put(self.target, 'conflict.bin', b'long-target', when=1000000002)
        with self.assertRaises(RuntimeError): self.compare()
        self.assertEqual(target.read_bytes(), b'long-target')
        target = self.put(self.target, 'conflict.bin', b'target', when=1000000002)
        self.report = Report(io.BytesIO())
        with self.assertRaises(RuntimeError): self.compare()
        self.assertEqual(target.read_bytes(), b'target')
        self.assertEqual(source.read_bytes(), b'source')

    def test_type_conflict_keeps_directory_and_file(self):
        self.put(self.source, 'avatar')
        (self.target / 'avatar').mkdir()
        with self.assertRaises(RuntimeError): self.compare()
        self.assertTrue((self.source / 'avatar').is_file())
        self.assertTrue((self.target / 'avatar').is_dir())

    def test_hash_budget_is_checked_before_content_reads(self):
        self.put(self.source, 'mtime.bin')
        self.put(self.target, 'mtime.bin', when=1000000002)
        with mock.patch.object(repair, 'MAX_HASH_BYTES', 1), mock.patch.object(repair, 'digest') as read:
            with self.assertRaisesRegex(RuntimeError, 'budget'): self.compare()
        read.assert_not_called()

    def test_content_filename_mismatch_is_refused(self):
        name = '0' * 64 + '.bin'
        self.put(self.source, name)
        self.put(self.target, name, when=1000000002)
        with self.assertRaises(RuntimeError): self.compare()
        self.assertIn('conflict_hash_error', self.log.getvalue().decode())

    def test_file_mutated_during_hash_cannot_pass(self):
        source = self.put(self.source, 'mtime.bin')
        self.put(self.target, 'mtime.bin', when=1000000002)
        original = repair.digest
        def changed(fd, size):
            value = original(fd, size)
            source.write_bytes(b'changed')
            return value
        with mock.patch.object(repair, 'digest', side_effect=changed), self.assertRaises(RuntimeError):
            self.compare()
        self.assertEqual((self.target / 'mtime.bin').read_bytes(), b'media')

    def test_complete_prepare_preserves_history_and_marker_and_never_adopts(self):
        self.put(self.source, 'ssd-only.bin')
        self.put(self.target, 'nas-only.bin')
        history_dir = self.root / 'history'; history_dir.mkdir()
        history = {'schema': 1, 'volume': prep.VOLUME, 'report_directory': manage.profiles()['part1']['report'],
                   'phase': 'running_on_nas', 'final_sync_passed': True, 'nas_may_have_writes': True,
                   'reclaim_ready': False, 'new_ids': {n: n + '-old' for n in prep.SERVICES},
                   'databases': {'postgres': 'pg', 'redis': 'rd'}}
        receipt = history_dir / 'execution.json'; receipt.write_text(json.dumps(history))
        initial = receipt.read_bytes()
        marker = {'job_id': 'original-job', 'phase': 'cutover_running_on_nas'}
        baseline = {'config_files_sha256': {'env': 'current'}, 'consumer_fingerprint': 'current'}
        report_dir = self.root / 'report'; report_dir.mkdir(mode=0o700)
        op = mock.Mock(path=history['report_directory'])
        held = []
        def opened(**kwargs):
            self.assertEqual(kwargs, {'sealed': True})
            op.source, op.target = os.dup(self.sfd), os.dup(self.tfd)
            held.extend((op.source, op.target)); op.job = 10001
        op.open_media.side_effect = opened
        op.close.side_effect = lambda: [os.close(fd) for fd in held]
        with mock.patch.object(repair, 'new_report', return_value=(str(report_dir), os.open(str(report_dir), repair.DIR_FLAGS))), \
                mock.patch.object(cutover, 'open_report', side_effect=lambda path: os.open(str(history_dir), repair.DIR_FLAGS)), \
                mock.patch.object(cutover, 'Cutover', return_value=op), \
                mock.patch.object(cutover, 'read_json', return_value=copy.deepcopy(history)), \
                mock.patch.object(repair, 'deployment', return_value=baseline), \
                mock.patch.object(prep, 'file_hashes', return_value={'env': 'current'}), \
                mock.patch.object(precopy, 'read_state', return_value=marker), \
                mock.patch.object(precopy, 'inspect_containers', return_value=[]), \
                mock.patch.object(precopy, 'check_consumers', return_value='current'), \
                mock.patch.object(cutover, 'select_services', return_value={}), \
                mock.patch.object(repair.reclaim_plan, 'health_guard'), \
                mock.patch.object(manage, 'run', return_value=json.dumps([{
                    'Name': prep.NFS_VOLUME, 'Driver': 'local', 'Options': prep.OPTIONS}])) as run:
            repair.prepare(manage, manage.profiles()['part1'])
        result = json.loads((report_dir / 'repair-plan.json').read_text())
        self.assertEqual(result['application_image'], repair.APP_IMAGE)
        self.assertEqual(result['historical_execution'], history)
        self.assertEqual(result['nas_marker'], marker)
        self.assertFalse(result['execution_allowed']); self.assertFalse(result['reclaim_ready'])
        self.assertEqual(result['groups']['ssd_only']['files'], 1)
        self.assertEqual(receipt.read_bytes(), initial)
        self.assertEqual(marker['phase'], 'cutover_running_on_nas')
        for name in ('config_guard', 'stop', 'start', 'sync', 'seal', 'checkpoint', 'command'):
            getattr(op, name).assert_not_called()
        run.assert_called_once_with(['docker', 'volume', 'inspect', prep.NFS_VOLUME])

    def test_symlink_or_hardlink_is_not_a_copy_candidate(self):
        self.put(self.source, 'original')
        (self.source / 'link').symlink_to('original')
        with self.assertRaises(RuntimeError): self.compare()
        (self.source / 'link').unlink()
        os.link(str(self.source / 'original'), str(self.source / 'hardlink'))
        self.report = Report(io.BytesIO())
        with self.assertRaises(RuntimeError): self.compare()


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name)
        self.fd = os.open(str(self.path), repair.DIR_FLAGS); self.addCleanup(os.close, self.fd)
        self.consumers, self.config = fixtures()
        for name, c in self.consumers.items():
            c['Image'] = repair.GATEWAY_IMAGE if name == 'gateway' else repair.APP_IMAGE
        self.op = mock.Mock(old=copy.deepcopy(self.consumers), state={'databases': {'postgres': 'pg', 'redis': 'rd'}})
        self.output = contextlib.redirect_stdout(io.StringIO())
        self.output.__enter__(); self.addCleanup(self.output.__exit__, None, None, None)
        self.changes = ''
        self.commands = []
        self.mutate_merged = lambda value: None

    def command(self, args):
        self.commands.append(args)
        if args[:2] == ['docker', 'compose']:
            if '--hash' in args:
                return '\n'.join(n + ' fixture-hash' for n in prep.SERVICES)
            if any(a.endswith('compose.nas.candidate.json') for a in args):
                merged = copy.deepcopy(self.config)
                overlay = json.loads((self.path / 'compose.nas.candidate.json').read_text())
                merged['volumes'].update(overlay['volumes'])
                for name, change in overlay['services'].items():
                    merged['services'][name]['image'] = change['image']
                    merged['services'][name]['volumes'] += change['volumes']
                    if 'environment' in change:
                        merged['services'][name]['environment'].update(change['environment'])
                    if 'command' in change: merged['services'][name]['command'] = change['command']
                self.mutate_merged(merged)
                return json.dumps(merged)
            return json.dumps(self.config)
        if args[:2] == ['docker', 'exec']: return json.dumps(prep.SCRIPT_HASHES)
        if args[:2] == ['docker', 'diff']: return self.changes
        self.fail('Unexpected operation: ' + repr(args))

    def prepare_deployment(self):
        with mock.patch.object(prep, 'file_hashes', return_value={'config': 'hash'}), \
                mock.patch.object(precopy, 'inspect_containers', return_value=list(self.consumers.values())), \
                mock.patch.object(precopy, 'check_consumers', return_value=('fingerprint', [])), \
                mock.patch.object(repair.reclaim_plan, 'health_guard'), \
                mock.patch.object(repair.reclaim_plan, 'extra_source_consumers', return_value=[]), \
                mock.patch.object(manage, 'run', side_effect=self.command):
            return repair.deployment(manage, self.op, self.fd, str(self.path))

    def test_new_images_are_pinned_and_auth_database_configuration_retained(self):
        result = self.prepare_deployment()
        candidate = json.loads((self.path / 'compose.nas.candidate.json').read_text())
        self.assertEqual(candidate['services']['web']['image'], repair.APP_IMAGE)
        self.assertEqual(candidate['services']['gateway']['image'], repair.GATEWAY_IMAGE)
        self.assertEqual(candidate['services']['web']['command'][0], 'gunicorn')
        self.assertNotIn('run_web.sh', repr(candidate))
        self.assertEqual(candidate['services']['worker']['environment'], {'MX_RECOVER_STALE_AGENT_RUNS': '0'})
        self.assertEqual(result['databases'], {'postgres': 'pg', 'redis': 'rd'})
        self.assertNotIn('KEEP_SECRET', repr(result))
        self.assertEqual((self.path / 'containers.private.json').stat().st_mode & 0o777, 0o600)
        self.assertFalse(any(c[:2] in (['docker', 'start'], ['docker', 'stop'], ['docker', 'run']) for c in self.commands))
        self.assertFalse(any('up' in c or 'create' in c for c in self.commands))

    def test_unreviewed_image_stops_before_candidate_is_written(self):
        self.consumers['web']['Image'] = 'sha256:unreviewed'
        with self.assertRaises(RuntimeError): self.prepare_deployment()
        self.assertFalse((self.path / 'compose.nas.candidate.json').exists())

    def test_changed_start_command_stops_before_candidate(self):
        self.consumers['web']['Config']['Cmd'] = ['new-bootstrap']
        with self.assertRaises(RuntimeError): self.prepare_deployment()
        self.assertFalse((self.path / 'compose.nas.candidate.json').exists())

    def test_manual_code_patch_is_not_lost_through_recreation(self):
        self.changes = 'C /app/mx_data/settings.py\n'
        with self.assertRaises(RuntimeError): self.prepare_deployment()
        self.assertFalse((self.path / 'compose.nas.candidate.json').exists())

    def test_unrelated_env_or_database_changes_in_merge_are_refused(self):
        self.mutate_merged = lambda merged: merged['services']['postgres']['environment'].update(PASSWORD='changed')
        with self.assertRaisesRegex(RuntimeError, 'unrelated'): self.prepare_deployment()

    def test_unreviewed_project_and_apply_route_are_not_available(self):
        self.assertEqual(catalog.route(['infra', 'repair', 'prepare'], manage.CONFIG), ['repair-prepare', 'part1'])
        for args in (['delta', 'repair', 'prepare'], ['infra', 'repair', 'apply']):
            with self.assertRaises(RuntimeError): catalog.route(args, manage.CONFIG)
        with self.assertRaises(RuntimeError): repair.reviewed(manage.profiles()['part2'])


if __name__ == '__main__':
    unittest.main()
