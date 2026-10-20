#!/usr/bin/env python3
"""Install and verify an isolated candidate; never redirect the live kubelet.

The candidate has no workloads. This is not the database/mount cutover. Its
systemd service is deliberately not enabled and active.json is not published.
"""
import argparse
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import stat
import subprocess
import sys
import tarfile
import time
import uuid

import candidate_guard as guard
import runtime_prepare as prep
import runtime_check as probe
from inventory import InspectionError, stage

DIRECTORY = Path('/etc/mx-k8s-runtime')
HELPERS = Path('/usr/local/lib/mx-k8s-runtime')
ACTIVE = DIRECTORY / 'active.json'
RECORD = DIRECTORY / 'candidate.json'
SERVICE = guard.SERVICE
UNIT = Path(guard.UNIT)
ADDRESS, STATE = prep.NEW_ADDRESS, prep.NEW_STATE
PREPARED_PATTERN = r'/var/lib/mx-move/k8s-runtime-prep/mx-k8s-[0-9]{8}-[0-9]{6}-[a-f0-9]{8}'
PROXY_KEYS = frozenset(('HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
                        'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
                        'SSL_CERT_FILE', 'SSL_CERT_DIR'))


def require(ok, message):
    prep.require(ok, message)


def read_private(path):
    guard.safe(str(path), private=True)
    return path.read_bytes()


def public_directory(path):
    prep.secure_directory(str(path.parent))
    try:
        path.mkdir(mode=0o755)
        # main uses umask 077; expose only this newly created public directory.
        path.chmod(0o755)
        prep.sync_directory(path.parent)
    except FileExistsError:
        pass
    value = guard.safe(str(path), directory=True)
    require(stat.S_IMODE(value.st_mode) == 0o755, '运行时描述/工具目录必须为 root:root 0755，以便调用者识别迁移标记')
    return path


def install_file(path, data, mode):
    """Create a protected file, or reuse only exactly identical owned bytes."""
    if path.exists() or path.is_symlink():
        value = guard.safe(str(path), private=mode == 0o600)
        require(stat.S_IMODE(value.st_mode) == mode and path.read_bytes() == data,
                '已有候选运行时文件内容或权限不匹配，拒绝覆盖')
        return
    fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    # umask is 077; explicitly expose only non-sensitive installed programs/unit.
    os.chmod(str(path), mode)
    prep.sync_directory(path.parent)


def environment_file(raw):
    """Project effective /proc/PID/environ proxy/trust settings, never values in logs.

    systemctl's Environment property omits EnvironmentFile and may describe
    settings changed after the running daemon started. Use its actual process.
    """
    values = {}
    require(isinstance(raw, bytes) and raw.endswith(b'\0'), '运行时有效环境格式不受支持')
    for pair in raw.rstrip(b'\0').split(b'\0'):
        key_raw, separator, value_raw = pair.partition(b'=')
        require(separator, '运行时有效环境格式不受支持')
        key = key_raw.decode('ascii', errors='replace')
        if key not in PROXY_KEYS:
            continue
        value = value_raw.decode('utf-8')
        require(key not in values and not re.search(r'[\x00-\x1f\x7f]', value), '原运行时环境存在重复或控制字符')
        values[key] = value
    # EnvironmentFile values have no shell or specifier expansion.
    return ''.join('{}="{}"\n'.format(k, v.replace('\\', '\\\\').replace('"', '\\"'))
                   for k, v in sorted(values.items())).encode('utf-8')


def unit_text(binary, python, config, data):
    for value in (binary, python, config, data):
        require(re.fullmatch(r'/[A-Za-z0-9_./-]+', value), 'systemd 配置路径含不支持的字符')
    return ('''[Unit]
Description=MX Kubernetes isolated containerd (candidate until explicit cutover)
After=network.target
RequiresMountsFor={data}

[Service]
Type=notify
EnvironmentFile=/etc/mx-k8s-runtime/environment
ExecStartPre={python} /usr/local/lib/mx-k8s-runtime/candidate_guard.py
ExecStart={binary} --config {config}
Delegate=yes
KillMode=process
Restart=always
RestartSec=5
LimitNOFILE=1048576
LimitNPROC=infinity
LimitCORE=infinity
TasksMax=infinity
TimeoutStartSec=90

[Install]
WantedBy=multi-user.target
'''.format(binary=binary, python=python, config=config, data=data)).encode()


