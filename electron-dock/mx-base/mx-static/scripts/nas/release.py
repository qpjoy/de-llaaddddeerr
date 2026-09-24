#!/usr/bin/env python3
"""Compose admission for the two reviewed application release entries.

Called by the application, never by boot recovery. No builds, migrations or
restarts are inferred: only the supplied, checked Compose command is executed.
"""
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
from types import SimpleNamespace

import catalog
import manage
from projects import infra_deploy, infra_runtime, infra_storage

DOCKER = ['docker', '--host', 'unix:///var/run/docker.sock']
OPTIONS = {'-f', '--env-file', '-p', '--project-directory'}
COMMANDS = {'config', 'pull', 'build', 'up', 'run', 'exec', 'ps', 'logs', 'start', 'restart', 'stop',
            'mx-nas-check', 'mx-nas-mode'}


def local_command(args):
    if args[0] != 'docker':
        raise RuntimeError('Only local Docker commands are supported by this entry.')
    return DOCKER + args[1:]


def read_command(args):
    return manage.run(local_command(args))


def parse(argv):
    if '--' not in argv:
        raise RuntimeError('Expected Compose global options, then -- and the Compose command.')
    split = argv.index('--')
    options, command = argv[:split], argv[split + 1:]
    if len(options) % 2 or not command or command[0] not in COMMANDS:
        raise RuntimeError('Unsupported Compose action; down/rm/prune are not release operations.')
    seen = []
    for key, value in zip(options[::2], options[1::2]):
        if key not in OPTIONS or not value or value.startswith('-'):
            raise RuntimeError('Unsupported Compose option.')
        if key != '-f' and key in seen:
            raise RuntimeError('Duplicate Compose option.')
        seen.append(key)
    if '-f' not in seen or '--env-file' not in seen:
        raise RuntimeError('Explicit Compose files and environment file are required.')
    if command[0].startswith('mx-nas-') and len(command) != 1:
        raise RuntimeError('The storage checks take no arguments.')
    if command[0] == 'run':
        # Command arguments after the service belong to the application. Before
        # the service, prohibit ad-hoc volumes/entrypoints that evade the model.
        i = 1
        while i < len(command) and command[i].startswith('-'):
            arg = command[i]
            if arg in ('--rm', '--no-deps', '-T'):
                i += 1
            elif arg in ('-e', '--env') and i + 1 < len(command):
                i += 2
            else:
                raise RuntimeError('Unreviewed one-off container option: ' + arg)
        if i == len(command):
            raise RuntimeError('One-off container service is missing.')
    return options, command


def inputs(options):
    files = [Path(v).resolve(strict=True) for k, v in zip(options[::2], options[1::2])
             if k in ('-f', '--env-file')]
    return {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in files}


def select(index, model):
    matches = [p for p in index['parts'].values() if p['project'] == model.get('name')]
    if len(matches) != 1:
        raise RuntimeError('Unknown application project; refusing implicit local storage.')
    profile = matches[0]
    volumes = model.get('volumes', {})
    if volumes.get('media_data', {}).get('name') != profile['volume']:
        raise RuntimeError('Application media parent volume differs from the registered project.')
    if profile['project'] == 'mx_data' and profile.get('recovery_mode') == 'media-v1':
        if not profile.get('release_file'):
            raise RuntimeError('Required NAS release declaration is missing.')
        return profile, 'nas'
    if (profile['project'] == 'delta_59202' and profile.get('report') is None
            and profile.get('storage_file') is None and profile.get('recovery_mode') is None):
        return profile, 'local'
    raise RuntimeError('This project needs a reviewed NAS release adapter; no SSD fallback.')


def current(manager, profile, require_all=False):
    ids = manager.run(['docker', 'ps', '-aq']).split()
    containers = json.loads(manager.run(['docker', 'inspect'] + ids)) if ids else []
    data = infra_storage.collect(manager, profile, containers=containers)
    result = infra_storage.evaluate(profile, *data, allow_stopped=True, allow_replicas=True)
    bad = list(result['issues'])
    bad += [s['service'] for s in result['services'] if s['issues'] and (require_all or s.get('id'))]
    if bad:
        raise RuntimeError('Existing media is not verified on NAS; reconcile SSD writes before releasing: ' + '; '.join(bad))
    return containers


