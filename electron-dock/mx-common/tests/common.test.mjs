import assert from 'node:assert/strict'
import test from 'node:test'
import { loadCommonConfig, productDatabaseName, ConfigError } from '../src/config.mjs'
import { defineIndexSet, defaultIlmPolicy } from '../src/elasticsearch/index-manager.mjs'
import { nameField, vectorField } from '../src/elasticsearch/analysis.mjs'
import { dailySnapshotPolicy, s3Repository, snapshotHealth } from '../src/elasticsearch/snapshots.mjs'
import { createQueue } from '../src/queue/index.mjs'
import { batchingSegmenter, HanlpSegmenter } from '../src/segmenter/index.mjs'
import {
  describeClusterHealth,
  ElasticsearchClient,
  ElasticsearchError,
} from '../src/elasticsearch/client.mjs'

test('product id maps to a hyphen-free database name', () => {
  assert.equal(productDatabaseName('mx-insight-hub'), 'mx_insight_hub')
  assert.throws(() => productDatabaseName('MX_Insight'), ConfigError)
  assert.throws(() => productDatabaseName('ab'), ConfigError)
})

test('optional stores are absent rather than fatal when unconfigured', () => {
  const config = loadCommonConfig('mx-insight-hub', { DATABASE_URL: 'postgres://x/y' })
  assert.equal(config.elasticsearch.enabled, false)
  assert.equal(config.redis.enabled, false)
  assert.equal(config.segmenter.hanlpUrl, null)
  // No Redis means the queue must still work, so it falls back to PostgreSQL
  // rather than refusing to start.
  assert.equal(config.queue.driver, 'postgres')
})

test('a reachable Redis does not silently downgrade the queue driver', () => {
  // Adding Redis for caching must not take transactional enqueue away from a
  // product that never asked for BullMQ.
  const withRedis = loadCommonConfig('mx-insight-hub', {
    DATABASE_URL: 'postgres://x/y',
    MX_COMMON_REDIS_URL: 'redis://localhost:6379',
  })
  assert.equal(withRedis.queue.driver, 'postgres')

  const optedIn = loadCommonConfig('mx-insight-hub', {
    DATABASE_URL: 'postgres://x/y',
    MX_COMMON_REDIS_URL: 'redis://localhost:6379',
    MX_COMMON_QUEUE_DRIVER: 'bullmq',
  })
  assert.equal(optedIn.queue.driver, 'bullmq')
})

test('bullmq driver refuses a transactional enqueue instead of silently dropping it', async () => {
  const queue = createQueue(
    { driver: 'bullmq', namespace: 'test', redisUrl: 'redis://localhost:6379', maxAttempts: 3 },
    { pool: {}, logger: { error() {} } },
  )
  // Redis cannot join a PostgreSQL transaction. Accepting the client argument
  // and ignoring it would look correct and lose jobs on crash, so it throws.
  await assert.rejects(
    () => queue.enqueue('demo', {}, { client: {} }),
    /Transactional enqueue is not available/,
  )
})

test('index set names encode the schema version in the write alias only', () => {
  const v1 = defineIndexSet({ productId: 'demo-product', name: 'content', properties: {} })
  const v2 = defineIndexSet({
    productId: 'demo-product',
    name: 'content',
    schemaVersion: 2,
    properties: {},
  })
  // The read alias is stable across versions so query code survives a migration.
  assert.equal(v1.readAlias, v2.readAlias)
  assert.notEqual(v1.writeAlias, v2.writeAlias)
  assert.equal(v2.bootstrapIndex, 'demo-product-content-v2-000001')
})

test('single-node index sets default to zero replicas', () => {
  const definition = defineIndexSet({ productId: 'demo-product', name: 'content', properties: {} })
  // A replica that can never be allocated keeps the cluster yellow forever and
  // would block any "wait for green" gate.
  assert.equal(definition.settings.number_of_replicas, 0)
})

test('the lifecycle policy never deletes data', () => {
  const { policy } = defaultIlmPolicy()
  assert.deepEqual(Object.keys(policy.phases).sort(), ['cold', 'hot', 'warm'])
  assert.equal(policy.phases.delete, undefined)
  assert.equal(policy.phases.hot.actions.rollover.max_age, '30d')
  assert.equal(policy.phases.cold.actions.readonly !== undefined, true)
})

test('name fields expose exact, prefix and bigram sub-fields', () => {
  const field = nameField()
  assert.deepEqual(Object.keys(field.fields).sort(), ['bigram', 'keyword', 'prefix'])
  // Applying the ngram filter at search time too would match on any shared
  // prefix and destroy precision.
  assert.equal(field.fields.prefix.analyzer, 'mx_edge_ngram')
  assert.equal(field.fields.prefix.search_analyzer, 'mx_edge_ngram_search')
})

test('vector fields are indexed for kNN and quantized by default', () => {
  const field = vectorField(768)
  assert.equal(field.index, true)
  assert.equal(field.similarity, 'cosine')
  // Raw float32 HNSW sets a hard memory ceiling; quantizing is what keeps a
  // large corpus searchable at all.
  assert.equal(field.index_options.type, 'int8_hnsw')
  assert.equal(vectorField(768, { quantization: 'bbq' }).index_options.type, 'bbq_hnsw')
  assert.equal(vectorField(768, { quantization: null }).index_options.type, 'hnsw')
  assert.throws(() => vectorField(0), /positive integer/)
})

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

test('a snapshot must fail loudly rather than complete partially', () => {
  const policy = dailySnapshotPolicy()
  // A partial snapshot that reports success is worse than no snapshot: it gets
  // trusted at restore time.
  assert.equal(policy.config.partial, false)
  assert.equal(policy.config.ignore_unavailable, false)
})

test('snapshot retention keeps a floor even past the expiry window', () => {
  const { retention } = dailySnapshotPolicy()
  assert.equal(retention.expire_after, '30d')
  // Without min_count, a cluster idle longer than expire_after would expire its
  // way down to zero restore points.
  assert.ok(retention.min_count >= 1)
})

