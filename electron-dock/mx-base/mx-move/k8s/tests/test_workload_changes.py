import copy
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).parents[1]))
import cluster_ops as ops


UID = '399f2349-3a34-48f4-8105-d7bae56ca136'
NEW_UID = '156c7e8f-68c5-42c0-9320-1cc739c69890'
PRIVATE = 'PRIVATE-DO-NOT-PRINT'


def workload(name='sample', namespace='mx-rig', uid=UID):
    return {'metadata': {'name': name, 'namespace': namespace, 'uid': uid,
                         'annotations': {'private': PRIVATE}},
            'spec': {'template': {'spec': {'containers': [{'env': [{'value': PRIVATE}]}]}}},
            'status': {'message': PRIVATE}}


def completed_job(name='migration'):
    obj = workload(name)
    obj['spec']['ttlSecondsAfterFinished'] = 3600
    obj['status'].update({'active': 0, 'conditions': [{'type': 'Complete', 'status': 'True', 'message': PRIVATE}],
                          'completionTime': '2026-10-20T01:23:45Z'})
    return obj


class ReadOnlyHost:
    def __init__(self, objects):
        self.objects = copy.deepcopy(objects)
        self.calls = []

    def run(self, args, timeout=60, input_data=None):
        self.calls.append((args, timeout, input_data))
        if args[:5] != ['kubectl', '--kubeconfig', '/etc/kubernetes/admin.conf', '--request-timeout=30s', 'get']:
            raise AssertionError('only readonly list requests are allowed')
        kind = args[5]
        if kind not in ops.WORKLOAD_REPORT_KINDS or args[6:] != ['-A', '-o', 'json'] or input_data is not None:
            raise AssertionError('unexpected inventory request')
        return json.dumps({'items': self.objects[kind]}).encode()


