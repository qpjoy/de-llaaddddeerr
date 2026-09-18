#!/usr/bin/env python3
"""Read-only admission check on the same host as the local Docker daemon."""
import csv
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys


def command(*args):
    return subprocess.check_output(args, universal_newlines=True, timeout=15).strip()


def top_pids(output):
    lines = output.splitlines()
    if not lines or 'PID' not in lines[0].split():
        return set()
    index = lines[0].split().index('PID')
    return {fields[index] for fields in (line.split() for line in lines[1:])
            if len(fields) > index and fields[index].isdigit()}


def process_container(pid):
    # New workers may appear after docker top. Verify exact Docker cgroup identity,
    # not executable names, parent PIDs, or a guessed association with the GPU.
    try:
        text = Path('/proc/{}/cgroup'.format(pid)).read_text()
    except OSError:
        return set()
    return set(re.findall(r'(?:/docker/|/docker-)([0-9a-f]{64})(?=/|\.scope(?:/|$)|$)', text, re.M))


def safe_label(value):
    return ''.join(c if c.isprintable() else '?' for c in str(value))[:200]


def container_description(c):
    config = c.get('Config') or {}
    labels = config.get('Labels') or {}
    service = labels.get('com.mx-base.app')
    if not service and labels.get('com.docker.compose.service'):
        service = '{}/{}'.format(labels.get('com.docker.compose.project', '?'), labels['com.docker.compose.service'])
    if not service and labels.get('io.kubernetes.pod.name'):
        service = '{}/{}'.format(labels.get('io.kubernetes.pod.namespace', '?'), labels['io.kubernetes.pod.name'])
    return '容器={} · 镜像={} · 服务={}'.format(
        safe_label(c['Name'].lstrip('/')), safe_label(config.get('Image', '未知')), safe_label(service or '未标注'))


def reserves_gpu(c, card):
    host = c.get('HostConfig') or {}
    requests = host.get('DeviceRequests') or []
    reserved = any(r.get('Count', 0) != 0 or any(
        d in card[:2] for d in (r.get('DeviceIDs') or [])) for r in requests)
    visible = next((v.split('=', 1)[1] for v in (c.get('Config', {}).get('Env') or [])
                    if v.startswith('NVIDIA_VISIBLE_DEVICES=')), '')
    return reserved or (host.get('Runtime') == 'nvidia' and (
        visible == 'all' or any(d in card[:2] for d in visible.split(','))))


def describe_process(pid, containers, cache=None):
    if not str(pid).isdigit():
        return '进程归属未知'
    try:
        name = Path('/proc/{}/comm'.format(pid)).read_text().strip()
    except FileNotFoundError:
        name = '当前 /proc 中不存在该 PID（可能退出或 PID 命名空间不同）'
    except PermissionError:
        name = '无权限读取 /proc/{}/comm'.format(pid)
    except OSError:
        name = '读取 /proc 失败'
    prefix = '进程={}'.format(safe_label(name))
    ids = process_container(pid)
    running = [c for c in containers if c.get('State', {}).get('Running')]
    for c in running:
        if c['Id'] in ids:
            return '{} · {} · 依据=cgroup'.format(prefix, container_description(c))
    # Display-only fallback. Failure to inspect a container never implies a host process.
    cache = {} if cache is None else cache
    for c in running:
        if c['Id'] not in cache:
            try:
                cache[c['Id']] = top_pids(command('docker', 'top', c['Id'], '-eo', 'pid'))
            except (OSError, subprocess.SubprocessError):
                cache[c['Id']] = set()
        if pid in cache[c['Id']]:
            return '{} · {} · 依据=docker top'.format(prefix, container_description(c))
    try:
        cgroup = Path('/proc/{}/cgroup'.format(pid)).read_text()
    except OSError:
        cgroup = ''
    units = re.findall(r'/system.slice/([^/\n]+\.service)(?:/|$)', cgroup, re.M)
    if units:
        return '{} · systemd={}（仅进程归组，不等于业务服务名） · 容器归属未确认'.format(prefix, safe_label(','.join(sorted(set(units)))))
    return '{} · 服务归属未确认（进程退出、权限不足或非 Docker 服务）'.format(prefix)


