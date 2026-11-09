"""Typed Python entry point with bounded subprocess and HTTP execution."""
from __future__ import annotations
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import re
import shutil
import ssl
import subprocess
from typing import Any
from urllib.request import getproxies, proxy_bypass
from urllib.parse import urlsplit
import uuid
from .runtime import runtime_path

OPERATIONS = ('app', 'search', 'reviews', 'list', 'developer', 'suggest', 'similar', 'permissions', 'datasafety', 'categories')
APP_OPERATIONS = {'app', 'reviews', 'similar', 'permissions', 'datasafety'}


def validate(operation: str, options: dict, timeout: float, request_timeout: float, max_requests: int) -> dict:
    """Validate inputs before filesystem or subprocess side effects."""
    if operation not in OPERATIONS:
        raise ValueError('Unsupported operation')
    for name, value in [('timeout', timeout), ('request_timeout', request_timeout)]:
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0.1 <= value <= 600:
            raise ValueError(f'{name} must be a finite number in 0.1..600 seconds')
    if type(max_requests) is not int or not 1 <= max_requests <= 100:
        raise ValueError('max_requests must be an integer in 1..100')
    if operation in APP_OPERATIONS:
        if not isinstance(options['app_id'], str) or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+', options['app_id']):
            raise ValueError('app_id must be an Android package identifier, not a URL')
    elif options['app_id'] is not None:
        raise ValueError('app_id is only valid for app, reviews, similar, permissions and datasafety')
    for key, required in [('term', operation in ('search', 'suggest')), ('developer_id', operation == 'developer')]:
        value = options[key]
        if required and (not isinstance(value, str) or not value.strip() or len(value) > 200 or any(ord(c) < 32 for c in value)):
            raise ValueError(f'{key} must be a nonempty string, at most 200 characters')
        if not required and value is not None:
            raise ValueError(f'{key} is not valid for this operation')
    for key, pattern in [('country', r'[A-Za-z]{2}'), ('lang', r'[A-Za-z]{2,3}(?:[-_][A-Za-z]{2,4})?')]:
        if not isinstance(options[key], str) or not re.fullmatch(pattern, options[key]):
            raise ValueError(f'Invalid {key}')
    num = options['num']
    if num is not None and (operation not in ('search', 'list', 'developer') or type(num) is not int or not 1 <= num <= 100):
        raise ValueError('num is an integer in 1..100, only for search/list/developer; reviews uses whole pages')
    pages = options['max_pages']
    if type(pages) is not int or not 1 <= pages <= 5 or (operation != 'reviews' and pages != 1):
        raise ValueError('max_pages is 1..5 for reviews; other operations must use 1')
    token = options['next_page_token']
    if token is not None and (operation != 'reviews' or not isinstance(token, str) or not 1 <= len(token) <= 10000 or any(ord(c) < 32 for c in token)):
        raise ValueError('Invalid reviews continuation token')
    if options['sort'] not in ('newest', 'rating', 'helpfulness') or (operation != 'reviews' and options['sort'] != 'newest'):
        raise ValueError('sort is newest/rating/helpfulness, for reviews only')
    if options['category'] is not None and (operation != 'list' or not isinstance(options['category'], str) or not re.fullmatch('[A-Z_]+', options['category'])):
        raise ValueError('category is a Google Play category constant for list only')
    if options['collection'] not in ('TOP_FREE', 'TOP_PAID', 'GROSSING') or (operation != 'list' and options['collection'] != 'TOP_FREE'):
        raise ValueError('Invalid list collection')
    return options


def resolve_proxy(proxy: str | None) -> str | None:
    if proxy is None:
        configured = getproxies()
        proxy = None if proxy_bypass('play.google.com') else configured.get('https') or configured.get('http')
    if proxy:
        parsed = urlsplit(proxy)
        if parsed.scheme not in ('http', 'https') or not parsed.hostname:
            raise ValueError('Proxy must be an http(s) URL; its value is omitted for privacy')
    return proxy or None


