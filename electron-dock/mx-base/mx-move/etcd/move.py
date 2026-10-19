#!/usr/bin/env python3
"""Single-node, local kubeadm etcd disk move. Python 3.6+, no third-party modules.

The journal's may_write bit is durable BEFORE the manifest is returned. After
that point the target is authoritative, even when startup/health checking fails.
Never use a historical copy as an automatic rollback of committed writes.
"""
import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import stat
import subprocess
import sys
import threading
import time
import uuid

from storage_paths import StoragePathError, pinned_directory

GIB = 1024 ** 3
STATE = Path('/var/lib/mx-move')
DATA = Path('/var/lib/etcd')
MANIFEST = Path('/etc/kubernetes/manifests/etcd.yaml')
FSTAB = Path('/etc/fstab')
MOUNT_UNIT = 'var-lib-etcd.mount'
GENERATED_MOUNT = Path('/run/systemd/generator') / MOUNT_UNIT
KUBECONFIG = '/etc/kubernetes/admin.conf'
HELPER = Path(__file__).with_name('launcher-identity.mjs')
TLS = ['--endpoints=https://127.0.0.1:2379',
       '--cacert=/etc/kubernetes/pki/etcd/ca.crt',
       '--cert=/etc/kubernetes/pki/etcd/healthcheck-client.crt',
       '--key=/etc/kubernetes/pki/etcd/healthcheck-client.key',
       '--dial-timeout=5s', '--command-timeout=30s']


class Refuse(RuntimeError):
    pass


class CommandFailed(Refuse):
    """Keep raw output private; callers may classify it but must not echo it."""
    def __init__(self, program, returncode=None, output=b'', kind='exit'):
        self.returncode, self.output, self.kind = returncode, output, kind
        message = '返回失败' if kind == 'exit' else '执行失败/超时'
        super().__init__('{} {}（输出已隐藏）'.format(Path(str(program)).name, message))


def require(ok, message):
    if not ok:
        raise Refuse(message)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def log(message):
    print(message, flush=True)


@contextlib.contextmanager
def progress(label, interval=15):
    """Report only fixed stage labels, without exposing command output.

    A heartbeat observes elapsed time only. It does not probe the host or alter
    subprocess timeouts. stderr keeps plan/status stdout usable as JSON.
    """
    started = time.monotonic()
    stopped = threading.Event()

    def report(state):
        try:
            print('[{}] {}：{}（已用 {:.1f} 秒）'.format(
                time.strftime('%H:%M:%S'), label, state, time.monotonic() - started),
                file=sys.stderr, flush=True)
        except (OSError, ValueError):
            # A closed log pipe must not interrupt a storage transaction.
            pass

    def heartbeat():
        while not stopped.wait(interval):
            report('仍在执行')

    report('开始')
    worker = threading.Thread(target=heartbeat, name='mx-move-progress', daemon=True)
    try:
        worker.start()
    except RuntimeError:
        worker = None
        report('周期提示不可用，继续执行')
    completed = False
    try:
        yield
        completed = True
    finally:
        stopped.set()
        if worker is not None:
            worker.join()
        report('完成' if completed else '未完成')


def run(args, timeout=60, input_data=None):
    # Command output may include credentials. Never echo it on failure.
    try:
        result = subprocess.run([str(x) for x in args], stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, timeout=timeout, input=input_data)
    except subprocess.TimeoutExpired:
        raise CommandFailed(args[0], kind='timeout') from None
    except OSError:
        raise CommandFailed(args[0], kind='exec') from None
    if result.returncode != 0:
        raise CommandFailed(args[0], result.returncode, result.stderr + b'\n' + result.stdout)
    return result.stdout


def parse_cri_version(raw):
    # crictl version has no --output/-o flag; its four labels are stable across
    # cri-tools releases. ps/inspect have separate JSON output flags.
    labels = {'Version', 'RuntimeName', 'RuntimeVersion', 'RuntimeApiVersion'}
    values = {}
    for line in raw.decode('utf-8', errors='replace').splitlines():
        label, separator, value = line.partition(':')
        label, value = label.strip(), value.strip()
        if separator and label in labels:
            require(label not in values and value, 'crictl version 响应字段重复或为空（原始输出已隐藏）')
            values[label] = value
    require(set(values) == labels, 'crictl version 响应缺少运行时版本字段（原始输出已隐藏）')
    return values


def cri_failure_reason(error):
    if error.kind == 'timeout':
        return '执行超时'
    if error.kind == 'exec':
        return '无法启动 crictl，请检查程序路径和执行权限'
    output = error.output.decode('utf-8', errors='replace').lower()
    for markers, reason in [
        (['flag provided but not defined', 'unknown flag', 'incorrect usage'], '当前 crictl 不支持所用参数'),
        (['permission denied'], 'CRI socket 权限不足'),
        (['connection refused'], 'CRI socket 拒绝连接'),
        (['no such file or directory'], 'CRI socket 或依赖路径不存在'),
        (['deadline exceeded', 'i/o timeout'], 'CRI 请求超时'),
        (['unknown service', 'unimplemented'], 'CRI API 不兼容或服务未提供'),
        (['failed to connect', 'transport: error while dialing'], 'CRI 连接失败'),
    ]:
        if any(marker in output for marker in markers):
            return reason
    return '运行时请求失败（原始输出已隐藏）'


