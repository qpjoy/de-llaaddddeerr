"""Offline regression suite. Synthetic responses are not live acceptance evidence."""
import asyncio
from contextlib import asynccontextmanager
import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from audiosource_220 import invoke_async
from audiosource_220.client import CONFIG
from audiosource_220 import providers
from audiosource_220.downloads import transfer, download_one, convert
from audiosource_220.runtime import Store, SourceError, WriterLock, identity, public_url

COLLECTION={'id':identity('collection'),'upstream_id':'123','title':'Test podcast','author':'Test author',
            'feed_url':'https://example.org/feed.xml','language':'en','genres':[],'raw':{}}
RSS=b'''<?xml version="1.0"?><rss xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" version="2.0"><channel>
<title>Test podcast</title><language>en</language><item><title>A &amp; B</title><guid>episode-1</guid>
<pubDate>Mon, 15 Sep 2025 10:00:00 GMT</pubDate><itunes:duration>01:02</itunes:duration>
<enclosure url="https://example.org/audio.mp3?a=1&amp;b=2" length="6" type="audio/mpeg"/></item></channel></rss>'''


class Content:
    def __init__(self, data):self.data=data
    async def iter_chunked(self, _):
        for offset in range(0,len(self.data),3):
            await asyncio.sleep(0)
            yield self.data[offset:offset+3]


class Response:
    def __init__(self,status=200,data=b'abcdef',headers=None):
        self.status=status;self.content=Content(data)
        self.headers=headers or {'Content-Length':str(len(data)),'Content-Type':'audio/mpeg'}


class FakeNetwork:
    def __init__(self,*args,response=None,fail=False,**kwargs):
        self.response=response or Response();self.fail=fail;self.calls=[]
    async def __aenter__(self):return self
    async def __aexit__(self,*_):pass
    @asynccontextmanager
    async def open(self,url,**kwargs):
        self.calls.append((url,kwargs))
        if self.fail:raise SourceError('NETWORK_ERROR','Synthetic network failure')
        yield self.response
    async def read(self,*_,**__):
        if self.fail:raise SourceError('NETWORK_ERROR','Synthetic network failure')
        return RSS
    async def json(self,url,**kwargs):
        self.calls.append((url,kwargs))
        if 'search/byterm' in url or 'podcasts/trending' in url or 'recent/feeds' in url:
            return {'status':True,'feeds':[{'id':123,'url':COLLECTION['feed_url'],'title':'Test podcast','author':'Author','language':'en'}]}
        if 'audiobooks' in url:
            return {'books':[{'id':'123','url_rss':COLLECTION['feed_url'],'title':'Book','authors':[],'language':'English'}]}
        if '/rss/' in url:return {'feed':{'entry':[{'id':{'attributes':{'im:id':'123'}}}]}}
        return {'results':[{'collectionId':123,'feedUrl':COLLECTION['feed_url'],'collectionName':'Test podcast','artistName':'Author'}]}


