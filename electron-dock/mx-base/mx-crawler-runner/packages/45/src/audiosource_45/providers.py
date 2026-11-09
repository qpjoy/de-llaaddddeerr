"""Bounded public-page/API collectors adapted from the pinned AudioSpider sources."""
from __future__ import annotations

import asyncio
from dataclasses import asdict
from datetime import datetime, timezone
import json
import re
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from lxml import etree, html

from .runtime import Network, SourceError, identity, now, public_url
from .upstream_types import AudioRecord

XYZ = 'https://www.xiaoyuzhoufm.com'
XM = 'https://mobile.ximalaya.com/v1/track/baseInfo'
HEADERS = {'User-Agent': 'Mozilla/5.0 (compatible; AudioSpider-Standalone/1.0)'}
DEFAULT_PODCAST = '5e4ee557418a84a0466737b7'
DEFAULT_TRACK = '3558286'


def xyz_page(payload: bytes) -> dict[str, Any]:
    """Decode embedded JSON instead of matching titles and URLs by unrelated order."""
    try:
        tree = html.fromstring(payload.decode("utf-8"))
        scripts = tree.xpath('//script[@id="__NEXT_DATA__"]/text()')
        data = json.loads(scripts[0])['props']['pageProps']
        if not isinstance(data, dict):
            raise ValueError()
        if data.get('statusCode', 200) != 200:
            raise SourceError('UPSTREAM_NOT_FOUND', 'Public page reports unavailable content')
        if not isinstance(data.get('podcast') or data.get('episode'), dict):
            raise ValueError()
        return data
    except (ValueError, IndexError, KeyError, TypeError, etree.ParserError):
        raise SourceError('UPSTREAM_FORMAT', 'Expected a public page containing podcast/episode JSON') from None


def _collection(source: str, uid: str, title: str, author: str, url: str,
                raw: dict[str, Any]) -> dict[str, Any]:
    """Keep the existing collection envelope; feed_url is the source page, not RSS."""
    return {'id': identity(source + ':' + uid), 'upstream_id': uid,
            'title': title, 'author': author, 'language': 'zh', 'genres': [],
            'feed_url': url, 'collection_url': url, 'observed_at': now(), 'raw': raw}


def _xyz_collection(page: dict[str, Any], kind: str, expected: str) -> dict[str, Any]:
    entity = page.get(kind)
    key = 'eid' if kind == 'episode' else 'pid'
    if not isinstance(entity, dict) or entity.get(key) != expected:
        raise SourceError('UPSTREAM_FORMAT', 'Page identity does not match the requested ID')
    podcast = entity.get('podcast', {}) if kind == 'episode' else entity
    if not isinstance(podcast, dict):
        raise SourceError('UPSTREAM_FORMAT', 'Podcast metadata is missing')
    pid = podcast.get('pid') or entity.get('pid')
    if not isinstance(pid, str) or not re.fullmatch('[a-f0-9]{24}', pid):
        raise SourceError('UPSTREAM_FORMAT', 'Invalid podcast identity')
    # Episode-specific collections remain separate, so they do not replace a full podcast scope.
    uid = f'episode:{expected}' if kind == 'episode' else pid
    return _collection('xiaoyuzhou', uid, str(podcast.get('title', '')), str(podcast.get('author', '')),
                       f'{XYZ}/{kind}/{expected}', {'kind': kind, 'page_id': expected, 'pid': pid,
                       'episode_count': podcast.get('episodeCount'), 'subscription_count': podcast.get('subscriptionCount')})


async def xm_track(net: Network, track_id: str) -> dict[str, Any]:
    """Read the same public baseInfo endpoint used by the original crawler."""
    data = await net.json(XM, params={'device': 'web', 'trackId': track_id}, headers=HEADERS)
    if not isinstance(data, dict) or data.get('ret') != 0:
        raise SourceError('UPSTREAM_ERROR', 'Track API reports an unavailable or rejected track')
    if str(data.get('trackId')) != track_id or not data.get('albumId'):
        raise SourceError('UPSTREAM_FORMAT', 'Track/album identity is missing or mismatched')
    if data.get('isPaid') or data.get('isPublic') is False or data.get('isDraft'):
        raise SourceError('RESTRICTED_CONTENT', 'Only public non-paid tracks are supported')
    return data


