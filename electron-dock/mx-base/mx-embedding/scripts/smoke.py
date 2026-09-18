"""Explicit real-model smoke test, executed inside the running service container."""
import json
import math
import os
from pathlib import Path
import urllib.request

key = Path('/run/secrets/api-key').read_text().strip()
body = {'model': 'Qwen/Qwen3-Embedding-0.6B', 'input': ['退货后商家拒绝退款', '今天的天气很好']}
request = urllib.request.Request('http://127.0.0.1:8000/v1/embeddings',
    data=json.dumps(body).encode(), headers={'Authorization': f'Bearer {key}', 'Content-Type': 'application/json'})
with urllib.request.urlopen(request, timeout=60) as response:
    result = json.load(response)
assert len(result['data']) == 2
for i, row in enumerate(result['data']):
    assert row['index'] == i and len(row['embedding']) == int(os.environ.get('DIMENSIONS', '512'))
    assert all(math.isfinite(v) for v in row['embedding'])
    assert abs(sum(v*v for v in row['embedding']) - 1) < 0.01
print('PASS: authenticated embeddings, order, dimensions and normalization')
