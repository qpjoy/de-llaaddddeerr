"""Failure-boundary tests for the cutover journal, without host/cluster writes.

The fixture models only the safety boundary: new writers require a durable
commit; restoring original data is forbidden after that commit. It does not
reimplement mount, database, endpoint, or Kubernetes reconciliation details.
"""
import base64
from contextlib import ExitStack
import copy
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).parents[1]))
try:
    import cutover
finally:
    sys.path.pop(0)

TRANSACTION = 'mx-k8s-20261020-010000-1234abcd'
JOURNAL_PATH = Path('/fixture/transactions/' + TRANSACTION + '/journal.json')


class InjectedFailure(RuntimeError):
    pass


class DurableJournal:
    def __init__(self):
        self.raw = None
        self.revisions = []
        self.fail_commit = None

    def replace(self, path, desired, before, mode=0o600):
        assert Path(path) == JOURNAL_PATH
        assert self.raw in (before, desired), 'journal compare-and-swap mismatch'
        record = json.loads(desired)
        failure = self.fail_commit if record['may_write'] else None
        if failure:
            self.fail_commit = None
        if failure == 'before-write':
            raise InjectedFailure('commit write failed')
        self.raw = desired
        self.revisions.append(copy.deepcopy(record))
        if failure == 'after-write':
            # Simulate an uncertain fsync result after replacement. Recovery
            # must inspect the durable bytes rather than assume rollback safe.
            raise InjectedFailure('commit sync result unknown')

    def read(self):
        return json.loads(self.raw)


class FakeHost:
    def __init__(self, durable):
        self.durable = durable
        self.events = []
        self.fail_at = None
        self.abort_failure = False
        self.cold_checks_change = False
        self.cold_checks = 0
        self.original_writers = True
        self.new_writers = False
        self.blocked = False
        self.copied = set()
        self.mounted_new = False
        self.cluster = SimpleNamespace(quiesce=self.quiesce, assert_quiesced=lambda value: self.event('assert-quiesced'))
        self.runtime = SimpleNamespace(stop_old=self.stop_old, assert_stopped=self.assert_stopped,
                                       check_cold=self.check_cold)
        self.storage = SimpleNamespace(unmount_kubelet_children=self.unmount_children, cold_copy=self.cold_copy)

    def event(self, name):
        self.events.append(name)
        if self.fail_at == name:
            self.fail_at = None
            raise InjectedFailure(name)

    def prepare(self, journal):
        self.event('prepare')
        # Irreversible host steps require these exact intended replacement bytes
        # to survive a process restart, not just remain in Move's Python object.
        journal.update(python='/usr/bin/python3', dropin='drop-in-intent',
                       unit_after='unit-intent', candidate_after='candidate-intent')

    def quiesce(self, cluster, persist):
        cluster['quiesced'] = True
        persist(cluster)
        self.event('quiesce')

    def docker_snapshot(self):
        return {'unchanged': True}

    def release_kubelet_bindings(self, journal):
        assert self.original_writers and not self.blocked, 'kubelet was stopped before releasing application binds'
        self.event('release-bindings')

    def block_startup(self, journal):
        stored = self.durable.read()
        assert not stored['may_write']
        for key in ('python', 'dropin', 'unit_after', 'candidate_after', 'blocked_record'):
            assert stored.get(key) == journal[key], 'startup mutation happened before durable intent'
        self.blocked = True
        self.event('block-startup')

    def stop_old(self):
        assert self.blocked, 'stopping without a durable startup guard'
        self.original_writers = False
        self.event('stop-old')

    def assert_stopped(self):
        assert not self.original_writers and not self.new_writers

    def unmount_children(self, storage, assert_stopped):
        assert_stopped()
        self.event('unmount-children')

    def check_cold(self, entries):
        self.assert_stopped()
        self.cold_checks += 1
        self.event('check-cold')
        return {'postgres': 'changed' if self.cold_checks_change and self.cold_checks > 1 else 'stable'}

    def cold_copy(self, entry, assert_stopped, persist):
        assert_stopped()
        entry['target_identity'] = {'device': 1, 'inode': len(self.copied) + 100}
        persist(entry)
        self.event('copy-' + entry['key'])
        entry['copied'] = True
        self.copied.add(entry['key'])
        persist(entry)

    def install_new_configuration(self, journal):
        self.assert_stopped()
        assert all(item.get('copied') for item in journal['storage']['entries'])
        assert not self.durable.read()['may_write']
        self.mounted_new = True
        self.event('install-configuration')

    def finish(self, journal, persist):
        assert journal['may_write'] and self.durable.read()['may_write'], 'new writers without durable permission'
        self.new_writers = True
        self.original_writers = False
        self.event('finish')
        journal['automatic_checks_passed'] = True
        persist()

    def abort(self, journal):
        assert not journal['may_write'] and not self.durable.read()['may_write'], 'stale data rollback after commit'
        assert not self.new_writers, 'cannot restore old data after new writers start'
        self.events.append('abort')
        if self.abort_failure:
            raise InjectedFailure('recovery interrupted')
        self.mounted_new = False
        self.blocked = False
        self.original_writers = True


