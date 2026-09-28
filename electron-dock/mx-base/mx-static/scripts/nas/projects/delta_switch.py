"""Explicit delta-only maintenance switch; no SSD fallback or data deletion.

Execution evidence is separate from immutable preparation/copy receipts. Durable
authority precedes stopping; crash recovery is explicit and never repeats final
SSD copying after any NAS application may have started.
"""
import copy
import json
import os
from pathlib import Path
import re
import time

import cutover
import cutover_prepare as prep
import precopy
import reclaim_plan
from permissions import emit
from projects import delta_copy as media
from projects import delta_migration as review
from projects import delta_runtime as runtime
from projects import infra_deploy, infra_services, infra_storage
from projects import infra_repair_switch as files

ROOT = '/var/lib/mx-static/nas-delta-cutover'
LIMITS = {'max_files': media.MAX_FILES, 'max_bytes': media.MAX_BYTES,
          'max_manifest_bytes': media.MAX_MANIFEST_BYTES}


def validate_path(path, resume=False):
    root = ROOT if resume else review.ROOT
    if not re.fullmatch(re.escape(root) + '/delta-[0-9a-f]{32}', path):
        raise RuntimeError('Use the exact delta ' + ('execution' if resume else 'deployment preparation') + ' report.')


def load_preparation(path):
    validate_path(path)
    fd = media.open_absolute(path, private=True)
    try:
        try: os.stat('failed.json', dir_fd=fd, follow_symlinks=False)
        except FileNotFoundError: pass
        else: raise RuntimeError('Preparation also has a failure receipt.')
        values = {key: media.read_private(fd, name)[0] for key, name in (
            ('review', 'review.json'), ('copy', 'copy-receipt.json'), ('old', 'containers.private.json'),
            ('base', 'compose.current.private.json'), ('overlay', 'compose.nas.candidate.json'),
            ('merged', 'compose.nas.candidate.private.json'))}
    finally: os.close(fd)
    r = values['review']
    if (r.get('schema') != 1 or r.get('project') != media.PROJECT or r.get('volume') != media.VOLUME
            or r.get('report_directory') != path or r.get('phase') != 'deployment_review_complete'
            or r.get('deployment_review_passed') is not True or r.get('review_items') != []
            or r.get('candidate_merge_verified') is not True
            or any(r.get(k) is not False for k in ('production_changed', 'source_deleted', 'reclaim_ready'))):
        raise RuntimeError('Delta deployment preparation did not pass.')
    hook = r.get('release_hook', {})
    if any(hook.get(k) is not True for k in ('installed_entry_referenced', 'storage_mode_check_present', 'post_release_check_present', 'nas_permission_prune_present')):
        raise RuntimeError('Application NAS release hook is not reviewed.')
    if review.completed_copy(r['copy_attempt']) != values['copy']:
        raise RuntimeError('Copy lineage changed after deployment preparation.')
    selected = review.select(list(values['old'].values()))
    if selected != values['old']:
        raise RuntimeError('Prepared service identity keys differ.')
    expected = prep.candidate({n: selected[n] for n in prep.SERVICES}, media.NFS_VOLUME)
    if values['overlay'] != expected: raise RuntimeError('Prepared NAS candidate differs from safe maintenance launch.')
    prep.validate_merged(values['base'], values['merged'], expected, media.NFS_VOLUME)
    return values


def require_same_deployment(manager, profile, values):
    declaration = review.definition(manager, profile)
    if review.inputs(declaration) != values['review']['deployment_files_sha256']:
        raise RuntimeError('Deployment files changed after preparation; prepare again, keep all existing data.')
    rows = review.select(precopy.inspect_containers())
    if review.runtime_snapshot(rows) != review.runtime_snapshot(values['old']):
        raise RuntimeError('Delta runtime changed after preparation; prepare a new deployment review.')
    base = json.loads(manager.run(review.command() + ['config', '--format', 'json']))
    if base != values['base']: raise RuntimeError('Current Compose model differs from preparation.')
    _, issues = review.launch_review(manager, base, rows, declaration)
    if issues: raise RuntimeError('Current startup/image review failed; no service stopped.')
    media.current(manager)  # Current XFS and all source/NAS aliases, not only labels.
    return rows


