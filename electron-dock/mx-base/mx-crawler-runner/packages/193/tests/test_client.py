"""Offline behavior tests exercise the actual Node worker with a fake source.

Synthetic records are not live acceptance evidence. Node.js is required.
"""
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch
from mingxi_google_play import collect
from mingxi_google_play.runtime import ASSETS, runtime_path

FAKE = r'''
function request(opts) { opts.requestOptions.hooks.beforeRequest[0]({url: new URL('https://play.google.com/store/test')}); }
export default {
 sort: { NEWEST: 2, RATING: 3, HELPFULNESS: 1 },
 app: async opts => {
   request(opts);
   if (opts.appId === 'com.test.empty') return {};
   if (opts.appId === 'com.test.secret') throw new Error('proxy failed: ' + opts.requestOptions.agent.https.proxy);
   return {appId:opts.appId,title:'Synthetic application',developer:'Synthetic developer'};
 },
 categories: async opts => {request(opts); return ['APPLICATION'];},
 reviews: async opts => {
   request(opts);
   if (opts.nextPaginationToken && opts.appId === 'com.test.slow') await new Promise(resolve => setTimeout(resolve,30000));
   if (opts.nextPaginationToken && opts.appId === 'com.test.failure') throw new Error('Synthetic network failure');
   return {data:[{id:opts.nextPaginationToken || 'first',text:'Synthetic review'}],nextPaginationToken:opts.nextPaginationToken ? null : 'second'};
 }
};
'''


class CollectTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.runtime = self.root / 'runtime'
        self.backend = runtime_path(self.runtime)
        self.backend.mkdir(parents=True)
        shutil.copy2(ASSETS / 'worker.mjs', self.backend / 'worker.mjs')
        (self.backend / 'installed.json').write_text('{}')
        for name, source in [('google-play-scraper', FAKE), ('https-proxy-agent',
                "import https from 'node:https'; export class HttpsProxyAgent extends https.Agent { constructor(proxy,opts){super(opts);this.proxy=proxy;} }")]:
            folder = self.backend / 'node_modules' / name
            folder.mkdir(parents=True)
            (folder / 'package.json').write_text(json.dumps({'type': 'module', 'exports': './index.js'}))
            (folder / 'index.js').write_text(source)

    def call(self, operation='app', **kwargs):
        return collect(operation, runtime_dir=self.runtime, work_dir=self.root/'data', proxy=kwargs.pop('proxy', ''), **kwargs)

    def test_invalid_inputs_prevent_process_and_disk_work(self):
        cases = [dict(operation='bad'), dict(operation='app', app_id='https://example.com'),
                 dict(operation='search', term=''), dict(operation='app', app_id='com.test.app', timeout=float('nan')),
                 dict(operation='reviews', app_id='com.test.app', num=3),
                 dict(operation='reviews', app_id='com.test.app', max_pages=6),
                 dict(operation='search', term='x', num=101), dict(operation='search', term='x', max_requests=0)]
        with patch('mingxi_google_play.client.subprocess.run') as run:
            for options in cases:
                with self.subTest(options=options), self.assertRaises(ValueError):
                    collect(**options, work_dir=self.root/'invalid')
            run.assert_not_called()
        self.assertFalse((self.root/'invalid').exists())

    def test_missing_backend_is_structured_error(self):
        result = collect('app', app_id='com.test.app', runtime_dir=self.root/'missing', work_dir=self.root/'data', proxy='')
        self.assertEqual(result['error']['code'], 'SETUP_REQUIRED')
        self.assertEqual(result['status'], 'error')

    def test_success_and_repeat_calls_have_independent_directories(self):
        first = self.call(app_id='com.test.app')
        second = self.call(app_id='com.test.app')
        self.assertEqual(first['status'], 'success')
        self.assertEqual(first['data']['items'][0]['appId'], 'com.test.app')
        self.assertNotEqual(first['execution']['run_dir'], second['execution']['run_dir'])
        self.assertEqual(first['stats']['requests'], 1)

    def test_empty_payload_is_unknown(self):
        result = self.call(app_id='com.test.empty')
        self.assertEqual(result['status'], 'unknown')
        self.assertEqual(result['data']['items'], [])

    def test_synthetic_category_fallback_is_not_success(self):
        result = self.call('categories')
        self.assertEqual(result['status'], 'unknown')
        self.assertFalse(result['data']['items'])

    def test_proxy_credentials_are_redacted(self):
        proxy = 'http://synthetic-user:synthetic-secret@127.0.0.1:8080'
        result = self.call(app_id='com.test.secret', proxy=proxy)
        self.assertEqual(result['status'], 'error')
        self.assertTrue(result['execution']['proxy_used'])
        self.assertNotIn('synthetic-secret', json.dumps(result))
        for name in ('result.json', 'checkpoint.json', 'process.log'):
            self.assertNotIn('synthetic-secret', (Path(result['execution']['run_dir'])/name).read_text())

    def test_reviews_return_complete_pages_and_resume(self):
        first = self.call('reviews', app_id='com.test.app')
        self.assertEqual(first['data']['next_page_token'], 'second')
        self.assertEqual(first['query']['app_id'], 'com.test.app')
        self.assertEqual(first['query']['country'], 'us')
        resumed = self.call('reviews', app_id='com.test.app', next_page_token='second')
        self.assertEqual(resumed['data']['items'][0]['id'], 'second')
        self.assertIsNone(resumed['data']['next_page_token'])
        two = self.call('reviews', app_id='com.test.app', max_pages=2)
        self.assertEqual(len(two['data']['items']), 2)

    def test_request_budget_retains_first_page(self):
        result = self.call('reviews', app_id='com.test.app', max_pages=2, max_requests=1)
        self.assertEqual(result['status'], 'partial')
        self.assertEqual(result['error']['code'], 'REQUEST_LIMIT')
        self.assertEqual(result['stats']['requests'], 1)
        self.assertEqual(result['data']['next_page_token'], 'second')
        self.assertEqual(len(result['data']['items']), 1)

    def test_second_page_failure_retains_first_page(self):
        result = self.call('reviews', app_id='com.test.failure', max_pages=2)
        self.assertEqual(result['status'], 'partial')
        self.assertEqual(result['error']['code'], 'SOURCE_ERROR')
        self.assertEqual(len(result['data']['items']), 1)

    def test_actual_subprocess_timeout_retains_checkpoint(self):
        result = self.call('reviews', app_id='com.test.slow', max_pages=2, timeout=2)
        self.assertEqual(result['status'], 'partial')
        self.assertEqual(result['error']['code'], 'TIMEOUT')
        self.assertTrue(result['execution']['timed_out'])
        self.assertEqual(result['data']['items'][0]['id'], 'first')

    def test_no_proxy_is_respected(self):
        from mingxi_google_play.client import resolve_proxy
        with patch('mingxi_google_play.client.getproxies', return_value={'https':'http://127.0.0.1:8888'}), patch('mingxi_google_play.client.proxy_bypass', return_value=True):
            self.assertIsNone(resolve_proxy(None))
            self.assertEqual(resolve_proxy('http://127.0.0.1:8080'), 'http://127.0.0.1:8080')


if __name__ == '__main__':
    unittest.main()
