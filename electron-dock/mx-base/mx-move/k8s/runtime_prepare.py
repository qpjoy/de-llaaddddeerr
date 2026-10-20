#!/usr/bin/env python3
"""Prepare private, offline artifacts for a Kubernetes-only runtime move.

This command never installs/starts a daemon, changes kubelet or stops containers.
The old shared containerd is accessed only through read APIs. No Docker namespace,
volumes, metadata tree or writable container layers are copied.
"""
import argparse
from contextlib import contextmanager
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import signal
import socket
import stat
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import uuid

from inventory import GIB, InspectionError, local_path, mount_for, mount_summary, stage
import runtime_check as probe
from runtime_config import clone_config, ConfigError

DEFAULT_TARGET = '/var/lib/mx-move/k8s-runtime-prep'
NEW_STATE = '/run/mx-k8s-containerd'
NEW_ADDRESS = NEW_STATE + '/containerd.sock'
RESERVE = 100 * GIB


class Refuse(RuntimeError):
    pass


def require(ok, message):
    if not ok:
        raise Refuse(message)


def secure_directory(path, create=False):
    """Only root-owned, non-writable-by-others, non-symlink local ancestors."""
    require(local_path(str(path)), '预备目录须为规范绝对路径')
    current = Path('/')
    for part in Path(path).parts[1:]:
        current = current / part
        if create:
            try:
                current.mkdir(mode=0o700)
            except FileExistsError:
                pass
        value = current.lstat()
        require(stat.S_ISDIR(value.st_mode) and value.st_uid == 0 and not value.st_mode & 0o022,
                '预备路径含符号链接、非 root 所有或可被其他用户修改的目录')
    return current


def save_private(path, raw):
    data = raw.encode('utf-8') if isinstance(raw, str) else raw
    fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    sync_directory(path.parent)


