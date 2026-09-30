"""Bounded Qwen3 embedding service. No database or Hub identity dependencies."""
from contextlib import asynccontextmanager
from dataclasses import dataclass
import hmac
import os
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, StrictInt, StrictStr
from starlette.concurrency import run_in_threadpool
from scheduler import BatchScheduler

MODEL = 'Qwen/Qwen3-Embedding-0.6B'
REVISION = '97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3'  # Resolved to a full upstream commit in the deployment defaults.
QUERY_INSTRUCTION = 'Given a web search query, retrieve relevant passages that answer the query'


@dataclass
class Settings:
    model_path: str = MODEL
    revision: str = REVISION
    dimensions: int = 512
    max_length: int = 2048
    max_batch: int = 16
    token_budget: int = 8192
    micro_batch: int = 4
    max_pending: int = 32
    query_reserved: int = 8
    query_timeout: float = 6.0
    background_timeout: float = 45.0
    batch_wait_ms: float = 2.0
    dtype: str = 'bfloat16'
    gpu_fraction: float = 0.25
    threads: int = 4
    api_key: str = ''

    @classmethod
    def from_env(cls):
        key = Path(os.environ.get('API_KEY_FILE', '/run/secrets/api-key')).read_text().strip()
        if len(key) < 32:
            raise ValueError('API key must have at least 32 characters')
        s = cls(model_path=os.environ.get('MODEL_PATH', MODEL),
                revision=os.environ.get('MODEL_REVISION', REVISION),
                dimensions=int(os.environ.get('DIMENSIONS', '512')),
                max_length=int(os.environ.get('MAX_LENGTH', '2048')),
                max_batch=int(os.environ.get('MAX_BATCH', '16')),
                token_budget=int(os.environ.get('TOKEN_BUDGET', '8192')),
                micro_batch=int(os.environ.get('MICRO_BATCH', '4')),
                max_pending=int(os.environ.get('MAX_PENDING', '32')),
                query_reserved=int(os.environ.get('QUERY_RESERVED', '8')),
                query_timeout=float(os.environ.get('QUERY_TIMEOUT', '6')),
                background_timeout=float(os.environ.get('BACKGROUND_TIMEOUT', '45')),
                batch_wait_ms=float(os.environ.get('BATCH_WAIT_MS', '2')),
                dtype=os.environ.get('DTYPE', 'bfloat16'),
                gpu_fraction=float(os.environ.get('GPU_MEMORY_FRACTION', '0.25')),
                threads=int(os.environ.get('CPU_THREADS', '4')), api_key=key)
        if not (32 <= s.dimensions <= 1024 and 16 <= s.max_length <= 32768
                and 1 <= s.max_batch <= 64 and 1 <= s.micro_batch <= s.max_batch
                and 16 <= s.token_budget <= 65536 and 1 <= s.threads <= 32
                and 2 <= s.max_pending <= 128 and 1 <= s.query_reserved < s.max_pending
                and 0 < s.query_timeout <= 30 and 0 < s.background_timeout <= 120
                and 0 <= s.batch_wait_ms <= 10
                and 0 < s.gpu_fraction <= 0.8 and s.dtype in ('bfloat16', 'float16')):
            raise ValueError('Invalid model/resource configuration')
        return s


class EmbeddingRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    model: StrictStr
    input: StrictStr | list[StrictStr]
    dimensions: StrictInt | None = None
    encoding_format: Literal['float'] = 'float'
    input_type: Literal['document', 'query'] = 'document'
    user: StrictStr | None = None


class QwenEngine:
    def __init__(self, settings):
        import torch
        from transformers import AutoModel, AutoTokenizer
        self.torch, self.settings = torch, settings
        if not torch.cuda.is_available():
            raise RuntimeError('CUDA is required; CPU fallback is disabled')
        torch.set_num_threads(settings.threads)
        torch.cuda.set_per_process_memory_fraction(settings.gpu_fraction, 0)
        options = {} if Path(settings.model_path).is_dir() else {'revision': settings.revision}
        self.tokenizer = AutoTokenizer.from_pretrained(settings.model_path, padding_side='left', **options)
        self.model = AutoModel.from_pretrained(
            settings.model_path, torch_dtype=getattr(torch, settings.dtype),
            attn_implementation='sdpa', **options).to('cuda:0').eval()
        if self.model.config.hidden_size != 1024:
            raise RuntimeError('Expected Qwen3-Embedding-0.6B hidden size 1024')
        # A real CUDA forward proves kernels work on the selected GPU before readiness.
        self.encode(['服务就绪检查'], 'document')

    def prepare(self, texts, input_type):
        s = self.settings
        if input_type == 'query':
            texts = [f'Instruct: {QUERY_INSTRUCTION}\nQuery:{t}' for t in texts]
        encoded = self.tokenizer(texts, padding=False, truncation=False)
        lengths = [len(ids) for ids in encoded['input_ids']]
        if max(lengths) > s.max_length:
            raise HTTPException(413, f'Input exceeds {s.max_length} tokens; split text, no silent truncation')
        if sum(lengths) > s.token_budget:
            raise HTTPException(413, f'Batch exceeds {s.token_budget} tokens; use a smaller batch')
        return [{k: v[i] for k, v in encoded.items()} for i in range(len(texts))], sum(lengths)

    def forward(self, rows):
        torch, s = self.torch, self.settings
        with torch.inference_mode():
            batch = self.tokenizer.pad(
                {k: [row[k] for row in rows] for k in rows[0]},
                padding=True, return_tensors='pt').to('cuda:0')
            # Embedding is a single forward, never autoregressive generation.
            hidden = self.model(**batch, use_cache=False).last_hidden_state
            pooled = hidden[:, -1, :s.dimensions].float()
            normalized = torch.nn.functional.normalize(pooled, p=2, dim=1)
            if not torch.isfinite(normalized).all() or (normalized.norm(dim=1) < 0.99).any():
                raise RuntimeError('Invalid embedding output')
            return normalized.cpu().tolist()

    def encode(self, texts, input_type):
        # Startup CUDA smoke only; requests run through the shared scheduler.
        rows, tokens = self.prepare(texts, input_type)
        vectors = []
        for start in range(0, len(rows), self.settings.micro_batch):
            vectors.extend(self.forward(rows[start:start+self.settings.micro_batch]))
        return vectors, tokens


