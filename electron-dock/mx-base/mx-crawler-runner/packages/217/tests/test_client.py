"""Behavioral regression tests; synthetic cases are not live acceptance."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from mingxi_market_217.client import collect
from mingxi_market_217.config import INPUT_KINDS,MARKET,HISTORY_KINDS
from mingxi_market_217.normalize import normalize,MAPPINGS


class Tests(unittest.TestCase):
    def test_empty_and_echo_payloads_are_rejected(self):
        for value in ({},{'_meta':{}},{'package_name':'com.example.app'},{'appMap':{}}):
            self.assertIsNone(normalize(value,'https://example.com'))

    def test_mapped_record_requires_identity_name_and_version(self):
        mapping=MAPPINGS[MARKET]
        app={mapping['package']:'com.example.app',mapping['name']:'Example',mapping['version']:'1.2'}
        payload={'appMap':app} if MARKET=='xiaomi' else app
        result=normalize(payload,'https://example.com/app')
        self.assertEqual(result['app']['package'],'com.example.app')
        self.assertEqual(result['app']['version'],'1.2')
        self.assertEqual(result['source_url'],'https://example.com/app')
        del app[mapping['version']]
        self.assertIsNone(normalize(payload,'https://example.com'))

    def test_invalid_inputs_do_not_spawn_a_process(self):
        bad=[([],{}),(['https://example.com'],{}),(['1'],{'concurrency':0}),
             (['1'],{'timeout':float('nan')}),(['1'],{'input_kind':'bogus'})]
        with patch('mingxi_market_217.client.subprocess.run') as run:
            for values,params in bad:
                with self.assertRaises(ValueError):collect(values,**params)
            run.assert_not_called()

    def test_unsupported_history_is_explicit(self):
        if HISTORY_KINDS:return
        values=['com.example.app'] if INPUT_KINDS[0]=='package' else ['1']
        with self.assertRaises(ValueError):collect(values,history=True)

    def test_timeout_preserves_completed_records(self):
        values=['com.example.app'] if INPUT_KINDS[0]=='package' else ['1']
        def timeout(*args,**kwargs):
            config=json.loads(kwargs['input'])
            (Path(config['work_dir'])/'records.jsonl').write_text('{"app":{"name":"kept"}}\n',encoding='utf-8')
            raise subprocess.TimeoutExpired(args[0],kwargs['timeout'])
        with tempfile.TemporaryDirectory() as directory,patch('mingxi_market_217.client.subprocess.run',side_effect=timeout):
            result=collect(values,work_dir=directory)
        self.assertEqual(result['status'],'partial')
        self.assertEqual(result['error']['code'],'TIMEOUT')
        self.assertEqual(result['data']['items'][0]['app']['name'],'kept')

    def test_request_limit(self):
        from mingxi_market_217.worker import RequestLimit
        from scrapy.exceptions import IgnoreRequest
        flags={}
        spider=SimpleNamespace(job_config=SimpleNamespace(extra={'max_requests':1}),crawler=SimpleNamespace(stats=SimpleNamespace(set_value=lambda k,v:flags.update({k:v}))))
        limiter=RequestLimit();limiter.process_request(None,spider)
        with self.assertRaises(IgnoreRequest):limiter.process_request(None,spider)
        self.assertTrue(flags['delivery/request_limit'])

    def test_repeated_calls_use_distinct_run_directories(self):
        values=['com.example.app'] if INPUT_KINDS[0]=='package' else ['1']
        def complete(*args,**kwargs):
            cfg=json.loads(kwargs['input'])
            (Path(cfg['work_dir'])/'summary.json').write_text(json.dumps({'status':'success','data':{'items':[{'app':{'name':'test'}}]},'error':None}),encoding='utf-8')
            return SimpleNamespace(returncode=0)
        with tempfile.TemporaryDirectory() as directory,patch('mingxi_market_217.client.subprocess.run',side_effect=complete):
            a=collect(values,work_dir=directory);b=collect(values,work_dir=directory)
            self.assertNotEqual(a['execution']['run_dir'],b['execution']['run_dir'])


if __name__=='__main__':unittest.main()
