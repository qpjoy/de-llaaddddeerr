#!/usr/bin/env python3
"""Installed, read-only startup guard for the isolated containerd candidate."""
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import stat
import subprocess
import sys

RECORD = '/etc/mx-k8s-runtime/candidate.json'
UNIT = '/etc/systemd/system/mx-k8s-containerd.service'
SERVICE = 'mx-k8s-containerd.service'
STATE = '/run/mx-k8s-containerd'
ADDRESS = STATE + '/containerd.sock'
ENVIRONMENT = '/etc/mx-k8s-runtime/environment'
GUARD = '/usr/local/lib/mx-k8s-runtime/candidate_guard.py'


class GuardError(RuntimeError):
    pass


def require(ok):
    if not ok:
        raise GuardError('candidate runtime identity/configuration mismatch; raw values hidden')


def safe(path, directory=False, private=False):
    require(isinstance(path, str) and path.startswith('/') and not path.startswith('//') and
            path != '/' and os.path.normpath(path) == path and
            not re.search(r'[\x00-\x20\x7f]', path))
    current = Path('/')
    for part in Path(path).parts[1:]:
        current = current / part
        value = current.lstat()
        final = str(current) == path
        require(value.st_uid == 0 and not value.st_mode & 0o022 and not stat.S_ISLNK(value.st_mode))
        require(stat.S_ISDIR(value.st_mode) if not final or directory else stat.S_ISREG(value.st_mode))
        if final and private:
            require(not value.st_mode & 0o077)
    return value


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result)
        result[key] = value
    return result


def sha(path):
    result = hashlib.sha256()
    with open(path, 'rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def run(args):
    try:
        result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
        require(result.returncode == 0)
        return result.stdout.decode('utf-8')
    except (OSError, subprocess.TimeoutExpired, UnicodeError):
        raise GuardError('candidate guard command unavailable; raw output hidden') from None


def verify(record_path=RECORD):
    safe(record_path, private=True)
    with open(record_path) as stream:
        record = json.load(stream, object_pairs_hook=unique_object)
    require(isinstance(record, dict))
    require(type(record['schema_version']) is int and record['schema_version'] == 1 and
            record['phase'] in ('starting', 'importing', 'ready') and
            record['hostname'] == socket.gethostname() and record['service'] == SERVICE and
            record['state'] == STATE and record['address'] == ADDRESS)
    prepared = record['prepared_directory']
    require(isinstance(prepared, str) and
            re.fullmatch(r'/var/lib/mx-move/k8s-runtime-prep/mx-k8s-[0-9]{8}-[0-9]{6}-[a-f0-9]{8}', prepared))
    require(record['root'] == prepared + '/data' and record['config_path'] == prepared + '/containerd.toml')
    require(record['unit_path'] == UNIT and record['environment_path'] == ENVIRONMENT and record['guard_path'] == GUARD)
    identity = record['root_identity']
    require(isinstance(identity, dict) and set(identity) == {'device', 'inode'} and
            type(identity['device']) is int and identity['device'] >= 0 and
            type(identity['inode']) is int and identity['inode'] > 0)
    root = safe(record['root'], directory=True, private=True)
    require({'device': root.st_dev, 'inode': root.st_ino} == record['root_identity'])
    for key in ('config', 'environment', 'unit', 'binary', 'guard'):
        path = record[key + '_path']
        digest = record[key + '_sha256']
        require(isinstance(digest, str) and re.fullmatch(r'[a-f0-9]{64}', digest))
        safe(path, private=key in ('config', 'environment'))
        require(sha(path) == digest)
    require(isinstance(record['filesystem_uuid'], str) and
            re.fullmatch(r'[a-fA-F0-9]{8}-(?:[a-fA-F0-9]{4}-){3}[a-fA-F0-9]{12}', record['filesystem_uuid']))
    for path in (record['root'], '/'):
        result = json.loads(run(['findmnt', '--json', '--target', path, '--output', 'TARGET,FSTYPE,UUID,OPTIONS']),
                            object_pairs_hook=unique_object)
        require(isinstance(result, dict))
        mounts = result['filesystems']
        require(isinstance(mounts, list) and len(mounts) == 1 and isinstance(mounts[0], dict))
        mount = mounts[0]
        require(mount['uuid'] == record['filesystem_uuid'] and mount['fstype'] in ('xfs', 'ext4') and
                isinstance(mount['options'], str) and 'rw' in mount['options'].split(','))
    if os.path.lexists(STATE):
        safe(STATE, directory=True)
    unit = unique_object(line.split('=', 1) for line in run(['systemctl', 'show', SERVICE, '-p', 'FragmentPath',
                         '-p', 'DropInPaths', '-p', 'NeedDaemonReload']).splitlines() if '=' in line)
    require(unit.get('FragmentPath') == UNIT and not unit.get('DropInPaths') and unit.get('NeedDaemonReload') == 'no')
    return record


def main():
    try:
        require(sys.platform.startswith('linux') and os.geteuid() == 0 and len(sys.argv) == 1)
        verify()
    except Exception:
        # Configuration and command failures, including malformed nested JSON,
        # must never print raw values or Python tracebacks to the service log.
        print('mx-k8s runtime startup guard refused: identity/configuration unavailable or changed; no fallback runtime', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