test('cluster state is excluded so a restore cannot clobber another cluster', () => {
  // Index templates, ILM and SLM policies are reconciled from code on every
  // deploy; capturing them here would add a second, staler source of truth.
  assert.equal(dailySnapshotPolicy().config.include_global_state, false)
})

test('an S3 repository requires a bucket rather than defaulting to something', () => {
  assert.throws(() => s3Repository({}), /requires a bucket/)
  const repo = s3Repository({ bucket: 'mx-backups', endpoint: 'http://minio:9000' })
  assert.equal(repo.type, 's3')
  assert.equal(repo.settings.path_style_access, true)
})

test('snapshot health treats "never succeeded" as unhealthy, not unknown', async () => {
  const client = {
    request: async () => ({ 'mx-common-daily': { policy: {}, stats: { snapshots_taken: 0 } } }),
  }
  const health = await snapshotHealth(client)
  assert.equal(health.configured, true)
  // A policy that exists but has never run is the exact failure this catches:
  // "configured" and "working" are different claims.
  assert.equal(health.healthy, false)
  assert.match(health.reason, /no successful snapshot/)
})

test('snapshot health goes unhealthy once the last success is stale', async () => {
  const twoDaysAgo = Date.now() - 48 * 3_600_000
  const client = {
    request: async () => ({
      'mx-common-daily': {
        last_success: { time: twoDaysAgo },
        stats: { snapshots_taken: 12, snapshots_failed: 3 },
      },
    }),
  }
  const health = await snapshotHealth(client, { staleAfterHours: 36 })
  assert.equal(health.healthy, false)
  assert.ok(health.lastSuccessAgeHours >= 47)
  assert.equal(health.snapshotsFailed, 3)
})

// ---------------------------------------------------------------------------
// Host-side scripts must not need node_modules
// ---------------------------------------------------------------------------

test('the snapshot config renderer imports nothing that needs installing', async () => {
  const { readFile } = await import('node:fs/promises')
  const { fileURLToPath } = await import('node:url')
  const { dirname, resolve } = await import('node:path')
  const here = dirname(fileURLToPath(import.meta.url))

  // `manage.sh ensure` runs this on the operator's host, where mx-common has no
  // node_modules and should need none. Reaching it through `src/index.mjs`
  // drags in the PostgreSQL helpers and therefore `pg`, which fails with
  // ERR_MODULE_NOT_FOUND on a freshly cloned server.
  const script = await readFile(resolve(here, '../scripts/print-snapshot-config.mjs'), 'utf8')
  const imports = [...script.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1])
  for (const specifier of imports) {
    assert.ok(
      specifier.startsWith('.') || specifier.startsWith('node:'),
      `${specifier} is an installed dependency; host-side scripts must only use relative or node: imports`,
    )
    assert.ok(
      !specifier.endsWith('/src/index.mjs'),
      'import the leaf module, not the package barrel: the barrel re-exports pg-dependent code',
    )
  }

  // The module it does import must itself be dependency-free, transitively.
  const snapshots = await readFile(resolve(here, '../src/elasticsearch/snapshots.mjs'), 'utf8')
  const nested = [...snapshots.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1])
  assert.deepEqual(nested, [], 'snapshots.mjs must stay import-free')
})

// ---------------------------------------------------------------------------
// Segmenter backend selection
// ---------------------------------------------------------------------------

test('jieba is the default backend, not the bigram fallback', async () => {
  const { createSegmenter, JiebaSegmenter, FallbackSegmenter, HanlpSegmenter } =
    await import('../src/segmenter/index.mjs')
  const quiet = { warn() {} }

  // Nothing configured: dictionary segmentation is a large quality win over
  // bigrams and costs no extra service, so it is what an unconfigured
  // deployment gets.
  assert.ok(createSegmenter({}, { logger: quiet }) instanceof JiebaSegmenter)
  // A configured HanLP URL outranks it.
  assert.ok(
    createSegmenter({ hanlpUrl: 'http://hanlp:8000' }, { logger: quiet }) instanceof HanlpSegmenter,
  )
  // An explicit choice wins over both.
  assert.ok(createSegmenter({ backend: 'fallback' }, { logger: quiet }) instanceof FallbackSegmenter)
  assert.ok(
    createSegmenter({ backend: 'jieba', hanlpUrl: 'http://hanlp:8000' }, { logger: quiet })
      instanceof JiebaSegmenter,
  )
})

test('MX_COMMON_SEGMENTER=hanlp without a URL degrades instead of failing', async () => {
  const { createSegmenter, JiebaSegmenter } = await import('../src/segmenter/index.mjs')
  const warnings = []
  const segmenter = createSegmenter(
    { backend: 'hanlp' },
    { logger: { warn: (message) => warnings.push(message) } },
  )
  // A projector that refuses to boot over a segmenter misconfiguration stops
  // ingestion; a worse segmenter only costs a later reindex.
  assert.ok(segmenter instanceof JiebaSegmenter)
  assert.match(warnings[0], /no MX_COMMON_HANLP_URL/)
})

test('jieba keeps multi-character terms whole and drops punctuation', async () => {
  const { createSegmenter } = await import('../src/segmenter/index.mjs')
  const segmenter = createSegmenter({ backend: 'jieba' }, { logger: { warn() {} } })
  const tokens = await segmenter.segment('人工智能，与检索增强生成的关系')
  if (!segmenter.available) return // package absent on this platform; covered by the fallback test

  // `new Jieba()` without the default dictionary silently produces single
  // characters, which retrieves no better than bigrams. This asserts the
  // dictionary is actually loaded.
  assert.ok(tokens.includes('人工智能'), `expected an intact term, got ${JSON.stringify(tokens)}`)
  assert.ok(!tokens.includes('，'), 'punctuation must not reach the token facet')
  assert.ok(tokens.every((token) => token === token.toLowerCase()))
})

