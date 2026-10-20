#!/usr/bin/env python3
"""Read-only resolver for an explicitly activated, managed Kubernetes runtime.

Standalone Python 3.6+ helper intended for /usr/local/lib/mx-k8s-runtime/resolve.py.
Never install it, publish active.json, or select a legacy fallback from here.

/etc/mx-k8s-runtime/active.json schema (all fields required):
  schema_version: 1, phase: "active", hostname: local hostname,
  filesystem_uuid: UUID of / and root, address/root/state: absolute paths,
  service: "mx-k8s-containerd.service", config_path: absolute private TOML,
  config_sha256: lowercase SHA256, kubelet_config_path: absolute kubelet YAML.
Descriptor mode must be 0644/root, TOML 0600/root; ancestors must be protected.

CLI prints exactly one validated field: address|root|service|cri-endpoint.
--allow-stopped-kubelet is restricted to root/service during start recovery.
Stopped services may then be resolved from protected files. Running processes
are always checked. No raw command output, configuration, or exception appears
in diagnostics. The installer guarantees the fixed helper path is a protected
root-owned regular file beneath protected ancestors, as for a system program.
Wrappers treat descriptor existence (including a symlink) as managed mode and
fail if the helper is missing or exits unsuccessfully; they do not fall back.
Wrappers suppress raw helper stderr, since damaged Python can fail before main.
"""

import argparse
import hashlib
import json
import os
import posixpath
import re
import stat
import subprocess
import sys


DESCRIPTOR = '/etc/mx-k8s-runtime/active.json'
SERVICE = 'mx-k8s-containerd.service'
FIELDS = ('address', 'root', 'service', 'cri-endpoint')
REASONS = frozenset(('descriptor', 'permissions', 'config', 'filesystem',
                     'runtime', 'kubelet', 'socket', 'arguments', 'unavailable'))


class Refuse(RuntimeError):
    def __init__(self, reason):
        self.reason = reason if reason in REASONS else 'unavailable'
        super(Refuse, self).__init__('managed Kubernetes runtime unavailable: ' + self.reason)


def require(condition, reason):
    if not condition:
        raise Refuse(reason)


def absolute(value):
    require(isinstance(value, str) and re.fullmatch(r'/[A-Za-z0-9_./-]+', value)
            and posixpath.normpath(value) == value and value != '/', 'descriptor')
    return value


def endpoint(value):
    require(isinstance(value, str), 'config')
    if value.startswith('unix://'):
        value = value[7:]
    return absolute(value)


def string(raw):
    try:
        if raw.startswith('"'):
            value = json.loads(raw)
        elif raw.startswith("'") and raw.endswith("'") and "'" not in raw[1:-1]:
            value = raw[1:-1]
        else:
            raise Refuse('config')
    except (ValueError, TypeError):
        raise Refuse('config') from None
    require(isinstance(value, str), 'config')
    return value


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'descriptor')
        result[key] = value
    return result


