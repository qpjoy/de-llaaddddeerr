"""Isolated runtime storage and HTTP transport for AudioSpider integrations."""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from datetime import datetime, timezone
import hashlib
import ipaddress
import json
from pathlib import Path
import socket
import sqlite3
from typing import Any, AsyncIterator
from urllib.parse import urljoin, urlsplit
from urllib.request import getproxies

import aiohttp
from aiohttp.helpers import get_env_proxy_for_url
from yarl import URL


def now() -> str:
    """Return an observation timestamp in UTC."""
    return datetime.now(timezone.utc).isoformat()


def identity(value: str) -> str:
    """Stable identifier independent of title and local filesystem."""
    return hashlib.sha256(value.encode('utf-8')).hexdigest()[:24]


class SourceError(Exception):
    """An error safe to serialize without disclosing credentials."""
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def public_url(value: str) -> str:
    """Allow only public HTTP(S) URLs without embedded credentials."""
    try:
        p = urlsplit(value)
        if p.scheme not in {'http', 'https'} or not p.hostname or p.username or p.password:
            raise ValueError()
        if p.port not in {None, 80, 443}:
            raise ValueError()
        if p.hostname.lower() in {'localhost', 'localhost.localdomain'}:
            raise ValueError()
        try:
            address = ipaddress.ip_address(p.hostname)
        except ValueError:
            address = None
        if address is not None and not address.is_global:
            raise ValueError()
    except (ValueError, TypeError, AttributeError):
        raise SourceError('INVALID_URL', 'Expected a public HTTP(S) URL on port 80 or 443') from None
    return value


class PublicResolver(aiohttp.resolver.DefaultResolver):
    """Reject private DNS answers, including after a redirect."""
    def __init__(self) -> None:
        super().__init__()
        # An explicitly configured deployment proxy may live on a private network.
        self.proxy_hosts = {urlsplit(value).hostname for scheme,value in getproxies().items() if scheme in {'http','https'}}

    async def resolve(self, host: str, port: int = 0, family: int = socket.AF_INET) -> list[Any]:
        answers = await super().resolve(host, port, family)
        if not answers or (host not in self.proxy_hosts and any(not ipaddress.ip_address(a['host']).is_global for a in answers)):
            raise SourceError('INVALID_URL', 'Target DNS did not resolve exclusively to public addresses')
        return answers


class Network:
    """One pooled aiohttp session per SDK request; no automatic request retries."""
    def __init__(self, timeout: float, concurrency: int):
        self.timeout, self.concurrency = timeout, concurrency

    async def __aenter__(self) -> Network:
        self.session = aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=self.timeout),
            connector=aiohttp.TCPConnector(limit=self.concurrency, resolver=PublicResolver()),
            headers={'User-Agent': 'AudioSpider-Standalone/1.0'},
        )
        return self

    async def __aexit__(self, *_: Any) -> None:
        await self.session.close()

    @asynccontextmanager
    async def open(self, url: str, *, headers: dict[str, str] | None = None,
                   params: dict[str, Any] | None = None) -> AsyncIterator[aiohttp.ClientResponse]:
        """Follow at most five validated redirects; never forward API auth to redirects."""
        try:
            for hop in range(6):
                public_url(url)
                try:
                    proxy, proxy_auth = get_env_proxy_for_url(URL(url))
                except LookupError:
                    proxy, proxy_auth = None, None
                response = await self.session.get(url, headers=headers, params=params, allow_redirects=False,
                                                  proxy=proxy, proxy_auth=proxy_auth)
                if response.status in {301, 302, 303, 307, 308}:
                    location = response.headers.get('Location')
                    response.release()
                    if not location or hop == 5:
                        raise SourceError('REDIRECT_ERROR', 'Invalid or excessive redirects')
                    if headers and any(k.lower() in {'authorization', 'x-auth-key', 'x-auth-date'} for k in headers):
                        raise SourceError('AUTH_REDIRECT', 'Refused to forward API credentials to a redirect')
                    url, params = urljoin(url, location), None
                    continue
                try:
                    yield response
                finally:
                    response.release()
                return
        except asyncio.TimeoutError:
            raise SourceError('REQUEST_TIMEOUT', 'HTTP request timed out') from None
        except aiohttp.ClientError:
            raise SourceError('NETWORK_ERROR', 'HTTP connection or response transfer failed') from None

    async def read(self, url: str, *, cap: int = 20 * 1024 * 1024, **kwargs: Any) -> bytes:
        """Read a bounded successful response."""
        async with self.open(url, **kwargs) as response:
            if response.status != 200:
                code = 'AUTH_FAILED' if response.status in {401, 403} else 'UPSTREAM_HTTP'
                raise SourceError(code, f'Upstream HTTP {response.status}')
            data = bytearray()
            async for chunk in response.content.iter_chunked(65536):
                data.extend(chunk)
                if len(data) > cap:
                    raise SourceError('RESPONSE_TOO_LARGE', 'Metadata response exceeded byte limit')
            return bytes(data)

    async def json(self, url: str, **kwargs: Any) -> Any:
        """Read bounded JSON with explicit format failure."""
        try:
            return json.loads(await self.read(url, cap=8*1024*1024, **kwargs))
        except (ValueError, UnicodeError):
            raise SourceError('UPSTREAM_FORMAT', 'Upstream response is not valid JSON') from None


