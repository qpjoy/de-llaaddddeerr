"""Offline regression fixtures; these are synthetic, not live source evidence."""
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

from audiosource_46 import invoke_async
from audiosource_46.client import CONFIG
from audiosource_46 import providers
from audiosource_46.downloads import transfer, download_one, convert
from audiosource_46.runtime import Store, SourceError, WriterLock, identity, public_url

PID = '5e4ee557418a84a0466737b7'
EID = '5e4ee557418a84a0466737c1'
COLLECTION = {'id':identity('collection'), 'upstream_id':'123', 'title':'Test podcast', 'author':'Test author',
              'feed_url':'https://example.org/feed', 'collection_url':'https://example.org/feed', 'language':'zh', 'genres':[], 'raw':{}}
RSS = b'synthetic-not-used-as-a-source'


def sample_record():
    return {'id':identity('record'), 'collection_id':COLLECTION['id'], 'url':'https://example.org/audio.mp3',
            'title':'Test audio', 'file_size':6, 'file_format':'mp3', 'duration':62, 'language':'zh',
            'published_at':'2026-09-18T00:00:00Z', 'upstream_item_id':'test-guid'}


def xyz_data():
    episode = {'eid':EID, 'pid':PID, 'title':'中文标题「一」', 'duration':62,
               'enclosure':{'url':'https://media.xyzcdn.net/test.m4a'},
               'media':{'size':6,'source':{'mode':'PUBLIC'}}, 'payType':'FREE',
               'pubDate':'2026-09-18T00:00:00Z', 'isPrivateMedia':False}
    podcast = {'pid':PID, 'title':'测试播客', 'author':'测试作者', 'episodeCount':1}
    episode['podcast'] = copy.deepcopy(podcast)
    podcast['episodes'] = [episode]
    return {'podcast':podcast, 'episode':episode}


def page_bytes(data):
    return ('<html><script id="__NEXT_DATA__" type="application/json">' +
            json.dumps({'props':{'pageProps':data}},ensure_ascii=False) + '</script></html>').encode()


def xm_data(tid='3558286', aid=277141):
    return {'ret':0, 'trackId':int(tid), 'albumId':aid, 'title':'测试音频', 'albumTitle':'测试专辑',
            'isPaid':False, 'isPublic':True, 'duration':62, 'userInfo':{'nickname':'测试作者'},
            'playPathAacv224':'http://aod.cos.tx.xmcdn.com/test.mp3', 'createdAt':1758153600000}

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
            row=sample_record()
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
            first=sample_record()
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
            record=sample_record()
            store.add_records([record])
            result=await download_one(FakeNetwork(),store,record,self.root,100,None,5)
            self.assertEqual(result['sha256'],hashlib.sha256(b'abcdef').hexdigest())
            self.assertEqual(store.records(1)[0][0]['status'],'done')
            self.assertTrue(Path(result['local_path']+'.json').exists())
        finally:store.close()
    async def test_conversion_failure_retains_original(self):
        store=Store(self.root,CONFIG['source_id'])
        try:
            record=sample_record();store.add_records([record])
            with patch('audiosource_46.downloads.convert',side_effect=SourceError('CONVERSION_FAILED','test')):
                result=await download_one(FakeNetwork(),store,record,self.root,100,{'path':'fake'},5)
            self.assertEqual(result['conversion']['status'],'error')
            self.assertEqual(Path(result['local_path']).read_bytes(),b'abcdef')
        finally:store.close()

class SourceNetwork(FakeNetwork):
    async def read(self, url, **kwargs):
        if self.fail:
            raise SourceError('NETWORK_ERROR','Synthetic failure')
        return page_bytes(xyz_data())

    async def json(self, url, **kwargs):
        if self.fail:
            raise SourceError('NETWORK_ERROR','Synthetic failure')
        tid = kwargs.get('params',{}).get('trackId','3558286')
        self.calls.append((url,kwargs))
        return xm_data(tid)