test('segmentWithMeta reports HanLP success and segment keeps its array contract', async () => {
  const { HanlpSegmenter } = await import('../src/segmenter/index.mjs')
  let fallbackCalls = 0
  const segmenter = new HanlpSegmenter({
    url: 'http://hanlp:8000',
    fetchImpl: async () => ({
      ok: true,
      json: async () => [['吴恩达', '与', '人工智能']],
    }),
    fallbackSegmenter: {
      async segmentWithMeta() {
        fallbackCalls += 1
        return { tokens: ['jieba'], backendUsed: 'jieba', degraded: false, errorCode: null }
      },
    },
    logger: { warn() {} },
  })

  assert.deepEqual(await segmenter.segmentWithMeta('吴恩达与人工智能'), {
    tokens: ['吴恩达', '与', '人工智能'],
    backendUsed: 'hanlp',
    degraded: false,
    errorCode: null,
  })
  assert.deepEqual(await segmenter.segment('吴恩达与人工智能'), ['吴恩达', '与', '人工智能'])
  assert.equal(fallbackCalls, 0)
})

test('HanLP failures report stable per-call codes and degrade to jieba', async (t) => {
  const { HanlpSegmenter } = await import('../src/segmenter/index.mjs')
  const cases = [
    {
      name: 'HTTP error',
      expected: 'hanlp_http_error',
      fetchImpl: async () => ({ ok: false, status: 500 }),
    },
    {
      name: 'invalid JSON',
      expected: 'hanlp_invalid_json',
      fetchImpl: async () => ({
        ok: true,
        json: async () => { throw new SyntaxError('bad JSON') },
      }),
    },
    {
      name: 'empty tokens',
      expected: 'hanlp_empty_response',
      fetchImpl: async () => ({ ok: true, json: async () => [[]] }),
    },
    {
      name: 'request failure',
      expected: 'hanlp_request_error',
      fetchImpl: async () => {
        throw Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' })
      },
    },
  ]

  for (const candidate of cases) {
    await t.test(candidate.name, async () => {
      const fallbackInputs = []
      const segmenter = new HanlpSegmenter({
        url: 'http://hanlp:8000',
        fetchImpl: candidate.fetchImpl,
        fallbackSegmenter: {
          async segmentWithMeta(text) {
            fallbackInputs.push(text)
            return { tokens: ['吴恩达', '人工智能'], backendUsed: 'jieba', degraded: false, errorCode: null }
          },
        },
        logger: { warn() {} },
      })

      assert.deepEqual(await segmenter.segmentWithMeta('吴恩达与人工智能'), {
        tokens: ['吴恩达', '人工智能'],
        backendUsed: 'jieba',
        degraded: true,
        errorCode: candidate.expected,
      })
      assert.deepEqual(fallbackInputs, ['吴恩达与人工智能'])
    })
  }
})

test('HanLP timeout degrades to jieba without borrowing shared status', async () => {
  const { HanlpSegmenter } = await import('../src/segmenter/index.mjs')
  const segmenter = new HanlpSegmenter({
    url: 'http://hanlp:8000',
    timeoutMs: 5,
    fetchImpl: async (_url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), {
        once: true,
      })
    }),
    fallbackSegmenter: {
      async segmentWithMeta() {
        return { tokens: ['超时', '降级'], backendUsed: 'jieba', degraded: false, errorCode: null }
      },
    },
    logger: { warn() {} },
  })

  assert.deepEqual(await segmenter.segmentWithMeta('超时降级'), {
    tokens: ['超时', '降级'],
    backendUsed: 'jieba',
    degraded: true,
    errorCode: 'hanlp_timeout',
  })
})

test('jieba reports its backend and falls back to CJK bigrams on failure', async (t) => {
  const { fallbackSegment, JiebaSegmenter } = await import('../src/segmenter/index.mjs')
  const quiet = { warn() {} }

  await t.test('success', async () => {
    const segmenter = new JiebaSegmenter({
      loadImpl: async () => ({ cutAsync: async () => ['吴恩达', '，', 'AI'] }),
      logger: quiet,
    })
    assert.deepEqual(await segmenter.segmentWithMeta('吴恩达，AI'), {
      tokens: ['吴恩达', 'ai'],
      backendUsed: 'jieba',
      degraded: false,
      errorCode: null,
    })
  })

  await t.test('load failure', async () => {
    const segmenter = new JiebaSegmenter({
      loadImpl: async () => { throw new Error('module unavailable') },
      logger: quiet,
    })
    assert.deepEqual(await segmenter.segmentWithMeta('人工智能'), {
      tokens: fallbackSegment('人工智能'),
      backendUsed: 'bigram',
      degraded: true,
      errorCode: 'jieba_unavailable',
    })
  })

  await t.test('inference failure', async () => {
    const segmenter = new JiebaSegmenter({
      loadImpl: async () => ({ cutAsync: async () => { throw new Error('native failure') } }),
      logger: quiet,
    })
    assert.deepEqual(await segmenter.segmentWithMeta('人工智能'), {
      tokens: fallbackSegment('人工智能'),
      backendUsed: 'bigram',
      degraded: true,
      errorCode: 'jieba_inference_error',
    })
  })

  for (const tokens of [[], ['，']]) {
    await t.test(`empty normalized response ${JSON.stringify(tokens)}`, async () => {
      const segmenter = new JiebaSegmenter({
        loadImpl: async () => ({ cutAsync: async () => tokens }),
        logger: quiet,
      })
      assert.deepEqual(await segmenter.segmentWithMeta('人工智能'), {
        tokens: fallbackSegment('人工智能'),
        backendUsed: 'bigram',
        degraded: true,
        errorCode: 'jieba_empty_response',
      })
    })
  }
})

