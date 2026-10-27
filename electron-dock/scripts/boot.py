#!/usr/bin/env python3
"""Audit the existing Internal installation; never deploy or repair it (Python 3.6+)."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import sys
import time

ACTIVE = Path('/etc/mx-k8s-runtime/active.json')
RESOLVER = Path('/usr/local/lib/mx-k8s-runtime/resolve.py')
STORAGE_GUARD = Path('/usr/local/lib/mx-k8s-runtime/storage_guard.py')
ETCD_GUARD = Path('/var/lib/mx-move/boot-guard.py')
ETCD_RECORD = Path('/var/lib/mx-move/active-etcd.json')
CHECKPOINT = Path('/var/lib/mx-launcher-recovery/latest.json')
OPERATIONS = Path('/var/lib/mx-service-operations/operations')
INSTALL = Path('/usr/local/lib/mx-boot')
UNIT = Path('/etc/systemd/system/mx-boot-verify.service')
SOURCE = Path(__file__).resolve().parent
DEADLINE = None
NAMESPACES = ('mx-internal-shadow', 'mx-common', 'mx-insight-hub', 'mx-harbor', 'mx-pay')
REQUIRED = {
    'mx-internal-shadow': {'mx-internal-postgres', 'mx-launcher-internal', 'mx-identity', 'mx-identity-public', 'mx-internal-gateway'},
    'mx-common': {'mx-common-postgres', 'mx-common-elasticsearch', 'mx-common-redis', 'mx-common-hanlp'},
    'mx-insight-hub': {'mx-insight-hub-' + name for name in ('admin', 'public', 'ingest', 'projector', 'classifier', 'retrieval')},
    'mx-harbor': {'mx-harbor'}, 'mx-pay': {'mx-pay-postgres', 'mx-pay', 'mx-pay-console'},
}


class Refuse(Exception):
    pass


class Pending(Refuse):
    pass


def say(value):
    print('[mx-boot] ' + value, flush=True)


def run(args, env, timeout=15):
    if DEADLINE is not None:
        timeout = min(timeout, DEADLINE - time.monotonic())
        if timeout <= 0:
            raise Pending('启动验收总等待时间已到')
    try:
        result = subprocess.run(args, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                universal_newlines=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        raise Pending('命令不可用或超时：' + Path(args[0]).name)
    if result.returncode:
        raise Pending('命令检查未通过：' + Path(args[0]).name + '（原始输出隐藏）')
    return result.stdout.strip()


def read_json(path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        raise Refuse('原安装记录缺失或格式无效；未创建替代身份')


def protected(path, allow_missing=False):
    """Installation files and helpers must not be writable through an untrusted parent."""
    for part in reversed((path,) + tuple(path.parents)):
        if allow_missing and not part.exists() and not part.is_symlink():
            continue
        info = part.lstat()
        if part.is_symlink() or info.st_uid != 0 or info.st_mode & 0o022:
            raise Refuse('原安装文件或安装路径权限不安全')


def service_name(value):
    if not re.fullmatch(r'[a-zA-Z0-9_.@-]+\.service', value):
        raise Refuse('服务名称必须是已有的 systemd .service 名称')
    return value


def unit_state(name, env):
    raw = run(['systemctl', 'show', name, '--no-pager',
               '--property=LoadState,ActiveState,UnitFileState,FragmentPath,ExecStartPre,Requires,After,RequiresMountsFor'], env)
    return dict(line.split('=', 1) for line in raw.splitlines() if '=' in line)


def host_audit(env, require_enabled):
    for path in (ACTIVE, RESOLVER, STORAGE_GUARD, ETCD_GUARD, ETCD_RECORD, CHECKPOINT):
        protected(path)
    active = read_json(ACTIVE)
    if active.get('phase') != 'active' or active.get('service') != 'mx-k8s-containerd.service':
        raise Refuse('仅支持已激活的 Internal 独立 Kubernetes runtime')
    runtime = run([sys.executable, '-I', str(RESOLVER), 'service', '--allow-stopped-kubelet'], env)
    if runtime != 'mx-k8s-containerd.service':
        raise Refuse('运行时解析与原安装不一致；未选择备用 runtime')
    run([sys.executable, '-I', str(STORAGE_GUARD)], env)
    run([sys.executable, '-I', str(ETCD_GUARD), '--record', str(ETCD_RECORD)], env)
    names = [runtime, 'kubelet.service', service_name(env.get('MX_HOST_PG_SERVICE', 'postgresql-16.service')),
             'mx-internal-host-runner.service', 'nginx.service']
    if env.get('MX_PROXY_SERVICE'):
        names.append(service_name(env['MX_PROXY_SERVICE']))
    else:
        # A proxy is not a prerequisite for cached Kubernetes workloads.
        for candidate in ('mihomo.service', 'mihomo-client.service', 'mx-internal-egress.service'):
            state = unit_state(candidate, env)
            if state.get('LoadState') == 'loaded' and state.get('ActiveState') == 'active':
                names.append(candidate)
    units = {}
    for name in dict.fromkeys(names):
        state = unit_state(name, env)
        if state.get('LoadState') != 'loaded' or not state.get('FragmentPath'):
            raise Refuse('必需的原服务未安装：' + name)
        protected(Path(state['FragmentPath']))
        units[name] = state
        say('{} active={} enabled={}'.format(name, state.get('ActiveState'), state.get('UnitFileState')))
        if state.get('ActiveState') != 'active':
            raise Pending('原服务尚未运行：' + name + '；未自动启动或重启')
        if state.get('UnitFileState') not in ('enabled', 'enabled-runtime', 'disabled'):
            raise Refuse('原服务不是可确认的持久 enable 目标：' + name)
        if require_enabled and state.get('UnitFileState') != 'enabled':
            raise Refuse('原服务尚未持久 enable：' + name)
    kubelet = units['kubelet.service']
    if (str(STORAGE_GUARD) not in kubelet.get('ExecStartPre', '') or
            str(ETCD_GUARD) not in kubelet.get('ExecStartPre', '') or
            runtime not in kubelet.get('Requires', '').split() or runtime not in kubelet.get('After', '').split() or
            '/var/lib/etcd' not in kubelet.get('RequiresMountsFor', '').split() or
            str(STORAGE_GUARD) not in units[runtime].get('ExecStartPre', '')):
        raise Refuse('现有 kubelet/runtime 的有效挂载保护或启动依赖缺失；未覆盖原 unit')
    return active, units


def kube(args, env):
    return run(['kubectl', '--kubeconfig=/etc/kubernetes/admin.conf', '--request-timeout=10s'] + args, env)


def unresolved_operations(env):
    directories = [OPERATIONS, Path(env.get('MX_MANAGE_STATE_DIR', str(Path.home() / '.local/state/mx-electron-dock')))]
    for directory in directories:
        if directory.exists():
            for path in directory.glob('*.json'):
                record = read_json(path)
                if (record.get('status') in ('queued', 'running', 'needs_reconciliation') or
                        record.get('phase') in ('preflight', 'running') or
                        (record.get('phase') == 'child_succeeded' and not record.get('finishedAt'))):
                    raise Refuse('存在未完成或待核对的运维记录；未重放任务')


def cluster_audit(active, env):
    if 'readyz check passed' not in kube(['get', '--raw=/readyz?verbose'], env):
        raise Pending('控制面/etcd 尚未就绪')
    uid = kube(['get', 'namespace', 'kube-system', '-o', 'jsonpath={.metadata.uid}'], env)
    if not uid or uid != read_json(CHECKPOINT).get('clusterUid'):
        raise Refuse('当前集群与 Launcher 保留检查点不同')
    nodes = json.loads(kube(['get', 'nodes', '-o', 'json'], env)).get('items', [])
    if len(nodes) != 1 or nodes[0]['metadata']['name'] != active.get('hostname'):
        raise Refuse('当前节点与原单节点 Internal 不一致')
    conditions = {item['type']: item['status'] for item in nodes[0].get('status', {}).get('conditions', [])}
    if conditions.get('Ready') != 'True' or any(conditions.get(key) != 'False' for key in ('MemoryPressure', 'DiskPressure', 'PIDPressure')):
        raise Pending('节点尚未就绪或存在资源压力')
    unresolved_operations(env)
    missing_images = set()
    identity_host = None
    for namespace in NAMESPACES:
        objects = json.loads(kube(['-n', namespace, 'get', 'deployment,statefulset,daemonset,job,configmap', '-o', 'json'], env))['items']
        found = set()
        for obj in objects:
            kind, name = obj['kind'], obj['metadata']['name']
            status, spec = obj.get('status', {}), obj.get('spec', {})
            if kind == 'ConfigMap':
                if name.endswith('-deploy-lock'):
                    raise Refuse(namespace + ' 存在部署锁；保留原锁并等待核对')
                continue
            if kind == 'Job':
                terminal = any(c.get('type') in ('Complete', 'Failed') and c.get('status') == 'True' for c in status.get('conditions', []))
                if not terminal and ('migrat' in name or 'init' in name):
                    raise Refuse(namespace + ' 存在未确认完成的迁移/初始化 Job；未重放')
                continue
            if name not in REQUIRED[namespace]:
                say(namespace + '/' + name + ' 保留；不属于本次开机纳管工作负载')
                continue
            found.add(name)
            desired = status.get('desiredNumberScheduled', 0) if kind == 'DaemonSet' else spec.get('replicas', 1)
            if desired == 0:
                raise Refuse(namespace + '/' + name + ' desired=0；维护暂停或中断部署意图待核对，未 scale')
            ready = status.get('numberReady', 0) if kind == 'DaemonSet' else status.get('readyReplicas', 0)
            if status.get('observedGeneration', 0) < obj['metadata'].get('generation', 1) or ready < desired:
                raise Pending(namespace + '/' + name + ' 尚未达到原期望副本数')
            pod = spec.get('template', {}).get('spec', {})
            for container in pod.get('containers', []) + pod.get('initContainers', []):
                if container.get('imagePullPolicy') == 'Never':
                    missing_images.add(container['image'])
                if namespace == 'mx-internal-shadow' and name == 'mx-identity-public':
                    headers = container.get('readinessProbe', {}).get('httpGet', {}).get('httpHeaders', [])
                    identity_host = next((h.get('value') for h in headers if h.get('name', '').lower() == 'host'), None)
        if not REQUIRED[namespace] <= found:
            raise Refuse(namespace + ' 缺少必需的原工作负载；未套用仓库清单')
    endpoint = run([sys.executable, '-I', str(RESOLVER), 'cri-endpoint'], env)
    images = json.loads(run(['crictl', '--runtime-endpoint', endpoint, '--image-endpoint', endpoint, 'images', '-o', 'json'], env))['images']
    cached = set(image_ref(ref) for row in images for ref in (row.get('repoTags', []) + row.get('repoDigests', [])))
    if {image_ref(ref) for ref in missing_images} - cached:
        raise Refuse('原 Kubernetes runtime 缺少 Never 镜像；需显式修复制品，未构建或拉取')
    if not identity_host or not re.fullmatch(r'[A-Za-z0-9.-]+(?::[0-9]+)?', identity_host):
        raise Refuse('公网身份工作负载缺少可验证的原 Host 探针')
    return identity_host


def image_ref(value):
    first = value.split('/')[0]
    if '/' not in value or ('.' not in first and ':' not in first and first != 'localhost'):
        value = 'docker.io/' + value
    if value.startswith('docker.io/') and value.count('/') == 1:
        value = 'docker.io/library/' + value[len('docker.io/'):]
    return value


def readiness():
    spec = importlib.util.spec_from_file_location('mx_boot_readiness', str(SOURCE / 'readiness.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def verify(env, require_enabled=True, wait=True):
    global DEADLINE
    try:
        timeout = int(env.get('MX_WAIT_TIMEOUT', '300')) if wait else 60
        interval = int(env.get('MX_WAIT_INTERVAL', '5'))
        if not 1 <= timeout <= 3600 or not 1 <= interval <= 60:
            raise ValueError()
    except ValueError:
        raise Refuse('等待时间必须为 1–3600 秒，间隔必须为 1–60 秒')
    deadline = time.monotonic() + timeout
    DEADLINE = deadline
    helper = readiness()
    while True:
        try:
            active, units = host_audit(env, require_enabled)
            identity_host = cluster_audit(active, env)
            for check in (helper.wait_host_postgres, helper.wait_hanlp):
                if time.monotonic() >= deadline:
                    raise Pending('启动验收总等待时间已到')
                check(env, timeout=deadline - time.monotonic())
            for url in ('http://127.0.0.1:18090/healthz', 'http://127.0.0.1:18151/health/ready',
                        'http://127.0.0.1:18220/ready'):
                run(['curl', '-q', '--noproxy', '*', '--fail', '--silent', '--max-time', '5', '--output', '/dev/null', url], env, 7)
            run(['curl', '-q', '--noproxy', '*', '--fail', '--silent', '--max-time', '5', '--output', '/dev/null',
                 '--header', 'Host: ' + identity_host, 'http://10.88.88.88:18444/healthz'], env, 7)
            say('原运行时、工作负载、PG、HanLP 与本机入口检查通过；真实用户登录/联网仍需验收')
            DEADLINE = None
            return units
        except (Pending, helper.ReadinessError) as error:
            if not wait or time.monotonic() >= deadline:
                raise Refuse(str(error))
            say(str(error) + '；只读等待，不执行恢复写入')
            time.sleep(min(interval, max(0, deadline - time.monotonic())))


def install(env):
    units = verify(env, require_enabled=False, wait=False)
    protected(INSTALL, allow_missing=True)
    protected(UNIT, allow_missing=True)
    receipt = INSTALL / 'unit.json'
    protected(receipt, allow_missing=True)
    if UNIT.exists() and (not receipt.exists() or read_json(receipt).get('unit') != UNIT.read_text()):
        raise Refuse('同名验收 unit 不属于已记录安装；未覆盖')
    files = {name: (SOURCE / name).read_bytes() for name in ('boot.py', 'readiness.py')}
    digest = hashlib.sha256(files['boot.py'] + files['readiness.py']).hexdigest()
    release = INSTALL / 'releases' / digest
    protected(release, allow_missing=True)
    release.mkdir(parents=True, exist_ok=True, mode=0o755)
    for name, data in files.items():
        target = release / name
        protected(target, allow_missing=True)
        if target.exists() and target.read_bytes() != data:
            raise Refuse('已安装版本内容被修改；未覆盖')
        if not target.exists():
            target.write_bytes(data)
            target.chmod(0o644)
    python = Path('/usr/bin/python3').resolve()
    protected(python)
    proxy_environment = 'Environment=MX_PROXY_SERVICE={}\n'.format(service_name(env['MX_PROXY_SERVICE'])) if env.get('MX_PROXY_SERVICE') else ''
    unit = ('# Managed by electron-dock boot install\n[Unit]\nDescription=Verify existing MX Internal startup\n'
            'After=network-online.target kubelet.service\nWants=network-online.target\n\n[Service]\nType=oneshot\n'
            'Environment=MX_HOST_PG_SERVICE={}\nEnvironment=MX_WAIT_TIMEOUT=900\n{}'
            'ExecStart={} -I {}/boot.py verify\nTimeoutStartSec=960\nUMask=0077\n\n[Install]\nWantedBy=multi-user.target\n').format(
                service_name(env.get('MX_HOST_PG_SERVICE', 'postgresql-16.service')), proxy_environment, python, release)
    temporary = UNIT.with_name(UNIT.name + '.tmp')
    protected(temporary, allow_missing=True)
    with temporary.open('x') as stream:
        stream.write(unit)
    temporary.chmod(0o644)
    os.replace(str(temporary), str(UNIT))
    receipt.write_text(json.dumps({'unit': unit}))
    receipt.chmod(0o600)
    run(['systemctl', 'daemon-reload'], env)
    for name in list(units) + [UNIT.name]:
        before = units[name].get('UnitFileState') if name in units else unit_state(name, env).get('UnitFileState')
        try:
            if before != 'enabled':
                run(['systemctl', 'enable', name], env)
            after = unit_state(name, env).get('UnitFileState')
            say('{} enable: {} -> {}'.format(name, before, after))
            if after != 'enabled':
                raise Refuse('持久 enable 未确认')
        except Refuse:
            say('部分安装可能已完成；保留上方逐项结果，不回滚、不启动或重启服务')
            raise
    say('开机验收已安装并 enable；本次未启动验收服务或任何业务服务')


def main(args):
    if len(args) != 1 or args[0] not in ('audit', 'install', 'verify'):
        raise Refuse('用法：boot audit|install|verify（仅已有 Internal 安装）')
    if platform.system() != 'Linux' or os.geteuid() != 0:
        raise Refuse('仅在原 Internal Linux 主机以 root 执行；未访问集群')
    env = os.environ.copy()
    for key in ('CONTEXT', 'KUBE_CONTEXT', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'):
        env.pop(key, None)
    env['KUBECONFIG'] = '/etc/kubernetes/admin.conf'
    if args[0] == 'install':
        install(env)
    else:
        units = verify(env, require_enabled=args[0] == 'verify', wait=args[0] == 'verify')
        disabled = [name for name, state in units.items() if state.get('UnitFileState') != 'enabled']
        if disabled:
            raise Refuse('原服务尚未持久 enable：' + ', '.join(disabled))


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except (Refuse, OSError, ValueError, KeyError, TypeError, AttributeError) as error:
        say(str(error) if isinstance(error, Refuse) else '检查无法完成；文件/响应不可用，原始信息隐藏')
        sys.exit(1)
