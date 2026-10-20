"""Offline behavior tests: staging does not install or start a second daemon."""
import hashlib
import io
import json
import os
from pathlib import Path
import stat
import sys
import tarfile
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).parents[1]))
try:
    import runtime_prepare as prep
finally:
    sys.path.pop(0)


def archive_fixture(path, bad_hash=False, unsafe=False, omit=None, multiarch=False,
                    architecture='amd64', aliases=False, docker=False, descriptor_size_delta=0):
    entries = []
    def blob(value, kind, label):
        content = json.dumps(value).encode() if isinstance(value, dict) else value
        digest = hashlib.sha256(content).hexdigest()
        if label != omit:
            entries.append(('blobs/sha256/' + digest, content + b'changed' if bad_hash and label == 'layer' else content))
        return {'mediaType': kind, 'digest': 'sha256:' + digest, 'size': len(content)}
    config_kind = 'application/vnd.docker.container.image.v1+json' if docker else 'application/vnd.oci.image.config.v1+json'
    manifest_kind = 'application/vnd.docker.distribution.manifest.v2+json' if docker else 'application/vnd.oci.image.manifest.v1+json'
    index_kind = 'application/vnd.docker.distribution.manifest.list.v2+json' if docker else 'application/vnd.oci.image.index.v1+json'
    config = blob({'architecture': architecture, 'os': 'linux'}, config_kind, 'config')
    layer = blob(b'layer-content', 'application/vnd.oci.image.layer.v1.tar', 'layer')
    layer['size'] += descriptor_size_delta
    manifest = blob({'schemaVersion': 2, 'mediaType': manifest_kind, 'config': config,
                     'layers': [layer]}, manifest_kind, 'manifest')
    root = manifest
    if multiarch:
        local = dict(manifest, platform={'os': 'linux', 'architecture': architecture})
        foreign = {'mediaType': manifest_kind, 'digest': 'sha256:' + 'a' * 64,
                   'size': 123, 'platform': {'os': 'linux', 'architecture': 's390x'}}
        root = blob({'schemaVersion': 2, 'mediaType': index_kind, 'manifests': [foreign, local]}, index_kind, 'platform-index')
    roots = [dict(root, annotations={'io.containerd.image.name': 'registry/app:one'})]
    if aliases:
        roots.append(dict(root, annotations={'org.opencontainers.image.ref.name': 'alias'}))
    index = {'schemaVersion': 2, 'manifests': roots}
    entries = [('oci-layout', json.dumps({'imageLayoutVersion': '1.0.0'}).encode()),
               ('index.json', json.dumps(index).encode())] + entries
    if unsafe:
        entries.append(('../escape', b'invalid'))
    with tarfile.open(str(path), 'w') as archive:
        for name, data in entries:
            info = tarfile.TarInfo(name)
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))
    return root['digest']


