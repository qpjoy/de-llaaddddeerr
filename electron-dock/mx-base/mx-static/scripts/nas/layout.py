#!/usr/bin/env python3
"""Bounded, read-only layout inventory. Never creates a destination directory."""
import itertools
import json
import os
import socket
import stat
import subprocess

NAS_MOUNT = '/mnt/nas'
HOST_ROOT = NAS_MOUNT + '/mx-internal-server'
MEDIA_ROOT = HOST_ROOT + '/data/docker/media-volumes'
EXPORTS = {'nas-storage:/volume1/data1', '192.168.1.3:/volume1/data1'}
VOLUMES = ('delta_59202_media_data', 'po_infra_media_data')
MAX_NAMES = 50


def inspect_path(path, list_names=False):
    # Check each component with lstat: an old symlink is evidence, not an alias
    # through which to inspect another tree or propose a copy destination.
    cursor = '/'
    try:
        for part in path.strip('/').split('/'):
            cursor = os.path.join(cursor, part)
            info = os.lstat(cursor)
            if stat.S_ISLNK(info.st_mode):
                return {'path': path, 'status': 'symlink-component-skipped', 'component': cursor}
        result = {'path': path, 'status': 'exists', 'uid': info.st_uid, 'gid': info.st_gid,
                  'mode': oct(stat.S_IMODE(info.st_mode)), 'device': info.st_dev,
                  'directory': stat.S_ISDIR(info.st_mode)}
        if list_names and result['directory']:
            with os.scandir(path) as entries:
                names = [e.name for e in itertools.islice(entries, MAX_NAMES + 1)]
            result['sample_names'] = sorted(names[:MAX_NAMES])
            result['sample_truncated'] = len(names) > MAX_NAMES
        return result
    except FileNotFoundError:
        return {'path': path, 'status': 'missing', 'first_missing_component': cursor}
    except OSError as exc:
        return {'path': path, 'status': 'unavailable', 'error': str(exc)}


def expected_mount(output):
    rows = [line.split() for line in output.splitlines() if line.strip()]
    return (len(rows) == 1 and len(rows[0]) == 3 and rows[0][0] == NAS_MOUNT
            and rows[0][1] in EXPORTS and rows[0][2] in ('nfs', 'nfs4'))


def main():
    print(json.dumps({'host': socket.gethostname(),
                      'local_paths': [inspect_path(p, True) for p in ('/data', '/data/docker', '/data/k8s')]},
                     ensure_ascii=False, indent=2), flush=True)
    # findmnt reads the mount table; it does not trigger an automount by walking
    # /mnt/nas. Only inspect remote paths after an actual NFS mount is verified.
    proc = subprocess.run(['findmnt', '-rn', '-M', NAS_MOUNT, '-t', 'nfs,nfs4',
                           '-o', 'TARGET,SOURCE,FSTYPE'], stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, universal_newlines=True, timeout=15)
    if proc.returncode or not expected_mount(proc.stdout):
        raise SystemExit('Refused NAS traversal: /mnt/nas is not the expected mounted NFS export.')
    print(json.dumps({'verified_mount': proc.stdout.strip(),
                      'next': 'Read fixed NAS paths only. Hard NFS can wait; do not launch duplicate scans.'}),
          flush=True)
    capacity = os.statvfs(NAS_MOUNT)
    print(json.dumps({'filesystem_capacity_bytes': {
        'total': capacity.f_blocks * capacity.f_frsize,
        'available_to_caller': capacity.f_bavail * capacity.f_frsize,
    }}), flush=True)
    paths = [HOST_ROOT, HOST_ROOT + '/data', HOST_ROOT + '/data/docker', MEDIA_ROOT]
    for path in paths:
        print(json.dumps(inspect_path(path, True), ensure_ascii=False, indent=2), flush=True)
    for path in (HOST_ROOT + '/shared_archives', HOST_ROOT + '/shared_dir',
                 HOST_ROOT + '/shared_media', HOST_ROOT + '/data/k8s',
                 HOST_ROOT + '/data/mx-static'):
        print(json.dumps(inspect_path(path), ensure_ascii=False, indent=2), flush=True)
    for volume in VOLUMES:
        path = MEDIA_ROOT + '/' + volume + '/data_hub_raw_media'
        result = inspect_path(path)
        result['role'] = 'proposed raw-media target; do not reuse an existing directory without review'
        print(json.dumps(result, ensure_ascii=False, indent=2), flush=True)
    print(json.dumps({'copy_readiness': 'not-established',
                      'note': 'Existence/mode do not prove write permission, identity, quota, backup or application readiness.'}))


if __name__ == '__main__':
    main()