def stop_policy(rows):
    """Review configured signals, never override them on docker stop.

    nginx's official entrypoint uses SIGQUIT for graceful shutdown. Application
    workers retain Docker's default SIGTERM for warm shutdown. This exception
    does not allow QUIT (cold shutdown) on workers or arbitrary gateway commands.
    """
    for name in sorted(prep.SERVICES):
        c = rows[name]
        policy = c.get('HostConfig', {}).get('RestartPolicy', {}).get('Name')
        if policy != 'unless-stopped':
            raise RuntimeError('Media restart policy needs review: ' + json.dumps(
                {'service': name, 'restart_policy': policy}))
        configured = c['Config'].get('StopSignal')
        effective = 'SIGTERM' if configured in (None, '', 'SIGTERM', '15') else configured
        if effective == '3': effective = 'SIGQUIT'
        nginx_quit = (name == 'gateway' and effective == 'SIGQUIT'
                      and c['Config'].get('Entrypoint') == ['/docker-entrypoint.sh']
                      and c['Config'].get('Cmd') == ['nginx', '-g', 'daemon off;'])
        details = {'service': name, 'configured_stop_signal': configured, 'effective_stop_signal': effective}
        if effective != 'SIGTERM' and not nginx_quit:
            raise RuntimeError('Media graceful stop signal needs review: ' + json.dumps(details))
        emit('nas_delta_stop_policy', **details)


def ensure_volume(manager, profile):
    names = manager.run(['docker', 'volume', 'ls', '--format', '{{.Name}}']).splitlines()
    if media.NFS_VOLUME not in names:
        args = ['docker', 'volume', 'create', '--driver', 'local']
        for key, value in sorted(infra_storage.storage_spec(profile)[2].items()):
            args += ['--opt', key + '=' + value]
        manager.run(args + [media.NFS_VOLUME])  # Explicit migration only, never boot/release.
    records = json.loads(manager.run(['docker', 'volume', 'inspect', media.NFS_VOLUME]))
    if len(records) != 1: raise RuntimeError('Expected one delta NFS volume.')
    infra_storage.validate_volume(profile, records[0])


