#!/usr/bin/env python3
"""Gracefully retire exactly one verified owned container, preserving volumes."""
import json
import subprocess
import sys


def retire(app, name):
    allowed = {'mx-ocr': {'mx-ocr-api', 'mx-ocr-vllm'}}
    if name not in allowed.get(app, set()):
        raise ValueError('Refusing to retire an unregistered container')
    ids = subprocess.check_output(['docker', 'ps', '-a', '-q', '--filter', 'name=^/{}$'.format(name)],
                                  universal_newlines=True, timeout=15).split()
    if not ids:
        return
    containers = json.loads(subprocess.check_output(['docker', 'inspect', *ids], universal_newlines=True, timeout=15))
    if len(containers) != 1:
        raise ValueError('Ambiguous container identity')
    c = containers[0]
    if c['Name'].lstrip('/') != name or (c.get('Config', {}).get('Labels') or {}).get('com.mx-base.app') != app:
        raise ValueError('Refusing to replace a container not owned by {}'.format(app))
    # ID avoids retiring a different container if its name is reused concurrently.
    if c.get('State', {}).get('Running'):
        subprocess.check_call(['docker', 'stop', '--time', '40', c['Id']], timeout=60)
    subprocess.check_call(['docker', 'rm', c['Id']], timeout=15)


if __name__ == '__main__':
    try:
        retire(*sys.argv[1:])
    except (ValueError, OSError, subprocess.SubprocessError) as exc:
        sys.exit('Container replacement refused: {}'.format(exc))
