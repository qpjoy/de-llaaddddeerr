"""Cold-copy and bind-mount primitives; the caller owns workload quiescence/journal.

No operation stops a service or changes application configuration. Every mutating
storage step calls assert_stopped(), which must raise unless kubelet and all old
and candidate Kubernetes writers are stopped. Docker/runtime/etcd are excluded.
"""
import base64
import contextlib
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import socket
import stat
import subprocess
import uuid

import storage_guard as guard

ROOTS = guard.ROOTS
StorageError = guard.StorageError
require = guard.require
FSTAB = Path('/etc/fstab')
GIB = 1024 ** 3
PROTECTED = ('/data/docker', '/var/lib/docker', '/var/lib/containerd',
             '/data/mx-runtime/containerd', '/var/lib/etcd', '/mnt/nas')
MOUNT_COLUMNS = 'TARGET,SOURCE,FSTYPE,UUID,FSROOT,OPTIONS'


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def within(path, parent):
    return path == parent or path.startswith(parent.rstrip('/') + '/')


def backing(path, mount):
    require(within(path, mount['target']))
    return os.path.normpath(mount['fsroot'].rstrip('/') + '/' + path[len(mount['target']):].lstrip('/'))


def mount_identity(mount):
    return {key: mount[key] for key in ('target', 'uuid', 'fsroot', 'fstype')}