class BodyLimit:
    def __init__(self, app, limit=1_048_576):
        self.app, self.limit = app, limit

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http' or scope['method'] != 'POST':
            return await self.app(scope, receive, send)
        chunks, size = [], 0
        while True:
            message = await receive()
            if message['type'] == 'http.disconnect':
                return
            body = message.get('body', b'')
            size += len(body)
            if size > self.limit:
                return await JSONResponse({'error': 'Request body too large'}, status_code=413)(scope, receive, send)
            chunks.append(body)
            if not message.get('more_body', False):
                break
        async def replay():
            return {'type': 'http.request', 'body': b''.join(chunks), 'more_body': False}
        await self.app(scope, replay, send)


def create_app(settings=None, engine_factory=QwenEngine):
    state = {'ready': False}

    @asynccontextmanager
    async def lifespan(app):
        app.state.settings = settings or Settings.from_env()
        app.state.engine = await run_in_threadpool(engine_factory, app.state.settings)
        app.state.scheduler = BatchScheduler(app.state.engine, app.state.settings)
        state['ready'] = True
        try:
            yield
        finally:
            state['ready'] = False
            await app.state.scheduler.close()

    app = FastAPI(title='MX Embedding', lifespan=lifespan)
    app.add_middleware(BodyLimit)

    @app.middleware('http')
    async def authenticate(request, call_next):
        if request.url.path != '/healthz':
            expected = f'Bearer {app.state.settings.api_key}'
            if not hmac.compare_digest(request.headers.get('authorization', '').encode(), expected.encode()):
                return JSONResponse({'error': 'Unauthorized'}, status_code=401)
        return await call_next(request)

    @app.get('/healthz')
    async def health():
        return JSONResponse({'ready': state['ready']}, status_code=200 if state['ready'] else 503)

    @app.get('/v1/models')
    async def models():
        return {'object': 'list', 'data': [{'id': MODEL, 'object': 'model', 'owned_by': 'mx-base'}]}

    @app.get('/api/info')
    async def info():
        s = app.state.settings
        return {'model': MODEL, 'revision': s.revision, 'dimensions': s.dimensions,
                'maxLength': s.max_length, 'maxBatch': s.max_batch, 'tokenBudget': s.token_budget,
                'microBatch': s.micro_batch, 'maxPending': s.max_pending,
                'queryReserved': s.query_reserved, 'queryTimeout': s.query_timeout,
                'backgroundTimeout': s.background_timeout, 'batchWaitMs': s.batch_wait_ms,
                'dtype': s.dtype, 'device': 'cuda:0', 'defaultInputType': 'document',
                **state, **app.state.scheduler.snapshot()}

    @app.post('/v1/embeddings')
    async def embeddings(body: EmbeddingRequest, request: Request):
        s = app.state.settings
        if body.model != MODEL:
            raise HTTPException(400, 'Unknown model')
        if body.dimensions is not None and body.dimensions != s.dimensions:
            raise HTTPException(400, 'Dimensions differ from this service fixed vector space')
        texts = [body.input] if isinstance(body.input, str) else body.input
        if not texts or len(texts) > s.max_batch or any(not t.strip() for t in texts):
            raise HTTPException(400, f'Expected 1–{s.max_batch} nonempty texts')
        priority = request.headers.get('x-mx-embedding-priority', 'background')
        if priority not in ('interactive', 'background'):
            raise HTTPException(400, 'Unknown embedding priority')
        # Scheduling metadata does not imply input_type=query or modify vector space.
        vectors, tokens = await app.state.scheduler.submit(texts, body.input_type, priority)
        return {'object': 'list', 'model': MODEL,
                'data': [{'object': 'embedding', 'index': i, 'embedding': v} for i, v in enumerate(vectors)],
                'usage': {'prompt_tokens': tokens, 'total_tokens': tokens}}

    return app


app = create_app()