def journal():
    entries = []
    for key, logical in cutover.storage_ops.ROOTS.items():
        target = cutover.storage_guard.DATA_BASE + '/' + TRANSACTION + '/' + key
        entries.append({'key': key, 'logical': logical, 'target': target, 'target_fsroot': target})
    return {'schema_version': 1, 'phase': 'preparing', 'transaction': TRANSACTION,
            'run': str(JOURNAL_PATH.parent), 'may_write': False, 'cluster': {}, 'docker_before': {'unchanged': True},
            'storage': {'schema_version': 1, 'transaction': TRANSACTION,
                        'hostname': 'fixture', 'root_uuid': cutover.ROOT_UUID, 'entries': entries}}


class CutoverTransactionsTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.durable = DurableJournal()
        self.stack.enter_context(mock.patch.object(cutover, 'replace_file', side_effect=self.durable.replace))
        self.stack.enter_context(mock.patch.object(cutover.prep, 'secure_directory'))
        self.stack.enter_context(mock.patch.object(cutover.prep, 'stage'))
        self.host = FakeHost(self.durable)
        self.move = cutover.Move(self.host, JOURNAL_PATH)

    def restart(self, host=None):
        move = cutover.Move(host or self.host, JOURNAL_PATH)
        move.journal, move.previous = self.durable.read(), self.durable.raw
        return move

    def test_success_starts_new_writers_only_after_durable_commit(self):
        self.move.execute(journal())
        self.assertTrue(self.host.new_writers)
        self.assertFalse(self.host.original_writers)
        self.assertNotIn('abort', self.host.events)
        self.assertEqual(self.durable.read()['phase'], 'services-restored')
        self.assertTrue(self.durable.read()['may_write'])
        first_commit = next(i for i, value in enumerate(self.durable.revisions) if value['may_write'])
        self.assertTrue(all(not value['may_write'] for value in self.durable.revisions[:first_commit]))
        self.assertTrue(all(value['may_write'] for value in self.durable.revisions[first_commit:]))

    def test_each_precommit_failure_restores_old_side_without_starting_new_writers(self):
        failures = ('prepare', 'quiesce', 'release-bindings', 'block-startup', 'stop-old', 'unmount-children',
                    'check-cold', 'copy-kubelet', 'copy-common', 'install-configuration')
        for failure in failures:
            with self.subTest(failure=failure):
                self.durable.raw, self.durable.revisions = None, []
                host = FakeHost(self.durable)
                host.fail_at = failure
                move = cutover.Move(host, JOURNAL_PATH)
                with self.assertRaises(InjectedFailure):
                    move.execute(journal())
                self.assertFalse(host.new_writers)
                self.assertTrue(host.original_writers)
                self.assertEqual(host.events.count('abort'), 1)
                self.assertEqual(self.durable.read()['phase'], 'aborted')
                self.assertFalse(self.durable.read()['may_write'])

    def test_binding_release_failure_recovers_before_stopping_kubelet_or_copying(self):
        self.host.fail_at = 'release-bindings'
        with self.assertRaises(InjectedFailure):
            self.move.execute(journal())
        self.assertNotIn('block-startup', self.host.events)
        self.assertNotIn('stop-old', self.host.events)
        self.assertNotIn('unmount-children', self.host.events)
        self.assertFalse(self.host.copied)
        self.assertTrue(self.host.original_writers)
        self.assertEqual(self.durable.read()['phase'], 'aborted')

    def test_source_changes_during_copy_prevent_configuration_switch_and_commit(self):
        self.host.cold_checks_change = True
        with self.assertRaises(cutover.prep.Refuse):
            self.move.execute(journal())
        self.assertNotIn('install-configuration', self.host.events)
        self.assertFalse(self.host.new_writers)
        self.assertEqual(self.durable.read()['phase'], 'aborted')
        self.assertEqual(self.host.copied, set(cutover.storage_ops.ROOTS))

    def test_failure_after_commit_only_allows_forward_resume(self):
        self.host.fail_at = 'finish'
        with self.assertRaises(InjectedFailure):
            self.move.execute(journal())
        self.assertTrue(self.durable.read()['may_write'])
        self.assertTrue(self.host.new_writers)
        self.assertNotIn('abort', self.host.events)
        self.restart().resume()
        self.assertEqual(self.durable.read()['phase'], 'services-restored')
        self.assertNotIn('abort', self.host.events)
        self.assertFalse(self.host.original_writers)

    def test_commit_write_failure_cannot_start_new_writers(self):
        self.durable.fail_commit = 'before-write'
        with self.assertRaises(InjectedFailure):
            self.move.execute(journal())
        self.assertFalse(self.host.new_writers)
        self.assertNotIn('finish', self.host.events)
        self.assertFalse(self.durable.read()['may_write'])
        # Restart resolves the uncertain in-memory state using the persisted
        # journal. Pre-commit recovery may restore originals, never activate.
        self.restart().resume()
        self.assertEqual(self.durable.read()['phase'], 'aborted')
        self.assertFalse(self.host.new_writers)
        self.assertTrue(self.host.original_writers)

    def test_uncertain_commit_sync_uses_durable_commit_and_never_old_data(self):
        self.durable.fail_commit = 'after-write'
        with self.assertRaises(InjectedFailure):
            self.move.execute(journal())
        self.assertTrue(self.durable.read()['may_write'])
        self.assertFalse(self.host.new_writers)
        self.assertNotIn('abort', self.host.events)
        self.restart().resume()
        self.assertTrue(self.host.new_writers)
        self.assertNotIn('abort', self.host.events)
        self.assertEqual(self.durable.read()['phase'], 'services-restored')

    def test_restart_after_partial_copy_retains_intents_and_target_identity_for_recovery(self):
        self.host.fail_at = 'copy-common'
        self.host.abort_failure = True
        with self.assertRaises(InjectedFailure):
            self.move.execute(journal())
        stored = self.durable.read()
        self.assertFalse(stored['may_write'])
        self.assertEqual(stored['unit_after'], 'unit-intent')
        self.assertEqual(stored['candidate_after'], 'candidate-intent')
        self.assertEqual(stored['dropin'], 'drop-in-intent')
        copied = next(e for e in stored['storage']['entries'] if e['key'] == 'common')
        self.assertIn('target_identity', copied)
        self.assertNotIn('copied', copied)
        blocked = json.loads(base64.b64decode(stored['blocked_record']))
        self.assertEqual(blocked['phase'], 'blocked')
        self.assertNotIn('target_identity', blocked['entries'][0])
        self.host.abort_failure = False
        self.restart().resume()
        self.assertEqual(self.durable.read()['phase'], 'aborted')
        self.assertFalse(self.host.new_writers)

    def test_resume_already_aborted_is_idempotent(self):
        data = journal()
        data['phase'] = 'aborted'
        self.durable.raw = cutover.raw_json(data)
        self.restart().resume()
        self.assertFalse(self.host.events)
        self.assertFalse(self.durable.revisions)

    def test_resume_interrupted_abort_never_activates_uncommitted_data(self):
        data = journal()
        data['phase'] = 'switching'
        self.durable.raw = cutover.raw_json(data)
        self.host.original_writers = False
        self.host.mounted_new = True
        self.host.abort_failure = True
        with self.assertRaises(InjectedFailure):
            self.restart().resume()
        self.assertFalse(self.durable.read()['may_write'])
        self.assertFalse(self.host.new_writers)
        self.host.abort_failure = False
        self.restart().resume()
        self.assertTrue(self.host.original_writers)
        self.assertFalse(self.host.new_writers)
        self.assertEqual(self.durable.read()['phase'], 'aborted')


if __name__ == '__main__':
    unittest.main()
