"""The explicit Rig repair is only allowed while restoring original storage."""
import contextlib
import copy
import io
import unittest
from unittest import mock

import test_cutover_host as fixtures

cutover = fixtures.cutover


class RigRepairCutoverTests(unittest.TestCase):
    def fixture(self):
        host = fixtures.host_without_initialization()
        host.storage = mock.Mock()
        host.cluster = mock.Mock(spec=cutover.cluster_ops.Cluster)
        data = fixtures.journal()
        data.update(phase='quiescing', may_write=False)
        data['cluster']['state'] = {'quiesced': True, 'es_snapshot': {'phase': 'verified'}}
        data['storage']['entries'] = [{
            'key': 'rig', 'logical': '/data/mx-rig', 'source': '/data/mx-rig',
            'source_mount': {'uuid': cutover.SOURCE_UUID},
        }]
        return host, data

    def test_checked_original_source_and_cluster_before_repair_then_persist(self):
        host, data = self.fixture()
        persist = mock.Mock()
        order = []
        host.storage.validate_source.side_effect = lambda entry: order.append('storage')
        host.cluster.validate_cluster_baseline.side_effect = lambda plan: order.append('identity')
        host.cluster.assert_workloads.side_effect = lambda plan: order.append('workloads')
        def repair(cluster, plan, save):
            self.assertIs(cluster, host.cluster)
            self.assertIs(plan, data['cluster'])
            order.append('repair')
            save(plan)
        with mock.patch.object(cutover.os.path, 'lexists', return_value=False), \
                mock.patch.object(cutover.rig_init_repair, 'repair', side_effect=repair), \
                mock.patch.object(cutover.prep, 'stage'):
            host.repair_rig_init(data, persist)
        self.assertEqual(order, ['storage', 'identity', 'workloads', 'repair'])
        persist.assert_called_once_with()
        self.assertEqual(data['phase'], 'quiescing')
        self.assertFalse(data['may_write'])

    def test_committed_unquiesced_changed_source_or_copied_data_refuse(self):
        for mutation in ('phase', 'may_write', 'quiesced', 'snapshot', 'source', 'uuid', 'copied', 'target'):
            with self.subTest(mutation=mutation):
                host, data = self.fixture()
                entry = data['storage']['entries'][0]
                if mutation == 'phase': data['phase'] = 'copying'
                elif mutation == 'may_write': data['may_write'] = True
                elif mutation == 'quiesced': data['cluster']['state']['quiesced'] = False
                elif mutation == 'snapshot': data['cluster']['state']['es_snapshot']['phase'] = 'started'
                elif mutation == 'source': entry['source'] = '/mnt/nas/rig'
                elif mutation == 'uuid': entry['source_mount']['uuid'] = cutover.ROOT_UUID
                elif mutation == 'copied': entry['copied'] = True
                else: entry['target_identity'] = {'device': 1, 'inode': 2}
                before = copy.deepcopy(data)
                with mock.patch.object(cutover.os.path, 'lexists', return_value=False), \
                        mock.patch.object(cutover.rig_init_repair, 'repair') as repair, \
                        self.assertRaises(cutover.prep.Refuse):
                    host.repair_rig_init(data, mock.Mock())
                repair.assert_not_called()
                host.storage.validate_source.assert_not_called()
                self.assertEqual(data, before)

    def test_switch_files_or_failed_baseline_refuse_without_repair(self):
        for stage in ('switch-files', 'storage', 'identity', 'workloads'):
            with self.subTest(stage=stage):
                host, data = self.fixture()
                if stage != 'switch-files':
                    target = {'storage': host.storage.validate_source,
                              'identity': host.cluster.validate_cluster_baseline,
                              'workloads': host.cluster.assert_workloads}[stage]
                    target.side_effect = cutover.prep.Refuse('fixture guard')
                with mock.patch.object(cutover.os.path, 'lexists', return_value=stage == 'switch-files'), \
                        mock.patch.object(cutover.rig_init_repair, 'repair') as repair, \
                        self.assertRaises(cutover.prep.Refuse):
                    host.repair_rig_init(data, mock.Mock())
                repair.assert_not_called()

    def test_explicit_flag_repairs_under_lock_before_resume(self):
        with contextlib.ExitStack() as stack:
            host, data, lock = fixtures.MainDispatchTests().fixture(stack, 'resume')
            order = []
            def repair(journal, persist):
                self.assertTrue(lock['held'])
                self.assertEqual(journal, data)
                self.assertTrue(callable(persist))
                order.append('repair')
            host.repair_rig_init.side_effect = repair
            resume = stack.enter_context(mock.patch.object(cutover.Move, 'resume',
                                                           side_effect=lambda: order.append('resume')))
            cutover.main(['resume', '--repair-rig-init'])
            self.assertEqual(order, ['repair', 'resume'])
            resume.assert_called_once_with()

    def test_flag_on_other_actions_rejected_before_host_access(self):
        for action in ('status', 'migrate', 'verify', 'cutover-check', 'prepare-check'):
            with self.subTest(action=action), mock.patch.object(cutover, 'Host') as host, \
                    contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as caught:
                cutover.main([action, '--repair-rig-init'])
            self.assertEqual(caught.exception.code, 2)
            host.assert_not_called()

    def test_active_migration_lock_refuses_repair_and_resume(self):
        with contextlib.ExitStack() as stack:
            host, data, lock = fixtures.MainDispatchTests().fixture(stack, 'resume')
            stack.enter_context(mock.patch.object(cutover, 'locks',
                                                 side_effect=cutover.prep.Refuse('migration active')))
            resume = stack.enter_context(mock.patch.object(cutover.Move, 'resume'))
            with self.assertRaises(cutover.prep.Refuse):
                cutover.main(['resume', '--repair-rig-init'])
            host.repair_rig_init.assert_not_called()
            resume.assert_not_called()


if __name__ == '__main__':
    unittest.main()