def database_mounts(model, containers):
    """Existing DB/queue mounts may not be redirected by an env change."""
    volumes = model.get('volumes', {})
    for name in ('postgres', 'redis'):
        mounts = model.get('services', {}).get(name, {}).get('volumes', [])
        if (len(mounts) != 1 or mounts[0].get('type') != 'volume'
                or mounts[0].get('source') != name + '_data'
                or not mounts[0].get('target') or mounts[0].get('volume', {}).get('subpath')):
            raise RuntimeError('Database/queue must retain its named data volume: ' + name)
    for c in containers:
        labels = c.get('Config', {}).get('Labels') or {}
        name = labels.get('com.docker.compose.service')
        if labels.get('com.docker.compose.project') != model['name'] or name not in ('postgres', 'redis'):
            continue
        expected = {m['target']: volumes[m['source']]['name']
                    for m in model['services'][name].get('volumes', []) if m.get('type') == 'volume'}
        actual = {m['Destination']: m.get('Name') for m in c.get('Mounts', [])}
        if not expected or actual != expected:
            raise RuntimeError('Existing database/queue volume mapping changed: ' + name)


def execute(options, command, reader=read_command, runner=None):
    index, _, _ = catalog.load(manage.CONFIG)
    info = json.loads(reader(['docker', 'info', '--format', '{{json .}}']))
    if (socket.gethostname() != index['host'] or info.get('Name') != index['host']
            or info.get('DockerRootDir') != '/data/docker'):
        raise RuntimeError('Release guard requires the registered local Docker host/root.')
    before = inputs(options)
    base = ['docker', 'compose'] + options
    model = json.loads(reader(base + ['config', '--format', 'json']))
    profile, mode = select(index, model)
    manager = SimpleNamespace(CONFIG=manage.CONFIG, prep=manage.prep, run=reader, AUTO_DIR=manage.AUTO_DIR)
    declaration = None
    if mode == 'nas':
        infra_runtime.registered(manager, profile)
        infra_runtime.maintenance_guard(manager)
        declaration = catalog.read_relative(manage.CONFIG.parent, profile['release_file'])
        path = str(manage.CONFIG.parent / profile['release_file'])
        base += ['-f', path]
        model = json.loads(reader(base + ['config', '--format', 'json']))
        infra_deploy.model_guard(manager, profile, model)
        if not all(v.get('external') is True for v in model.get('volumes', {}).values()):
            raise RuntimeError('All existing data volumes must be external for NAS releases.')
        infra_deploy.data_volumes(manager, profile, model)
        rows = current(manager, profile, require_all=command[0] == 'mx-nas-check')
        database_mounts(model, rows)
        with socket.create_connection(('192.168.1.3', 2049), timeout=5):
            pass
    if inputs(options) != before or (declaration is not None and declaration != catalog.read_relative(
            manage.CONFIG.parent, profile['release_file'])):
        raise RuntimeError('Deployment files changed during release admission.')
    if command[0] in ('mx-nas-check', 'mx-nas-mode'):
        print(mode if command[0] == 'mx-nas-mode' else 'NAS release preflight: ' + profile['project'] + ' / ' + mode)
        return 0
    result = (runner or (lambda args: subprocess.call(local_command(args))))(base + command)
    if result == 0 and mode == 'nas' and command[0] in ('up', 'start', 'restart', 'run'):
        current(manager, profile)
    return result


def main(argv):
    if os.geteuid() != 0:
        raise RuntimeError('Use root/sudo for the local NAS release guard.')
    # Keep application interpolation variables, but never target a remote daemon
    # via an inherited Docker context or TLS setting.
    for key in ('DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'DOCKER_TLS'):
        os.environ.pop(key, None)
    options, command = parse(argv)
    # Share the existing migration/recovery lock. A busy repair rejects release
    # before Compose execution; it never waits and then deploys unexpectedly.
    with manage.migration_lock():
        return execute(options, command)


if __name__ == '__main__':
    try:
        sys.exit(main(sys.argv[1:]))
    except (RuntimeError, OSError, ValueError, KeyError, subprocess.SubprocessError) as exc:
        # Never print rendered config, environment values or Docker stderr.
        message = str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__
        print('NAS release blocked: ' + message, file=sys.stderr)
        sys.exit(1)