def sync_directory(path):
    fd = os.open(str(path), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


@contextmanager
def progress(label):
    stopped = threading.Event()
    started = time.monotonic()
    def heartbeat():
        while not stopped.wait(15):
            stage('{}：仍在执行，已用 {:.0f} 秒'.format(label, time.monotonic() - started))
    thread = threading.Thread(target=heartbeat)
    thread.daemon = True
    thread.start()
    try:
        yield
    finally:
        stopped.set()
        thread.join()


def available(path):
    value = os.statvfs(str(path))
    return value.f_bavail * value.f_frsize


def parse_images(raw):
    """ctr's fixed columns: retain only reference/type/digest/platforms."""
    rows = [line.split() for line in raw.splitlines() if line.strip()]
    require(rows and rows[0] == ['REF', 'TYPE', 'DIGEST', 'SIZE', 'PLATFORMS', 'LABELS'],
            '无法识别 ctr 镜像列表格式')
    images = []
    for row in rows[1:]:
        # Human-readable size has a number and unit, e.g. 25.0 MiB.
        require(len(row) >= 7 and re.fullmatch(r'[A-Za-z0-9._:/@+-]+', row[0]) and
                re.fullmatch(r'sha256:[a-f0-9]{64}', row[2]) and re.fullmatch(r'[0-9]+(?:\.[0-9]+)?', row[3]) and
                row[4] in ('B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB') and
                re.fullmatch(r'(?:-|[A-Za-z0-9_./,-]+)', row[5]), '镜像引用、摘要或列表格式不受支持')
        images.append({'name': row[0], 'media_type': row[1], 'digest': row[2], 'platforms': row[5]})
    require(images and len(set(i['name'] for i in images)) == len(images), 'Kubernetes 镜像列表为空或重复')
    return sorted(images, key=lambda i: i['name'])


def verify_archive(path, expected_digests=None, platform='linux/amd64'):
    """Hash every blob and check the selected platform's graph without extraction."""
    require(platform in ('linux/amd64', 'linux/arm64'), '尚未核验归档目标平台')
    manifest_types = ('application/vnd.oci.image.manifest.v1+json',
                      'application/vnd.docker.distribution.manifest.v2+json')
    index_types = ('application/vnd.oci.image.index.v1+json',
                   'application/vnd.docker.distribution.manifest.list.v2+json')
    config_types = ('application/vnd.oci.image.config.v1+json',
                    'application/vnd.docker.container.image.v1+json')
    blobs, documents, index, layout, json_bytes = {}, {}, None, None, 0
    with tarfile.open(str(path), 'r|') as archive:
        for member in archive:
            name = member.name.rstrip('/')
            if member.isdir():
                require(name in ('blobs', 'blobs/sha256'), '镜像归档含未知目录')
                continue
            require(member.isfile(), '镜像归档含链接或特殊文件')
            if name in ('index.json', 'oci-layout'):
                require(member.size <= 8 * 1024 * 1024, '镜像索引过大')
                data = json.loads(archive.extractfile(member).read().decode('utf-8'))
                if name == 'index.json':
                    require(index is None, '镜像索引重复')
                    index = data
                else:
                    require(layout is None, '镜像布局重复')
                    layout = data
                continue
            require(re.fullmatch(r'blobs/sha256/[a-f0-9]{64}', name), '镜像归档含未知文件')
            key = name.split('/')[-1]
            require(key not in blobs, '镜像归档含重复 blob')
            digest, candidate = hashlib.sha256(), bytearray() if member.size <= 8 * 1024 * 1024 else None
            stream = archive.extractfile(member)
            for block in iter(lambda: stream.read(1024 * 1024), b''):
                digest.update(block)
                if candidate is not None:
                    candidate.extend(block)
            require(digest.hexdigest() == key, '镜像 blob 校验失败')
            blobs[key] = member.size
            if candidate is not None and candidate.lstrip().startswith(b'{'):
                try:
                    document = json.loads(candidate.decode('utf-8'))
                except (ValueError, UnicodeError):
                    document = None
                if isinstance(document, dict):
                    json_bytes += len(candidate)
                    require(json_bytes <= 64 * 1024 * 1024, '镜像 JSON 元数据超过验证上限')
                    documents[key] = document
    require(isinstance(layout, dict) and layout.get('imageLayoutVersion') == '1.0.0' and
            isinstance(index, dict) and index.get('schemaVersion') == 2 and
            isinstance(index.get('manifests'), list) and index['manifests'], 'OCI 布局或索引无效')

    def descriptor(item, present=True):
        require(isinstance(item, dict) and isinstance(item.get('digest'), str) and
                re.fullmatch(r'sha256:[a-f0-9]{64}', item['digest']) and
                type(item.get('size')) is int and item['size'] >= 0 and
                isinstance(item.get('mediaType'), str), 'OCI 描述符无效')
        key = item['digest'][7:]
        if present:
            require(blobs.get(key) == item['size'], 'OCI 描述符指向缺失或不匹配的 blob')
        return key

    def matches(value):
        require(isinstance(value, dict) and isinstance(value.get('os'), str) and
                isinstance(value.get('architecture'), str) and
                isinstance(value.get('variant', ''), str), 'OCI 平台声明无效')
        os_name, architecture = platform.split('/')
        variants = ('', 'v1') if architecture == 'amd64' else ('', 'v8')
        return value['os'] == os_name and value['architecture'] == architecture and value.get('variant', '') in variants

    def document_for(key):
        require(key in documents, '镜像 manifest/config 缺失、过大或不是有效 JSON')
        return documents[key]

    verified, visiting = {}, set()
    def visit(item):
        key = descriptor(item)
        kind = item['mediaType']
        require(kind in manifest_types + index_types, '镜像索引含不支持的 manifest 类型')
        identity = (key, kind)
        if identity in verified:
            return verified[identity]
        require(identity not in visiting and len(visiting) < 32, '镜像索引嵌套异常')
        visiting.add(identity)
        document = document_for(key)
        require(document.get('schemaVersion') == 2 and document.get('mediaType', kind) == kind,
                '镜像 manifest 结构无效')
        count = 0
        if kind in index_types:
            children = document.get('manifests')
            require(isinstance(children, list) and children, '镜像平台索引为空或无效')
            for child in children:
                descriptor(child, present=False)
                # --platform exports retain the original multiarch index but
                # omit other architectures' blobs. Only require our graph.
                if child.get('platform') is None or matches(child['platform']):
                    count += visit(child)
        else:
            config = document.get('config')
            config_key = descriptor(config)
            require(config['mediaType'] in config_types, '镜像配置类型不受支持')
            matching = matches(document_for(config_key))
            if item.get('platform') is not None and matches(item['platform']):
                require(matching, '镜像平台索引与配置的架构不一致')
            if matching:
                layers = document.get('layers')
                require(isinstance(layers, list), '镜像层列表无效')
                for layer in layers:
                    descriptor(layer)
                count = 1
        visiting.remove(identity)
        verified[identity] = count
        return count

    for item in index['manifests']:
        descriptor(item)
    require(not expected_digests or set(expected_digests) <= {i['digest'] for i in index['manifests']},
            'OCI 索引未覆盖全部选定 Kubernetes 镜像摘要')
    for item in index['manifests']:
        require(visit(item) > 0, '选定镜像缺少本机平台的完整 manifest/config/layer')
    return {'blob_count': len(blobs), 'index_descriptors': len(index['manifests']),
            'blob_hashes_verified': True, 'platform_graph_verified': platform,
            'import_verified': False}


def stop_child(child):
    if child.poll() is None:
        try:
            os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError:
            return
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait(timeout=5)


def export_archive(command, path, reserve=RESERVE):
    """Stream old k8s.io read API to a new file, bound space and elapsed time."""
    require(available(path.parent) > reserve, '根卷可用空间不足，须保留至少 100 GiB')
    fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    child, selector = None, selectors.DefaultSelector()
    started, last_progress, count = time.monotonic(), time.monotonic(), 0
    digest = hashlib.sha256()
    try:
        with os.fdopen(fd, 'wb') as output, tempfile.TemporaryFile() as errors:
            child = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=errors, start_new_session=True)
            selector.register(child.stdout, selectors.EVENT_READ)
            while True:
                require(time.monotonic() - started < 6 * 3600, '镜像导出超过 6 小时，保留未完成文件')
                require(available(path.parent) > reserve + 1024 * 1024, '导出达到根卷预留空间边界，保留未完成文件')
                if time.monotonic() - last_progress >= 15:
                    stage('导出 Kubernetes 镜像：已写入 {:.2f} GiB，已用 {:.0f} 秒'.format(count / GIB, time.monotonic() - started))
                    last_progress = time.monotonic()
                if not selector.select(timeout=1):
                    continue
                data = os.read(child.stdout.fileno(), 1024 * 1024)
                if not data:
                    break
                output.write(data)
                digest.update(data)
                count += len(data)
            require(child.wait(timeout=30) == 0 and count > 0, 'Kubernetes 镜像导出失败；原始输出已隐藏，未完成文件保留')
            output.flush()
            os.fsync(output.fileno())
        sync_directory(path.parent)
        return {'sha256': digest.hexdigest(), 'bytes': count}
    finally:
        selector.close()
        if child is not None:
            stop_child(child)
            if child.stdout:
                child.stdout.close()