def report(selector=None):
    raw = command('nvidia-smi', '--query-gpu=index,uuid,display_active,display_mode', '--format=csv,noheader,nounits')
    cards = [[v.strip() for v in row] for row in csv.reader(io.StringIO(raw))]
    if selector is not None:
        cards = [c for c in cards if selector in c[:2]]
    if not cards:
        raise ValueError('找不到指定 GPU')
    containers = []
    try:
        endpoint = os.environ.get('DOCKER_HOST') or command('docker', 'context', 'inspect', '--format', '{{.Endpoints.docker.Host}}')
        if not endpoint.startswith('unix://'):
            raise ValueError('Docker context 不是本机，不能关联本机 GPU')
        ids = command('docker', 'ps', '-a', '-q').split()
        containers = json.loads(command('docker', 'inspect', *ids)) if ids else []
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        print('Docker 归属查询不可用：{}'.format(safe_label(exc)))
    processes = command('nvidia-smi', '--query-compute-apps=gpu_uuid,pid,process_name,used_gpu_memory', '--format=csv,noheader,nounits')
    rows = [[v.strip() for v in row] for row in csv.reader(io.StringIO(processes))]
    cache = {}
    for card in cards:
        print('GPU {} ({}) · 显示活跃={} · 显示模式={}'.format(*card))
        reservations = [c for c in containers if c.get('State', {}).get('Running') and reserves_gpu(c, card)]
        for c in reservations:
            print('  容器设备申请：{}（仅配置关联，不证明下列 PID 属于它）'.format(container_description(c)))
        matching = [r for r in rows if len(r) == 4 and r[0] == card[1]]
        if not matching:
            print('  未报告计算进程；不代表没有图形进程或容器预留')
        for _, pid, executable, memory in matching:
            print('  PID {} · 显存 {} MiB · NVIDIA进程={}'.format(safe_label(pid), safe_label(memory), safe_label(executable)))
            print('    ' + describe_process(pid, containers, cache))
    print('只读快照；不输出命令行参数/环境变量，不停止进程。显示器状态不等于计算进程列表。')


def check(app):
    endpoint = os.environ.get('DOCKER_HOST') or command(
        'docker', 'context', 'inspect', '--format', '{{.Endpoints.docker.Host}}')
    if not endpoint.startswith('unix://'):
        raise ValueError('请在 GPU 主机本地执行；不能用本机 nvidia-smi 校验远程 Docker')
    command('docker', 'info', '--format', '{{.OSType}}')
    raw = command('nvidia-smi', '--query-gpu=index,uuid,display_active,display_mode', '--format=csv,noheader,nounits')
    rows = [[v.strip() for v in row] for row in csv.reader(io.StringIO(raw))]
    by_id = {key: row for row in rows for key in row[:2]}
    def resolve(value):
        if value not in by_id:
            raise ValueError(f'GPU {value} 不存在；必须指定一个编号或完整 UUID')
        return by_id[value]
    display = resolve(os.environ.get('MX_BASE_DISPLAY_GPU', '3'))
    ocr = resolve(os.environ.get('MX_BASE_OCR_GPU', '2'))
    embedding = resolve(os.environ.get('MX_BASE_EMBEDDING_GPU', '1'))
    if len({display[1], ocr[1], embedding[1]}) != 3:
        raise ValueError('显示器、OCR、Embedding 必须分配三张不同的 GPU')
    target = ocr if app == 'mx-ocr' else embedding
    if any(v.lower() != 'disabled' for v in target[2:]):
        raise ValueError(f'GPU {target[0]} 显示输出未明确禁用，拒绝占用')
    # Container reservations catch another service even when it has no CUDA process yet.
    ids = command('docker', 'ps', '-a', '-q').split()
    owned_pids = set()
    owned_ids = set()
    containers = json.loads(command('docker', 'inspect', *ids)) if ids else []
    own_names = {'mx-ocr-api', 'mx-ocr-vllm'} if app == 'mx-ocr' else {'mx-embedding-api'}
    for c in containers:
        name = c['Name'].lstrip('/')
        own = name in own_names and (c.get('Config', {}).get('Labels') or {}).get('com.mx-base.app') == app
        if name in own_names and not own:
            raise ValueError(f'容器名称 {name} 已被非本应用使用')
        if not c.get('State', {}).get('Running'):
            continue
        if reserves_gpu(c, target) and not own:
            raise ValueError(f'GPU {target[0]} 已被容器 {name} 申请；{container_description(c)}；先显式停止该服务或换卡')
        if own:
            owned_ids.add(c['Id'])
            top = command('docker', 'top', c['Id'], '-eo', 'pid')
            owned_pids.update(top_pids(top))
    processes = command('nvidia-smi', '--query-compute-apps=gpu_uuid,pid', '--format=csv,noheader,nounits')
    for row in csv.reader(io.StringIO(processes)):
        if len(row) == 2 and row[0].strip() == target[1]:
            pid = row[1].strip()
            if pid not in owned_pids and not (pid.isdigit() and process_container(pid) & owned_ids):
                details = describe_process(pid, containers)
                raise ValueError(f'GPU {target[0]} 有其他计算进程 PID {pid}（未证明属于 {app}）；{details}；不会自动终止。可运行 bash scripts/manage.sh gpu {target[0]} 查看')
    print(f'[mx-base] GPU admission passed: {app} -> {target[0]} ({target[1]})', file=sys.stderr)
    # Bind UUID rather than index: later enumeration changes must not select another card.
    return target[1]


if __name__ == '__main__':
    try:
        if len(sys.argv) in (2, 3) and sys.argv[1] == '--report':
            report(sys.argv[2] if len(sys.argv) == 3 else None)
        elif len(sys.argv) == 2 and sys.argv[1] in ('mx-ocr', 'mx-embedding'):
            print(check(sys.argv[1]))
        else:
            raise ValueError('usage: gpu-check.py mx-ocr|mx-embedding')
    except (ValueError, subprocess.SubprocessError, OSError) as exc:
        print(f'[mx-base] GPU admission refused: {exc}', file=sys.stderr)
        sys.exit(1)