test('HanLP falls through a failed jieba backend to CJK bigrams', async () => {
  const { fallbackSegment, HanlpSegmenter, JiebaSegmenter } =
    await import('../src/segmenter/index.mjs')
  const quiet = { warn() {} }
  const segmenter = new HanlpSegmenter({
    url: 'http://hanlp:8000',
    fetchImpl: async () => ({ ok: false, status: 503 }),
    fallbackSegmenter: new JiebaSegmenter({
      loadImpl: async () => { throw new Error('jieba unavailable') },
      logger: quiet,
    }),
    logger: quiet,
  })

  assert.deepEqual(await segmenter.segmentWithMeta('人工智能'), {
    tokens: fallbackSegment('人工智能'),
    backendUsed: 'bigram',
    degraded: true,
    errorCode: 'hanlp_http_error',
  })
})

test('HanLP recovers and concurrent calls keep their own backend provenance', async () => {
  const { HanlpSegmenter } = await import('../src/segmenter/index.mjs')
  let recoverCalls = 0
  const recovering = new HanlpSegmenter({
    url: 'http://hanlp:8000',
    fetchImpl: async () => {
      recoverCalls += 1
      return recoverCalls === 1
        ? { ok: false, status: 503 }
        : { ok: true, json: async () => [['已恢复']] }
    },
    fallbackSegmenter: {
      async segmentWithMeta() {
        return { tokens: ['降级'], backendUsed: 'jieba', degraded: false, errorCode: null }
      },
    },
    logger: { warn() {} },
  })
  assert.equal((await recovering.segmentWithMeta('第一次')).backendUsed, 'jieba')
  assert.deepEqual(await recovering.segmentWithMeta('第二次'), {
    tokens: ['已恢复'],
    backendUsed: 'hanlp',
    degraded: false,
    errorCode: null,
  })
  assert.equal(recovering.available, true)
  assert.equal(recovering.lastError, null)

  const pending = new Map()
  const concurrent = new HanlpSegmenter({
    url: 'http://hanlp:8000',
    fetchImpl: async (_url, options) => {
      const { text } = JSON.parse(options.body)
      return new Promise((resolve) => pending.set(text, resolve))
    },
    fallbackSegmenter: {
      async segmentWithMeta(text) {
        return { tokens: [`jieba:${text}`], backendUsed: 'jieba', degraded: false, errorCode: null }
      },
    },
    logger: { warn() {} },
  })
  const failing = concurrent.segmentWithMeta('慢失败')
  const succeeding = concurrent.segmentWithMeta('快成功')
  pending.get('快成功')({ ok: true, json: async () => [['hanlp:快成功']] })
  const successResult = await succeeding
  pending.get('慢失败')({ ok: false, status: 500 })
  const failureResult = await failing

  assert.deepEqual(successResult, {
    tokens: ['hanlp:快成功'],
    backendUsed: 'hanlp',
    degraded: false,
    errorCode: null,
  })
  assert.deepEqual(failureResult, {
    tokens: ['jieba:慢失败'],
    backendUsed: 'jieba',
    degraded: true,
    errorCode: 'hanlp_http_error',
  })
})

test('HanLP image pins the compatible transformers line and infers during prefetch', async () => {
  const { readFile } = await import('node:fs/promises')
  const { fileURLToPath } = await import('node:url')
  const { dirname, resolve } = await import('node:path')
  const here = dirname(fileURLToPath(import.meta.url))
  const dockerfile = await readFile(resolve(here, '../deploy/hanlp/Dockerfile'), 'utf8')

  assert.match(dockerfile, /ARG TRANSFORMERS_VERSION=4\.54\.1/)
  assert.match(dockerfile, /"transformers==\$\{TRANSFORMERS_VERSION\}"/)
  const prefetch = dockerfile.slice(dockerfile.indexOf('RUN if [ "$PREFETCH_MODEL" = "1" ]'))
  assert.match(prefetch, /hanlp\.load/)
  assert.match(prefetch, /tokenizer\(\['\u5434\u6069\u8fbe\u4e0e\u4eba\u5de5\u667a\u80fd'\]\)/)
  assert.match(prefetch, /any\(isinstance\(sentence, list\)/)
  assert.match(prefetch, /any\(isinstance\(token, str\) and token\.strip\(\)/)
})

test('HanLP publishes readiness after warm-up and serializes safe inference', async () => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const { fileURLToPath } = await import('node:url')
  const { dirname, resolve } = await import('node:path')
  const run = promisify(execFile)
  const server = resolve(dirname(fileURLToPath(import.meta.url)), '../deploy/hanlp/server.py')

  const probe = String.raw`
import contextlib
import importlib.util
import io
import json
import sys
import types

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("mx_common_hanlp_server", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

assert module.MAX_CONCURRENT_INFERENCES == 1
assert module.INFERENCE_QUEUE_TIMEOUT_SECONDS > 0

class GoodTokenizer:
    def __init__(self):
        self.calls = []

    def __call__(self, text):
        self.calls.append(text)
        return [["吴恩达", "与", "人工智能"]]

good = GoodTokenizer()
model_ref = object()
sys.modules["hanlp"] = types.SimpleNamespace(
    pretrained=types.SimpleNamespace(
        tok=types.SimpleNamespace(COARSE_ELECTRA_SMALL_ZH=model_ref)
    ),
    load=lambda requested: good if requested is model_ref else None,
)
module._tokenizer = None
module._load_error = None
module._load_model()
assert module._tokenizer is good
assert good.calls == [[module.WARMUP_TEXT]]

class EmptyTokenizer:
    def __call__(self, _text):
        return [[]]

sys.modules["hanlp"].load = lambda _requested: EmptyTokenizer()
module._tokenizer = None
module._load_error = None
empty_log = io.StringIO()
with contextlib.redirect_stderr(empty_log):
    module._load_model()
assert module._tokenizer is None
assert module._load_error == "RuntimeError: model warm-up failed"

class BrokenTokenizer:
    def __call__(self, text):
        raise RuntimeError(f"inference detail contains {text}")

sys.modules["hanlp"].load = lambda _requested: BrokenTokenizer()
module._tokenizer = None
module._load_error = None
startup_log = io.StringIO()
with contextlib.redirect_stderr(startup_log):
    module._load_model()
assert module._tokenizer is None
assert module._load_error == "RuntimeError: model warm-up failed"
assert module.WARMUP_TEXT not in startup_log.getvalue()
assert "RuntimeError" in startup_log.getvalue()

class Slot:
    def __init__(self):
        self.timeout = None
        self.released = False

    def acquire(self, *, timeout):
        self.timeout = timeout
        return True

    def release(self):
        self.released = True

slot = Slot()
module._inference_slots = slot
request_calls = []

class RequestBrokenTokenizer:
    def __call__(self, text):
        request_calls.append(text)
        raise RuntimeError(f"inference detail contains {text}")

module._tokenizer = RequestBrokenTokenizer()
request_text = "request-content-must-not-enter-logs"
body = json.dumps({"text": request_text}).encode()
handler = object.__new__(module.Handler)
handler.path = "/tokenize"
handler.headers = {"content-length": str(len(body))}
handler.rfile = io.BytesIO(body)
sent = []
handler._send = lambda status, payload: sent.append((status, payload))
inference_log = io.StringIO()
with contextlib.redirect_stderr(inference_log):
    module.Handler.do_POST(handler)
assert sent == [(500, {"error": "tokenizer inference failed"})]
assert request_calls == [[request_text]]
assert request_text not in inference_log.getvalue()
assert "RuntimeError" in inference_log.getvalue()
assert slot.timeout == module.INFERENCE_QUEUE_TIMEOUT_SECONDS
assert slot.released
`
  await run('python3', ['-c', probe, server])
})

// ---------------------------------------------------------------------------
// Shell: bounded random reads
// ---------------------------------------------------------------------------

test('password generation cannot be killed by SIGPIPE under pipefail', async () => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const { fileURLToPath } = await import('node:url')
  const { dirname, resolve } = await import('node:path')
  const run = promisify(execFile)
  const script = resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/manage.sh')

  // `tr -dc ... </dev/urandom | head -c N` reads an infinite stream; head exits
  // first, tr dies of SIGPIPE (141), pipefail propagates it and `set -e` kills
  // the deploy before anything is logged. Every draw here must be bounded.
  const { stdout } = await run('bash', [
    '-c',
    `set -euo pipefail; source ${script} >/dev/null 2>&1 || true; for i in 1 2 3 4 5 6 7 8; do generate_password; echo; done`,
  ])
  const passwords = stdout.trim().split('\n')
  assert.equal(passwords.length, 8, 'every invocation must succeed, not just most')
  for (const password of passwords) {
    assert.match(password, /^[A-Za-z0-9]{40}$/)
  }
  // Alphanumeric-only is load-bearing: the value goes into a single-quoted SQL
  // literal and into URL userinfo, both without escaping.
  assert.equal(new Set(passwords).size, 8, 'passwords must not repeat')
})