class Switch:
    def __init__(self, manager, profile, path, output, values, state):
        self.manager, self.profile, self.path, self.output = manager, profile, path, output
        self.values, self.state = values, state
        self.persisted_state = copy.deepcopy(state)
        self.old, self.overlay = values['old'], values['overlay']
        self.held = []
        with media.media() as view:
            if media.identity(view) != values['copy']['media_identity']:
                raise RuntimeError('Source/NAS identities or original marker changed.')
            for field in ('source', 'target', 'job'):
                fd = os.dup(view[field]); self.held.append(fd); setattr(self, field, fd)

    def close(self):
        for fd in reversed(self.held): os.close(fd)

    def checkpoint(self, phase, **extra):
        self.state.update(extra, phase=phase, updated_at_unix=time.time())
        cutover.atomic_json(self.output, 'execution.json', self.state)
        self.persisted_state = copy.deepcopy(self.state)
        emit('nas_delta_switch_phase', report_directory=self.path, phase=phase,
             nas_may_have_writes=self.state.get('nas_may_have_writes', False), reclaim_ready=False)

    def command(self, args, timeout=45):
        # Captured errors never expose Compose/environment values in public logs.
        return self.manager.run(args, timeout=timeout)

    def config_guard(self):
        if self.manager.profiles()['part2'] != self.profile:
            raise RuntimeError('Delta registry changed during switch.')
        runtime.registered(self.manager, self.profile)
        runtime.maintenance_guard(self.manager, self.path)
        if review.inputs(review.definition(self.manager, self.profile)) != self.values['review']['deployment_files_sha256']:
            raise RuntimeError('Deployment changed during switch; do not resume with new application settings.')
        if media.read_private(self.output, 'baseline.private.json')[0] != self.values:
            raise RuntimeError('Private switch baseline changed.')
        if media.read_private(self.output, 'compose.nas.override.json')[0] != self.overlay:
            raise RuntimeError('Private switch overlay changed.')
        if media.read_private(self.output, 'execution.json')[0] != self.persisted_state:
            raise RuntimeError('Switch checkpoint changed concurrently.')

    def media_guard(self):
        with media.media() as view:
            if (media.identity(view) != self.values['copy']['media_identity'] or any(
                    precopy.source_identity(getattr(self, k)) != precopy.source_identity(view[k])
                    for k in ('source', 'target', 'job'))):
                raise RuntimeError('Delta source/NAS path changed during switch.')

    def rows(self):
        all_rows = precopy.inspect_containers()
        chosen = {}
        for c in all_rows:
            labels = c.get('Config', {}).get('Labels') or {}
            if labels.get('com.docker.compose.project') != media.PROJECT: continue
            n = labels.get('com.docker.compose.service')
            if n not in self.old or n in chosen or str(labels.get('com.docker.compose.oneoff', 'false')).lower() != 'false':
                raise RuntimeError('Delta services changed during switch; no automatic removal.')
            chosen[n] = c
        if set(chosen) != set(self.old): raise RuntimeError('Delta service missing during switch.')
        for n in set(self.old) - prep.SERVICES:
            if review.runtime_snapshot({n: chosen[n]}) != review.runtime_snapshot({n: self.old[n]}):
                raise RuntimeError('Database/queue/auxiliary changed during switch: ' + n)
        reclaim_plan.health_guard({n: chosen[n] for n in review.DEPENDENCIES})
        # Check all attached volume aliases, including binds in other projects.
        selected_ids = {chosen[n]['Id'] for n in prep.SERVICES}
        names = sorted({m['Name'] for c in all_rows for m in c.get('Mounts', []) if m.get('Type') == 'volume'})
        definitions = json.loads(self.command(['docker', 'volume', 'inspect'] + names)) if names else []
        if {v['Name'] for v in definitions} != set(names): raise RuntimeError('Incomplete volume alias inspection.')
        for v in definitions:
            device = (v.get('Options') or {}).get('device', '')
            path = device.split(':', 1)[-1]
            alias = (device.startswith('/') and any(media.overlaps(device, root) for root in (media.SOURCE, media.TARGET))) or (
                path.startswith('/') and media.overlaps(path, media.EXPORT_TARGET))
            if alias:
                if v['Name'] != media.NFS_VOLUME: raise RuntimeError('Unreviewed delta media volume alias.')
                infra_storage.validate_volume(self.profile, v)
        roots = (media.SOURCE, media.TARGET, '/data/docker/volumes/' + media.NFS_VOLUME + '/_data')
        for c in all_rows:
            for m in c.get('Mounts', []):
                source = m.get('Source', '')
                if (m.get('Name') in (media.VOLUME, media.NFS_VOLUME) or
                        (source.startswith('/') and any(media.overlaps(source, p) for p in roots))):
                    if c['Id'] not in selected_ids: raise RuntimeError('Unreviewed delta media consumer; no automatic stop.')
        return chosen

    def writer_guard(self, stopped=False):
        rows = self.rows()
        for n in prep.SERVICES:
            c, old = rows[n], self.old[n]
            if any(c.get(k) != old.get(k) for k in ('Id', 'Image', 'Config', 'HostConfig', 'Mounts')):
                raise RuntimeError('Original SSD writer changed: ' + n)
            state = c['State']
            if state.get('Running') and any(state.get(k) != old['State'].get(k) for k in ('Pid', 'StartedAt')):
                raise RuntimeError('Original SSD writer restarted: ' + n)
            if any(state.get(k) for k in ('Paused', 'Restarting', 'OOMKilled', 'Dead')):
                raise RuntimeError('SSD writer needs manual state review: ' + n)
        if stopped: cutover.require_stopped({n: rows[n] for n in prep.SERVICES})
        return {n: rows[n] for n in prep.SERVICES}

    def identity_probe(self, write=False):
        inode = self.values['copy']['media_identity']['target_identity']['inode']
        code = prep.PROBE if write else (
            'import os,json; assert os.stat("/nas").st_ino==' + str(inode) + '; '
            'assert any(x.split()[4]=="/nas" and " - nfs" in x for x in open("/proc/self/mountinfo")); '
            'print(json.dumps({"nfs_identity_passed":True}))')
        result = json.loads(self.command(['docker', 'run', '--rm', '--pull=never', '--network=none',
            '--read-only', '--no-healthcheck', '--user', '0:0', '--entrypoint', 'python', '--mount',
            'type=volume,src=' + media.NFS_VOLUME + ',dst=/nas,volume-nocopy' + ('' if write else ',readonly'),
            self.old['web']['Image'], '-c', code, str(inode)], timeout=None))
        keys = ('docker_nfs_mount', 'same_target_inode', 'root_4k_write_read') if write else ('nfs_identity_passed',)
        if any(result.get(k) is not True for k in keys): raise RuntimeError('Delta isolated NFS probe failed.')
        emit('nas_delta_nfs_probe', write_test=write, **result)

    def created(self):
        rows = self.rows()
        runtime.inspect(self.manager, self.profile, inspection=infra_storage.collect(self.manager, self.profile))
        for n in prep.SERVICES:
            c, old = rows[n], self.old[n]
            mounts = [m for m in c.get('Mounts', []) if m.get('Destination') != media.RAW]
            ordered = lambda ms: sorted(ms, key=lambda m: json.dumps(m, sort_keys=True))
            expected_env = dict(x.split('=', 1) for x in old['Config'].get('Env', []) if '=' in x)
            if n.startswith('worker'): expected_env['MX_RECOVER_STALE_AGENT_RUNS'] = '0'
            actual_env = dict(x.split('=', 1) for x in c['Config'].get('Env', []) if '=' in x)
            if (ordered(mounts) != ordered(old['Mounts']) or c['Image'] != old['Image'] or actual_env != expected_env
                    or c['Config'].get('Cmd') != self.overlay['services'][n].get('command', old['Config'].get('Cmd'))
                    or any(c['Config'].get(k) != old['Config'].get(k) for k in ('Entrypoint', 'User', 'WorkingDir'))):
                raise RuntimeError('Created container launch/data mounts differ: ' + n)
            if self.state.get('new_ids') and c['Id'] != self.state['new_ids'][n]:
                raise RuntimeError('NAS container replaced during switch: ' + n)
        return {n: rows[n] for n in prep.SERVICES}

    def finish(self):
        rows = self.created()
        deadline = time.monotonic() + 180
        while True:
            try: reclaim_plan.health_guard(rows); break
            except RuntimeError:
                if time.monotonic() >= deadline: raise
                time.sleep(2)
                self.config_guard(); rows = self.created()
        # This helper only uses sample/command-free HTTP logic, no infra identity.
        cutover.Cutover.http_probe(self, rows)
        code = (Path(__file__).parent / 'infra_probe.py').read_text()
        inode = self.values['copy']['media_identity']['target_identity']['inode']
        for n in sorted(prep.SERVICES - {'gateway'}):
            result = json.loads(self.command(['docker', 'exec', rows[n]['Id'], 'python', '-B', '-c',
                                              code, 'probe', str(inode)], timeout=None))
            if any(result.get(k) is not True for k in ('effective_read', 'effective_write', 'effective_search',
                                                      'write_read_rename_passed', 'cleanup_passed')):
                raise RuntimeError('Application NAS I/O failed: ' + n)
            emit('nas_application_permissions', service=n, **result)
        self.config_guard(); self.media_guard(); reclaim_plan.health_guard(self.created())
        self.checkpoint('running_on_nas', final_sync_passed=True, business_acceptance_pending=True)
        runtime.finish(self.manager, self.profile, self.path)
        emit('nas_delta_switch_complete', **self.state)

    def continue_switch(self):
        self.config_guard(); self.media_guard()
        if self.state.get('phase') == 'running_on_nas':
            # Complete registration after a crash between the two durable writes.
            self.finish(); return
        if not self.state.get('new_ids'):
            if self.state.get('phase') not in ('prepared', 'stopping', 'finalizing', 'repair_final_passed'):
                raise RuntimeError('Creation may be partial; inspect exact container IDs before resume. No SSD fallback.')
            if self.state.get('nas_may_have_writes'):
                raise RuntimeError('NAS application writes possible; final SSD copying is prohibited.')
            self.writer_guard()
            self.checkpoint('stopping')
            for group in cutover.STOP_GROUPS:
                self.config_guard(); rows = self.writer_guard()
                ids = [rows[n]['Id'] for n in group if rows[n]['State']['Running']]
                if ids:
                    emit('nas_delta_stopping', services=[n for n in group if rows[n]['Id'] in ids], graceful=True)
                    self.command(['docker', 'stop', '-t', '-1'] + ids, timeout=None)
            self.writer_guard(stopped=True)
            self.checkpoint('finalizing', final_sync_passed=False)
            files.final_union(self, writer_check=lambda op, stopped=False: op.writer_guard(stopped),
                              media_check=lambda op: op.media_guard(), limits=LIMITS)
            self.config_guard(); self.writer_guard(stopped=True)
            self.checkpoint('creating_nas_containers')
            command = review.command() + ['-f', self.path + '/compose.nas.override.json', 'up', '--no-deps',
                '--no-build', '--pull', 'never', '--no-start', '--force-recreate', '--remove-orphans=false'] + sorted(prep.SERVICES)
            infra_deploy.run_logged(command, self.output, 'compose-create.private.log')
            rows = self.created()
            cutover.require_stopped(rows)
            if any(c['State'].get('StartedAt') not in (None, '', '0001-01-01T00:00:00Z') for c in rows.values()):
                raise RuntimeError('NAS container started before checkpoint; do not copy/restore SSD.')
            self.checkpoint('nas_containers_created', new_ids={n: c['Id'] for n, c in rows.items()})
        if self.state.get('phase') not in ('nas_containers_created', 'nas_starting'):
            raise RuntimeError('Unreviewed switch phase; no automatic recovery.')
        if not self.state.get('final_sync_passed'): raise RuntimeError('Stopped-writer final sync missing.')
        self.created()
        self.checkpoint('nas_starting', nas_may_have_writes=True)
        # Dependency order and current IDs are rechecked. DB/Redis are already
        # running and stay untouched; no builds or Compose in this recovery path.
        infra_services.recover(self.manager, self.profile, maintenance_report=self.path,
                               guard=lambda: (self.config_guard(), self.created()))
        self.finish()


