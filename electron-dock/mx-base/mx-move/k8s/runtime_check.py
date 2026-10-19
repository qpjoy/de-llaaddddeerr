#!/usr/bin/env python3
"""Read-only, allowlisted evidence before separating Kubernetes from Docker.

Python 3.6+, standard library only. This never starts/stops services, creates a
second runtime, exports images, copies data or changes configuration/mounts.
"""
import argparse
import datetime
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

from inventory import (Inspector, InspectionError, local_path, mount_for,
                       mount_summary, runtime_flags, stage)


def run(args):
    # An inherited Docker context must not silently inspect another machine.
    env = {k: v for k, v in os.environ.items() if not k.startswith('DOCKER_')}
    env['LC_ALL'] = 'C'
    try:
        result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                timeout=30, env=env)
        if result.returncode:
            raise InspectionError('command failed; raw output hidden')
        return result.stdout.decode('utf-8')
    except (OSError, subprocess.TimeoutExpired, UnicodeError):
        raise InspectionError('command unavailable; raw output hidden') from None


def scalar(raw):
    """Only literal single-line strings; never evaluate YAML/TOML expressions."""
    match = re.fullmatch(r'''\s*(?:"([^"\\\n]*)"|'([^'\\\n]*)'|([^\s#'"\[\]{}&*!|>]+))\s*(?:#.*)?''', raw)
    if not match:
        raise ValueError('unsupported scalar')
    return next(v for v in match.groups() if v is not None)


def endpoint(value):
    path = value[7:] if isinstance(value, str) and value.startswith('unix://') else value
    if not local_path(path):
        raise ValueError('unsupported endpoint')
    return path


def yaml_endpoint(raw):
    # Duplicate fields, document streams, aliases and flow-style roots require
    # a real YAML parser/audit. Do not guess an effective endpoint from them.
    if re.search(r'(?m)^(?:---|\.\.\.|[\[{])|\t', raw):
        raise ValueError('unsupported YAML')
    values = re.findall(r'(?m)^containerRuntimeEndpoint\s*:\s*([^\n]*)$', raw)
    if len(values) != 1:
        raise ValueError('endpoint missing or duplicated')
    return endpoint(scalar(values[0]))


def assignment(line):
    match = re.match(r'''^((?:"[^"\\\n]*"|'[^'\\\n]*'|[A-Za-z_]+))\s*=\s*(.*)$''', line)
    return (scalar(match.group(1)), match.group(2)) if match else None


def config_summary(raw):
    """Extract only literal root/state/imports and grpc.address from a dump."""
    result = {'root': None, 'state': None, 'address': None, 'imports': 'absent'}
    section, seen = '', set()
    for line in raw.splitlines():
        line = line.strip()
        if line.startswith('['):
            section = 'grpc' if re.fullmatch(r'''\[\s*(?:grpc|"grpc"|'grpc')\s*\]\s*(?:#.*)?''', line) else 'other'
            continue
        pair = assignment(line)
        if not pair:
            continue
        key, value = pair
        wanted = (not section and key in ('root', 'state', 'imports')) or (section == 'grpc' and key == 'address')
        if not wanted:
            continue
        if key in seen:
            raise ValueError('duplicate runtime config field')
        seen.add(key)
        if key == 'imports':
            if re.fullmatch(r'\[\s*\]\s*(?:#.*)?', value):
                result[key] = 'empty'
            elif re.fullmatch(r'''\[\s*(?:"[^"\\\n]*"|'[^'\\\n]*')(?:\s*,\s*(?:"[^"\\\n]*"|'[^'\\\n]*'))*\s*,?\s*\]\s*(?:#.*)?''', value):
                result[key] = 'present'
            else:
                raise ValueError('unsupported imports syntax')
        else:
            result[key] = endpoint(scalar(value))
    return result


def canonical_flags(argv, aliases):
    found = runtime_flags(argv, tuple(aliases))
    result = {}
    for name, value in found.items():
        key = aliases[name]
        if key in result:
            raise ValueError('duplicate flag aliases')
        result[key] = endpoint(value)
    return result


def effective_config(summary, flags):
    result = dict(summary)
    result.update({k: flags[k] for k in ('root', 'state', 'address') if k in flags})
    if any(not result.get(k) for k in ('root', 'state', 'address')):
        raise ValueError('effective config paths incomplete')
    return result


def section_parts(value):
    token = r'''(?:"[^"\\\n]*"|'[^'\\\n]*'|[A-Za-z0-9_-]+)'''
    if not re.fullmatch(token + r'(?:\s*\.\s*' + token + r')*', value):
        raise ValueError('unsupported TOML table')
    return tuple(scalar(match.group()) for match in re.finditer(token, value))


