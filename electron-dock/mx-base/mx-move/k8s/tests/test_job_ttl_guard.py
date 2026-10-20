import copy
import datetime
import unittest
from unittest import mock

from test_cluster_ops import FakeHost, obj, ops


JOB_UID = '7d914a1b-a9cc-4a55-8f3d-88f25de7d4d4'
FINISHED = '2026-10-18T21:54:26Z'
DEADLINE = datetime.datetime(2026, 10, 19, 21, 54, 26,
                             tzinfo=datetime.timezone.utc).timestamp()


def completed_job():
    job = obj('mx-harbor-migrate-256cfbfe', 'mx-harbor',
              spec={'ttlSecondsAfterFinished': 86400, 'template': {'spec': {}}},
              status={'active': 0, 'completionTime': FINISHED,
                      'conditions': [{'type': 'Complete', 'status': 'True',
                                      'lastTransitionTime': FINISHED}]})
    job['metadata']['uid'] = JOB_UID
    return job


def job_pod():
    pod = obj('mx-harbor-migrate-256cfbfe-test', 'mx-harbor',
              spec={'nodeName': 'node'},
              status={'phase': 'Succeeded', 'containerStatuses': [
                  {'name': 'migrate', 'state': {'terminated': {'exitCode': 0}}}]})
    pod['metadata']['ownerReferences'] = [
        {'kind': 'Job', 'name': 'mx-harbor-migrate-256cfbfe',
         'uid': JOB_UID, 'controller': True}]
    return pod


