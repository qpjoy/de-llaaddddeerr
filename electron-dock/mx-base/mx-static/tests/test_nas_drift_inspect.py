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
from projects import infra_drift as drift
from projects import infra_repair as repair
from test_nas_cutover_prepare import fixtures


class InspectTests(unittest.TestCase):
    def setUp(self):
        self.consumers, self.config = fixtures()
        self.original = copy.deepcopy(self.consumers)
        self.history = {'databases': {'postgres': 'pg', 'redis': 'rd'}}
        for name, c in self.consumers.items():
            c['Image'] = repair.GATEWAY_IMAGE if name == 'gateway' else 'sha256:' + 'f' * 64
        self.rows = list(self.consumers.values()) + [
            {'Id': ident, 'State': {'Running': True, 'Status': 'running', 'Health': {'Status': 'healthy'}},
             'Config': {'Labels': {'com.docker.compose.project': 'mx_data', 'com.docker.compose.service': name}}}
            for name, ident in self.history['databases'].items()]
        self.after = copy.deepcopy(self.rows)
        self.scripts = dict(prep.SCRIPT_HASHES)
        self.code_changes = ''
        self.commands = []
        self.events = []

    def run_command(self, args):
        self.commands.append(args)
        if args[:2] == ['docker', 'compose']:
            if '--hash' in args:
                return '\n'.join(n + ' fixture-hash' for n in prep.SERVICES)
            self.assertEqual(args[-3:], ['config', '--format', 'json'])
            return json.dumps(self.config)
        if args[:2] == ['docker', 'exec']:
            self.assertEqual(args[3:6], ['python', '-B', '-c'])
            self.assertNotIn('bootstrap_admin', args[-1])
            return json.dumps(self.scripts)
        if args[:2] == ['docker', 'diff']:
            return self.code_changes
        self.fail('Unexpected command: ' + repr(args))

    def inspect(self, file_change=False):
        with mock.patch.object(drift, 'receipt_snapshot', return_value=(self.history, self.original, [])), \
                mock.patch.object(drift.precopy, 'inspect_containers', side_effect=[self.rows, self.after]), \
                mock.patch.object(prep, 'file_hashes', side_effect=[{'env': 'secret-hash'}, {'env': 'changed' if file_change else 'secret-hash'}]), \
                mock.patch.object(manage, 'run', side_effect=self.run_command), \
                mock.patch.object(drift, 'emit', side_effect=lambda event, **value: self.events.append(dict(event=event, **value))), \
                mock.patch.object(cutover, 'Cutover', side_effect=AssertionError('must not create a migration operation')), \
                mock.patch.object(prep, 'candidate', side_effect=AssertionError('must not build a candidate')):
            return drift.inspect(manage, manage.profiles()['part1'])

    def test_new_image_is_evidence_not_adoption_and_secrets_never_printed(self):
        self.assertTrue(self.inspect())
        result = self.events[-1]
        self.assertTrue(result['snapshot_stable'])
        self.assertFalse(result['existing_repair_images_match'])
        self.assertFalse(result['execution_allowed'])
        self.assertFalse(result['reclaim_ready'])
        self.assertFalse(result['production_changed'])
        output = json.dumps(self.events)
        for secret in ('literal$value', 'private', 'secret-hash', 'MX_WEB_WORKERS=4'):
            self.assertNotIn(secret, output)
        self.assertEqual(len([c for c in self.commands if c[:2] == ['docker', 'exec']]), 9)
        self.assertEqual(len(result['databases']), 2)

    def test_changed_startup_script_or_writable_code_cannot_be_silent(self):
        self.scripts['scripts/run_web.sh'] = '0' * 64
        self.code_changes = 'C /app/mx_data/settings.py\n'
        self.assertFalse(self.inspect())
        row = next(r for r in self.events[-1]['services'] if r['service'] == 'web')
        self.assertFalse(row['startup_scripts_match_reviewed'])
        self.assertEqual(row['changed_app_code_count'], 1)

    def test_replaced_database_is_reported_without_start_or_database_queries(self):
        self.rows[-1]['Id'] = 'new-redis'
        self.after = copy.deepcopy(self.rows)
        self.assertFalse(self.inspect())
        self.assertIn({'service': 'redis', 'reason': 'database_identity_or_health_needs_review'}, self.events[-1]['review_items'])

    def test_file_or_container_changes_invalidate_snapshot(self):
        self.assertFalse(self.inspect(file_change=True))
        self.assertFalse(self.events[-1]['snapshot_stable'])
        self.after[0]['Config']['Env'].append('SECRET=changed')
        self.assertFalse(self.inspect())
        self.assertNotIn('SECRET=changed', json.dumps(self.events))

    def test_route_does_not_grant_delta_inspection_or_execution(self):
        route = catalog.route(['infra', 'repair', 'inspect'], manage.CONFIG)
        self.assertEqual(route, ['repair-inspect', 'part1'])
        self.assertEqual(manage.parser().parse_args(route).action, 'repair-inspect')
        with self.assertRaises(RuntimeError): catalog.route(['delta', 'repair', 'inspect'], manage.CONFIG)


class ReceiptTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / 'execution.json').write_text('{"phase":"running_on_nas"}')
        (self.root / 'containers.private.json').write_text('{}')
        self.plan = self.root / ('reclaim-plan-' + 'a' * 32)
        self.plan.mkdir(mode=0o700)

    def inspect(self):
        def read(root, name):
            with os.fdopen(os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=root)) as stream:
                return json.load(stream)
        # Fixtures are owned by the local test user; production read_json keeps its root/private checks.
        with mock.patch.object(cutover, 'open_report', side_effect=lambda path: os.open(str(self.root), drift.DIR_FLAGS)), \
                mock.patch.object(cutover, 'read_json', side_effect=read):
            return drift.receipt_snapshot({'report': '/fixture'})

    def test_check_only_is_distinct_from_partial_and_completed_deletion(self):
        self.assertEqual(self.inspect()[2], [])
        (self.plan / 'unlink-intents.jsonl').write_text('intent\n')
        evidence = self.inspect()[2][0]
        self.assertEqual(evidence['intent_bytes'], 7)
        self.assertFalse(evidence['completion_recorded'])
        (self.plan / 'reclaim-result.json').write_text('{"phase":"ssd_files_reclaimed","removed_this_run":123}')
        evidence = self.inspect()[2][0]
        self.assertTrue(evidence['completion_recorded'])
        self.assertEqual(evidence['removed_this_run'], 123)
        self.assertEqual((self.plan / 'unlink-intents.jsonl').read_text(), 'intent\n')

    def test_journal_and_plan_symlinks_are_refused(self):
        (self.plan / 'unlink-intents.jsonl').symlink_to(self.root / 'execution.json')
        with self.assertRaises(RuntimeError): self.inspect()
        (self.plan / 'unlink-intents.jsonl').unlink()
        self.plan.rmdir()
        self.plan.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(OSError): self.inspect()


if __name__ == '__main__':
    unittest.main()