class WriterLock:
    """OS-released, nonblocking per-runtime writer lock (Windows/POSIX)."""
    def __init__(self, directory: Path):
        self.path = directory / '.writer.lock'

    def __enter__(self) -> WriterLock:
        self.stream = self.path.open('a+b')
        self.stream.seek(0, 2)
        if self.stream.tell() == 0:
            self.stream.write(b'0'); self.stream.flush()
        self.stream.seek(0)
        try:
            import os
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(self.stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.stream.close()
            raise SourceError('RUNTIME_BUSY', 'Another operation is writing this run_dir') from None
        return self

    def __exit__(self, *_: Any) -> None:
        self.stream.close()


class Store:
    """Instance-owned SQLite state; no module-global connection or package writes.

    AudioSpider's URL/GUID deduplication, checkpoints and pending/downloading/done/
    failed lifecycle are retained. Runtime schema is isolated from upstream DBs.
    """
    def __init__(self, directory: Path, source_id: str):
        self.db = sqlite3.connect(directory / 'audiospider.sqlite3', timeout=5)
        self.db.row_factory = sqlite3.Row
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.executescript('''
        CREATE TABLE IF NOT EXISTS runtime_meta (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE IF NOT EXISTS collections (
          id TEXT PRIMARY KEY, payload TEXT NOT NULL, parsed INTEGER DEFAULT 0,
          last_success TEXT, last_error TEXT);
        CREATE TABLE IF NOT EXISTS records (
          id TEXT PRIMARY KEY, collection_id TEXT NOT NULL, audio_url TEXT UNIQUE,
          payload TEXT NOT NULL, status TEXT DEFAULT 'pending', local_path TEXT,
          sha256 TEXT, last_error TEXT, downloaded_at TEXT);
        CREATE INDEX IF NOT EXISTS records_status ON records(status);
        ''')
        owner = self.db.execute("SELECT value FROM runtime_meta WHERE key='source_id'").fetchone()
        if owner and owner[0] != source_id:
            self.db.close()
            raise SourceError('RUNTIME_SOURCE_MISMATCH', 'run_dir belongs to another platform')
        self.db.execute("INSERT OR IGNORE INTO runtime_meta VALUES ('source_id', ?)", (source_id,))
        self.db.commit()

    def close(self) -> None:
        self.db.close()

    def recover(self) -> None:
        """Called only while holding the exclusive runtime lock."""
        self.db.execute("UPDATE records SET status='pending' WHERE status='downloading'")
        self.db.commit()

    def add_collection(self, item: dict[str, Any]) -> None:
        self.db.execute('INSERT INTO collections(id,payload) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',
                        (item['id'], json.dumps(item, ensure_ascii=False)))
        self.db.commit()

    def collections(self, limit: int, ids: list[str] | None = None, refresh: bool = False) -> list[dict[str, Any]]:
        if ids:
            rows = self.db.execute('SELECT payload FROM collections WHERE id IN ('+','.join('?' for _ in ids)+') ORDER BY rowid LIMIT ?', (*ids,limit)).fetchall()
            if len(rows) != len(ids):
                raise SourceError('NOT_FOUND', 'One or more collection IDs are not present; discover first')
        else:
            rows = self.db.execute('SELECT payload FROM collections '+('' if refresh else 'WHERE parsed=0 ')+'ORDER BY rowid LIMIT ?', (limit,)).fetchall()
        return [json.loads(r[0]) for r in rows]

    def collection_result(self, collection_id: str, error: str | None = None) -> None:
        if error:
            self.db.execute('UPDATE collections SET last_error=? WHERE id=?', (error,collection_id))
        else:
            self.db.execute('UPDATE collections SET parsed=1,last_success=?,last_error=NULL WHERE id=?', (now(),collection_id))
        self.db.commit()

    def add_records(self, records: list[dict[str, Any]]) -> int:
        """Insert/backfill records and return canonical IDs for URL duplicates."""
        added = 0
        for item in records:
            previous = self.db.execute('SELECT id,payload FROM records WHERE id=?', (item['id'],)).fetchone()
            url_match = self.db.execute('SELECT id,payload FROM records WHERE audio_url=?', (item['url'],)).fetchone()
            if url_match and (not previous or url_match['id'] != previous['id']):
                previous = url_match
            if previous:
                old = json.loads(previous['payload'])
                # Preserve stable identity/download state; fill previously absent metadata.
                for key in ['published_at','duration','file_size','language','title']:
                    if not old.get(key) and item.get(key):old[key] = item[key]
                old['url'] = item['url']
                self.db.execute('UPDATE records SET payload=?,audio_url=? WHERE id=?', (json.dumps(old,ensure_ascii=False),item['url'],previous['id']))
                item['id'] = previous['id']
            else:
                self.db.execute('INSERT INTO records(id,collection_id,audio_url,payload) VALUES (?,?,?,?)',
                    (item['id'],item['collection_id'],item['url'],json.dumps(item,ensure_ascii=False)))
                added += 1
        self.db.commit()
        return added

    def records(self, limit: int, offset: int = 0, ids: list[str] | None = None,
                status: str | None = None) -> tuple[list[dict[str, Any]], int]:
        where, args = [], []
        if ids:
            where.append('id IN ('+','.join('?' for _ in ids)+')');args.extend(ids)
        if status:
            where.append('status=?');args.append(status)
        clause = ' WHERE '+' AND '.join(where) if where else ''
        total = self.db.execute('SELECT COUNT(*) FROM records'+clause, args).fetchone()[0]
        rows = self.db.execute('SELECT * FROM records'+clause+' ORDER BY rowid LIMIT ? OFFSET ?', (*args,limit,offset)).fetchall()
        output = []
        for row in rows:
            item = json.loads(row['payload'])
            item.update({k:row[k] for k in ['status','local_path','sha256','last_error','downloaded_at']})
            output.append(item)
        return output,total

    def status(self, record_id: str, status: str, *, path: str | None = None,
               sha: str | None = None, error: str | None = None) -> None:
        self.db.execute('UPDATE records SET status=?,local_path=COALESCE(?,local_path),sha256=COALESCE(?,sha256),last_error=?,downloaded_at=CASE WHEN ?=\'done\' THEN ? ELSE downloaded_at END WHERE id=?',
            (status,path,sha,error,status,now(),record_id))
        self.db.commit()

    def stats(self) -> dict[str, Any]:
        return {'collections':self.db.execute('SELECT COUNT(*) FROM collections').fetchone()[0],
                'parsed_collections':self.db.execute('SELECT COUNT(*) FROM collections WHERE parsed=1').fetchone()[0],
                'records':self.db.execute('SELECT COUNT(*) FROM records').fetchone()[0],
                'downloads':{r[0]:r[1] for r in self.db.execute('SELECT status,COUNT(*) FROM records GROUP BY status')}}
