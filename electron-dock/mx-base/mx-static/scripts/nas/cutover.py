#!/usr/bin/env python3
"""Part 1 cutover. Preserve SSD and quarantined NAS extras; never reclaim data."""
import copy
import fcntl
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import uuid

import cutover_prepare as prep
import precopy
from media import checked_root
from permissions import emit, open_parent
from sample_copy import DIR_FLAGS, descriptor_path
from verify import Report, inventory, stamp, open_file

ROOT = '/var/lib/mx-static/nas-cutover'
RAW = '/app/media/data_hub_raw_media'
WORKERS = sorted(name for name in prep.SERVICES if name.startswith('worker'))
STOP_GROUPS = [('gateway', 'beat'), ('web', 'chat-gateway'), tuple(WORKERS)]
MODES = ('--cutover', '--restore-ssd', '--resume-nas')


def read_json(fd, name):
    leaf = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    with os.fdopen(leaf) as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077 or info.st_size > 32 * 1024 ** 2:
            raise RuntimeError('Unsafe private report: ' + name)
        return json.load(stream)


def atomic_json(fd, name, value):
    temporary = '.execution-' + uuid.uuid4().hex
    prep.private_write(fd, temporary, value)
    os.rename(temporary, name, src_dir_fd=fd, dst_dir_fd=fd)
    os.fsync(fd)


def open_report(path):
    if not re.fullmatch(re.escape(ROOT + '/' + prep.VOLUME + '-') + '[0-9a-f]{32}', path):
        raise RuntimeError('Use the exact successful Part 1 report directory.')
    fd = os.open('/', DIR_FLAGS)
    try:
        for part in path.strip('/').split('/'):
            child = os.open(part, DIR_FLAGS, dir_fd=fd)
            os.close(fd); fd = child
            info = os.fstat(fd)
            if info.st_uid != 0 or info.st_mode & 0o022:
                raise RuntimeError('Unsafe report directory.')
        return fd
    except BaseException:
        os.close(fd); raise


def select_services(containers):
    result = {}
    for c in containers:
        labels = c.get('Config', {}).get('Labels') or {}
        name = labels.get('com.docker.compose.service')
        if labels.get('com.docker.compose.project') == 'mx_data' and name in prep.SERVICES:
            if name in result:
                raise RuntimeError('Duplicate media service: ' + name)
            result[name] = c
    if set(result) != prep.SERVICES:
        raise RuntimeError('Expected exactly ten mx_data media services.')
    return result


def live_state(c):
    s = c.get('State', {})
    return s.get('Running') or s.get('Restarting') or s.get('Paused')


def require_stopped(consumers):
    for name, c in consumers.items():
        if live_state(c): raise RuntimeError('Media service still active: ' + name)
        if c.get('State', {}).get('OOMKilled') or c.get('State', {}).get('ExitCode') == 137:
            raise RuntimeError('Service did not finish gracefully: ' + name)


def create_command(report, filename):
    return prep.compose_command() + ['-f', report + '/' + filename, 'up', '--no-deps',
        '--no-build', '--pull', 'never', '--no-start', '--force-recreate', '--remove-orphans=false'] + sorted(prep.SERVICES)


def rollback_overlay(overlay):
    result = copy.deepcopy(overlay)
    result.pop('volumes')
    for service in result['services'].values(): service.pop('volumes')
    return result


def quick_command(source, target):
    # --delete is permitted ONLY together with --dry-run, to detect target extras.
    return ['rsync', '-a', '--numeric-ids', '--one-file-system', '--dry-run', '--delete',
            '--itemize-changes', '--out-format=%i %n%L', '--',
            descriptor_path(source) + '/', descriptor_path(target) + '/']


def parent_fd(root, path, baseline):
    parts = path.split('/')
    if any(part in ('', '.', '..') for part in parts): raise RuntimeError('Unsafe relative path.')
    fd = os.dup(root)
    try:
        current = ''
        for name in parts[:-1]:
            current = current + '/' + name if current else name
            child = os.open(name, DIR_FLAGS, dir_fd=fd)
            os.close(fd); fd = child
            actual = stamp(os.fstat(fd))
            if any(actual[key] != baseline[current][key] for key in ('dev', 'ino')):
                raise RuntimeError('Directory replaced during quarantine.')
        return fd, parts[-1]
    except BaseException:
        os.close(fd); raise


