#!/usr/bin/env python3
"""Read-only kubelet startup guard for the currently selected etcd bind mount.

Install a private copy outside the checkout. No repair, mounting or configuration
changes belong here: a missing/wrong disk must prevent kubelet from starting etcd
against an older directory. Compatible with the host's Python 3.6.
"""
import argparse
import json
import os
from pathlib import Path
import stat
import subprocess
import sys


DATA = Path('/var/lib/etcd')


class GuardError(Exception):
    pass


def secure_path(path, owner_uid=0, path_root=Path('/'), private=False):
    """Check every component without resolving away a symlink.

    owner_uid/path_root exist for unprivileged fixture tests; the CLI always
    checks root ownership all the way to /.
    """
    path, path_root = Path(path), Path(path_root)
    if not path.is_absolute() or '..' in path.parts or not path_root.is_absolute():
        raise GuardError('路径必须是绝对路径且不能包含上级跳转')
    try:
        relative = path.relative_to(path_root)
    except ValueError:
        raise GuardError('路径超出检查范围')
    chain = [path_root]
    for part in relative.parts:
        chain.append(chain[-1] / part)
    last = None
    for index, component in enumerate(chain):
        try:
            info = component.lstat()
        except OSError:
            raise GuardError('必需路径不存在或无法读取：{}'.format(component))
        if stat.S_ISLNK(info.st_mode):
            raise GuardError('路径不能是符号链接：{}'.format(component))
        if info.st_uid != owner_uid or info.st_mode & 0o022:
            raise GuardError('路径所有者或写权限不安全：{}'.format(component))
        if index < len(chain) - 1 and not stat.S_ISDIR(info.st_mode):
            raise GuardError('父路径必须是目录：{}'.format(component))
        last = info
    if private and (not stat.S_ISREG(last.st_mode) or last.st_mode & 0o077):
        raise GuardError('身份记录必须是仅 root 可读写的普通文件')
    return last


def read_record(path, owner_uid=0, path_root=Path('/')):
    before = secure_path(path, owner_uid, path_root, private=True)
    descriptor = None
    try:
        descriptor = os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW)
        opened = os.fstat(descriptor)
        if ((before.st_dev, before.st_ino) != (opened.st_dev, opened.st_ino)
                or not stat.S_ISREG(opened.st_mode) or opened.st_uid != owner_uid
                or opened.st_mode & 0o077):
            raise GuardError('身份记录在检查时发生变化或权限不安全')
        with os.fdopen(descriptor, 'rb') as stream:
            descriptor = None
            raw = stream.read(16385)
        if len(raw) > 16384:
            raise GuardError('身份记录过大')
        record = json.loads(raw.decode('utf-8'))
    except (OSError, UnicodeError, ValueError):
        raise GuardError('身份记录无法读取或不是有效 JSON')
    finally:
        if descriptor is not None:
            os.close(descriptor)
    if (not isinstance(record, dict) or set(record) != {'version', 'data', 'allowed'}
            or type(record['version']) is not int or record['version'] != 1
            or not isinstance(record['data'], str)
            or not isinstance(record['allowed'], list) or not 1 <= len(record['allowed']) <= 2):
        raise GuardError('身份记录格式不受支持')
    identities = []
    for allowed in record['allowed']:
        if (not isinstance(allowed, dict) or set(allowed) != {'uuid', 'inode'}
                or not isinstance(allowed['uuid'], str) or not allowed['uuid']
                or len(allowed['uuid']) > 128
                or type(allowed['inode']) is not int or allowed['inode'] <= 0):
            raise GuardError('身份记录格式不受支持')
        identity = (allowed['uuid'], allowed['inode'])
        if identity in identities:
            raise GuardError('身份记录包含重复的数据目录')
        identities.append(identity)
    return record


def mounted_filesystem(data):
    try:
        result = subprocess.run(
            ['/usr/bin/findmnt', '--json', '--target', str(data), '--output',
             'TARGET,UUID,OPTIONS,FSROOT'], stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, timeout=15, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise GuardError('无法读取 etcd 挂载信息')
    if result.returncode != 0:
        raise GuardError('未找到 etcd 挂载或 findmnt 失败')
    try:
        return json.loads(result.stdout.decode('utf-8'))
    except (UnicodeError, ValueError):
        raise GuardError('findmnt 未返回有效挂载信息')


def verify(record_path, data=DATA, owner_uid=0, path_root=Path('/'), findmnt=None):
    record = read_record(record_path, owner_uid, path_root)
    data = Path(data)
    if record['data'] != str(data):
        raise GuardError('身份记录的数据路径不匹配')
    info = secure_path(data, owner_uid, path_root)
    if not stat.S_ISDIR(info.st_mode):
        raise GuardError('etcd 数据路径必须是目录')
    response = (findmnt or mounted_filesystem)(data)
    mounts = response.get('filesystems') if isinstance(response, dict) else None
    if not isinstance(mounts, list) or len(mounts) != 1 or not isinstance(mounts[0], dict):
        raise GuardError('无法唯一确定 etcd 挂载')
    mount = mounts[0]
    if mount.get('target') != str(data):
        raise GuardError('etcd 数据路径没有独立挂载；拒绝使用底层旧目录')
    if mount.get('uuid') not in [item['uuid'] for item in record['allowed']]:
        raise GuardError('etcd 文件系统 UUID 与当前选择不一致')
    options = mount.get('options')
    if not isinstance(options, str) or 'rw' not in options.split(',') or 'ro' in options.split(','):
        raise GuardError('etcd 文件系统不是可读写挂载')
    fsroot = mount.get('fsroot')
    if not isinstance(fsroot, str) or not fsroot.startswith('/'):
        raise GuardError('etcd 挂载缺少文件系统根路径')
    if not any(mount['uuid'] == item['uuid'] and info.st_ino == item['inode']
               for item in record['allowed']):
        raise GuardError('etcd 数据目录 inode 与当前选择不一致')
    for child in [data / 'member', data / 'member/snap']:
        child_info = secure_path(child, owner_uid, path_root)
        if not stat.S_ISDIR(child_info.st_mode):
            raise GuardError('etcd 数据结构不完整')
    database = secure_path(data / 'member/snap/db', owner_uid, path_root)
    if not stat.S_ISREG(database.st_mode) or database.st_size == 0:
        raise GuardError('etcd 数据库缺失、为空或不是普通文件')
    return record


def main(argv=None):
    parser = argparse.ArgumentParser(description='只读检查当前 etcd 数据挂载；失败时阻止 kubelet 启动')
    parser.add_argument('--record', required=True)
    args = parser.parse_args(argv)
    try:
        verify(args.record)
    except GuardError as error:
        print('mx-move etcd 启动检查失败：{}'.format(error), file=sys.stderr)
        return 1
    print('mx-move etcd 启动检查通过')
    return 0


if __name__ == '__main__':
    sys.exit(main())
