"""Offline, conservative cloning of canonical containerd 1.6 config dumps.

clone_config returns {'config_text': sensitive TOML, 'metadata': safe summary}.
The caller must keep config_text private (0600), never log it, verify it with the
same containerd binary's `config dump`, and audit the host before starting it.
This module performs no I/O and does not claim that starting a clone is safe.

Canonical one-line assignments/tables from containerd's TOML encoder are the
only accepted syntax. Unknown ordinary settings survive byte-for-byte; unknown
plugins, listeners or writable locations fail closed. Registry configuration
is retained privately, including authentication and certificate paths.

Upstream 1.6 references:
https://github.com/containerd/containerd/blob/release/1.6/services/server/config/config.go
https://github.com/containerd/containerd/blob/release/1.6/cmd/containerd/command/main.go
https://github.com/containerd/containerd/blob/v1.6.32/docs/cri/config.md
"""

import json
import posixpath
import re


CRI = 'io.containerd.grpc.v1.cri'
ERROR = 'unsupported containerd configuration; raw values hidden'
PATH_ERROR = 'unsupported isolated runtime paths; raw values hidden'


class ConfigError(ValueError):
    """A fixed, safe-to-report error; never contains source configuration."""

    REASONS = frozenset(('unsupported', 'syntax', 'profile', 'plugin',
                         'external_path', 'listener', 'target_path'))

    def __init__(self, message=ERROR, reason='unsupported'):
        self.reason = reason if reason in self.REASONS else 'unsupported'
        # Never trust a caller-supplied message as safe diagnostic content.
        super(ConfigError, self).__init__(PATH_ERROR if message == PATH_ERROR else ERROR)


BUILTINS = {
    'io.containerd.gc.v1.scheduler', CRI, 'io.containerd.internal.v1.opt',
    'io.containerd.internal.v1.restart', 'io.containerd.internal.v1.tracing',
    'io.containerd.metadata.v1.bolt', 'io.containerd.monitor.v1.cgroups',
    'io.containerd.runtime.v1.linux', 'io.containerd.runtime.v2.task',
    'io.containerd.service.v1.diff-service', 'io.containerd.service.v1.tasks-service',
    'io.containerd.snapshotter.v1.aufs', 'io.containerd.snapshotter.v1.btrfs',
    'io.containerd.snapshotter.v1.devmapper', 'io.containerd.snapshotter.v1.native',
    'io.containerd.snapshotter.v1.overlayfs', 'io.containerd.snapshotter.v1.zfs',
    'io.containerd.tracing.processor.v1.otlp',
}
TOP_SECTIONS = {'grpc', 'ttrpc', 'debug', 'metrics', 'cgroup', 'plugins',
                'proxy_plugins', 'stream_processors', 'timeouts'}
DECODERS = {'io.containerd.ocicrypt.decoder.v1.tar',
            'io.containerd.ocicrypt.decoder.v1.tar.gzip'}


def _string(raw):
    try:
        if raw.startswith('"'):
            value = json.loads(raw)
        elif raw.startswith("'") and raw.endswith("'") and "'" not in raw[1:-1]:
            value = raw[1:-1]
        else:
            raise ValueError()
        if not isinstance(value, str) or '\x00' in value:
            raise ValueError()
        return value
    except (ValueError, TypeError):
        raise ConfigError(reason='syntax') from None


def _parts(raw):
    """Parse a canonical TOML table path without interpreting arbitrary TOML."""
    pattern = r'(?:"(?:[^"\\]|\\.)*"|\'[^\']*\'|[A-Za-z0-9_-]+)'
    tokens = re.findall(pattern, raw)
    if '.'.join(tokens) != raw:
        raise ConfigError(reason='syntax')
    return tuple(_string(t) if t[:1] in ('"', "'") else t for t in tokens)


def _parse(raw):
    if not isinstance(raw, str) or len(raw) > 4 * 1024 * 1024 or '\x00' in raw:
        raise ConfigError(reason='syntax')
    section = ()
    entries = {}
    sections = {()}
    lines = raw.splitlines(True)
    for index, line in enumerate(lines):
        stripped = line.strip()
        if not stripped or stripped.startswith('#'):
            continue
        if stripped.startswith('['):
            if not stripped.endswith(']') or stripped.startswith('[['):
                raise ConfigError(reason='syntax')
            section = _parts(stripped[1:-1])
            if section in sections or section[0] not in TOP_SECTIONS:
                raise ConfigError(reason='syntax')
            sections.add(section)
            continue
        match = re.fullmatch(r'\s*([A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*")\s*=\s*(.*?)\s*', line.rstrip('\r\n'))
        if not match:
            raise ConfigError(reason='syntax')
        key = _string(match.group(1)) if match.group(1).startswith('"') else match.group(1)
        value = match.group(2)
        # A multiline string or array might hide a table/listener from this parser.
        if (not value or value.startswith(('"""', "'''")) or
                (value.startswith('[') and not value.endswith(']'))):
            raise ConfigError(reason='syntax')
        if value.startswith(('"', "'")):
            _string(value)
        elif not (re.fullmatch(r'(true|false|[+-]?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)', value)
                  or (value.startswith('[') and value.endswith(']'))):
            raise ConfigError(reason='syntax')
        identity = (section, key)
        if identity in entries:
            raise ConfigError(reason='syntax')
        entries[identity] = (index, value)
    return lines, entries, sections