def quarantine_extras(source, target, source_tree, target_tree, job, output):
    missing = set(target_tree) - set(source_tree)
    extras = [path for path in sorted(missing)
              if not any('/'.join(path.split('/')[:n]) in missing for n in range(1, len(path.split('/'))))]
    if not extras: return 0
    name = '.mx-static-extras-' + uuid.uuid4().hex
    quarantine, created = precopy.child_directory(job, name, create=True)
    try:
        if not created: raise RuntimeError('Quarantine directory already exists.')
        leaf = os.open('quarantine.jsonl', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=output)
        with os.fdopen(leaf, 'w') as ledger:
            for index, path in enumerate(extras):
                parent, base = parent_fd(target, path, target_tree)
                try:
                    # Source is stopped and was inventoried without links/submounts.
                    try: os.stat(path, dir_fd=source, follow_symlinks=False)
                    except FileNotFoundError: pass
                    else: raise RuntimeError('Extra path reappeared in source; stop quarantine.')
                    if stamp(os.stat(base, dir_fd=parent, follow_symlinks=False)) != target_tree[path]:
                        raise RuntimeError('NAS extra changed since inventory.')
                    saved = '{:08d}'.format(index)
                    entry = {'source_relative': path, 'saved_relative': name + '/' + saved,
                             'identity': target_tree[path], 'phase': 'rename_intent'}
                    ledger.write(json.dumps(entry, ensure_ascii=True) + '\n'); ledger.flush(); os.fsync(ledger.fileno())
                    os.rename(base, saved, src_dir_fd=parent, dst_dir_fd=quarantine)
                    os.fsync(parent); os.fsync(quarantine)
                    entry['phase'] = 'renamed'
                    ledger.write(json.dumps(entry, ensure_ascii=True) + '\n'); ledger.flush(); os.fsync(ledger.fileno())
                finally: os.close(parent)
        emit('nas_extras_retained', moved_roots=len(extras), directory=name,
             note='Renamed within NAS outside live raw-media; no file content deleted.')
        return len(extras)
    finally: os.close(quarantine)


class MetadataReport(Report):
    def progress(self, phase, **values):
        if time.monotonic() - self.last_progress >= 10:
            self.stream.flush()
            emit('cutover_metadata_progress', phase=phase, metadata_only=True,
                 issues=self.counts['issues'], **values)
            self.last_progress = time.monotonic()