def config_paths(text):
    """Read only canonical root/state/grpc address; no imports or execution."""
    section, result = (), {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        if line.startswith('['):
            require(line.endswith(']') and not line.startswith('[['), 'config')
            section = line[1:-1]
            continue
        match = re.fullmatch(r'([A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*")\s*=\s*(.*)', line)
        require(match is not None, 'config')
        key, raw = match.groups()
        key = key.strip('"')
        wanted = key if not section and key in ('root', 'state') else 'address' if section in ('grpc', '"grpc"') and key == 'address' else None
        if not section and key == 'imports':
            require(raw == '[]', 'config')
        if wanted:
            require(wanted not in result, 'config')
            result[wanted] = absolute(string(raw))
    require(set(result) == {'root', 'state', 'address'}, 'config')
    return result


def kubelet_endpoint(text):
    values = []
    for line in text.splitlines():
        if line.strip() in ('---', '...') or re.match(r'^(<<:|[\[{])', line) or '\t' in line:
            raise Refuse('kubelet')
        match = re.match(r'^containerRuntimeEndpoint:\s*(.*?)\s*$', line)
        if match:
            raw = match.group(1)
            # Canonical kubelet config uses one scalar, with no aliases/merges.
            if raw.startswith(('"', "'")):
                parsed = string(raw)
            else:
                parsed = raw.split(' #', 1)[0].strip()
            values.append(endpoint(parsed))
    require(len(values) == 1, 'kubelet')
    return values[0]


def flags(argv, aliases):
    result = {}
    index = 1
    while index < len(argv):
        item = argv[index]
        key, separator, value = item.partition('=')
        if key in aliases:
            if not separator:
                index += 1
                require(index < len(argv), 'config')
                value = argv[index]
            name = aliases[key]
            require(name not in result and value, 'config')
            result[name] = endpoint(value) if name == 'address' else absolute(value)
        index += 1
    return result


class System:
    def lstat(self, path):
        return os.lstat(path)

    def stat(self, path):
        return os.stat(path)

    def readlink(self, path):
        return os.readlink(path)

    def read_file(self, path):
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, 'rb') as stream:
            info = os.fstat(stream.fileno())
            require(stat.S_ISREG(info.st_mode) and info.st_size <= 4 * 1024 * 1024, 'permissions')
            return stream.read(4 * 1024 * 1024 + 1), info

    def proc_args(self, pid):
        with open('/proc/{}/cmdline'.format(pid), 'rb') as stream:
            raw = stream.read(1024 * 1024)
        return raw.decode('utf-8').rstrip('\x00').split('\x00')

    def hostname(self):
        return os.uname().nodename

    def run(self, args):
        result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=15)
        require(result.returncode == 0 and len(result.stdout) < 1024 * 1024, 'unavailable')
        return result.stdout.decode('utf-8')

    def service(self, name):
        raw = self.run(['systemctl', 'show', name, '--property=LoadState', '--property=ActiveState', '--property=MainPID'])
        values = dict(line.split('=', 1) for line in raw.splitlines() if '=' in line)
        require(values.get('LoadState') == 'loaded', 'runtime')
        return values.get('ActiveState'), values.get('MainPID')

    def filesystem_uuid(self, path):
        raw = self.run(['findmnt', '--json', '--target', path, '--output', 'UUID'])
        rows = json.loads(raw).get('filesystems', [])
        require(len(rows) == 1 and isinstance(rows[0].get('uuid'), str), 'filesystem')
        return rows[0]['uuid']


