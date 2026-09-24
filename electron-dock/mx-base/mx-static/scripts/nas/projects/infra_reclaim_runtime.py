"""Current deployment evidence for reclaim, separate from immutable cutover proof.

No Compose, application initialization, container creation or media writes.
Every new plan pins one current runtime; later deployment requires a new check.
"""
from contextlib import contextmanager
import hashlib
import json
import os

import cutover
import cutover_prepare as prep
import precopy
import reclaim_plan
from permissions import emit
from projects import infra_runtime, infra_services, infra_storage

POLICY = 'retained-union-media-v1'


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def snapshot(manager, profile):
    policy = infra_runtime.registered(manager, profile)
    infra_runtime.maintenance_guard(manager)
    inspection = infra_storage.collect(manager, profile)
    media = infra_runtime.inspect(manager, profile, require_running=True, inspection=inspection)
    rows = {}
    for c in inspection[0]:
        labels = c.get('Config', {}).get('Labels') or {}
        name = labels.get('com.docker.compose.service')
        if labels.get('com.docker.compose.project') != profile['project']:
            continue
        if name not in prep.SERVICES | infra_services.DEPENDENCIES:
            continue
        if name in rows or str(labels.get('com.docker.compose.oneoff', 'false')).lower() != 'false':
            raise RuntimeError('Reclaim requires one persistent container per reviewed service: ' + name)
        state = c.get('State', {})
        if (state.get('Running') is not True or any(state.get(k) for k in ('Paused', 'OOMKilled', 'Restarting', 'Dead'))
                or state.get('Health', {}).get('Status') == 'unhealthy'):
            raise RuntimeError('Current service is not stably running: ' + name)
        if name in {'web', 'chat-gateway', 'gateway', 'postgres', 'redis'} and state.get('Health', {}).get('Status') != 'healthy':
            raise RuntimeError('Current service is not healthy: ' + name)
        rows[name] = c
    if set(rows) != prep.SERVICES | infra_services.DEPENDENCIES:
        raise RuntimeError('Current media/database/queue service is missing.')
    infra_services.order({n: infra_services.dependencies(n, c) for n, c in rows.items()}, policy)

    # Permit only the verified parent mount hidden by each media NFS child.
    # Also reject SSD aliases in those same containers, not just unknown IDs.
    exposed = []
    for c in inspection[0]:
        mounts = c.get('Mounts', [])
        if c['Id'] in media:
            mounts = [m for m in mounts if not (m.get('Name') == prep.VOLUME and m.get('Destination') == '/app/media')]
        exposed.append(dict(c, Mounts=mounts))
    if reclaim_plan.extra_source_consumers(exposed, set()):
        raise RuntimeError('Other mounts can access retained SSD; reclaim is blocked.')
    _, _, contract = infra_runtime.contract(manager, profile)
    evidence = {'schema': 1, 'project': profile['project'], 'contract_sha256': contract, 'services': {}}
    for name, c in rows.items():
        value = {k: c.get(k) for k in ('Id', 'Image', 'Config', 'HostConfig', 'Mounts')}
        value['ports'] = c.get('NetworkSettings', {}).get('Ports')
        value['process'] = {k: c['State'].get(k) for k in ('Pid', 'StartedAt')}
        # Do not persist environment values or private Docker inspection output.
        evidence['services'][name] = {'id': c['Id'], 'sha256': digest(value)}
    return evidence, {n: rows[n] for n in prep.SERVICES}


class Session:
    def __init__(self, manager, profile, op, expected=None):
        if profile.get('recovery_mode') != 'media-v1' or profile.get('report') != op.path:
            raise RuntimeError('Current reclaim requires the registered media-v1 report.')
        self.manager, self.profile, self.op = manager, dict(profile), op
        self.deleting = expected is not None
        if not op.state.get('repair_of'):
            raise RuntimeError('Current reclaim requires repaired stopped-writer evidence.')
        manager.storage_guard(op, profile)
        self.evidence, self.rows = snapshot(manager, profile)
        if expected is not None and self.evidence != expected:
            raise RuntimeError('Runtime changed since reclaim check; generate a new verified plan.')
        self.guard()

    def guard(self):
        if self.manager.profiles()['part1'] != self.profile:
            raise RuntimeError('Reclaim registration changed during this operation.')
        reclaim_plan.require_completed(self.op.state, self.op.path)
        if cutover.read_json(self.op.output, 'execution.json') != self.op.state:
            raise RuntimeError('Historical execution record changed.')
        if self.op.job is not None and precopy.read_state(self.op.job).get('phase') != 'cutover_running_on_nas':
            raise RuntimeError('NAS marker no longer running.')
        self.manager.storage_guard(self.op, self.profile)
        evidence, rows = snapshot(self.manager, self.profile)
        if evidence != self.evidence:
            raise RuntimeError('Runtime changed during reclaim; no further deletion is allowed.')
        if self.deleting:
            from projects import infra_reclaim
            if not infra_reclaim.recovery_evidence(self.manager)['verified']:
                raise RuntimeError('Recovery coverage changed; no further deletion is allowed.')
        self.rows = rows

    def probes(self):
        self.guard()
        # Use the current web container, never a possibly removed historic image.
        code = ('import json,os; p="/app/media/data_hub_raw_media"; '
                'assert os.stat(p).st_ino == ' + str(self.op.saved['precopy_state']['target_inode']) + '; '
                'assert any(x.split()[4]==p and " - nfs " in x for x in open("/proc/self/mountinfo")); '
                'print(json.dumps({"nfs_identity_passed":True}))')
        value = json.loads(self.manager.run(['docker', 'exec', self.rows['web']['Id'], 'python', '-c', code], timeout=None))
        if value != {'nfs_identity_passed': True}:
            raise RuntimeError('Current container NAS identity probe failed.')
        self.op.http_probe(self.rows)
        self.guard()
        emit('nas_reclaim_runtime_verified', runtime_snapshot_sha256=digest(self.evidence), containers=len(self.evidence['services']))


@contextmanager
def operation(manager, profile):
    output = cutover.open_report(profile['report'])
    op = None
    try:
        op = cutover.Cutover(profile['report'], output)
        op.state = cutover.read_json(output, 'execution.json')
        session = Session(manager, profile, op)
        yield op, session.rows, session
    finally:
        if op is not None:
            op.close()
        os.close(output)
