#!/usr/bin/env python3
"""Standalone, read-only guard for the five selected Kubernetes data binds.

The installed copy has no repository imports. It never repairs a mount or creates
an application directory. Database identifiers are stable, unlike file checksums.
"""
import json
import os
from pathlib import Path
import re
import socket
import stat
import subprocess
import sys

RECORD = '/etc/mx-k8s-runtime/storage.json'
DATA_BASE = '/var/lib/mx-move/k8s-data'
ROOTS = {'kubelet': '/var/lib/kubelet', 'launcher': '/var/lib/mx-launcher',
         'common': '/data/k8s/mx-runtime/mx-common/k8s', 'rig': '/data/mx-rig',
         'pay-postgres': '/data/mx-pay/mx-pay/postgres'}
PG_PATHS = {'launcher': 'k8s/postgres/pgdata', 'common': 'postgres/data/pgdata',
            'rig': 'postgres/pgdata', 'pay-postgres': 'pgdata'}


class StorageError(RuntimeError):
    pass


def require(ok, message='Kubernetes storage identity mismatch; raw values hidden'):
    if not ok:
        raise StorageError(message)


def canonical(path):
    require(isinstance(path, str) and re.fullmatch(r'/[A-Za-z0-9_./-]*', path) and
            not path.startswith('//') and os.path.normpath(path) == path)
    return Path(path)


def identity(info):
    return {'device': info.st_dev, 'inode': info.st_ino}


def path_info(path, data_leaf=False, protected=True):
    """Root protects the path; the selected application leaf may own its data.

    /data is the pre-existing shared filesystem root, not an application parent.
    Its owner may differ, but it and all ancestors must not be writable by others.
    """
    path = canonical(str(path))
    current = Path('/')
    for part in ('',) + path.parts[1:]:
        if part:
            current /= part
        info = current.lstat()
        require(not stat.S_ISLNK(info.st_mode))
        final = current == path
        require(stat.S_ISDIR(info.st_mode) if not final else
                stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode))
        if protected and not (final and data_leaf):
            require((info.st_uid == 0 or current == Path('/data')) and not info.st_mode & 0o022)
    return info


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result)
        result[key] = value
    return result


def read_record(path=RECORD):
    before = path_info(path)
    require(stat.S_ISREG(before.st_mode) and not before.st_mode & 0o077)
    fd = os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW)
    try:
        require(identity(os.fstat(fd)) == identity(before))
        with os.fdopen(fd, 'rb') as stream:
            fd = None
            raw = stream.read(65537)
        require(len(raw) <= 65536)
        return json.loads(raw.decode(), object_pairs_hook=unique_object)
    finally:
        if fd is not None:
            os.close(fd)


def run(args):
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
    require(result.returncode == 0, 'Kubernetes storage inspection failed; raw output hidden')
    return result.stdout


def mount(path, runner=run):
    result = json.loads(runner(['findmnt', '--json', '--target', str(path), '--output',
                               'TARGET,SOURCE,FSTYPE,UUID,FSROOT,OPTIONS']), object_pairs_hook=unique_object)
    require(isinstance(result, dict) and isinstance(result.get('filesystems'), list) and
            len(result['filesystems']) == 1 and isinstance(result['filesystems'][0], dict))
    value = result['filesystems'][0]
    require(isinstance(value.get('uuid'), str) and value['uuid'] and
            value.get('fstype') in ('xfs', 'ext4') and isinstance(value.get('options'), str) and
            'rw' in value['options'].split(',') and 'ro' not in value['options'].split(','))
    canonical(value.get('target'))
    canonical(value.get('fsroot'))
    return value


def pg_identity(root):
    root = canonical(str(root))
    info = path_info(root, protected=False)
    require(stat.S_ISDIR(info.st_mode))
    for relative in ('PG_VERSION', 'global/pg_control'):
        child = path_info(root / relative, protected=False)
        require(stat.S_ISREG(child.st_mode) and child.st_size > 0)
    version = (root / 'PG_VERSION').read_text().strip()
    require(version in ('16', '17'))
    with (root / 'global/pg_control').open('rb') as stream:
        identifier = stream.read(8)
    require(len(identifier) == 8 and identifier != b'\x00' * 8)
    # WAL/tablespaces outside the selected root require a separate migration.
    require(not (root / 'pg_wal').is_symlink())
    require((root / 'pg_tblspc').is_dir() and not (root / 'pg_tblspc').is_symlink())
    require(not any(item.is_symlink() for item in (root / 'pg_tblspc').iterdir()))
    return {'version': version, 'control_first8_hex': identifier.hex()}


def validate_record(record):
    require(isinstance(record, dict) and type(record.get('schema_version')) is int and
            record['schema_version'] == 1 and record.get('phase') == 'active' and
            record.get('hostname') == socket.gethostname())
    require(isinstance(record.get('transaction'), str) and re.fullmatch(
        r'mx-k8s-[0-9]{8}-[0-9]{6}-[a-f0-9]{8}', record['transaction']))
    require(isinstance(record.get('root_uuid'), str) and re.fullmatch(
        r'[a-fA-F0-9]{8}-(?:[a-fA-F0-9]{4}-){3}[a-fA-F0-9]{12}', record['root_uuid']))
    entries = record.get('entries')
    require(isinstance(entries, list) and len(entries) == len(ROOTS) and
            all(isinstance(e, dict) for e in entries) and
            set(e.get('key') for e in entries) == set(ROOTS))
    for entry in entries:
        key = entry['key']
        require(entry.get('logical') == ROOTS[key] and entry.get('target') ==
                DATA_BASE + '/' + record['transaction'] + '/' + key and
                entry.get('target_fsroot') == entry['target'])
        ident = entry.get('target_identity')
        require(isinstance(ident, dict) and set(ident) == {'device', 'inode'} and
                type(ident['device']) is int and ident['device'] >= 0 and
                type(ident['inode']) is int and ident['inode'] > 0)
        if key in PG_PATHS:
            pg = entry.get('postgres')
            require(isinstance(pg, dict) and pg.get('version') in ('16', '17') and
                    isinstance(pg.get('control_first8_hex'), str) and
                    re.fullmatch(r'[a-f0-9]{16}', pg['control_first8_hex']))
    return entries


def verify(record_path=RECORD, findmnt=None):
    record = read_record(record_path)
    entries = validate_record(record)
    get_mount = findmnt or mount
    root = get_mount('/')
    require(root['target'] == '/' and root['fsroot'] == '/' and root['uuid'] == record['root_uuid'])
    for entry in entries:
        logical, target = entry['logical'], entry['target']
        original = path_info(target, data_leaf=True)
        active = path_info(logical, data_leaf=True)
        require(stat.S_ISDIR(original.st_mode) and stat.S_ISDIR(active.st_mode) and
                identity(original) == entry['target_identity'] == identity(active))
        backing, selected = get_mount(target), get_mount(logical)
        require(backing['target'] == '/' and backing['fsroot'] == '/' and
                backing['uuid'] == selected['uuid'] == record['root_uuid'] and
                selected['target'] == logical and selected['fsroot'] == entry['target_fsroot'])
        if entry['key'] in PG_PATHS:
            require(pg_identity(Path(logical) / PG_PATHS[entry['key']]) == entry['postgres'])
    return record


def main():
    try:
        require(sys.platform.startswith('linux') and os.geteuid() == 0 and len(sys.argv) == 1)
        verify()
    except Exception:
        print('mx-k8s storage startup guard refused: selected data mounts or database identities changed; no empty-directory fallback', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