class Resolver:
    def __init__(self, system=None):
        self.system = system or System()

    def protected_directory(self, path, allow_missing=False):
        current = '/'
        root = self.system.lstat(current)
        require(stat.S_ISDIR(root.st_mode) and root.st_uid == 0 and not root.st_mode & 0o022, 'permissions')
        for part in path.split('/'):
            if not part:
                continue
            current = posixpath.join(current, part)
            try:
                info = self.system.lstat(current)
            except FileNotFoundError:
                require(allow_missing, 'permissions')
                return
            require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022, 'permissions')

    def protected_file(self, path, mode=None):
        self.protected_directory(posixpath.dirname(path))
        raw, info = self.system.read_file(path)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022, 'permissions')
        if mode is not None:
            require(stat.S_IMODE(info.st_mode) == mode, 'permissions')
        require(len(raw) <= 4 * 1024 * 1024, 'permissions')
        return raw

    def socket(self, path):
        self.protected_directory(posixpath.dirname(path))
        info = self.system.stat(path)
        require(stat.S_ISSOCK(info.st_mode) and info.st_uid == 0, 'socket')
        return info.st_dev, info.st_ino

    def process(self, pid, expected_name):
        require(isinstance(pid, str) and re.fullmatch(r'[1-9][0-9]*', pid), 'runtime')
        executable = self.system.readlink('/proc/{}/exe'.format(pid))
        require(posixpath.basename(executable) == expected_name, 'runtime')
        absolute(executable)
        self.protected_directory(posixpath.dirname(executable))
        info = self.system.stat(executable)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022
                and info.st_mode & 0o111, 'permissions')
        return self.system.proc_args(pid)

    def resolve(self, field, allow_stopped=False):
        require(field in FIELDS and (not allow_stopped or field in ('root', 'service')), 'arguments')
        raw = self.protected_file(DESCRIPTOR, 0o644)
        descriptor = json.loads(raw.decode('utf-8'), object_pairs_hook=unique_object)
        required = {'schema_version', 'phase', 'hostname', 'filesystem_uuid', 'address', 'root',
                    'state', 'service', 'config_path', 'config_sha256', 'kubelet_config_path'}
        require(isinstance(descriptor, dict) and set(descriptor) == required, 'descriptor')
        require(type(descriptor['schema_version']) is int and descriptor['schema_version'] == 1
                and descriptor['phase'] == 'active' and descriptor['service'] == SERVICE
                and descriptor['hostname'] == self.system.hostname(), 'descriptor')
        require(isinstance(descriptor['config_sha256'], str) and re.fullmatch(r'[a-f0-9]{64}', descriptor['config_sha256'])
                and isinstance(descriptor['filesystem_uuid'], str)
                and re.fullmatch(r'[A-Za-z0-9-]{8,80}', descriptor['filesystem_uuid']), 'descriptor')
        for key in ('root', 'state', 'address', 'config_path', 'kubelet_config_path'):
            absolute(descriptor[key])
        require(descriptor['address'].startswith(descriptor['state'] + '/')
                and not descriptor['root'].startswith(descriptor['state'] + '/')
                and not descriptor['state'].startswith(descriptor['root'] + '/')
                and descriptor['state'] != descriptor['root'], 'descriptor')
        self.protected_directory(descriptor['root'])
        self.protected_directory(descriptor['state'], allow_missing=allow_stopped)
        require(self.system.filesystem_uuid('/') == descriptor['filesystem_uuid']
                and self.system.filesystem_uuid(descriptor['root']) == descriptor['filesystem_uuid'], 'filesystem')
        config = self.protected_file(descriptor['config_path'], 0o600)
        require(hashlib.sha256(config).hexdigest() == descriptor['config_sha256'], 'config')
        paths = config_paths(config.decode('utf-8'))
        require(all(paths[key] == descriptor[key] for key in ('root', 'state', 'address')), 'config')
        kubelet_config = self.protected_file(descriptor['kubelet_config_path']).decode('utf-8')
        runtime_status, runtime_pid = self.system.service(SERVICE)
        kubelet_status, kubelet_pid = self.system.service('kubelet.service')
        runtime_running = runtime_status == 'active'
        kubelet_running = kubelet_status == 'active'
        require(allow_stopped or (runtime_running and kubelet_running), 'runtime')
        require(runtime_running or runtime_status in ('inactive', 'failed'), 'runtime')
        require(kubelet_running or kubelet_status in ('inactive', 'failed'), 'kubelet')
        require(runtime_running or runtime_pid == '0', 'runtime')
        require(kubelet_running or kubelet_pid == '0', 'kubelet')
        runtime_socket = None
        if runtime_running:
            argv = self.process(runtime_pid, 'containerd')
            actual = flags(argv, {'--config': 'config', '-c': 'config', '--root': 'root', '--state': 'state',
                                  '--address': 'address', '-a': 'address'})
            require(actual.get('config', '/etc/containerd/config.toml') == descriptor['config_path'], 'runtime')
            require(all(actual.get(key, paths[key]) == descriptor[key] for key in ('root', 'state', 'address')), 'runtime')
            runtime_socket = self.socket(descriptor['address'])
        if kubelet_running:
            require(runtime_running, 'runtime')
            argv = self.process(kubelet_pid, 'kubelet')
            actual = flags(argv, {'--config': 'config', '--container-runtime-endpoint': 'address'})
            require(actual.get('config') == descriptor['kubelet_config_path'], 'kubelet')
            effective = actual['address'] if 'address' in actual else kubelet_endpoint(kubelet_config)
            require(self.socket(effective) == runtime_socket, 'kubelet')
        else:
            require(kubelet_endpoint(kubelet_config) == descriptor['address'], 'kubelet')
        # Detect service PID changes during resolution instead of returning a stale result.
        require(self.system.service(SERVICE) == (runtime_status, runtime_pid)
                and self.system.service('kubelet.service') == (kubelet_status, kubelet_pid), 'runtime')
        return 'unix://' + descriptor['address'] if field == 'cri-endpoint' else descriptor[field]


def main(argv=None):
    parser = argparse.ArgumentParser(description='Resolve a validated managed Kubernetes runtime; no legacy fallback.')
    parser.add_argument('field', choices=FIELDS)
    parser.add_argument('--allow-stopped-kubelet', action='store_true')
    args = parser.parse_args(argv)
    try:
        print(Resolver().resolve(args.field, args.allow_stopped_kubelet))
        return 0
    except Refuse as error:
        reason = error.reason
    except (OSError, ValueError, TypeError, KeyError, UnicodeError, subprocess.SubprocessError):
        reason = 'unavailable'
    print('managed Kubernetes runtime unavailable: ' + reason, file=sys.stderr)
    return 2


if __name__ == '__main__':
    sys.exit(main())