class Cutover:
    def __init__(self, path, output):
        self.path, self.output = path, output
        self.saved = read_json(output, 'prepare-result.json')
        self.old = read_json(output, 'containers.private.json')
        self.original = read_json(output, 'compose.rendered.private.json')
        self.overlay = read_json(output, 'compose.nas.override.json')
        self.merged = read_json(output, 'compose.nas.rendered.private.json')
        s = self.saved
        if (s.get('volume') != prep.VOLUME or s.get('report_directory') != path or s.get('review_items') != []
                or any(s.get('writable_app_code', {}).values()) or s.get('production_stopped') is not False
                or not all(s.get('docker_nfs_probe', {}).get(k) is True for k in
                           ('docker_nfs_mount', 'same_target_inode', 'root_4k_write_read'))):
            raise RuntimeError('Successful unmodified preparation required.')
        fp = precopy.check_consumers(prep.VOLUME, containers=list(self.old.values()))
        if fp != s.get('consumer_fingerprint_normalized') or self.overlay != prep.candidate(self.old):
            raise RuntimeError('Saved consumer/candidate identity changed.')
        prep.validate_merged(self.original, self.merged, self.overlay)
        self.state = None
        self.job = self.source = self.target = None
        self.held = []

    def command(self, args, timeout=45, pass_fds=()):
        result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                universal_newlines=True, timeout=timeout, pass_fds=pass_fds)
        if result.returncode:
            name = 'command-error-' + uuid.uuid4().hex + '.json'
            prep.private_write(self.output, name, {'command': args, 'exit': result.returncode,
                                                   'stdout': result.stdout, 'stderr': result.stderr})
            raise RuntimeError('Command failed (exit {}); private details: {}'.format(result.returncode, name))
        return result.stdout

    def checkpoint(self, phase, **values):
        self.state.update(values, phase=phase, updated_at_unix=time.time())
        atomic_json(self.output, 'execution.json', self.state)
        emit('cutover_phase', phase=phase, report_directory=self.path,
             nas_may_have_writes=self.state['nas_may_have_writes'], reclaim_ready=False)

    def seal(self, phase):
        marker = dict(self.saved['precopy_state'], phase=phase, cutover_report=self.path,
                      cutover_ready=False, reclaim_ready=False)
        precopy.write_state(self.job, marker)

    def config_guard(self):
        if prep.file_hashes() != self.saved['config_files_sha256']:
            raise RuntimeError('Deployment files changed since preparation.')
        config = json.loads(self.command(prep.compose_command() + ['config', '--format', 'json']))
        if config != self.original: raise RuntimeError('Rendered original config changed.')
        merged = json.loads(self.command(prep.compose_command() + ['-f', self.path + '/compose.nas.override.json',
                                                                   'config', '--format', 'json']))
        if merged != self.merged: raise RuntimeError('Rendered NAS config changed.')
        prep.validate_volume(json.loads(self.command(['docker', 'volume', 'inspect', prep.NFS_VOLUME]))[0])

    def databases(self, containers, initial=False):
        result = {}
        for c in containers:
            labels = c.get('Config', {}).get('Labels') or {}
            name = labels.get('com.docker.compose.service')
            if labels.get('com.docker.compose.project') == 'mx_data' and name in ('postgres', 'redis'):
                if name in result: raise RuntimeError('Duplicate database service.')
                if not c['State']['Running'] or c['State'].get('Health', {}).get('Status') != 'healthy':
                    raise RuntimeError('Database/queue not healthy: ' + name)
                result[name] = c['Id']
        if set(result) != {'postgres', 'redis'}: raise RuntimeError('Expected mx_data Postgres and Redis.')
        if not initial and result != self.state['databases']:
            raise RuntimeError('Database/queue container identities changed.')
        return result

    def originals(self, stopped=False):
        containers = precopy.inspect_containers()
        fp = precopy.check_consumers(prep.VOLUME, containers=containers)
        if fp != self.saved['consumer_fingerprint_normalized']:
            raise RuntimeError('Original consumer identity changed.')
        self.databases(containers)
        selected = select_services(containers)
        if stopped: require_stopped(selected)
        return selected

    def open_media(self, sealed=False):
        self.source = os.open(checked_root(prep.VOLUME), DIR_FLAGS); self.held.append(self.source)
        if precopy.source_identity(self.source) != self.saved['precopy_state']['source_identity']:
            raise RuntimeError('SSD source identity changed.')
        parent = open_parent(); self.held.append(parent)
        if not sealed:
            _, records = precopy.check_consumers(prep.VOLUME, with_records=True)
            self.job, self.target, state = precopy.open_job(parent, prep.VOLUME, self.source,
                self.saved['consumer_fingerprint_normalized'], False, records=records)
            self.held.extend((self.job, self.target))
            if state != self.saved['precopy_state']: raise RuntimeError('Pre-copy state changed since preparation.')
        else:
            current = parent
            for name in ('data', 'docker', 'media-volumes', prep.VOLUME):
                current, _ = precopy.child_directory(current, name); self.held.append(current)
            self.job = current
            self.target, _ = precopy.child_directory(self.job, 'data_hub_raw_media'); self.held.append(self.target)
            state = precopy.read_state(self.job)
            if (state.get('job_id') != self.saved['precopy_state']['job_id'] or state.get('cutover_report') != self.path
                    or state.get('phase') not in ('cutover_in_progress', 'cutover_nas_writes_possible',
                                                  'cutover_running_on_nas', 'cutover_rolled_back')):
                raise RuntimeError('Sealed migration marker differs.')
        if os.fstat(self.target).st_ino != self.saved['precopy_state']['target_inode']:
            raise RuntimeError('NAS target inode changed.')

    def identity_probe(self):
        code = ('import os,json; p="/nas"; '
                'assert os.stat(p).st_ino == ' + str(self.saved['precopy_state']['target_inode']) + '; '
                'assert any(x.split()[4]==p and " - nfs" in x for x in open("/proc/self/mountinfo")); '
                'print(json.dumps({"nfs_identity_passed":True}))')
        value = json.loads(self.command(['docker', 'run', '--rm', '--pull=never', '--network=none',
            '--read-only', '--no-healthcheck', '--user', '0:0', '--entrypoint', 'python', '--mount',
            'type=volume,src=' + prep.NFS_VOLUME + ',dst=/nas,readonly,volume-nocopy',
            self.old['web']['Image'], '-c', code], timeout=None))
        if value != {'nfs_identity_passed': True}: raise RuntimeError('Unexpected NFS identity probe result.')
        emit('cutover_nfs_identity_passed')

    def stop(self, consumers):
        for group in STOP_GROUPS:
            emit('cutover_stopping', services=list(group), note='Graceful stop, no forced kill or task purge.')
            self.command(['docker', 'stop', '-t', '-1'] + [consumers[name]['Id'] for name in group], timeout=None)

    def sync(self):
        command = precopy.copy_command(self.source, self.target, self.saved['precopy_state'], unlimited=True)
        if precopy.run_rsync(command, (self.source, self.target)) != 0:
            raise RuntimeError('rsync returned nonzero; no cutover permitted.')

    def final_sync(self):
        self.checkpoint('final_sync')
        emit('cutover_metadata_start', metadata_only=True, full_sha256=False)
        leaf = os.open('metadata.jsonl', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=self.output)
        with os.fdopen(leaf, 'wb') as stream:
            report = MetadataReport(stream)
            before = inventory(self.source, 'source', report)
            if report.counts['issues']: raise RuntimeError('Source metadata has unsupported entries; inspect metadata.jsonl.')
            self.sync()
            target = inventory(self.target, 'target', report)
            if report.counts['issues']: raise RuntimeError('NAS metadata has unsupported entries; inspect metadata.jsonl.')
            moved = quarantine_extras(self.source, self.target, before, target, self.job, self.output)
            if moved: self.sync()  # Restore directory mtimes after extra renames.
            output = self.command(quick_command(self.source, self.target), timeout=None, pass_fds=(self.source, self.target))
            prep.private_write(self.output, 'quick-check.json', {'itemized_output': output, 'dry_run': True})
            if output.strip(): raise RuntimeError('Final per-path quick-check differs; see quick-check.json.')
            after = inventory(self.source, 'source_after', report)
            if report.counts['issues'] or before != after: raise RuntimeError('SSD changed during stopped-writer sync.')
            stream.flush(); os.fsync(stream.fileno())
            # Small existing-media readback over HTTP after startup; never hash the full tree.
            choices = [p for p, v in before.items() if stat.S_ISREG(v['mode']) and v['size'] > 1024 and not p.endswith('.tmp')]
            if not choices: raise RuntimeError('No existing media file available for HTTP acceptance probe.')
            sample = sorted(choices, key=lambda p: (not p.endswith('.mp4'), p))[0]
            fd = open_file(self.source, sample, before)
            try: digest = hashlib.sha256(os.read(fd, 1024)).hexdigest()
            finally: os.close(fd)
            self.state['sample'] = {'relative': sample, 'size': before[sample]['size'], 'prefix_sha256': digest}
        self.originals(stopped=True)
        self.config_guard()
        # Reopen registered paths, not only pinned fds, before Docker uses them.
        old_source, old_target = self.source, self.target
        self.open_media(sealed=True)
        for before_fd, now_fd in ((old_source, self.source), (old_target, self.target)):
            if precopy.source_identity(before_fd) != precopy.source_identity(now_fd):
                raise RuntimeError('Registered source/target path identity changed.')
        self.identity_probe()
        self.checkpoint('final_sync_passed', final_sync_passed=True, quarantined_roots=moved)

    def mounted_services(self, nas, expected_ids=None):
        containers = precopy.inspect_containers()
        self.databases(containers)
        selected = select_services(containers)
        expected_source = '/data/docker/volumes/' + prep.NFS_VOLUME + '/_data'
        for name, c in selected.items():
            old = self.old[name]
            if expected_ids is not None and c['Id'] != expected_ids[name]: raise RuntimeError('Created container replaced: ' + name)
            mounts = list(c.get('Mounts', []))
            child = [m for m in mounts if m.get('Destination') == RAW]
            if nas:
                if (len(child) != 1 or child[0].get('Name') != prep.NFS_VOLUME or child[0].get('Type') != 'volume'
                        or child[0].get('Source') != expected_source or child[0].get('RW') != (name != 'gateway')):
                    raise RuntimeError('Wrong actual NAS child mount: ' + name)
                mounts.remove(child[0])
                host_mounts = c.get('HostConfig', {}).get('Mounts', [])
                if not any(m.get('Target') == RAW and m.get('VolumeOptions', {}).get('NoCopy') is True for m in host_mounts):
                    raise RuntimeError('Docker nocopy missing: ' + name)
            elif child: raise RuntimeError('SSD recovery still has NAS child mount: ' + name)
            order = lambda ms: sorted(ms, key=lambda m: json.dumps(m, sort_keys=True))
            if order(mounts) != order(old['Mounts']) or c['Image'] != old['Image']:
                raise RuntimeError('Parent mounts or pinned image differ: ' + name)
            expected_env = dict(item.split('=', 1) for item in old['Config'].get('Env', []) if '=' in item)
            if name.startswith('worker'): expected_env['MX_RECOVER_STALE_AGENT_RUNS'] = '0'
            current_env = dict(item.split('=', 1) for item in c['Config'].get('Env', []) if '=' in item)
            expected_cmd = self.overlay['services'][name].get('command', old['Config'].get('Cmd'))
            if (expected_env != current_env or c['Config'].get('Cmd') != expected_cmd
                    or c['Config'].get('Entrypoint') != old['Config'].get('Entrypoint')
                    or c['Config'].get('User') != old['Config'].get('User')):
                raise RuntimeError('Recreated environment/launch differs: ' + name)
        return selected

    def wait_running(self, ids, healthy):
        deadline = time.monotonic() + 180
        while True:
            rows = json.loads(self.command(['docker', 'inspect'] + ids))
            if all(c['State']['Running'] and not c['State'].get('Restarting') and not c['State'].get('Paused') and
                   (not healthy or c['State'].get('Health', {}).get('Status') == 'healthy') for c in rows): return
            if time.monotonic() >= deadline: raise RuntimeError('Service startup/health timeout; inspect private Docker logs.')
            time.sleep(5)

    def start(self, consumers, nas):
        # Commit the no-rollback boundary BEFORE any NAS application can start.
        if nas:
            self.checkpoint('nas_starting', nas_may_have_writes=True)
            self.seal('cutover_nas_writes_possible')
        else: self.checkpoint('ssd_restoring')
        for names, healthy in ((('web', 'chat-gateway'), True), (tuple(WORKERS), False),
                               (('gateway',), True), (('beat',), False)):
            ids = [consumers[name]['Id'] for name in names]
            emit('cutover_starting', services=list(names), storage='nas' if nas else 'ssd')
            self.command(['docker', 'start'] + ids, timeout=None)
            self.wait_running(ids, healthy)
        time.sleep(10)
        ids = {name: c['Id'] for name, c in consumers.items()}
        fresh = self.mounted_services(nas, expected_ids=ids)
        if any(not c['State']['Running'] or c['State'].get('Restarting') for c in fresh.values()):
            raise RuntimeError('Media service exited after startup.')
        return fresh

    def http_probe(self, consumers):
        sample = self.state['sample']
        ports = consumers['gateway'].get('NetworkSettings', {}).get('Ports', {}).get('8080/tcp') or []
        if not ports: raise RuntimeError('Gateway published port unavailable.')
        binding = next((p for p in ports if ':' not in p['HostIp']), ports[0])
        host = binding['HostIp']
        if host in ('0.0.0.0', ''): host = '127.0.0.1'
        if host == '::': host = '::1'
        if ':' in host: host = '[' + host + ']'
        url = 'http://' + host + ':' + binding['HostPort'] + '/media/data_hub_raw_media/' + urllib.parse.quote(sample['relative'], safe='/')
        request = urllib.request.Request(url, headers={'Range': 'bytes=0-1023'})
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=30) as response:
            data = response.read(1025)
            if (response.status != 206 or response.headers.get('Content-Range') != 'bytes 0-1023/' + str(sample['size'])
                    or len(data) != 1024 or hashlib.sha256(data).hexdigest() != sample['prefix_sha256']):
                raise RuntimeError('Gateway existing-media Range/readback mismatch.')
        emit('cutover_http_media_passed', bytes=1024, status=206)

    def execute(self):
        emit('cutover_preflight_start', report_directory=self.path)
        try: previous = read_json(self.output, 'execution.json')
        except FileNotFoundError: pass
        else:
            self.state = previous
            raise RuntimeError('This preparation already has an execution; inspect it, do not rerun --cutover.')
        self.config_guard()
        containers = precopy.inspect_containers()
        selected = select_services(containers)
        if precopy.check_consumers(prep.VOLUME, containers=containers) != self.saved['consumer_fingerprint_normalized']:
            raise RuntimeError('Deployment changed since preparation.')
        if prep.validate_config(self.original, selected): raise RuntimeError('Live configuration/state changed.')
        for name, c in selected.items():
            if c.get('HostConfig', {}).get('RestartPolicy', {}).get('Name') != 'unless-stopped':
                raise RuntimeError('Expected unless-stopped restart policy: ' + name)
            if name.startswith('worker') and c['Config'].get('StopSignal', 'SIGTERM') not in ('', 'SIGTERM', '15'):
                raise RuntimeError('Unexpected worker stop signal: ' + name)
            if name != 'gateway':
                changed = [line for line in self.command(['docker', 'diff', c['Id']]).splitlines()
                           if len(line) > 2 and line[2:].startswith('/app/') and
                           not line[2:].startswith(('/app/media/', '/app/staticfiles/', '/app/__pycache__/')) and
                           line[2:].endswith(('.py', '.sh', '.toml', '.yaml', '.yml', '.json'))]
                if changed: raise RuntimeError('Writable application code changed: ' + name)
        self.open_media()
        self.state = {'schema': 1, 'report_directory': self.path, 'volume': prep.VOLUME,
                      'nas_may_have_writes': False, 'final_sync_passed': False, 'reclaim_ready': False,
                      'databases': self.databases(containers, initial=True), 'started_at_unix': time.time()}
        self.checkpoint('online_catchup')
        self.seal('cutover_in_progress')  # Block old pre-copy/verify tools for this attempt.
        self.sync()  # Reduce the later write-stop window while business still runs.
        self.originals(); self.config_guard()
        self.checkpoint('stopping')
        self.stop(selected)
        self.originals(stopped=True)
        self.final_sync()
        self.checkpoint('creating_nas_containers')
        self.command(create_command(self.path, 'compose.nas.override.json'), timeout=None)
        created = self.mounted_services(True)
        if any(c['State'].get('StartedAt') not in (None, '', '0001-01-01T00:00:00Z') for c in created.values()):
            self.checkpoint('unexpected_nas_start', nas_may_have_writes=True)
            raise RuntimeError('A NAS container has already run unexpectedly; SSD rollback is disabled.')
        require_stopped(created)
        self.checkpoint('nas_containers_created', new_ids={name: c['Id'] for name, c in created.items()})
        running = self.start(created, True)
        self.http_probe(running)
        self.seal('cutover_running_on_nas')
        self.checkpoint('running_on_nas', business_acceptance_pending=True)
        emit('cutover_result', **self.state)

    def recover(self, mode):
        self.state = read_json(self.output, 'execution.json')
        if (self.state.get('schema') != 1 or self.state.get('report_directory') != self.path
                or self.state.get('volume') != prep.VOLUME or self.state.get('reclaim_ready') is not False):
            raise RuntimeError('Execution identity differs.')
        self.config_guard()
        self.open_media(sealed=True)
        if mode == '--resume-nas':
            if not self.state.get('final_sync_passed') or set(self.state.get('new_ids', {})) != prep.SERVICES:
                raise RuntimeError('No complete set of validated NAS containers; inspect failure before recovery.')
            self.identity_probe()
            created = self.mounted_services(True, expected_ids=self.state['new_ids'])
            running = self.start(created, True)  # No rsync and no recreation after NAS writes.
            self.http_probe(running)
            self.seal('cutover_running_on_nas')
            self.checkpoint('running_on_nas', business_acceptance_pending=True)
        else:
            if self.state.get('nas_may_have_writes') is not False:
                raise RuntimeError('NAS may contain new writes. SSD rollback is refused; use --resume-nas or investigate.')
            rows = precopy.inspect_containers()
            self.databases(rows)
            selected = select_services(rows)
            for name, c in selected.items():
                if any(m.get('Name') == prep.NFS_VOLUME for m in c.get('Mounts', [])):
                    if live_state(c) or c['State'].get('StartedAt') not in (None, '', '0001-01-01T00:00:00Z'):
                        raise RuntimeError('A NAS consumer may already have run; SSD rollback refused.')
                elif c['Id'] != self.old[name]['Id']:
                    raise RuntimeError('Unexpected consumer during SSD recovery.')
            self.checkpoint('ssd_restore_stopping')
            self.stop(selected)
            require_stopped(select_services(precopy.inspect_containers()))
            overlay = rollback_overlay(self.overlay)
            try: prep.private_write(self.output, 'compose.ssd.restore.json', overlay)
            except FileExistsError:
                if read_json(self.output, 'compose.ssd.restore.json') != overlay: raise RuntimeError('SSD override changed.')
            actual = json.loads(self.command(prep.compose_command() + ['-f', self.path + '/compose.ssd.restore.json', 'config', '--format', 'json']))
            expected = copy.deepcopy(self.merged); expected['volumes'].pop('mx_static_raw_media_nfs')
            for s in prep.SERVICES:
                expected['services'][s]['volumes'] = [m for m in expected['services'][s]['volumes'] if m.get('target') != RAW]
            if actual != expected: raise RuntimeError('SSD recovery merge changed unrelated configuration.')
            self.command(create_command(self.path, 'compose.ssd.restore.json'), timeout=None)
            self.start(self.mounted_services(False), False)
            self.seal('cutover_rolled_back')
            self.checkpoint('restored_ssd', note='Keep both copies and reports. A new reviewed preparation is needed before another attempt.')
        emit('cutover_result', **self.state)

    def close(self):
        for fd in reversed(self.held): os.close(fd)