class Host:
    def run(self, args):
        return probe.run(args)

    def facts(self):
        inspector = probe.RuntimeInspector()
        runtime = {}
        for name in ('containerd', 'kubelet'):
            service = inspector.service(name)
            require(service.get('ActiveState') == 'active', '当前 containerd/kubelet 必须正在运行')
            runtime[name] = inspector.process(name, service)
            runtime[name]['pid'] = service['MainPID']
        require(not inspector.errors, '运行时配置读取不完整；请先运行 runtime-check 查看脱敏错误')
        containerd = runtime['containerd']
        require(containerd['version'] == '1.6.32' and containerd['compatibility']['config_version'] == 2,
                '本次预备工具仅核验了现场 containerd 1.6.32 / 配置 v2')
        old = probe.socket_identity(containerd['address'])
        kubelet = probe.socket_identity(runtime['kubelet']['address'])
        require(probe.same_socket(old, kubelet) is True, '当前 kubelet 与待导出运行时不一致')
        require(not os.path.lexists(NEW_STATE), '新运行时 state 路径已存在，拒绝覆盖')
        args = ['/proc/' + containerd['pid'] + '/exe']
        for key, value in sorted(containerd['flags'].items()):
            args += ['--' + key, value]
        dump = self.run(args + ['config', 'dump'])
        mounts = mount_summary(json.loads(self.run(['findmnt', '--json', '--list', '--output',
                               'TARGET,SOURCE,FSTYPE,FSROOT,UUID,OPTIONS']))['filesystems'])
        machine = os.uname().machine
        require(machine in ('x86_64', 'aarch64'), '尚未核验本机架构的镜像导出')
        return {'runtime': runtime, 'socket': old, 'mounts': mounts, 'dump': dump,
                'platform': 'linux/' + {'x86_64': 'amd64', 'aarch64': 'arm64'}[machine]}

    def images(self, address):
        return parse_images(self.run(['ctr', '--address', address, '--namespace', 'k8s.io', 'images', 'list']))

    def validate_config(self, binary, path, expected):
        dump = self.run([binary, '--config', str(path), 'config', 'dump'])
        summary = probe.config_summary(dump)
        require(all(summary[k] == expected[k] for k in ('root', 'state', 'address')), '预备配置经 containerd 加载后的路径不匹配')
        # dump's imports contains the loaded filename; clone resets it again.
        validated = clone_config(dump, expected['root'], expected['state'], expected['address'])
        require(validated['metadata'] == expected['metadata'], '预备配置再次加载后的隔离摘要不匹配')

    def export(self, address, platform, images, path):
        command = ['ctr', '--address', address, '--namespace', 'k8s.io', 'images', 'export',
                   '--platform', platform, '--skip-manifest-json', '-'] + [i['name'] for i in images]
        return export_archive(command, path)


