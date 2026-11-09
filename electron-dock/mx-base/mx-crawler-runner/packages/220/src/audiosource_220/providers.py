"""Adapted from AudioSpider discover.py and spiders/librivox.py (MIT).

The upstream search -> feed -> enclosure workflow is retained. Network errors
are explicit, region/limits are call-local, and RSS parsing is a pure operation.
"""
from __future__ import annotations

from dataclasses import asdict
import hashlib
import os
import time
from typing import Any
from urllib.parse import urlsplit

from lxml import etree

from .upstream_types import AudioRecord, _parse_pubdate, _parse_duration
from .runtime import Network, SourceError, identity, now, public_url


def _collection(source: str, row: dict[str, Any]) -> dict[str, Any]:
    if source == 'apple':
        uid, feed, title, author = row.get('collectionId'), row.get('feedUrl'), row.get('collectionName'), row.get('artistName')
        language, genres = '', row.get('genres', [])  # country does not determine language
    elif source == 'podcastindex':
        uid, feed, title, author = row.get('id'), row.get('url') or row.get('originalUrl'), row.get('title'), row.get('author')
        language, genres = row.get('language',''), list((row.get('categories') or {}).values())
    else:
        uid, feed, title = row.get('id'), row.get('url_rss'), row.get('title')
        author = ', '.join(' '.join(str(a.get(k,'')) for k in ['first_name','last_name']).strip() for a in row.get('authors',[]))
        language, genres = row.get('language',''), ['audiobook']
    if not feed:
        raise SourceError('FEED_MISSING', 'Collection has no public feed URL')
    public_url(feed)
    return {'id':identity(source+':'+str(uid or feed)), 'upstream_id':str(uid or ''),
            'title':title or '', 'author':author or '', 'feed_url':feed,
            'language':language or '', 'genres':genres, 'observed_at':now(), 'raw':row}


