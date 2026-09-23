"""Media registration and checks. No historical app configuration or Compose up.

Registration is explicit and stored outside Docker. Recovery never recreates a
missing volume/container or silently falls back to the legacy migration helper.
"""
import hashlib
import json
import os
import stat
import time

import catalog
from permissions import emit
from sample_copy import DIR_FLAGS
from projects import infra_storage

RECORD = 'infra-media.json'


def contract(manager, profile):
    infra_storage.reviewed(profile)
    policy = catalog.read_relative(manager.CONFIG.parent, profile['runtime_file'])
    storage = catalog.read_relative(manager.CONFIG.parent, profile['storage_file'])
    names = [n for group in policy['start_groups'] for n in group]
    if (policy.get('schema') != 1 or policy.get('project') != profile['project']
            or policy.get('media_path') != infra_storage.RAW or policy.get('parent_path') != '/app/media'
            or policy.get('docker_root') != '/data/docker'
            or policy.get('nfs_options') != manager.prep.OPTIONS
            or len(names) != len(set(names)) or set(names) != set(storage['services'])
            or set(names) != manager.prep.SERVICES):
        raise RuntimeError('Unreviewed media recovery contract.')
    for name, service in storage['services'].items():
        expected = {'type': 'volume', 'source': 'mx_static_raw_media_nfs',
                    'target': policy['media_path'], 'read_only': name == 'gateway',
                    'volume': {'nocopy': True}}
        if service != {'volumes': [expected]}:
            raise RuntimeError('Unexpected media storage declaration: ' + name)
    if storage['volumes'] != {'mx_static_raw_media_nfs': {'external': True, 'name': profile['nfs_volume']}}:
        raise RuntimeError('Media volume must remain external with the registered identity.')
    identity = dict(policy)
    identity.update(parent_volume=profile['volume'], nfs_volume=profile['nfs_volume'], storage=storage)
    digest = hashlib.sha256(json.dumps(identity, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    return policy, storage, digest


def read_record(manager, optional=False):
    try:
        folder = os.open(manager.AUTO_DIR, DIR_FLAGS)
    except FileNotFoundError:
        if optional: return None
        raise RuntimeError('尚未登记媒体恢复；运行 nas infra storage register。')
    try:
        s = os.fstat(folder)
        if s.st_uid != os.geteuid() or s.st_mode & 0o022:
            raise RuntimeError('Unsafe media registration directory.')
        try: fd = os.open(RECORD, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=folder)
        except FileNotFoundError:
            if optional: return None
            raise RuntimeError('尚未登记媒体恢复；运行 nas infra storage register。')
        with os.fdopen(fd) as stream:
            s = os.fstat(stream.fileno())
            if not stat.S_ISREG(s.st_mode) or s.st_uid != os.geteuid() or s.st_mode & 0o077 or s.st_size > 16384:
                raise RuntimeError('Unsafe media registration file.')
            return json.load(stream)
    finally: os.close(folder)


def registered(manager, profile):
    policy, storage, digest = contract(manager, profile)
    record = read_record(manager)
    if (not isinstance(record, dict) or record.get('schema') != 1
            or record.get('project') != profile['project'] or record.get('nas_authoritative') is not True
            or record.get('contract_sha256') != digest):
        raise RuntimeError('媒体存储登记不匹配；不能自动采用新目标或回退旧恢复路径。')
    return policy


def selected(profile, containers):
    rows = {}
    for c in containers:
        labels = c.get('Config', {}).get('Labels') or {}
        if (labels.get('com.docker.compose.project') == profile['project']
                and labels.get('com.docker.compose.service') in infra_storage.prep.SERVICES):
            # Maintenance one-offs must not be adopted as persistent services.
            if str(labels.get('com.docker.compose.oneoff', 'false')).lower() != 'false':
                raise RuntimeError('媒体临时容器仍存在；等待发布/维护完成后再恢复。')
            rows[c['Id']] = c
    return rows


def inspect(manager, profile, require_running=False, expected_ids=None, inspection=None):
    containers, volume, mountinfo = inspection if inspection is not None else infra_storage.collect(manager, profile)
    result = infra_storage.evaluate(profile, containers, volume, mountinfo,
                                    allow_stopped=not require_running, allow_replicas=True)
    if not result['ok']:
        bad = list(result['issues'])
        bad.extend(s['service'] + ': ' + '; '.join(s['issues']) for s in result['services'] if s['issues'])
        raise RuntimeError('媒体挂载检查未通过：' + '；'.join(bad))
    rows = selected(profile, containers)
    if expected_ids is not None and set(rows) != set(expected_ids):
        raise RuntimeError('部署在恢复过程中发生变化；未继续启动，请完成发布后重试。')
    for c in rows.values():
        state = c.get('State', {})
        if any(state.get(k) for k in ('Paused', 'OOMKilled', 'Restarting', 'Dead')):
            raise RuntimeError('媒体容器暂停、OOM、重启中或已损坏，需处理；不强制重启。')
    return rows


def register(manager, profile):
    policy, storage, digest = contract(manager, profile)
    previous = read_record(manager, optional=True)
    if previous is not None:
        registered(manager, profile)  # Never overwrite a different storage authority.
    # Initial registration needs a completed migration receipt, not its app hashes.
    if previous is None:
        if not profile.get('report'): raise RuntimeError('Media registration requires a completed migration receipt.')
        fd = manager.cutover.open_report(profile['report'])
        try: state = manager.cutover.read_json(fd, 'execution.json')
        finally: os.close(fd)
        if (not isinstance(state, dict) or state.get('schema') != 1
                or state.get('volume') != profile['volume'] or state.get('report_directory') != profile['report']
                or state.get('phase') != 'running_on_nas' or state.get('final_sync_passed') is not True
                or state.get('nas_may_have_writes') is not True):
            raise RuntimeError('A completed NAS migration receipt is required; registration does not perform a cutover.')
    rows = inspect(manager, profile, require_running=True)
    inspect(manager, profile, require_running=True, expected_ids=rows)
    if previous is None:
        fd = manager.secure_directory(manager.AUTO_DIR)
        try:
            manager.prep.private_write(fd, RECORD, {'schema': 1, 'project': profile['project'],
                'nas_authoritative': True, 'contract_sha256': digest, 'registered_unix': time.time(),
                'source_report': profile['report']})
            os.fsync(fd)
        finally: os.close(fd)
    emit('nas_media_registered', project=profile['project'], record=manager.AUTO_DIR + '/' + RECORD,
         consumers=len(rows), already_registered=previous is not None, containers_started=False,
         note='仅登记媒体存储；不保存 Env/镜像/容器 ID，不改迁移报告，不启用 timer。')


def check(manager, profile, require_running=False):
    registered(manager, profile)
    maintenance_guard(manager)
    return inspect(manager, profile, require_running=require_running)


def maintenance_guard(manager, owner=None):
    pending = read_record(manager).get('maintenance_report')
    if pending is not None and pending != owner:
        raise RuntimeError('媒体维护尚未完成，禁止开机补启动混合容器；先检查维护报告：' + str(pending))


def maintenance_state(manager, profile, report, complete=False):
    registered(manager, profile)
    record = read_record(manager)
    if complete:
        if record.get('maintenance_report') != report: raise RuntimeError('Media maintenance owner changed.')
        record.pop('maintenance_report')
    else:
        record['maintenance_report'] = report
    fd = manager.secure_directory(manager.AUTO_DIR)
    try: manager.cutover.atomic_json(fd, RECORD, record)
    finally: os.close(fd)
