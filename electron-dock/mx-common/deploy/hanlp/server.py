"""Minimal HanLP tokenization service.

Exposes exactly the endpoints mx-common's segmenter client calls:

    POST /tokenize        {"text": "...", "coarse": true}   ->  [["token", ...]]
    POST /tokenize/batch  {"texts": [...], "coarse": true}  ->  {"batch": [[...], ...]}
    GET  /health          200 once every worker has warmed up, 503 before

Kept to a single capability on purpose. HanLP can do POS tagging, NER, SRL and
dependency parsing, and every one of those loads another model into memory. This
service exists so Elasticsearch can index Chinese text without an in-cluster
analyzer plugin; anything beyond word segmentation belongs in the Hub agent, not
in a shared, always-on tokenizer.

Inference runs in a pool of worker processes, each holding its own model. The
HTTP front never imports HanLP or PyTorch: it parses requests, admits them to a
worker and relays the answer. The pool is sized from the container's cgroup CPU
quota and memory limit, so the manifest's resource limits are the only knob.
First load downloads weights to HANLP_HOME, so the container needs a persistent
volume there or a warm image; readiness stays false until every worker has its
model in memory.
"""

import collections
import json
import multiprocessing
import os
import select
import signal
import socket
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Coarse-grained ("CTB-style") segmentation keeps multi-character terms such as
# 人工智能 and brand names intact. Fine-grained models split them, which hurts
# search precision far more than it helps recall.
MODEL_NAME = os.environ.get("HANLP_MODEL", "COARSE_ELECTRA_SMALL_ZH")
HOST = "0.0.0.0"
PORT = int(os.environ.get("PORT", "8000"))
MAX_BODY_BYTES = int(os.environ.get("MAX_BODY_BYTES", "1048576"))
# A rebuild segments hundreds of thousands of records. HanLP's own API is
# batch-shaped -- it takes a list of texts and returns a list of token lists --
# so sending one text per HTTP request pays the model handoff, the HTTP round
# trip and the Python dispatch once per record instead of once per batch. The
# bound keeps a single caller from monopolising a worker.
MAX_BATCH_TEXTS = int(os.environ.get("MAX_BATCH_TEXTS", "256"))
# Waiting briefly is important: the Hub projector segments several fields in
# parallel, so a non-blocking admission would routinely degrade otherwise
# healthy requests to the local fallback.
INFERENCE_QUEUE_TIMEOUT_SECONDS = float(
    os.environ.get("INFERENCE_QUEUE_TIMEOUT_SECONDS", "3")
)
WARMUP_TEXT = "吴恩达与人工智能"

# A HanLP component is one mutable Python object that nobody has validated as
# thread-safe, so concurrency comes from processes that each own a model, never
# from threads sharing one. Each worker costs a full model plus PyTorch's
# runtime, and its activations grow with the batch. The budget is the high end
# of what one worker needs under a full bulk batch, because an OOM kill takes
# the whole pod down with it. The front reserve covers the HTTP process, the
# multiprocessing resource tracker and request bodies in flight.
MIB = 1024 * 1024
WORKER_MEMORY_BYTES = 1536 * MIB
FRONT_MEMORY_BYTES = 512 * MIB
# Workers only interactive requests may take, so a projector or rebuild that
# fills every other worker with long batches never leaves a query waiting for
# one of them to finish. A pool of one has nothing to spare and falls back to
# admitting interactive requests first.
INTERACTIVE_RESERVED_WORKERS = 1
PRIORITY_HEADER = "x-mx-segment-priority"
INTERACTIVE = "interactive"
BULK = "bulk"
# PyTorch sizes its pools from the *host* CPU count, not the cgroup limit, so on
# a 128-thread node every worker would start 128 threads inside a 16-CPU
# container: thrashing, plus thread stacks and allocator arenas this pod was
# once OOM-killed for. Each worker gets an even share of the quota instead.
THREAD_ENV_NAMES = ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "TORCH_NUM_THREADS")
CGROUP_ROOT = "/sys/fs/cgroup"
# cgroup v1 reports "no limit" as a page-aligned value just under 2**63.
_UNLIMITED_MEMORY_BYTES = 1 << 60


def _optional_positive_int(name):
    raw = os.environ.get(name, "").strip()
    return max(1, int(raw)) if raw else None


# Optional upper bound on the pool, unset by default. It used to count threads
# sharing one model; it now caps worker processes, which keeps that safety
# property and adds real parallelism. Setting it to 1 restores the single-slot
# service without a rebuild.
MAX_CONCURRENT_INFERENCES = _optional_positive_int("MAX_CONCURRENT_INFERENCES")