test('deploy parses the hanlp target and rejects ignored arguments', async () => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const { fileURLToPath } = await import('node:url')
  const { dirname, resolve } = await import('node:path')
  const run = promisify(execFile)
  const script = resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/manage.sh')

  const { stdout } = await run('bash', [
    '-c',
    'source "$1"; cmd_ensure() { echo core; }; cmd_deploy_hanlp() { echo hanlp; }; main deploy; main deploy hanlp',
    '_',
    script,
  ])
  assert.deepEqual(stdout.trim().split('\n'), ['core', 'hanlp'])

  await assert.rejects(
    run('bash', ['-c', 'source "$1"; main deploy unknown', '_', script]),
    /unknown deploy target/,
  )
  await assert.rejects(
    run('bash', ['-c', 'source "$1"; main deploy hanlp extra', '_', script]),
    /usage: manage\.sh deploy \[hanlp\]/,
  )
  await assert.rejects(
    run('bash', [
      '-c',
      'source "$1"; need() { :; }; MX_COMMON_HANLP_ENABLED=1; cmd_ensure',
      '_',
      script,
    ]),
    /no longer a standalone deploy switch/,
  )
})

test('containerd image names are canonicalized before idempotency checks', async () => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const { fileURLToPath } = await import('node:url')
  const { dirname, resolve } = await import('node:path')
  const run = promisify(execFile)
  const script = resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/manage.sh')

  const { stdout } = await run('bash', [
    '-c',
    'source "$1"; canonical_image_ref mx-common-hanlp:local; canonical_image_ref qpjoy/hanlp:v1; canonical_image_ref registry.example/hanlp:v1',
    '_',
    script,
  ])
  assert.deepEqual(stdout.trim().split('\n'), [
    'docker.io/library/mx-common-hanlp:local',
    'docker.io/qpjoy/hanlp:v1',
    'registry.example/hanlp:v1',
  ])
})

test('the rendered HanLP pod template tracks the built image ID and local node', async () => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const { fileURLToPath } = await import('node:url')
  const { dirname, resolve } = await import('node:path')
  const run = promisify(execFile)
  const here = dirname(fileURLToPath(import.meta.url))
  const script = resolve(here, '../scripts/manage.sh')
  const manifest = resolve(here, '../deploy/k8s/optional/50-hanlp.yaml')

  const { stdout } = await run('bash', [
    '-c',
    'source "$1"; HANLP_IMAGE=registry.example/hanlp:test; MX_COMMON_HANLP_IMAGE_ID=sha256:abc123; MX_COMMON_HANLP_NODE_NAME=node-a; render_manifest "$2"',
    '_',
    script,
    manifest,
  ])
  assert.match(stdout, /mx-common\.io\/hanlp-image-id: "sha256:abc123"/)
  assert.equal((stdout.match(/image: registry\.example\/hanlp:test/g) || []).length, 2)
  assert.match(stdout, /kubernetes\.io\/hostname: node-a/)
  assert.doesNotMatch(stdout, /MX_COMMON_HANLP_IMAGE_ID_PLACEHOLDER/)
  assert.doesNotMatch(stdout, /MX_COMMON_HANLP_NODE_NAME_PLACEHOLDER/)
})