def compatibility_kind(section, key):
    if not section and key == 'version':
        return 'integer'
    if not section and key in ('disabled_plugins', 'required_plugins'):
        return 'plugin_list'
    if section in (('grpc',), ('ttrpc',), ('debug',), ('metrics',)) and key == 'address':
        return 'address'
    if len(section) == 2 and section[0] == 'proxy_plugins' and key in ('address', 'type'):
        return 'address' if key == 'address' else 'identifier'
    if len(section) < 2 or section[0] != 'plugins':
        return None
    plugin, tail = section[1], section[2:]
    if plugin == 'io.containerd.nri.v1.nri' and not tail:
        return 'boolean' if key == 'disable' else 'path' if key in ('socket_path', 'plugin_path', 'plugin_config_path') else None
    if plugin not in ('io.containerd.grpc.v1.cri', 'io.containerd.cri.v1.images', 'io.containerd.cri.v1.runtime'):
        return None
    if (not tail and key == 'sandbox_image') or (tail == ('pinned_images',) and key == 'sandbox'):
        return 'image'
    if tail in ((), ('containerd',)) and key in ('snapshotter', 'default_runtime_name'):
        return 'identifier'
    if tail == ('cni',):
        return 'integer' if key == 'max_conf_num' else 'path' if key in ('bin_dir', 'conf_dir') else None
    if tail == ('registry',) and key == 'config_path':
        return 'path'
    if len(tail) in (3, 4) and tail[:2] == ('containerd', 'runtimes'):
        if len(tail) == 3 and key == 'runtime_type':
            return 'identifier'
        if len(tail) == 4 and tail[3] == 'options':
            return 'boolean' if key == 'SystemdCgroup' else 'binary' if key == 'BinaryName' else None
    return None


def compatibility_value(raw, kind):
    if kind in ('integer', 'boolean'):
        value = scalar(raw)
        if kind == 'boolean' and value in ('true', 'false'):
            return value == 'true'
        if kind == 'integer' and re.fullmatch('[0-9]+', value):
            return int(value)
        raise ValueError('unsupported primitive')
    if kind == 'plugin_list':
        value = raw.split('#', 1)[0].strip()
        if not value.startswith('[') or not value.endswith(']'):
            raise ValueError('unsupported plugin list')
        return [compatibility_value(v.strip(), 'identifier') for v in value[1:-1].split(',') if v.strip()]
    value = scalar(raw)
    if not value:
        return value
    if kind in ('path', 'binary') and local_path(value):
        return value
    patterns = {'identifier': r'[A-Za-z0-9_.-]+', 'binary': r'[A-Za-z0-9_.-]+',
                'image': r'[A-Za-z0-9._:/-]+(?:@sha256:[a-f0-9]{64})?',
                'address': r'[A-Za-z0-9_.:/\[\]-]+'}
    if kind in patterns and re.fullmatch(patterns[kind], value) and '://' not in value:
        return value
    raise ValueError('unsupported allowlisted value')


def compatibility_summary(raw):
    fields, section, seen = [], (), set()
    for line in raw.splitlines():
        line = line.strip()
        if line.startswith('['):
            match = re.fullmatch(r'\[([^\n]+)\]\s*(?:#.*)?', line)
            section = section_parts(match.group(1)) if match else ('unsupported',)
            continue
        pair = assignment(line)
        if not pair:
            continue
        key, value = pair
        kind = compatibility_kind(section, key)
        if kind is None:
            continue
        identity = section + (key,)
        if identity in seen:
            raise ValueError('duplicate compatibility field')
        seen.add(identity)
        fields.append({'section': list(section), 'key': key, 'value': compatibility_value(value, kind)})
    version = next((v['value'] for v in fields if not v['section'] and v['key'] == 'version'), None)
    return {'config_version': version, 'requires_manual_review': True, 'fields': fields}


def version_value(raw, name):
    prefix = r'containerd\s+(?:\S+\s+)?' if name == 'containerd' else r'Kubernetes\s+'
    match = re.match(prefix + r'(v?[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?)(?:\s|$)', raw.strip())
    if not match:
        raise ValueError('unsupported version output')
    return match.group(1)


def socket_identity(path):
    if path is None:
        return None
    path = endpoint(path)
    value = os.stat(path)
    return {'path': path, 'device': value.st_dev, 'inode': value.st_ino,
            'is_socket': stat.S_ISSOCK(value.st_mode)}


def same_socket(left, right):
    if not left or not right or not left['is_socket'] or not right['is_socket']:
        return None
    return (left['device'], left['inode']) == (right['device'], right['inode'])