def fsync_dir(path):
    fd = os.open(str(path), os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def safe_path(path, private=False):
    path = Path(path)
    require(path.is_absolute(), '必须使用绝对路径')
    for part in [path] + list(path.parents):
        if part.exists() or part.is_symlink():
            s = part.lstat()
            require(not stat.S_ISLNK(s.st_mode), '拒绝符号链接: ' + str(part))
            require(s.st_uid == 0 and not s.st_mode & 0o022, '路径必须由 root 持有且不能被组/其他用户写入: ' + str(part))
    if private and path.exists():
        require(path.is_dir() and not path.stat().st_mode & 0o077, '状态目录必须为 root:0700')
    return path


def private_dir(path):
    safe_path(path)
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    safe_path(path, private=True)


def atomic(path, raw, reference=None):
    """Atomic file replacement; preserve fstab/manifest metadata and SELinux xattrs."""
    path = Path(path)
    temp = path.with_name('.' + path.name + '.' + uuid.uuid4().hex)
    fd = os.open(str(temp), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(raw)
            stream.flush()
            if reference:
                s = Path(reference).stat()
                os.fchown(stream.fileno(), s.st_uid, s.st_gid)
                shutil.copystat(str(reference), str(temp))
                for key in os.listxattr(str(reference)):
                    os.setxattr(str(temp), key, os.getxattr(str(reference), key))
            os.fsync(stream.fileno())
        os.replace(str(temp), str(path))
        fsync_dir(path.parent)
    finally:
        if temp.exists():
            temp.unlink()


def save_json(path, value):
    atomic(path, (json.dumps(value, sort_keys=True, indent=2) + '\n').encode())


def read_json(path):
    return json.loads(Path(path).read_text())


def directory_identity(path):
    info = Path(path).stat()
    require(stat.S_ISDIR(info.st_mode), '数据入口必须是目录')
    return {'device': info.st_dev, 'inode': info.st_ino}


def parse_fstab(raw):
    rows = []
    for i, line in enumerate(raw.decode().splitlines(keepends=True)):
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        fields = line.split()
        if len(fields) >= 4 and fields[1] == str(DATA):
            rows.append((i, fields))
    require(len(rows) == 1, 'fstab 必须恰有一条 /var/lib/etcd bind 记录')
    i, fields = rows[0]
    require('bind' in fields[3].split(',') and not set(fields[3].split(',')) & {'nofail', 'noauto', 'ro'},
            'etcd 必须是启动必需的读写 bind mount（不能有 nofail/noauto/ro）')
    require(re.fullmatch(r'/[A-Za-z0-9_./-]+', fields[0]) is not None, '不支持转义/空白字符的 etcd 源路径')
    require('..' not in Path(fields[0]).parts, '拒绝包含 .. 的数据路径')
    return i, fields


def change_fstab(raw, source):
    i, fields = parse_fstab(raw)
    lines = raw.decode().splitlines(keepends=True)
    # Replace only the source token; retain options, comments and every other row.
    lines[i] = re.sub(r'^(\s*)\S+', lambda m: m.group(1) + str(source), lines[i], count=1)
    return ''.join(lines).encode()


def validate_mount_unit(raw, source):
    # Only the simple fstab-generated unit is supported. Do not interpret an
    # administrator's native unit or silently discard its overrides.
    expected = {('Unit', 'SourcePath'): str(FSTAB),
                ('Mount', 'What'): str(source), ('Mount', 'Where'): str(DATA)}
    values, section = {}, None
    for line in raw.decode().splitlines():
        line = line.strip()
        if not line or line.startswith(('#', ';')):
            continue
        require(not line.endswith('\\'), 'etcd 生成挂载配置含续行，无法安全核验')
        if line.startswith('[') and line.endswith(']'):
            section = line[1:-1]
            continue
        key, separator, value = line.partition('=')
        field = (section, key.strip())
        if separator and (field in expected or field == ('Mount', 'Options')):
            require(field not in values, 'etcd 生成挂载配置含重复字段')
            values[field] = value.strip()
    require(all(values.get(key) == value for key, value in expected.items()),
            'etcd 生成挂载配置与 fstab/预期源目录不一致；请检查 systemctl cat var-lib-etcd.mount')
    options = set(values.get(('Mount', 'Options'), '').split(','))
    require('bind' in options and not options & {'nofail', 'noauto', 'ro'},
            'etcd 生成挂载配置不是启动必需的读写 bind mount')


def physical_disks(tree, major_minor):
    found = set()

    def walk(node, parents):
        here = parents | ({node['name']} if node.get('type') == 'disk' else set())
        if node.get('maj:min') == major_minor:
            found.update(here)
        for child in node.get('children', []):
            walk(child, here)
    for node in tree.get('blockdevices', []):
        walk(node, set())
    require(bool(found), '无法验证本地块设备的物理父盘')
    return sorted(found)


def verify_snapshot(path):
    # etcdctl snapshot save appends SHA256(db). Reading only snap/db has no hash
    # and is intentionally rejected: it is not an online snapshot backup.
    size = path.stat().st_size
    require(size > 32 and size % 512 == 32, 'snapshot 缺少 etcdctl 完整性尾部')
    h = hashlib.sha256()
    with path.open('rb') as stream:
        left = size - 32
        while left:
            chunk = stream.read(min(left, 1024 * 1024))
            require(bool(chunk), 'snapshot 提前结束')
            h.update(chunk)
            left -= len(chunk)
        require(h.digest() == stream.read(32), 'snapshot SHA256 校验失败')
    return h.hexdigest()


def tree_bytes(path):
    total = 0
    device = path.stat().st_dev
    for root, dirs, files in os.walk(str(path), followlinks=False):
        for name in dirs + files:
            p = Path(root) / name
            s = p.lstat()
            require(s.st_dev == device and not stat.S_ISLNK(s.st_mode) and
                    (stat.S_ISDIR(s.st_mode) or stat.S_ISREG(s.st_mode)),
                    'etcd 目录不能包含嵌套挂载、链接或特殊文件')
            if stat.S_ISREG(s.st_mode):
                total += s.st_size
    require((path / 'member/snap/db').is_file() and (path / 'member/wal').is_dir(), 'etcd 完整 member/snap/db 与 WAL 缺失')
    return total


def capacity(path, needed):
    info = os.statvfs(str(path))
    free, size = info.f_bavail * info.f_frsize, info.f_blocks * info.f_frsize
    reserve = 50 * GIB
    if free < needed + reserve:
        deficit_gib = (needed + reserve - free + GIB - 1) // GIB
        raise Refuse('文件系统空间不足（检查路径：{}）：总容量 {:.2f} GiB，可用 {:.2f} GiB；'
                     '本轮副本/备份预算 {:.2f} GiB，安全预留 {:.2f} GiB（固定预留）；'
                     '合计至少需要 {:.2f} GiB 可用，还需释放至少 {} GiB（向上取整）。'.format(
                         path, size / GIB, free / GIB, needed / GIB, reserve / GIB,
                         (needed + reserve) / GIB, deficit_gib))
    return {'free_gib': round(free / GIB, 1), 'required_gib': round(needed / GIB, 2), 'reserve_gib': round(reserve / GIB, 1)}


def flag(args, name):
    values = []
    for i, item in enumerate(args):
        if item.startswith(name + '='):
            values.append(item[len(name) + 1:])
        elif item == name and i + 1 < len(args):
            values.append(args[i + 1])
    require(len(values) <= 1, '重复参数 ' + name)
    return values[0] if values else None


def validate_manifest(pod):
    require(pod.get('kind') == 'Pod' and pod.get('metadata', {}).get('name') == 'etcd' and
            pod.get('metadata', {}).get('namespace') == 'kube-system', '仅支持 kubeadm etcd 静态 Pod')
    spec = pod['spec']
    containers = spec.get('containers', [])
    require(spec.get('hostNetwork') is True and len(containers) == 1 and containers[0]['name'] == 'etcd', '不支持此 etcd Pod 拓扑')
    c = containers[0]
    require(not c.get('envFrom') and not any(e.get('name', '').startswith('ETCD_') for e in c.get('env', [])),
            '拒绝环境变量覆盖 etcd 数据/WAL/配置；仅支持 kubeadm 显式参数')
    args = c.get('command', []) + c.get('args', [])
    require(flag(args, '--data-dir') == str(DATA) and not flag(args, '--wal-dir') and not flag(args, '--config-file'), '仅支持 /var/lib/etcd 内置 WAL；拒绝外置 WAL/config-file')
    require('https://127.0.0.1:2379' in (flag(args, '--listen-client-urls') or '').split(','), '缺少本机 etcd TLS endpoint')
    volumes = {v['name']: v.get('hostPath', {}).get('path') for v in spec.get('volumes', [])}
    mappings = {m['mountPath']: volumes.get(m['name']) for m in c.get('volumeMounts', []) if not m.get('subPath') and not m.get('subPathExpr')}
    require(mappings.get(str(DATA)) == str(DATA) and mappings.get('/etc/kubernetes/pki/etcd') == '/etc/kubernetes/pki/etcd', 'etcd 数据/TLS hostPath 不匹配')
    return args


class Host:
    def __init__(self):
        self.endpoint = None
        self.etcdctl = None

    def kubectl(self, *args):
        return run(['kubectl', '--kubeconfig=' + KUBECONFIG, '--request-timeout=15s'] + list(args), 45)

    def cri(self, command, *args):
        require(command in ('version', 'ps', 'inspect'), '不支持的 CRI 检查命令')
        # ps also opens an image service connection. Pin both services to the
        # verified kubelet socket instead of inheriting a stale crictl.yaml.
        options = ['--runtime-endpoint=' + self.endpoint, '--image-endpoint=' + self.endpoint, '--timeout=10s']
        try:
            return run(['crictl'] + options + [command] + list(args), 30)
        except CommandFailed as error:
            hint = ' '.join(shlex.quote(arg) for arg in ['crictl'] + options + ['version'])
            raise Refuse('crictl {} 失败（{}；退出码 {}）。CRI endpoint={}。只读复查：{}'.format(
                command, cri_failure_reason(error), error.returncode if error.returncode is not None else '无',
                self.endpoint, hint)) from None

    def cri_json(self, command, *args):
        raw = self.cri(command, *args)
        try:
            value = json.loads(raw)
        except (ValueError, UnicodeError):
            raise Refuse('crictl {} 未返回有效 JSON（原始输出已隐藏）'.format(command)) from None
        require(isinstance(value, dict), 'crictl {} JSON 结构不匹配（原始输出已隐藏）'.format(command))
        return value

    def mount(self, path):
        value = json.loads(run(['findmnt', '--json', '--target', str(path), '--output', 'TARGET,SOURCE,UUID,FSROOT,FSTYPE,OPTIONS,MAJ:MIN']))['filesystems'][0]
        require(value.get('uuid') and value['fstype'] in ('xfs', 'ext4') and 'rw' in value['options'].split(','), '仅支持可验证 UUID 的读写 xfs/ext4 本地文件系统')
        return value

    def disk(self, path):
        mount = self.mount(path)
        disks = physical_disks(json.loads(run(['lsblk', '--json', '--paths', '--output', 'NAME,TYPE,MAJ:MIN'])), mount['maj:min'])
        return {'uuid': mount['uuid'], 'disks': disks}

    def same_mount(self, source):
        m = self.mount(DATA)
        require(m['target'] == str(DATA) and os.path.samefile(str(source), str(DATA)), '活动 etcd bind mount 与记录不一致')

    def persistent_mount(self, source):
        _, fields = parse_fstab(FSTAB.read_bytes())
        require(fields[0] == str(source), 'fstab 的 etcd 源目录与预期不一致')
        properties = ['LoadState', 'FragmentPath', 'SourcePath', 'DropInPaths', 'NeedDaemonReload']
        command = ['systemctl', 'show', '--no-pager']
        for name in properties:
            command.extend(['--property', name])
        command.append(MOUNT_UNIT)
        raw = run(command, 30)
        values = {}
        for line in raw.decode().splitlines():
            name, separator, value = line.partition('=')
            if separator and name in properties:
                require(name not in values, 'systemd 挂载检查返回重复字段')
                values[name] = value
        require(set(values) == set(properties), 'systemd 挂载检查缺少字段；请检查 systemctl show var-lib-etcd.mount')
        require(values['LoadState'] == 'loaded' and values['FragmentPath'] == str(GENERATED_MOUNT) and
                values['SourcePath'] == str(FSTAB) and not values['DropInPaths'],
                'etcd 挂载必须仅由 /etc/fstab 生成，不能有原生 mount unit 或 drop-in 覆盖；请检查 systemctl cat var-lib-etcd.mount')
        require(values['NeedDaemonReload'] == 'no',
                'etcd 挂载配置尚未被 systemd 重新加载；请核查配置后执行 daemon-reload，再运行 plan')
        # For an active bind, systemctl show What/Options reflect the live block
        # device, not the next-boot source. Read the verified fragment instead.
        safe_path(GENERATED_MOUNT)
        validate_mount_unit(GENERATED_MOUNT.read_bytes(), source)

    @contextlib.contextmanager
    def storage(self, path, expected=None):
        # /data can belong to its existing storage administrator. This exception
        # applies only to a verified filesystem root, never to data/state dirs.
        m = self.mount(path)
        boundary = Path(m['target'])
        shared = boundary if boundary != Path('/') and boundary != Path(path) and m['fsroot'] == '/' else None
        try:
            with pinned_directory(path, shared_mount=shared, expected=expected) as handle:
                device = '{}:{}'.format(os.major(handle.identity['device']), os.minor(handle.identity['device']))
                require(device == m['maj:min'], '目录在打开期间换到了其他文件系统')
                handle.assert_current()
                yield handle
        except StoragePathError as error:
            raise Refuse(str(error)) from None

    def storage_identity(self, path):
        with self.storage(path) as handle:
            return handle.identity

    def active_identity(self, expected, disk):
        m = self.mount(DATA)
        require(m['target'] == str(DATA) and m['uuid'] == disk['uuid'] and
                directory_identity(DATA) == expected, '活动 etcd 目录 inode/文件系统与事务记录不一致')

    def no_child_mounts(self, paths):
        result = json.loads(run(['findmnt', '--json', '--list', '--output', 'TARGET']))
        targets = [entry['target'] for entry in result.get('filesystems', [])]
        for path in paths:
            prefix = str(path).rstrip('/') + '/'
            require(not any(target.startswith(prefix) for target in targets), 'etcd 目录下存在子挂载；拒绝遗漏独立 WAL 或数据')

    def runtime(self):
        pids = []
        for p in Path('/proc').glob('[0-9]*'):
            try:
                if (p / 'comm').read_text().strip() == 'kubelet':
                    pids.append(p)
            except (OSError, UnicodeError):
                pass
        require(len(pids) == 1, '必须有且仅有一个运行中的 kubelet')
        cmd = (pids[0] / 'cmdline').read_bytes().decode().split('\0')
        config = Path(flag(cmd, '--config') or '/var/lib/kubelet/config.yaml')
        safe_path(config)
        content = config.read_text()
        endpoint_match = re.search(r'^\s*containerRuntimeEndpoint:\s*[\"\x27]?([^\s\"\x27]+)', content, re.M)
        endpoint = flag(cmd, '--container-runtime-endpoint') or (endpoint_match.group(1) if endpoint_match else None)
        manifest_match = re.search(r'^\s*staticPodPath:\s*[\"\x27]?([^\s\"\x27]+)', content, re.M)
        watched = flag(cmd, '--pod-manifest-path') or (manifest_match.group(1) if manifest_match else None)
        require(watched and Path(watched) == MANIFEST.parent and not flag(cmd, '--manifest-url'), 'kubelet 实际监视目录不是预期静态 Pod 目录')
        require(endpoint and endpoint.startswith('unix:///') and Path(endpoint[7:]).is_socket(), '无法确定 kubelet 正在使用的本机 CRI socket')
        self.endpoint = endpoint
        info = parse_cri_version(self.cri('version'))
        require(info['RuntimeName'] == 'containerd', '此迁移工具仅支持 containerd CRI')

    def containers(self):
        result = self.cri_json('ps', '-a', '-o', 'json')
        require(isinstance(result.get('containers'), list), 'crictl ps JSON 缺少 containers 列表（原始输出已隐藏）')
        return result['containers']

    def etcd_containers(self):
        return [c for c in self.containers() if c.get('metadata', {}).get('name') == 'etcd' and c.get('state') == 'CONTAINER_RUNNING']

    def stopped(self):
        if self.etcd_containers():
            return False
        for p in Path('/proc').glob('[0-9]*'):
            try:
                if (p / 'comm').read_text().strip() == 'etcd':
                    return False
            except (OSError, UnicodeError):
                pass
        return True

    def ctl(self, *args):
        return run([self.etcdctl] + TLS + list(args), 180)

    def etcd_status(self):
        status = json.loads(self.ctl('endpoint', 'status', '-w', 'json'))
        require(len(status) == 1, 'etcd endpoint 数量异常')
        s = status[0]['Status']
        require(not s.get('errors') and not s.get('isLearner') and s.get('leader') == s['header']['member_id'], 'etcd 未就绪或非单节点 leader')
        members = json.loads(self.ctl('member', 'list', '-w', 'json'))['members']
        require(len(members) == 1 and members[0]['ID'] == s['header']['member_id'], '拒绝多 member etcd 集群')
        return {'cluster_id': s['header']['cluster_id'], 'member_id': s['header']['member_id'], 'revision': s['header']['revision'], 'version': s['version']}

    def helper(self, action, journal):
        run(['node', HELPER, action, journal['run'], journal['node'], journal['cluster_uid']])

    def leases(self):
        result = {}
        for name in ['kube-controller-manager', 'kube-scheduler']:
            lease = json.loads(self.kubectl('-n', 'kube-system', 'get', 'lease', name, '-o', 'json'))
            require(lease.get('spec', {}).get('renewTime'), '控制器 lease 尚未就绪')
            result[name] = lease['spec']['renewTime']
        return result

    def launcher_check(self):
        deployments = json.loads(self.kubectl('get', 'deployments', '-A', '-o', 'json'))['items']
        matches = [d for d in deployments if d['metadata']['name'] == 'mx-launcher-internal']
        require(len(matches) <= 1, '多个 Launcher Internal 实例，无法确定验收目标')
        if not matches:
            return None
        namespace = matches[0]['metadata']['namespace']
        secrets = json.loads(self.kubectl('-n', namespace, 'get', 'secrets', '-o', 'json'))['items']
        # Hash only values/config; resource versions legitimately change.
        fingerprints = {s['metadata']['name']: digest(json.dumps(s.get('data', {}), sort_keys=True).encode())
                        for s in secrets if s['metadata']['name'].startswith('mx-')}
        ops = [s for s in secrets if s['metadata']['name'] == 'mx-internal-ops']
        require(len(ops) == 1 and ops[0].get('data', {}).get('token'), 'Launcher Ops 凭据缺失')
        script = """
let input=''; process.stdin.on('data', c=>input+=c); process.stdin.on('end',async()=>{
 try {
  const token=Buffer.from(JSON.parse(input).token,'base64').toString('utf8');
  const r=await fetch('http://127.0.0.1:18090/internal/v1/user-center/roles',
    {headers:{'x-mx-ops-token':token},signal:AbortSignal.timeout(10000)});
  await r.body?.cancel(); if(r.status!==200) throw Error();
  const f=await fetch('http://127.0.0.1:18090/internal/v1/sdk/oauth/feishu/config',
    {signal:AbortSignal.timeout(10000)});
  if(!f.ok) throw Error(); console.log(JSON.stringify({feishu:(await f.json()).config?.enabled===true}));
 } catch { process.exitCode=1; }
});"""
        output = run(['kubectl', '--kubeconfig=' + KUBECONFIG, '--request-timeout=30s', '-n', namespace,
                      'exec', '-i', 'deployment/mx-launcher-internal', '--', 'node', '-e', script],
                     45, json.dumps({'token': ops[0]['data']['token']}).encode())
        return {'namespace': namespace, 'secrets': fingerprints, 'login_config': json.loads(output)}

    def discover(self):
        require(sys.platform.startswith('linux') and os.geteuid() == 0, '请在 Internal 控制平面 Linux 主机以 root 执行')
        for name in ['kubectl', 'crictl', 'rsync', 'findmnt', 'lsblk', 'mount', 'umount', 'node', 'sync', 'systemctl']:
            require(shutil.which(name), '缺少依赖: ' + name)
        for path in [MANIFEST, FSTAB, Path(KUBECONFIG), DATA, STATE.parent]:
            safe_path(path)
        _, fields = parse_fstab(FSTAB.read_bytes())
        source = Path(fields[0])
        self.persistent_mount(source)
        self.runtime()
        pod = json.loads(self.kubectl('create', '--dry-run=client', '--validate=false', '-f', str(MANIFEST), '-o', 'json'))
        validate_manifest(pod)
        # No other file in the watched directory may define a second etcd Pod.
        others = [p for p in MANIFEST.parent.iterdir() if p.is_file() and not p.name.startswith('.') and p != MANIFEST]
        for path in others:
            require(not re.search(rb'(?m)^\s*name:\s*[\"\x27]?etcd[\"\x27]?\s*$', path.read_bytes()), 'manifests 目录有另一份 etcd 配置，请先人工检查')
        nodes = json.loads(self.kubectl('get', 'nodes', '-o', 'json'))['items']
        require(len(nodes) == 1, '仅支持现有单节点集群')
        node = nodes[0]
        require(any(c['type'] == 'Ready' and c['status'] == 'True' for c in node['status']['conditions']), '节点尚未 Ready')
        cluster_uid = json.loads(self.kubectl('get', 'namespace', 'kube-system', '-o', 'json'))['metadata']['uid']
        with self.storage(source) as handle:
            self.same_mount(handle.proc_path)
            source_identity = handle.identity
        source_parent_identity = self.storage_identity(source.parent)
        self.no_child_mounts([source, DATA])
        size = tree_bytes(DATA)
        running = self.etcd_containers()
        require(len(running) == 1 and running[0].get('labels', {}).get('io.kubernetes.pod.namespace') == 'kube-system', 'etcd 容器身份不明确')
        inspect = self.cri_json('inspect', '-o', 'json', running[0]['id'])
        details = inspect.get('info')
        pid = details.get('pid') if isinstance(details, dict) else None
        require(type(pid) is int and pid > 0, 'crictl inspect 未返回有效的 containerd etcd PID（原始输出已隐藏）')
        proc = Path('/proc') / str(pid)
        require((proc / 'comm').read_text().strip() == 'etcd' and os.path.samefile(str(proc / 'root/var/lib/etcd/member/snap/db'), str(DATA / 'member/snap/db')), 'etcd 进程没有使用预期数据')
        require(not any(v.startswith(b'ETCD_') for v in (proc / 'environ').read_bytes().split(b'\0')), 'etcd 进程有环境配置覆盖，不支持自动搬迁')
        live_args = (proc / 'cmdline').read_bytes().decode().split('\0')
        require(flag(live_args, '--data-dir') == str(DATA) and not flag(live_args, '--wal-dir') and not flag(live_args, '--config-file'),
                'etcd 实际进程数据/WAL/config 参数不匹配')
        executable = Path(os.readlink(str(proc / 'exe')))
        candidate = proc / 'root' / str(executable.parent / 'etcdctl').lstrip('/')
        require(candidate.is_file(), '当前 etcd 镜像缺少配套 etcdctl（不自动下载工具）')
        self.etcdctl = str(candidate)
        status = self.etcd_status()
        require(status['version'].startswith(('3.5.', '3.6.')), '仅支持 etcd 3.5/3.6')
        version = run([self.etcdctl, 'version']).decode()
        require(status['version'] in version, 'etcdctl 与运行中 etcd 版本不同')
        self.active_identity(source_identity, self.disk(source))
        return {'node': node['metadata']['name'], 'cluster_uid': cluster_uid, 'source': str(source),
                'source_identity': source_identity, 'source_parent_identity': source_parent_identity,
                'source_disk': self.disk(source), 'size': size, 'etcd': status, 'endpoint': self.endpoint}

    def health(self, journal):
        side = 'target' if journal['may_write'] else 'source'
        self.active_identity(journal[side + '_identity'], journal[side + '_disk'])
        self.same_mount(journal['target'] if journal['may_write'] else journal['source'])
        status = self.etcd_status()
        for key in ['cluster_id', 'member_id']:
            require(status[key] == journal['etcd'][key], 'etcd 集群/member 身份发生变化')
        require(status['revision'] >= journal['etcd']['revision'], 'etcd revision 倒退')
        self.kubectl('get', '--raw=/readyz')
        namespace = json.loads(self.kubectl('get', 'namespace', 'kube-system', '-o', 'json'))
        require(namespace['metadata']['uid'] == journal['cluster_uid'], 'Kubernetes 集群 UID 变化')
        nodes = json.loads(self.kubectl('get', 'nodes', '-o', 'json'))['items']
        require(len(nodes) == 1 and nodes[0]['metadata']['name'] == journal['node'] and
                any(c['type'] == 'Ready' and c['status'] == 'True' for c in nodes[0]['status']['conditions']), '原节点未恢复 Ready')
        return status


def wait_for(test, seconds, message):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            value = test()
            if value:
                return value
        except (Refuse, OSError, ValueError, KeyError):
            pass
        time.sleep(2)
    raise Refuse(message)


class Move:
    def __init__(self, host, state=STATE):
        self.host, self.state = host, state
        self.current_file = state / 'current.json'
        self.j = None

    def persist(self, phase=None, **changes):
        if phase:
            self.j['phase'] = phase
        self.j.update(changes)
        save_json(Path(self.j['run']) / 'journal.json', self.j)
        save_json(self.current_file, self.j)

    def load(self):
        require(self.current_file.exists(), '尚无迁移记录')
        safe_path(self.current_file)
        pointer = read_json(self.current_file)
        # run journal is written first; use it if interrupted between the writes.
        safe_path(Path(pointer['run']), private=True)
        self.j = read_json(Path(pointer['run']) / 'journal.json')
        require(self.j['run'] == pointer['run'] and self.j['version'] == 1, '迁移 journal 不匹配')
        self.host.endpoint = self.j['endpoint']
        self.host.etcdctl = str(Path(self.j['run']) / 'etcdctl')
        return self.j

    def plan(self, mode, target_root):
        facts = self.host.discover()
        current_tool = self.host.etcdctl
        if mode == 'rollback':
            old = self.load()
            completed_move = old['phase'] == 'complete' and old['direction'] == 'migrate'
            retry_rollback = old['phase'] == 'aborted' and old['direction'] == 'rollback'
            require(completed_move or retry_rollback, 'rollback 需要已完成的迁移或安全中止的回滚；中断请先运行 resume')
            active = old['target'] if completed_move else old['source']
            require(facts['source'] == active and facts['etcd']['cluster_id'] == old['etcd']['cluster_id'], '当前数据不是本次迁移的活动数据')
            root = Path(old['origin']).parent
            origin, origin_disk = old['origin'], old['origin_disk']
            require('origin_parent_identity' in old, '旧记录缺少原盘父目录身份，需人工核验后才能回滚')
            origin_parent_identity = old['origin_parent_identity']
        else:
            if self.current_file.exists():
                previous = self.load()
                require(previous['phase'] in ('complete', 'aborted'), '存在未完成事务；请先执行 resume')
                require((previous['phase'] == 'aborted' and previous['direction'] == 'migrate') or
                        (previous['phase'] == 'complete' and previous['direction'] == 'rollback'),
                        '仍在迁移目标上运行；无需 migrate，失败回滚可重试 rollback')
            root = Path(target_root)
            origin, origin_disk = facts['source'], facts['source_disk']
            origin_parent_identity = facts['source_parent_identity']
        require(re.fullmatch(r'/[A-Za-z0-9_./-]+', str(root)) is not None and '..' not in root.parts,
                '目标必须是没有空白、转义或 .. 的绝对路径')
        if mode == 'rollback':
            with self.host.storage(root, origin_parent_identity):
                pass
        else:
            safe_path(root)
        existing = root
        while not existing.exists():
            existing = existing.parent
        target_disk = self.host.disk(existing)
        state_existing = self.state if self.state.exists() else self.state.parent
        state_disk = self.host.disk(state_existing)
        require(not set(facts['source_disk']['disks']) & set(target_disk['disks']), '源和目标位于同一物理盘，迁移不能隔离 I/O')
        require(target_disk['uuid'] != facts['source_disk']['uuid'], '目标文件系统必须独立')
        if mode == 'migrate':
            require(target_disk == self.host.disk(Path('/')) == state_disk, '目标和备份状态须位于根文件系统，且与源数据的物理盘独立；请先确认磁盘布局')
        else:
            require(target_disk == origin_disk, '原 2T 文件系统身份变化，拒绝回滚到替代盘')
        budget = capacity(existing, facts['size'] * (3 if target_disk == state_disk else 2) + GIB)
        if target_disk != state_disk:
            capacity(state_existing, facts['size'] + GIB)
        facts.update({'target_root': str(root), 'target_disk': target_disk, 'origin': origin,
                      'origin_disk': origin_disk, 'origin_parent_identity': origin_parent_identity,
                      'target_parent_identity': self.host.storage_identity(root) if root.exists() else None,
                      'space': budget, 'direction': mode})
        self.host.etcdctl = current_tool
        return facts

    def prepare(self, facts):
        private_dir(self.state)
        run_dir = self.state / 'runs' / (time.strftime('%Y%m%d-%H%M%S') + '-' + uuid.uuid4().hex[:8])
        private_dir(run_dir)
        root = Path(facts['target_root'])
        # On rollback the source parent belongs to the existing data layout.
        if not root.exists():
            private_dir(root)
        with self.host.storage(root, facts['target_parent_identity']) as parent:
            facts['target_parent_identity'] = parent.identity
        target = root / ('mx-etcd-' + run_dir.name)
        require(not target.exists(), '目标 generation 已存在')
        held = MANIFEST.parent.parent / ('mx-move-etcd-' + run_dir.name + '.yaml')
        j = dict(facts, version=1, run=str(run_dir), target=str(target), held=str(held),
                 phase='preparing', may_write=False)
        self.j = j
        log('本次备份与事务目录：' + str(run_dir))
        with progress('备份配置、证书与 Launcher 恢复记录'):
            for src, dest in [(MANIFEST, run_dir / 'etcd.yaml'), (FSTAB, run_dir / 'fstab.before')]:
                shutil.copy2(str(src), str(dest))
                os.chmod(str(dest), 0o600)
            atomic(run_dir / 'fstab.after', change_fstab((run_dir / 'fstab.before').read_bytes(), target))
            # Copy matching tool from the running image before its container exits.
            shutil.copyfile(self.host.etcdctl, str(run_dir / 'etcdctl'))
            os.chmod(str(run_dir / 'etcdctl'), 0o700)
            self.host.etcdctl = str(run_dir / 'etcdctl')
            run([self.host.etcdctl, 'version'])
            self.host.helper('prepare', j)
            shutil.copytree('/etc/kubernetes/pki', str(run_dir / 'pki'))
        # Private parent protects original key modes; backup never enters logs.
        log('保存在线 etcd snapshot 并校验 SHA256；此阶段不暂停 etcd。')
        with progress('保存在线 etcd snapshot'):
            self.host.ctl('snapshot', 'save', str(run_dir / 'snapshot.db'))
        os.chmod(str(run_dir / 'snapshot.db'), 0o600)
        with progress('校验 snapshot SHA256'):
            j['snapshot_sha256'] = verify_snapshot(run_dir / 'snapshot.db')
        with progress('记录集群、容器与 Launcher 登录配置基线'):
            j['etcd'] = self.host.etcd_status()
            j['business'] = sorted(c['id'] for c in self.host.containers() if c.get('state') == 'CONTAINER_RUNNING' and c.get('metadata', {}).get('name') != 'etcd')
            j['leases'] = self.host.leases()
            j['launcher'] = self.host.launcher_check()
        with progress('安装并验证启动保护'):
            self.guard_record('source')
            self.boot_guard()
        with progress('备份落盘'):
            run(['sync', '-f', str(run_dir)], 180)
        self.persist('prepared')

    def boot_guard(self):
        # On future boots kubelet must not start an empty etcd after a failed
        # bind mount. daemon-reload does not restart the running kubelet.
        directory = Path('/etc/systemd/system/kubelet.service.d')
        safe_path(directory)
        directory.mkdir(mode=0o755, parents=True, exist_ok=True)
        guard = directory / '90-mx-move-etcd.conf'
        mountpoint, test = shutil.which('mountpoint'), shutil.which('test')
        require(mountpoint and test, '缺少 mountpoint/test 启动保护工具')
        legacy = ('# Managed by mx-base/mx-move; kept on rollback.\n[Unit]\nRequiresMountsFor=/var/lib/etcd\n'
               '[Service]\nExecStartPre={} -q /var/lib/etcd\nExecStartPre={} -s /var/lib/etcd/member/snap/db\n'.format(mountpoint, test)).encode()
        installed = self.state / 'boot-guard.py'
        safe_path(installed)
        atomic(installed, Path(__file__).with_name('boot_guard.py').read_bytes())
        # Keep the boot dependency independent of this repository's checkout.
        # Prefer the system Python so activating Conda is not a boot dependency.
        python = (Path('/usr/bin/python3') if Path('/usr/bin/python3').is_file() else Path(sys.executable)).resolve()
        safe_path(python)
        run([python, '-I', '-c', 'import sys; assert sys.version_info >= (3, 6)'])
        self.j['guard_python'] = str(python)
        self.check_boot_guard()

        def unit(arguments):
            command = ' '.join('"' + str(p).replace('\\', '\\\\').replace('"', '\\"') + '"'
                               for p in arguments)
            return ('# Managed by mx-base/mx-move; kept on rollback.\n[Unit]\nRequiresMountsFor=/var/lib/etcd\n'
                    '[Service]\nExecStartPre=' + command + '\n').encode()

        raw = unit(self.boot_guard_command())
        previous = unit([python, installed, '--record', self.state / 'active-etcd.json'])
        safe_path(guard)
        if guard.exists():
            require(guard.read_bytes() in (raw, previous, legacy), '已有不同的 mx-move kubelet 启动保护，请人工核查')
            atomic(Path(self.j['run']) / 'boot-guard.before', guard.read_bytes())
        if not guard.exists() or guard.read_bytes() != raw:
            atomic(guard, raw)
        run(['systemctl', 'daemon-reload'])

    def boot_guard_command(self):
        python = self.j.get('guard_python')
        require(isinstance(python, str) and Path(python).is_absolute(),
                '事务缺少已验证的启动保护 Python 路径，拒绝恢复 manifest')
        safe_path(Path(python))
        installed = self.state / 'boot-guard.py'
        safe_path(installed)
        return [python, '-I', installed, '--record', self.state / 'active-etcd.json']

    def check_boot_guard(self):
        # Run the same isolated command used by systemd, including on resume.
        # A failed guard must leave the etcd manifest outside the watched path.
        command = self.boot_guard_command()
        try:
            run(command)
        except CommandFailed:
            raise Refuse('etcd 启动保护检查失败（原始输出已隐藏）；只读复查：' +
                         ' '.join(shlex.quote(str(arg)) for arg in command)) from None

    def guard_record(self, *sides):
        allowed = []
        for side in sides:
            require(side + '_identity' in self.j, '事务缺少目录身份，拒绝猜测数据位置')
            allowed.append({'uuid': self.j[side + '_disk']['uuid'], 'inode': self.j[side + '_identity']['inode']})
        save_json(self.state / 'active-etcd.json', {'version': 1, 'data': str(DATA), 'allowed': allowed})

    def manifest_out(self):
        held = Path(self.j['held'])
        backup = Path(self.j['run']) / 'etcd.yaml'
        if MANIFEST.exists():
            require(not held.exists() and MANIFEST.read_bytes() == backup.read_bytes(), 'etcd manifest 变化/重复，拒绝暂停')
            self.persist('stopping')
            os.rename(str(MANIFEST), str(held))
            fsync_dir(MANIFEST.parent)
            fsync_dir(held.parent)
        else:
            require(held.exists() and held.read_bytes() == backup.read_bytes(), '无法验证已暂停的 manifest')
        with progress('等待 etcd 容器和进程停止'):
            wait_for(self.host.stopped, 150, 'etcd 未停止，未执行复制或卸载')
            require(self.host.stopped(), 'etcd 仍在运行')

    def manifest_in(self):
        side = 'target' if self.j['may_write'] else 'source'
        self.host.active_identity(self.j[side + '_identity'], self.j[side + '_disk'])
        self.host.persistent_mount(self.j[side])
        self.check_boot_guard()
        held = Path(self.j['held'])
        backup = Path(self.j['run']) / 'etcd.yaml'
        if MANIFEST.exists():
            require(not held.exists() and MANIFEST.read_bytes() == backup.read_bytes(), 'etcd manifest 冲突')
        else:
            require(held.exists() and held.read_bytes() == backup.read_bytes(), '待恢复 manifest 缺失/变化')
            os.rename(str(held), str(MANIFEST))
            fsync_dir(held.parent)
            fsync_dir(MANIFEST.parent)

    def fstab_to(self, after):
        run_dir = Path(self.j['run'])
        before = (run_dir / 'fstab.before').read_bytes()
        new = (run_dir / 'fstab.after').read_bytes()
        current = FSTAB.read_bytes()
        require(current in (before, new), 'fstab 被其他进程修改；拒绝覆盖')
        desired = new if after else before
        if current != desired:
            atomic(FSTAB, desired, reference=FSTAB)
        # Update generated mount units; does not restart kubelet or any runtime.
        run(['systemctl', 'daemon-reload'])
        self.host.persistent_mount(self.j['target'] if after else self.j['source'])

    def mount_to(self, path, expected_disk):
        require(self.host.stopped() and not MANIFEST.exists(), 'etcd 未证实停止，禁止切换挂载')
        path = Path(path)
        side = 'source' if str(path) == self.j['source'] else 'target'
        require(str(path) == self.j[side] and side + '_identity' in self.j, '缺少待挂载目录身份')
        with self.host.storage(path, self.j[side + '_identity']) as handle:
            require(self.host.disk(path) == expected_disk and (Path(handle.proc_path) / 'member/snap/db').is_file(), '目录/磁盘身份变化，拒绝挂载')
            current = self.host.mount(DATA)
            if current['target'] == str(DATA):
                identity = directory_identity(DATA)
                require(identity in [self.j.get('source_identity'), self.j.get('target_identity')], '检测到第三方 etcd 挂载，拒绝卸载')
                if identity == handle.identity:
                    handle.assert_current()
                    return
                run(['umount', str(DATA)])
            # The directory FD remains valid even if a shared ancestor is moved.
            run(['mount', '--bind', handle.proc_path, str(DATA), '--no-canonicalize'])
            handle.assert_current()
            self.host.active_identity(handle.identity, expected_disk)

    def cold_copy(self):
        source, target = Path(self.j['source']), Path(self.j['target'])
        require(self.host.stopped() and not MANIFEST.exists(), '禁止复制仍在运行的 etcd')
        self.host.same_mount(source)
        self.host.active_identity(self.j['source_identity'], self.j['source_disk'])
        self.host.no_child_mounts([source, DATA])
        with progress('复查冷拷贝数据大小与目标空间'):
            size = tree_bytes(DATA)
            capacity(target.parent, size + GIB)
        require(not target.exists(), '冷拷贝目标必须是全新 generation')
        self.persist('copying')
        with self.host.storage(target.parent, self.j['target_parent_identity']) as parent:
            os.mkdir(target.name, mode=0o700, dir_fd=parent.fd)
            with parent.open_child(target.name) as destination:
                self.persist(target_identity=destination.identity)
                log('etcd 已暂停，复制完整 member/WAL；原目录保留。')
                # DATA is the existing, root-protected bind. Do not reread the
                # mutable /data pathname after validating the live DB inode.
                with progress('冷拷贝完整 member/WAL（{:.1f} MiB）'.format(size / 1024 ** 2)):
                    run(['rsync', '-aHAX', '--numeric-ids', str(DATA) + '/', destination.proc_path + '/'], 900)
                with progress('校验冷副本内容与元数据'):
                    require(not run(['rsync', '-aHAXnci', '--numeric-ids', str(DATA) + '/', destination.proc_path + '/'], 900).strip(), '冷拷贝内容或元数据校验失败')
                    require(tree_bytes(Path(destination.proc_path)) == size, '冷拷贝文件大小不一致')
                with progress('冷副本落盘'):
                    run(['sync', '-f', destination.proc_path], 180)
                parent.assert_current()
                destination.assert_current()
                self.host.active_identity(self.j['source_identity'], self.j['source_disk'])
                self.host.same_mount(source)
        self.persist('copied')

    def finish(self):
        with progress('等待 etcd、Kubernetes API 与原节点恢复健康'):
            status = wait_for(lambda: self.host.health(self.j), 180, 'etcd/API 未恢复健康；保留当前权威副本，请运行 status/resume')
        with progress('核对 Launcher 恢复身份'):
            self.host.helper('reconcile', self.j)
        def leases_renewed():
            current = self.host.leases()
            return all(current[name] > value for name, value in self.j['leases'].items())
        with progress('等待 controller-manager 与 scheduler 续租'):
            wait_for(leases_renewed, 90, '控制器 lease 未继续更新；保持当前副本，请运行 resume')
        with progress('验收 Launcher 登录配置与凭据，核对原有容器'):
            require(self.host.launcher_check() == self.j['launcher'], 'Launcher 凭据/登录配置/只读认证验收变化；保持当前副本，核查后 resume')
            active = {c['id'] for c in self.host.containers() if c.get('state') == 'CONTAINER_RUNNING'}
        lost = sorted(set(self.j['business']) - active)
        # Record rather than automatically restart or revert business workloads.
        self.persist('complete', final_etcd=status, changed_business_containers=lost)
        log('完成。原始目录、snapshot、冷副本和事务记录均保留：' + self.j['run'])
        if lost:
            log('注意：有 {} 个原有非 etcd 容器 ID 已不在运行列表中（统计包含控制平面）。'
                '请用 status 查看 ID 并核查对应服务及登录/联网；脚本未主动重启这些容器。'.format(len(lost)))

    def switch(self):
        # Snapshot preparation can take time. Recheck the selected source before
        # removing the manifest, so a changed shared path need not interrupt etcd.
        with progress('暂停前复查源目录与持久挂载'):
            self.host.persistent_mount(self.j['source'])
            with self.host.storage(self.j['source'], self.j['source_identity']):
                self.host.active_identity(self.j['source_identity'], self.j['source_disk'])
        self.manifest_out()
        self.cold_copy()
        self.persist('switching')
        with progress('切换 etcd 挂载并更新恢复身份'):
            self.guard_record('source', 'target')
            self.fstab_to(True)
            self.mount_to(self.j['target'], self.j['target_disk'])
            self.host.helper('reconcile', self.j)
        # Critical write-ahead boundary. Even a failure of rename/fsync afterwards
        # must never cause an old, stale directory to become authoritative.
        with progress('提交新副本写入状态并恢复 etcd manifest'):
            self.persist('starting', may_write=True)
            self.guard_record('target')
            self.manifest_in()
        self.finish()

    def recover(self):
        """Before write boundary abort safely; after it only start the new copy."""
        require(self.j['phase'] not in ('complete', 'aborted'), '事务已经完成')
        if self.j['may_write']:
            # The running etcd might already have written. Do NOT stop/copy or
            # fall back to the old data when merely retrying acceptance checks.
            with progress('恢复已提交的新副本配置与 manifest'):
                self.host.same_mount(self.j['target'])
                self.host.active_identity(self.j['target_identity'], self.j['target_disk'])
                self.fstab_to(True)
                self.host.helper('reconcile', self.j)
                self.guard_record('target')
                self.manifest_in()
            self.finish()
        else:
            log('尚未允许新副本写入，恢复原始活动目录。')
            if self.j['phase'] in ('prepared', 'stopping'):
                # A kubelet stop timeout is not permission to leave its manifest
                # missing forever. No copy/mount/identity changes happened yet.
                with progress('恢复暂停前的 etcd manifest'):
                    self.host.same_mount(self.j['source'])
                    require(FSTAB.read_bytes() == (Path(self.j['run']) / 'fstab.before').read_bytes(), 'fstab 在暂停阶段被修改')
                    self.guard_record('source')
                    self.manifest_in()
                with progress('等待原 etcd 恢复健康'):
                    wait_for(lambda: self.host.health(self.j), 180, '恢复原 manifest 后 etcd 未就绪，请运行 resume')
                self.persist('aborted')
                return
            self.manifest_out()
            with progress('恢复原活动挂载、恢复身份与 manifest'):
                self.guard_record(*(['source', 'target'] if 'target_identity' in self.j else ['source']))
                self.fstab_to(False)
                self.mount_to(self.j['source'], self.j['source_disk'])
                self.host.helper('reconcile', self.j)
                self.guard_record('source')
                self.manifest_in()
            with progress('等待原 etcd 恢复健康'):
                wait_for(lambda: self.host.health(self.j), 180, '原 etcd 未恢复健康；保留记录，请运行 resume')
            self.persist('aborted')
            log('已回到本事务开始前的数据，失败副本和备份保留。')

    def execute(self, facts):
        self.prepare(facts)
        try:
            self.switch()
        except (Exception, KeyboardInterrupt):
            if not self.j['may_write']:
                try:
                    self.recover()
                except (Exception, KeyboardInterrupt):
                    log('自动恢复未完成；请运行 etcd status / etcd resume。不要手动挂回历史目录。')
            else:
                log('新副本可能已写入；已保留它作为权威数据。请运行 etcd status / etcd resume，禁止直接挂回旧目录。')
            raise


@contextlib.contextmanager
def locks():
    paths = [Path('/run/mx-move-etcd.lock'), Path('/run/mx-launcher-deploy.lock')]
    hub = Path(__file__).resolve().parents[3] / 'mx-insight-hub/.runtime'
    if hub.is_dir():
        paths.append(hub / 'internal-production-deploy.flock')
    fds = []
    try:
        for p in paths:
            safe_path(p)
            fd = os.open(str(p), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            fds.append(fd)
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise Refuse('迁移/Launcher/Hub 发布正在执行，请稍后重试')
        yield
    finally:
        for fd in fds:
            os.close(fd)


def main(argv=None):
    parser = argparse.ArgumentParser(description='mx-move：保留所有原数据的单节点 etcd 迁移')
    parser.add_argument('component', choices=['etcd'])
    parser.add_argument('action', choices=['plan', 'migrate', 'rollback', 'status', 'resume'])
    parser.add_argument('--target-root', default=str(STATE / 'etcd-data'), help='迁移目标父目录；必须在独立根盘上')
    args = parser.parse_args(argv)
    if args.action not in ('plan', 'migrate'):
        require(args.target_root == str(STATE / 'etcd-data'), '此操作不接受 --target-root')
    host, move = Host(), None
    move = Move(host)
    require(sys.platform.startswith('linux') and os.geteuid() == 0, '请在 Internal 控制平面 Linux 主机以 root 执行')
    os.umask(0o077)
    if args.action == 'status':
        j = move.load()
        # Do not output any secret backup, manifest or credentials.
        print(json.dumps({k: j.get(k) for k in ['direction', 'phase', 'may_write', 'source', 'target', 'origin', 'run', 'changed_business_containers']}, ensure_ascii=False, indent=2))
        return
    if args.action == 'plan':
        with progress('只读检查迁移条件'):
            facts = move.plan('migrate', args.target_root)
        print(json.dumps(facts, ensure_ascii=False, indent=2))
        return
    with locks():
        if args.action == 'resume':
            with progress('读取中断事务并核对容器运行时'):
                move.load()
                host.runtime()
                require(host.endpoint == move.j['endpoint'], 'CRI endpoint 已变化，拒绝恢复')
            if move.j['phase'] in ('complete', 'aborted'):
                log('事务已结束；无需 resume。')
            else:
                move.recover()
        else:
            with progress('检查迁移条件' if args.action == 'migrate' else '检查回滚条件'):
                facts = move.plan(args.action, args.target_root)
            log('{}: {} → {}，预留空间 {} GiB。'.format(args.action, facts['source'], facts['target_root'], facts['space']['reserve_gib']))
            move.execute(facts)


if __name__ == '__main__':
    def interrupted(signum, frame):
        raise KeyboardInterrupt('signal')
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGHUP, interrupted)
    try:
        main()
    except (Refuse, OSError, ValueError, KeyError, KeyboardInterrupt) as exc:
        # No raw subprocess output or file contents in errors.
        log('停止：' + (str(exc) if isinstance(exc, Refuse) else type(exc).__name__ + '；检查本机状态和事务记录'))
        sys.exit(1)
