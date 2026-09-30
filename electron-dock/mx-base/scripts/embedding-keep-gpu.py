#!/usr/bin/env python3
"""Read-only plan for explicitly upgrading an existing shared-GPU Embedding instance."""
import importlib.util
import json
import math
import os
from pathlib import Path
import shlex
import sys

spec = importlib.util.spec_from_file_location('gpu_check', Path(__file__).with_name('gpu-check.py'))
gpu = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gpu)

FIELDS = {
    'MODEL_PATH': 'MODEL_PATH', 'MODEL_REVISION': 'REVISION', 'DIMENSIONS': 'DIMENSIONS',
    'MAX_LENGTH': 'MAX_LENGTH', 'MAX_BATCH': 'MAX_BATCH', 'TOKEN_BUDGET': 'TOKEN_BUDGET',
    'MICRO_BATCH': 'MICRO_BATCH', 'DTYPE': 'DTYPE', 'GPU_MEMORY_FRACTION': 'GPU_FRACTION',
    'CPU_THREADS': 'CPU_THREADS',
}


def plan(container, cards, app_dir):
    config, host = container.get('Config') or {}, container.get('HostConfig') or {}
    labels = config.get('Labels') or {}
    if (container.get('Name') != '/mx-embedding-api' or labels.get('com.mx-base.app') != 'mx-embedding'
            or labels.get('com.docker.compose.project') != 'mx-embedding'
            or labels.get('com.docker.compose.service') != 'api'
            or not container.get('State', {}).get('Running') or not container.get('Id')):
        raise ValueError('--keep-gpu 仅支持本 Compose 项目中已运行的 mx-embedding-api；不接管其他容器')
    requests = host.get('DeviceRequests') or []
    if (len(requests) != 1 or requests[0].get('Driver') != 'nvidia' or requests[0].get('Count') != 0
            or len(requests[0].get('DeviceIDs') or []) != 1):
        raise ValueError('旧容器必须已绑定一个明确的 GPU UUID；不接受 all、多卡或数量分配')
    uuid = requests[0]['DeviceIDs'][0]
    card = next((row for row in cards if row[1] == uuid), None)
    if not card or card[2].lower() not in ('enabled', 'disabled'):
        raise ValueError('旧容器 GPU UUID 不存在或显示状态未知，保留旧实例')
    env = dict(value.split('=', 1) for value in config.get('Env') or [] if '=' in value)
    if any(not env.get(key) for key in FIELDS) or env.get('API_KEY_FILE') != '/run/secrets/api-key':
        raise ValueError('旧实例缺少明确的模型/资源配置或使用不同凭据路径，不能推测默认值')
    for key, low, high in (('DIMENSIONS', 32, 1024), ('MAX_LENGTH', 16, 32768),
                           ('MAX_BATCH', 1, 64), ('MICRO_BATCH', 1, 64),
                           ('TOKEN_BUDGET', 16, 65536), ('CPU_THREADS', 1, 32)):
        if not env[key].isdigit() or not low <= int(env[key]) <= high:
            raise ValueError('旧实例资源配置不受支持：' + key)
    fraction = float(env['GPU_MEMORY_FRACTION'])
    if (not math.isfinite(fraction) or not 0 < fraction <= .8 or
            int(env['MICRO_BATCH']) > int(env['MAX_BATCH']) or env['DTYPE'] not in ('float16', 'bfloat16')):
        raise ValueError('旧实例的 batch / 显存 / 精度配置不受支持')
    if any(not isinstance(host.get(key), int) or host[key] <= 0 for key in ('NanoCpus', 'Memory', 'ShmSize')):
        raise ValueError('旧实例必须具有明确的 CPU、内存和共享内存上限')
    mounts = {m.get('Destination'): m for m in container.get('Mounts') or []}
    model_mount, key_mount = mounts.get('/models', {}), mounts.get('/run/secrets/api-key', {})
    secret = Path(app_dir) / 'secrets/api-key'
    if (model_mount.get('Type') != 'bind' or not Path(model_mount.get('Source', '')).is_absolute()
            or not Path(model_mount.get('Source', '')).is_dir()
            or key_mount.get('Type') != 'bind' or not secret.is_file()
            or not os.path.samefile(str(secret), key_mount.get('Source', ''))):
        raise ValueError('旧实例模型缓存或 API Key 挂载与本项目不兼容；不创建/替换凭据')
    ports = host.get('PortBindings') or {}
    bindings = ports.get('8000/tcp') or []
    if set(ports) != {'8000/tcp'} or len(bindings) != 1 or not bindings[0].get('HostPort', '').isdigit():
        raise ValueError('旧实例必须具有一个明确的 8000/tcp 端口映射')
    values = {'MX_EMBEDDING_' + output: env[key] for key, output in FIELDS.items()}
    bind = bindings[0].get('HostIp') or '0.0.0.0'
    if ':' in bind and not bind.startswith('['):
        bind = '[' + bind + ']'
    values.update(GPU_UUID=uuid, MX_EMBEDDING_CPUS=str(host['NanoCpus'] / 1000000000),
                  MX_EMBEDDING_MEMORY=str(host['Memory']), MX_EMBEDDING_SHM_SIZE=str(host['ShmSize']),
                  MX_EMBEDDING_MODELS_PATH=model_mount['Source'],
                  MX_EMBEDDING_BIND=bind,
                  MX_EMBEDDING_PORT=bindings[0]['HostPort'])
    # Only allowlisted deployment values are retained. Never serialize all Env,
    # command arguments or the secret's contents into the plan or logs.
    return {'containerId': container['Id'], 'values': values}