test('HanLP deploy re-imports the built image to self-heal a stale mutable tag', async () => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const { fileURLToPath } = await import('node:url')
  const { dirname, resolve } = await import('node:path')
  const run = promisify(execFile)
  const script = resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/manage.sh')

  const { stdout } = await run('bash', [
    '-c',
    `source "$1"
     need() { :; }
     require_local_single_k8s_node() { MX_COMMON_HANLP_NODE_NAME=node-a; export MX_COMMON_HANLP_NODE_NAME; }
     report_capacity() { :; }
     require_hanlp_disk_capacity() { :; }
     build_hanlp_image() { MX_COMMON_HANLP_IMAGE_ID=sha256:same; export MX_COMMON_HANLP_IMAGE_ID; echo build; }
     import_hanlp_image() { echo import; }
     kubectl() { return 0; }
     has_default_storage_class() { return 0; }
     render_manifest() { printf 'kind: List\n'; }
     allow_hostnetwork_clients() { :; }
     allow_client_namespace() { :; }
     wait_ready() { :; }
     hanlp_is_healthy() { return 0; }
     hanlp_tokenize_smoke() { return 0; }
     cmd_deploy_hanlp`,
    '_',
    script,
  ])
  assert.match(stdout, /build/)
  assert.match(stdout, /^import$/m)
})

test('HanLP local-image deploy refuses a remote Kubernetes node', async () => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const { fileURLToPath } = await import('node:url')
  const { dirname, resolve } = await import('node:path')
  const run = promisify(execFile)
  const script = resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/manage.sh')

  const matching = await run('bash', [
    '-c',
    `source "$1"
     kubectl() {
       case "$*" in
         'get nodes '*) printf 'node-metadata-name\\n' ;;
         'get node node-metadata-name '*) printf 'node-hostname-label\\n10.0.0.2\\n' ;;
         *) return 1 ;;
       esac
     }
     hostname() {
       case "\${1:-}" in
         -f) printf 'node-metadata-name\\n' ;;
         -I) printf '10.0.0.2\\n' ;;
         *) printf 'node-metadata-name\\n' ;;
       esac
     }
     say() { :; }
     require_local_single_k8s_node
     printf '%s' "$MX_COMMON_HANLP_NODE_NAME"`,
    '_',
    script,
  ])
  assert.equal(matching.stdout, 'node-hostname-label')

  await assert.rejects(
    run('bash', [
      '-c',
      `source "$1"
       kubectl() {
         case "$*" in
           'get nodes '*) printf 'remote-node\\n' ;;
           'get node remote-node '*) printf 'remote-node\\n10.9.8.7\\n' ;;
           *) return 1 ;;
         esac
       }
       hostname() {
         case "\${1:-}" in
           -f) printf 'local-host\\n' ;;
           -I) printf '10.0.0.2\\n' ;;
           *) printf 'local-host\\n' ;;
         esac
       }
       require_local_single_k8s_node`,
      '_',
      script,
    ]),
    /this host is not that node/,
  )

  await assert.rejects(
    run('bash', ['-c', 'source "$1"; kubectl() { return 1; }; require_local_single_k8s_node', '_', script]),
    /cannot query Kubernetes nodes/,
  )
})

test('the HanLP PVC seeder is repeatable and repairs a corrupt cache', async () => {
  const { execFile } = await import('node:child_process')
  const { mkdtemp, mkdir, readFile, rm, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join, resolve, dirname } = await import('node:path')
  const { createHash } = await import('node:crypto')
  const { fileURLToPath } = await import('node:url')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  const root = await mkdtemp(join(tmpdir(), 'mx-common-hanlp-seed-'))
  const seed = join(root, 'seed')
  const models = join(root, 'models')
  await mkdir(seed)
  await mkdir(models)

  const payload = 'model-weights-v1\n'
  const digest = createHash('sha256').update(payload).digest('hex')
  await writeFile(join(seed, 'model.bin'), payload)
  await writeFile(join(seed, '.mx-common-manifest.sha256'), `${digest}  ./model.bin\n`)

  const script = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../deploy/hanlp/seed-models.sh',
  )
  const environment = { ...process.env, HANLP_SEED_DIR: seed, HANLP_HOME: models }
  const first = await run('sh', [script], { env: environment })
  assert.match(first.stdout, /seeded and verified/)
  const second = await run('sh', [script], { env: environment })
  assert.match(second.stdout, /cache is current/)

  await writeFile(join(models, 'stale-model.bin'), 'obsolete')
  const cleaned = await run('sh', [script], { env: environment })
  assert.match(cleaned.stdout, /seeded and verified/)
  await assert.rejects(readFile(join(models, 'stale-model.bin')))

  await writeFile(join(models, 'model.bin'), 'corrupt')
  const repaired = await run('sh', [script], { env: environment })
  assert.match(repaired.stdout, /seeded and verified/)
  assert.equal(await readFile(join(models, 'model.bin'), 'utf8'), payload)
  await rm(root, { recursive: true, force: true })
})