def _path(value):
    if (not isinstance(value, str) or not re.fullmatch(r'/[A-Za-z0-9_./-]+', value)
            or posixpath.normpath(value) != value or value in ('/', '/run', '/var', '/var/lib')):
        raise ConfigError(PATH_ERROR, reason='target_path')
    return value


def _within(path, root):
    return path == root or path.startswith(root + '/')


def clone_config(raw_dump, target_root, state, address):
    """Return private clone text and safe allowlisted metadata, without I/O.

    Supported profile: config v2, built-in overlayfs, the sole CRI runc handler
    using io.containerd.runc.v2 and SystemdCgroup=true. Unsupported profiles
    need explicit review rather than silently falling back to defaults.
    """
    target_root, state, address = map(_path, (target_root, state, address))
    if (_within(target_root, state) or _within(state, target_root)
            or not address.startswith(state + '/') or len(address.encode('utf-8')) > 100):
        raise ConfigError(PATH_ERROR, reason='target_path')
    lines, entries, sections = _parse(raw_dump)

    def value(section, key, required=True):
        found = entries.get((section, key))
        if found is None:
            if required:
                raise ConfigError(reason='profile')
            return None
        return found[1]

    def string(section, key, required=True):
        raw = value(section, key, required)
        return _string(raw) if raw is not None else None

    source_root = _path(string((), 'root'))
    source_state = _path(string((), 'state'))
    source_address = _path(string(('grpc',), 'address'))
    cri = ('plugins', CRI)
    containerd = cri + ('containerd',)
    runtime = containerd + ('runtimes', 'runc')
    options = runtime + ('options',)
    opt = ('plugins', 'io.containerd.internal.v1.opt')
    # The executor invokes this again on the real binary's normalized dump.
    # Accept that exact isolated identity only when its auxiliary roots match.
    already_isolated = (source_root == target_root and source_state == state
                        and source_address == address and string(options, 'Root', False) == state + '/runc'
                        and string(opt, 'path', False) == target_root + '/opt')
    if not already_isolated:
        for proposed in (target_root, state):
            for original in (source_root, source_state):
                if _within(proposed, original) or _within(original, proposed):
                    raise ConfigError(PATH_ERROR, reason='target_path')
        if address == source_address:
            raise ConfigError(PATH_ERROR, reason='target_path')
    if (value((), 'version') != '2' or string(containerd, 'snapshotter') != 'overlayfs'
            or string(containerd, 'default_runtime_name') != 'runc'
            or string(runtime, 'runtime_type') != 'io.containerd.runc.v2'
            or value(options, 'SystemdCgroup') != 'true'):
        raise ConfigError(reason='profile')
    if value((), 'disabled_plugins', False) not in (None, '[]'):
        raise ConfigError(reason='plugin')
    if value((), 'required_plugins', False) not in (None, '[]'):
        raise ConfigError(reason='plugin')
    if string((), 'plugin_dir', False) not in (None, ''):
        raise ConfigError(reason='plugin')
    if string(opt, 'path', False) not in (None, '', '/opt/containerd', target_root + '/opt' if already_isolated else ''):
        raise ConfigError(reason='external_path')
    for section in sections:
        if section[0:1] == ('plugins',) and len(section) > 1:
            if section[1] not in BUILTINS:
                raise ConfigError(reason='plugin')
        if section[0:1] == ('proxy_plugins',) and len(section) > 1:
            raise ConfigError(reason='plugin')
        if section[:len(containerd + ('runtimes',))] == containerd + ('runtimes',):
            if len(section) > len(containerd) + 1 and section[len(containerd) + 1] != 'runc':
                raise ConfigError(reason='profile')
        if section[0:1] == ('stream_processors',) and len(section) > 1 and section[1] not in DECODERS:
            raise ConfigError(reason='plugin')

    changes = {
        ((), 'imports'): '[]', ((), 'root'): json.dumps(target_root),
        ((), 'state'): json.dumps(state), ((), 'temp'): json.dumps(target_root + '/tmp'),
        (('grpc',), 'address'): json.dumps(address), (('grpc',), 'tcp_address'): '""',
        (('ttrpc',), 'address'): json.dumps(address + '.ttrpc'),
        (('debug',), 'address'): '""', (('metrics',), 'address'): '""',
        (('plugins', 'io.containerd.internal.v1.opt'), 'path'): json.dumps(target_root + '/opt'),
        (cri, 'stream_server_address'): '"127.0.0.1"', (cri, 'stream_server_port'): '"0"',
        (cri, 'disable_tcp_service'): 'true', (options, 'Root'): json.dumps(state + '/runc'),
    }
    for (section, key), (_, raw) in entries.items():
        registry = section[:len(cri + ('registry',))] == cri + ('registry',)
        if registry:
            continue
        lower = key.lower()
        if section == ('proxy_plugins',) or (section[0:1] == ('proxy_plugins',)):
            raise ConfigError(reason='plugin')
        if key == 'Root' and section == options:
            if _string(raw) not in ('', state + '/runc' if already_isolated else ''):
                raise ConfigError(reason='external_path')
            continue
        if section in (containerd + ('default_runtime',), containerd + ('untrusted_workload_runtime',)) and key == 'runtime_type':
            if _string(raw):
                raise ConfigError(reason='profile')
        if section == options and key in ('ShimCgroup', 'BinaryName') and _string(raw):
            raise ConfigError(reason='external_path')
        if key in ('root_path', 'runtime_root', 'runtime_engine', 'runtime_path'):
            if _string(raw):
                raise ConfigError(reason='external_path')
        if (section, key) in changes:
            continue
        if section == ('cgroup',) and key == 'path' and _string(raw):
            raise ConfigError(reason='external_path')
        if section == cri + ('cni',) and key == 'conf_template' and _string(raw):
            raise ConfigError(reason='external_path')
        if section == ('plugins', 'io.containerd.runtime.v1.linux') and key in ('shim', 'runtime', 'runtime_root'):
            if _string(raw) not in ('', 'runc', 'containerd-shim'):
                raise ConfigError(reason='profile')
        if key in ('CriuImagePath', 'CriuWorkPath') and _string(raw):
            raise ConfigError(reason='external_path')
        # No unreviewed listener or writable plugin root may survive cloning.
        if (any(word in lower for word in ('address', 'socket', 'listen', 'endpoint'))
                or re.search(r'(^|_)(root|state|temp|port)(_|$)', lower)
                or lower in ('path', 'data_dir', 'work_dir')):
            if lower in ('enable_unprivileged_ports', 'netns_mounts_under_state_dir'):
                continue
            if section[0:1] == ('stream_processors',) and key == 'path' and _string(raw) == 'ctd-decoder':
                continue
            if section == ('cgroup',) and key == 'path' and _string(raw) == '':
                continue
            if (key == 'root_path' and len(section) == 2 and section[0] == 'plugins'
                    and section[1].startswith('io.containerd.snapshotter.v1.') and _string(raw) == ''):
                continue
            if key == 'runtime_root' and _string(raw) == '' and (
                    section[:len(containerd)] == containerd or
                    section == ('plugins', 'io.containerd.runtime.v1.linux')):
                continue
            if (section == ('plugins', 'io.containerd.tracing.processor.v1.otlp')
                    and key == 'endpoint' and _string(raw) == ''):
                continue
            reason = 'listener' if any(word in lower for word in ('address', 'socket', 'listen', 'endpoint', 'port')) else 'external_path'
            raise ConfigError(reason=reason)
        if section == ('plugins', 'io.containerd.snapshotter.v1.devmapper') and key in ('pool_name', 'base_image_size'):
            if _string(raw):
                raise ConfigError(reason='external_path')
    # Modify only known assignments; append missing required settings inside
    # their exact table, never as a dotted key beneath the last existing table.
    additions = {}
    for identity, replacement in changes.items():
        if identity in entries:
            index, _ = entries[identity]
            indent = re.match(r'\s*', lines[index]).group(0)
            lines[index] = '{}{} = {}\n'.format(indent, identity[1], replacement)
        else:
            additions.setdefault(identity[0], []).append('{} = {}\n'.format(identity[1], replacement))
    result = []
    current = ()
    for line in lines:
        if line.strip().startswith('['):
            result.extend(additions.pop(current, []))
            current = _parts(line.strip()[1:-1])
        result.append(line if line.endswith('\n') else line + '\n')
    result.extend(additions.pop(current, []))
    for section, assignments in sorted(additions.items()):
        if not section:
            raise ConfigError(ERROR)
        result.append('\n[{}]\n'.format('.'.join(json.dumps(part) for part in section)))
        result.extend(assignments)
    return {'config_text': ''.join(result), 'metadata': {
        'config_version': 2, 'root': target_root, 'state': state, 'address': address,
        'imports_cleared': True, 'grpc_tcp_disabled': True, 'debug_disabled': True,
        'metrics_disabled': True, 'stream_loopback_ephemeral': True,
        'snapshotter': 'overlayfs', 'runtime_type': 'io.containerd.runc.v2',
        'systemd_cgroup': True, 'registry_preserved': True, 'cni_preserved': True,
        'execution_supported': False, 'requires_binary_validation': True}}