class ArtifactTests(unittest.TestCase):
    def test_private_file_is_exclusive_and_never_overwrites(self):
        with tempfile.TemporaryDirectory() as folder:
            file = Path(folder) / 'config.toml'
            prep.save_private(file, 'private-value')
            self.assertEqual(stat.S_IMODE(file.stat().st_mode), 0o600)
            with self.assertRaises(FileExistsError):
                prep.save_private(file, 'overwritten')
            self.assertEqual(file.read_text(), 'private-value')

    def test_archive_checks_blob_hash_and_requested_roots_without_extracting(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'images.tar'
            digest = archive_fixture(path)
            result = prep.verify_archive(path, [digest])
            self.assertTrue(result['blob_hashes_verified'])
            self.assertEqual(result['platform_graph_verified'], 'linux/amd64')
            self.assertFalse(result['import_verified'])
            self.assertEqual(list(Path(folder).iterdir()), [path])
            with self.assertRaises(prep.Refuse):
                prep.verify_archive(path, ['sha256:' + '1' * 64])
            archive_fixture(path, bad_hash=True)
            with self.assertRaises(prep.Refuse):
                prep.verify_archive(path)
            archive_fixture(path, unsafe=True)
            with self.assertRaises(prep.Refuse):
                prep.verify_archive(path)

    def test_archive_requires_local_manifest_config_and_every_layer(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'images.tar'
            for missing in ('manifest', 'config', 'layer'):
                with self.subTest(missing=missing):
                    digest = archive_fixture(path, omit=missing)
                    with self.assertRaises(prep.Refuse):
                        prep.verify_archive(path, [digest])
            digest = archive_fixture(path, descriptor_size_delta=1)
            with self.assertRaises(prep.Refuse):
                prep.verify_archive(path, [digest])

    def test_archive_allows_unexported_foreign_platforms_and_image_aliases(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'images.tar'
            for docker in (False, True):
                with self.subTest(docker=docker):
                    digest = archive_fixture(path, multiarch=True, aliases=True, docker=docker)
                    result = prep.verify_archive(path, [digest, digest], 'linux/amd64')
                    self.assertEqual(result['index_descriptors'], 2)
                    self.assertEqual(result['blob_count'], 4)
                    self.assertFalse(result['import_verified'])
                    archive_fixture(path, multiarch=True, omit='layer', docker=docker)
                    with self.assertRaises(prep.Refuse):
                        prep.verify_archive(path)

    def test_archive_checks_config_architecture_and_requested_platform(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'images.tar'
            for multiarch in (False, True):
                digest = archive_fixture(path, architecture='arm64', multiarch=multiarch)
                with self.assertRaises(prep.Refuse):
                    prep.verify_archive(path, [digest], 'linux/amd64')
                result = prep.verify_archive(path, [digest], 'linux/arm64')
                self.assertEqual(result['platform_graph_verified'], 'linux/arm64')

    def test_archive_rejects_symlinks(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'images.tar'
            with tarfile.open(str(path), 'w') as archive:
                entry = tarfile.TarInfo('blobs/sha256/x')
                entry.type = tarfile.SYMTYPE
                entry.linkname = '/etc/passwd'
                archive.addfile(entry)
            with self.assertRaises(prep.Refuse):
                prep.verify_archive(path)

    def test_ctr_table_preserves_digest_and_ignores_labels(self):
        digest = 'sha256:' + 'a' * 64
        raw = 'REF TYPE DIGEST SIZE PLATFORMS LABELS\nregistry/app:one application/vnd.oci.image.manifest.v1+json ' + digest + ' 20.0 MiB linux/amd64 secret=not-reported\n'
        images = prep.parse_images(raw)
        self.assertEqual(images[0]['platforms'], 'linux/amd64')
        self.assertNotIn('secret', json.dumps(images))
        with self.assertRaises(prep.Refuse):
            prep.parse_images(raw + raw.splitlines()[1])
        with self.assertRaises(prep.Refuse):
            prep.parse_images('REF TYPE DIGEST SIZE PLATFORMS LABELS\n')

    def test_stream_export_writes_private_file_and_matches_hash(self):
        with tempfile.TemporaryDirectory() as folder, mock.patch.object(prep, 'available', return_value=10 * prep.GIB):
            path = Path(folder) / 'archive.tar'
            result = prep.export_archive([sys.executable, '-c', 'import sys;sys.stdout.buffer.write(b"archive-data")'], path, reserve=0)
            self.assertEqual(result['sha256'], prep.sha256_file(path))
            self.assertEqual(result['bytes'], len(b'archive-data'))
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_export_space_failure_starts_no_command(self):
        with tempfile.TemporaryDirectory() as folder, mock.patch.object(prep, 'available', return_value=0), mock.patch.object(prep.subprocess, 'Popen') as command:
            with self.assertRaises(prep.Refuse):
                prep.export_archive(['ctr'], Path(folder) / 'archive.tar')
            command.assert_not_called()

    def test_export_failure_hides_stderr_and_retains_partial_artifact(self):
        with tempfile.TemporaryDirectory() as folder, mock.patch.object(prep, 'available', return_value=10 * prep.GIB):
            path = Path(folder) / 'archive.tar'
            with self.assertRaises(prep.Refuse) as error:
                prep.export_archive([sys.executable, '-c', 'import sys;sys.stdout.write("partial");sys.stderr.write("secret-marker");sys.exit(3)'], path, reserve=0)
            self.assertNotIn('secret-marker', str(error.exception))
            self.assertEqual(path.read_text(), 'partial')

    def test_export_command_only_selects_kubernetes_namespace(self):
        with mock.patch.object(prep, 'export_archive') as export:
            prep.Host().export('/run/old.sock', 'linux/amd64', [{'name': 'registry/app:one'}], Path('/private/archive.tar'))
        command = export.call_args[0][0]
        self.assertEqual(command, ['ctr', '--address', '/run/old.sock', '--namespace', 'k8s.io',
                                  'images', 'export', '--platform', 'linux/amd64', '--skip-manifest-json', '-', 'registry/app:one'])


class PreparationTests(unittest.TestCase):
    def run_preparation(self, changed=False, root_target=True):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / 'prepare'
            mount = {'target': '/', 'uuid': 'root-fs', 'fsroot': '/', 'fstype': 'xfs', 'writable': True}
            data = dict(mount, target='/data', uuid='data-fs')
            runtime = {'executable': '/usr/bin/containerd', 'pid': '12', 'version': '1.6.32', 'address': '/run/old.sock',
                       'config_dump': {'root': '/data/containerd'}}
            facts = {'runtime': {'containerd': runtime}, 'socket': {'device': 1, 'inode': 2, 'is_socket': True},
                     'mounts': [mount, data], 'dump': 'private-config-secret', 'platform': 'linux/amd64'}
            if not root_target:
                facts['mounts'].append(dict(data, target=str(target)))
            host = mock.Mock()
            host.facts.return_value = facts
            seed = Path(folder) / 'seed.tar'
            digest = archive_fixture(seed)
            images = [{'name': 'registry/app:one', 'digest': digest}]
            host.images.side_effect = [images, [] if changed else images]
            def export(address, platform, selected, path):
                path.write_bytes(seed.read_bytes())
                return {'bytes': path.stat().st_size, 'sha256': prep.sha256_file(path)}
            host.export.side_effect = export
            def directory(path, create=False):
                Path(path).mkdir(parents=True, exist_ok=True)
                return Path(path)
            with mock.patch.object(prep, 'secure_directory', side_effect=directory), \
                 mock.patch.object(prep, 'available', return_value=200 * prep.GIB), \
                 mock.patch.object(prep, 'clone_config', return_value={'config_text': 'credential=secret', 'metadata': {'isolated': True}}):
                if changed or not root_target:
                    with self.assertRaises(prep.Refuse):
                        prep.prepare(host, str(target))
                    self.assertFalse(list(target.glob('*/prepared.json')))
                    if not root_target:
                        host.export.assert_not_called()
                    return
                result = prep.prepare(host, str(target))
            staged = Path(result['prepared_directory'])
            receipt = json.loads((staged / 'prepared.json').read_text())
            self.assertEqual(receipt['phase'], 'artifacts-prepared')
            self.assertFalse(receipt['service_changes'])
            self.assertFalse(result['cutover_supported'])
            self.assertFalse(result['docker_data_copied'])
            self.assertNotIn('credential', json.dumps(result))
            self.assertNotIn('private-config-secret', json.dumps(result))
            self.assertFalse((staged / 'data').exists())
            self.assertEqual([call[0] for call in host.method_calls],
                             ['facts', 'validate_config', 'images', 'export', 'images', 'facts'])

    def test_prepare_retains_private_artifacts_without_starting_runtime(self):
        self.run_preparation()

    def test_source_image_change_never_marks_preparation_complete(self):
        self.run_preparation(changed=True)

    def test_target_on_data_filesystem_is_rejected_before_export(self):
        self.run_preparation(root_target=False)


if __name__ == '__main__':
    unittest.main()