def fsync_dir(path):
    fd = os.open(str(path), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic(path, raw, before):
    """CAS and replace only an existing protected file, preserving metadata/xattrs."""
    path = Path(path)
    info = guard.path_info(path)
    require(stat.S_ISREG(info.st_mode) and path.read_bytes() == before, 'fstab changed; refusing overwrite')
    temporary = path.with_name('.' + path.name + '.mx-move-' + uuid.uuid4().hex)
    fd = os.open(str(temporary), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(raw)
            stream.flush()
            os.fchown(stream.fileno(), info.st_uid, info.st_gid)
            shutil.copystat(str(path), str(temporary))
            for key in os.listxattr(str(path)):
                os.setxattr(str(temporary), key, os.getxattr(str(path), key))
            os.fsync(stream.fileno())
        require(guard.identity(guard.path_info(path)) == guard.identity(info) and path.read_bytes() == before,
                'fstab changed during update; refusing overwrite')
        os.replace(str(temporary), str(path))
        fsync_dir(path.parent)
    finally:
        if temporary.exists():
            temporary.unlink()


def parse_fstab(raw):
    rows = {}
    for number, line in enumerate(raw.decode('utf-8').splitlines(keepends=True)):
        fields = line.split('#', 1)[0].split()
        if not fields:
            continue
        require(len(fields) >= 4, 'fstab has an unsupported row')
        if fields[1] not in ROOTS.values():
            continue
        require(fields[1] not in rows, 'duplicate selected fstab mount')
        require(len(fields) == 6 and fields[2] == 'none' and fields[4:] == ['0', '0'] and
                'bind' in fields[3].split(',') and
                not set(fields[3].split(',')) & {'rbind', 'ro', 'nofail', 'noauto'},
                'selected fstab row must be a required read-write bind')
        guard.canonical(fields[0])
        rows[fields[1]] = (number, fields)
    return rows


def fstab_after(raw, entries):
    rows = parse_fstab(raw)
    lines = raw.decode('utf-8').splitlines(keepends=True)
    for entry in entries:
        logical, target = entry['logical'], entry['target']
        require(logical == ROOTS.get(entry['key']))
        guard.canonical(target)
        if logical in rows:
            index, fields = rows[logical]
            require(fields[0] == entry['source'], 'fstab source changed since planning')
            lines[index] = re.sub(r'^(\s*)\S+', lambda match: match.group(1) + target, lines[index], count=1)
        else:
            require(not entry['source_bind'], 'original bind is absent from fstab')
            if lines and not lines[-1].endswith('\n'):
                lines[-1] += '\n'
            lines.append('{} {} none bind 0 0\n'.format(target, logical))
    return ''.join(lines).encode('utf-8')


def mount_unit_name(logical):
    require(logical in ROOTS.values())
    # These five allowlisted paths contain only ASCII letters, slash and dash.
    # systemd path escaping turns literal '-' into \x2d before '/' becomes '-'.
    return logical.lstrip('/').replace('-', r'\x2d').replace('/', '-') + '.mount'


def validate_mount_unit(raw, logical, source):
    expected = {('Unit', 'SourcePath'): str(FSTAB), ('Mount', 'What'): source,
                ('Mount', 'Where'): logical}
    values, section = {}, None
    require(isinstance(raw, bytes) and len(raw) <= 65536, 'generated mount unit is invalid')
    for line in raw.decode('utf-8').splitlines():
        line = line.strip()
        if not line or line.startswith(('#', ';')):
            continue
        require(not line.endswith('\\'), 'continued mount unit fields are unsupported')
        if line.startswith('[') and line.endswith(']'):
            section = line[1:-1]
            continue
        key, separator, value = line.partition('=')
        field = (section, key.strip())
        if separator and (field in expected or field == ('Mount', 'Options')):
            require(field not in values, 'duplicate generated mount unit field')
            values[field] = value.strip()
    require(all(values.get(key) == value for key, value in expected.items()),
            'generated mount unit differs from the selected fstab bind')
    options = set(values.get(('Mount', 'Options'), '').split(','))
    require('bind' in options and not options & {'rbind', 'nofail', 'noauto', 'ro'},
            'generated mount unit must be a required read-write bind')


class Host:
    def run(self, args, timeout=30, allowed=(0,)):
        try:
            result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
        except (OSError, subprocess.TimeoutExpired):
            raise StorageError('storage command unavailable or timed out; raw output hidden') from None
        require(result.returncode in allowed, 'storage command failed; raw output hidden')
        return result.stdout

    def mount(self, path):
        return guard.mount(path, self.run)

    def mounts(self):
        raw = json.loads(self.run(['findmnt', '--json', '--list', '--output', MOUNT_COLUMNS]),
                         object_pairs_hook=guard.unique_object)
        require(isinstance(raw, dict) and isinstance(raw.get('filesystems'), list))
        mounts = raw['filesystems']
        require(all(isinstance(m, dict) and isinstance(m.get('target'), str) for m in mounts))
        counts = {}
        for mount in mounts:
            counts[mount['target']] = counts.get(mount['target'], 0) + 1
        duplicates = [{'target': path, 'count': count} for path, count in sorted(counts.items()) if count > 1]
        # Do not collapse identical rows: a repeated mount can hide another
        # layer. Report only locations/counts, never sources or mount options.
        require(not duplicates, 'stacked mounts are unsupported; duplicate_targets=' +
                json.dumps(duplicates, ensure_ascii=True, separators=(',', ':')))
        return mounts

    def identity(self, path):
        info = guard.path_info(path, data_leaf=True)
        require(stat.S_ISDIR(info.st_mode))
        return guard.identity(info)

    @contextlib.contextmanager
    def pin(self, path, expected):
        require(self.identity(path) == expected, 'data path identity changed')
        fd = os.open(str(path), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            require(guard.identity(os.fstat(fd)) == expected)
            yield '/proc/{}/fd/{}'.format(os.getpid(), fd)
            require(self.identity(path) == expected, 'data path replaced during operation')
        finally:
            os.close(fd)

    def capacity(self, path, extra=0):
        value = os.statvfs(str(path))
        require(value.f_bavail * value.f_frsize >= 100 * GIB + extra,
                'root filesystem must retain at least 100 GiB free')


class Storage:
    def __init__(self, host=None):
        self.host = host or Host()

    def verify_mount_units(self, raw):
        """Check persistent definitions, not show.What for an already active bind."""
        rows = parse_fstab(raw)
        properties = ('LoadState', 'FragmentPath', 'SourcePath', 'DropInPaths', 'NeedDaemonReload')
        for logical in ROOTS.values():
            unit = mount_unit_name(logical)
            for directory in ('/etc/systemd/system', '/run/systemd/system',
                              '/usr/local/lib/systemd/system', '/usr/lib/systemd/system', '/lib/systemd/system'):
                require(not os.path.lexists(directory + '/' + unit) and
                        not os.path.lexists(directory + '/' + unit + '.d'),
                        'native mount units and drop-ins are unsupported for selected storage')
            args = ['systemctl', 'show', '--no-pager', '--all']
            for property_name in properties:
                args += ['--property', property_name]
            # systemd versions differ in the exit status for an absent unit.
            # Only a complete, explicitly not-found result is accepted below.
            result = self.host.run(args + [unit], allowed=(0, 1, 4)).decode('utf-8')
            fields = {}
            for line in result.splitlines():
                key, separator, value = line.partition('=')
                if separator and key in properties:
                    require(key not in fields, 'duplicate systemd mount property')
                    fields[key] = value
            require(set(fields) == set(properties) and fields['NeedDaemonReload'] == 'no' and
                    not fields['DropInPaths'], 'mount unit is stale, overridden or incompletely inspected')
            if logical not in rows:
                require(fields['LoadState'] == 'not-found' and not fields['FragmentPath'] and
                        not fields['SourcePath'], 'unexpected persistent mount unit for an unmounted data directory')
                continue
            fragment = '/run/systemd/generator/' + unit
            require(fields['LoadState'] == 'loaded' and fields['FragmentPath'] == fragment and
                    fields['SourcePath'] == str(FSTAB), 'selected mount must be generated solely from fstab')
            # The allowlisted unit name can contain literal systemd escapes
            # (e.g. mx\x2dlauncher). Keep data-path canonicalization strict;
            # validate the fixed parent and the derived unit file separately.
            unit_path = Path(fragment)
            guard.path_info(unit_path.parent)
            info = unit_path.lstat()
            require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022,
                    'generated mount unit must be a root-owned regular file without group/other write access: ' + logical)
            validate_mount_unit(unit_path.read_bytes(), logical, rows[logical][1][0])

    def no_children(self, path):
        require(not any(m['target'] != path and within(m['target'], path) for m in self.host.mounts()),
                'unexpected nested storage mount')

    def snapshot(self, transaction, root_uuid, source_uuid, protected_paths=PROTECTED):
        require(re.fullmatch(r'mx-k8s-[0-9]{8}-[0-9]{6}-[a-f0-9]{8}', transaction))
        root, source = self.host.mount('/'), self.host.mount('/data')
        require(root['target'] == '/' and root['fsroot'] == '/' and root['uuid'] == root_uuid and
                source['target'] == '/data' and source['fsroot'] == '/' and source['uuid'] == source_uuid and
                root_uuid != source_uuid, 'source and target filesystem identities do not match')
        guard.path_info(FSTAB)
        raw = FSTAB.read_bytes()
        rows = parse_fstab(raw)
        self.verify_mount_units(raw)
        mounts = self.host.mounts()
        protected = []
        for path in set(PROTECTED) | set(protected_paths):
            guard.canonical(path)
            if os.path.lexists(path):
                candidates = [m for m in mounts if within(path, m['target'])]
                require(candidates, 'protected storage mount is unknown')
                m = max(candidates, key=lambda item: len(item['target']))
                protected.append((path, m.get('uuid'), backing(path, m)))
        entries = []
        for key, logical in ROOTS.items():
            current = self.host.mount(logical)
            require(current['uuid'] == source_uuid, 'selected data is not on the expected source disk')
            source_bind = current['target'] == logical
            require(source_bind == (key in ('kubelet', 'launcher')), 'unexpected original bind layout')
            source_path = '/data' + backing(logical, current)
            require(source_path != '/data' and self.host.identity(source_path) == self.host.identity(logical))
            if source_bind:
                require(logical in rows and rows[logical][1][0] == source_path,
                        'original bind source does not match fstab')
            else:
                require(logical not in rows and source_path == logical)
            for path, filesystem_uuid, physical in protected:
                require(not (within(logical, path) or within(path, logical)) and
                        not (filesystem_uuid == source_uuid and
                             (within(backing(logical, current), physical) or within(physical, backing(logical, current)))),
                        'selected data overlaps Docker, runtime, etcd or remote storage')
            children = [m for m in mounts if m['target'] != logical and within(m['target'], logical)]
            if key == 'kubelet':
                for child in children:
                    self.check_kubelet_child(child)
            else:
                require(not children, 'selected application data contains a nested mount')
            entry = {'key': key, 'logical': logical, 'source': source_path,
                     'source_bind': source_bind, 'source_identity': self.host.identity(logical),
                     'source_mount': mount_identity(current),
                     'target': guard.DATA_BASE + '/' + transaction + '/' + key,
                     'target_fsroot': guard.DATA_BASE + '/' + transaction + '/' + key,
                     'target_uuid': root_uuid,
                     'kubelet_children': children if key == 'kubelet' else []}
            if key in guard.PG_PATHS:
                entry['postgres'] = guard.pg_identity(Path(logical) / guard.PG_PATHS[key])
            entries.append(entry)
        fstab_after(raw, entries)
        return {'schema_version': 1, 'transaction': transaction, 'hostname': socket.gethostname(),
                'root_uuid': root_uuid, 'source_uuid': source_uuid, 'entries': entries,
                'fstab_before_base64': base64.b64encode(raw).decode(), 'fstab_before_sha256': sha(raw)}

    @staticmethod
    def check_kubelet_child(mount):
        require(re.fullmatch(r'/var/lib/kubelet/pods/[a-f0-9-]{36}/volumes/kubernetes.io~(?:projected|secret)/[A-Za-z0-9_.-]+',
                             mount.get('target', '')) is not None and
                mount.get('fstype') == 'tmpfs' and mount.get('source') == 'tmpfs' and mount.get('fsroot') == '/',
                'unsupported kubelet submount; never unmount NAS or application storage automatically')

    def unmount_kubelet_children(self, snapshot, assert_stopped):
        entry = next(e for e in snapshot['entries'] if e['key'] == 'kubelet')
        expected = {m['target']: m for m in entry['kubelet_children']}
        current = [m for m in self.host.mounts() if within(m['target'], entry['logical']) and m['target'] != entry['logical']]
        for item in current:
            self.check_kubelet_child(item)
            require(item['target'] in expected and item == expected[item['target']], 'kubelet submount changed since planning')
        for item in sorted(current, key=lambda m: len(Path(m['target']).parts), reverse=True):
            assert_stopped()
            require(self.host.identity(entry['logical']) == entry['source_identity'])
            live = [m for m in self.host.mounts() if m['target'] == item['target']]
            require(live == [item], 'kubelet submount changed before unmount')
            self.host.run(['umount', '--', item['target']])
        self.no_children(entry['logical'])

    def validate_source(self, entry):
        require(self.host.identity(entry['source']) == entry['source_identity'], 'original data directory changed')
        mount = self.host.mount(entry['source'])
        require(mount['uuid'] == entry['source_mount']['uuid'] and mount['target'] == '/data' and mount['fsroot'] == '/')

    def validate_target(self, entry, root_uuid):
        require(self.host.identity(entry['target']) == entry['target_identity'], 'target data directory changed')
        mount = self.host.mount(entry['target'])
        require(mount['target'] == '/' and mount['fsroot'] == '/' and mount['uuid'] == root_uuid)

    def cold_copy(self, entry, assert_stopped, persist=None):
        assert_stopped()
        require(entry.get('copied') is not True, 'completed cold copy must not be overwritten')
        self.validate_source(entry)
        self.no_children(entry['source'])
        self.no_children(entry['logical'])
        parent, target = Path(entry['target']).parent, Path(entry['target'])
        guard.path_info(parent)
        parent_mount = self.host.mount(parent)
        require(parent_mount['target'] == '/' and parent_mount['fsroot'] == '/' and parent_mount['uuid'] == entry['target_uuid'])
        if 'target_identity' not in entry:
            require(not os.path.lexists(str(target)), 'cold-copy target must be new')
            target.mkdir(mode=0o700)
            fsync_dir(parent)
            entry['target_identity'] = self.host.identity(target)
            if persist:
                persist(entry)
        else:
            require(persist is not None, 'resuming a cold copy requires a durable journal callback')
            require(self.host.identity(target) == entry['target_identity'])
        with self.host.pin(entry['source'], entry['source_identity']) as source, self.host.pin(str(target), entry['target_identity']) as destination:
            size_raw = self.host.run(['du', '-sHx', '--apparent-size', '--block-size=1', '--', source])
            require(re.match(rb'^[0-9]+\s', size_raw) is not None, 'cannot measure cold-copy source')
            self.host.capacity(parent, int(size_raw.split()[0]))
            assert_stopped()
            self.host.run(['rsync', '-aHAXx', '--numeric-ids', '--', source + '/', destination + '/'], timeout=6 * 3600)
            assert_stopped()
            require(not self.host.run(['rsync', '-aHAXxnci', '--delete', '--numeric-ids', '--', source + '/', destination + '/'],
                                      timeout=6 * 3600).strip(), 'cold copy checksum or metadata mismatch')
            self.host.run(['sync', '-f', destination], timeout=600)
            self.host.capacity(parent)
        self.validate_source(entry)
        if entry['key'] in guard.PG_PATHS:
            require(guard.pg_identity(target / guard.PG_PATHS[entry['key']]) == entry['postgres'],
                    'copied database identifier changed')
        entry['copied'] = True
        if persist:
            persist(entry)
        return entry

    def switch(self, entry, assert_stopped, root_uuid):
        assert_stopped()
        require(entry.get('copied') is True)
        self.validate_target(entry, root_uuid)
        self.no_children(entry['logical'])
        current = self.host.mount(entry['logical'])
        if current['target'] == entry['logical'] and current['uuid'] == root_uuid:
            require(current['fsroot'] == entry['target_fsroot'] and
                    self.host.identity(entry['logical']) == entry['target_identity'])
            return
        self.validate_source(entry)
        if current['target'] == entry['logical']:
            require(entry['source_bind'] and mount_identity(current) == entry['source_mount'] and
                    self.host.identity(entry['logical']) == entry['source_identity'], 'unexpected active bind')
            self.host.run(['umount', '--', entry['logical']])
        elif entry['source_bind']:
            require(current['target'] == '/' and current['uuid'] == root_uuid and current['fsroot'] == '/',
                    'unexpected underlying mount after interrupted bind switch')
        else:
            require(mount_identity(current) == entry['source_mount'] and
                    self.host.identity(entry['logical']) == entry['source_identity'])
        assert_stopped()
        guard.path_info(entry['logical'], data_leaf=True)
        with self.host.pin(entry['target'], entry['target_identity']) as target:
            self.host.run(['mount', '--bind', target, entry['logical'], '--no-canonicalize'])
        selected = self.host.mount(entry['logical'])
        require(selected['target'] == entry['logical'] and selected['uuid'] == root_uuid and
                selected['fsroot'] == entry['target_fsroot'] and self.host.identity(entry['logical']) == entry['target_identity'])

    def restore(self, entry, assert_stopped, root_uuid):
        """Only before may_write; the orchestrator must forbid rollback afterwards."""
        assert_stopped()
        self.no_children(entry['logical'])
        current = self.host.mount(entry['logical'])
        if mount_identity(current) == entry['source_mount'] and self.host.identity(entry['logical']) == entry['source_identity']:
            return
        if current['target'] == entry['logical']:
            self.validate_target(entry, root_uuid)
            require(current['uuid'] == root_uuid and current['fsroot'] == entry['target_fsroot'] and
                    self.host.identity(entry['logical']) == entry['target_identity'], 'unexpected bind during rollback')
            self.host.run(['umount', '--', entry['logical']])
        if entry['source_bind']:
            self.validate_source(entry)
            underlying = self.host.mount(entry['logical'])
            require(underlying['target'] == '/' and underlying['uuid'] == root_uuid and underlying['fsroot'] == '/')
            assert_stopped()
            with self.host.pin(entry['source'], entry['source_identity']) as source:
                self.host.run(['mount', '--bind', source, entry['logical'], '--no-canonicalize'])
        require(mount_identity(self.host.mount(entry['logical'])) == entry['source_mount'] and
                self.host.identity(entry['logical']) == entry['source_identity'], 'original mount could not be verified')

    def install_fstab(self, snapshot, after=True):
        before = base64.b64decode(snapshot['fstab_before_base64'], validate=True)
        require(sha(before) == snapshot['fstab_before_sha256'])
        updated = fstab_after(before, snapshot['entries'])
        current = FSTAB.read_bytes()
        require(current in (before, updated), 'fstab was changed outside this transaction')
        desired = updated if after else before
        if current != desired:
            atomic(FSTAB, desired, current)
        self.host.run(['systemctl', 'daemon-reload'])
        self.verify_mount_units(desired)


def guard_record(snapshot, phase='blocked'):
    require(phase in ('blocked', 'active'))
    entries = []
    for entry in snapshot['entries']:
        value = {key: entry[key] for key in ('key', 'logical', 'target', 'target_fsroot')}
        if 'target_identity' in entry:
            value['target_identity'] = entry['target_identity']
        if 'postgres' in entry:
            value['postgres'] = entry['postgres']
        entries.append(value)
    return {'schema_version': 1, 'phase': phase, 'transaction': snapshot['transaction'],
            'hostname': snapshot['hostname'], 'root_uuid': snapshot['root_uuid'], 'entries': entries}


def guard_dropin(python):
    guard.canonical(python)
    return ('[Unit]\nRequiresMountsFor={}\n[Service]\nExecStartPre={} /usr/local/lib/mx-k8s-runtime/storage_guard.py\n'.format(
        ' '.join(ROOTS.values()), python)).encode()