def cri_images(raw):
    """Only image IDs and references, no image config/environment/credentials."""
    result = {}
    for image in json.loads(raw)['images']:
        image_id = image['id']
        require(isinstance(image_id, str) and re.fullmatch(r'sha256:[a-f0-9]{64}', image_id), 'CRI 镜像标识不受支持')
        tags, digests = image.get('repoTags') or [], image.get('repoDigests') or []
        require(isinstance(tags, list) and isinstance(digests, list) and
                all(isinstance(v, str) and re.fullmatch(r'[A-Za-z0-9._:/@+-]+', v) for v in tags + digests),
                'CRI 镜像引用格式不受支持')
        require(image_id not in result, 'CRI 镜像列表重复')
        result[image_id] = {'tags': sorted(set(tags)), 'digests': sorted(set(digests))}
    require(result, 'CRI 镜像列表为空')
    return result


def images_cover(candidate, source):
    return all(key in candidate and all(set(value[field]) <= set(candidate[key][field])
               for field in ('tags', 'digests')) for key, value in source.items())


class Host(prep.Host):
    def command(self, args, timeout=60):
        try:
            result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    timeout=timeout, env=dict(os.environ, LC_ALL='C'))
            require(result.returncode == 0, '候选运行时命令失败（原始输出已隐藏）')
            return result.stdout.decode('utf-8')
        except (OSError, subprocess.TimeoutExpired, UnicodeError):
            raise prep.Refuse('候选运行时命令不可用或超时（原始输出已隐藏）') from None

    def facts(self):
        # The first preparation rejected NEW_STATE. Candidate installation owns
        # that path after its journal has been created; repeat all other checks.
        inspector = probe.RuntimeInspector()
        runtimes = {}
        for name in ('containerd', 'kubelet'):
            service = inspector.service(name)
            require(service.get('ActiveState') == 'active', '原运行时和 kubelet 必须正在运行')
            runtimes[name] = inspector.process(name, service)
            runtimes[name]['pid'] = service['MainPID']
        require(not inspector.errors, '原运行时信息读取不完整；请用 runtime-check 检查')
        runtime = runtimes['containerd']
        require(runtime['version'] == '1.6.32', '本工具仅核验了现场 containerd 1.6.32')
        old_socket = probe.socket_identity(runtime['address'])
        require(probe.same_socket(old_socket, probe.socket_identity(runtimes['kubelet']['address'])) is True,
                'kubelet 已不再使用原共享运行时，拒绝按候选安装流程继续')
        args = ['/proc/' + runtime['pid'] + '/exe']
        for key, value in sorted(runtime['flags'].items()):
            args += ['--' + key, value]
        return {'runtime': runtimes, 'socket': old_socket,
                'dump': self.run(args + ['config', 'dump'])}

    def cri(self, address, *args):
        return self.command(['crictl', '--runtime-endpoint=unix://' + address,
                             '--image-endpoint=unix://' + address, '--timeout=20s'] + list(args), 30)

    def image_state(self, address):
        return cri_images(self.cri(address, 'images', '-o', 'json'))

    def environment(self, pid):
        require(str(pid).isdigit() and int(pid) > 0, '运行时 PID 无效')
        return environment_file(Path('/proc/' + str(pid) + '/environ').read_bytes())

    def ready(self, record):
        guard.verify()
        service = probe.RuntimeInspector().service('mx-k8s-containerd')
        require(service.get('ActiveState') == 'active' and str(service.get('MainPID', '')).isdigit(), '候选运行时未运行')
        pid = service['MainPID']
        require(os.readlink('/proc/' + pid + '/exe') == record['binary_path'], '候选运行时二进制不匹配')
        require(hashlib.sha256(self.environment(pid)).hexdigest() == record['environment_sha256'],
                '候选实例有效代理/信任环境与原实例不匹配（值已隐藏）')
        args = Path('/proc/' + pid + '/cmdline').read_bytes().decode().rstrip('\0').split('\0')
        flags = probe.canonical_flags(args, {'--config': 'config', '-c': 'config', '--root': 'root',
                    '--state': 'state', '--address': 'address', '-a': 'address'})
        require(flags == {'config': record['config_path']}, '候选运行时出现未记录的路径覆盖')
        target = probe.socket_identity(ADDRESS)
        require(target['is_socket'] and probe.same_socket(target, probe.socket_identity(record['source_address'])) is False,
                '新旧运行时 socket 未隔离')
        info = json.loads(self.cri(ADDRESS, 'info'))
        conditions = info.get('status', {}).get('conditions', [])
        require(any(c.get('type') == 'RuntimeReady' and c.get('status') is True for c in conditions), '候选 CRI 未就绪')
        require(probe.tasks_summary(self.command(['ctr', '--address', ADDRESS, '--namespace', 'k8s.io', 'tasks', 'list']))['total'] == 0 and
                not self.cri(ADDRESS, 'pods', '-q').strip() and not self.cri(ADDRESS, 'ps', '-a', '-q').strip(),
                '候选实例已有工作负载，拒绝继续预导入流程')
        return target


