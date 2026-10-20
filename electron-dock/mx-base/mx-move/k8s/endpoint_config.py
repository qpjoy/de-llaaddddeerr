"""Read-only kubelet launch configuration receipt and narrow crictl YAML rewrite.

No commands here restart a service or write a file. Receipts can contain effective
service environment values and must remain in the caller's root-private journal.
Inodes are intentionally excluded: kubelet environment files move with its data.
"""
import hashlib
import os
from pathlib import Path
import re
import stat

EXTRA_DROPIN = '/etc/systemd/system/kubelet.service.d/95-mx-move-k8s.conf'
OLD = '/run/containerd/containerd.sock'
NEW = '/run/mx-k8s-containerd/containerd.sock'
PROPERTIES = ('LoadState', 'FragmentPath', 'DropInPaths', 'EnvironmentFiles',
              'Environment', 'ExecStart', 'NeedDaemonReload')
FORBIDDEN = (b'--container-runtime-endpoint', b'--root-dir')


class EndpointError(RuntimeError):
    pass


def require(ok, message='kubelet launch configuration changed or is unsupported; raw values hidden'):
    if not ok:
        raise EndpointError(message)


def canonical(value):
    require(isinstance(value, str) and re.fullmatch(r'/[A-Za-z0-9_./-]+', value) and
            value != '/' and os.path.normpath(value) == value)
    return value


def protected_file(path, optional=False):
    """Hash a protected regular file, or record an explicitly optional absence."""
    canonical(path)
    current = Path('/')
    final_info = None
    for part in ('',) + Path(path).parts[1:]:
        if part:
            current /= part
        try:
            info = current.lstat()
        except FileNotFoundError:
            require(optional, 'required kubelet service configuration file is missing')
            return {'missing': True}
        require(info.st_uid == 0 and not info.st_mode & 0o022 and not stat.S_ISLNK(info.st_mode),
                'kubelet service configuration path is not root protected')
        require(stat.S_ISREG(info.st_mode) if str(current) == path else stat.S_ISDIR(info.st_mode))
        final_info = info
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        opened = os.fstat(fd)
        require((opened.st_dev, opened.st_ino) == (final_info.st_dev, final_info.st_ino) and
                opened.st_uid == 0 and not opened.st_mode & 0o022 and stat.S_ISREG(opened.st_mode))
        with os.fdopen(fd, 'rb') as stream:
            fd = None
            raw = stream.read(1024 * 1024 + 1)
        require(len(raw) <= 1024 * 1024, 'kubelet service configuration file is too large')
        require(not any(flag in raw for flag in FORBIDDEN),
                'kubelet service files contain a runtime endpoint or root directory override')
        return {'sha256': hashlib.sha256(raw).hexdigest(), 'uid': opened.st_uid,
                'gid': opened.st_gid, 'mode': stat.S_IMODE(opened.st_mode)}
    finally:
        if fd is not None:
            os.close(fd)


def environment_files(raw):
    """Parse systemctl's projected EnvironmentFiles property without shell eval."""
    require(isinstance(raw, str))
    files, offset = [], 0
    while offset < len(raw):
        match = re.match(r'\s*(/[A-Za-z0-9_./-]+)\s+\(ignore_errors=(yes|no)\)(?:\s+|$)', raw[offset:])
        require(match is not None, 'unsupported systemd EnvironmentFiles representation')
        path, ignored = match.groups()
        canonical(path)
        require(path not in [item['path'] for item in files], 'duplicate kubelet environment file')
        files.append({'path': path, 'ignore_errors': ignored == 'yes'})
        offset += match.end()
    return files


def exec_start(raw):
    """Retain execution configuration; omit systemctl's changing PID/timestamps."""
    require(isinstance(raw, str))
    match = re.fullmatch(r'\{\s*path=([^;{}]+?)\s*;\s*argv\[\]=([^{}]*?)\s*;\s*ignore_errors=(yes|no)\s*;[^{}]*\}', raw)
    require(match is not None, 'kubelet must have one inspectable ExecStart command')
    path, argv, ignore = match.groups()
    canonical(path)
    require(argv and '\n' not in argv and '\r' not in argv)
    return {'path': path, 'argv': argv, 'ignore_errors': ignore == 'yes'}


def properties(run):
    args = ['systemctl', 'show', 'kubelet.service', '--no-pager', '--all']
    for key in PROPERTIES:
        args += ['--property', key]
    raw = run(args)
    require(isinstance(raw, bytes) and len(raw) <= 1024 * 1024)
    require(not any(flag in raw for flag in FORBIDDEN),
            'effective kubelet environment or command contains an endpoint/root override')
    values, environment_rows, environment_key = {}, [], None
    for line in raw.decode('utf-8').splitlines():
        key, separator, value = line.partition('=')
        if separator and key in ('EnvironmentFile', 'EnvironmentFiles'):
            # systemd prints this array once per file, using the singular
            # name in v219 and the plural name in v239/v252. Preserve order:
            # later environment files may override earlier assignments.
            require(environment_key in (None, key), 'systemctl mixed environment file property formats')
            environment_key = key
            environment_rows.append(value)
            continue
        require(separator and key in PROPERTIES and key not in values,
                'systemctl returned an ambiguous kubelet configuration')
        values[key] = value
    require(len(environment_rows) <= 1 or all(environment_rows),
            'systemctl mixed empty and repeated environment file entries')
    for row in environment_rows:
        environment_files(row)  # Never join incomplete entries across rows.
    # An empty EnvironmentFiles array produces no row, even with --all.
    # All scalar properties below must still be present exactly once.
    values['EnvironmentFiles'] = ' '.join(environment_rows)
    require(set(values) == set(PROPERTIES) and values['LoadState'] == 'loaded')
    canonical(values['FragmentPath'])
    dropins = values['DropInPaths'].split()
    require(len(set(dropins)) == len(dropins))
    for path in dropins:
        canonical(path)
    require(values['FragmentPath'] not in dropins)
    return {'fragment': values['FragmentPath'], 'dropins': dropins,
            'environment_files': environment_files(values['EnvironmentFiles']),
            'environment': values['Environment'], 'exec_start': exec_start(values['ExecStart']),
            'need_reload': values['NeedDaemonReload']}


