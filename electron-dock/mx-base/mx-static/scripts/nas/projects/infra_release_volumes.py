"""Separate retained infrastructure volumes from application-owned local volumes.

Admission only: never create, change or remove a volume. Compose may create a
new application volume only as part of the operator's explicit release command.
"""
import json
import posixpath
import re

PROTECTED = {'media_data', 'mx_static_raw_media_nfs', 'postgres_data', 'redis_data', 'static_data'}


def application_volumes(model):
    volumes = model.get('volumes', {})
    invalid = sorted(key for key in PROTECTED if volumes.get(key, {}).get('external') is not True)
    if invalid:
        raise RuntimeError('Protected data volumes must remain external: ' + ', '.join(invalid))
    names = [value.get('name') for value in volumes.values()]
    if any(not isinstance(name, str) or not name for name in names) or len(names) != len(set(names)):
        raise RuntimeError('Volume names must be explicit and distinct; storage aliases require review.')
    managed = {}
    for key, value in volumes.items():
        if key in PROTECTED or value.get('external') is True:
            continue
        if (not re.fullmatch(re.escape(model['name']) + r'_[A-Za-z0-9_.-]+', value['name'])
                or value.get('driver') not in (None, '', 'local') or value.get('driver_opts')):
            raise RuntimeError('Application volume requires project-scoped local storage without driver options: ' + key)
        managed[key] = value['name']
    return managed


def overlaps(a, b):
    a, b = posixpath.normpath(a), posixpath.normpath(b)
    return a == b or a.startswith(b.rstrip('/') + '/') or b.startswith(a.rstrip('/') + '/')


def check(manager, model, managed, containers):
    if not managed:
        return
    existing = set(manager.run(['docker', 'volume', 'ls', '--format', '{{.Name}}']).splitlines())
    for key, name in sorted(managed.items()):
        if name in existing:
            values = json.loads(manager.run(['docker', 'volume', 'inspect', name]))
            if len(values) != 1:
                raise RuntimeError('Expected one application volume: ' + key)
            value = values[0]; labels = value.get('Labels') or {}
            if (value.get('Name') != name or value.get('Driver') != 'local' or value.get('Options')
                    or value.get('Scope') != 'local'
                    or value.get('Mountpoint') != '/data/docker/volumes/' + name + '/_data'
                    or labels.get('com.docker.compose.project') != model['name']
                    or labels.get('com.docker.compose.volume') != key):
                raise RuntimeError('Existing application volume identity/ownership differs: ' + key)
        for c in containers:
            if not any(m.get('Name') == name for m in c.get('Mounts', [])):
                continue
            labels = c.get('Config', {}).get('Labels') or {}
            if name not in existing or labels.get('com.docker.compose.project') != model['name']:
                raise RuntimeError('Application volume is missing despite a container reference, or shared across projects: ' + key)

    for service, config in model['services'].items():
        mounts = config.get('volumes', [])
        tmpfs = config.get('tmpfs', [])
        if isinstance(tmpfs, str):
            tmpfs = [tmpfs]
        protected_paths = ['/app/media', '/app/staticfiles'] + [m['target'] for m in mounts
            if m.get('type') == 'volume' and m.get('source') in PROTECTED]
        for mount in mounts:
            key = mount.get('source')
            if mount.get('type') != 'volume' or key not in managed:
                continue
            target = mount.get('target', '')
            if (not target.startswith('/') or target.startswith('//') or posixpath.normpath(target) != target
                    or any(overlaps(target, p) for p in protected_paths)
                    or mount.get('volume', {}).get('subpath')):
                raise RuntimeError('Application volume must not hide protected storage or use a subpath: ' + service + '/' + key)
            if (any(other is not mount and overlaps(target, other.get('target', '/')) for other in mounts)
                    or any(overlaps(target, p.split(':', 1)[0]) for p in tmpfs)):
                raise RuntimeError('Application volume overlaps another configured mount: ' + service + '/' + key)
            for c in containers:
                labels = c.get('Config', {}).get('Labels') or {}
                if (labels.get('com.docker.compose.project') != model['name']
                        or labels.get('com.docker.compose.service') != service):
                    continue
                for actual in c.get('Mounts', []):
                    destination = actual.get('Destination', '/')
                    if overlaps(target, destination) and not (destination == target
                            and actual.get('Type') == 'volume' and actual.get('Name') == managed[key]):
                        raise RuntimeError('Application volume would replace or hide an existing mount: ' + service + '/' + key)
