import concurrent.futures
import importlib.util
from pathlib import Path
import sys
import threading
import unittest

from fastapi import HTTPException
from fastapi.testclient import TestClient

spec = importlib.util.spec_from_file_location('embedding_server', Path(__file__).parents[1] / 'app/server.py')
server = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = server
spec.loader.exec_module(server)
KEY = 'test-only-' + 'x' * 40
HEADERS = {'Authorization': f'Bearer {KEY}'}


class FakeEngine:
    def __init__(self, settings):
        self.settings = settings
        self.calls = []

    def encode(self, texts, input_type):
        self.calls.append((texts, input_type))
        if texts == ['too-long']:
            raise HTTPException(413, 'Too many tokens')
        if texts == ['fail']:
            raise RuntimeError('sensitive submitted text must not escape')
        return [[float(i == j) for j in range(self.settings.dimensions)] for i in range(len(texts))], len(texts) * 3


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.app = server.create_app(server.Settings(api_key=KEY), FakeEngine)
        self.client = TestClient(self.app)
        self.client.__enter__()

    def tearDown(self):
        self.client.__exit__(None, None, None)

    def post(self, **kwargs):
        body = {'model': server.MODEL, 'input': ['退款纠纷', '天气预报'], **kwargs}
        return self.client.post('/v1/embeddings', json=body, headers=HEADERS)

    def test_auth_health_and_hub_contract(self):
        self.assertEqual(self.client.get('/healthz').status_code, 200)
        self.assertEqual(self.client.get('/v1/models').status_code, 401)
        self.assertEqual(self.client.get('/api/info').status_code, 401)
        r = self.post()
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual(body['model'], server.MODEL)
        self.assertEqual([v['index'] for v in body['data']], [0, 1])
        self.assertEqual(len(body['data'][0]['embedding']), 512)
        self.assertEqual(body['usage']['total_tokens'], 6)
        self.assertEqual(self.app.state.engine.calls[-1][1], 'document')
        self.assertEqual(self.post(input='退款', input_type='query').status_code, 200)
        self.assertEqual(self.app.state.engine.calls[-1], (['退款'], 'query'))

    def test_validation_and_fixed_space(self):
        for args in ({'dimensions': 768}, {'model': 'Qwen3-0.6B'}, {'input': []},
                     {'input': [' ']}, {'input': ['x'] * 17}):
            self.assertEqual(self.post(**args).status_code, 400, args)
        self.assertEqual(self.post(input=[123]).status_code, 422)
        self.assertEqual(self.post(encoding_format='base64').status_code, 422)
        self.assertEqual(self.post(dimensions=True).status_code, 422)
        self.assertEqual(self.post(input='too-long').status_code, 413)
        r = self.post(input='fail')
        self.assertEqual(r.status_code, 503)
        self.assertNotIn('sensitive', r.text)
        self.assertEqual(self.post().status_code, 200)  # failure releases admission
        r = self.client.post('/v1/embeddings', content=b'x' * 1_048_577, headers=HEADERS)
        self.assertEqual(r.status_code, 413)

    def test_busy_is_bounded_and_order_is_preserved(self):
        entered, release = threading.Event(), threading.Event()
        original = self.app.state.engine.encode
        def slow(texts, kind):
            entered.set()
            if not release.wait(5):
                raise RuntimeError('test timed out')
            return original(texts, kind)
        self.app.state.engine.encode = slow
        with concurrent.futures.ThreadPoolExecutor() as executor:
            first = executor.submit(self.post)
            self.assertTrue(entered.wait(3))
            try:
                second = self.post()
                self.assertEqual(second.status_code, 429)
                self.assertEqual(second.headers['retry-after'], '1')
            finally:
                release.set()
            self.assertEqual(first.result().status_code, 200)

    def test_bad_engine_output_is_never_published(self):
        self.app.state.engine.encode = lambda *_: ([[float('nan')] * 512], 1)
        self.assertEqual(self.post(input='x').status_code, 503)


if __name__ == '__main__':
    unittest.main()