test('the HanLP image and HTTP service keep reproducibility and load bounds explicit', async () => {
  const { readFile } = await import('node:fs/promises')
  const { dirname, resolve } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const here = dirname(fileURLToPath(import.meta.url))
  const dockerfile = await readFile(resolve(here, '../deploy/hanlp/Dockerfile'), 'utf8')
  const server = await readFile(resolve(here, '../deploy/hanlp/server.py'), 'utf8')
  const manifest = await readFile(resolve(here, '../deploy/k8s/optional/50-hanlp.yaml'), 'utf8')
  const manage = await readFile(resolve(here, '../scripts/manage.sh'), 'utf8')

  assert.match(dockerfile, /^ARG HANLP_VERSION=\d+\.\d+\.\d+$/m)
  assert.match(dockerfile, /^ARG TORCH_VERSION=\d+\.\d+\.\d+$/m)
  assert.match(dockerfile, /^ARG PIP_DEFAULT_TIMEOUT=\d+$/m)
  assert.match(dockerfile, /^ARG PIP_RETRIES=\d+$/m)
  assert.match(
    dockerfile,
    /^ARG PYTORCH_CPU_WHEEL_LINKS=https:\/\/download\.pytorch\.org\/whl\/cpu\/torch\/$/m,
  )
  assert.match(dockerfile, /--mount=type=cache,target=\/root\/\.cache\/pip/)
  assert.match(dockerfile, /--timeout "\$PIP_DEFAULT_TIMEOUT"[\s\S]*?--retries "\$PIP_RETRIES"/)
  assert.match(
    dockerfile,
    /--index-url "\$PIP_INDEX_URL"[\s\S]*?--find-links "\$PYTORCH_CPU_WHEEL_LINKS"[\s\S]*?"torch==\$\{TORCH_VERSION\}\+cpu"[\s\S]*?"hanlp==\$\{HANLP_VERSION\}"/,
  )
  assert.doesNotMatch(dockerfile, /--extra-index-url/)
  assert.doesNotMatch(dockerfile, /https:\/\/pypi\.org\/simple/)
  assert.match(dockerfile, /python -m pip check/)
  assert.match(dockerfile, /assert '\+cpu' in torch\.__version__/)
  assert.match(dockerfile, /assert torch\.version\.cuda is None/)
  assert.match(server, /MAX_BODY_BYTES/)
  assert.match(server, /BoundedSemaphore/)
  assert.match(manifest, /name: seed-models[\s\S]*?resources:/)
  assert.match(manage, /--driver docker-container/)
  assert.match(manage, /--buildkitd-flags '--allow-insecure-entitlement network\.host'/)
  assert.match(manage, /--network host[\s\S]*?--allow network\.host/)
  assert.match(manage, /MX_COMMON_HANLP_PROXY_CONFIG/)
  assert.match(manage, /docker buildx rm --keep-state/)
  assert.match(manage, /docker update[\s\S]*?--memory[\s\S]*?--cpu-quota/)
  assert.match(manage, /HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy/)
  assert.match(manage, /proxy_build_args\+=\(--build-arg "\$proxy_name"\)/)
  assert.match(manage, /MX_COMMON_CONTAINERD_ROOT/)
  assert.match(manage, /except urllib\.error\.HTTPError as error:/)
  assert.match(manage, /error\.read\(2049\)/)
  assert.match(manage, /HanLP \/tokenize returned no tokens/)
})


test('a wait_for_status timeout is the cluster answering, not an outage', async () => {
  const health = {
    cluster_name: 'mx-common',
    status: 'red',
    timed_out: true,
    number_of_nodes: 1,
    unassigned_shards: 6,
    initializing_shards: 0,
  }
  const client = new ElasticsearchClient({
    url: 'http://elasticsearch:9200',
    // ES answers a status it could not reach with 408 and the health document.
    fetchImpl: async () => new Response(JSON.stringify(health), {
      status: 408,
      headers: { 'content-type': 'application/json' },
    }),
  })

  const result = await client.clusterHealth({ waitForStatus: 'yellow', timeout: '3s' })
  assert.equal(result.status, 'red')
  assert.equal(result.timedOut, true)
  assert.equal(result.unassigned_shards, 6)
})

test('a transport failure stays an outage rather than a health reading', async () => {
  const client = new ElasticsearchClient({
    url: 'http://elasticsearch:9200',
    fetchImpl: async () => { throw new Error('connect ECONNREFUSED') },
  })
  await assert.rejects(
    () => client.clusterHealth(),
    (error) => error.name === 'ElasticsearchUnavailableError',
  )
})

test('a 408 that is not a health document still throws', async () => {
  const client = new ElasticsearchClient({
    url: 'http://elasticsearch:9200',
    fetchImpl: async () => new Response('<html>gateway timeout</html>', { status: 408 }),
  })
  await assert.rejects(() => client.clusterHealth(), ElasticsearchError)
})

test('a health document describes itself instead of reporting "unknown error"', () => {
  const error = new ElasticsearchError(
    408,
    { cluster_name: 'mx-common', status: 'red', timed_out: true, unassigned_shards: 6 },
    { method: 'GET', path: '/_cluster/health' },
  )
  assert.match(error.message, /status=red/)
  assert.match(error.message, /unassigned_shards=6/)
  assert.doesNotMatch(error.message, /unknown error/)
  assert.equal(describeClusterHealth({ cluster_name: 'x', status: 'green', number_of_nodes: 3 }),
    'status=green, nodes=3')
})


test('concurrent segmentation calls leave as one batch request', async () => {
  const requests = []
  const hanlp = new HanlpSegmenter({
    url: 'http://hanlp:8000',
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body)
      requests.push({ url: String(url), count: body.texts.length })
      return new Response(
        JSON.stringify({ batch: body.texts.map((text) => [text]) }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    },
  })
  const batching = batchingSegmenter(hanlp)

  const results = await Promise.all(
    ['吴恩达', '人工智能', '大模型'].map((text) => batching.segmentWithMeta(text)),
  )

  // One forward pass instead of three: this is the difference between a rebuild
  // measured in hours and one measured in days.
  assert.equal(requests.length, 1)
  assert.equal(requests[0].count, 3)
  assert.match(requests[0].url, /\/tokenize\/batch$/)
  // Results stay matched to their own input, with their own provenance.
  assert.deepEqual(results.map((result) => result.tokens), [['吴恩达'], ['人工智能'], ['大模型']])
  assert.deepEqual(results.map((result) => result.backendUsed), ['hanlp', 'hanlp', 'hanlp'])
  assert.equal(results.every((result) => result.degraded === false), true)
})

test('a batch larger than the limit is split rather than truncated', async () => {
  const sizes = []
  const hanlp = new HanlpSegmenter({
    url: 'http://hanlp:8000',
    fetchImpl: async (unused, options) => {
      const body = JSON.parse(options.body)
      sizes.push(body.texts.length)
      return new Response(JSON.stringify({ batch: body.texts.map((text) => [text]) }), { status: 200 })
    },
  })
  const batching = batchingSegmenter(hanlp, { maxBatch: 2 })

  const texts = ['a', 'b', 'c', 'd', 'e']
  const results = await Promise.all(texts.map((text) => batching.segmentWithMeta(text)))
  assert.deepEqual(sizes, [2, 2, 1])
  assert.deepEqual(results.map((result) => result.tokens), texts.map((text) => [text]))
})

