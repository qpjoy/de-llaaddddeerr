#!/usr/bin/env python3
"""Read-only admission check on the same host as the local Docker daemon."""
import csv
import io
import json
import os
import subprocess
import sys


def command(*args):
    return subprocess.check_output(args, text=True, timeout=15).strip()


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
    containers = json.loads(command('docker', 'inspect', *ids)) if ids else []
    own_names = {'mx-ocr-api', 'mx-ocr-vllm'} if app == 'mx-ocr' else {'mx-embedding-api'}
    for c in containers:
        name = c['Name'].lstrip('/')
        own = name in own_names and (c.get('Config', {}).get('Labels') or {}).get('com.mx-base.app') == app
        if name in own_names and not own:
            raise ValueError(f'容器名称 {name} 已被非本应用使用')
        if not c.get('State', {}).get('Running'):
            continue
        requests = c.get('HostConfig', {}).get('DeviceRequests') or []
        reserves = any(r.get('Count', 0) != 0 or any(
            d in (target[0], target[1]) for d in (r.get('DeviceIDs') or [])) for r in requests)
        visible = next((v.split('=', 1)[1] for v in (c.get('Config', {}).get('Env') or [])
                        if v.startswith('NVIDIA_VISIBLE_DEVICES=')), '')
        if c.get('HostConfig', {}).get('Runtime') == 'nvidia':
            reserves = reserves or visible == 'all' or any(d in (target[0], target[1]) for d in visible.split(','))
        if reserves and not own:
            raise ValueError(f'GPU {target[0]} 已被容器 {name} 申请；先显式停止该服务或换卡')
        if own:
            top = command('docker', 'top', c['Id'], '-eo', 'pid')
            owned_pids.update(line.strip() for line in top.splitlines()[1:] if line.strip().isdigit())
    processes = command('nvidia-smi', '--query-compute-apps=gpu_uuid,pid', '--format=csv,noheader,nounits')
    for row in csv.reader(io.StringIO(processes)):
        if len(row) == 2 and row[0].strip() == target[1] and row[1].strip() not in owned_pids:
            raise ValueError(f'GPU {target[0]} 有其他计算进程 PID {row[1].strip()}；不会自动终止')
    print(f'[mx-base] GPU admission passed: {app} -> {target[0]} ({target[1]})', file=sys.stderr)
    # Bind UUID rather than index: later enumeration changes must not select another card.
    return target[1]


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2 or sys.argv[1] not in ('mx-ocr', 'mx-embedding'):
            raise ValueError('usage: gpu-check.py mx-ocr|mx-embedding')
        print(check(sys.argv[1]))
    except (ValueError, subprocess.SubprocessError, OSError) as exc:
        print(f'[mx-base] GPU admission refused: {exc}', file=sys.stderr)
        sys.exit(1)