def collect(operation: str, *, app_id: str | None = None, term: str | None = None,
            developer_id: str | None = None, lang: str = 'en', country: str = 'us',
            num: int | None = None, max_pages: int = 1, next_page_token: str | None = None,
            sort: str = 'newest', category: str | None = None, collection: str = 'TOP_FREE',
            timeout: float = 90, request_timeout: float = 15, max_requests: int = 20,
            work_dir: str | Path = 'data', runtime_dir: str | Path = '.runtime',
            proxy: str | None = None, node_path: str | None = None) -> dict[str, Any]:
    """Query public Google Play data with a fresh Node process per call.

    Reviews returns complete source pages (up to 150 reviews each), with a safe
    continuation token. num only applies to search/list/developer. No API key is
    required. proxy=None uses environment/system proxy; proxy='' forces direct.
    Input errors raise ValueError, disk errors raise OSError; source/runtime
    failures return structured results. See README for field and scope limits.
    """
    options = validate(operation, dict(app_id=app_id, term=term, developer_id=developer_id,
        lang=lang, country=country.lower() if isinstance(country, str) else country, num=num,
        max_pages=max_pages, next_page_token=next_page_token, sort=sort, category=category,
        collection=collection), timeout, request_timeout, max_requests)
    selected_proxy = resolve_proxy(proxy)
    folder = Path(work_dir).resolve() / ('run-' + uuid.uuid4().hex)
    folder.mkdir(parents=True)
    result = {'source_row_id': 193, 'platform': 'google_play', 'provider': 'facundoolano/google-play-scraper',
              'operation': operation, 'observed_at': datetime.now(timezone.utc).isoformat(),
              'query': {key: value for key, value in options.items() if value is not None and key != 'next_page_token'},
              'status': 'error', 'data': {'items': [], 'next_page_token': None}, 'warnings': [], 'error': None,
              'execution': {'run_dir': str(folder), 'proxy_used': bool(selected_proxy), 'timed_out': False}}
    node = node_path or shutil.which('node')
    backend = runtime_path(runtime_dir)
    if not node or not (backend / 'installed.json').is_file():
        result['error'] = {'code': 'SETUP_REQUIRED', 'message': 'Run scripts/setup.ps1 or python -m mingxi_google_play.runtime in this project directory; Node.js 22+ is required.'}
    else:
        roots = ''.join(ssl.DER_cert_to_PEM_cert(cert) for cert in ssl.create_default_context().get_ca_certs(binary_form=True))
        # Public CA roots only, never proxy credentials. Keep TLS/hostname verification.
        ca_file = folder / 'system-roots.pem'
        ca_file.write_text(roots, encoding='ascii')
        config = {'operation': operation, 'options': options, 'request_timeout': request_timeout,
                  'max_requests': max_requests, 'proxy': selected_proxy, 'output_dir': str(folder)}
        env = {**os.environ, 'NODE_EXTRA_CA_CERTS': str(ca_file), 'DEBUG': '', 'NODE_TLS_REJECT_UNAUTHORIZED': '1'}
        env.pop('NODE_OPTIONS', None)
        timed_out = False
        returncode = None
        try:
            # Node is launched directly: no shell, no credentials in process arguments.
            with (folder / 'process.log').open('w', encoding='utf-8') as log:
                process = subprocess.run([node, str(backend / 'worker.mjs')], input=json.dumps(config),
                    stdout=log, stderr=log, text=True, encoding='utf-8', env=env, timeout=timeout,
                    creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            returncode = process.returncode
        except subprocess.TimeoutExpired:
            timed_out = True
        except OSError:
            result['error'] = {'code': 'NODE_START_FAILED', 'message': 'Unable to start Node.js; check node_path and installation.'}
        checkpoint = folder / 'checkpoint.json'
        if checkpoint.is_file():
            try:
                result.update(json.loads(checkpoint.read_text(encoding='utf-8')))
            except ValueError:
                result['error'] = {'code': 'INVALID_WORKER_OUTPUT', 'message': 'Worker output was incomplete.'}
        if timed_out:
            result['status'] = 'partial' if result['data']['items'] else 'error'
            result['error'] = {'code': 'TIMEOUT', 'message': 'Total timeout reached; completed review pages are retained.'}
        elif returncode != 0 and not result['error']:
            result['status'] = 'partial' if result['data']['items'] else 'error'
            result['error'] = {'code': 'WORKER_FAILED', 'message': 'Node backend failed; inspect process.log.'}
        elif not checkpoint.is_file() and not result['error']:
            result['error'] = {'code': 'WORKER_FAILED', 'message': 'Node backend did not produce a result.'}
        result['execution'].update(returncode=returncode, timed_out=timed_out)
    result['observed_at'] = datetime.now(timezone.utc).isoformat()
    (folder / 'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    return result