class Install:
    def __init__(self, host):
        self.host, self.record, self.previous = host, None, None

    def persist(self, **values):
        require(not RECORD.is_symlink(), '候选记录不能是符号链接')
        if self.previous is not None:
            require(read_private(RECORD) == self.previous, '候选记录被其他操作修改，拒绝覆盖')
        else:
            require(not RECORD.exists(), '已有候选记录，拒绝覆盖')
        self.record.update(values)
        raw = json.dumps(self.record, ensure_ascii=False, indent=2).encode()
        temporary = DIRECTORY / ('.candidate-' + uuid.uuid4().hex)
        prep.save_private(temporary, raw)
        os.replace(str(temporary), str(RECORD))
        prep.sync_directory(DIRECTORY)
        self.previous = raw

    def execute(self, prepared):
        require(not os.path.lexists(str(ACTIVE)), '已有生效运行时描述，不能再按候选流程操作')
        require(re.fullmatch(PREPARED_PATTERN, str(prepared)),
                '请选择 prepare-runtime 生成的原始默认预备目录')
        stage('校验现有归档、运行时和配置；不切换 kubelet')
        receipt_raw = read_private(prepared / 'prepared.json')
        receipt = json.loads(receipt_raw)
        require(receipt['schema_version'] == 1 and receipt['phase'] == 'artifacts-prepared' and
                receipt['host'] == socket.gethostname() and receipt['source_version'] == '1.6.32' and
                receipt['target']['root'] == str(prepared / 'data') and
                receipt['target']['state'] == STATE and receipt['target']['address'] == ADDRESS,
                '预备回执与本机/候选路径不匹配')
        config = prepared / 'containerd.toml'
        require(hashlib.sha256(read_private(config)).hexdigest() == receipt['config_sha256'], '预备配置已改变')
        images = json.loads(read_private(prepared / 'images.json'))
        require(isinstance(images, list) and len(images) == receipt['image_count'], '预备镜像清单不匹配')
        archive = prepared / 'k8s-images.tar'
        guard.safe(str(archive), private=True)
        with prep.progress('重新核对归档摘要及本机平台内容'):
            require(archive.stat().st_size == receipt['archive']['bytes'] and
                    prep.sha256_file(archive) == receipt['archive']['sha256'], '归档大小或摘要不匹配')
            prep.verify_archive(archive, [i['digest'] for i in images], receipt['platform'])
        before = self.host.facts()
        runtime = before['runtime']['containerd']
        require(before['socket'] == receipt['source_socket'] and runtime['config_dump']['root'] == receipt['source_root'] and
                hashlib.sha256(before['dump'].encode()).hexdigest() == receipt['source_config_sha256'],
                '原运行时身份或配置自预备后改变，拒绝使用未复核的预备')
        require(self.host.images(runtime['address']) == images, '原镜像引用集合自预备后改变，不能直接使用该归档')
        source_cri = self.host.image_state(runtime['address'])
        binary = os.path.realpath(runtime['executable'])
        python = os.path.realpath(sys.executable)
        guard.safe(binary)
        guard.safe(python)
        self.host.validate_config('/proc/' + runtime['pid'] + '/exe', config, receipt['target'])
        env = self.host.environment(runtime['pid'])
        unit = unit_text(binary, python, str(config), str(prepared / 'data'))
        helper_files = {'candidate_guard.py': Path(__file__).with_name('candidate_guard.py').read_bytes(),
                        'resolve.py': Path(__file__).with_name('runtime_resolver.py').read_bytes()}
        # Require substantial room before unpack; continuously preserve 100 GiB
        # below. Compressed archive size cannot prove final unpack capacity.
        require(prep.available(prepared) > prep.RESERVE + receipt['archive']['bytes'], '根卷余量不足以开始候选镜像导入')
        public_directory(DIRECTORY)
        public_directory(HELPERS)
        if RECORD.exists() or RECORD.is_symlink():
            self.previous = read_private(RECORD)
            self.record = json.loads(self.previous)
            require(self.record['prepared_directory'] == str(prepared) and
                    self.record['prepared_sha256'] == hashlib.sha256(receipt_raw).hexdigest() and
                    self.record['phase'] in ('allocating', 'starting', 'importing', 'ready'), '已有其他或无法恢复的候选事务')
        else:
            status = self.host.command(['systemctl', 'show', SERVICE, '-p', 'LoadState', '-p', 'FragmentPath'])
            values = dict(v.split('=', 1) for v in status.splitlines() if '=' in v)
            require(values.get('LoadState') == 'not-found' and not values.get('FragmentPath') and
                    not UNIT.exists() and not UNIT.is_symlink() and not os.path.lexists(STATE) and
                    not (prepared / 'data').exists() and not (prepared / 'data').is_symlink(), '候选服务或数据路径已有未受管内容，拒绝覆盖')
            self.record = {'schema_version': 1, 'phase': 'allocating', 'hostname': socket.gethostname(),
                'prepared_directory': str(prepared), 'prepared_sha256': hashlib.sha256(receipt_raw).hexdigest(),
                'root': str(prepared / 'data'), 'root_identity': None, 'state': STATE, 'address': ADDRESS,
                'service': SERVICE, 'filesystem_uuid': receipt['target_filesystem_uuid'],
                'config_path': str(config), 'config_sha256': receipt['config_sha256'],
                'binary_path': binary, 'binary_sha256': prep.sha256_file(Path(binary)),
                'environment_path': str(DIRECTORY / 'environment'), 'environment_sha256': hashlib.sha256(env).hexdigest(),
                'unit_path': str(UNIT), 'unit_sha256': hashlib.sha256(unit).hexdigest(),
                'guard_path': str(HELPERS / 'candidate_guard.py'), 'guard_sha256': hashlib.sha256(helper_files['candidate_guard.py']).hexdigest(),
                'source_address': runtime['address'], 'source_socket': before['socket'],
                'created_at_utc': datetime.datetime.utcnow().isoformat() + 'Z'}
            self.persist()
        for actual, expected in ((hashlib.sha256(env).hexdigest(), self.record['environment_sha256']),
                                 (hashlib.sha256(unit).hexdigest(), self.record['unit_sha256']),
                                 (hashlib.sha256(helper_files['candidate_guard.py']).hexdigest(), self.record['guard_sha256']),
                                 (prep.sha256_file(Path(binary)), self.record['binary_sha256'])):
            require(actual == expected, '候选恢复前环境、工具、服务或二进制已改变')
        data = prepared / 'data'
        if self.record['phase'] == 'allocating':
            try:
                data.mkdir(mode=0o700)
            except FileExistsError:
                pass
            value = guard.safe(str(data), directory=True, private=True)
            require(not list(data.iterdir()), '未完成分配的候选目录非空，不能自动接管')
            prep.sync_directory(prepared)
            self.persist(root_identity={'device': value.st_dev, 'inode': value.st_ino}, phase='starting')
        for name, content in helper_files.items():
            install_file(HELPERS / name, content, 0o644)
        install_file(DIRECTORY / 'environment', env, 0o600)
        install_file(UNIT, unit, 0o644)
        self.host.command(['systemctl', 'daemon-reload'])
        guard.verify()
        require(self.host.command(['systemctl', 'show', SERVICE, '-p', 'UnitFileState', '--value']).strip() == 'disabled',
                '候选服务已被其他操作设置开机启动或状态异常，拒绝候选安装')
        stage('启动独立候选运行时；原 containerd、Docker、kubelet 继续运行')
        self.host.command(['systemctl', 'start', SERVICE], 120)
        self.host.ready(self.record)
        if self.record['phase'] != 'ready':
            self.persist(phase='importing')
            stage('向候选实例导入现有归档；不重新导出镜像')
            command = ['ctr', '--address', ADDRESS, '--namespace', 'k8s.io', 'images', 'import',
                       '--platform', receipt['platform'], '--snapshotter', 'overlayfs', str(archive)]
            self.import_images(command, prepared)
        stage('核对镜像引用、CRI 标识、源实例及空工作负载状态')
        imported = {v['name']: v['digest'] for v in self.host.images(ADDRESS)}
        require(all(imported.get(v['name']) == v['digest'] for v in images), '候选镜像引用/摘要不完整')
        visible = None
        for attempt in range(12):
            try:
                visible = self.host.image_state(ADDRESS)
                if images_cover(visible, source_cri):
                    break
            except prep.Refuse:
                pass
            time.sleep(2)
        require(visible is not None and images_cover(visible, source_cri), '候选 CRI 尚未完整识别原镜像标识及引用')
        candidate_socket = self.host.ready(self.record)
        after = self.host.facts()
        require(after == before and self.host.images(runtime['address']) == images and
                self.host.image_state(runtime['address']) == source_cri and self.host.environment(runtime['pid']) == env,
                '安装期间原运行时或镜像状态变化，需要复核；原服务未切换')
        require(not os.path.lexists(str(ACTIVE)), '安装期间出现生效描述，不能发布候选结果')
        self.persist(phase='ready', verified_at_utc=datetime.datetime.utcnow().isoformat() + 'Z',
                     candidate_socket=candidate_socket, image_count=len(images), cri_image_count=len(source_cri))
        return {'phase': 'candidate-ready', 'service': SERVICE, 'prepared_directory': str(prepared),
                'address': ADDRESS, 'image_count': len(images), 'cri_image_count': len(source_cri),
                'archive_sha256': receipt['archive']['sha256'], 'filesystem_uuid': receipt['target_filesystem_uuid'],
                'root_free_bytes': prep.available(prepared), 'candidate_workloads': 0,
                'kubelet_switched': False, 'docker_data_moved': False, 'database_data_moved': False,
                'active_descriptor_published': False, 'cutover_supported': False}

    def import_images(self, command, directory):
        """Bound only our ctr client; never kill the daemon or its old tasks."""
        with prep.progress('导入并解包 Kubernetes 镜像'), open(os.devnull, 'wb') as sink:
            child = subprocess.Popen(command, stdout=sink, stderr=sink, start_new_session=True)
            started = time.monotonic()
            try:
                while child.poll() is None:
                    require(prep.available(directory) > prep.RESERVE, '候选导入达到根卷预留边界；保留候选内容，原服务未切换')
                    require(time.monotonic() - started < 6 * 3600, '候选导入超过 6 小时；保留候选内容')
                    time.sleep(1)
                require(child.returncode == 0, '候选镜像导入失败；可用同一命令在核验后续跑，原始输出已隐藏')
                require(prep.available(directory) > prep.RESERVE, '候选导入完成后根卷余量不足；不能验收候选，原服务未切换')
            finally:
                prep.stop_child(child)


