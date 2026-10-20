"""Semantic Docker observations preserve real state and never expose payloads."""
import copy
import json
from pathlib import Path
import sys
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).parents[1]))
import docker_compare as docker


IDS = ('a' * 64, 'b' * 64)


def snapshot():
    """A complete production-shaped observation; every call returns fresh data."""
    return {
        'complete': True, 'containers_complete': True,
        'info': {'root': '/data/private-docker-root', 'live_restore': False,
                 'name': 'private-host-name', 'swarm_state': 'inactive'},
        'containers': [
            {'id': IDS[0], 'name': '/private-container-a', 'running': True, 'paused': False,
             'restart_policy': {'Name': 'always', 'MaximumRetryCount': 0}, 'stop_signal': None},
            {'id': IDS[1], 'name': '/private-container-b', 'running': False, 'paused': False,
             'restart_policy': {'Name': 'on-failure', 'MaximumRetryCount': 3}, 'stop_signal': 'SIGTERM'},
        ],
        'total': 2, 'inspected_total': 2, 'running': 1, 'paused': 0,
        'diagnostics': [],
        'mounts': {
            IDS[0]: [
                {'Type': 'bind', 'Source': '/mnt/nas/private-data', 'Destination': '/private-shared',
                 'Mode': 'rw', 'RW': True, 'Propagation': 'rprivate'},
                {'Type': 'volume', 'Name': 'private-volume', 'Driver': 'local',
                 'Source': '/data/private-docker-root/volumes/private-volume/_data',
                 'Destination': '/private-cache', 'Mode': '', 'RW': True, 'Propagation': ''},
            ],
            IDS[1]: [{'Type': 'bind', 'Source': '/data/private-app-config', 'Destination': '/private-config',
                      'Mode': 'ro', 'RW': False, 'Propagation': 'rprivate'}],
        },
    }


