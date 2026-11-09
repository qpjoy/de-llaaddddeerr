from __future__ import annotations

import json
import os
import sqlite3
import time
from dataclasses import dataclass
from typing import Optional, Dict, Any

from ..models import HttpResponse


@dataclass
class CacheEntry:
    cache_key: str
    url: str
    status_code: int
    headers: Dict[str, str]
    body: str
    created_at: float
    ttl_seconds: Optional[float]


class SQLiteCacheBackend:
    """Persistent cache stored in a SQLite database.

    Each entry is keyed by a stable cache_key and stores url, status, headers, body,
    and optional TTL. Expired entries are ignored and purged lazily.
    """

    def __init__(self, db_path: str) -> None:
        self.db_path = db_path
        dir_name = os.path.dirname(db_path)
        if dir_name:
            os.makedirs(dir_name, exist_ok=True)
        self._conn = sqlite3.connect(self.db_path)
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS http_cache (
                cache_key TEXT PRIMARY KEY,
                url TEXT NOT NULL,
                status_code INTEGER NOT NULL,
                headers TEXT NOT NULL,
                body TEXT NOT NULL,
                created_at REAL NOT NULL,
                ttl_seconds REAL
            );
            """
        )
        self._conn.commit()

    def close(self) -> None:
        try:
            self._conn.close()
        except Exception:
            pass

    def get(self, cache_key: str) -> Optional[HttpResponse]:
        now = time.time()
        cur = self._conn.cursor()
        cur.execute(
            "SELECT url, status_code, headers, body, created_at, ttl_seconds FROM http_cache WHERE cache_key = ?",
            (cache_key,),
        )
        row = cur.fetchone()
        if not row:
            return None
        url, status_code, headers_json, body, created_at, ttl_seconds = row
        if ttl_seconds is not None and (now - created_at) > ttl_seconds:
            # Expired; purge and miss
            try:
                self.delete(cache_key)
            finally:
                return None
        try:
            headers = json.loads(headers_json)
        except Exception:
            headers = {}
        return HttpResponse(url=url, status_code=int(status_code), headers=headers, text=body)

    def set(self, cache_key: str, response: HttpResponse, ttl_seconds: Optional[float] = None) -> None:
        if int(response.status_code) != 200:
            return
        created_at = time.time()
        headers_json = json.dumps(response.headers or {})
        self._conn.execute(
            "REPLACE INTO http_cache (cache_key, url, status_code, headers, body, created_at, ttl_seconds) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                cache_key,
                response.url,
                int(response.status_code),
                headers_json,
                response.text,
                created_at,
                ttl_seconds,
            ),
        )
        self._conn.commit()

    def delete(self, cache_key: str) -> None:
        self._conn.execute("DELETE FROM http_cache WHERE cache_key = ?", (cache_key,))
        self._conn.commit()

    def purge_expired(self) -> int:
        now = time.time()
        cur = self._conn.cursor()
        cur.execute("DELETE FROM http_cache WHERE ttl_seconds IS NOT NULL AND (? - created_at) > ttl_seconds", (now,))
        self._conn.commit()
        return cur.rowcount


def default_cache_path() -> str:
    base = os.path.join(os.path.expanduser("~"), ".cache", "medium_scraper")
    os.makedirs(base, exist_ok=True)
    return os.path.join(base, "http_cache.sqlite") 