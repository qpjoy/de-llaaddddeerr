"""Read-only storage diagnostics, independent of old deployment receipts.

This is NOT an admission controller or permission to rebase a cutover report.
Only Docker metadata and local procfs are read; no media directory is opened.
"""
import json
import os
from pathlib import Path

import cutover_prepare as prep
from permissions import emit

RAW = '/app/media/data_hub_raw_media'


def media_consumer(container):
    roots = ['/data/docker/volumes/' + prep.VOLUME + '/_data/data_hub_raw_media',
             '/data/docker/volumes/' + prep.NFS_VOLUME + '/_data']
    for mount in container.get('Mounts', []):
        if mount.get('Name') in (prep.VOLUME, prep.NFS_VOLUME): return True
        source = mount.get('Source', '')
        if mount.get('Type') == 'bind' and source.startswith('/'):
            source = os.path.normpath(source)
            if any(source == root or source.startswith(root + '/') or root.startswith(source.rstrip('/') + '/') for root in roots):
                return True
    return False


def reviewed(profile):
    if (profile['project'], profile['volume'], profile['nfs_volume']) != ('mx_data', prep.VOLUME, prep.NFS_VOLUME):
        raise RuntimeError('Storage check is only reviewed for infra/mx_data.')


def kernel_mounts(text):
    rows = []
    for line in text.splitlines():
        left, right = line.split(' - ', 1)
        a, b = left.split(), right.split()
        rows.append({'target': a[4], 'root': a[3], 'type': b[0], 'source': b[1],
                     'options': a[5].split(','), 'super_options': b[2].split(',')})
    return rows