def current(app_dir):
    endpoint = os.environ.get('DOCKER_HOST') or gpu.command(
        'docker', 'context', 'inspect', '--format', '{{.Endpoints.docker.Host}}')
    if not endpoint.startswith('unix://'):
        raise ValueError('--keep-gpu 必须在 GPU 主机的本地 Docker 执行')
    containers = json.loads(gpu.command('docker', 'inspect', 'mx-embedding-api'))
    if len(containers) != 1:
        raise ValueError('无法唯一确认旧 Embedding 实例')
    return plan(containers[0], gpu.gpu_inventory(), app_dir)


def main():
    action, app_dir, snapshot, *rest = sys.argv[1:]
    state = current(app_dir)
    if action == 'prepare' and len(rest) == 1:
        Path(snapshot).write_text(json.dumps(state))
        Path(rest[0]).write_text(''.join('export {}={}\n'.format(key, shlex.quote(value))
                                      for key, value in sorted(state['values'].items())))
        for filename in (snapshot, rest[0]):
            os.chmod(filename, 0o600)
        values = state['values']
        print('[mx-base] 沿用旧实例 GPU {}；接受当前显示/模型共享，不改其他服务。'.format(values['GPU_UUID']), file=sys.stderr)
        print('[mx-base] 保留 micro-batch={}，max-batch={}，GPU fraction={}，CPU={}，内存={} bytes；缓存、端口和 Key 挂载沿用。'.format(
            values['MX_EMBEDDING_MICRO_BATCH'], values['MX_EMBEDDING_MAX_BATCH'], values['MX_EMBEDDING_GPU_FRACTION'],
            values['MX_EMBEDDING_CPUS'], values['MX_EMBEDDING_MEMORY']), file=sys.stderr)
    elif action == 'check' and not rest:
        if state != json.loads(Path(snapshot).read_text()):
            raise ValueError('构建期间旧实例或资源配置发生变化；取消替换，请重新规划')
    else:
        raise ValueError('usage: embedding-keep-gpu.py prepare|check APP_DIR SNAPSHOT [ENV_FILE]')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, gpu.subprocess.SubprocessError) as exc:
        print('[mx-base] 沿用 GPU 升级被拒绝：{}'.format(exc), file=sys.stderr)
        sys.exit(1)
