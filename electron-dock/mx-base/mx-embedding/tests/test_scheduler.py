import asyncio
import threading
import unittest

from fastapi import HTTPException
from test_api import server


class Engine:
    def __init__(self, dimensions=32):
        self.dimensions = dimensions
        self.calls = []
        self.entered, self.release = threading.Event(), threading.Event()
        self.release.set()
        self.active = 0
        self.max_active = 0

    def prepare(self, texts, input_type):
        if 'invalid' in texts:
            raise HTTPException(413, 'Too many tokens')
        rows = [{'input_ids': [int(text.split(':')[0])] * int(text.split(':')[1])} for text in texts]
        return rows, sum(len(row['input_ids']) for row in rows)

    def forward(self, rows):
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        self.calls.append([row['input_ids'][0] for row in rows])
        self.entered.set()
        try:
            if not self.release.wait(3):
                raise RuntimeError('Test barrier timeout')
            return [[float(row['input_ids'][0])] * self.dimensions for row in rows]
        finally:
            self.active -= 1


class SchedulerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = Engine()
        self.settings = server.Settings(dimensions=32)
        self.scheduler = server.BatchScheduler(self.engine, self.settings)

    async def asyncTearDown(self):
        self.engine.release.set()
        await self.scheduler.close()

    def submit(self, texts, priority='background'):
        return asyncio.create_task(self.scheduler.submit(texts, 'document', priority))

    async def blocked_background(self):
        self.engine.release.clear()
        job = self.submit([f'{i}:8' for i in range(16)])
        self.assertTrue(await asyncio.to_thread(self.engine.entered.wait, 2))
        return job

    async def test_query_overtakes_remaining_document_chunks_without_parallel_gpu(self):
        background = await self.blocked_background()
        query = self.submit(['100:2'], 'interactive')
        await asyncio.sleep(0.01)
        self.engine.release.set()
        query_vectors, _ = await query
        vectors, tokens = await background
        self.assertEqual(self.engine.calls[1], [100])
        self.assertEqual([v[0] for v in vectors], list(range(16)))
        self.assertEqual(query_vectors[0][0], 100)
        self.assertEqual(tokens, 128)
        self.assertEqual(self.engine.max_active, 1)

    async def test_short_requests_share_forwards_and_long_inputs_restore_order(self):
        result = await asyncio.gather(*(self.submit([f'{i}:2']) for i in range(12)))
        self.assertEqual(len(self.engine.calls), 3)
        self.assertEqual([vectors[0][0] for vectors, _ in result], list(range(12)))
        # Same maximum micro-batch; sorting avoids padding all four batches to 100.
        before = self.scheduler.metrics['paddedTokens']
        texts = [f'{i}:{100 if i % 4 == 0 else 2}' for i in range(16)]
        vectors, _ = await self.scheduler.submit(texts, 'document', 'background')
        self.assertEqual([v[0] for v in vectors], list(range(16)))
        self.assertEqual(self.scheduler.metrics['paddedTokens'] - before, 424)

    async def test_reserved_admission_and_full_queue_return_retry_after(self):
        self.settings.max_pending, self.settings.query_reserved = 3, 1
        first = await self.blocked_background()
        second = self.submit(['20:2'])
        await asyncio.sleep(0)
        with self.assertRaises(HTTPException) as error:
            await self.scheduler.submit(['30:2'], 'document', 'background')
        self.assertEqual(error.exception.status_code, 429)
        self.assertEqual(error.exception.headers['Retry-After'], '1')
        query = self.submit(['100:2'], 'interactive')
        await asyncio.sleep(0)
        with self.assertRaises(HTTPException):
            await self.scheduler.submit(['101:2'], 'document', 'interactive')
        self.engine.release.set()
        await asyncio.gather(first, second, query)
        self.assertEqual(self.scheduler.snapshot()['pending'], 0)
        self.assertEqual(self.scheduler.metrics['rejected'], 2)

    async def test_expired_and_cancelled_queries_never_enter_later_forward(self):
        first = await self.blocked_background()
        self.settings.query_timeout = 0.02
        with self.assertRaises(HTTPException):
            await self.scheduler.submit(['100:2'], 'document', 'interactive')
        cancelled = self.submit(['101:2'], 'interactive')
        await asyncio.sleep(0)
        cancelled.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await cancelled
        self.engine.release.set()
        await first
        self.assertFalse({100, 101} & {v for batch in self.engine.calls for v in batch})
        self.assertEqual(self.scheduler.metrics['expired'], 1)

    async def test_query_burst_does_not_starve_background_and_bad_request_is_isolated(self):
        self.settings.micro_batch = 1
        first = await self.blocked_background()
        queries = [self.submit([f'{i}:2'], 'interactive') for i in range(100, 112)]
        bad = self.submit(['invalid'])
        await asyncio.sleep(0.01)
        self.engine.release.set()
        results = await asyncio.gather(first, bad, *queries, return_exceptions=True)
        self.assertIsInstance(results[1], HTTPException)
        self.assertEqual(results[1].status_code, 413)
        self.assertTrue(all(100 <= batch[0] for batch in self.engine.calls[1:5]))
        self.assertLess(self.engine.calls[5][0], 100)
        self.assertEqual(self.scheduler.metrics['failed'], 1)

    async def test_cancel_during_another_requests_tokenization_skips_selected_row(self):
        entered, release = threading.Event(), threading.Event()
        original = self.engine.prepare
        def prepare(texts, kind):
            if texts == ['2:2']:
                entered.set()
                if not release.wait(2):
                    raise RuntimeError('Test barrier timeout')
            return original(texts, kind)
        self.engine.prepare = prepare
        first, second = self.submit(['1:2']), self.submit(['2:2'])
        try:
            self.assertTrue(await asyncio.to_thread(entered.wait, 1))
            first.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await first
        finally:
            release.set()
        await second
        self.assertEqual(self.engine.calls, [[2]])

    async def test_padded_token_bound_and_shutdown(self):
        self.settings.token_budget = 10
        result = await asyncio.gather(self.submit(['1:6']), self.submit(['2:6']))
        self.assertEqual(self.engine.calls, [[1], [2]])
        self.assertEqual(len(result), 2)
        await self.scheduler.close()
        with self.assertRaises(HTTPException) as error:
            await self.scheduler.submit(['3:2'], 'document', 'interactive')
        self.assertEqual(error.exception.status_code, 503)


if __name__ == '__main__':
    unittest.main()