class ParserTests(unittest.TestCase):
    def test_enclosure_metadata_and_guid(self):
        records,errors=providers.parse_feed(RSS,COLLECTION,CONFIG['source'],10)
        self.assertFalse(errors);self.assertEqual(len(records),1)
        self.assertEqual(records[0]['duration'],62)
        self.assertEqual(records[0]['title'],'A & B')
        self.assertEqual(records[0]['url'],'https://example.org/audio.mp3?a=1&b=2')
        self.assertEqual(records[0]['upstream_item_id'],'episode-1')
        self.assertTrue(records[0]['published_at'].startswith('2025-09-15'))
    def test_invalid_html_xml_and_entities(self):
        for data in [b'<html>blocked</html>',b'<rss><channel>',b'<!DOCTYPE rss><rss><channel/></rss>']:
            with self.assertRaises(SourceError):providers.parse_feed(data,COLLECTION,CONFIG['source'],10)
    def test_valid_empty_feed_is_not_failure(self):
        self.assertEqual(providers.parse_feed(b'<rss><channel/></rss>',COLLECTION,CONFIG['source'],10),([],[]))
    def test_malformed_item_does_not_discard_good_items(self):
        data=RSS.replace(b'</channel>',b'<item><enclosure url="https://example.org/a.mp3" length="broken"/></item></channel>')
        records,errors=providers.parse_feed(data,COLLECTION,CONFIG['source'],10)
        self.assertEqual(len(records),1);self.assertEqual(errors[0]['code'],'INVALID_SIZE')
    def test_private_and_non_http_urls_are_rejected(self):
        for url in ['file:///test','http://127.0.0.1/a','http://[::1]/a','https://user:password@example.org/a','https://example.org:8888/a']:
            with self.assertRaises(SourceError):public_url(url)


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
    def test_connection_isolation_and_owner_binding(self):
        a=self.root/'a';b=self.root/'b';a.mkdir();b.mkdir()
        first=Store(a,CONFIG['source_id']);second=Store(b,CONFIG['source_id'])
        try:
            first.add_collection(COLLECTION)
            self.assertEqual(second.stats()['collections'],0)
            with self.assertRaises(SourceError):Store(a,'wrong_platform')
        finally:first.close();second.close()
    def test_incremental_deduplication_and_date_backfill(self):
        store=Store(self.root,CONFIG['source_id'])
        try:
            row=providers.parse_feed(RSS,COLLECTION,CONFIG['source'],10)[0][0]
            empty=copy.deepcopy(row);empty['published_at']=''
            self.assertEqual(store.add_records([empty]),1)
            self.assertEqual(store.add_records([row]),0)
            self.assertEqual(store.records(10)[0][0]['published_at'],row['published_at'])
        finally:store.close()
    def test_failed_feed_is_retryable(self):
        store=Store(self.root,CONFIG['source_id'])
        try:
            store.add_collection(COLLECTION);store.collection_result(COLLECTION['id'],'NETWORK_ERROR')
            self.assertEqual(len(store.collections(5)),1)
            store.collection_result(COLLECTION['id'])
            self.assertFalse(store.collections(5))
            self.assertEqual(len(store.collections(5,refresh=True)),1)
        finally:store.close()
    def test_writer_lock_blocks_second_operation(self):
        with WriterLock(self.root):
            with self.assertRaises(SourceError):
                with WriterLock(self.root):pass
    def test_url_duplicate_returns_stored_id_and_guid_refreshes_url(self):
        store=Store(self.root,CONFIG['source_id'])
        try:
            first=providers.parse_feed(RSS,COLLECTION,CONFIG['source'],10)[0][0]
            duplicate=copy.deepcopy(first);duplicate['id']=identity('different-guid')
            store.add_records([first]);self.assertEqual(store.add_records([duplicate]),0)
            self.assertEqual(duplicate['id'],first['id'])
            first['url']='https://example.org/refreshed.mp3';store.add_records([first])
            self.assertEqual(store.records(1)[0][0]['url'],first['url'])
        finally:store.close()


class DownloadTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.part=self.root/'file.part'
    async def test_full_download_and_hash(self):
        self.assertEqual(await transfer(FakeNetwork(),'https://example.org/a.mp3',self.part,100),6)
        self.assertEqual(self.part.read_bytes(),b'abcdef')
    async def test_range_206_exact_offset(self):
        self.part.write_bytes(b'abc')
        net=FakeNetwork(response=Response(206,b'def',{'Content-Length':'3','Content-Range':'bytes 3-5/6'}))
        await transfer(net,'https://example.org/a.mp3',self.part,100)
        self.assertEqual(self.part.read_bytes(),b'abcdef')
        self.assertEqual(net.calls[0][1]['headers']['Range'],'bytes=3-')
    async def test_ignored_range_restarts_not_appends(self):
        self.part.write_bytes(b'abc')
        await transfer(FakeNetwork(),'https://example.org/a.mp3',self.part,100)
        self.assertEqual(self.part.read_bytes(),b'abcdef')
    async def test_mismatched_206_does_not_append(self):
        self.part.write_bytes(b'abc')
        net=FakeNetwork(response=Response(206,b'def',{'Content-Length':'3','Content-Range':'bytes 0-2/6'}))
        with self.assertRaises(SourceError):await transfer(net,'https://example.org/a.mp3',self.part,100)
        self.assertEqual(self.part.read_bytes(),b'abc')
    async def test_changed_url_does_not_resume_old_partial(self):
        self.part.write_bytes(b'old-content')
        self.part.with_suffix('.part.resume.json').write_text(json.dumps({'url':'https://example.org/old.mp3','validator':'etag-old'}))
        net=FakeNetwork()
        await transfer(net,'https://example.org/new.mp3',self.part,100)
        self.assertNotIn('Range',net.calls[0][1]['headers'])
        self.assertEqual(self.part.read_bytes(),b'abcdef')
    async def test_416_requires_exact_total(self):
        self.part.write_bytes(b'abc')
        for headers in [{},{'Content-Range':'bytes */6'}]:
            with self.assertRaises(SourceError):await transfer(FakeNetwork(response=Response(416,b'',headers)),'https://example.org/a.mp3',self.part,100)
        size=await transfer(FakeNetwork(response=Response(416,b'',{'Content-Range':'bytes */3'})),'https://example.org/a.mp3',self.part,100)
        self.assertEqual(size,3)
    async def test_short_transfer_is_not_complete(self):
        net=FakeNetwork(response=Response(200,b'abc',{'Content-Length':'6'}))
        with self.assertRaises(SourceError):await transfer(net,'https://example.org/a.mp3',self.part,100)
        self.assertEqual(self.part.read_bytes(),b'abc')
    async def test_size_cap_known_and_chunked(self):
        for headers in [{'Content-Length':'6'},{'Content-Type':'audio/mpeg'}]:
            with self.assertRaises(SourceError):await transfer(FakeNetwork(response=Response(200,b'abcdef',headers)),'https://example.org/a.mp3',self.part,4)
    async def test_html_is_not_saved_as_audio(self):
        with self.assertRaises(SourceError):
            await transfer(FakeNetwork(response=Response(200,b'<html/>',{'Content-Type':'text/html'})),'https://example.org/a.mp3',self.part,100)
    async def test_pipeline_commits_complete_file_and_manifest(self):
        store=Store(self.root,CONFIG['source_id'])
        try:
            record=providers.parse_feed(RSS,COLLECTION,CONFIG['source'],10)[0][0]
            store.add_records([record])
            result=await download_one(FakeNetwork(),store,record,self.root,100,None,5)
            self.assertEqual(result['sha256'],hashlib.sha256(b'abcdef').hexdigest())
            self.assertEqual(store.records(1)[0][0]['status'],'done')
            self.assertTrue(Path(result['local_path']+'.json').exists())
        finally:store.close()
    async def test_conversion_failure_retains_original(self):
        store=Store(self.root,CONFIG['source_id'])
        try:
            record=providers.parse_feed(RSS,COLLECTION,CONFIG['source'],10)[0][0];store.add_records([record])
            with patch('audiosource_220.downloads.convert',side_effect=SourceError('CONVERSION_FAILED','test')):
                result=await download_one(FakeNetwork(),store,record,self.root,100,{'path':'fake'},5)
            self.assertEqual(result['conversion']['status'],'error')
            self.assertEqual(Path(result['local_path']).read_bytes(),b'abcdef')
        finally:store.close()


class SdkTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.directory=str(Path(self.temp.name)/'runtime')
        env=patch.dict(os.environ,{'PODCAST_INDEX_KEY':'TEST_KEY_NOT_REAL','PODCAST_INDEX_SECRET':'TEST_SECRET_NOT_REAL'})
        env.start();self.addCleanup(env.stop)
    async def call(self,operation,**params):
        with patch('audiosource_220.client.Network',FakeNetwork):
            return await invoke_async({'operation':operation,'params':{'run_dir':self.directory,**params}})
    async def test_discover_collect_list_and_incremental_refresh(self):
        inputs={} if CONFIG['source']=='librivox' else {'keyword':'test'}
        found=await self.call('discover',**inputs)
        self.assertEqual(found['status'],'success',found)
        result=await self.call('collect')
        self.assertEqual(result['status'],'success',result)
        self.assertEqual(result['result']['new_records'],1)
        self.assertEqual((await self.call('collect'))['status'],'no_data')
        self.assertEqual((await self.call('collect',refresh=True))['result']['new_records'],0)
        listed=await self.call('list_records',limit=1)
        self.assertEqual(listed['result']['pagination']['total'],1)
        self.assertEqual(listed['source_id'],CONFIG['source_id'])
    async def test_discovery_variants(self):
        if CONFIG['source']=='apple':
            self.assertEqual((await self.call('discover',mode='charts',genre_id=1318))['status'],'success')
        elif CONFIG['source']=='podcastindex':
            for mode in ['recent','trending']:
                self.assertEqual((await self.call('discover',mode=mode))['status'],'success')
        else:self.assertEqual((await self.call('discover',offset=10))['status'],'success')
    async def test_network_failure_not_empty_success(self):
        inputs={} if CONFIG['source']=='librivox' else {'keyword':'test'}
        await self.call('discover',**inputs)
        with patch('audiosource_220.client.Network',lambda *_:FakeNetwork(fail=True)):
            result=await invoke_async({'operation':'collect','params':{'run_dir':self.directory}})
        self.assertEqual(result['status'],'error')
        self.assertEqual(result['result']['errors'][0]['code'],'NETWORK_ERROR')
        self.assertEqual((await self.call('collect'))['status'],'success')
    async def test_bad_arguments_do_not_create_runtime(self):
        for op,params in [('collect',{'refresh':'yes'}),('download',{'max_file_bytes':0}),('stats',{'typo':True}),('discover',{'limit':True})]:
            result=await self.call(op,**params)
            self.assertEqual(result['status'],'error')
            self.assertFalse(Path(self.directory).exists())
    async def test_foreign_record_id_is_rejected(self):
        result=await self.call('download',record_ids=['0'*24])
        self.assertEqual(result['error']['code'],'NOT_FOUND')
    async def test_missing_ffmpeg_does_not_download(self):
        result=await self.call('download',format='opus',ffmpeg_path=str(Path(self.temp.name)/'missing.exe'))
        self.assertEqual(result['error']['code'],'DEPENDENCY_MISSING')
    async def test_missing_podcastindex_credentials(self):
        if CONFIG['source']!='podcastindex':return
        with patch.dict(os.environ,{'PODCAST_INDEX_KEY':'','PODCAST_INDEX_SECRET':''}):
            result=await self.call('discover',keyword='test')
        self.assertEqual(result['error']['code'],'CREDENTIAL_REQUIRED')
        self.assertFalse(Path(self.directory).exists())
    async def test_total_timeout_preserves_feed_for_retry(self):
        inputs={} if CONFIG['source']=='librivox' else {'keyword':'test'}
        await self.call('discover',**inputs)
        class Slow(FakeNetwork):
            async def read(self,*_,**__):await asyncio.sleep(2);return RSS
        with patch('audiosource_220.client.Network',Slow):
            result=await invoke_async({'operation':'collect','params':{'run_dir':self.directory,'total_timeout':1}})
        self.assertEqual(result['status'],'unknown',result)
        self.assertEqual(result['error']['code'],'TOTAL_TIMEOUT')
        self.assertEqual((await self.call('collect'))['status'],'success')


class CliTests(unittest.TestCase):
    def test_cli_stdout_is_one_json(self):
        base=Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as directory:
            request={'operation':'stats','params':{'run_dir':directory}}
            for entry in ['main.py','adapter.py']:
                proc=subprocess.run([sys.executable,str(base/entry)],input=json.dumps(request).encode(),capture_output=True,timeout=20)
                self.assertEqual(proc.returncode,0,proc.stderr)
                self.assertEqual(len(proc.stdout.splitlines()),1)
                self.assertEqual(json.loads(proc.stdout)['status'],'success')
            proc=subprocess.run([sys.executable,str(base/'adapter.py')],input=b'{broken',capture_output=True,timeout=20)
            self.assertEqual(proc.returncode,1)
            self.assertEqual(json.loads(proc.stdout)['error']['code'],'INVALID_INPUT')


if __name__=='__main__':unittest.main()