async def discover(net: Network, source: str, params: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    """Resolve caller-supplied seeds; never treat unqueried seeds as discovered data."""
    items: dict[str, dict[str, Any]] = {}
    errors = []
    if source == 'xiaoyuzhou':
        kind = 'episode' if 'episode_ids' in params else 'podcast'
        seeds = params.get('episode_ids', params.get('podcast_ids', [DEFAULT_PODCAST]))
    else:
        kind, seeds = 'track', params.get('track_ids', [DEFAULT_TRACK])
    for pos, seed in enumerate(seeds[:params.get('limit', 10)]):
        if pos:
            await asyncio.sleep(params.get('request_interval', 2))
        try:
            if source == 'xiaoyuzhou':
                page = xyz_page(await net.read(f'{XYZ}/{kind}/{seed}', headers=HEADERS))
                item = _xyz_collection(page, kind, seed)
            else:
                data = await xm_track(net, seed)
                aid = str(data['albumId'])
                item = _collection(source, aid, str(data.get('albumTitle', '')),
                                   str((data.get('userInfo') or {}).get('nickname') or data.get('nickname', '')),
                                   f'https://www.ximalaya.com/album/{aid}', {'seed_track_ids': [seed]})
                if item['id'] in items:
                    items[item['id']]['raw']['seed_track_ids'].append(seed)
                    continue
            items[item['id']] = item
        except SourceError as exc:
            errors.append({'upstream_id': seed, 'code': exc.code, 'message': str(exc)})
    return list(items.values()), errors


def _record(source: str, collection: dict[str, Any], uid: str, url: str, title: str,
            duration: Any, published: str, size: int = 0) -> dict[str, Any]:
    public_url(url)
    ext = urlsplit(url).path.rsplit('.', 1)[-1].lower()
    if ext not in {'mp3', 'm4a', 'aac', 'ogg', 'opus', 'wav', 'flac'}:
        raise SourceError('NOT_AUDIO', 'Public URL does not identify a supported audio format')
    try:
        seconds = max(0, int(duration or 0))
    except (TypeError, ValueError):
        raise SourceError('UPSTREAM_FORMAT', 'Invalid audio duration') from None
    result = asdict(AudioRecord(url=url, source=source, title=title, file_format=ext,
                    file_size=size, duration=seconds, category='podcast' if source == 'xiaoyuzhou' else 'audio',
                    language='zh', speaker=collection['title'], source_id=uid,
                    published_at=published, discovered_at=now()))
    result['upstream_item_id'] = result.pop('source_id')
    result.update(id=identity(source + ':episode:' + uid), collection_id=collection['id'],
                  collection_title=collection['title'], feed_url=collection['feed_url'],
                  collection_url=collection['collection_url'], author=collection['author'])
    return result


def xyz_records(page: dict[str, Any], collection: dict[str, Any], limit: int) -> tuple[list[dict[str, Any]], list[dict[str, str]], list[str]]:
    """Bind each title to its own enclosure and skip inaccessible/paid media explicitly."""
    kind, page_id = collection['raw']['kind'], collection['raw']['page_id']
    _xyz_collection(page, kind, page_id)
    rows = [page['episode']] if kind == 'episode' else page['podcast'].get('episodes')
    if not isinstance(rows, list):
        raise SourceError('UPSTREAM_FORMAT', 'Expected episode list in the public page')
    records, errors, warnings = [], [], []
    for row in rows[:limit]:
        try:
            if not isinstance(row, dict):
                raise SourceError('UPSTREAM_FORMAT', 'Invalid episode record')
            if row.get('isPrivateMedia') or row.get('payType', 'FREE') != 'FREE':
                raise SourceError('RESTRICTED_CONTENT', 'Paid/private episodes are excluded')
            media = row.get('media') or {}
            media_source = media.get('source') or {}
            if media_source.get('mode', 'PUBLIC') != 'PUBLIC':
                raise SourceError('RESTRICTED_CONTENT', 'Episode does not expose public media')
            eid = row.get('eid')
            if not isinstance(eid, str) or not re.fullmatch('[a-f0-9]{24}', eid) or row.get('pid') != collection['raw']['pid']:
                raise SourceError('UPSTREAM_FORMAT', 'Episode ID or parent podcast is invalid')
            enclosure = row.get('enclosure') or {}
            url = enclosure.get('url') or media_source.get('url')
            if not isinstance(url, str) or not url:
                raise SourceError('ENCLOSURE_MISSING', 'Episode has no public audio URL')
            record = _record('xiaoyuzhou', collection, eid, url, str(row.get('title', '')),
                             row.get('duration'), str(row.get('pubDate') or ''), int(media.get('size') or 0))
            record.update(page_url=f'{XYZ}/episode/{eid}', play_count=row.get('playCount'),
                          comment_count=row.get('commentCount'), availability='public')
            records.append(record)
        except (SourceError, TypeError, ValueError, AttributeError) as exc:
            errors.append({'code': getattr(exc, 'code', 'UPSTREAM_FORMAT'),
                           'message': str(exc) if isinstance(exc, SourceError) else 'Invalid episode metadata'})
    if kind == 'podcast':
        warnings.append('Only episodes embedded in the public page are visible; no complete-history pagination is claimed')
    return records, errors, warnings


def xm_record(data: dict[str, Any], collection: dict[str, Any]) -> dict[str, Any]:
    """Retain upstream audio-field priority; use HTTPS for the same public CDN resource."""
    chosen = next((key for key in ('playPathAacv224', 'playPathAacv164', 'playUrl64', 'playUrl32', 'downloadUrl') if data.get(key)), None)
    if not chosen:
        raise SourceError('ENCLOSURE_MISSING', 'Track has no public audio URL')
    original = data[chosen]
    public_url(original)
    parts = urlsplit(original)
    url = urlunsplit(parts._replace(scheme='https')) if parts.scheme == 'http' and (parts.hostname or '').endswith('.xmcdn.com') else original
    timestamp = data.get('createdAt')
    try:
        published = datetime.fromtimestamp(float(timestamp) / 1000, timezone.utc).isoformat() if timestamp else ''
    except (ValueError, TypeError, OverflowError, OSError):
        published = ''
    # Upstream's per-codec size can disagree with the returned media. Actual size is
    # measured by downloader; retain the declaration separately, never invent it.
    record = _record('ximalaya', collection, str(data['trackId']), url, str(data.get('title', '')),
                     data.get('duration'), published)
    record.update(original_audio_url=original, upstream_declared_size=data.get(chosen + 'Size'),
                  page_url=f'https://www.ximalaya.com/sound/{data["trackId"]}',
                  category=str(data.get('categoryName') or ''), play_count=data.get('playtimes'),
                  author=str((data.get('userInfo') or {}).get('nickname') or collection['author']),
                  availability='public_non_paid')
    return record


async def collect(net: Network, source: str, collection: dict[str, Any], params: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, str]], list[str]]:
    """Collect a bounded public page or bounded same-album neighbor sample."""
    limit = params.get('episodes_per_feed', 10)
    if source == 'xiaoyuzhou':
        payload = await net.read(collection['collection_url'], headers=HEADERS)
        return xyz_records(xyz_page(payload), collection, limit)
    seeds = collection['raw']['seed_track_ids']
    pending = list(seeds)
    radius = params.get('probe_range', 0)
    for seed in seeds:
        for delta in range(1, radius + 1):
            pending.extend(str(value) for value in (int(seed) + delta, int(seed) - delta) if value > 0)
    pending = list(dict.fromkeys(pending))[:params.get('max_track_requests', 10)]
    records, errors = [], []
    for pos, tid in enumerate(pending):
        if pos:
            await asyncio.sleep(params.get('request_interval', 2))
        try:
            data = await xm_track(net, tid)
            if str(data['albumId']) != collection['upstream_id']:
                continue  # Nearby numeric IDs are not necessarily part of this album.
            records.append(xm_record(data, collection))
            if len(records) >= limit:
                break
        except SourceError as exc:
            errors.append({'upstream_item_id': tid, 'code': exc.code, 'message': str(exc)})
    return records, errors, ['Seed/neighbor sampling is bounded and does not enumerate the complete album or platform']