def collect_files(configuration):
    selected = [(configuration['fragment'], False)] + [(path, False) for path in configuration['dropins']]
    selected += [(item['path'], item['ignore_errors']) for item in configuration['environment_files']]
    require(len({path for path, _ in selected}) == len(selected), 'kubelet launch files have ambiguous roles')
    return {path: protected_file(path, optional=ignored) for path, ignored in selected}


def stable(configuration):
    return {key: value for key, value in configuration.items() if key != 'need_reload'}


def snapshot(run):
    configuration = properties(run)
    require(configuration['need_reload'] == 'no', 'kubelet service configuration requires daemon-reload before planning')
    require(EXTRA_DROPIN not in configuration['dropins'], 'kubelet migration drop-in already exists')
    files = collect_files(configuration)
    current = properties(run)
    require(current['need_reload'] == 'no' and stable(current) == stable(configuration),
            'kubelet service configuration changed during inspection')
    return {'schema_version': 1, 'configuration': stable(configuration), 'files': files}


def verify(run, receipt):
    require(isinstance(receipt, dict) and type(receipt.get('schema_version')) is int and
            receipt['schema_version'] == 1 and isinstance(receipt.get('configuration'), dict) and
            isinstance(receipt.get('files'), dict), 'invalid kubelet endpoint configuration receipt')
    configuration = properties(run)
    original = dict(configuration)
    original['dropins'] = [path for path in configuration['dropins'] if path != EXTRA_DROPIN]
    require(stable(original) == receipt['configuration'], 'effective kubelet launch configuration changed')
    require(collect_files(original) == receipt['files'], 'original kubelet launch file bytes or permissions changed')
    if EXTRA_DROPIN in configuration['dropins']:
        # The transaction checks exact intended bytes separately. Never adopt an
        # arbitrary writable/symlinked extra drop-in solely by its filename.
        protected_file(EXTRA_DROPIN)
    current = properties(run)
    current['dropins'] = [path for path in current['dropins'] if path != EXTRA_DROPIN]
    require(stable(current) == receipt['configuration'], 'kubelet configuration changed during verification')
    return receipt


def old_endpoint(value):
    if value.startswith('unix://'):
        value = value[7:]
    require(value in (OLD, '/var/run/containerd/containerd.sock'),
            'crictl endpoint does not reference the original local containerd socket')


def rewrite_crictl(raw):
    replacement = 'unix://' + NEW
    if raw is None:
        return ('runtime-endpoint: ' + replacement + '\nimage-endpoint: ' + replacement + '\n').encode()
    require(isinstance(raw, bytes) and len(raw) <= 1024 * 1024, 'invalid crictl configuration bytes')
    text = raw.decode('utf-8')
    require(not text.startswith('\ufeff'), 'crictl YAML BOM is unsupported')
    output, found = [], set()
    for line in text.splitlines(keepends=True):
        stripped = line.strip()
        if not stripped or stripped.startswith('#'):
            output.append(line)
            continue
        require(not stripped.startswith(('---', '...', '%', '<<:', '{', '[')),
                'crictl YAML documents, merges and flow mappings are unsupported')
        key = re.match(r'^[ \t]*(?:[\"\x27]?)(runtime-endpoint|image-endpoint)(?:[\"\x27]?)[ \t]*:', line)
        if not key:
            output.append(line)
            continue
        match = re.fullmatch(r'(runtime-endpoint|image-endpoint)([ \t]*:[ \t]*)(\"[^\"\r\n]*\"|\x27[^\x27\r\n]*\x27|[^ \t#\r\n]+)([ \t]*(?:#[^\r\n]*)?)(\r?\n)?', line)
        require(match is not None, 'crictl endpoints must be unindented scalar keys without aliases')
        name, separator, scalar, suffix, newline = match.groups()
        require(name not in found, 'duplicate crictl endpoint key')
        found.add(name)
        require(not suffix.startswith('#'), 'crictl endpoint comments require whitespace')
        quoted = scalar[0] in ('\"', "'")
        value = scalar[1:-1] if quoted else scalar
        old_endpoint(value)
        rendered = scalar[0] + replacement + scalar[0] if quoted else replacement
        output.append(name + separator + rendered + suffix + (newline or ''))
    require(found == {'runtime-endpoint', 'image-endpoint'}, 'existing crictl file must explicitly contain both endpoint fields')
    return ''.join(output).encode('utf-8')