def main():
    if len(sys.argv) != 3 or sys.argv[1] not in MODES or not sys.platform.startswith('linux') or os.geteuid() != 0:
        raise SystemExit('Use sudo bash scripts/nas-cutover.sh --cutover|--restore-ssd|--resume-nas <successful-report-directory>.')
    held = []; operation = None
    try:
        precopy.check_host()
        os.environ['COMPOSE_REMOVE_ORPHANS'] = '0'
        lock = os.open('/run/lock/mx-static-nas-sample.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600); held.append(lock)
        info = os.fstat(lock)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022: raise RuntimeError('Unsafe migration lock.')
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        output = open_report(sys.argv[2]); held.append(output)
        operation = Cutover(sys.argv[2], output)
        if sys.argv[1] == '--cutover': operation.execute()
        else: operation.recover(sys.argv[1])
        return 0
    except (OSError, ValueError, RuntimeError, KeyError, subprocess.SubprocessError) as exc:
        state = operation.state if operation is not None else None
        emit('cutover_failed', error=str(exc), report_directory=sys.argv[2],
             phase=state.get('phase') if state else 'preflight',
             nas_may_have_writes=state.get('nas_may_have_writes') if state else None,
             reclaim_ready=False, note='No automatic rollback or deletion. Preserve both copies and report this output.')
        return 1
    finally:
        if operation is not None: operation.close()
        for fd in reversed(held): os.close(fd)


if __name__ == '__main__': sys.exit(main())
