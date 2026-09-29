#!/usr/bin/env python3
import collections
import fnmatch
import heapq
import json
import os
import stat
import subprocess
import time

def checked_root(volume):
    meta = json.loads(subprocess.check_output(['docker', 'volume', 'inspect', volume]))[0]
    expected = '/data/docker/volumes/' + volume + '/_data'
    if meta['Mountpoint'] != expected or meta['Driver'] != 'local' or meta.get('Options'):
        raise SystemExit('Unexpected volume definition; stop: ' + volume)
    root = expected + '/data_hub_raw_media'
    mount = subprocess.check_output(['findmnt', '-rn', '-T', root, '-o', 'SOURCE,FSTYPE'],
                                    universal_newlines=True).split()
    # systemd's exact ReadWritePaths child inside ReadOnlyPaths=/data is a
    # bind mount. findmnt SOURCE then includes the path within the SSD fs.
    # Keep that path meaningful: never strip an arbitrary bracket suffix.
    exact_child = '/dev/nvme0n1p1[' + root[len('/data'):] + ']'
    if (len(mount) != 2 or mount[0] not in ('/dev/nvme0n1p1', exact_child)
            or mount[1] not in ('xfs', 'ext4', 'btrfs')):
        raise SystemExit('Source is not the expected local SSD: ' + repr(mount))
    if os.path.realpath(root) != root:
        raise SystemExit('Source path resolves through a symlink; stop: ' + root)
    device, directory = os.stat('/dev/nvme0n1p1'), os.stat(root)
    if (not stat.S_ISBLK(device.st_mode) or not stat.S_ISDIR(directory.st_mode)
            or directory.st_dev != device.st_rdev):
        raise SystemExit('Source device identity is not the expected local SSD; stop: ' + root)
    return root


def scan_tree(root):
    device = os.stat(root).st_dev
    pending = [root]
    groups = collections.defaultdict(lambda: {'files': 0, 'logical_bytes': 0})
    groups['TOTAL'] = {'files': 0, 'logical_bytes': 0}
    top = []
    errors = []
    error_count = 0
    skipped = 0
    linked = 0
    cutoff = time.time() - 86400
    while pending:
        directory = pending.pop()
        try:
            with os.scandir(directory) as entries:
                for entry in entries:
                    try:
                        st = entry.stat(follow_symlinks=False)
                        if st.st_dev != device or stat.S_ISLNK(st.st_mode):
                            skipped += 1
                            continue
                        if stat.S_ISDIR(st.st_mode):
                            pending.append(entry.path)
                        elif stat.S_ISREG(st.st_mode):
                            relative = os.path.relpath(entry.path, root)
                            group = 'raw-media-temp' if fnmatch.fnmatchcase(entry.name, 'raw-media-*.tmp') else 'other-files'
                            for key in (group, 'TOTAL'):
                                groups[key]['files'] += 1
                                groups[key]['logical_bytes'] += st.st_size
                            if group == 'raw-media-temp' and st.st_mtime < cutoff:
                                groups['temp-older-than-24h']['files'] += 1
                                groups['temp-older-than-24h']['logical_bytes'] += st.st_size
                            linked += int(st.st_nlink > 1)
                            heapq.heappush(top, (st.st_size, relative))
                            if len(top) > 20:
                                heapq.heappop(top)
                    except OSError as exc:
                        error_count += 1
                        if len(errors) < 20:
                            errors.append({'path': entry.path, 'error': str(exc)})
        except OSError as exc:
            error_count += 1
            if len(errors) < 20:
                errors.append({'path': directory, 'error': str(exc)})
    return {'groups': dict(groups),
            'largest_20_logical_bytes_and_paths': sorted(top, reverse=True),
            'skipped_symlinks_or_other_devices': skipped,
            'file_paths_with_multiple_hardlinks': linked, 'error_count': error_count,
            'errors_first_20': errors,
            'note': 'Live metadata snapshot; sizes count each path. Temp age is NOT deletion authorization.'}


def main():
    had_errors = False
    for volume in ('delta_59202_media_data', 'po_infra_media_data'):
        result = scan_tree(checked_root(volume))
        result['volume'] = volume
        print(json.dumps(result, ensure_ascii=False, indent=2), flush=True)
        had_errors = had_errors or result['error_count'] > 0
    if had_errors:
        raise SystemExit('Incomplete metadata scan; review reported errors before using totals.')


if __name__ == '__main__':
    main()
