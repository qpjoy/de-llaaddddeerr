"""Start existing registered project services; no Compose up or NAS file I/O."""
import json
import os
import re
import socket
import stat
import time

from permissions import emit
from projects import infra_runtime as media
from projects import infra_storage as storage
from sample_copy import DIR_FLAGS

DEPENDENCIES = {'postgres', 'redis'}
LABEL = 'com.docker.compose.depends_on'
WAIT_SECONDS = 180
LOCAL_VOLUMES = '/data/docker/volumes'


def dependencies(name, container):
    labels = container['Config']['Labels']
    if LABEL not in labels:
        # Reviewed Compose fallback for older containers without this label.
        if name in DEPENDENCIES: return {}
        return {n: 'service_healthy' for n in (('web', 'chat-gateway') if name == 'gateway' else ('postgres', 'redis'))}
    result = {}
    for item in filter(None, labels[LABEL].split(',')):
        fields = item.split(':')
        if (len(fields) not in (1, 2, 3) or not re.fullmatch(r'[a-zA-Z0-9_-]+', fields[0])
                or (len(fields) == 3 and fields[2] not in ('true', 'false'))):
            raise RuntimeError('无法识别现有 Compose 依赖标签：' + name)
        condition = fields[1] if len(fields) > 1 else 'running_or_healthy'
        if condition not in ('service_started', 'service_healthy', 'running_or_healthy'):
            raise RuntimeError('依赖包含一次性任务或未审核条件，不自动执行：' + name)
        if fields[0] in result: raise RuntimeError('重复依赖：' + name)
        result[fields[0]] = condition
    return result


def snapshot(manager, profile, expected_ids=None):
    inspection = storage.collect(manager, profile)
    rows = media.inspect(manager, profile, inspection=inspection)
    for c in inspection[0]:
        labels = c.get('Config', {}).get('Labels') or {}
        if labels.get('com.docker.compose.project') == profile['project'] and labels.get('com.docker.compose.service') in DEPENDENCIES:
            if str(labels.get('com.docker.compose.oneoff', 'false')).lower() != 'false':
                raise RuntimeError('依赖临时容器仍存在；完成维护后再启动项目。')
            if any(c.get('State', {}).get(k) for k in ('Paused', 'OOMKilled', 'Restarting', 'Dead')):
                raise RuntimeError('依赖容器暂停、OOM 或重启中；不强制重启。')
            rows[c['Id']] = c
    groups = {}
    for c in rows.values(): groups.setdefault(c['Config']['Labels']['com.docker.compose.service'], []).append(c)
    if any(len(groups.get(n, [])) != 1 for n in DEPENDENCIES):
        raise RuntimeError('已有 PostgreSQL/Redis 容器缺失或不唯一；本入口不创建数据库。')
    if expected_ids is not None and set(rows) != set(expected_ids):
        raise RuntimeError('项目容器在恢复期间变化；停止本轮操作，完成部署后重试。')
    graph = {}
    for name, replicas in groups.items():
        graph[name] = dependencies(name, replicas[0])
        if any(dependencies(name, c) != graph[name] for c in replicas[1:]):
            raise RuntimeError('服务副本依赖不一致：' + name)
        if set(graph[name]) - set(groups):
            raise RuntimeError('存在缺失或未登记依赖，需要适配后再接管：' + name)
    return rows, groups, graph


def order(graph, policy):
    priority = ['postgres', 'redis'] + [n for g in policy['start_groups'] for n in g]
    result = []
    while len(result) < len(graph):
        ready = [n for n in priority if n not in result and set(graph[n]).issubset(result)]
        if not ready: raise RuntimeError('项目依赖形成循环，未启动任何容器。')
        result.append(ready[0])
    return result


def check(manager, profile, require_running=False, maintenance_report=None):
    policy = media.registered(manager, profile)
    media.maintenance_guard(manager, maintenance_report)
    rows, groups, graph = snapshot(manager, profile)
    order(graph, policy)
    if require_running and any(not c['State']['Running'] for c in rows.values()):
        raise RuntimeError('项目仍有停止的服务；先 nas infra start，再启用自动恢复。')
    return rows