def evaluate(profile, containers, volume, mountinfo, allow_stopped=False, allow_replicas=False):
    reviewed(profile)
    issues = []
    try:
        prep.validate_volume(volume or {})
    except RuntimeError:
        issues.append('NFS 卷不存在或 driver/options 不符；禁止自动创建本地替代卷。')
    selected = {name: [] for name in prep.SERVICES}
    for c in containers:
        labels = c.get('Config', {}).get('Labels') or {}
        name = labels.get('com.docker.compose.service')
        if labels.get('com.docker.compose.project') == profile['project'] and name in selected:
            selected[name].append(c)
        elif media_consumer(c):
            issues.append('发现登记清单外的媒体卷消费者：' + c['Id'][:12])
    services = []
    batches = []
    for name in sorted(selected):
        current = selected[name]
        if allow_replicas and current:
            batches.extend((name, [c]) for c in current)
        else:
            batches.append((name, current))
    ids = [c['Id'] for group in selected.values() for c in group]
    if len(ids) != len(set(ids)):
        issues.append('媒体容器身份重复，无法可靠核对。')
    for name, current in batches:
        reasons = []
        result = {'service': name, 'running': False, 'kernel_source': None}
        if len(current) != 1:
            reasons.append('预期恰好一个容器，实际 ' + str(len(current)))
        else:
            c = current[0]
            result['id'] = c['Id'][:12]
            result['running'] = c.get('State', {}).get('Running') is True
            mounts = c.get('Mounts', [])
            parent = [m for m in mounts if m.get('Destination') == '/app/media']
            child = [m for m in mounts if m.get('Destination') == RAW]
            if (len(parent) != 1 or parent[0].get('Type') != 'volume' or parent[0].get('Name') != prep.VOLUME
                    or parent[0].get('Source') != '/data/docker/volumes/' + prep.VOLUME + '/_data'):
                reasons.append('SSD 父卷不符')
            if (len(child) != 1 or child[0].get('Type') != 'volume' or child[0].get('Name') != prep.NFS_VOLUME
                    or child[0].get('Source') != '/data/docker/volumes/' + prep.NFS_VOLUME + '/_data'
                    or child[0].get('RW') is not (name != 'gateway')):
                reasons.append('缺少正确的 NAS 子卷或读写属性不符')
            host = [m for m in c.get('HostConfig', {}).get('Mounts', []) if m.get('Target') == RAW]
            if (len(host) != 1 or host[0].get('Type') != 'volume' or host[0].get('Source') != prep.NFS_VOLUME
                    or host[0].get('VolumeOptions', {}).get('NoCopy') is not True
                    or host[0].get('VolumeOptions', {}).get('Subpath')
                    or ('ReadOnly' in host[0] and host[0]['ReadOnly'] is not (name == 'gateway'))):
                reasons.append('缺少正确的 nocopy 挂载声明')
            if any(path == RAW or path.startswith(RAW + '/') for path in c.get('HostConfig', {}).get('Tmpfs', {})):
                reasons.append('tmpfs 可能覆盖媒体目录')
            text = mountinfo.get(c['Id'])
            if not result['running'] and allow_stopped:
                result['declared_only'] = True  # Docker must mount NFS before start; verify procfs afterwards.
            elif not result['running'] or text is None:
                reasons.append('容器未运行或内核挂载表不可读；不能确认实际 NAS 挂载')
            else:
                rows = kernel_mounts(text)
                covering = [m for m in rows if m['target'] == '/' or RAW == m['target'] or RAW.startswith(m['target'] + '/')]
                nearest = max(covering, key=lambda m: len(m['target'])) if covering else None
                if nearest:
                    result['kernel_source'] = {k: nearest[k] for k in ('target', 'root', 'type', 'source')}
                exact = [m for m in rows if m['target'] == RAW]
                sources = {prep.OPTIONS['device'], '192.168.1.3' + prep.OPTIONS['device'], 'nas-storage' + prep.OPTIONS['device']}
                if (len(exact) != 1 or exact[0]['type'] != 'nfs' or exact[0]['root'] != '/'
                        or exact[0]['source'] not in sources
                        or not {'hard', 'vers=3', 'addr=192.168.1.3'}.issubset(exact[0]['super_options'])
                        or ('ro' if name == 'gateway' else 'rw') not in exact[0]['options']):
                    reasons.append('内核未确认预期 NFS 子挂载；可能仍由 SSD 父卷提供媒体')
                if any(m['target'].startswith(RAW + '/') for m in rows):
                    reasons.append('raw-media 内存在额外子挂载，需单独审核')
            if any(m.get('Destination', '').startswith(RAW + '/') for m in mounts):
                reasons.append('Docker 声明包含额外媒体子挂载')
        result['issues'] = reasons
        result['matched'] = not reasons
        services.append(result)
    return {'project': profile['project'], 'ok': not issues and all(s['matched'] for s in services),
            'issues': issues, 'services': services, 'nas_walk': False, 'live_snapshot': True,
            'note': '只读瞬时核对；不证明 NAS 可读写、不授权清理、不拦截其他 Docker/发布入口。'}


def collect(manager, profile, containers=None):
    reviewed(profile)
    if containers is None:
        containers = manager.precopy.inspect_containers()
    names = manager.run(['docker', 'volume', 'ls', '--format', '{{.Name}}']).splitlines()
    volume = None
    if prep.NFS_VOLUME in names:
        volume = json.loads(manager.run(['docker', 'volume', 'inspect', prep.NFS_VOLUME]))[0]
    mountinfo = {}
    for c in containers:
        labels = c.get('Config', {}).get('Labels') or {}
        pid = c.get('State', {}).get('Pid')
        if (labels.get('com.docker.compose.project') == profile['project']
                and labels.get('com.docker.compose.service') in prep.SERVICES
                and c.get('State', {}).get('Running') is True and isinstance(pid, int) and pid > 0):
            try:
                mountinfo[c['Id']] = Path('/proc/{}/mountinfo'.format(pid)).read_text()
            except OSError:
                pass  # A disappearing container must produce an unverified result.
    return containers, volume, mountinfo


def check(manager, profile, containers=None):
    containers, volume, mountinfo = collect(manager, profile, containers)
    result = evaluate(profile, containers, volume, mountinfo, allow_replicas=profile.get('recovery_mode') == 'media-v1')
    emit('nas_infra_storage_check', **result)
    return result['ok']