async def discover(net: Network, source: str, params: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    """Discover bounded collections using the pinned upstream endpoint algorithms."""
    limit = params.get('limit',10)
    if source == 'apple':
        mode = params.get('mode','search')
        if mode == 'search':
            data = await net.json('https://itunes.apple.com/search',params={
                'term':params['keyword'],'media':'podcast','limit':min(limit,200),'country':params.get('country','us')})
        else:
            country, genre = params.get('country','us'), params['genre_id']
            data = await net.json(f'https://itunes.apple.com/{country}/rss/toppodcasts/limit={min(limit,200)}/genre={genre}/json')
            entries = data.get('feed',{}).get('entry',[])
            if not isinstance(entries,list):raise SourceError('UPSTREAM_FORMAT','Invalid Apple chart entries')
            ids = [str(row.get('id',{}).get('attributes',{}).get('im:id','')) for row in entries[:limit]]
            ids = [x for x in ids if x.isdigit()]
            if not ids:return [],[]
            data = await net.json('https://itunes.apple.com/lookup',params={
                'id':','.join(ids),'entity':'podcast','country':country})
        rows = data.get('results')
    elif source == 'podcastindex':
        key, secret = os.environ.get('PODCAST_INDEX_KEY',''), os.environ.get('PODCAST_INDEX_SECRET','')
        if not key or not secret:raise SourceError('CREDENTIAL_REQUIRED','Configure PODCAST_INDEX_KEY and PODCAST_INDEX_SECRET')
        timestamp = str(int(time.time()))
        headers = {'X-Auth-Key':key,'X-Auth-Date':timestamp,
                   'Authorization':hashlib.sha1((key+secret+timestamp).encode()).hexdigest(),
                   'User-Agent':'AudioSpider/1.0'}
        mode = params.get('mode','search')
        path = {'search':'search/byterm','trending':'podcasts/trending','recent':'recent/feeds'}[mode]
        query: dict[str, Any] = {'max':limit}
        if mode == 'search':query['q'] = params['keyword']
        if mode in {'recent','trending'}:query['lang'] = params.get('language','en')
        if mode == 'recent' and params.get('since') is not None:query['since'] = params['since']
        data = await net.json('https://api.podcastindex.org/api/1.0/'+path,headers=headers,params=query)
        if data.get('status') is False:raise SourceError('UPSTREAM_ERROR','Podcast Index rejected this request')
        rows = data.get('feeds')
    else:
        data = await net.json('https://librivox.org/api/feed/audiobooks/',params={
            'format':'json','limit':limit,'offset':params.get('offset',0)})
        rows = data.get('books')
    if not isinstance(rows,list):raise SourceError('UPSTREAM_FORMAT','Expected a list of collections')
    items, errors = [], []
    for row in rows[:limit]:
        try:
            if not isinstance(row,dict):raise SourceError('UPSTREAM_FORMAT','Invalid collection record')
            items.append(_collection(source,row))
        except (SourceError,AttributeError,TypeError) as exc:
            errors.append({'code':getattr(exc,'code','UPSTREAM_FORMAT'),'message':'Skipped an invalid or unavailable collection'})
    return items,errors


def parse_feed(payload: bytes, collection: dict[str, Any], source: str, limit: int) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    """Parse RSS enclosure metadata without network calls or XML entity expansion.

    AudioSpider's AudioRecord and date/duration helpers are reused directly.
    Invalid items are reported while good records remain available.
    """
    if b'<!DOCTYPE' in payload.upper() or b'<!ENTITY' in payload.upper():
        raise SourceError('INVALID_FEED','RSS document declarations/entities are unsupported')
    try:
        root = etree.fromstring(payload, parser=etree.XMLParser(resolve_entities=False,no_network=True,recover=False,huge_tree=False))
    except etree.XMLSyntaxError:
        raise SourceError('INVALID_FEED','Invalid RSS XML') from None
    if etree.QName(root).localname.lower() != 'rss':
        raise SourceError('INVALID_FEED','Expected an RSS document')
    channels = root.xpath('./*[local-name()="channel"]')
    if not channels:raise SourceError('INVALID_FEED','RSS channel is missing')
    channel = channels[0]
    def child_text(element: Any, name: str) -> str:
        found = element.xpath('./*[local-name()=$name]',name=name)
        return ''.join(found[0].itertext()).strip() if found else ''
    title = child_text(channel,'title') or collection['title']
    language = child_text(channel,'language') or collection.get('language','')
    records, errors = [], []
    for item in channel.xpath('./*[local-name()="item"]')[:limit]:
        enclosures = item.xpath('./*[local-name()="enclosure"]')
        if not enclosures:
            errors.append({'code':'ENCLOSURE_MISSING','message':'An item has no audio enclosure'});continue
        enclosure = enclosures[0]
        try:
            url = public_url(enclosure.get('url',''))
            extension = urlsplit(url).path.rsplit('.',1)[-1].lower()
            mime = enclosure.get('type','').lower()
            if 'audio' not in mime and extension not in {'mp3','m4a','aac','ogg','opus','wav','flac'}:
                raise SourceError('NOT_AUDIO','Item enclosure is not recognized as audio')
            size = enclosure.get('length','0') or '0'
            if not size.isdigit():raise SourceError('INVALID_SIZE','Enclosure length is invalid')
            guid = child_text(item,'guid') or url
            record = AudioRecord(url=url,source=source,title=child_text(item,'title'),
                file_format=extension if extension in {'mp3','m4a','aac','ogg','opus','wav','flac'} else 'mp3',
                file_size=int(size), duration=_parse_duration(child_text(item,'duration')),
                category='audiobook' if source=='librivox' else 'podcast',language=language,
                speaker=title,source_id=guid,published_at=_parse_pubdate(child_text(item,'pubDate')),
                discovered_at=now())
            output = asdict(record)
            # Preserve upstream GUID separately from the delivery row's source_id.
            output['upstream_item_id'] = output.pop('source_id')
            output.update(id=identity(collection['id']+':'+guid),collection_id=collection['id'],
                          feed_url=collection['feed_url'],collection_title=collection['title'],
                          author=child_text(item,'author') or collection.get('author',''))
            records.append(output)
        except SourceError as exc:
            errors.append({'code':exc.code,'message':str(exc)})
    return records,errors
