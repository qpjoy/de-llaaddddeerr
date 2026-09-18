#!/usr/bin/env python3
"""Wait for saved container health; never publish keys or perform inference."""
import json
import subprocess
import sys
import time

deadline = time.monotonic() + 1800
while time.monotonic() < deadline:
    try:
        state = json.loads(subprocess.check_output(
            ['docker', 'inspect', '--format', '{{json .State}}', sys.argv[1]], text=True, timeout=10))
    except (subprocess.SubprocessError, ValueError):
        sys.exit('无法读取容器状态；请检查 status/logs')
    if not state.get('Running'):
        sys.exit('容器未运行；请检查 logs')
    health = state.get('Health', {}).get('Status')
    if health == 'healthy':
        print(f'{sys.argv[1]} healthy')
        sys.exit(0)
    if health == 'unhealthy':
        sys.exit('容器健康检查失败；请检查 logs')
    time.sleep(5)
sys.exit('等待模型就绪超时；容器保留，请检查 status/logs')
