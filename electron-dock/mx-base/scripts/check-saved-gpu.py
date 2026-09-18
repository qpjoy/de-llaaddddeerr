#!/usr/bin/env python3
"""Starting existing containers must use their saved GPU, not a new .env allocation."""
import json
import subprocess
import sys

app, uuid, *names = sys.argv[1:]
for c in json.loads(subprocess.check_output(['docker', 'inspect', *names], universal_newlines=True)):
    if (c.get('Config', {}).get('Labels') or {}).get('com.mx-base.app') != app:
        sys.exit('容器不属于此应用，拒绝启动')
    for r in c.get('HostConfig', {}).get('DeviceRequests') or []:
        if r.get('Count') == -1 or r.get('DeviceIDs') != [uuid]:
            sys.exit('容器保存的 GPU 与当前分配不同；请使用 deploy 重新应用配置')
