"""One GPU forward at a time, bounded admission and priority between micro-batches."""
import asyncio
from collections import deque
from dataclasses import dataclass, field
import logging
import math
import time

from fastapi import HTTPException
from starlette.concurrency import run_in_threadpool


def busy(message):
    return HTTPException(429, message, headers={'Retry-After': '1'})


@dataclass(eq=False)
class Job:
    texts: list
    input_type: str
    priority: str
    future: object
    started: float
    rows: object = None
    remaining: deque = field(default_factory=deque)
    vectors: list = field(default_factory=list)
    tokens: int = 0


class BatchScheduler:
    def __init__(self, engine, settings):
        self.engine, self.settings = engine, settings
        self.queues = {'interactive': deque(), 'background': deque()}
        self.jobs = set()
        self.wake = asyncio.Event()
        self.closed = False
        self.interactive_streak = 0
        self.metrics = dict(requests=0, failed=0, rejected=0, expired=0, tokens=0,
                            seconds=0.0, batches=0, texts=0, paddedTokens=0,
                            queueSeconds=0.0)
        self.task = asyncio.create_task(self.run())

    def snapshot(self):
        return {**self.metrics, 'pending': len(self.jobs),
                'interactivePending': sum(j.priority == 'interactive' for j in self.jobs),
                'backgroundPending': sum(j.priority == 'background' for j in self.jobs)}

    async def submit(self, texts, input_type, priority):
        s = self.settings
        background = sum(j.priority == 'background' for j in self.jobs)
        if self.closed:
            raise HTTPException(503, 'Embedding scheduler is stopping')
        if len(self.jobs) >= s.max_pending or (priority == 'background' and
                background >= s.max_pending - s.query_reserved):
            self.metrics['rejected'] += 1
            raise busy('Embedding queue full; retry with backoff')
        job = Job(texts, input_type, priority, asyncio.get_running_loop().create_future(), time.monotonic())
        self.jobs.add(job)
        self.queues[priority].append(job)
        self.wake.set()
        timeout = s.query_timeout if priority == 'interactive' else s.background_timeout
        try:
            return await asyncio.wait_for(job.future, timeout)
        except asyncio.TimeoutError:
            self.metrics['expired'] += 1
            raise busy('Embedding deadline exceeded; retry with backoff') from None
        finally:
            # Cancellation is checked before each forward. An already running CUDA
            # forward cannot be preempted; keep its admission slot until it returns.
            self.wake.set()

    def fail(self, job, error):
        if not job.future.done():
            self.metrics['failed'] += 1
            job.future.set_exception(error)
        self.jobs.discard(job)

    async def run(self):
        while not self.closed:
            await self.wake.wait()
            self.wake.clear()
            # Only wait to fill an underfull batch. A full document backlog
            # should run immediately; queries still get the next scheduling turn.
            queued_rows = sum(len(j.texts) if j.rows is None else len(j.remaining)
                              for queue in self.queues.values() for j in queue if not j.future.done())
            await asyncio.sleep(self.settings.batch_wait_ms / 1000
                                if queued_rows < self.settings.micro_batch else 0)
            for lane, queue in self.queues.items():
                self.queues[lane] = deque(j for j in queue if not j.future.done())
            self.jobs = {j for j in self.jobs if not j.future.done()}
            high, low = self.queues['interactive'], self.queues['background']
            if not high and not low:
                continue
            lane = 'interactive' if high and (not low or self.interactive_streak < 4) else 'background'
            self.interactive_streak = self.interactive_streak + 1 if lane == 'interactive' else 0
            queue = self.queues[lane]
            selected, width = [], 0
            while queue and len(selected) < self.settings.micro_batch:
                job = queue.popleft()
                if job.future.done():
                    self.jobs.discard(job)
                    continue
                if job.rows is None:
                    try:
                        self.metrics['queueSeconds'] += time.monotonic() - job.started
                        job.rows, job.tokens = await run_in_threadpool(self.engine.prepare, job.texts, job.input_type)
                        job.texts = []
                        job.vectors = [None] * len(job.rows)
                        job.remaining = deque(sorted(range(len(job.rows)), key=lambda i: len(job.rows[i]['input_ids'])))
                    except Exception as exc:
                        self.fail(job, self.safe_error(exc))
                        continue
                if job.future.done():
                    self.jobs.discard(job)
                    continue
                index = job.remaining[0]
                next_width = max(width, len(job.rows[index]['input_ids']))
                if selected and next_width * (len(selected) + 1) > self.settings.token_budget:
                    queue.appendleft(job)
                    break
                job.remaining.popleft()
                selected.append((job, index, job.rows[index]))
                width = next_width
                if job.remaining:
                    queue.append(job)
            # Preparing a later request yields to the event loop: an earlier
            # selection may expire/cancel during that time, before any GPU work.
            for job, _, _ in selected:
                if job.future.done():
                    self.jobs.discard(job)
            selected = [(job, index, row) for job, index, row in selected if not job.future.done()]
            if selected:
                width = max(len(row['input_ids']) for _, _, row in selected)
                started = time.monotonic()
                try:
                    vectors = await run_in_threadpool(self.engine.forward, [row for _, _, row in selected])
                    if len(vectors) != len(selected) or any(len(v) != self.settings.dimensions or
                            not all(math.isfinite(x) for x in v) for v in vectors):
                        raise RuntimeError('Invalid embedding shape')
                    self.metrics['batches'] += 1
                    self.metrics['texts'] += len(selected)
                    self.metrics['paddedTokens'] += width * len(selected)
                    for (job, index, _), vector in zip(selected, vectors):
                        job.vectors[index] = vector
                    for job in {j for j, _, _ in selected}:
                        if job.future.done():
                            self.jobs.discard(job)
                        elif all(v is not None for v in job.vectors):
                            self.metrics['requests'] += 1
                            self.metrics['tokens'] += job.tokens
                            job.future.set_result((job.vectors, job.tokens))
                            self.jobs.discard(job)
                except Exception as exc:
                    error = self.safe_error(exc)
                    for job in {j for j, _, _ in selected}:
                        self.fail(job, error)
                finally:
                    self.metrics['seconds'] += time.monotonic() - started
            if any(self.queues.values()):
                self.wake.set()

    @staticmethod
    def safe_error(error):
        if isinstance(error, HTTPException):
            return error
        logging.error('Embedding inference failed: %s', type(error).__name__)
        return HTTPException(503, 'Embedding inference unavailable')

    async def close(self):
        self.closed = True
        for job in list(self.jobs):
            self.fail(job, HTTPException(503, 'Embedding scheduler is stopping'))
        self.wake.set()
        await self.task
