#!/usr/bin/env python3
"""Single Internal node cutover, preserving original data and Docker runtime.

Before may_write: resume restores the original mounts and desired replicas.
After may_write: resume only completes the new side. Never mount stale data as
an automatic rollback after new PostgreSQL/Elasticsearch may have written.
"""
import argparse
import base64
import contextlib
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import uuid

import candidate_guard
import cluster_ops
import cutover_runtime
import endpoint_config
import rig_init_repair
import runtime_install
import runtime_prepare as prep
import runtime_resolver
import storage_guard
import storage_ops

require = prep.require
BASE = Path('/var/lib/mx-move/k8s-transactions')
CURRENT = BASE / 'current.json'
DESCRIPTOR = Path('/etc/mx-k8s-runtime/active.json')
STORAGE_RECORD = Path('/etc/mx-k8s-runtime/storage.json')
STORAGE_HELPER = Path('/usr/local/lib/mx-k8s-runtime/storage_guard.py')
DROPIN = Path('/etc/systemd/system/kubelet.service.d/95-mx-move-k8s.conf')
CRICTL = Path('/etc/crictl.yaml')
NODE_ENDPOINT = 'kubeadm.alpha.kubernetes.io/cri-socket'
NODE = 'mx-internal-server'
CLUSTER_UID = '399f2349-3a34-48f4-8105-d7bae56ca136'
ROOT_UUID = 'ea7e456d-19db-4f6e-b8b0-02c00f59d066'
SOURCE_UUID = '45fa3b72-5a59-4d3c-9a57-4f61aee13e5e'
KUBERNETES_CONFIG = Path('/etc/kubernetes')
# Confirmed historical repair artifacts, not the active kubelet credentials.
KUBERNETES_BACKUP_LINKS = frozenset((
    'mx-kubelet-auth-repair.CeHaeh/pki.before/kubelet-client-current.pem',
    'mx-kubelet-auth-repair.CeHaeh/old-clients/kubelet-client-current.pem',
))
REPO = Path(__file__).resolve().parents[3]
IDENTITY_HELPER = Path(__file__).with_name('storage-identities.mjs')
IDENTITY_ACTIONS = ('check', 'prepare', 'update', 'restore', 'patches', 'restore-patches',
                    'verify', 'verify-restored', 'verify-local', 'verify-local-restored')
PREPARATION_STEPS = ('endpoint-check', 'identity-backup', 'config-backup', 'endpoint-plan',
                     'etcd-tool-backup', 'kubernetes-backup', 'etcd-snapshot-save',
                     'etcd-snapshot-verify', 'launcher-baseline', 'startup-plan', 'flush')
FAILURE_PHASES = ('preparing', 'quiescing', 'blocking', 'stopping', 'copying',
                  'switching', 'committed', 'services-restored', 'aborted', 'unknown')
FAILURE_REASONS = ('interrupted', 'cluster_guard_rejected', 'guard_rejected',
                   'command_timeout', 'command_exit', 'filesystem_error',
                   'invalid_data_or_api', 'unexpected_error')
FAILURE_MODULES = ('k8s/cutover.py', 'k8s/cluster_ops.py', 'k8s/cutover_runtime.py',
                   'k8s/storage_ops.py', 'k8s/storage_guard.py', 'k8s/candidate_guard.py',
                   'k8s/endpoint_config.py', 'k8s/runtime_prepare.py', 'k8s/runtime_install.py',
                   'k8s/runtime_resolver.py', 'k8s/rig_init_repair.py', 'etcd/move.py')
RECOVERY_STATUSES = ('restoring-original', 'restored', 'incomplete')


def failure_diagnostic(error, phase):
    """Describe a failure without exception messages, arguments or frame locals."""
    reason, exit_code, number = 'unexpected_error', None, None
    if isinstance(error, (KeyboardInterrupt, SystemExit)):
        reason = 'interrupted'
    elif isinstance(error, (cluster_ops.ClusterError, rig_init_repair.Error)):
        reason = 'cluster_guard_rejected'
    elif isinstance(error, (prep.Refuse, candidate_guard.GuardError, storage_guard.StorageError,
                            endpoint_config.EndpointError, runtime_resolver.Refuse)):
        reason = 'guard_rejected'
    elif isinstance(error, subprocess.TimeoutExpired):
        reason = 'command_timeout'
    elif isinstance(error, subprocess.CalledProcessError):
        reason = 'command_exit'
        exit_code = error.returncode if type(error.returncode) is int else None
    elif isinstance(error, OSError):
        reason = 'filesystem_error'
        number = error.errno if type(error.errno) is int else None
    elif isinstance(error, (ValueError, TypeError, KeyError, AttributeError)):
        reason = 'invalid_data_or_api'
    base = Path(__file__).resolve().parents[1]
    sources = {str(base / module): module for module in FAILURE_MODULES}
    locations, frame = [], error.__traceback__
    while frame is not None:
        module = sources.get(os.path.abspath(frame.tb_frame.f_code.co_filename))
        if module:
            locations.append({'module': module, 'line': frame.tb_lineno})
        frame = frame.tb_next
    return {'schema_version': 1, 'phase': phase if phase in FAILURE_PHASES else 'unknown',
            'reason': reason, 'exit_code': exit_code, 'errno': number, 'locations': locations[-3:]}


def public_failure_diagnostic(value):
    """Validate the persisted diagnostic before exposing it through status."""
    if (type(value) is not dict or set(value) !=
            {'schema_version', 'phase', 'reason', 'exit_code', 'errno', 'locations'} or
            type(value['schema_version']) is not int or value['schema_version'] != 1 or
            value['phase'] not in FAILURE_PHASES or value['reason'] not in FAILURE_REASONS or
            any(value[key] is not None and type(value[key]) is not int for key in ('exit_code', 'errno')) or
            type(value['locations']) is not list or len(value['locations']) > 3):
        return None
    for location in value['locations']:
        if (type(location) is not dict or set(location) != {'module', 'line'} or
                location['module'] not in FAILURE_MODULES or
                type(location['line']) is not int or not 1 <= location['line'] <= 100000):
            return None
    return {key: ([dict(item) for item in value[key]] if key == 'locations' else value[key])
            for key in ('schema_version', 'phase', 'reason', 'exit_code', 'errno', 'locations')}


def kubernetes_backup_links(root):
    """Inspect the local tree without resolving historical certificate links."""
    root = Path(root)
    device = root.lstat().st_dev
    links, pending = {}, [root]
    while pending:
        directory = pending.pop()
        info = directory.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_dev == device,
                'Kubernetes 配置备份目录类型或设备变化，拒绝复制')
        for child in directory.iterdir():
            info = child.lstat()
            require(info.st_dev == device, 'Kubernetes 配置备份禁止跨文件系统')
            if stat.S_ISLNK(info.st_mode):
                relative = child.relative_to(root).as_posix()
                require(relative in KUBERNETES_BACKUP_LINKS,
                        'Kubernetes 配置含未核验的符号链接，拒绝复制（目标已隐藏）')
                links[relative] = os.readlink(str(child))
            elif stat.S_ISDIR(info.st_mode):
                pending.append(child)
            else:
                require(stat.S_ISREG(info.st_mode), 'Kubernetes 配置含特殊文件，拒绝复制')
    return links