def local_data_guard(manager, name, container):
    """Never start Postgres on an empty/new data directory. Read local metadata only."""
    target = '/var/lib/postgresql/data' if name == 'postgres' else '/data'
    mounts = container.get('Mounts', [])
    candidates = [m for m in mounts if m.get('Destination') == target]
    if (len(candidates) != 1 or candidates[0].get('Type') != 'volume' or candidates[0].get('RW') is not True
            or any(m.get('Destination', '').startswith(target + '/') for m in mounts)
            or any(m.get('Target') == target and m.get('VolumeOptions', {}).get('Subpath') for m in container.get('HostConfig', {}).get('Mounts', []))
            or any(p == target or p.startswith(target + '/') for p in container.get('HostConfig', {}).get('Tmpfs', {}))):
        raise RuntimeError('依赖数据挂载需人工核对：' + name)
    mount = candidates[0]; volume = mount.get('Name', '')
    if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]*', volume): raise RuntimeError('无效依赖数据卷。')
    path = LOCAL_VOLUMES + '/' + volume + '/_data'
    records = json.loads(manager.run(['docker', 'volume', 'inspect', volume]))
    if (len(records) != 1 or records[0].get('Name') != volume or records[0].get('Driver') != 'local'
            or records[0].get('Options') or records[0].get('Mountpoint') != path or mount.get('Source') != path):
        raise RuntimeError('依赖数据卷缺失或不是已存在的本地卷；不创建替代品。')
    # Open every component without following symlinks, never create anything.
    fd = os.open('/', DIR_FLAGS)
    try:
        for part in path.strip('/').split('/'):
            child = os.open(part, DIR_FLAGS, dir_fd=fd); os.close(fd); fd = child
        if name == 'postgres':
            env = dict(x.split('=', 1) for x in container['Config'].get('Env', []) if '=' in x)
            pgdata = env.get('PGDATA', target)
            if not (pgdata == target or pgdata.startswith(target + '/')):
                raise RuntimeError('PGDATA 不在已核对的数据卷内。')
            for part in pgdata[len(target):].strip('/').split('/') if pgdata != target else []:
                if part in ('', '.', '..'): raise RuntimeError('PGDATA 路径不受支持。')
                child = os.open(part, DIR_FLAGS, dir_fd=fd); os.close(fd); fd = child
            for marker in ('PG_VERSION', 'global/pg_control'):
                parent = os.dup(fd)
                try:
                    parts = marker.split('/')
                    for part in parts[:-1]:
                        child = os.open(part, DIR_FLAGS, dir_fd=parent); os.close(parent); parent = child
                    value = os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)
                    if not stat.S_ISREG(value.st_mode) or value.st_size == 0:
                        raise RuntimeError('PostgreSQL 初始化标记不完整，禁止启动空库。')
                finally: os.close(parent)
    finally: os.close(fd)


def recover(manager, profile, automatic=False, maintenance_report=None):
    policy = media.registered(manager, profile)
    media.maintenance_guard(manager, maintenance_report)
    initial_selection = dict(manager.auto_config())
    rows, groups, graph = snapshot(manager, profile)
    ids = set(rows); sequence = order(graph, policy); started = []
    def refresh():
        media.registered(manager, profile); media.maintenance_guard(manager, maintenance_report)
        selection = manager.auto_config()
        if not manager.recovery_control.requested(selection, 'part1') and (automatic or selection != initial_selection):
            raise RuntimeError('项目恢复已暂停，不继续启动。')
        current, by_name, current_graph = snapshot(manager, profile, expected_ids=ids)
        if current_graph != graph: raise RuntimeError('恢复过程中依赖关系变化，停止操作。')
        return current, by_name
    if all(c['State']['Running'] for c in rows.values()):
        emit('nas_project_recovery', project=profile['project'], started=[],
             note='全部已登记服务已运行，媒体 NFS 挂载匹配；不重启，不执行 NAS 删除。')
        return
    refresh()
    with socket.create_connection(('192.168.1.3', 2049), timeout=5): pass
    # Validate every stopped stateful dependency before the first mutation.
    for name in DEPENDENCIES:
        if not groups[name][0]['State']['Running']: local_data_guard(manager, name, groups[name][0])
    emit('nas_project_start_order', services=sequence, note='使用现有容器的 Compose 依赖标签；旧容器缺标签时使用已审核依赖。')
    for name in sequence:
        for cid in sorted(c['Id'] for c in groups[name]):
            current, by_name = refresh()
            if current[cid]['State']['Running']: continue
            deadline = time.monotonic() + WAIT_SECONDS
            announced = False
            while True:
                current, by_name = refresh()
                if current[cid]['State']['Running']: break  # Docker may have already started it.
                pending = []
                for dep, condition in graph[name].items():
                    for c in by_name[dep]:
                        state = c['State']; health = state.get('Health', {}).get('Status')
                        healthy = condition == 'service_healthy' or (condition == 'running_or_healthy' and health is not None)
                        if healthy and health is None: raise RuntimeError('依赖要求 healthy 但没有健康检查：' + dep)
                        if not state['Running'] or (healthy and health != 'healthy'): pending.append(dep)
                if not pending: break
                if not announced:
                    emit('nas_project_waiting', service=name, dependencies=sorted(set(pending)), timeout_seconds=WAIT_SECONDS)
                    announced = True
                if time.monotonic() >= deadline: raise RuntimeError('等待依赖就绪超时：' + ', '.join(sorted(set(pending))))
                time.sleep(2)
            if current[cid]['State']['Running']: continue
            if name in DEPENDENCIES: local_data_guard(manager, name, current[cid])
            current, _ = refresh()
            if current[cid]['State']['Running']: continue
            manager.run(['docker', 'start', cid], timeout=None)
            started.append(name)
            current, _ = refresh()
            if not current[cid]['State']['Running']: raise RuntimeError('服务启动后未运行：' + name)
    current, _ = refresh()
    if any(not c['State']['Running'] for c in current.values()): raise RuntimeError('仍有停止的服务；不自动重建。')
    emit('nas_project_recovery', project=profile['project'], started=started,
         note='仅补启动已有依赖和媒体服务，已核对实际 NFS；不构建、迁移数据库、初始化账号或删除 NAS 文件。')