class WorkloadChangesTests(unittest.TestCase):
    def setUp(self):
        self.objects = {kind: [workload()] for kind in ops.WORKLOAD_REPORT_KINDS}
        self.objects['jobs'] = [completed_job()]
        self.plan = {'objects': copy.deepcopy(self.objects), 'state': {'private': PRIVATE}}
        self.host = ReadOnlyHost(self.objects)
        self.cluster = ops.Cluster(self.host)

    def test_equal_set_lists_only_six_kinds_and_never_writes_or_changes_baseline(self):
        original = copy.deepcopy(self.plan)
        current = copy.deepcopy(self.host.objects)
        self.assertEqual(self.cluster.workload_changes(self.plan),
                         {'schema_version': 1, 'workload_set_equal': True, 'equivalent': True, 'differences': []})
        self.assertEqual([args[5] for args, _, _ in self.host.calls], list(ops.WORKLOAD_REPORT_KINDS))
        self.assertEqual(self.plan, original)
        self.assertEqual(self.host.objects, current)

    def test_missing_completed_job_reports_only_approved_lifecycle_fields(self):
        self.host.objects['jobs'] = []
        report = self.cluster.workload_changes(self.plan)
        self.assertFalse(report['workload_set_equal'])
        self.assertFalse(report['equivalent'])
        self.assertEqual(report['differences'], [{'kind': 'jobs', 'missing': [{
            'namespace': 'mx-rig', 'name': 'migration', 'uid': UID, 'terminal': 'Complete',
            'active': False, 'ttl_seconds_after_finished': 3600,
            'completion_time': '2026-10-20T01:23:45Z', 'deleting': False}], 'added': [], 'replaced': []}])
        self.assertNotIn(PRIVATE, json.dumps(report))

    def test_added_missing_and_replaced_are_separate_and_sorted(self):
        self.host.objects['deployments'] = [workload('z-new'), workload('a-new')]
        self.host.objects['statefulsets'][0]['metadata']['uid'] = NEW_UID
        report = self.cluster.workload_changes(self.plan)
        self.assertEqual([item['kind'] for item in report['differences']], ['deployments', 'statefulsets'])
        diff, replacement = report['differences']
        self.assertEqual([obj['name'] for obj in diff['missing']], ['sample'])
        self.assertEqual([obj['name'] for obj in diff['added']], ['a-new', 'z-new'])
        self.assertEqual(replacement['replaced'], [{'before': {'namespace': 'mx-rig', 'name': 'sample', 'uid': UID},
                                                   'after': {'namespace': 'mx-rig', 'name': 'sample', 'uid': NEW_UID}}])

    def test_uid_replacement_keeps_set_equal_but_not_equivalent(self):
        self.host.objects['hpa'][0]['metadata']['uid'] = NEW_UID
        report = self.cluster.workload_changes(self.plan)
        self.assertTrue(report['workload_set_equal'])
        self.assertFalse(report['equivalent'])

    def test_job_status_alone_does_not_pretend_set_or_uid_changed(self):
        self.host.objects['jobs'][0]['status']['message'] = 'different private text'
        self.host.objects['deployments'][0]['spec'] = {'private': 'not included in set diagnostics'}
        self.assertTrue(self.cluster.workload_changes(self.plan)['equivalent'])

    def test_added_failed_active_and_unfinished_jobs_have_safe_fields(self):
        failed = completed_job('failed')
        failed['status']['conditions'] = [{'type': 'Failed', 'status': 'True'}]
        failed['status'].pop('completionTime')
        failed['metadata']['deletionTimestamp'] = '2026-10-20T03:04:05Z'
        active = workload('active')
        active['status']['active'] = 2
        self.host.objects['jobs'].extend([failed, active])
        report = self.cluster.workload_changes(self.plan)
        added = {obj['name']: obj for obj in report['differences'][0]['added']}
        self.assertEqual(added['failed']['terminal'], 'Failed')
        self.assertTrue(added['failed']['deleting'])
        self.assertIsNone(added['failed']['completion_time'])
        self.assertIsNone(added['active']['terminal'])
        self.assertTrue(added['active']['active'])
        self.assertIsNone(added['active']['ttl_seconds_after_finished'])
        self.assertNotIn(PRIVATE, json.dumps(report))

    def test_invalid_identities_fail_with_fixed_message_for_baseline_and_live(self):
        invalid = {'name': ['bad/name', 'line\nbreak', 'a' * 254, 'UPPER', None, []],
                   'namespace': ['bad.namespace', 'a' * 64, '', None],
                   'uid': ['secret/token', PRIVATE, '', None, []]}
        for source in ('before', 'after'):
            for field, values in invalid.items():
                for value in values:
                    with self.subTest(source=source, field=field, value=value):
                        self.setUp()
                        objects = self.plan['objects'] if source == 'before' else self.host.objects
                        objects['jobs'][0]['metadata'][field] = value
                        with self.assertRaisesRegex(ops.ClusterError, '^invalid workload report identity; raw values hidden$'):
                            self.cluster.workload_changes(self.plan)

    def test_invalid_job_values_are_not_coerced_or_exposed(self):
        examples = [('spec', 'ttlSecondsAfterFinished', -1), ('spec', 'ttlSecondsAfterFinished', True),
                    ('spec', 'ttlSecondsAfterFinished', PRIVATE), ('status', 'active', -1),
                    ('status', 'active', True), ('status', 'active', PRIVATE),
                    ('status', 'conditions', PRIVATE), ('status', 'conditions', [PRIVATE]),
                    ('status', 'conditions', [{'type': 'Complete', 'status': 'True'}, {'type': 'Failed', 'status': 'True'}])]
        for section, field, value in examples:
            with self.subTest(section=section, field=field, value=value):
                self.setUp()
                self.host.objects['jobs'][0][section][field] = value
                with self.assertRaisesRegex(ops.ClusterError, '^invalid workload report Job fields; raw values hidden$'):
                    self.cluster.workload_changes(self.plan)

    def test_invalid_completion_time_is_hidden(self):
        for value in (PRIVATE, '', '2026-02-30T01:02:03Z', '2026-10-20T25:01:01Z',
                      '2026-10-20T01:01:01+24:00', '2026-10-20T01:01:01+01:60', [], 42):
            with self.subTest(value=value):
                self.setUp()
                self.host.objects['jobs'][0]['status']['completionTime'] = value
                with self.assertRaisesRegex(ops.ClusterError, '^invalid workload report timestamp; raw values hidden$'):
                    self.cluster.workload_changes(self.plan)

    def test_completion_time_preserves_valid_rfc3339_precision_and_offset(self):
        for value in ('2026-10-20T01:02:03.123456789Z', '2026-10-20T01:02:03+08:00'):
            with self.subTest(value=value):
                self.setUp()
                self.plan['objects']['jobs'][0]['status']['completionTime'] = value
                self.host.objects['jobs'] = []
                report = self.cluster.workload_changes(self.plan)
                self.assertEqual(report['differences'][0]['missing'][0]['completion_time'], value)

    def test_duplicate_identities_refuse_ambiguous_report(self):
        self.host.objects['jobs'].append(copy.deepcopy(self.host.objects['jobs'][0]))
        with self.assertRaisesRegex(ops.ClusterError, '^duplicate workload report identity; raw values hidden$'):
            self.cluster.workload_changes(self.plan)

    def test_malformed_metadata_baseline_and_inventory_are_hidden(self):
        for plan in (None, {}, {'objects': []}):
            with self.subTest(plan=plan):
                with self.assertRaisesRegex(ops.ClusterError, '^invalid workload report baseline; raw values hidden$'):
                    self.cluster.workload_changes(plan)
        self.plan['objects']['jobs'] = None
        with self.assertRaisesRegex(ops.ClusterError, '^invalid workload report inventory; raw values hidden$'):
            self.cluster.workload_changes(self.plan)
        self.setUp()
        self.host.objects['jobs'][0]['metadata'] = PRIVATE
        with self.assertRaisesRegex(ops.ClusterError, '^invalid workload report metadata; raw values hidden$'):
            self.cluster.workload_changes(self.plan)


if __name__ == '__main__':
    unittest.main()