def tasks_summary(raw):
    rows = [line.split() for line in raw.splitlines() if line.strip()]
    if not rows or rows[0] != ['TASK', 'PID', 'STATUS']:
        raise ValueError('unsupported task table')
    result = {'total': len(rows) - 1, 'status_counts': {}}
    for row in rows[1:]:
        if len(row) != 3 or not row[1].isdigit() or row[2] not in ('RUNNING', 'CREATED', 'STOPPED', 'PAUSED', 'PAUSING', 'UNKNOWN'):
            raise ValueError('unsupported task row')
        result['status_counts'][row[2]] = result['status_counts'].get(row[2], 0) + 1
    return result


def docker_info(raw):
    value = json.loads(raw)
    if (not local_path(value.get('root')) or type(value.get('live_restore')) is not bool or
            any(not isinstance(value.get(k), str) for k in ('name', 'swarm_state'))):
        raise ValueError('invalid Docker info')
    return {key: value.get(key) for key in ('root', 'live_restore', 'name', 'swarm_state')}


def docker_container(value):
    if not re.fullmatch('[a-f0-9]{64}', value.get('id', '')) or any(type(value.get(k)) is not bool for k in ('running', 'paused')):
        raise ValueError('invalid Docker state')
    result = {key: value.get(key) for key in ('id', 'name', 'running', 'paused', 'stop_signal')}
    result['restart_policy'] = {key: value['restart_policy'].get(key) for key in ('Name', 'MaximumRetryCount')}
    return result


