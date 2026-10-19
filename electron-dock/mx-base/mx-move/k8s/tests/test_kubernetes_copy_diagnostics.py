"""Copy failure diagnostics expose bounded metadata, never source file contents."""
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).parents[1]))
try:
    import cutover
finally:
    sys.path.pop(0)


class KubernetesCopyDiagnosticsTests(unittest.TestCase):
    def project(self, entries):
        return cutover.kubernetes_copy_diagnostics(shutil.Error(entries))

    def test_mixed_errors_preserve_relative_paths_and_fixed_categories_only(self):
        value = self.project([
            ('/etc/kubernetes/pki/etcd/server.key', '/private/secret-target',
             '[Errno 13] permission detail with credential=private-secret'),
            ('/etc/kubernetes', '/private/destination', '[Errno 28] disk-full-sensitive-output'),
            ('/etc/kubernetes/admin.conf', '/private/destination', 'raw password=do-not-output'),
        ])
        self.assertEqual(value, {
            'copy_errors': [
                {'path': 'pki/etcd/server.key', 'errno': 13, 'reason': 'permission_denied'},
                {'path': '.', 'errno': 28, 'reason': 'no_space'},
                {'path': 'admin.conf', 'errno': None, 'reason': 'unclassified_copy_error'},
            ], 'copy_error_count': 3, 'copy_errors_truncated': False,
        })
        self.assertNotIn('secret', json.dumps(value))
        self.assertNotIn('password', json.dumps(value))

    def test_unsafe_sources_never_become_visible_paths(self):
        paths = ['/etc/kubernetes-elsewhere/token', '/etc/kubernetes/../private-key',
                 '/etc/kubernetes/pki/../../key', '/etc/kubernetes/./key',
                 '/etc/kubernetes//key', '/etc/kubernetes/key\nsecret',
                 '/etc/kubernetes/key\x00secret', '/etc/kubernetes/密钥',
                 '/etc/kubernetes/' + 'x' * 129, '/etc/kubernetes/' + 'dir/' * 129 + 'key',
                 'etc/kubernetes/key', '/etc/kubernetes/', '/mnt/nas/key',
                 b'/etc/kubernetes/key', Path('/etc/kubernetes/key')]
        value = self.project([(path, 'secret-destination', '[Errno 2] raw secret') for path in paths])
        self.assertEqual(len(value['copy_errors']), len(paths))
        self.assertTrue(all(entry['path'] == 'unknown' for entry in value['copy_errors']))
        self.assertNotIn('secret', json.dumps(value))

    def test_errno_requires_strict_leading_standard_marker(self):
        messages = ['prefix [Errno 13] secret', '[Errno -13] secret', '[Errno 013] secret',
                    '[Errno 12345] secret', '[Errno 13]secret', '[Errno １３] secret',
                    b'[Errno 13] secret', None]
        value = self.project([('/etc/kubernetes/admin.conf', 'destination', message) for message in messages])
        self.assertTrue(all(entry['errno'] is None for entry in value['copy_errors']))
        self.assertTrue(all(entry['reason'] == 'unclassified_copy_error' for entry in value['copy_errors']))
        unknown = self.project([('/etc/kubernetes/admin.conf', 'destination', '[Errno 1234]')])
        self.assertEqual(unknown['copy_errors'][0]['reason'], 'filesystem_error')
        self.assertEqual(unknown['copy_errors'][0]['errno'], 1234)

    def test_malformed_aggregate_entries_are_bounded_unknowns(self):
        value = self.project(['private error text', None, {}, ('bad', 'shape')])
        self.assertEqual(value['copy_error_count'], 4)
        self.assertTrue(all(entry == {'path': 'unknown', 'errno': None, 'reason': 'unclassified_copy_error'}
                            for entry in value['copy_errors']))
        self.assertNotIn('private', json.dumps(value))
        self.assertEqual(self.project('private raw error')['copy_error_count'], 1)

    def test_more_than_twenty_failures_report_total_and_truncation(self):
        value = self.project([('/etc/kubernetes/pki/key-{}'.format(i), 'hidden', '[Errno 2] hidden')
                              for i in range(25)])
        self.assertEqual(value['copy_error_count'], 25)
        self.assertEqual(len(value['copy_errors']), 20)
        self.assertTrue(value['copy_errors_truncated'])
        exact = self.project([('/etc/kubernetes/pki/key', 'hidden', '[Errno 2] hidden')] * 20)
        self.assertFalse(exact['copy_errors_truncated'])

    def test_projection_does_not_access_any_source_or_destination(self):
        error = shutil.Error([('/etc/kubernetes/pki/key', '/mnt/nas/private', '[Errno 13] private')])
        with mock.patch('builtins.open', side_effect=AssertionError('unexpected read')), \
                mock.patch.object(os, 'lstat', side_effect=AssertionError('unexpected lstat')), \
                mock.patch.object(os, 'stat', side_effect=AssertionError('unexpected stat')), \
                mock.patch.object(os, 'readlink', side_effect=AssertionError('unexpected readlink')), \
                mock.patch.object(os.path, 'realpath', side_effect=AssertionError('unexpected realpath')):
            value = cutover.kubernetes_copy_diagnostics(error)
        self.assertEqual(value['copy_errors'][0]['path'], 'pki/key')

    def test_real_copytree_broken_link_failure_retains_errno_without_target(self):
        with tempfile.TemporaryDirectory(prefix='mx-copy-diagnostic-') as directory:
            source, target = Path(directory) / 'source', Path(directory) / 'backup'
            source.mkdir()
            (source / 'broken-client.conf').symlink_to('private-secret-target')
            try:
                shutil.copytree(str(source), str(target))
            except shutil.Error as error:
                # The production prefix is mapped lexically; the real shutil
                # aggregate and its errno/message formatting remain unchanged.
                mapped = [(str(path).replace(str(source), '/etc/kubernetes', 1), dest, message)
                          for path, dest, message in error.args[0]]
            else:
                self.fail('copytree unexpectedly followed a missing fixture target')
            value = self.project(mapped)
        self.assertEqual(value['copy_errors'], [
            {'path': 'broken-client.conf', 'errno': 2, 'reason': 'missing_path'}])
        self.assertNotIn('private-secret-target', json.dumps(value))
        self.assertNotIn(directory, json.dumps(value))

    def test_only_kubernetes_backup_errors_gain_aggregate_projection(self):
        backend = SimpleNamespace(CommandFailed=type('CommandFailed', (Exception,), {}),
                                  Refuse=type('EtcdRefuse', (Exception,), {}))
        error = shutil.Error([('/etc/kubernetes/pki/key', 'hidden', '[Errno 2] hidden')])
        value = cutover.preparation_diagnostic(error, 'kubernetes-backup', backend)
        self.assertEqual(value['reason'], 'copy_failed')
        self.assertEqual(value['copy_error_count'], 1)
        self.assertEqual(value['copy_errors'][0]['path'], 'pki/key')
        unrelated = cutover.preparation_diagnostic(error, 'etcd-tool-backup', backend)
        self.assertNotIn('copy_errors', unrelated)


if __name__ == '__main__':
    unittest.main()