def prepare(host, target):
    stage('核对当前运行时及根卷；预备过程中不切换服务')
    facts = host.facts()
    runtime = facts['runtime']['containerd']
    root_mount = mount_for('/', facts['mounts']) or {}
    target_mount = mount_for(target, facts['mounts']) or {}
    source_mount = mount_for(runtime['config_dump']['root'], facts['mounts']) or {}
    require(root_mount.get('uuid') and target_mount.get('uuid') == root_mount['uuid'] and
            target_mount.get('fstype') in ('xfs', 'ext4') and target_mount.get('writable'), '预备文件必须位于可写且身份明确的根文件系统')
    require(source_mount.get('uuid') and source_mount['uuid'] != root_mount['uuid'], '原运行时未处于已核验的另一文件系统')
    base = secure_directory(target, create=True)
    require(available(base) > RESERVE, '根卷可用空间不足，须保留至少 100 GiB')
    name = 'mx-k8s-' + datetime.datetime.utcnow().strftime('%Y%m%d-%H%M%S-') + uuid.uuid4().hex[:8]
    directory = base / name
    directory.mkdir(mode=0o700)
    sync_directory(base)
    stage('本次私有预备目录：' + str(directory))
    expected = {'root': str(directory / 'data'), 'state': NEW_STATE, 'address': NEW_ADDRESS}
    cloned = clone_config(facts['dump'], expected['root'], expected['state'], expected['address'])
    expected['metadata'] = cloned['metadata']
    config = directory / 'containerd.toml'
    save_private(config, cloned['config_text'])
    host.validate_config('/proc/' + runtime['pid'] + '/exe', config, expected)
    images = host.images(runtime['address'])
    save_private(directory / 'images.json', json.dumps(images, ensure_ascii=False, indent=2))
    intent = {'schema_version': 1, 'phase': 'preparing', 'cutover_supported': False,
              'host': socket.gethostname(), 'platform': facts['platform'],
              'source_socket': facts['socket'], 'source_config_sha256': hashlib.sha256(facts['dump'].encode()).hexdigest(),
              'source_version': runtime['version'], 'source_root': runtime['config_dump']['root'],
              'target_filesystem_uuid': root_mount['uuid'], 'target': expected,
              'image_count': len(images), 'config_sha256': sha256_file(config)}
    save_private(directory / 'intent.json', json.dumps(intent, ensure_ascii=False, indent=2))
    stage('仅通过 k8s.io 镜像 API 导出；保留旧运行时及 Docker 数据')
    archive = directory / 'k8s-images.tar'
    exported = host.export(runtime['address'], facts['platform'], images, archive)
    stage('校验 OCI 归档与源运行时；不启动新实例')
    with progress('校验镜像归档'):
        verification = verify_archive(archive, [i['digest'] for i in images], facts['platform'])
        require(sha256_file(archive) == exported['sha256'], '镜像归档写入后整体摘要不匹配')
    require(host.images(runtime['address']) == images, '准备期间 Kubernetes 镜像集合改变，请保留本次文件并重新准备')
    after = host.facts()
    require(after['socket'] == facts['socket'] and after['runtime'] == facts['runtime'] and after['dump'] == facts['dump'],
            '准备期间运行时或配置发生变化；本次预备不能用于后续切换')
    require(sha256_file(config) == intent['config_sha256'], '预备配置发生变化')
    receipt = dict(intent, phase='artifacts-prepared', archive=dict(exported, **verification),
                   completed_at_utc=datetime.datetime.utcnow().isoformat() + 'Z',
                   service_changes=False, docker_data_copied=False, writable_layers_copied=False)
    save_private(directory / 'prepared.json', json.dumps(receipt, ensure_ascii=False, indent=2))
    return {'phase': receipt['phase'], 'prepared_directory': str(directory),
            'image_count': len(images), 'archive_bytes': exported['bytes'],
            'archive_sha256': exported['sha256'], 'config_isolation': cloned['metadata'],
            'service_changes': False, 'docker_data_copied': False, 'cutover_supported': False,
            'next': 'Keep private artifacts on this host. Cutover still requires workload/storage guards, endpoint consumers and image import verification.'}