class RuntimeInspector(Inspector):
    def __init__(self):
        self.errors = []

    def service(self, name):
        keys = ('LoadState', 'ActiveState', 'SubState', 'MainPID')
        args = ['systemctl', 'show', name + '.service']
        for key in keys:
            args += ['-p', key]
        values = dict(line.split('=', 1) for line in run(args).splitlines() if '=' in line)
        return {key: values.get(key) for key in keys}

    def process(self, name, service):
        pid = service.get('MainPID')
        if not str(pid).isdigit() or int(pid) <= 0:
            raise ValueError('no running process')
        base = '/proc/' + str(pid)
        executable = os.readlink(base + '/exe')
        if not local_path(executable) or os.path.basename(executable) != {'docker': 'dockerd'}.get(name, name):
            raise ValueError('unrecognized executable')
        argv = Path(base + '/cmdline').read_bytes().decode('utf-8').rstrip('\0').split('\0')
        aliases = {'kubelet': {'--config': 'config', '--root-dir': 'root', '--container-runtime-endpoint': 'address'},
                   'containerd': {'--config': 'config', '-c': 'config', '--root': 'root', '--state': 'state', '--address': 'address', '-a': 'address'},
                   'docker': {'--config-file': 'config', '--data-root': 'root', '--containerd': 'address'}}
        flags = canonical_flags(argv, aliases[name])
        output = {'executable': executable, 'flags': flags, 'address': flags.get('address')}
        if name in ('containerd', 'kubelet'):
            output['version'] = self.attempt(name + ' binary version', lambda: version_value(run([base + '/exe', '--version']), name))
        if name == 'containerd':
            args = [base + '/exe']
            for key, value in sorted(flags.items()):
                args += ['--' + key, value]
            dump = self.attempt('containerd config dump', lambda: run(args + ['config', 'dump']))
            output['config_dump'] = self.attempt('containerd effective paths', lambda: effective_config(config_summary(dump), flags)) if dump is not None else None
            output['compatibility'] = self.attempt('containerd compatibility fields', lambda: compatibility_summary(dump)) if dump is not None else None
            output['address'] = (output['config_dump'] or {}).get('address')
            config = flags.get('config', '/etc/containerd/config.toml')
            output['source_config_path'] = config
            output['source_imports'] = self.attempt('containerd source imports', lambda: config_summary(Path(config).read_text())['imports'])
        elif name == 'kubelet' and not output['address']:
            output['address'] = self.attempt('kubelet configured endpoint', lambda: yaml_endpoint(Path(flags['config']).read_text()))
        elif name == 'docker' and not output['address']:
            config = flags.get('config', '/etc/docker/daemon.json')
            output['address'] = self.attempt('Docker configured containerd endpoint', lambda: endpoint(json.loads(Path(config).read_text())['containerd']))
        return output

    def namespaces(self, address):
        if not address:
            raise ValueError('no verified containerd address')
        base = ['ctr', '--address', address]
        names = run(base + ['namespaces', 'list', '--quiet']).split()
        if any(not re.fullmatch(r'[A-Za-z0-9_.-]+', name) for name in names) or len(set(names)) != len(names):
            raise ValueError('invalid namespaces')
        result = []
        for name in names:
            args = base + ['--namespace', name]
            item = {'name': name, 'tasks': self.attempt('containerd namespace tasks', lambda a=args: tasks_summary(run(a + ['tasks', 'list'])))}
            if name == 'k8s.io':
                item['image_count'] = self.attempt('Kubernetes image count', lambda a=args: len([v for v in run(a + ['images', 'list', '--quiet']).splitlines() if v.strip()]))
            result.append(item)
        return result

    def docker_local(self):
        base = ['docker', '--host', 'unix:///var/run/docker.sock']
        template = '{"root":{{json .DockerRootDir}},"live_restore":{{json .LiveRestoreEnabled}},"name":{{json .Name}},"swarm_state":{{json .Swarm.LocalNodeState}}}'
        output = {'info': self.attempt('local Docker info', lambda: docker_info(run(base + ['info', '--format', template])))}
        ids = run(base + ['ps', '--all', '--quiet', '--no-trunc']).split()
        if any(not re.fullmatch('[a-f0-9]{64}', value) for value in ids):
            raise ValueError('invalid Docker container IDs')
        containers = []
        template = '{"id":{{json .Id}},"name":{{json .Name}},"running":{{json .State.Running}},"paused":{{json .State.Paused}},"restart_policy":{{json .HostConfig.RestartPolicy}},"stop_signal":{{json .Config.StopSignal}}}'
        for offset in range(0, len(ids), 50):
            rows = [docker_container(json.loads(line)) for line in run(base + ['inspect', '--format', template] + ids[offset:offset + 50]).splitlines() if line.strip()]
            if sorted(c['id'] for c in rows) != sorted(ids[offset:offset + 50]):
                raise ValueError('Docker container set changed')
            containers.extend(rows)
        output.update(containers=containers, total=len(containers),
                      running=sum(c['running'] for c in containers), paused=sum(c['paused'] for c in containers))
        return output

    def shared_dir(self, mounts):
        value = os.lstat('/shared_dir')
        output = {'path': '/shared_dir', 'is_symlink': stat.S_ISLNK(value.st_mode), 'mount': mount_for('/shared_dir', mounts)}
        if output['is_symlink']:
            target = os.readlink('/shared_dir')
            lexical = os.path.normpath(os.path.join('/', target))
            output.update(link_target=target, lexical_target=lexical,
                          lexical_target_mount=mount_for(lexical, mounts),
                          target_resolution='lexical-only-not-followed')
        return output

    def collect(self):
        stage('只读检查本机运行时、共享 socket 和 Docker 停启状态；不迁移 Docker 数据')
        services, runtimes, sockets = {}, {}, {}
        for name in ('kubelet', 'containerd', 'docker'):
            services[name] = self.attempt('systemd ' + name, lambda n=name: self.service(n), {})
            runtimes[name] = self.attempt('running process ' + name, lambda n=name: self.process(n, services[n]), {})
            sockets[name] = self.attempt('runtime socket ' + name, lambda n=name: socket_identity(runtimes[n].get('address')))
        namespaces = self.attempt('containerd namespaces', lambda: self.namespaces(runtimes['containerd'].get('address')))
        docker = self.attempt('local Docker containers', self.docker_local)
        mounts = self.attempt('mount table', lambda: mount_summary(json.loads(run(['findmnt', '--json', '--list', '--output', 'TARGET,SOURCE,FSTYPE,FSROOT,UUID,OPTIONS']))['filesystems']), [])
        shared = self.attempt('shared_dir link', lambda: self.shared_dir(mounts))
        return {'schema_version': 1, 'collected_at_utc': datetime.datetime.utcnow().isoformat() + 'Z',
                'read_only': True, 'execution_supported': False, 'services': services, 'runtime': runtimes,
                'socket_identities': sockets, 'shares_socket': {'kubelet_containerd': same_socket(sockets['kubelet'], sockets['containerd']),
                    'docker_containerd': same_socket(sockets['docker'], sockets['containerd']), 'kubelet_docker': same_socket(sockets['kubelet'], sockets['docker'])},
                'containerd_namespaces': namespaces, 'docker': docker, 'shared_dir': shared, 'collection_errors': self.errors,
                'notes': ['Docker-only data remains outside the migration scope.',
                          'Namespace/task counts do not establish that containerd storage can be split by copying directories.',
                          'A separate Kubernetes runtime requires version, CRI, snapshotter, CNI and image availability review before cutover.']}


def main(argv=None):
    parser = argparse.ArgumentParser(description='mx-move k8s runtime-check: 只读本机运行时检查，不停服务、不复制数据、不改挂载')
    parser.parse_args(argv)
    if not sys.platform.startswith('linux') or os.geteuid() != 0:
        print('请在 Linux 主机以 root 执行 runtime-check（无需参数）。', file=sys.stderr)
        return 1
    try:
        report = RuntimeInspector().collect()
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 2 if report['collection_errors'] else 0
    except (InspectionError, OSError, ValueError, TypeError, KeyError, IndexError, AttributeError):
        print('运行时检查失败；请检查本机访问权限和工具（原始输出已隐藏）。', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
