"""Install this package's locked Node backend in a caller-owned directory."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

ASSETS = Path(__file__).parent / 'node'


def fingerprint() -> str:
    digest = hashlib.sha256()
    for path in sorted(p for p in ASSETS.rglob('*') if p.is_file()):
        digest.update(path.relative_to(ASSETS).as_posix().encode())
        digest.update(path.read_bytes())
    return digest.hexdigest()


def runtime_path(root: str | Path) -> Path:
    return Path(root).resolve() / fingerprint()[:20]


def install(root: str | Path = '.runtime') -> Path:
    """Install pinned dependencies once; require Node 22+ and npm on PATH."""
    node = shutil.which('node')
    npm = shutil.which('npm.cmd' if os.name == 'nt' else 'npm')
    if not node or not npm:
        raise RuntimeError('Install Node.js 22+ (including npm), then run setup again.')
    version = subprocess.check_output([node, '--version'], text=True, timeout=10).strip()
    if int(version.lstrip('v').split('.')[0]) < 22:
        raise RuntimeError('Node.js 22 or newer is required.')
    target = runtime_path(root)
    marker = target / 'installed.json'
    if marker.is_file() and (target / 'node_modules/google-play-scraper/package.json').is_file():
        return target
    target.mkdir(parents=True, exist_ok=True)
    shutil.copytree(ASSETS, target, dirs_exist_ok=True)
    env = {**os.environ, 'npm_config_cache': str(target / 'npm-cache')}
    with (target / 'install.log').open('w', encoding='utf-8') as log:
        result = subprocess.run([npm, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'],
                                cwd=target, env=env, stdout=log, stderr=log, timeout=240,
                                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if result.returncode:
        raise RuntimeError(f'Node dependency installation failed; inspect {target / "install.log"}')
    marker.write_text(json.dumps({'source_sha256': fingerprint(), 'node_version': version}), encoding='utf-8')
    return target


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime-dir', default='.runtime')
    print(install(parser.parse_args().runtime_dir))