def main(argv=None):
    parser = argparse.ArgumentParser(description='只预备 Kubernetes 隔离配置与镜像归档；不安装/启动服务、不迁移数据库')
    parser.add_argument('--target-root', default=DEFAULT_TARGET, help='预备目录，必须位于本机根卷')
    args = parser.parse_args(argv)
    require(sys.platform.startswith('linux') and os.geteuid() == 0, '请在 Internal Linux 主机以 root 执行')
    require(local_path(args.target_root) and args.target_root.startswith('/var/lib/mx-move/'), '预备目录须位于 /var/lib/mx-move/ 下')
    os.umask(0o077)
    base = secure_directory('/var/lib/mx-move', create=True)
    lock_path = base / 'k8s-runtime-prepare.lock'
    fd = os.open(str(lock_path), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'a') as lock:
        value = os.fstat(lock.fileno())
        require(stat.S_ISREG(value.st_mode) and value.st_uid == 0 and not value.st_mode & 0o077, '预备锁文件身份无效')
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Refuse('另一个 Kubernetes 运行时预备正在执行') from None
        report = prepare(Host(), args.target_root)
        print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print('[mx-move k8s] 预备已中断；私有文件保留，服务和原数据未切换。', file=sys.stderr)
        sys.exit(130)
    except Refuse as error:
        print('[mx-move k8s] ' + str(error), file=sys.stderr)
        sys.exit(1)
    except ConfigError as error:
        print('[mx-move k8s] 配置隔离停止：' + error.reason + '（配置值已隐藏）；未切换服务。', file=sys.stderr)
        sys.exit(1)
    except (InspectionError, OSError, ValueError, KeyError, TypeError, tarfile.TarError,
            subprocess.TimeoutExpired, RecursionError):
        print('[mx-move k8s] 运行时预备失败；原始配置/命令输出已隐藏，私有预备文件保留。', file=sys.stderr)
        sys.exit(1)