class JobTTLGuardTests(unittest.TestCase):
    def setUp(self):
        self.host = FakeHost()
        self.host.objects['jobs'] = [completed_job()]
        self.host.objects['pods'] = [job_pod()]
        self.cluster = ops.Cluster(self.host)
        self.plan = self.cluster.snapshot()
        self.now = DEADLINE + 60
        self.clock = mock.patch.object(ops.time, 'time', side_effect=lambda: self.now)
        self.clock.start()
        self.addCleanup(self.clock.stop)

    def missing_job(self):
        self.host.objects['jobs'] = []
        self.host.calls.clear()

    def assert_refused(self):
        with self.assertRaises(ops.ClusterError):
            self.cluster.assert_workloads(self.plan)

    def test_expired_completed_job_missing_is_read_only_and_retains_baseline(self):
        original = copy.deepcopy(self.plan)
        self.missing_job()
        self.cluster.assert_workloads(self.plan)
        self.assertEqual(self.plan, original)
        self.assertTrue(all(args[4] == 'get' and raw is None
                            for args, raw in self.host.calls))

    def test_deadline_is_inclusive_and_checks_more_than_completion_time(self):
        self.missing_job()
        self.now = DEADLINE - 0.001
        self.assert_refused()
        self.now = DEADLINE
        self.cluster.assert_workloads(self.plan)
        self.plan['objects']['jobs'][0]['status']['conditions'][0][
            'lastTransitionTime'] = '2026-10-18T21:54:27Z'
        self.assert_refused()
        self.now = DEADLINE + 1
        self.cluster.assert_workloads(self.plan)

    def test_rfc3339_timezone_offsets_and_fractional_seconds(self):
        self.missing_job()
        status = self.plan['objects']['jobs'][0]['status']
        status['completionTime'] = '2026-10-19T05:54:26.250+08:00'
        status['conditions'][0]['lastTransitionTime'] = '2026-10-18T16:54:26.500-05:00'
        self.now = DEADLINE + 0.49
        self.assert_refused()
        self.now = DEADLINE + 0.5
        self.cluster.assert_workloads(self.plan)

    def test_zero_ttl_accepts_at_terminal_time(self):
        self.missing_job()
        self.plan['objects']['jobs'][0]['spec']['ttlSecondsAfterFinished'] = 0
        self.now = DEADLINE - 86400
        self.cluster.assert_workloads(self.plan)
        self.now -= 1
        self.assert_refused()

    def test_missing_or_invalid_ttl_refuses(self):
        self.missing_job()
        spec = self.plan['objects']['jobs'][0]['spec']
        for value in (None, True, False, -1, 1.5, '86400', [], {}):
            with self.subTest(value=value):
                spec['ttlSecondsAfterFinished'] = value
                self.assert_refused()
        del spec['ttlSecondsAfterFinished']
        self.assert_refused()

    def test_missing_or_invalid_timestamp_refuses_for_both_fields(self):
        self.missing_job()
        status = self.plan['objects']['jobs'][0]['status']
        for target, field in ((status, 'completionTime'),
                              (status['conditions'][0], 'lastTransitionTime')):
            for value in (None, '', 123, '2026-10-18', '2026-10-18T21:54:26',
                          '2026-02-30T21:54:26Z', '2026-10-18T25:54:26Z',
                          '2026-10-18T21:54:26+24:00', '2026-10-18T21:54:26+08:60',
                          '2026-10-18T21:54:26.1234567890Z'):
                with self.subTest(field=field, value=value):
                    target[field] = value
                    self.assert_refused()
            del target[field]
            self.assert_refused()
            target[field] = FINISHED

    def test_unfinished_failed_or_duplicate_complete_condition_refuses(self):
        self.missing_job()
        status = self.plan['objects']['jobs'][0]['status']
        complete = copy.deepcopy(status['conditions'][0])
        examples = [[], [dict(complete, status='False')],
                    [dict(complete, type='Failed')],
                    [complete, dict(complete, type='Failed')],
                    [complete, copy.deepcopy(complete)]]
        for conditions in examples:
            with self.subTest(conditions=conditions):
                status['conditions'] = conditions
                self.assert_refused()

    def test_active_or_terminating_job_refuses(self):
        self.missing_job()
        status = self.plan['objects']['jobs'][0]['status']
        for field in ('active', 'terminating'):
            status[field] = 1
            with self.subTest(field=field):
                self.assert_refused()
            status[field] = 0

    def test_deleting_or_invalid_job_identity_refuses(self):
        self.missing_job()
        metadata = self.plan['objects']['jobs'][0]['metadata']
        metadata['deletionTimestamp'] = FINISHED
        self.assert_refused()
        del metadata['deletionTimestamp']
        for uid in ('', 'not-a-uuid', None):
            with self.subTest(uid=uid):
                metadata['uid'] = uid
                self.assert_refused()
        del metadata['uid']
        self.assert_refused()

    def test_terminal_pods_may_be_retained_or_gone(self):
        self.missing_job()
        for phase in ('Succeeded', 'Failed'):
            with self.subTest(phase=phase):
                self.host.objects['pods'][0]['status']['phase'] = phase
                self.plan['objects']['pods'][0]['status']['phase'] = phase
                self.cluster.assert_workloads(self.plan)
        self.host.objects['pods'] = []
        self.cluster.assert_workloads(self.plan)
        self.plan['objects']['pods'] = []
        self.cluster.assert_workloads(self.plan)

    def test_baseline_and_current_nonterminal_job_pods_refuse(self):
        self.missing_job()
        for scope in ('baseline', 'current'):
            pods = (self.plan['objects'] if scope == 'baseline' else self.host.objects)['pods']
            for phase in ('Pending', 'Running', 'Unknown', None):
                with self.subTest(scope=scope, phase=phase):
                    pods[0]['status']['phase'] = phase
                    self.assert_refused()
            pods[0]['status']['phase'] = 'Succeeded'

    def test_running_or_waiting_container_in_terminal_job_pod_refuses(self):
        self.missing_job()
        for scope in ('baseline', 'current'):
            pod = (self.plan['objects'] if scope == 'baseline' else self.host.objects)['pods'][0]
            for field in ('containerStatuses', 'initContainerStatuses', 'ephemeralContainerStatuses'):
                for state in ('running', 'waiting'):
                    with self.subTest(scope=scope, field=field, state=state):
                        saved = copy.deepcopy(pod['status'])
                        pod['status'][field] = [{'name': 'unexpected', 'state': {state: {}}}]
                        self.assert_refused()
                        pod['status'] = saved

    def test_controller_uid_labels_also_identify_surviving_job_pods(self):
        self.missing_job()
        for scope in ('baseline', 'current'):
            pod = (self.plan['objects'] if scope == 'baseline' else self.host.objects)['pods'][0]
            original = copy.deepcopy(pod)
            for label in ('controller-uid', 'batch.kubernetes.io/controller-uid'):
                with self.subTest(scope=scope, label=label):
                    pod['metadata']['ownerReferences'] = []
                    pod['metadata']['labels'] = {label: JOB_UID}
                    pod['status']['phase'] = 'Running'
                    self.assert_refused()
                    pod['status']['phase'] = 'Succeeded'
                    self.cluster.assert_workloads(self.plan)
            pod.clear()
            pod.update(original)

    def test_different_job_uid_pod_does_not_block_expired_job(self):
        self.missing_job()
        pod = job_pod()
        pod['metadata']['ownerReferences'][0]['uid'] = '11111111-1111-1111-1111-111111111111'
        pod['status']['phase'] = 'Running'
        self.host.objects['pods'].append(pod)
        self.cluster.assert_workloads(self.plan)

    def test_present_job_uid_spec_and_deletion_checks_remain_strict(self):
        for mutation in ('uid', 'spec', 'deleting', 'active'):
            with self.subTest(mutation=mutation):
                job = copy.deepcopy(self.plan['objects']['jobs'][0])
                self.host.objects['jobs'] = [job]
                if mutation == 'uid':
                    job['metadata']['uid'] = '11111111-1111-1111-1111-111111111111'
                elif mutation == 'spec':
                    job['spec']['ttlSecondsAfterFinished'] += 1
                elif mutation == 'deleting':
                    job['metadata']['deletionTimestamp'] = FINISHED
                else:
                    job['status']['active'] = 1
                self.assert_refused()

    def test_new_job_or_other_missing_workload_still_refuses(self):
        self.missing_job()
        extra = completed_job()
        extra['metadata'].update(name='other-job', uid='11111111-1111-1111-1111-111111111111')
        self.host.objects['jobs'] = [extra]
        self.assert_refused()
        self.host.objects['jobs'] = []
        for kind in ('deployments', 'statefulsets', 'daemonsets'):
            with self.subTest(kind=kind):
                old = self.host.objects[kind]
                self.host.objects[kind] = []
                self.assert_refused()
                self.host.objects[kind] = old

    def test_quiesce_resume_then_expiry_and_resume_does_not_restart_services(self):
        original_objects = copy.deepcopy(self.plan['objects'])
        persisted = []
        persist = lambda plan: persisted.append(copy.deepcopy(plan))
        self.now = DEADLINE - 60
        self.cluster.quiesce(self.plan, persist)
        self.cluster.resume(self.plan, persist)
        self.now = DEADLINE + 60
        self.missing_job()
        self.host.objects['pods'] = []
        self.cluster.resume(self.plan, persist)
        self.assertTrue(self.plan['state']['resumed'])
        self.assertEqual(self.plan['objects'], original_objects)
        self.assertTrue(all(args[4] == 'get' and raw is None
                            for args, raw in self.host.calls))


if __name__ == '__main__':
    unittest.main()
