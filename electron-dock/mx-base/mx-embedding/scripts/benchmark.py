"""Explicit synthetic load only. Run inside the container; never print the Key."""
import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
import json
import math
import os
from pathlib import Path
import threading
import time
import urllib.error
import urllib.request

MODEL = 'Qwen/Qwen3-Embedding-0.6B'


def percentile(values, p):
    return round(sorted(values)[max(0, math.ceil(len(values) * p) - 1)] * 1000, 2) if values else None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--requests', type=int, default=20, help='Requests per worker, bounded to 1..100')
    parser.add_argument('--query-workers', type=int, default=2)
    parser.add_argument('--background-workers', type=int, default=2)
    parser.add_argument('--batch-size', type=int, default=16)
    args = parser.parse_args()
    if not (1 <= args.requests <= 100 and 0 <= args.query_workers <= 8 and
            0 <= args.background_workers <= 8 and args.query_workers + args.background_workers > 0 and
            1 <= args.batch_size <= 16):
        parser.error('workers: 0..8 each (at least one total); requests: 1..100; batch-size: 1..16')
    key = Path(os.environ.get('API_KEY_FILE', '/run/secrets/api-key')).read_text().strip()
    headers = {'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'}
    # Do not accidentally route localhost inference through model-download proxies.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    base = 'http://127.0.0.1:8000'

    def info():
        with opener.open(urllib.request.Request(base + '/api/info', headers=headers), timeout=10) as response:
            return json.load(response)

    def send(texts, priority):
        body = json.dumps({'model': MODEL, 'input': texts}, ensure_ascii=False).encode()
        request = urllib.request.Request(base + '/v1/embeddings', data=body,
                                        headers={**headers, 'X-MX-Embedding-Priority': priority})
        started = time.perf_counter()
        try:
            with opener.open(request, timeout=55) as response:
                result = json.load(response)
            rows = result['data']
            if len(rows) != len(texts) or [row['index'] for row in rows] != list(range(len(texts))):
                raise ValueError('Invalid result order/count')
            return dict(status='200', seconds=time.perf_counter() - started,
                        tokens=result['usage']['total_tokens'], texts=len(rows))
        except urllib.error.HTTPError as error:
            status = str(error.code)
            error.close()
        except Exception as error:
            status = type(error).__name__
        return dict(status=status, seconds=time.perf_counter() - started, tokens=0, texts=0)

    warmup = send(['合成验收：服务响应检查'], 'interactive')
    if warmup['status'] != '200':
        raise SystemExit('Warmup failed: ' + warmup['status'])
    before = info()
    workers = args.query_workers + args.background_workers
    barrier = threading.Barrier(workers + 1)

    def run(worker, priority):
        barrier.wait()
        rows = []
        for i in range(args.requests):
            texts = ([f'合成检索 {worker}-{i}：退货后商家迟迟不退款怎么办？'] if priority == 'interactive' else
                     [f'合成文档 {worker}-{i}-{j}：' +
                      '消费者退回商品后等待退款，客服记录了处理过程与物流签收情况。' * (2 + j % 5)
                      for j in range(args.batch_size)])
            rows.append(send(texts, priority))
        return priority, rows

    with ThreadPoolExecutor(max_workers=workers) as executor:
        tasks = [executor.submit(run, i, 'interactive' if i < args.query_workers else 'background')
                 for i in range(workers)]
        started = time.perf_counter()
        barrier.wait()
        results = [task.result() for task in tasks]
        seconds = time.perf_counter() - started
    after = info()
    lanes = {}
    for priority in ('interactive', 'background'):
        rows = [row for lane, batch in results if lane == priority for row in batch]
        good = [row for row in rows if row['status'] == '200']
        if rows:
            lanes[priority] = dict(statuses=dict(Counter(row['status'] for row in rows)),
                                  successfulQps=round(len(good) / seconds, 3),
                                  textsPerSecond=round(sum(row['texts'] for row in good) / seconds, 3),
                                  tokensPerSecond=round(sum(row['tokens'] for row in good) / seconds, 3),
                                  successP50Ms=percentile([row['seconds'] for row in good], .5),
                                  successP95Ms=percentile([row['seconds'] for row in good], .95),
                                  allP95Ms=percentile([row['seconds'] for row in rows], .95))
    counters = ('requests', 'tokens', 'batches', 'texts', 'paddedTokens', 'rejected', 'expired', 'queueSeconds', 'seconds')
    print(json.dumps(dict(synthetic=True, includesHubOrES=False, seconds=round(seconds, 3),
                         settings={key: after.get(key) for key in ('model', 'revision', 'dimensions', 'microBatch',
                                                                  'maxPending', 'queryReserved')},
                         workers=vars(args), results=lanes,
                         serviceCounterDelta={key: round(after[key] - before[key], 3) for key in counters
                                              if key in before and key in after},
                         note='Service counters include concurrent real traffic; successful QPS includes no retries.'),
                     ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