def kubernetes_copy_diagnostics(error):
    """Project copytree's aggregate without reading paths or exposing raw errors."""
    entries = error.args[0] if error.args and isinstance(error.args[0], (list, tuple)) else [None]
    failures = []
    for entry in entries[:20]:
        path, number = 'unknown', None
        if isinstance(entry, (list, tuple)) and len(entry) == 3:
            source, _, message = entry
            # Never normalize traversal into an allowed path. This is lexical
            # validation only: realpath/stat could follow a source link to NAS.
            if type(source) is str and source == '/etc/kubernetes':
                path = '.'
            elif type(source) is str and source.startswith('/etc/kubernetes/'):
                relative = source[len('/etc/kubernetes/'):]
                if (len(relative) <= 512 and all(part not in ('.', '..') and
                        re.fullmatch(r'[A-Za-z0-9_.-]{1,128}', part)
                        for part in relative.split('/'))):
                    path = relative
            if type(message) is str:
                match = re.match(r'^\[Errno ([1-9][0-9]{0,3})\](?: |$)', message)
                if match:
                    number = int(match.group(1))
        reason = {1: 'permission_denied', 2: 'missing_path', 5: 'io_error',
                  13: 'permission_denied', 20: 'not_directory', 21: 'is_directory',
                  28: 'no_space', 30: 'read_only_filesystem', 36: 'name_too_long',
                  40: 'symlink_loop', 95: 'unsupported_operation'}.get(
                      number, 'filesystem_error' if number is not None else 'unclassified_copy_error')
        failures.append({'path': path, 'errno': number, 'reason': reason})
    return {'copy_errors': failures, 'copy_error_count': len(entries),
            'copy_errors_truncated': len(entries) > 20}


def preparation_diagnostic(error, step, backend):
    """Keep only fixed categories and tool source locations, never exception text."""
    reason, exit_code, error_number = 'unexpected_error', None, None
    if isinstance(error, backend.CommandFailed):
        reason = {'exit': 'command_exit', 'exec': 'command_unavailable', 'timeout': 'command_timeout'}.get(error.kind, 'command_failed')
        exit_code = error.returncode if type(error.returncode) is int else None
    elif isinstance(error, backend.Refuse):
        reason = 'etcd_guard_rejected'
    elif isinstance(error, shutil.Error):
        reason = 'copy_failed'
    elif isinstance(error, OSError):
        reason = 'filesystem_error'
        error_number = error.errno if type(error.errno) is int else None
    elif isinstance(error, (prep.Refuse, candidate_guard.GuardError, storage_guard.StorageError, endpoint_config.EndpointError)):
        reason = 'guard_rejected'
    elif isinstance(error, (ValueError, TypeError, KeyError, AttributeError)):
        reason = 'invalid_data_or_api'
    sources = {str(Path(__file__).resolve()): 'k8s/cutover.py',
               str(Path(__file__).resolve().parents[1] / 'etcd/move.py'): 'etcd/move.py'}
    locations, frame = [], error.__traceback__
    while frame is not None:
        module = sources.get(os.path.abspath(frame.tb_frame.f_code.co_filename))
        if module:
            locations.append({'module': module, 'line': frame.tb_lineno})
        frame = frame.tb_next
    result = {'schema_version': 1, 'step': step if step in PREPARATION_STEPS else 'unknown',
              'reason': reason, 'exit_code': exit_code, 'errno': error_number, 'locations': locations[-3:]}
    if isinstance(error, shutil.Error) and step == 'kubernetes-backup':
        result.update(kubernetes_copy_diagnostics(error))
    return result


def identity_diagnostic(stderr):
    """Project only the helper's bounded diagnostic protocol, never raw errors."""
    prefix = b'MX_MOVE_IDENTITY_DIAGNOSTIC='
    if isinstance(stderr, bytes) and len(stderr) <= 2048 and stderr.startswith(prefix):
        try:
            value = json.loads(stderr[len(prefix):], object_pairs_hook=candidate_guard.unique_object)
            if (isinstance(value, dict) and set(value) == {'schema_version', 'stage', 'subject', 'reason', 'rule'} and
                    type(value['schema_version']) is int and value['schema_version'] == 1 and
                    value['stage'] in ('request', 'protected-path', 'source-file', 'local-observation', 'validation', 'operation') and
                    value['subject'] in ('none', 'request', 'transaction', 'launcherHost', 'launcherLatest',
                                         'common', 'payHost', 'payCheckpoint', 'launcher', 'pay') and
                    value['reason'] in ('guard_rejected', 'invalid_json', 'missing_path', 'permission_denied',
                                        'symlink_or_not_directory', 'io_error', 'command_failed', 'unexpected_error') and
                    isinstance(value['rule'], str) and re.fullmatch(r'(?:[a-f0-9]{12})?', value['rule'])):
                return value
        except (ValueError, TypeError, RecursionError, candidate_guard.GuardError):
            pass
    # Node may fail while parsing/importing, before the helper's catch can run.
    # Match fixed signatures only; filenames, source lines and stacks stay hidden.
    raw = stderr if isinstance(stderr, bytes) else b''
    reason = 'unclassified_failure'
    if b'ERR_MODULE_NOT_FOUND' in raw or b"code: 'MODULE_NOT_FOUND'" in raw:
        reason = 'dependency_missing'
    elif b'does not provide an export named' in raw:
        reason = 'dependency_export_mismatch'
    elif b'SyntaxError:' in raw:
        reason = 'javascript_syntax_error'
    elif b'structuredClone is not defined' in raw or b'Object.hasOwn is not a function' in raw:
        reason = 'node_api_unavailable'
    return {'schema_version': 1, 'stage': 'node-bootstrap-or-legacy-helper', 'subject': 'none',
            'reason': reason, 'rule': ''}


def identity_node_version():
    """A failed diagnostic probe must not replace the original helper failure."""
    try:
        result = subprocess.run(['node', '--version'], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                timeout=5, env=dict(os.environ, LC_ALL='C'))
        match = re.fullmatch(rb'v([0-9]+)\.([0-9]+)\.([0-9]+)(?:-[A-Za-z0-9.-]+)?\s*', result.stdout)
        if result.returncode == 0 and match:
            return 'v' + '.'.join(part.decode('ascii') for part in match.groups())
    except (OSError, subprocess.TimeoutExpired):
        pass
    return 'unknown'


