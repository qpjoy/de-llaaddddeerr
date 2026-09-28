"""Delta NAS authority, independent of app env, images and container IDs.

The Git declaration requires NAS even when this local record is lost. Only an
explicit successful switch completes registration; release/recovery fail closed
during maintenance. Ordinary recovery never creates or deletes storage.
"""
import hashlib
import json
import os
import re
import time

import catalog
import cutover
import cutover_prepare as prep
from projects import delta_copy as media
from projects import infra_storage as storage
from projects import infra_runtime
from sample_copy import DIR_FLAGS

RECORD = 'delta-media.json'
REPORT_ROOT = '/var/lib/mx-static/nas-delta-cutover'


def contract(manager, profile):
    storage.storage_spec(profile)
    if (profile.get('project') != media.PROJECT or profile.get('recovery_mode') != 'delta-media-v1'
            or any(profile.get(k + '_file') != 'part2.' + k + '.json' for k in ('storage', 'runtime', 'release'))):
        raise RuntimeError('Delta requires its explicit NAS contract; no SSD fallback.')
    policy = catalog.read_relative(manager.CONFIG.parent, profile['runtime_file'])
    declared = catalog.read_relative(manager.CONFIG.parent, profile['storage_file'])
    names = [n for group in policy.get('start_groups', []) for n in group]
    if (policy.get('schema') != 1 or policy.get('project') != media.PROJECT
            or policy.get('parent_path') != '/app/media' or policy.get('media_path') != media.RAW
            or policy.get('docker_root') != '/data/docker'
            or policy.get('nfs_options') != storage.storage_spec(profile)[2]
            or set(names) != prep.SERVICES or len(names) != len(set(names))):
        raise RuntimeError('Unreviewed delta runtime contract.')
    expected = {'services': {n: {'volumes': [{'type': 'volume', 'source': 'mx_static_raw_media_nfs',
        'target': media.RAW, 'read_only': n == 'gateway', 'volume': {'nocopy': True}}]} for n in prep.SERVICES},
        'volumes': {'mx_static_raw_media_nfs': {'external': True, 'name': media.NFS_VOLUME}}}
    if declared != expected:
        raise RuntimeError('Delta storage declaration changed.')
    identity = dict(policy, storage=declared, parent_volume=media.VOLUME, nfs_volume=media.NFS_VOLUME)
    digest = hashlib.sha256(json.dumps(identity, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    return policy, declared, digest


def read_record(manager, optional=False):
    try: folder = media.open_absolute(manager.AUTO_DIR)
    except FileNotFoundError:
        if optional: return None
        raise RuntimeError('Delta NAS switch has not completed; release/recovery blocked.')
    try:
        info = os.fstat(folder)
        if info.st_uid != os.geteuid() or info.st_mode & 0o022:
            raise RuntimeError('Unsafe delta registration directory.')
        try:
            value = media.read_private(folder, RECORD, 16384)[0]
            if not isinstance(value, dict): raise RuntimeError('Invalid delta registration object.')
            return value
        except FileNotFoundError:
            if optional: return None
            raise RuntimeError('Delta NAS registration missing; never fall back to SSD.')
    finally: os.close(folder)


def registered(manager, profile):
    policy, _, digest = contract(manager, profile)
    value = read_record(manager)
    if (value.get('schema') != 1 or value.get('project') != media.PROJECT
            or value.get('nas_authoritative') is not True or value.get('contract_sha256') != digest
            or value.get('phase') not in ('maintenance', 'running_on_nas')
            or not re.fullmatch(re.escape(REPORT_ROOT) + '/delta-[0-9a-f]{32}', str(value.get('source_report')))):
        raise RuntimeError('Delta NAS registration differs; do not replace or bypass it.')
    return policy


def maintenance_guard(manager, owner=None):
    value = read_record(manager)
    if value.get('phase') != 'running_on_nas' and (owner is None or value.get('maintenance_report') != owner):
        raise RuntimeError('Delta migration unfinished; resume its exact report: ' + str(value.get('maintenance_report')))
    if value.get('maintenance_report') and value['maintenance_report'] != owner:
        raise RuntimeError('Delta maintenance owns storage; release/recovery blocked.')


def begin(manager, profile, report):
    _, _, digest = contract(manager, profile)
    if read_record(manager, optional=True) is not None:
        raise RuntimeError('Delta NAS authority already exists; use its resume path, never repeat cutover.')
    folder = manager.secure_directory(manager.AUTO_DIR)
    try:
        prep.private_write(folder, RECORD, {'schema': 1, 'project': media.PROJECT,
            'nas_authoritative': True, 'contract_sha256': digest, 'phase': 'maintenance',
            'maintenance_report': report, 'source_report': report, 'registered_unix': time.time()})
        os.fsync(folder)
    finally: os.close(folder)


def finish(manager, profile, report):
    registered(manager, profile)
    value = read_record(manager)
    if value.get('source_report') != report or value.get('maintenance_report') not in (None, report):
        raise RuntimeError('Delta maintenance owner changed.')
    value.update(phase='running_on_nas', completed_unix=time.time())
    value.pop('maintenance_report', None)
    folder = manager.secure_directory(manager.AUTO_DIR)
    try: cutover.atomic_json(folder, RECORD, value)
    finally: os.close(folder)


def inspect(manager, profile, require_running=False, expected_ids=None, inspection=None):
    # The shared evaluator takes explicit identities, never rewrites infra globals.
    contract(manager, profile)
    inspection = inspection if inspection is not None else storage.collect(manager, profile)
    for c in inspection[0]:
        labels = c.get('Config', {}).get('Labels') or {}
        name = labels.get('com.docker.compose.service')
        if labels.get('com.docker.compose.project') != media.PROJECT or name not in ('postgres', 'redis'): continue
        mounts = c.get('Mounts', [])
        volume = media.PROJECT + '_' + name + '_data'
        target = '/var/lib/postgresql/data' if name == 'postgres' else '/data'
        if (len(mounts) != 1 or mounts[0].get('Name') != volume or mounts[0].get('Type') != 'volume'
                or mounts[0].get('Source') != '/data/docker/volumes/' + volume + '/_data'
                or mounts[0].get('Destination') != target or mounts[0].get('RW') is not True):
            raise RuntimeError('Delta database/queue storage identity changed: ' + name)
    return infra_runtime.inspect(manager, profile, require_running, expected_ids, inspection)


def model_guard(manager, profile, model):
    from projects import infra_deploy
    infra_deploy.model_guard(manager, profile, model, contract=contract)
    for key in ('media_data', 'static_data', 'postgres_data', 'redis_data'):
        if model.get('volumes', {}).get(key, {}).get('name') != media.PROJECT + '_' + key:
            raise RuntimeError('Delta protected data volume changed: ' + key)