class SourceTests(unittest.IsolatedAsyncioTestCase):
    async def test_xyz_structured_json_preserves_chinese_and_pairs(self):
        data = xyz_data()
        collection = providers._xyz_collection(data,'podcast',PID)
        records, errors, warnings = providers.xyz_records(providers.xyz_page(page_bytes(data)),collection,10)
        self.assertFalse(errors)
        self.assertEqual(records[0]['title'],'中文标题「一」')
        self.assertEqual(records[0]['upstream_item_id'],EID)
        self.assertTrue(warnings)

    async def test_xyz_malformed_and_access_pages_are_errors(self):
        for payload in [b'<html>challenge</html>', b'<html/>', page_bytes({'statusCode':404})]:
            with self.assertRaises(SourceError):providers.xyz_page(payload)

    async def test_xyz_identity_and_private_url_rejected(self):
        data = xyz_data();collection = providers._xyz_collection(data,'podcast',PID)
        with self.assertRaises(SourceError):providers._xyz_collection(data,'podcast','f'*24)
        data['podcast']['episodes'][0]['enclosure']['url']='http://127.0.0.1/a.mp3'
        records, errors, _ = providers.xyz_records(data,collection,10)
        self.assertFalse(records);self.assertEqual(errors[0]['code'],'INVALID_URL')

    async def test_xyz_paid_episode_does_not_discard_public(self):
        data = xyz_data();collection = providers._xyz_collection(data,'podcast',PID)
        paid = copy.deepcopy(data['episode']);paid['payType']='PAY';paid['eid']='a'*24
        data['podcast']['episodes'].append(paid)
        records, errors, _ = providers.xyz_records(data,collection,10)
        self.assertEqual(len(records),1);self.assertEqual(errors[0]['code'],'RESTRICTED_CONTENT')

    async def test_xyz_empty_episode_list_is_valid_no_data(self):
        data=xyz_data();collection=providers._xyz_collection(data,'podcast',PID)
        data['podcast']['episodes']=[]
        records, errors, _ = providers.xyz_records(data,collection,10)
        self.assertEqual((records,errors),([],[]))

    async def test_xyz_single_episode_scope(self):
        data=xyz_data();collection=providers._xyz_collection(data,'episode',EID)
        records, errors, warnings = providers.xyz_records(data,collection,1)
        self.assertEqual(len(records),1);self.assertFalse(errors);self.assertFalse(warnings)

    async def test_xm_grouped_seeds_https_and_size(self):
        with patch('audiosource_46.providers.asyncio.sleep',return_value=None):
            items,errors=await providers.discover(SourceNetwork(),'ximalaya',{'track_ids':['3558286','3558287']})
        self.assertFalse(errors);self.assertEqual(len(items),1)
        self.assertEqual(items[0]['raw']['seed_track_ids'],['3558286','3558287'])
        record=providers.xm_record(xm_data(),items[0])
        self.assertTrue(record['url'].startswith('https://'))
        self.assertTrue(record['original_audio_url'].startswith('http://'))
        self.assertEqual(record['file_size'],0)
        self.assertTrue(record['published_at'])

    async def test_xm_api_paid_and_mismatched_tracks_fail(self):
        for changes in [{'isPaid':True},{'isPublic':False},{'ret':-1},{'trackId':99}]:
            class Invalid(SourceNetwork):
                async def json(self,*args,**kwargs):return {**xm_data(),**changes}
            with self.assertRaises(SourceError):await providers.xm_track(Invalid(),'3558286')

    async def test_xm_neighbor_scope_and_budget(self):
        class Neighbors(SourceNetwork):
            async def json(self,url,**kwargs):
                tid=kwargs['params']['trackId'];self.calls.append(tid)
                return xm_data(tid,aid=999 if tid=='3558287' else 277141)
        net=Neighbors()
        collection=providers._collection('ximalaya','277141','Album','Author','https://www.ximalaya.com/album/277141',{'seed_track_ids':['3558286']})
        with patch('audiosource_46.providers.asyncio.sleep',return_value=None):
            records,errors,warnings=await providers.collect(net,'ximalaya',collection,{'probe_range':5,'max_track_requests':3})
        self.assertEqual(len(net.calls),3);self.assertEqual(len(records),2)
        self.assertNotIn('3558287',[r['upstream_item_id'] for r in records])
        self.assertFalse(errors);self.assertTrue(warnings)


class SdkTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.directory=str(Path(self.temp.name)/'runtime')

    async def call(self,operation,**params):
        with patch('audiosource_46.client.Network',SourceNetwork):
            return await invoke_async({'operation':operation,'params':{'run_dir':self.directory,**params}})

    async def test_discover_collect_list_refresh_dedup(self):
        found=await self.call('discover');self.assertEqual(found['status'],'success',found)
        first=await self.call('collect');self.assertEqual(first['status'],'success',first)
        self.assertEqual(first['result']['new_records'],1)
        empty=await self.call('collect');self.assertEqual(empty['status'],'no_data')
        refreshed=await self.call('collect',refresh=True);self.assertEqual(refreshed['result']['new_records'],0)
        listed=await self.call('list_records');self.assertEqual(len(listed['result']['items']),1)

    async def test_invalid_inputs_no_runtime_side_effects(self):
        requests=[{'concurrency':False},{'concurrency':5},{'request_interval':0},{'keyword':'unsupported'},
                  {'limit':21},{'track_ids':['1;echo bad']} if CONFIG['source']=='ximalaya' else {'podcast_ids':['https://example.org']},
                  {'track_ids':['01']} if CONFIG['source']=='ximalaya' else {'podcast_ids':[PID],'episode_ids':[EID]}]
        for params in requests:
            out=await self.call('discover',**params)
            self.assertEqual(out['error']['code'],'INVALID_INPUT',out)
        self.assertFalse(Path(self.directory).exists())

    async def test_network_failure_not_no_data_and_collection_retryable(self):
        await self.call('discover')
        with patch('audiosource_46.client.Network',lambda *a:SourceNetwork(fail=True)):
            failed=await invoke_async({'operation':'collect','params':{'run_dir':self.directory}})
        self.assertEqual(failed['status'],'error')
        recovered=await self.call('collect');self.assertEqual(recovered['status'],'success')

    async def test_overall_timeout_reports_unknown(self):
        async def slow(*args,**kwargs):await asyncio.sleep(10)
        with patch('audiosource_46.client.providers.discover',slow):
            response=await self.call('discover',total_timeout=1)
        self.assertEqual(response['status'],'unknown');self.assertEqual(response['error']['code'],'TOTAL_TIMEOUT')

    async def test_unconfigured_ffmpeg_is_explicit(self):
        out=await self.call('download',format='opus',ffmpeg_path=str(Path(self.temp.name)/'missing.exe'))
        self.assertEqual(out['status'],'error')
        self.assertEqual(out['error']['code'],'DEPENDENCY_MISSING')

    async def test_cli_stdout_contains_one_json_document(self):
        command=[sys.executable,str(Path(__file__).resolve().parents[1]/'main.py')]
        run=await asyncio.to_thread(subprocess.run,command,input=b'{"operation":"stats","params":{}}',capture_output=True,timeout=10)
        result=json.loads(run.stdout)
        self.assertEqual(result['status'],'error');self.assertEqual(result['error']['code'],'INVALID_INPUT')
        self.assertEqual(run.returncode,1)


if __name__=='__main__':
    unittest.main()
