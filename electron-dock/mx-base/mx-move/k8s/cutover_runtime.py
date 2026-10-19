"""Runtime quiescence and configuration primitives for the local cutover.

Never stop Docker or its containerd service. The caller must persist its
transaction before invoking these operations. No generic reset/force option.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import struct
import sys

import runtime_prepare as prep
import runtime_check as probe
import storage_guard

require = prep.require
OLD = '/run/containerd/containerd.sock'
NEW = prep.NEW_ADDRESS
PROC = Path('/proc')
PG = {'launcher': 'k8s/postgres/pgdata', 'common': 'postgres/data/pgdata',
      'rig': 'postgres/pgdata', 'pay-postgres': 'pgdata'}


def replace_endpoint(raw, old=OLD, new=NEW):
    text = raw.decode('utf-8')
    require(probe.yaml_endpoint(text) == old, 'kubelet 配置不是记录的原 CRI endpoint')
    updated, count = re.subn(r'^containerRuntimeEndpoint\s*:[^\n]*',
                            'containerRuntimeEndpoint: unix://' + new, text, flags=re.M)
    require(count == 1 and probe.yaml_endpoint(updated) == new, '无法唯一更新 kubelet CRI endpoint')
    return updated.encode('utf-8')


def pg_shutdown(path, expected):
    """PG16/17 native control prefix: ID, control version, catalog, DBState.

    This is a shutdown/identity check, not a replacement for PostgreSQL's
    control-file CRC validation on startup. The entire cold tree is checksummed.
    """
    path = Path(path)
    require(not os.path.lexists(str(path / 'postmaster.pid')), 'PostgreSQL 尚有 postmaster.pid，拒绝冷拷贝')
    identity = storage_guard.pg_identity(path)
    require(identity == expected, 'PostgreSQL 身份发生变化')
    raw = (path / 'global/pg_control').read_bytes()
    require(len(raw) == 8192 and sys.byteorder == 'little', '未核验的 PostgreSQL 控制文件布局')
    require(raw[:8].hex() == expected['control_first8_hex'], 'PostgreSQL 控制文件在检查中变化')
    _, version, _, state = struct.unpack_from('<QIII', raw)
    require(version == {'16': 1300, '17': 1700}.get((path / 'PG_VERSION').read_text().strip()) and state == 1,
            'PostgreSQL 控制文件未确认干净关闭；不复制运行中或崩溃状态数据')
    return hashlib.sha256(raw).hexdigest()


def sandbox_order(item):
    metadata = item['metadata']
    name, namespace = metadata['name'], metadata['namespace']
    if namespace == 'kube-system':
        for prefix, priority in (('etcd-', 50), ('kube-apiserver-', 40),
                                 ('kube-controller-manager-', 30), ('kube-scheduler-', 30)):
            if name.startswith(prefix):
                return priority, name
    return (20 if namespace in ('kube-system', 'kube-flannel') else 10), name


class Runtime:
    def __init__(self, host):
        self.host = host

    def cri(self, address, *args):
        return self.host.run(['crictl', '--runtime-endpoint=unix://' + address,
                             '--image-endpoint=unix://' + address, '--timeout=120s'] + list(args), timeout=180)

    def tasks(self, address, namespace='k8s.io'):
        raw = self.host.run(['ctr', '--address', address, '--namespace', namespace, 'tasks', 'list']).decode()
        probe.tasks_summary(raw)
        rows = [line.split() for line in raw.splitlines() if line.strip()][1:]
        require(len({row[0] for row in rows}) == len(rows), '运行时 task 标识不唯一')
        # A host restart changes task PIDs without changing the containers.
        # Keep the identity/state invariant used to verify untouched Docker.
        return sorted(row[0] + ' ' + row[2] for row in rows)

    def candidate_offline(self):
        status = probe.RuntimeInspector().service('mx-k8s-containerd')
        if status.get('ActiveState') not in ('inactive', 'failed') or status.get('MainPID') != '0':
            return False
        try:
            os.lstat(NEW)
        except FileNotFoundError:
            # Before commit the boot gate deliberately prevents this service
            # from starting. After a reboot there can therefore be no socket.
            # A stale socket/symlink or any other inspection failure must still
            # require the normal RPC checks below. Orphan shims are checked too.
            return True
        return False

    def assert_stopped(self):
        status = probe.RuntimeInspector().service('kubelet')
        require(status['ActiveState'] in ('inactive', 'failed') and status['MainPID'] == '0', 'kubelet 尚未完全停止')
        for address in (OLD, NEW):
            if address == NEW and self.candidate_offline():
                continue
            require(not self.tasks(address), 'Kubernetes runtime 尚有任务；拒绝复制或改挂载')
            for name in ('pods', 'ps'):
                args = ('-a', '-q') if name == 'ps' else ('-q',)
                require(not self.cri(address, name, *args).strip(), 'Kubernetes CRI 尚有 sandbox/容器')
        for proc in PROC.glob('[0-9]*'):
            try:
                raw = (proc / 'cmdline').read_bytes()
            except (FileNotFoundError, ProcessLookupError):
                continue
            args = [os.fsdecode(part) for part in raw.rstrip(b'\0').split(b'\0')]
            if not args or not Path(args[0]).name.startswith('containerd-shim'):
                continue
            namespaces = []
            for position, argument in enumerate(args[1:], 1):
                if argument in ('-namespace', '--namespace'):
                    require(position + 1 < len(args), '无法核对 containerd shim namespace')
                    namespaces.append(args[position + 1])
                elif argument.startswith(('-namespace=', '--namespace=')):
                    namespaces.append(argument.split('=', 1)[1])
            require(len(namespaces) == 1 and re.fullmatch('[A-Za-z0-9_.-]+', namespaces[0]),
                    '无法唯一核对 containerd shim namespace')
            # Every k8s.io shim must have exited, including an orphan whose
            # socket address is omitted, aliased, or no longer reachable.
            require(namespaces[0] != 'k8s.io', 'Kubernetes shim 尚未退出')

    def stop_old(self):
        self.host.run(['systemctl', 'stop', 'kubelet.service'], timeout=180)
        status = probe.RuntimeInspector().service('kubelet')
        require(status['ActiveState'] in ('inactive', 'failed') and status['MainPID'] == '0', 'kubelet 未停止')
        pods = json.loads(self.cri(OLD, 'pods', '-o', 'json')).get('items')
        require(isinstance(pods, list), '原 sandbox 列表格式不受支持')
        for item in sorted(pods, key=sandbox_order):
            identifier = item['id']
            require(isinstance(identifier, str) and re.fullmatch('[a-f0-9]{64}', identifier), 'sandbox 标识格式异常')
            containers = json.loads(self.cri(OLD, 'ps', '-a', '--pod', identifier, '-o', 'json')).get('containers')
            require(isinstance(containers, list), 'sandbox 容器列表格式不受支持')
            for container in containers:
                require(container.get('podSandboxId') == identifier and
                        isinstance(container.get('id'), str) and re.fullmatch('[a-f0-9]{64}', container['id']) and
                        container.get('state') in ('CONTAINER_CREATED', 'CONTAINER_RUNNING', 'CONTAINER_EXITED'),
                        'sandbox 容器身份或状态不受支持')
                if container['state'] == 'CONTAINER_RUNNING':
                    # StopPodSandbox may force-stop remaining containers. Give
                    # each one (especially etcd) a graceful interval first;
                    # the stop command's timeout is seconds, not a duration.
                    self.cri(OLD, 'stop', '--timeout=60', container['id'])
            self.cri(OLD, 'stopp', identifier)
            self.cri(OLD, 'rmp', identifier)
        # Retired completed Jobs may leave an orphaned stopped CRI container.
        containers = json.loads(self.cri(OLD, 'ps', '-a', '-o', 'json')).get('containers')
        require(isinstance(containers, list), '原容器列表格式不受支持')
        for item in containers:
            require(item.get('state') == 'CONTAINER_EXITED' and re.fullmatch('[a-f0-9]{64}', item['id']),
                    '存在未退出的孤立 CRI 容器')
            self.cri(OLD, 'rm', item['id'])
        self.host.wait(self.assert_stopped, 120, '等待原 Kubernetes tasks、sandboxes 和 shim 退出')

    def no_host_writers(self, entries):
        """Reject live host descriptors/mappings into the selected data roots.

        Vanished processes/descriptors are normal races. Other inspection
        failures propagate, rather than silently treating access denied as no
        writer. This supplements the CRI and Docker mount checks; operators must
        also keep deployment/host mutation suspended for the maintenance window.
        """
        paths = {v[field] for v in entries for field in ('logical', 'source')}

        def selected(name):
            suffix = ' (deleted)'
            if name.endswith(suffix):
                name = name[:-len(suffix)]
            return any(name == p or name.startswith(p + '/') for p in paths)

        for proc in PROC.glob('[0-9]*'):
            if proc.name == str(os.getpid()):
                continue
            try:
                # A process rooted/working in a selected directory could open
                # new relative paths immediately after the descriptor scan.
                for link in ('cwd', 'root'):
                    try:
                        require(not selected(os.readlink(str(proc / link))),
                                '迁移目录仍是宿主机进程的工作目录或根目录；拒绝复制')
                    except (FileNotFoundError, ProcessLookupError):
                        pass
                for fd in (proc / 'fd').iterdir():
                    try:
                        if not selected(os.readlink(str(fd))):
                            continue
                        info = (proc / 'fdinfo' / fd.name).read_text()
                        modes = re.findall(r'^flags:\s*([0-7]+)\s*$', info, re.M)
                        require(len(modes) == 1 and (int(modes[0], 8) & os.O_ACCMODE) == os.O_RDONLY,
                                '迁移目录仍被宿主机进程写入；拒绝复制')
                    except (FileNotFoundError, ProcessLookupError):
                        continue
                # A shared writable mmap can outlive the descriptor that
                # created it; a read-only fd check alone would miss that writer.
                for row in (proc / 'maps').read_text().splitlines():
                    fields = row.split(None, 5)
                    require(len(fields) >= 5 and re.fullmatch(r'[rwxps-]{4}', fields[1]),
                            '无法核对宿主机进程内存映射；拒绝复制')
                    if len(fields) == 6 and selected(fields[5]):
                        require(not (fields[1][1] == 'w' and fields[1][3] == 's'),
                                '迁移目录仍有可写共享内存映射；拒绝复制')
            except (FileNotFoundError, ProcessLookupError):
                continue

    def check_cold(self, entries):
        self.assert_stopped()
        self.no_host_writers(entries)
        return {entry['key']: pg_shutdown(Path(entry['logical']) / PG[entry['key']], entry['postgres'])
                for entry in entries if entry['key'] in PG}