def raw_json(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode()


def digest(value):
    return hashlib.sha256(value).hexdigest()


def private_json(path):
    candidate_guard.safe(str(path), private=True)
    return json.loads(path.read_bytes(), object_pairs_hook=candidate_guard.unique_object)


def replace_file(path, desired, before, mode=0o600):
    """CAS a recorded file; preserve original attributes for existing files."""
    path = Path(path)
    if os.path.lexists(str(path)):
        candidate_guard.safe(str(path), private=mode == 0o600)
        current = path.read_bytes()
        require(current in (before, desired), '受管配置被其他操作修改，拒绝覆盖')
        if current != desired:
            storage_ops.atomic(path, desired, current)
    else:
        require(before is None, '原受管配置缺失，拒绝创建替代文件')
        runtime_install.install_file(path, desired, mode)


def remove_created(path, expected):
    if os.path.lexists(str(path)):
        candidate_guard.safe(str(path))
        require(Path(path).read_bytes() == expected, '待恢复配置已改变，拒绝移除')
        Path(path).unlink()
        prep.sync_directory(Path(path).parent)


def etcd_driver():
    directory = Path(__file__).parents[1] / 'etcd'
    sys.path.insert(0, str(directory))
    try:
        spec = importlib.util.spec_from_file_location('mx_move_etcd_backend', str(directory / 'move.py'))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        sys.path.pop(0)


def verify_product_runtime_entries(repo):
    """Read product entry points without executing deployment scripts."""
    for relative in ('mx-launcher/scripts/k8s-production-recovery.sh', 'mx-insight-hub/scripts/manage.sh',
                     'mx-common/scripts/manage.sh', 'mx-rig/scripts/manage.sh',
                     'mx-rig/scripts/build-proxy.sh', 'mx-base/mx-pay/scripts/runtime.mjs',
                     'mx-base/mx-pay/scripts/build-proxy.sh'):
        try:
            body = (repo / relative).read_bytes()
        except OSError:
            raise prep.Refuse('无法读取产品运行时入口：' + relative) from None
        supported = b'/etc/mx-k8s-runtime/active.json' in body
        if relative == 'mx-rig/scripts/manage.sh':
            # Rig shares the resolver with its sourced build-proxy module.
            # Check the caller/provider pair instead of requiring a duplicate
            # resolver path in manage.sh; the provider is checked below.
            supported = supported and all(re.search(pattern, body, re.M) for pattern in (
                rb'^[ \t]*source[ \t]+"\$\{ROOT_DIR\}/scripts/build-proxy\.sh"[ \t]*$',
                rb'^[ \t]*address="\$\(rig_managed_runtime_value[ \t]+address\)"[ \t]+\|\|[ \t]+return[ \t]+1[ \t]*$'))
            supported = supported and b'ctr --address "$address" -n k8s.io' in body
        else:
            supported = supported and b'/usr/local/lib/mx-k8s-runtime/resolve.py' in body
        if relative == 'mx-rig/scripts/build-proxy.sh':
            supported = supported and re.search(rb'^rig_managed_runtime_value\(\)[ \t]*\{', body, re.M)
        require(supported, '产品运行时入口未同步完整适配：' + relative)


class Host:
    def __init__(self):
        self.runtime = cutover_runtime.Runtime(self)
        self.storage = storage_ops.Storage()
        self.cluster = cluster_ops.Cluster(self)
        self.etcd_module = etcd_driver()
        self.etcd = self.etcd_module.Host()

    def run(self, args, timeout=60, input_data=None):
        try:
            result = subprocess.run([str(v) for v in args], input=input_data, stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE, timeout=timeout, env=dict(os.environ, LC_ALL='C'))
            if (result.returncode != 0 and len(args) == 4 and str(args[0]) == 'node' and
                    str(args[1]) == str(IDENTITY_HELPER) and args[2] in IDENTITY_ACTIONS):
                detail = identity_diagnostic(result.stderr)
                detail.update(action=args[2], exit_code=result.returncode, node_version=identity_node_version())
                raise prep.Refuse('存储身份子命令失败；identity_diagnostics=' +
                                  json.dumps(detail, ensure_ascii=True, separators=(',', ':')))
            require(result.returncode == 0, '迁移子命令失败：{}，退出码 {}（原始输出已隐藏）'.format(Path(str(args[0])).name, result.returncode))
            return result.stdout
        except (OSError, subprocess.TimeoutExpired):
            raise prep.Refuse('迁移子命令不可用或超时（原始输出已隐藏）') from None

    def wait(self, predicate, seconds, label):
        with prep.progress(label):
            end = time.monotonic() + seconds
            while True:
                try:
                    result = predicate()
                    if result is not False:
                        return result
                except Exception:
                    pass
                require(time.monotonic() < end, label + '超时；保留事务以便恢复')
                time.sleep(3)

    def kubectl(self, *args):
        return self.run(['kubectl', '--kubeconfig=/etc/kubernetes/admin.conf', '--request-timeout=30s'] + list(args), 60)

    def pay_resources(self):
        resources = {}
        for key, kind, name in (('configMap', 'configmap', 'mx-pay-database'),
                                ('statefulSet', 'statefulset', 'mx-pay-postgres'),
                                ('pv', 'pv', 'mx-pay-postgres-data'), ('pvc', 'pvc', 'mx-pay-postgres-data')):
            resources[key] = json.loads(self.kubectl('-n', 'mx-pay', 'get', kind, name, '-o', 'json'))
        return resources

    def identity_request(self, journal, resources=None):
        return {'runDirectory': journal['run'], 'node': NODE, 'clusterUid': CLUSTER_UID, 'targetUUID': ROOT_UUID,
                'targets': {entry['logical']: entry['target'] for entry in journal['storage']['entries']},
                'payCheckpointPath': str(REPO / 'mx-base/mx-pay/.deploy/database.json'),
                'resources': resources or journal['pay_resources']}

    def identities(self, action, journal, resources=None):
        if action.startswith('verify'):
            with tempfile.TemporaryDirectory(prefix='mx-k8s-verify-', dir='/var/tmp') as directory:
                path = Path(directory) / 'request.json'
                prep.save_private(path, raw_json(self.identity_request(journal, resources)))
                self.run(['node', Path(__file__).with_name('storage-identities.mjs'), action, path], 120)
            return
        path = Path(journal['run']) / ('identity-request-' + uuid.uuid4().hex + '.json')
        prep.save_private(path, raw_json(self.identity_request(journal, resources)))
        self.run(['node', Path(__file__).with_name('storage-identities.mjs'), action, path], 120)

    def check_identities(self, journal):
        with tempfile.TemporaryDirectory(prefix='mx-k8s-check-', dir='/var/tmp') as directory:
            path = Path(directory) / 'request.json'
            prep.save_private(path, raw_json(self.identity_request(journal)))
            self.run(['node', Path(__file__).with_name('storage-identities.mjs'), 'check', path], 120)

    def docker_snapshot(self):
        docker = prep.probe.RuntimeInspector().docker_local()
        if docker.get('complete') is not True:
            # docker_local already classifies failures without command output.
            # Project only its diagnostic fields, never info/container payloads.
            diagnostics = [{key: item[key] for key in ('stage', 'reason', 'exit_code', 'container_id', 'retry')
                            if key in item} for item in docker.get('diagnostics', [])]
            summary = {'info_available': docker.get('info') is not None,
                       'total': docker.get('total'), 'inspected_total': docker.get('inspected_total'),
                       'containers_complete': docker.get('containers_complete'), 'diagnostics': diagnostics}
            raise prep.Refuse('Docker 本机消费者盘点不完整；docker_diagnostics=' +
                              json.dumps(summary, ensure_ascii=True, separators=(',', ':')))
        command = ['docker', '--host=unix:///var/run/docker.sock']
        ids = sorted(self.run(command + ['ps', '-aq', '--no-trunc']).decode().split())
        require(ids == sorted(v['id'] for v in docker['containers']), 'Docker 容器集合在盘点期间变化')
        mounts = {}
        for identifier in ids:
            require(re.fullmatch('[a-f0-9]{64}', identifier), 'Docker 容器标识异常')
            value = json.loads(self.run(command + ['inspect', '--format', '{{json .Mounts}}', identifier]))
            require(isinstance(value, list) and all(isinstance(m, dict) and isinstance(m.get('Source'), str) for m in value),
                    'Docker 挂载盘点格式异常')
            mounts[identifier] = value
        require(ids == sorted(self.run(command + ['ps', '-aq', '--no-trunc']).decode().split()), 'Docker 容器集合在盘点期间变化')
        docker['mounts'] = mounts
        docker['containers'] = sorted(docker['containers'], key=lambda v: v['id'])
        return docker

    def preflight(self, transaction):
        require(os.uname().nodename == NODE, '本执行器仅支持已盘点的 Internal 节点')
        require(not os.path.lexists(str(DESCRIPTOR)), '已有正式运行时描述，使用 status / resume / verify')
        for name in ('kubectl', 'crictl', 'ctr', 'node', 'rsync', 'du', 'docker', 'findmnt', 'mount', 'umount', 'sync', 'systemctl'):
            require(shutil.which(name), '缺少迁移必需工具：' + name)
        candidate = candidate_guard.verify()
        require(candidate['phase'] == 'ready' and candidate['filesystem_uuid'] == ROOT_UUID, '候选实例尚未验证 ready')
        inspector = runtime_install.Host()
        inspector.ready(candidate)
        facts = inspector.facts()
        require(facts['runtime']['kubelet']['flags'].get('config') == '/var/lib/kubelet/config.yaml' and
                not any(k in facts['runtime']['kubelet']['flags'] for k in ('address', 'root')) and
                facts['runtime']['containerd']['address'] == cutover_runtime.OLD,
                '当前 kubelet 启动参数或原运行时偏离已核验布局')
        prepared = private_json(Path(candidate['prepared_directory']) / 'prepared.json')
        images = private_json(Path(candidate['prepared_directory']) / 'images.json')
        imported = {v['name']: v['digest'] for v in inspector.images(cutover_runtime.NEW)}
        require(inspector.images(cutover_runtime.OLD) == images and
                all(imported.get(v['name']) == v['digest'] for v in images) and
                runtime_install.images_cover(inspector.image_state(cutover_runtime.NEW), inspector.image_state(cutover_runtime.OLD)),
                '候选镜像与当前 Kubernetes 镜像不一致，先复核运行时')
        require(digest(facts['dump'].encode()) == prepared['source_config_sha256'], '原运行时配置已改变')
        for file in (STORAGE_RECORD, DROPIN):
            require(not os.path.lexists(str(file)), '已存在其他存储迁移保护，使用 status / resume')
        if os.path.lexists(str(STORAGE_HELPER)):
            candidate_guard.safe(str(STORAGE_HELPER))
            require(STORAGE_HELPER.read_bytes() == Path(__file__).with_name('storage_guard.py').read_bytes(),
                    '原存储保护程序与本次版本不匹配，请先复核已有事务')
        launch = endpoint_config.snapshot(self.run)
        crictl_before = None
        if os.path.lexists(str(CRICTL)):
            candidate_guard.safe(str(CRICTL))
            crictl_before = CRICTL.read_bytes()
        crictl_after = endpoint_config.rewrite_crictl(crictl_before)
        # Require all affected products' normal entry points before publishing
        # active.json. They remain inert while only candidate.json exists.
        verify_product_runtime_entries(REPO)
        require(Path('/usr/local/lib/mx-k8s-runtime/resolve.py').read_bytes() ==
                Path(__file__).with_name('runtime_resolver.py').read_bytes(), '服务器解析器与本次工具版本不匹配')
        cluster = self.cluster.snapshot()
        node_endpoint = cluster['objects']['nodes'][0]['metadata'].get('annotations', {}).get(NODE_ENDPOINT)
        require(node_endpoint in (None, 'unix://' + cutover_runtime.OLD, 'unix:///var/run/containerd/containerd.sock'),
                'Node 的 kubeadm CRI 标注与原实例不匹配')
        require(not any(v['metadata'].get('namespace') == 'mx-pay' and v['metadata']['name'] == 'mx-pay-deploy-lock'
                        for v in cluster['objects']['configmaps']), 'Pay 有操作持锁，请等待现有操作完成')
        etcd = self.etcd.discover()
        require(etcd['node'] == NODE and etcd['cluster_uid'] == CLUSTER_UID, '集群/节点身份变化')
        docker = self.docker_snapshot()
        protected = [docker['info']['root']]
        for mounts in docker['mounts'].values():
            for mount in mounts:
                if mount['Source'].startswith('/'):
                    protected += [mount['Source'], os.path.realpath(mount['Source'])]
        storage = self.storage.snapshot(transaction, ROOT_UUID, SOURCE_UUID, protected_paths=protected,
                                        objects=cluster['objects'])
        sizes = {}
        for entry in storage['entries']:
            raw = self.run(['du', '-sHx', '--apparent-size', '--block-size=1', '--', entry['source']], 1800)
            require(re.match(rb'^[0-9]+\s', raw), '无法估算原 Kubernetes 数据量')
            sizes[entry['key']] = int(raw.split()[0])
        free = prep.available(Path('/var/lib/mx-move'))
        require(free > sum(sizes.values()) + prep.RESERVE, '根卷不足以复制业务数据并保留 100 GiB 安全余量')
        # The exact byte total is rechecked cold by storage_ops before copying.
        journal = {'schema_version': 1, 'transaction': transaction, 'run': str(BASE / transaction), 'phase': 'preparing',
                'may_write': False, 'storage': storage, 'candidate': candidate, 'runtime_before': facts,
                'cluster': cluster, 'etcd': etcd, 'pay_resources': self.pay_resources(),
                'docker_before': docker, 'moby_before': self.runtime.tasks(cutover_runtime.OLD, 'moby'),
                'kubelet_launch': launch,
                'crictl_before': base64.b64encode(crictl_before).decode() if crictl_before is not None else None,
                'crictl_after': base64.b64encode(crictl_after).decode(),
                'capacity': {'estimated_copy_bytes': sum(sizes.values()), 'root_free_bytes': free, 'reserve_bytes': prep.RESERVE}}
        self.check_identities(journal)
        return journal

    def release_kubelet_bindings(self, journal):
        label = '等待 kubelet 正常释放 Pay/ES 本地绑定（不执行手工卸载）'
        with prep.progress(label):
            end = time.monotonic() + 120
            while not self.storage.kubelet_bindings_released(journal['storage']):
                # Only unchanged, reviewed binds are pending. Inspection errors
                # and new/unexpected mounts abort immediately with their cause.
                require(time.monotonic() < end, label + '超时；拒绝停止 kubelet 或复制数据')
                time.sleep(3)

    def prepare(self, journal):
        try:
            self._prepare(journal)
        except Exception as error:
            detail = preparation_diagnostic(error, journal.get('preparation_step'), self.etcd_module)
            # execute() persists this safe projection when marking the attempt
            # aborted. No raw error or command output enters the journal here.
            journal['preparation_failure'] = detail
            known = (prep.Refuse, candidate_guard.GuardError, storage_guard.StorageError, endpoint_config.EndpointError)
            if isinstance(error, known):
                raise
            raise prep.Refuse('迁移准备失败；preparation_diagnostics=' +
                              json.dumps(detail, ensure_ascii=True, separators=(',', ':'))) from None

    def backup_kubernetes(self, destination):
        def source_identity():
            # Check mounts before walking: even a same-device bind could expose
            # unrelated data. Never enter nested mounts or resolve link targets.
            self.storage.no_children(KUBERNETES_CONFIG)
            mount = self.storage.host.mount(KUBERNETES_CONFIG)
            require(mount['target'] == '/' and mount['fsroot'] == '/' and mount['uuid'] == ROOT_UUID,
                    'Kubernetes 配置备份源必须位于已核验的本机根卷')
            return storage_guard.identity(storage_guard.path_info(KUBERNETES_CONFIG))

        before = source_identity()
        links = kubernetes_backup_links(KUBERNETES_CONFIG)
        # Default copytree dereferences links, breaking historical repair copies
        # and potentially reading external storage. Preserve only reviewed links.
        shutil.copytree(str(KUBERNETES_CONFIG), str(destination), symlinks=True)
        require(source_identity() == before, 'Kubernetes 配置备份源在复制期间改变')
        require(kubernetes_backup_links(KUBERNETES_CONFIG) == links and
                kubernetes_backup_links(destination) == links,
                'Kubernetes 配置备份链接在复制期间改变；拒绝进入停写阶段')

    def _prepare(self, journal):
        run = Path(journal['run'])
        journal['preparation_step'] = 'endpoint-check'
        endpoint_config.verify(self.run, journal['kubelet_launch'])
        journal['preparation_step'] = 'identity-backup'
        self.identities('prepare', journal)
        journal['preparation_step'] = 'config-backup'
        files = [Path('/etc/fstab'), runtime_install.RECORD, runtime_install.UNIT,
                 Path('/var/lib/kubelet/config.yaml')]
        for optional in ('/var/lib/kubelet/instance-config.yaml', '/var/lib/kubelet/kubeadm-flags.env'):
            if Path(optional).exists():
                files.append(Path(optional))
        journal['files'] = {}
        for path in files:
            candidate_guard.safe(str(path))
            raw = path.read_bytes()
            journal['files'][str(path)] = base64.b64encode(raw).decode()
        journal['preparation_step'] = 'endpoint-plan'
        replace_endpoint = cutover_runtime.replace_endpoint
        replace_endpoint(Path('/var/lib/kubelet/config.yaml').read_bytes())
        flags = Path('/var/lib/kubelet/kubeadm-flags.env')
        if flags.exists():
            require(b'--container-runtime-endpoint' not in flags.read_bytes(), 'kubeadm flags 有独立 endpoint 覆盖，需先审查')
        for file in ('/var/lib/kubelet/config.yaml', '/var/lib/kubelet/instance-config.yaml'):
            if file in journal['files']:
                replace_endpoint(base64.b64decode(journal['files'][file]))
        # Match the already running etcd binary and retain keys privately.
        journal['preparation_step'] = 'etcd-tool-backup'
        shutil.copyfile(self.etcd.etcdctl, str(run / 'etcdctl'))
        (run / 'etcdctl').chmod(0o700)
        self.etcd.etcdctl = str(run / 'etcdctl')
        journal['preparation_step'] = 'kubernetes-backup'
        self.backup_kubernetes(run / 'kubernetes.before')
        with prep.progress('保存并校验在线 etcd 快照和原用户配置基线'):
            journal['preparation_step'] = 'etcd-snapshot-save'
            self.etcd.ctl('snapshot', 'save', str(run / 'snapshot.db'))
            (run / 'snapshot.db').chmod(0o600)
            journal['preparation_step'] = 'etcd-snapshot-verify'
            journal['snapshot_sha256'] = self.etcd_module.verify_snapshot(run / 'snapshot.db')
            journal['preparation_step'] = 'launcher-baseline'
            journal['launcher_before'] = self.etcd.launcher_check()
            require(journal['launcher_before'] and journal['launcher_before']['namespace'] == 'mx-internal-shadow',
                    'Launcher 登录基线不属于已盘点的 Internal 实例')
        # Compute every file mutation intent now. execute persists these bytes
        # before installing a guard, changing a unit or changing a mount.
        journal['preparation_step'] = 'startup-plan'
        python = os.path.realpath(sys.executable)
        candidate_guard.safe(python)
        require(re.fullmatch(r'/[A-Za-z0-9_./-]+', python), 'Python 路径不适于 systemd')
        journal['python'] = python
        journal['dropin'] = base64.b64encode(storage_ops.guard_dropin(python) +
            b'\n[Unit]\nRequires=mx-k8s-containerd.service\nAfter=mx-k8s-containerd.service\n').decode()
        before = base64.b64decode(journal['files'][str(runtime_install.UNIT)])
        paths = ' '.join(v['logical'] for v in journal['storage']['entries'])
        after, count = re.subn(rb'(?m)^RequiresMountsFor=([^\n]+)$',
                              lambda m: m.group(0) + b' ' + paths.encode(), before)
        extra = ('\nExecStartPre={} {}\n'.format(python, STORAGE_HELPER)).encode()
        after = after.replace(b'\n[Install]\n', extra + b'\n[Install]\n')
        require(count == 1 and after != before and after.count(extra) == 1, '候选服务 unit 格式异常')
        journal['unit_after'] = base64.b64encode(after).decode()
        candidate_before = base64.b64decode(journal['files'][str(runtime_install.RECORD)])
        journal['candidate_after'] = base64.b64encode(raw_json(dict(json.loads(candidate_before), unit_sha256=digest(after)))).decode()
        journal['preparation_step'] = 'flush'
        self.run(['sync', '-f', run], 180)

    def block_startup(self, journal):
        endpoint_config.verify(self.run, journal['kubelet_launch'])
        runtime_install.install_file(STORAGE_HELPER, Path(__file__).with_name('storage_guard.py').read_bytes(), 0o644)
        runtime_install.install_file(STORAGE_RECORD, base64.b64decode(journal['blocked_record']), 0o600)
        runtime_install.install_file(DROPIN, base64.b64decode(journal['dropin']), 0o644)
        self.run(['systemctl', 'daemon-reload'])

    def install_new_configuration(self, journal):
        entries = journal['storage']['entries']
        self.storage.install_fstab(journal['storage'])
        for entry in entries:
            self.storage.switch(entry, self.runtime.assert_stopped, ROOT_UUID)
        self.identities('update', journal)
        for file in ('/var/lib/kubelet/config.yaml', '/var/lib/kubelet/instance-config.yaml'):
            if file in journal['files']:
                old = base64.b64decode(journal['files'][file])
                replace_file(file, cutover_runtime.replace_endpoint(old), old, mode=0o644)
        unit = runtime_install.UNIT
        before = base64.b64decode(journal['files'][str(unit)])
        after = base64.b64decode(journal['unit_after'])
        candidate_before = base64.b64decode(journal['files'][str(runtime_install.RECORD)])
        # The running candidate is unchanged; all startup remains blocked.
        replace_file(unit, after, before, 0o644)
        replace_file(runtime_install.RECORD, base64.b64decode(journal['candidate_after']), candidate_before)
        self.run(['systemctl', 'daemon-reload'])
        candidate_guard.verify()

    def activate(self, journal):
        require(journal['may_write'], '禁止在事务提交前启动新副本')
        endpoint_config.verify(self.run, journal['kubelet_launch'])
        require(DROPIN.read_bytes() == base64.b64decode(journal['dropin']), 'kubelet 存储启动保护与事务不符')
        require(not self.runtime.tasks(cutover_runtime.OLD), '原 Kubernetes 实例仍有任务，拒绝启动新副本')
        candidate_guard.verify()
        record = raw_json(storage_ops.guard_record(journal['storage'], 'active'))
        # Initial blocked record may predate target identities. Compare against
        # its exact saved bytes, not a reconstructed record after copying.
        replace_file(STORAGE_RECORD, record, base64.b64decode(journal['blocked_record']))
        storage_guard.verify()
        candidate = journal['candidate']
        descriptor = {key: candidate[key] for key in ('hostname', 'filesystem_uuid', 'address', 'root', 'state', 'service', 'config_path', 'config_sha256')}
        descriptor.update(schema_version=1, phase='active', kubelet_config_path='/var/lib/kubelet/config.yaml')
        replace_file(DESCRIPTOR, raw_json(descriptor), None, 0o644)
        old = base64.b64decode(journal['crictl_before']) if journal['crictl_before'] is not None else None
        replace_file(CRICTL, base64.b64decode(journal['crictl_after']), old, 0o644)
        self.run(['systemctl', 'enable', runtime_install.SERVICE])
        self.run(['systemctl', 'start', runtime_install.SERVICE], 120)
        self.run(['systemctl', 'start', 'kubelet.service'], 120)
        self.wait(lambda: self.kubectl('get', '--raw=/readyz'), 300, '等待原集群 API 在新运行时恢复')

    def apply_pay_patches(self, journal):
        self.identities('patches', journal, self.pay_resources())
        patches = private_json(Path(journal['run']) / 'storage-identities/pay-patches.json')
        for kind, key in (('configmap', 'configMap'), ('statefulset', 'statefulSet')):
            patch = patches[key]['patch']
            if patch:
                path = Path(journal['run']) / (key + '-patch.json')
                raw = raw_json(patch)
                if path.exists():
                    replace_file(path, raw, path.read_bytes())
                else:
                    prep.save_private(path, raw)
                name = 'mx-pay-database' if kind == 'configmap' else 'mx-pay-postgres'
                self.kubectl('-n', 'mx-pay', 'patch', kind, name, '--type=json', '--patch-file=' + str(path))

    def reconcile_node_endpoint(self, journal):
        old = journal['cluster']['objects']['nodes'][0]['metadata'].get('annotations', {}).get(NODE_ENDPOINT)
        node = json.loads(self.kubectl('get', 'node', NODE, '-o', 'json'))
        require(node['metadata']['uid'] == journal['cluster']['node_uid'], 'Node UID 变化')
        value = node['metadata'].get('annotations', {}).get(NODE_ENDPOINT)
        expected = 'unix://' + cutover_runtime.NEW if old is not None else None
        require(value in (old, expected), 'Node CRI 标注被其他操作修改')
        if value != expected:
            patch = [{'op': 'test', 'path': '/metadata/uid', 'value': node['metadata']['uid']},
                     {'op': 'test', 'path': '/metadata/resourceVersion', 'value': node['metadata']['resourceVersion']},
                     {'op': 'test', 'path': '/metadata/annotations/kubeadm.alpha.kubernetes.io~1cri-socket', 'value': old},
                     {'op': 'replace', 'path': '/metadata/annotations/kubeadm.alpha.kubernetes.io~1cri-socket', 'value': expected}]
            self.run(['kubectl', '--kubeconfig=/etc/kubernetes/admin.conf', '--request-timeout=30s',
                      'patch', 'node', NODE, '--type=json', '--patch-file=/dev/stdin'], input_data=raw_json(patch))

    def finish(self, journal, persist):
        self.activate(journal)
        self.reconcile_node_endpoint(journal)
        self.apply_pay_patches(journal)
        target = next(v for v in journal['storage']['entries'] if v['key'] == 'pay-postgres')
        pay = {'mountTarget': target['logical'], 'filesystemUUID': ROOT_UUID, 'volumeMountRoot': target['target_fsroot']}
        self.cluster.resume(journal['cluster'], lambda value: persist(), pay_mount_root=pay['volumeMountRoot'])
        self.cluster.wait_network_ready(journal['cluster'])
        self.verify(journal)
        journal['automatic_checks_passed'] = True

    def verify(self, journal):
        require(journal['may_write'], '尚未提交新副本')
        candidate_guard.verify()
        storage_guard.verify()
        endpoint_config.verify(self.run, journal['kubelet_launch'])
        require(DROPIN.read_bytes() == base64.b64decode(journal['dropin']) and
                CRICTL.read_bytes() == base64.b64decode(journal['crictl_after']), 'kubelet/crictl 受管配置不匹配')
        self.storage.verify_mount_units(storage_ops.FSTAB.read_bytes())
        require(runtime_resolver.Resolver().resolve('address') == cutover_runtime.NEW, 'kubelet 未使用独立运行时')
        target = next(v for v in journal['storage']['entries'] if v['key'] == 'pay-postgres')
        pay = {'mountTarget': target['logical'], 'filesystemUUID': ROOT_UUID, 'volumeMountRoot': target['target_fsroot']}
        self.cluster.assert_workloads(journal['cluster'], pay_mount_root=pay['volumeMountRoot'])
        self.cluster.wait_ready(journal['cluster'], timeout=0, pay_mount_root=pay['volumeMountRoot'])
        self.cluster.wait_network_ready(journal['cluster'], timeout=0)
        self.identities('verify', journal, self.pay_resources())
        current = self.cluster.validate_cluster_baseline(journal['cluster'], pay_identity=pay)
        require(any(c.get('type') == 'Ready' and c.get('status') == 'True' for c in current['nodes'][0].get('status', {}).get('conditions', [])),
                '原节点尚未 Ready')
        old = journal['cluster']['objects']['nodes'][0]['metadata'].get('annotations', {}).get(NODE_ENDPOINT)
        expected = 'unix://' + cutover_runtime.NEW if old is not None else None
        require(current['nodes'][0]['metadata'].get('annotations', {}).get(NODE_ENDPOINT) == expected, 'Node CRI 标注未核验')
        self.etcd.runtime()
        self.etcd.etcdctl = str(Path(journal['run']) / 'etcdctl')
        status = self.etcd.etcd_status()
        require(all(status[key] == journal['etcd']['etcd'][key] for key in ('cluster_id', 'member_id')) and
                status['revision'] >= journal['etcd']['etcd']['revision'], 'etcd 身份或 revision 不连续')
        require(self.etcd.launcher_check() == journal['launcher_before'], 'Launcher 凭据或登录配置基线变化')
        require(not self.runtime.tasks(cutover_runtime.OLD) and
                self.runtime.tasks(cutover_runtime.OLD, 'moby') == journal['moby_before'], '旧运行时或 Docker task 集合变化')
        require(self.docker_snapshot() == journal['docker_before'], 'Docker 状态或挂载在维护窗口内发生变化')

    def repair_rig_init(self, journal, persist):
        require(journal['phase'] == 'quiescing' and journal['may_write'] is False,
                'Rig 初始化修复仅用于停写阶段失败后恢复原副本')
        state = journal['cluster'].get('state', {})
        require(state.get('quiesced') is True and (state.get('es_snapshot') or {}).get('phase') == 'verified',
                'Rig 初始化修复缺少已完成停写和快照的事务记录')
        require(not os.path.lexists(str(DESCRIPTOR)) and not os.path.lexists(str(STORAGE_RECORD)) and
                not os.path.lexists(str(DROPIN)), '已有切换配置，拒绝按原副本执行 Rig 初始化修复')
        entry = next(e for e in journal['storage']['entries'] if e['key'] == 'rig')
        require(entry['logical'] == storage_ops.ROOTS['rig'] and entry['source'] == entry['logical'] and
                entry['source_mount']['uuid'] == SOURCE_UUID and not entry.get('copied') and
                'target_identity' not in entry, 'Rig 数据已偏离本次未复制的原副本')
        self.storage.validate_source(entry)
        self.cluster.validate_cluster_baseline(journal['cluster'])
        self.cluster.assert_workloads(journal['cluster'])
        prep.stage('核验并修复 Rig 故障初始化容器；随后恢复原服务，不继续迁移')
        with prep.progress('等待 Rig 故障副本正常退出并核验初始化权限修复'):
            rig_init_repair.repair(self.cluster, journal['cluster'], lambda plan: persist())

    def abort(self, journal):
        require(not journal['may_write'], '新副本可能已写入，仅可向前恢复')
        if journal['phase'] not in ('preparing', 'quiescing'):
            # No data may be switched while either runtime has K8s writers.
            self.runtime.stop_old()
            self.storage.unmount_kubelet_children(journal['storage'], self.runtime.assert_stopped)
            for entry in reversed(journal['storage']['entries']):
                self.storage.restore(entry, self.runtime.assert_stopped, ROOT_UUID)
            self.storage.install_fstab(journal['storage'], after=False)
            self.identities('restore', journal)
            for file, after_key in ((runtime_install.UNIT, 'unit_after'), (runtime_install.RECORD, 'candidate_after')):
                before = base64.b64decode(journal['files'][str(file)])
                current = file.read_bytes()
                allowed_after = base64.b64decode(journal.get(after_key, ''))
                require(current in (before, allowed_after), '恢复时运行时配置与事务不匹配')
                replace_file(file, before, current, 0o644 if file == runtime_install.UNIT else 0o600)
            if 'dropin' in journal:
                remove_created(DROPIN, base64.b64decode(journal['dropin']))
            if 'blocked_record' in journal:
                remove_created(STORAGE_RECORD, base64.b64decode(journal['blocked_record']))
            self.run(['systemctl', 'daemon-reload'])
            self.run(['systemctl', 'start', runtime_install.SERVICE], 120)
            self.run(['systemctl', 'start', 'kubelet.service'], 120)
            self.wait(lambda: self.kubectl('get', '--raw=/readyz'), 300, '等待原运行时恢复集群 API')
        if journal['phase'] != 'preparing':
            self.cluster.resume(journal['cluster'], lambda value: None)
            self.cluster.wait_network_ready(journal['cluster'])
            self.identities('verify-restored', journal, self.pay_resources())
            self.cluster.validate_cluster_baseline(journal['cluster'])
            require(self.etcd.launcher_check() == journal['launcher_before'], '原副本恢复后 Launcher 登录配置基线不一致')


class Move:
    def __init__(self, host, path=None):
        self.host, self.path, self.journal, self.previous = host, path, None, None

    def persist(self, phase=None, **values):
        if phase:
            self.journal['phase'] = phase
        self.journal.update(values)
        raw = raw_json(self.journal)
        replace_file(self.path, raw, self.previous)
        self.previous = raw

    @staticmethod
    def recovery_stage(label):
        # A closed terminal or failed log sink cannot prevent recovery or
        # replace the original migration error.
        try:
            prep.stage(label)
        except BaseException:
            pass

    def record_recovery(self, **values):
        # Diagnostic persistence must never prevent restoration of old writers.
        # In particular, do not alter phase: Host.abort uses that phase to decide
        # whether mounts/configuration need restoring as well as the workloads.
        try:
            self.persist(**values)
        except BaseException:
            self.recovery_stage('恢复状态记录未能保存；继续恢复原服务，保留事务供后续核验')

    def restore_original(self, failure=None):
        values = {'recovery_status': 'restoring-original'}
        if failure is not None:
            values['failure_diagnostics'] = failure
        self.recovery_stage('正在恢复原 Kubernetes 服务；等待数据库 Ready 后恢复应用')
        self.record_recovery(**values)
        try:
            # Progress reporting is optional, including thread startup and
            # context cleanup. Neither may skip abort or hide its exception.
            progress = contextlib.ExitStack()
            try:
                progress.enter_context(prep.progress('恢复原 Kubernetes 服务并等待数据库 Ready'))
            except BaseException:
                pass
            try:
                self.host.abort(self.journal)
            finally:
                try:
                    progress.close()
                except BaseException:
                    pass
            self.persist('aborted', recovery_status='restored')
        except BaseException as error:
            self.record_recovery(recovery_status='incomplete',
                                 recovery_diagnostics=failure_diagnostic(error, self.journal['phase']))
            raise

    def execute(self, journal):
        self.journal = journal
        self.persist()
        try:
            self.host.prepare(journal)
            self.persist('quiescing')
            with prep.progress('停止业务写入并校验 Elasticsearch 快照'):
                self.host.cluster.quiesce(journal['cluster'], lambda value: self.persist())
            self.host.cluster.assert_quiesced(journal['cluster'])
            # Kubelet must remain running until its local PV/config binds have
            # disappeared with the stopped Pods. Never unmount those ourselves.
            self.host.release_kubelet_bindings(journal)
            require(self.host.docker_snapshot() == journal['docker_before'], '停写期间 Docker 状态或挂载发生变化')
            # Save exact blocked bytes and intended drop-in before installation.
            journal['blocked_record'] = base64.b64encode(raw_json(storage_ops.guard_record(journal['storage']))).decode()
            self.persist('blocking')
            self.host.block_startup(journal)
            self.persist('stopping')
            self.host.runtime.stop_old()
            self.host.storage.unmount_kubelet_children(journal['storage'], self.host.runtime.assert_stopped)
            journal['pg_shutdown'] = self.host.runtime.check_cold(journal['storage']['entries'])
            self.persist('copying')
            target_parent = Path(storage_guard.DATA_BASE) / journal['transaction']
            prep.secure_directory(str(target_parent), create=True)
            for entry in journal['storage']['entries']:
                with prep.progress('冷复制并校验 ' + entry['key']):
                    self.host.storage.cold_copy(entry, self.host.runtime.assert_stopped, lambda value: self.persist())
            require(self.host.runtime.check_cold(journal['storage']['entries']) == journal['pg_shutdown'], '复制期间源 PostgreSQL 控制文件变化')
            self.persist('switching')
            self.host.install_new_configuration(journal)
            self.persist('committed', may_write=True)
            self.host.finish(journal, self.persist)
            self.persist('services-restored')
        except BaseException as error:
            detail = failure_diagnostic(error, journal['phase'])
            self.recovery_stage('迁移步骤失败；failure_diagnostics=' +
                                json.dumps(detail, ensure_ascii=True, separators=(',', ':')))
            if not journal['may_write']:
                try:
                    self.restore_original(detail)
                except BaseException:
                    self.recovery_stage('自动恢复未完成；保留全部数据，请使用 k8s resume，不要手动挂回旧目录')
            else:
                # Do not persist diagnostics here. A failed commit write/fsync
                # may have an unknown outcome; only resume may resolve it from
                # the durable journal before choosing the recovery direction.
                self.recovery_stage('新副本已提交；保留它作为权威数据，请使用 k8s resume，不要挂回旧目录')
            raise

    def resume(self):
        if self.journal['phase'] == 'aborted':
            return
        if self.journal['may_write']:
            self.host.finish(self.journal, self.persist)
            self.persist('services-restored')
        else:
            self.restore_original()


@contextlib.contextmanager
def locks():
    paths = ['/run/mx-move-k8s.lock', '/run/mx-move-etcd.lock', '/run/mx-launcher-deploy.lock',
             '/var/lib/mx-move/k8s-runtime-install.lock']
    hub = REPO / 'mx-insight-hub/.runtime/internal-production-deploy.flock'
    if hub.parent.is_dir():
        paths.append(str(hub))
    descriptors = []
    try:
        for path in paths:
            fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            descriptors.append(fd)
            candidate_guard.safe(path)
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise prep.Refuse('已有迁移或产品发布正在执行') from None
        yield
    finally:
        for fd in descriptors:
            os.close(fd)


def summary(journal):
    result = {'phase': journal['phase'], 'transaction': journal['transaction'], 'may_write': journal['may_write'],
            'run_directory': journal['run'], 'data_roots': [v['logical'] for v in journal['storage']['entries']],
            'docker_data_moved': False, 'etcd_data_moved_again': False,
            'automatic_checks_passed': journal.get('automatic_checks_passed', False),
            'capacity': journal.get('capacity'),
            'user_login_and_network_validation': 'required', 'historical_data_deleted': False}
    if journal.get('preparation_step') in PREPARATION_STEPS:
        result['preparation_step'] = journal['preparation_step']
    if journal.get('recovery_status') in RECOVERY_STATUSES:
        result['recovery_status'] = journal['recovery_status']
    for key in ('failure_diagnostics', 'recovery_diagnostics'):
        detail = public_failure_diagnostic(journal.get(key))
        if detail is not None:
            result[key] = detail
    return result


def load_move(host):
    current = private_json(CURRENT)
    require(re.fullmatch(r'mx-k8s-[0-9]{8}-[0-9]{6}-[a-f0-9]{8}', current['transaction']), '当前事务标识无效')
    path = BASE / current['transaction'] / 'journal.json'
    candidate_guard.safe(str(path), private=True)
    raw = path.read_bytes()
    journal = json.loads(raw, object_pairs_hook=candidate_guard.unique_object)
    require(journal['run'] == str(path.parent) and journal['transaction'] == current['transaction'] and
            journal['schema_version'] == 1 and type(journal['may_write']) is bool, '事务路径或状态不匹配')
    move = Move(host, path)
    move.journal, move.previous = journal, raw
    return move


def main(argv=None):
    parser = argparse.ArgumentParser(description='本机 Kubernetes 业务存储切换；仅维护窗口执行 migrate，Docker 数据不迁移')
    parser.add_argument('action', choices=('cutover-check', 'prepare-check', 'migrate', 'status', 'resume', 'verify'))
    parser.add_argument('--repair-rig-init', action='store_true',
                        help='仅用于 resume：受控修复已确认的 Rig 初始化权限故障，再恢复原服务')
    args = parser.parse_args(argv)
    if args.repair_rig_init and args.action != 'resume':
        parser.error('--repair-rig-init 只能与 resume 一起使用')
    require(sys.platform.startswith('linux') and os.geteuid() == 0, '请以 root 在 Internal Linux 主机执行')
    os.umask(0o077)
    host = Host()
    if args.action in ('status', 'resume', 'verify'):
        if args.action == 'status':
            move = load_move(host)
        else:
            # Never act on a pre-lock snapshot of may_write. Another process
            # may have committed the new data while this caller waited.
            with locks():
                move = load_move(host)
                if args.action == 'verify':
                    host.verify(move.journal)
                else:
                    if args.repair_rig_init:
                        host.repair_rig_init(move.journal, move.persist)
                    move.resume()
        print(json.dumps(summary(move.journal), ensure_ascii=False, indent=2))
        return
    with locks():
        if CURRENT.exists():
            require(load_move(host).journal['phase'] == 'aborted', '已有事务，请使用 status / resume')
        transaction = 'mx-k8s-' + time.strftime('%Y%m%d-%H%M%S') + '-' + uuid.uuid4().hex[:8]
        with prep.progress('检查完整切换条件（尚未停止业务）'):
            journal = host.preflight(transaction)
        if args.action == 'cutover-check':
            print(json.dumps(dict(summary(journal), phase='preflight-passed', execution_started=False), ensure_ascii=False, indent=2))
            return
        prep.secure_directory(journal['run'], create=True)
        move = Move(host, Path(journal['run']) / 'journal.json')
        move.journal = journal
        move.persist()
        if args.action == 'prepare-check':
            # Exercise backup preparation without publishing CURRENT or calling
            # execute(), which is the only route into workload quiescence.
            prep.stage('仅检查备份准备，不停止业务；私有记录目录：' + journal['run'])
            try:
                host.prepare(journal)
            except BaseException:
                move.persist('preparation-failed')
                raise
            move.persist('preparation-checked')
            print(json.dumps(dict(summary(journal), execution_started=False, service_changes=False),
                             ensure_ascii=False, indent=2))
            return
        before = CURRENT.read_bytes() if CURRENT.exists() else None
        replace_file(CURRENT, raw_json({'transaction': transaction}), before)
        move.execute(journal)
        print(json.dumps(summary(journal), ensure_ascii=False, indent=2))


if __name__ == '__main__':
    def interrupted(signum, frame):
        raise KeyboardInterrupt()
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGHUP, interrupted)
    try:
        main()
    except BaseException as error:
        if isinstance(error, SystemExit):
            raise
        known = (prep.Refuse, candidate_guard.GuardError, storage_guard.StorageError, cluster_ops.ClusterError,
                 endpoint_config.EndpointError, rig_init_repair.Error)
        prep.stage(str(error) if isinstance(error, known) else '迁移未完成；原始错误已隐藏。请运行 k8s status，按事务使用 k8s resume')
        sys.exit(1)