test('a misaligned batch degrades every caller instead of misattributing tokens', async () => {
  const hanlp = new HanlpSegmenter({
    url: 'http://hanlp:8000',
    // Two texts in, one token list back.
    fetchImpl: async () => new Response(JSON.stringify({ batch: [['吴恩达']] }), { status: 200 }),
    fallbackSegmenter: {
      async segmentWithMeta(text) {
        return { tokens: [`jieba:${text}`], backendUsed: 'jieba', degraded: false, errorCode: null }
      },
    },
  })

  const results = await hanlp.segmentBatchWithMeta(['吴恩达', '人工智能'])
  // Attaching one record's tokens to another is worse than degrading, so the
  // whole batch falls back and every item is marked degraded for a strict
  // caller to reject.
  assert.equal(results.length, 2)
  assert.equal(results.every((result) => result.degraded === true), true)
  assert.equal(results.every((result) => result.backendUsed === 'jieba'), true)
  assert.equal(results[0].errorCode, 'hanlp_misaligned_batch')
})

test('a segmenter without a batch API is passed through unchanged', () => {
  const plain = { async segmentWithMeta() { return { tokens: [], backendUsed: 'jieba' } } }
  assert.equal(batchingSegmenter(plain), plain)
})


test('the migration refuses every path that would touch another product', async () => {
  const { readFile } = await import('node:fs/promises')
  const manage = await readFile(new URL('../scripts/manage.sh', import.meta.url), 'utf8')
  // mx-launcher carries the running MX-H2I estate; rsync into a live PGDATA
  // would corrupt a database this migration has no business touching.
  assert.match(manage, /that volume belongs to mx-launcher/)
  assert.match(manage, /refusing to write into/)
  assert.match(manage, /refusing to write inside/)
  assert.match(manage, /refusing a root that contains/)
  // The source is verified before anything is deleted, and never deleted here.
  assert.match(manage, /aborting before any PV is touched/)
  assert.match(manage, /rsync -aHAXn --numeric-ids --checksum/)
  // The old copy is only ever *printed* as a reclaim instruction, never run:
  // deleting the source is a human decision made after the new root proves out.
  for (const line of manage.split('\n')) {
    if (!line.includes('HOST_DATA_ROOT_ORIGINAL') || !line.includes('rm -rf')) continue
    assert.match(line.trim(), /^say "/, `the migration must not delete the source: ${line.trim()}`)
  }
  // The root is recovered from the cluster, so a forgotten export cannot
  // strand freshly moved data.
  assert.match(manage, /resolve_host_data_root/)
  assert.match(manage, /jsonpath='\{\.spec\.hostPath\.path\}'/)
})

test('the HanLP deployment is sized and configured for batch rebuilds', async () => {
  const { readFile } = await import('node:fs/promises')
  const manifest = await readFile(new URL('../deploy/k8s/optional/50-hanlp.yaml', import.meta.url), 'utf8')
  const server = await readFile(new URL('../deploy/hanlp/server.py', import.meta.url), 'utf8')
  assert.match(manifest, /name: MAX_BATCH_TEXTS/)
  // The queue must outlast a batch, or callers see 429 for work that succeeded.
  assert.match(manifest, /name: INFERENCE_QUEUE_TIMEOUT_SECONDS\n\s+value: "30"/)
  assert.match(server, /tokenize\/batch|endswith\("\/batch"\)/)
  // A short batch would misalign tokens with records; it is refused, not padded.
  assert.match(server, /tokenizer returned a misaligned batch/)
})


test('the relocation flag is accepted wherever it appears', async () => {
  const { readFile } = await import('node:fs/promises')
  const manage = await readFile(new URL('../scripts/manage.sh', import.meta.url), 'utf8')
  // `relocate --confirm` used to read the flag as the target path and then
  // reject it for not being absolute -- rejecting the command as documented.
  assert.match(manage, /parse_relocation_args/)
  assert.match(manage, /--confirm\) PARSED_RELOCATION_CONFIRMED=1/)
  // Both entry points forward every argument rather than two fixed slots.
  assert.match(manage, /migrate-storage\) shift; cmd_migrate_storage "\$@"/)
  assert.match(manage, /relocate\) shift; cmd_relocate "\$@"/)
  // An unrecognised flag is named, never silently taken for a path.
  assert.match(manage, /unknown option: \$\{argument\}/)
})


test('relocating storage restores the HanLP claim it detached', async () => {
  const { readFile } = await import('node:fs/promises')
  const manage = await readFile(new URL('../scripts/manage.sh', import.meta.url), 'utf8')
  // The HanLP PVC is declared in optional/, so migrating it without reapplying
  // that file leaves the pod Pending. The Hub then discovers no endpoint and
  // configures jieba -- a silent downgrade that only shows up as bad tokens.
  assert.match(manage, /hanlp_is_deployed/)
  assert.match(manage, /ensure_local_pvc mx-common-hanlp-models/)
  assert.match(manage, /rollout status deployment\/mx-common-hanlp/)
  // Never the whole HanLP manifest: it carries a nodeSelector placeholder that
  // only render_manifest fills in, so applying it raw would pin the pod to a
  // node named MX_COMMON_HANLP_NODE_NAME_PLACEHOLDER and strand it forever.
  const migrationStart = manage.indexOf('cmd_migrate_storage()')
  const migration = manage.slice(migrationStart, manage.indexOf('cmd_relocate()', migrationStart))
  assert.ok(migration.length > 0, 'the migration body must be locatable')
  assert.doesNotMatch(migration, /kubectl apply -f "\$\{K8S_DIR\}\/optional/)
  assert.doesNotMatch(migration, /50-hanlp\.yaml/)
})