def execute(manager, profile, path, resume=False):
    runtime.contract(manager, profile)
    validate_path(path, resume)
    op = None; output = None; execution_path = path if resume else None
    new_attempt = False; registration_started = False
    try:
        if not manager.recovery_control.installed_current(manager):
            raise RuntimeError('Install the current runtime before delta switch; release guard must match.')
        if resume:
            runtime.registered(manager, profile)
            record = runtime.read_record(manager)
            if record.get('source_report') != path: raise RuntimeError('Resume path differs from delta authority.')
            runtime.maintenance_guard(manager, path)
            output = media.open_absolute(path, private=True)
            values = media.read_private(output, 'baseline.private.json')[0]
            state = media.read_private(output, 'execution.json')[0]
            if load_preparation(state['preparation_report']) != values:
                raise RuntimeError('Resume baseline differs from original immutable preparation.')
            if (state.get('schema') != 1 or state.get('project') != media.PROJECT
                    or state.get('volume') != media.VOLUME or state.get('report_directory') != path
                    or state.get('source_deleted') is not False or state.get('reclaim_ready') is not False):
                raise RuntimeError('Invalid delta execution checkpoint.')
            op = Switch(manager, profile, path, output, values, state)
        else:
            if runtime.read_record(manager, optional=True) is not None:
                raise RuntimeError('Delta authority exists; use migration resume with its exact execution report.')
            new_attempt = True
            values = load_preparation(path)
            require_same_deployment(manager, profile, values)
            stop_policy(values['old'])  # Before creating/probing NFS or stopping services.
            with media.media() as view:
                if media.identity(view) != values['copy']['media_identity']: raise RuntimeError('Media identity changed.')
            # Verify dependency graph before any stop. Auxiliary stays outside it.
            graph = {n: infra_services.dependencies(n, c) for n, c in values['old'].items()
                     if n in prep.SERVICES | set(review.DEPENDENCIES)}
            if any(set(deps) - set(graph) for deps in graph.values()):
                raise RuntimeError('Media dependency graph includes an unreviewed auxiliary; no services stopped.')
            infra_services.order(graph, runtime.contract(manager, profile)[0])
            root = manager.secure_directory(ROOT)
            try:
                fs = os.fstatvfs(root)
                if (manager.run(['findmnt', '-rn', '-T', ROOT, '-o', 'FSTYPE']).strip() not in ('xfs', 'ext4', 'btrfs')
                        or fs.f_bavail * fs.f_frsize < 1024 ** 3):
                    raise RuntimeError('Local execution reports require 1 GiB free.')
                name, output = files.new_directory(root, 'delta-')
                execution_path = ROOT + '/' + name
            finally: os.close(root)
            prep.private_write(output, 'baseline.private.json', values)
            prep.private_write(output, 'compose.nas.override.json', values['overlay']); os.fsync(output)
            state = {'schema': 1, 'project': media.PROJECT, 'volume': media.VOLUME,
                     'report_directory': execution_path, 'preparation_report': path,
                     'source_deleted': False, 'reclaim_ready': False, 'final_sync_passed': False,
                     'nas_may_have_writes': False, 'business_acceptance_pending': True,
                     'started_at_unix': time.time()}
            op = Switch(manager, profile, execution_path, output, values, state)
            ensure_volume(manager, profile)
            op.identity_probe(write=True)
            # Verify intended Compose merge NOW, and never execute the business
            # release script (which can migrate DB/reset admin/change permissions).
            merged = json.loads(manager.run(review.command() + ['-f', execution_path + '/compose.nas.override.json', 'config', '--format', 'json']))
            if merged != values['merged']: raise RuntimeError('NAS candidate render changed.')
            # Do not create missing app data volumes during storage maintenance.
            infra_deploy.data_volumes(manager, profile, merged)
            _, folder = files.new_directory(output, 'online-review-')
            try: files.union_plan(op.source, op.target, folder, LIMITS)
            finally: os.close(folder)
            require_same_deployment(manager, profile, values)
            op.writer_guard(); op.media_guard()
            op.checkpoint('prepared')
            registration_started = True  # A failed write/fsync may still leave authority on disk.
            runtime.begin(manager, profile, execution_path)
        op.continue_switch()
        return op.state
    except Exception as exc:
        preflight_only = new_attempt and not registration_started
        emit('nas_delta_switch_failed', report_directory=execution_path,
             phase=op.state.get('phase', 'preflight') if op else 'preflight', error=str(exc),
             source_deleted=False, reclaim_ready=False, preflight_only=preflight_only,
             next_action='retry_switch_after_fix' if preflight_only else 'inspect_execution',
             note=('Keep SSD and NAS. No automatic rollback. ' +
                   ('No maintenance registration or service stop attempted. After fixing the error, '
                    'retry migration switch with the original preparation if unchanged; '
                    'do not resume this preflight report.' if preflight_only else
                    'Inspect durable registration/checkpoint before migration resume; '
                    'partial container creation requires inspection.')))
        raise
    finally:
        if op is not None: op.close()
        if output is not None: os.close(output)