PoolPlan = collections.namedtuple("PoolPlan", "workers threads reserved cpus memory_bytes")


def _log_safe_traceback(context, error):
    """Log diagnostic frames without reflecting request text or exception data."""
    print(f"[hanlp] {context}: {type(error).__name__}", file=sys.stderr)
    traceback.print_tb(error.__traceback__, file=sys.stderr)


def _read_text(path):
    try:
        with open(path, encoding="ascii") as handle:
            return handle.read().strip()
    except (OSError, UnicodeDecodeError):
        return None


def _affinity_cpus():
    try:
        return len(os.sched_getaffinity(0))
    except (AttributeError, OSError):
        return None


def cgroup_cpu_limit(root=CGROUP_ROOT):
    """Whole CPUs the container's quota allows, or None when it has no quota."""
    quota = period = None
    unified = _read_text(os.path.join(root, "cpu.max"))
    if unified is not None:
        fields = unified.split()
        if len(fields) == 2:
            quota, period = fields
    else:
        for controller in ("cpu", "cpu,cpuacct"):
            legacy_quota = _read_text(os.path.join(root, controller, "cpu.cfs_quota_us"))
            legacy_period = _read_text(os.path.join(root, controller, "cpu.cfs_period_us"))
            if legacy_quota is not None and legacy_period is not None:
                quota, period = legacy_quota, legacy_period
                break
    try:
        quota, period = int(quota), int(period)
    except (TypeError, ValueError):
        return None  # cgroup v2 writes "max"
    if quota <= 0 or period <= 0:
        return None  # cgroup v1 writes -1
    # Rounded down: a fractional CPU cannot carry a worker's thread.
    cpus = max(1, quota // period)
    affinity = _affinity_cpus()
    return min(cpus, affinity) if affinity else cpus


def cgroup_memory_limit(root=CGROUP_ROOT):
    """The container's memory limit in bytes, or None when it has none."""
    raw = _read_text(os.path.join(root, "memory.max"))
    if raw is None:
        raw = _read_text(os.path.join(root, "memory", "memory.limit_in_bytes"))
    try:
        limit = int(raw)
    except (TypeError, ValueError):
        return None
    if limit <= 0 or limit >= _UNLIMITED_MEMORY_BYTES:
        return None
    return limit


def plan_pool(cpus, memory_bytes, cap=None):
    """Size the pool from the container's limits.

    Without both limits there is nothing safe to divide, so the service keeps
    its original shape: one worker with whatever thread settings it inherited.
    """
    if cpus is None or memory_bytes is None:
        workers = 1
    else:
        by_memory = (memory_bytes - FRONT_MEMORY_BYTES) // WORKER_MEMORY_BYTES
        workers = max(1, min(cpus, by_memory))
    if cap is not None:
        workers = max(1, min(workers, cap))
    threads = max(1, cpus // workers) if cpus is not None else None
    reserved = INTERACTIVE_RESERVED_WORKERS if workers > INTERACTIVE_RESERVED_WORKERS else 0
    return PoolPlan(workers, threads, reserved, cpus, memory_bytes)


# ---------------------------------------------------------------------------
# Worker process
# ---------------------------------------------------------------------------


def _warm_up(tokenizer):
    tokens = tokenizer([WARMUP_TEXT])
    has_token = isinstance(tokens, list) and any(
        isinstance(sentence, list)
        and any(isinstance(token, str) and token.strip() for token in sentence)
        for sentence in tokens
    )
    if not has_token:
        raise RuntimeError("tokenizer warm-up returned no tokens")


def _load_tokenizer(model_name):
    import hanlp  # imported in the worker only; the HTTP front never loads PyTorch

    candidate = hanlp.load(getattr(hanlp.pretrained.tok, model_name))
    # Loading weights alone does not exercise the transformers forward API.
    # Warm up before publishing readiness so an incompatible dependency fails
    # closed instead of making every request return 500.
    _warm_up(candidate)
    return candidate


def _limit_threads(threads):
    if threads is None:
        return
    # Set before HanLP imports PyTorch, which reads them once at start-up.
    for name in THREAD_ENV_NAMES:
        os.environ[name] = str(threads)
    try:
        import torch
    except ImportError:
        return
    torch.set_num_threads(threads)


def _plain(value):
    # Only builtins cross back to the front, so unpickling there never needs
    # HanLP's own classes -- or PyTorch behind them.
    if isinstance(value, str):
        return str(value)
    if isinstance(value, (list, tuple)):
        return [_plain(item) for item in value]
    return value


def _worker_main(connection, model_name, threads):
    # A fresh interpreter (spawn): nothing from the front's threads is inherited.
    # Ctrl-C is the front's to handle; it stops the workers itself.
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    _limit_threads(threads)
    try:
        tokenizer = _load_tokenizer(model_name)
    except Exception as error:  # noqa: BLE001 - surfaced through /health
        _log_safe_traceback("model load or warm-up failed", error)
        connection.send(("failed", f"{type(error).__name__}: model warm-up failed"))
        return
    connection.send(("ready", os.getpid()))
    while True:
        try:
            inputs = connection.recv()
        except (EOFError, OSError):
            return  # the front is gone
        try:
            # HanLP's native tokenizer API is batch-shaped, so a batch of N is
            # one forward pass rather than N of them.
            reply = ("ok", _plain(tokenizer(inputs)))
        except Exception as error:  # noqa: BLE001
            _log_safe_traceback("tokenizer inference failed", error)
            reply = ("error", None)
        connection.send(reply)


class WorkerFailed(Exception):
    """A worker could not load its model, or could not answer a request."""


class ProcessWorker:
    """The front's handle on one worker process and its private pipe."""

    def __init__(self, index, threads, context):
        self.index = index
        self.pid = None
        self.broken = False
        self._connection, child = context.Pipe()
        self._process = context.Process(
            target=_worker_main,
            args=(child, MODEL_NAME, threads),
            name=f"hanlp-worker-{index}",
            daemon=True,
        )
        self._process.start()
        child.close()

    def wait_ready(self):
        try:
            status, detail = self._connection.recv()
        except (EOFError, OSError):
            self.close()
            raise WorkerFailed("WorkerExited: model warm-up failed") from None
        if status != "ready":
            self.close()
            raise WorkerFailed(detail)
        self.pid = detail

    def alive(self):
        return not self.broken and self._process.is_alive()

    def run(self, inputs):
        try:
            self._connection.send(inputs)
            status, tokens = self._connection.recv()
        except (EOFError, OSError):
            # Died mid-pass (segfault, OOM kill). The pool replaces it.
            self.broken = True
            raise WorkerFailed("worker exited during inference") from None
        if status != "ok":
            raise WorkerFailed("tokenizer inference failed")
        return tokens

    def close(self):
        self.broken = True
        try:
            self._connection.close()
        except OSError:
            pass
        if self._process.is_alive():
            self._process.terminate()
        self._process.join(timeout=5)
        if self._process.is_alive():
            self._process.kill()
            self._process.join(timeout=5)


# ---------------------------------------------------------------------------
# Admission
# ---------------------------------------------------------------------------

# What acquire() returns for a request whose caller hung up while it queued.
ABANDONED = object()


class _Ticket:
    __slots__ = ("lane", "abandoned", "worker", "state")

    def __init__(self, lane, abandoned):
        self.lane = lane
        self.abandoned = abandoned
        self.worker = None
        self.state = "waiting"


class InferencePool:
    """Admit requests to workers: interactive first, bulk never on the reserve.

    `spawn(index)` returns a started worker; `start()` waits for every one to
    warm up before the pool reports ready. A worker that dies is replaced in
    the background while the rest keep serving. If a replacement cannot load
    its model the pool reports failed, /health turns 503, and liveness restarts
    the pod from a clean state.
    """

    def __init__(self, plan, spawn):
        self.plan = plan
        self._spawn = spawn
        self._cond = threading.Condition()
        self._workers = {}
        self._idle = collections.deque()
        self._queues = {INTERACTIVE: collections.deque(), BULK: collections.deque()}
        self._live = 0
        self._bulk_running = 0
        self._ready = False
        self._error = None
        self._closed = False
        self._skipped = 0
        self._replaced = 0

    @property
    def ready(self):
        return self._ready and self._error is None

    @property
    def error(self):
        return self._error

    def describe(self):
        with self._cond:
            return {
                "workers": self.plan.workers,
                "liveWorkers": self._live,
                "threadsPerWorker": self.plan.threads,
                "reservedForInteractive": self.plan.reserved,
                "queued": {lane: len(queue) for lane, queue in self._queues.items()},
                "skippedDisconnected": self._skipped,
                "replacedWorkers": self._replaced,
            }

    def start(self):
        workers = []
        try:
            for index in range(self.plan.workers):
                workers.append(self._spawn(index))
            # The processes load concurrently; waiting in order costs nothing.
            for worker in workers:
                worker.wait_ready()
        except Exception as error:  # noqa: BLE001 - surfaced through /health
            self._fail(error)
            for worker in workers:
                worker.close()
            return
        with self._cond:
            if self._closed:
                for worker in workers:
                    worker.close()
                return
            for worker in workers:
                self._workers[worker.index] = worker
                self._idle.append(worker)
            self._live = len(workers)
            self._ready = True
            self._dispatch()

    def acquire(self, lane, timeout, abandoned=None):
        """A ticket holding a worker; None on timeout; ABANDONED if the caller left."""
        ticket = _Ticket(lane, abandoned)
        deadline = time.monotonic() + timeout
        with self._cond:
            # A failed pool is on its way to a restart and admits nothing, in
            # step with /health; its waiters below give up for the same reason.
            if self._error is not None or self._closed:
                return None
            self._queues[lane].append(ticket)
            self._dispatch()
            while ticket.state == "waiting":
                remaining = deadline - time.monotonic()
                if remaining <= 0 or self._error is not None or self._closed:
                    self._queues[lane].remove(ticket)
                    return None
                self._cond.wait(remaining)
        return ABANDONED if ticket.state == "abandoned" else ticket

    def release(self, ticket):
        worker = ticket.worker
        with self._cond:
            if ticket.lane == BULK:
                self._bulk_running -= 1
            if worker.alive() and not self._closed:
                self._idle.append(worker)
            else:
                self._retire(worker)
            self._dispatch()

    def close(self):
        with self._cond:
            self._closed = True
            workers = list(self._workers.values())
            self._workers.clear()
            self._idle.clear()
            self._cond.notify_all()
        for worker in workers:
            worker.close()

    def _bulk_limit(self):
        # With the reserve held back there must still be room for bulk work,
        # or a pool shrunk by a dying worker would starve writers outright.
        if self._live == 0:
            return 0
        return max(1, self._live - self.plan.reserved)

    def _next_ticket(self):
        if self._queues[INTERACTIVE]:
            return self._queues[INTERACTIVE].popleft()
        if self._queues[BULK] and self._bulk_running < self._bulk_limit():
            return self._queues[BULK].popleft()
        return None

    def _dispatch(self):
        # Called with the lock held.
        while True:
            while self._idle and not self._idle[0].alive():
                self._retire(self._idle.popleft())
            if not self._idle:
                return
            ticket = self._next_ticket()
            if ticket is None:
                return
            # A forward pass for a caller who already hung up is pure waste, and
            # under load it is the waste that keeps everyone behind it waiting.
            if ticket.abandoned is not None and ticket.abandoned():
                ticket.state = "abandoned"
                self._skipped += 1
                self._cond.notify_all()
                continue
            ticket.worker = self._idle.popleft()
            ticket.state = "assigned"
            if ticket.lane == BULK:
                self._bulk_running += 1
            self._cond.notify_all()

    def _retire(self, worker):
        # Called with the lock held.
        self._live -= 1
        self._workers.pop(worker.index, None)
        if self._closed:
            worker.close()
            return
        print(f"[hanlp] worker {worker.index} exited; replacing it", file=sys.stderr)
        threading.Thread(
            target=self._replace, args=(worker,), name=f"hanlp-replace-{worker.index}", daemon=True
        ).start()

    def _replace(self, old):
        old.close()
        try:
            worker = self._spawn(old.index)
            worker.wait_ready()
        except Exception as error:  # noqa: BLE001 - surfaced through /health
            self._fail(error)
            return
        with self._cond:
            if self._closed:
                worker.close()
                return
            self._workers[worker.index] = worker
            self._idle.append(worker)
            self._live += 1
            self._replaced += 1
            self._dispatch()

    def _fail(self, error):
        if isinstance(error, WorkerFailed):
            message = str(error)
        else:
            _log_safe_traceback("worker start failed", error)
            message = f"{type(error).__name__}: model warm-up failed"
        with self._cond:
            if self._error is None:
                self._error = message
            self._cond.notify_all()


def _client_gone(connection):
    """True once the caller has closed its socket and is waiting for nothing."""
    try:
        poller = select.poll()
        poller.register(connection, select.POLLIN)
        if not poller.poll(0):
            return False
        # Readable with nothing to read is end-of-stream. Bytes waiting here
        # would be a pipelined request, which means the caller is still there.
        return connection.recv(1, socket.MSG_PEEK) == b""
    except OSError:
        return True


# ---------------------------------------------------------------------------
# HTTP front
# ---------------------------------------------------------------------------

_pool = None


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("content-type", "application/json; charset=utf-8")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            # The caller gave up while its request ran; nobody is left to read this.
            self.close_connection = True

    def do_GET(self):  # noqa: N802 - BaseHTTPRequestHandler API
        if self.path.startswith("/health"):
            pool = _pool
            if pool is not None and pool.ready:
                self._send(200, {"status": "ready", "model": MODEL_NAME, "pool": pool.describe()})
            elif pool is not None and pool.error is not None:
                self._send(503, {"status": "failed", "error": pool.error})
            else:
                self._send(503, {"status": "loading", "model": MODEL_NAME})
            return
        self._send(404, {"error": "not found"})

    def do_POST(self):  # noqa: N802 - BaseHTTPRequestHandler API
        if not self.path.startswith("/tokenize"):
            self._send(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("content-length") or 0)
        except ValueError:
            self._send(400, {"error": "invalid content-length"})
            return
        if length < 0 or length > MAX_BODY_BYTES:
            self.close_connection = True
            self._send(413, {"error": f"request body exceeds {MAX_BODY_BYTES} bytes"})
            return
        try:
            request = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            self._send(400, {"error": "invalid JSON body"})
            return

        pool = _pool
        if pool is None or not pool.ready:
            self._send(503, {"error": (pool.error if pool else None) or "model is still loading"})
            return

        batch = self.path.rstrip("/").endswith("/batch")
        if batch:
            texts = request.get("texts")
            if not isinstance(texts, list) or not all(isinstance(item, str) for item in texts):
                self._send(400, {"error": "texts must be an array of strings"})
                return
            if len(texts) > MAX_BATCH_TEXTS:
                self._send(400, {"error": f"texts exceeds {MAX_BATCH_TEXTS} items"})
                return
            if not texts:
                self._send(200, {"batch": []})
                return
            # Same per-text bound as the single path: one oversized document
            # must not stall a shared worker for every other caller.
            inputs = [item[:20_000] for item in texts]
        else:
            text = request.get("text") or ""
            if not isinstance(text, str):
                self._send(400, {"error": "text must be a string"})
                return
            inputs = [text[:20_000]]

        # Unlabelled requests are bulk: every client that predates the lane is a
        # writer, and writers must not be able to claim the interactive reserve.
        priority = (self.headers.get(PRIORITY_HEADER) or "").strip().lower()
        lane = INTERACTIVE if priority == INTERACTIVE else BULK
        connection = getattr(self, "connection", None)
        ticket = pool.acquire(
            lane,
            INFERENCE_QUEUE_TIMEOUT_SECONDS,
            abandoned=(lambda: _client_gone(connection)) if connection is not None else None,
        )
        if ticket is ABANDONED:
            self.close_connection = True
            return
        if ticket is None:
            if pool.error is not None:
                self._send(503, {"error": pool.error})
            else:
                self._send(429, {"error": "tokenizer is busy"})
            return
        try:
            tokens = ticket.worker.run(inputs)
        except WorkerFailed:
            # The worker logged the frames; the request text never leaves it.
            self._send(500, {"error": "tokenizer inference failed"})
            return
        finally:
            pool.release(ticket)

        # Normalize to the list-of-sentences shape the Node client expects.
        if tokens and isinstance(tokens[0], str):
            tokens = [tokens]
        if not batch:
            self._send(200, tokens)
            return
        # One token list per input, positionally. A short result would silently
        # misalign tokens with records, so it is refused rather than padded.
        if not isinstance(tokens, list) or len(tokens) != len(inputs):
            self._send(500, {"error": "tokenizer returned a misaligned batch"})
            return
        self._send(200, {"batch": tokens})

    def log_message(self, *_args):
        # Default handler logs every request to stderr; too noisy for an
        # always-on tokenizer behind a projector.
        return


def _stop(_signum, _frame):
    # Python as PID 1 ignores SIGTERM unless it installs a handler, which would
    # leave every pod termination waiting out its grace period.
    raise SystemExit(0)


def main():
    global _pool
    plan = plan_pool(cgroup_cpu_limit(), cgroup_memory_limit(), MAX_CONCURRENT_INFERENCES)
    # spawn, not fork: the front runs threads, and forking a threaded process
    # can copy a lock some other thread holds.
    context = multiprocessing.get_context("spawn")
    _pool = InferencePool(plan, lambda index: ProcessWorker(index, plan.threads, context))
    print(
        f"[hanlp] {plan.workers} worker(s) x {plan.threads or 'inherited'} thread(s), "
        f"{plan.reserved} reserved for interactive requests "
        f"(cpu quota: {plan.cpus}, memory limit: {plan.memory_bytes})",
        file=sys.stderr,
    )
    signal.signal(signal.SIGTERM, _stop)
    threading.Thread(target=_pool.start, name="hanlp-pool-start", daemon=True).start()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    try:
        server.serve_forever()
    finally:
        _pool.close()


if __name__ == "__main__":
    main()
