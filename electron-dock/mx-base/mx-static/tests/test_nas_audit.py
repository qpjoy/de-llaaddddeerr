"""Read-only audit regression tests; no Docker daemon or NAS required."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import runpy
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location('nas_' + name, ROOT / 'scripts/nas' / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


layout = load('layout')
media = load('media')


class LayoutTests(unittest.TestCase):
    def test_mount_identity_and_no_automount_substitute(self):
        self.assertTrue(layout.expected_mount('/mnt/nas nas-storage:/volume1/data1 nfs\n'))
        self.assertTrue(layout.expected_mount('/mnt/nas 192.168.1.3:/volume1/data1 nfs4\n'))
        for value in ('', '/mnt/nas systemd-1 autofs', '/mnt/nas bad:/volume1/data1 nfs',
                      '/other nas-storage:/volume1/data1 nfs',
                      '/mnt/nas nas-storage:/volume1/wrong nfs'):
            self.assertFalse(layout.expected_mount(value))

    def test_wrong_mount_never_inspects_remote_paths(self):
        paths = []
        def inspect(path, *args):
            self.assertFalse(path.startswith('/mnt/nas'))
            paths.append(path)
            return {'path': path}
        result = subprocess.CompletedProcess([], 1, '', '')
        with patch.object(layout, 'inspect_path', side_effect=inspect), \
                patch.object(layout.subprocess, 'run', return_value=result), \
                patch.object(layout.os, 'statvfs') as capacity, \
                contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(SystemExit, 'Refused NAS traversal'):
                layout.main()
        self.assertEqual(paths, ['/data', '/data/docker', '/data/k8s'])
        capacity.assert_not_called()

    def test_missing_symlink_and_bounded_listing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            real = root / 'existing'; real.mkdir()
            for number in range(80):
                (real / str(number)).mkdir()
            (root / 'alias').symlink_to(real, target_is_directory=True)
            self.assertEqual(layout.inspect_path(str(root / 'absent'))['status'], 'missing')
            skipped = layout.inspect_path(str(root / 'alias/subpath'), True)
            self.assertEqual(skipped['status'], 'symlink-component-skipped')
            result = layout.inspect_path(str(real), True)
            self.assertTrue(result['sample_truncated'])
            self.assertEqual(len(result['sample_names']), 50)
            self.assertEqual(len(list(real.iterdir())), 80)


class MediaTests(unittest.TestCase):
    def test_counts_and_no_link_traversal_or_modification(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            temporary = root / 'raw-media-test.tmp'; temporary.write_bytes(b'abc')
            os.utime(temporary, (time.time() - 90000,) * 2)
            formal = root / 'final.mp4'; formal.write_bytes(b'video!')
            os.link(str(formal), str(root / 'hardlink.mp4'))
            (root / 'loop').symlink_to(root, target_is_directory=True)
            before = (temporary.read_bytes(), formal.read_bytes(), temporary.stat().st_mtime)
            result = media.scan_tree(str(root))
            self.assertEqual(result['groups']['TOTAL'], {'files': 3, 'logical_bytes': 15})
            self.assertEqual(result['groups']['temp-older-than-24h'], {'files': 1, 'logical_bytes': 3})
            self.assertEqual(result['skipped_symlinks_or_other_devices'], 1)
            self.assertEqual(result['file_paths_with_multiple_hardlinks'], 2)
            self.assertEqual(result['error_count'], 0)
            self.assertEqual(before, (temporary.read_bytes(), formal.read_bytes(), temporary.stat().st_mtime))

    def test_refuse_network_source_before_resolving_path(self):
        volume = 'po_infra_media_data'
        metadata = [{'Driver': 'local', 'Options': None,
                     'Mountpoint': '/data/docker/volumes/' + volume + '/_data'}]
        with patch.object(media.subprocess, 'check_output', side_effect=[json.dumps(metadata).encode(),
                                                                        'nas-storage:/volume1/data1 nfs\n']), \
                patch.object(media.os.path, 'realpath') as realpath:
            with self.assertRaisesRegex(SystemExit, 'not the expected local SSD'):
                media.checked_root(volume)
        realpath.assert_not_called()

    def test_volume_driver_options_are_not_local_ssd_proof(self):
        metadata = [{'Driver': 'local', 'Options': {'type': 'nfs'},
                     'Mountpoint': '/data/docker/volumes/po_infra_media_data/_data'}]
        with patch.object(media.subprocess, 'check_output', return_value=json.dumps(metadata).encode()) as run:
            with self.assertRaisesRegex(SystemExit, 'Unexpected volume definition'):
                media.checked_root('po_infra_media_data')
        self.assertEqual(run.call_count, 1)

    def test_scan_errors_are_visible_and_main_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(media.os, 'scandir', side_effect=PermissionError('fixture denial')):
                result = media.scan_tree(directory)
            self.assertEqual(result['error_count'], 1)
            with patch.object(media, 'checked_root', return_value=directory), \
                    patch.object(media, 'scan_tree', return_value=result.copy()), \
                    contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaisesRegex(SystemExit, 'Incomplete metadata scan'):
                    media.main()


class DeploymentTests(unittest.TestCase):
    def test_secrets_excluded_and_parent_bind_consumer_reported(self):
        target = {'Name': '/mx_data-web-1', 'Image': 'sha256:fixture',
                  'State': {'Status': 'running'}, 'HostConfig': {'RestartPolicy': {'Name': 'unless-stopped'}},
                  'Config': {'Image': 'fixture:existing', 'User': '1000',
                             'Env': ['API_KEY=SECRET_VALUE', 'MX_DB_PASSWORD=SECRET_VALUE',
                                     'MEDIA_ROOT=/app/media', 'GIT_COMMIT=abc'],
                             'Labels': {'com.docker.compose.service': 'web'}},
                  'Mounts': [{'Type': 'volume', 'Name': 'po_infra_media_data', 'RW': True}]}
        extra = {'Name': '/host-maintenance', 'Mounts': [
            {'Type': 'bind', 'Source': '/data', 'Destination': '/host-data', 'RW': True}]}
        calls = []
        def run(args, **kwargs):
            calls.append(args)
            if args == ['docker', 'ps', '-aq']:
                output = 'id1\nid2'
            elif args[:2] == ['docker', 'inspect']:
                output = json.dumps([target, extra])
            elif args[:3] == ['docker', 'image', 'inspect']:
                output = json.dumps([{'Id': 'sha256:fixture', 'Config': {'Env': ['TOKEN=SECRET_VALUE']}}])
            else:
                output = 'mock metadata'
            return subprocess.CompletedProcess(args, 0, output, '')
        capture = io.StringIO()
        with patch('subprocess.run', side_effect=run), contextlib.redirect_stdout(capture):
            runpy.run_path(str(ROOT / 'scripts/nas/deployment.py'), run_name='__main__')
        output = capture.getvalue()
        self.assertNotIn('SECRET_VALUE', output)
        self.assertIn('/host-maintenance', output)
        self.assertIn('/app/media', output)
        self.assertIn('abc', output)
        for args in calls:
            self.assertNotIn('restart', args)
            self.assertNotIn('prune', args)
            self.assertNotIn('mount', args)


class EntryTests(unittest.TestCase):
    def test_help_and_bad_mode_need_no_server(self):
        script = str(ROOT / 'scripts/nas-audit.sh')
        help_result = subprocess.run(['bash', script, '--help'], stdout=subprocess.PIPE)
        self.assertEqual(help_result.returncode, 0)
        self.assertIn(b'layout', help_result.stdout)
        bad = subprocess.run(['bash', script, 'copy'], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.assertEqual(bad.returncode, 2)


if __name__ == '__main__':
    unittest.main()