class DockerComparisonTests(unittest.TestCase):
    def unchanged(self, before, after):
        result = docker.compare(before, after)
        self.assertIs(result['equivalent'], True)
        return result

    def changed(self, before, after):
        result = docker.compare(before, after)
        self.assertIs(result['equivalent'], False)
        self.assert_private(result)
        return result

    def assert_private(self, value):
        output = json.dumps(value, ensure_ascii=True, sort_keys=True)
        for secret in ('private-', '/mnt/nas', '/data/',
                       'untrusted-key', 'untrusted-value'):
            self.assertNotIn(secret, output)

    def test_fixture_is_complete_and_normalization_is_pure(self):
        before = snapshot()
        retained = copy.deepcopy(before)
        canonical = docker.normalize(before)
        self.assertIsInstance(canonical, str)
        self.assertEqual(before, retained)
        self.unchanged(before, snapshot())

    def test_container_mount_and_object_key_order_do_not_change_semantics(self):
        before = snapshot()
        after = json.loads(json.dumps(before, sort_keys=True))
        after['containers'].reverse()
        for mounts in after['mounts'].values():
            mounts.reverse()
        after['mounts'] = dict(reversed(list(after['mounts'].items())))
        self.unchanged(before, after)
        self.assertEqual(docker.normalize(before), docker.normalize(after))

    def test_successful_retry_diagnostics_do_not_change_retained_state(self):
        before, after = snapshot(), snapshot()
        before['diagnostics'] = [{'stage': 'inspect batch command', 'reason': 'timeout',
                                  'retry': 'per-container', 'exit_code': 1,
                                  'untrusted-key': 'untrusted-value-private-log'}]
        after['diagnostics'] = [{'stage': 'inspect batch response', 'reason': 'invalid_or_incomplete_response'}]
        self.assert_private(self.unchanged(before, after))
        self.assertEqual(docker.normalize(before), docker.normalize(after))

    def test_old_unordered_raw_snapshot_compares_without_rewriting_it(self):
        original = snapshot()
        original['containers'].reverse()
        original['mounts'][IDS[0]].reverse()
        original['diagnostics'] = [{'reason': 'old-retry-record'}]
        saved = copy.deepcopy(original)
        self.unchanged(original, snapshot())
        self.assertEqual(original, saved)

    def test_summary_distinguishes_ignored_enumeration_from_semantic_changes(self):
        before, after = snapshot(), snapshot()
        after['containers'].reverse()
        after['mounts'][IDS[0]].reverse()
        after['diagnostics'] = [{'retry': 'per-container', 'private-key': 'private-value'}]
        result = self.unchanged(before, after)
        self.assertIs(result['raw_equal'], False)
        self.assertEqual(result['ignored_differences'], ['container_order', 'mount_order', 'probe_diagnostics'])
        self.assertEqual(result['changes'], {'info_fields': [], 'containers_added': [], 'containers_removed': [],
            'container_changes': [], 'mount_changes': [], 'other_fields': []})
        self.assert_private(result)
        after['mounts'][IDS[0]][0]['RW'] = False
        result = self.changed(before, after)
        self.assertEqual(result['changes']['mount_changes'], [{'id': IDS[0], 'fields': ['RW']}])
        self.assertNotIn('mount_order', result['ignored_differences'])

    def test_only_top_level_probe_diagnostics_are_ignored(self):
        before, after = snapshot(), snapshot()
        before['containers'][0]['diagnostics'] = {'untrusted-key': 'untrusted-value-before'}
        after['containers'][0]['diagnostics'] = {'untrusted-key': 'untrusted-value-after'}
        result = self.changed(before, after)
        self.assertEqual(result['changes']['container_changes'], [{'id': IDS[0], 'fields': ['other']}])

    def test_real_container_and_daemon_changes_are_retained(self):
        for field in ('id', 'running', 'paused', 'restart-name', 'restart-limit', 'stop-signal',
                      'container-name', 'root', 'live-restore', 'daemon-name', 'swarm-state'):
            with self.subTest(field=field):
                before, after = snapshot(), snapshot()
                container = after['containers'][0]
                if field == 'id':
                    container['id'] = 'c' * 64
                    after['mounts'][container['id']] = after['mounts'].pop(IDS[0])
                elif field == 'running': container['running'] = False; after['running'] = 0
                elif field == 'paused': container['paused'] = True; after['paused'] = 1
                elif field == 'restart-name': container['restart_policy']['Name'] = 'unless-stopped'
                elif field == 'restart-limit': container['restart_policy']['MaximumRetryCount'] = 4
                elif field == 'stop-signal': container['stop_signal'] = 'SIGUSR1'
                elif field == 'container-name': container['name'] = '/private-new-name'
                elif field == 'root': after['info']['root'] = '/data/private-other-docker'
                elif field == 'live-restore': after['info']['live_restore'] = True
                elif field == 'daemon-name': after['info']['name'] = 'private-other-host'
                elif field == 'swarm-state': after['info']['swarm_state'] = 'active'
                self.changed(before, after)

    def test_real_mount_semantics_are_not_normalized_away(self):
        changes = {'Source': '/mnt/nas/private-other-data', 'Destination': '/private-other-destination',
                   'Type': 'volume', 'RW': False, 'Propagation': 'rshared', 'Mode': 'ro',
                   'Name': 'private-other-volume', 'Driver': 'private-other-driver'}
        for field, value in changes.items():
            with self.subTest(field=field):
                before, after = snapshot(), snapshot()
                after['mounts'][IDS[0]][0][field] = value
                self.changed(before, after)

    def test_mount_added_removed_or_assigned_to_other_container_is_a_change(self):
        for kind in ('added', 'removed', 'reassigned'):
            with self.subTest(kind=kind):
                before, after = snapshot(), snapshot()
                if kind == 'added':
                    after['mounts'][IDS[0]].append({'Source': '/private-source', 'Destination': '/private-new',
                                                  'Type': 'bind', 'RW': True, 'Propagation': 'rprivate'})
                elif kind == 'removed': after['mounts'][IDS[0]].pop()
                else: after['mounts'][IDS[1]].append(after['mounts'][IDS[0]].pop())
                self.changed(before, after)

    def test_unknown_fields_are_preserved_without_disclosing_keys_or_values(self):
        for scope in ('top', 'info', 'container', 'policy', 'mount'):
            with self.subTest(scope=scope):
                before, after = snapshot(), snapshot()
                target = {'top': after, 'info': after['info'], 'container': after['containers'][0],
                          'policy': after['containers'][0]['restart_policy'],
                          'mount': after['mounts'][IDS[0]][0]}[scope]
                target['untrusted-key'] = {'nested': ['untrusted-value', '/mnt/nas/private-path']}
                self.changed(before, after)

    def test_unknown_field_bool_int_and_float_remain_distinct(self):
        for old, new in ((True, 1), (1, 1.0), (False, 0)):
            with self.subTest(old=repr(old), new=repr(new)):
                before, after = snapshot(), snapshot()
                before['mounts'][IDS[0]][0]['untrusted-key'] = old
                after['mounts'][IDS[0]][0]['untrusted-key'] = new
                self.changed(before, after)

    def test_complete_zero_container_snapshot_is_supported(self):
        empty = snapshot()
        empty.update(containers=[], total=0, inspected_total=0, running=0, paused=0, mounts={})
        self.assert_private(self.unchanged(empty, copy.deepcopy(empty)))

    def test_container_addition_and_removal_are_complete_changes(self):
        before, after = snapshot(), snapshot()
        after['containers'].pop()
        after['mounts'].pop(IDS[1])
        after['total'] = after['inspected_total'] = 1
        result = self.changed(before, after)
        self.assertEqual(result['changes']['containers_removed'], [IDS[1]])
        self.assertEqual(result['changes']['containers_added'], [])
        result = self.changed(after, before)
        self.assertEqual(result['changes']['containers_added'], [IDS[1]])
        self.assertEqual(result['changes']['containers_removed'], [])

    def test_unknown_field_array_order_remains_semantic(self):
        before, after = snapshot(), snapshot()
        before['mounts'][IDS[0]][0]['untrusted-key'] = ['untrusted-value-a', 'untrusted-value-b']
        after['mounts'][IDS[0]][0]['untrusted-key'] = ['untrusted-value-b', 'untrusted-value-a']
        result = self.changed(before, after)
        self.assertEqual(result['changes']['mount_changes'], [{'id': IDS[0], 'fields': ['other']}])

    def test_incomplete_or_inconsistent_counts_are_rejected_privately(self):
        for field, value in (('complete', False), ('containers_complete', False), ('total', 3),
                             ('inspected_total', 1), ('running', 2), ('paused', 1),
                             ('total', True), ('inspected_total', 2.0), ('paused', None)):
            with self.subTest(field=field, value=value):
                observed = snapshot()
                observed[field] = value
                with self.assertRaises(docker.Error) as caught:
                    docker.normalize(observed)
                self.assert_private(str(caught.exception))

    def test_duplicate_containers_missing_mount_owner_and_duplicate_destinations_refuse(self):
        for fault in ('duplicate-container', 'missing-owner', 'extra-owner', 'duplicate-destination'):
            with self.subTest(fault=fault):
                observed = snapshot()
                if fault == 'duplicate-container': observed['containers'][1] = copy.deepcopy(observed['containers'][0])
                elif fault == 'missing-owner': observed['mounts'].pop(IDS[0])
                elif fault == 'extra-owner': observed['mounts']['c' * 64] = []
                else: observed['mounts'][IDS[0]].append(copy.deepcopy(observed['mounts'][IDS[0]][0]))
                with self.assertRaises(docker.Error) as caught:
                    docker.normalize(observed)
                self.assert_private(str(caught.exception))

    def test_malformed_required_fields_fail_with_fixed_private_errors(self):
        for fault in ('missing-info', 'missing-count', 'bad-id', 'bad-policy', 'bool-retry',
                      'running-string', 'bad-source', 'missing-destination', 'bad-destination', 'bad-diagnostics'):
            with self.subTest(fault=fault):
                observed = snapshot()
                if fault == 'missing-info': observed.pop('info')
                elif fault == 'missing-count': observed.pop('total')
                elif fault == 'bad-id': observed['containers'][0]['id'] = 'private-id'
                elif fault == 'bad-policy': observed['containers'][0]['restart_policy']['Name'] = 'private-policy'
                elif fault == 'bool-retry': observed['containers'][0]['restart_policy']['MaximumRetryCount'] = True
                elif fault == 'running-string': observed['containers'][0]['running'] = 'private-true'
                elif fault == 'bad-source': observed['mounts'][IDS[0]][0]['Source'] = {'private-key': 'private-value'}
                elif fault == 'missing-destination': observed['mounts'][IDS[0]][0].pop('Destination')
                elif fault == 'bad-destination': observed['mounts'][IDS[0]][0]['Destination'] = ''
                elif fault == 'bad-diagnostics': observed['diagnostics'] = 'private-message'
                with self.assertRaises(docker.Error) as caught:
                    docker.compare(snapshot(), observed)
                self.assert_private(str(caught.exception))

    def test_normalization_and_comparison_never_access_files_or_run_commands(self):
        before, after = snapshot(), snapshot()
        with mock.patch('builtins.open', side_effect=AssertionError('unexpected filesystem read')), \
                mock.patch('os.stat', side_effect=AssertionError('unexpected target stat')), \
                mock.patch('os.lstat', side_effect=AssertionError('unexpected target lstat')), \
                mock.patch('os.readlink', side_effect=AssertionError('unexpected link read')), \
                mock.patch('os.path.realpath', side_effect=AssertionError('unexpected target resolution')), \
                mock.patch('subprocess.run', side_effect=AssertionError('unexpected subprocess')):
            docker.normalize(before)
            self.unchanged(before, after)


if __name__ == '__main__':
    unittest.main()