def main(argv=None):
    parser = argparse.ArgumentParser(description='安装隔离候选运行时并复用归档导入镜像；不切换 kubelet/数据库/挂载')
    parser.add_argument('--prepared', required=True, help='已成功的 prepare-runtime 私有目录')
    args = parser.parse_args(argv)
    require(sys.platform.startswith('linux') and os.geteuid() == 0, '请在 Internal Linux 主机以 root 执行')
    os.umask(0o077)
    prep.secure_directory('/var/lib/mx-move')
    lock_path = '/var/lib/mx-move/k8s-runtime-install.lock'
    fd = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'a') as lock:
        guard.safe(lock_path, private=True)
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise prep.Refuse('另一个候选安装正在执行') from None
        result = Install(Host()).execute(Path(args.prepared))
        print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print('[mx-move k8s] 候选安装已中断；候选文件保留，原服务未切换。', file=sys.stderr)
        sys.exit(130)
    except prep.Refuse as error:
        print('[mx-move k8s] ' + str(error), file=sys.stderr)
        sys.exit(1)
    except (InspectionError, guard.GuardError, OSError, ValueError, KeyError, TypeError,
            subprocess.TimeoutExpired, RecursionError, tarfile.TarError):
        print('[mx-move k8s] 候选安装未完成；原始输出已隐藏，原服务未切换，保留全部候选文件。', file=sys.stderr)
        sys.exit(1)
