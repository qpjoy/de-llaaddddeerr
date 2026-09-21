#!/usr/bin/env python3
"""Read local route/NIC/kernel NFS state; no NAS file access or traffic test."""
import json
import os
import re
import subprocess
import sys

NAS_IP = '192.168.1.3'
INTERFACE_NAME = re.compile(r'[A-Za-z0-9_.:-]{1,64}')


def run(arguments):
    try:
        result = subprocess.run(arguments, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                universal_newlines=True, timeout=3)
        return {'exit': result.returncode, 'stdout': result.stdout[:12000],
                'stderr': result.stderr[:1000]}
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {'available': False, 'error_type': type(exc).__name__}


def read_local(path):
    try:
        with open(path) as stream:
            return stream.read(4096).strip()
    except OSError as exc:
        return {'available': False, 'error_type': type(exc).__name__}


def nfs_mountstats():
    lines = []
    try:
        # /proc is local kernel state, not stat/open of the mounted NAS path.
        with open('/proc/self/mountstats') as stream:
            for index, line in enumerate(stream):
                if index >= 20000:
                    return {'truncated': True, 'lines': lines}
                if line.startswith('device '):
                    if lines:
                        break
                    if ' mounted on /mnt/nas with fstype nfs' in line:
                        lines.append(line.rstrip())
                elif lines:
                    if len(lines) >= 100:
                        return {'truncated': True, 'lines': lines}
                    lines.append(line.rstrip())
        return {'found': bool(lines), 'lines': lines,
                'note': 'Counters are cumulative since mount, not specific to the previous copy test.'}
    except OSError as exc:
        return {'available': False, 'error_type': type(exc).__name__}


def main():
    route = run(['ip', '-o', 'route', 'get', NAS_IP])
    match = re.search(r'\bdev\s+(\S+)', route.get('stdout', ''))
    pending = [match.group(1)] if route.get('exit') == 0 and match else []
    interfaces, seen = [], set()
    while pending and len(interfaces) < 8:
        name = pending.pop(0)
        if name in seen or not INTERFACE_NAME.fullmatch(name) or name in ('.', '..'):
            continue
        seen.add(name)
        base = '/sys/class/net/' + name
        try:
            lowers = sorted(entry[len('lower_'):] for entry in os.listdir(base)
                            if entry.startswith('lower_'))
        except OSError:
            lowers = []
        interfaces.append({
            'name': name, 'lower_interfaces': lowers,
            'sysfs': {field: read_local(base + '/' + field)
                      for field in ('speed', 'duplex', 'mtu', 'operstate', 'bonding/slaves')},
            'counters': {field: read_local(base + '/statistics/' + field)
                         for field in ('rx_bytes', 'tx_bytes', 'rx_errors', 'tx_errors',
                                       'rx_dropped', 'tx_dropped')},
            'ethtool': run(['ethtool', name]),
        })
        pending.extend(lowers)
    print(json.dumps({
        'python': sys.version.split()[0], 'nas_ip': NAS_IP, 'route': route,
        'interfaces': interfaces, 'interface_limit_reached': bool(pending),
        'nfs_mountstats': nfs_mountstats(),
        'note': 'Read-only local snapshot. No remount, tuning, NAS scan, copy, iperf or service restart. '
                'NIC link speed is not end-to-end NAS throughput; bond members do not imply one-flow aggregation.',
    }, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
