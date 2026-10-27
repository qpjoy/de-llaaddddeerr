"""deploy/hanlp/server.py against a stub tokenizer.

Run directly (`python3 -I -B tests/hanlp_server_test.py`) or through
tests/hanlp-server.test.mjs, which is how `npm test` reaches it. Nothing here
needs HanLP, PyTorch or a network: the in-process cases drive the pool and the
HTTP handler with fake workers, and the end-to-end cases start the real server
with a stub `hanlp` module, so worker processes, pipes and sockets are real.
"""

import contextlib
import importlib.util
import io
import json
import os
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest import mock

sys.dont_write_bytecode = True
DEPLOY_DIR = Path(__file__).resolve().parent.parent / "deploy" / "hanlp"
GIB = 1024 ** 3


def load_server():
    spec = importlib.util.spec_from_file_location(
        "mx_common_hanlp_server", DEPLOY_DIR / "server.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


server = load_server()
INTERACTIVE, BULK = server.INTERACTIVE, server.BULK


def wait_until(predicate, timeout=5.0, interval=0.01):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return predicate()


def memory_for(workers):
    return server.FRONT_MEMORY_BYTES + workers * server.WORKER_MEMORY_BYTES


def split_tokens(texts):
    return [text.split() for text in texts]


class FakeWorker:
    """A worker process stand-in that tokenizes in the caller's thread."""

    def __init__(self, index, tokenizer=split_tokens, ready_error=None, ready_gate=None):
        self.index = index
        self.tokenizer = tokenizer
        self.ready_error = ready_error
        self.ready_gate = ready_gate
        self.dead = False
        self.closed = False
        self.calls = []

    def wait_ready(self):
        if self.ready_gate is not None:
            self.ready_gate.wait(5)
        if self.ready_error:
            raise server.WorkerFailed(self.ready_error)

    def alive(self):
        return not self.dead and not self.closed

    def run(self, inputs):
        self.calls.append(list(inputs))
        try:
            return self.tokenizer(inputs)
        except Exception:  # noqa: BLE001 - mirrors ProcessWorker
            raise server.WorkerFailed("tokenizer inference failed") from None

    def close(self):
        self.closed = True


def make_pool(workers, tokenizer=split_tokens, start=True):
    spawned = []

    def spawn(index):
        worker = FakeWorker(index, tokenizer)
        spawned.append(worker)
        return worker

    pool = server.InferencePool(server.plan_pool(workers, memory_for(workers)), spawn)
    if start:
        pool.start()
    return pool, spawned


# ---------------------------------------------------------------------------
# Pool sizing
# ---------------------------------------------------------------------------


class PoolSizingTest(unittest.TestCase):
    def test_an_uncapped_16_cpu_8gi_pod_gets_five_workers_of_three_threads(self):
        plan = server.plan_pool(16, 8 * GIB)
        self.assertEqual((plan.workers, plan.threads, plan.reserved), (5, 3, 1))

    def test_memory_bounds_the_pool_and_never_rounds_up(self):
        self.assertEqual(server.plan_pool(16, memory_for(3) - 1).workers, 2)
        self.assertEqual(server.plan_pool(16, memory_for(3)).workers, 3)

    def test_the_cpu_quota_bounds_the_pool_and_threads_split_evenly(self):
        plan = server.plan_pool(2, 64 * GIB)
        self.assertEqual((plan.workers, plan.threads, plan.reserved), (2, 1, 1))
        self.assertEqual(server.plan_pool(16, memory_for(3)).threads, 5)

    def test_unknown_limits_keep_the_single_slot_service(self):
        for cpus, memory in ((None, 8 * GIB), (16, None), (None, None)):
            plan = server.plan_pool(cpus, memory)
            self.assertEqual((plan.workers, plan.reserved), (1, 0))
        # Nothing to divide: thread settings stay whatever the process inherited.
        self.assertIsNone(server.plan_pool(None, None).threads)
        self.assertEqual(server.plan_pool(16, None).threads, 16)

    def test_a_container_too_small_for_one_budget_still_gets_one_worker(self):
        plan = server.plan_pool(1, 256 * 1024 * 1024)
        self.assertEqual((plan.workers, plan.threads, plan.reserved), (1, 1, 0))

    def test_the_legacy_setting_only_ever_caps_the_pool(self):
        self.assertEqual(server.plan_pool(16, 8 * GIB, cap=1)[:3], (1, 16, 0))
        self.assertEqual(server.plan_pool(16, 8 * GIB, cap=2)[:3], (2, 8, 1))
        self.assertEqual(server.plan_pool(16, 8 * GIB, cap=64).workers, 5)

    def test_a_five_worker_cap_keeps_extra_memory_as_headroom(self):
        self.assertEqual(server.plan_pool(16, 32 * GIB).workers, 16)
        self.assertEqual(server.plan_pool(16, 32 * GIB, cap=5)[:3], (5, 3, 1))

    def test_the_legacy_setting_is_optional(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertIsNone(server._optional_positive_int("MAX_CONCURRENT_INFERENCES"))
        with mock.patch.dict(os.environ, {"MAX_CONCURRENT_INFERENCES": " 3 "}):
            self.assertEqual(server._optional_positive_int("MAX_CONCURRENT_INFERENCES"), 3)
        with mock.patch.dict(os.environ, {"MAX_CONCURRENT_INFERENCES": "0"}):
            self.assertEqual(server._optional_positive_int("MAX_CONCURRENT_INFERENCES"), 1)


class CgroupLimitTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = directory.name
        patcher = mock.patch.object(server, "_affinity_cpus", lambda: None)
        patcher.start()
        self.addCleanup(patcher.stop)

    def write(self, relative, content):
        path = Path(self.root, relative)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content + "\n")

    def limits(self):
        return server.cgroup_cpu_limit(self.root), server.cgroup_memory_limit(self.root)

    def test_cgroup_v2_limits(self):
        self.write("cpu.max", "1600000 100000")
        self.write("memory.max", "8589934592")
        self.assertEqual(self.limits(), (16, 8 * GIB))

    def test_cgroup_v2_without_limits(self):
        self.write("cpu.max", "max 100000")
        self.write("memory.max", "max")
        self.assertEqual(self.limits(), (None, None))

    def test_a_fractional_quota_rounds_down_but_never_to_zero(self):
        self.write("cpu.max", "250000 100000")
        self.assertEqual(server.cgroup_cpu_limit(self.root), 2)
        self.write("cpu.max", "50000 100000")
        self.assertEqual(server.cgroup_cpu_limit(self.root), 1)

    def test_cgroup_v1_limits(self):
        self.write("cpu,cpuacct/cpu.cfs_quota_us", "400000")
        self.write("cpu,cpuacct/cpu.cfs_period_us", "100000")
        self.write("memory/memory.limit_in_bytes", str(2 * GIB))
        self.assertEqual(self.limits(), (4, 2 * GIB))

    def test_cgroup_v1_without_limits(self):
        self.write("cpu/cpu.cfs_quota_us", "-1")
        self.write("cpu/cpu.cfs_period_us", "100000")
        self.write("memory/memory.limit_in_bytes", "9223372036854771712")
        self.assertEqual(self.limits(), (None, None))

    def test_no_cgroup_at_all(self):
        self.assertEqual(self.limits(), (None, None))

    def test_a_cpuset_narrower_than_the_quota_wins(self):
        self.write("cpu.max", "1600000 100000")
        with mock.patch.object(server, "_affinity_cpus", lambda: 4):
            self.assertEqual(server.cgroup_cpu_limit(self.root), 4)


# ---------------------------------------------------------------------------
# Admission
# ---------------------------------------------------------------------------


class AdmissionTest(unittest.TestCase):
    def test_initial_models_load_one_at_a_time_and_all_warm_before_ready(self):
        gates = [threading.Event() for _ in range(3)]
        started = [threading.Event() for _ in range(3)]

        def spawn(index):
            started[index].set()
            return FakeWorker(index, ready_gate=gates[index])

        pool = server.InferencePool(
            server.plan_pool(3, memory_for(3)),
            spawn,
        )
        starter = threading.Thread(target=pool.start)
        self.addCleanup(starter.join, 5)
        for gate in gates:
            self.addCleanup(gate.set)
        self.addCleanup(pool.close)
        starter.start()
        self.assertTrue(started[0].wait(1))
        self.assertFalse(started[1].wait(0.05))
        self.assertFalse(pool.ready)
        gates[0].set()
        self.assertTrue(started[1].wait(1))
        self.assertFalse(started[2].wait(0.05))
        self.assertFalse(pool.ready)
        gates[1].set()
        self.assertTrue(started[2].wait(1))
        self.assertFalse(pool.ready)
        gates[2].set()
        starter.join(5)
        self.assertFalse(starter.is_alive())
        self.assertTrue(pool.ready)
        self.assertEqual(pool.describe()["liveWorkers"], 3)

    def test_one_worker_failing_to_load_fails_the_pool_and_stops_the_rest(self):
        spawned = []

        def spawn(index):
            error = "RuntimeError: model warm-up failed" if index == 1 else None
            spawned.append(FakeWorker(index, ready_error=error))
            return spawned[-1]

        pool = server.InferencePool(server.plan_pool(3, memory_for(3)), spawn)
        pool.start()
        self.assertFalse(pool.ready)
        self.assertEqual(pool.error, "RuntimeError: model warm-up failed")
        self.assertTrue(all(worker.closed for worker in spawned))
        self.assertEqual([worker.index for worker in spawned], [0, 1])

    def test_close_during_initial_loading_stops_it_without_spawning_more(self):
        gate = threading.Event()
        started = threading.Event()
        spawned = []

        class LoadingWorker(FakeWorker):
            def close(self):
                super().close()
                gate.set()  # terminating a real child also wakes wait_ready

        def spawn(index):
            spawned.append(LoadingWorker(index, ready_gate=gate))
            started.set()
            return spawned[-1]

        pool = server.InferencePool(server.plan_pool(3, memory_for(3)), spawn)
        starter = threading.Thread(target=pool.start)
        self.addCleanup(starter.join, 5)
        self.addCleanup(gate.set)
        self.addCleanup(pool.close)
        starter.start()
        self.assertTrue(started.wait(1))
        pool.close()
        starter.join(5)
        self.assertFalse(starter.is_alive())
        self.assertEqual(len(spawned), 1)
        self.assertTrue(spawned[0].closed)
        self.assertFalse(pool.ready)

    def test_extra_memory_keeps_five_slots_and_the_interactive_reserve(self):
        pool = server.InferencePool(server.plan_pool(16, 32 * GIB, cap=5), FakeWorker)
        self.addCleanup(pool.close)
        pool.start()
        writers = [pool.acquire(BULK, 0.05) for _ in range(4)]
        self.assertTrue(all(isinstance(ticket, server._Ticket) for ticket in writers))
        self.assertIsNone(pool.acquire(BULK, 0.05))
        query = pool.acquire(INTERACTIVE, 0.05)
        self.assertIsInstance(query, server._Ticket)
        tickets = [*writers, query]
        self.assertEqual(len({ticket.worker.index for ticket in tickets}), 5)
        self.assertEqual(pool.describe()["threadsPerWorker"], 3)
        self.assertEqual(pool.describe()["reservedForInteractive"], 1)
        for ticket in tickets:
            pool.release(ticket)

    def test_interactive_is_admitted_before_bulk_that_queued_first(self):
        pool, _ = make_pool(1)
        held = pool.acquire(BULK, 1)
        order = []

        def request(lane):
            ticket = pool.acquire(lane, 5)
            order.append(lane)
            pool.release(ticket)

        bulk = threading.Thread(target=request, args=(BULK,))
        bulk.start()
        self.assertTrue(wait_until(lambda: pool.describe()["queued"][BULK] == 1))
        query = threading.Thread(target=request, args=(INTERACTIVE,))
        query.start()
        self.assertTrue(wait_until(lambda: pool.describe()["queued"][INTERACTIVE] == 1))
        pool.release(held)
        bulk.join(5)
        query.join(5)
        self.assertEqual(order, [INTERACTIVE, BULK])

    def test_bulk_never_takes_the_reserved_worker(self):
        pool, _ = make_pool(3)
        writers = [pool.acquire(BULK, 1), pool.acquire(BULK, 1)]
        self.assertTrue(all(isinstance(ticket, server._Ticket) for ticket in writers))
        # One worker is idle, and a third writer still may not have it.
        self.assertIsNone(pool.acquire(BULK, 0.05))
        query = pool.acquire(INTERACTIVE, 0.05)
        self.assertIsInstance(query, server._Ticket)
        for ticket in (*writers, query):
            pool.release(ticket)

    def test_interactive_may_use_every_worker(self):
        pool, _ = make_pool(3)
        queries = [pool.acquire(INTERACTIVE, 0.05) for _ in range(3)]
        self.assertTrue(all(isinstance(ticket, server._Ticket) for ticket in queries))
        self.assertIsNone(pool.acquire(INTERACTIVE, 0.05))
        for ticket in queries:
            pool.release(ticket)

    def test_a_single_worker_pool_still_serves_bulk(self):
        pool, _ = make_pool(1)
        self.assertEqual(pool.plan.reserved, 0)
        self.assertIsInstance(pool.acquire(BULK, 0.05), server._Ticket)

    def test_a_queued_request_times_out_and_leaves_the_queue(self):
        pool, _ = make_pool(1)
        held = pool.acquire(BULK, 1)
        self.assertIsNone(pool.acquire(BULK, 0.05))
        self.assertIsNone(pool.acquire(INTERACTIVE, 0.05))
        self.assertEqual(pool.describe()["queued"], {INTERACTIVE: 0, BULK: 0})
        pool.release(held)

    def test_a_caller_who_hung_up_while_queued_is_skipped_without_inference(self):
        pool, workers = make_pool(1)
        held = pool.acquire(BULK, 1)
        gone = threading.Event()
        outcome = {}

        def queued():
            outcome["ticket"] = pool.acquire(BULK, 5, abandoned=gone.is_set)

        waiter = threading.Thread(target=queued)
        waiter.start()
        self.assertTrue(wait_until(lambda: pool.describe()["queued"][BULK] == 1))
        gone.set()
        pool.release(held)
        waiter.join(5)
        self.assertIs(outcome["ticket"], server.ABANDONED)
        self.assertEqual(pool.describe()["skippedDisconnected"], 1)
        self.assertEqual(workers[0].calls, [])
        # The worker it would have used is free for the next caller.
        self.assertIsInstance(pool.acquire(BULK, 0.05), server._Ticket)

    def test_a_worker_that_died_holding_a_request_is_replaced(self):
        pool, spawned = make_pool(2)
        ticket = pool.acquire(INTERACTIVE, 1)
        ticket.worker.dead = True
        log = io.StringIO()
        with contextlib.redirect_stderr(log):
            pool.release(ticket)
            self.assertTrue(wait_until(lambda: pool.describe()["replacedWorkers"] == 1))
        self.assertTrue(pool.ready)
        self.assertEqual(pool.describe()["liveWorkers"], 2)
        self.assertEqual([worker.index for worker in spawned], [0, 1, ticket.worker.index])
        self.assertTrue(ticket.worker.closed)
        self.assertIn("replacing it", log.getvalue())

    def test_an_idle_worker_that_died_is_never_handed_out(self):
        pool, spawned = make_pool(2)
        spawned[0].dead = True
        with contextlib.redirect_stderr(io.StringIO()):
            ticket = pool.acquire(INTERACTIVE, 1)
            self.assertIs(ticket.worker, spawned[1])
            pool.release(ticket)
            self.assertTrue(wait_until(lambda: pool.describe()["liveWorkers"] == 2))

    def test_a_pool_shrunk_by_a_dead_worker_still_admits_bulk(self):
        hold_replacement = threading.Event()
        self.addCleanup(hold_replacement.set)
        spawned = []

        def spawn(index):
            gate = hold_replacement if len(spawned) >= 2 else None
            spawned.append(FakeWorker(index, ready_gate=gate))
            return spawned[-1]

        pool = server.InferencePool(server.plan_pool(2, memory_for(2)), spawn)
        pool.start()
        spawned[0].dead = True
        with contextlib.redirect_stderr(io.StringIO()):
            ticket = pool.acquire(BULK, 1)
        # One live worker and a reserve of one would leave writers nothing.
        self.assertIsInstance(ticket, server._Ticket)
        self.assertEqual(pool.describe()["liveWorkers"], 1)
        pool.release(ticket)

    def test_a_replacement_that_cannot_load_fails_the_pool(self):
        spawned = []

        def spawn(index):
            error = "RuntimeError: model warm-up failed" if len(spawned) >= 2 else None
            spawned.append(FakeWorker(index, ready_error=error))
            return spawned[-1]

        pool = server.InferencePool(server.plan_pool(2, memory_for(2)), spawn)
        pool.start()
        ticket = pool.acquire(BULK, 1)
        ticket.worker.dead = True
        with contextlib.redirect_stderr(io.StringIO()):
            pool.release(ticket)
            self.assertTrue(wait_until(lambda: pool.error is not None))
        self.assertFalse(pool.ready)
        self.assertEqual(pool.error, "RuntimeError: model warm-up failed")
        self.assertTrue(spawned[-1].closed)
        # Waiters give up at once rather than sitting out their timeout.
        started = time.monotonic()
        self.assertIsNone(pool.acquire(BULK, 5))
        self.assertLess(time.monotonic() - started, 1)

    def test_replacements_load_serially_while_a_surviving_worker_serves(self):
        gates = [threading.Event(), threading.Event()]
        started = [threading.Event(), threading.Event()]
        spawned = []

        def spawn(index):
            replacement = len(spawned) - 3
            gate = gates[replacement] if replacement >= 0 else None
            worker = FakeWorker(index, ready_gate=gate)
            spawned.append(worker)
            if replacement >= 0:
                started[replacement].set()
            return worker

        pool = server.InferencePool(server.plan_pool(3, memory_for(3)), spawn)
        for gate in gates:
            self.addCleanup(gate.set)
        self.addCleanup(pool.close)
        pool.start()
        tickets = [pool.acquire(INTERACTIVE, 0.05) for _ in range(2)]
        with contextlib.redirect_stderr(io.StringIO()):
            for ticket in tickets:
                ticket.worker.dead = True
                pool.release(ticket)
        self.assertTrue(started[0].wait(1))
        self.assertFalse(started[1].wait(0.05))
        self.assertTrue(pool.ready)
        survivor = pool.acquire(INTERACTIVE, 0.1)
        self.assertIsInstance(survivor, server._Ticket)
        self.assertEqual(survivor.worker.run(["still serving"]), [["still", "serving"]])
        pool.release(survivor)
        self.assertFalse(gates[0].is_set())
        gates[0].set()
        self.assertTrue(started[1].wait(1))
        self.assertTrue(wait_until(lambda: pool.describe()["liveWorkers"] == 2))
        gates[1].set()
        self.assertTrue(wait_until(lambda: pool.describe()["replacedWorkers"] == 2))
        self.assertEqual(pool.describe()["liveWorkers"], 3)

    def test_close_prevents_a_queued_replacement_from_spawning(self):
        gate = threading.Event()
        loading = threading.Event()
        spawned = []

        class LoadingWorker(FakeWorker):
            def close(self):
                super().close()
                gate.set()

        def spawn(index):
            if len(spawned) >= 3:
                worker = LoadingWorker(index, ready_gate=gate)
                loading.set()
            else:
                worker = FakeWorker(index)
            spawned.append(worker)
            return worker

        pool = server.InferencePool(server.plan_pool(3, memory_for(3)), spawn)
        pool.start()
        # Invoke the same replacement entry point in joinable threads so close
        # can be checked after both the active and queued loader have returned.
        old = [pool.acquire(INTERACTIVE, 0.05).worker for _ in range(2)]
        threads = [threading.Thread(target=pool._replace, args=(worker,)) for worker in old]
        for thread in threads:
            self.addCleanup(thread.join, 5)
        self.addCleanup(gate.set)
        self.addCleanup(pool.close)
        for thread in threads:
            thread.start()
        self.assertTrue(loading.wait(1))
        pool.close()
        for thread in threads:
            thread.join(5)
            self.assertFalse(thread.is_alive())
        self.assertEqual(len(spawned), 4)
        self.assertTrue(all(worker.closed for worker in spawned))

    def test_closing_stops_every_worker(self):
        pool, spawned = make_pool(3)
        pool.close()
        self.assertTrue(all(worker.closed for worker in spawned))
        self.assertIsNone(pool.acquire(INTERACTIVE, 1))


class ClientGoneTest(unittest.TestCase):
    def pair(self):
        ours, theirs = socket.socketpair()
        self.addCleanup(ours.close)
        self.addCleanup(theirs.close)
        return ours, theirs

    def test_an_open_connection_is_not_gone(self):
        ours, _theirs = self.pair()
        self.assertFalse(server._client_gone(ours))

    def test_a_closed_connection_is_gone(self):
        ours, theirs = self.pair()
        theirs.close()
        self.assertTrue(server._client_gone(ours))

    def test_pipelined_bytes_are_not_mistaken_for_a_hang_up(self):
        ours, theirs = self.pair()
        theirs.sendall(b"GET")
        self.assertTrue(wait_until(lambda: not server._client_gone(ours)))
        self.assertEqual(ours.recv(3), b"GET")

    def test_a_reset_connection_is_gone(self):
        listener = socket.socket()
        self.addCleanup(listener.close)
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        client = socket.create_connection(listener.getsockname())
        accepted, _ = listener.accept()
        self.addCleanup(accepted.close)
        client.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
        client.close()
        self.assertTrue(wait_until(lambda: server._client_gone(accepted)))


# ---------------------------------------------------------------------------
# HTTP contract, in process
# ---------------------------------------------------------------------------


class HttpContractTest(unittest.TestCase):
    def setUp(self):
        self.use_pool(make_pool(2)[0])

    def use_pool(self, pool):
        patcher = mock.patch.object(server, "_pool", pool)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.pool = pool

    def call(self, method, path, payload=None, raw=None, headers=None, connection=None):
        body = raw if raw is not None else (b"" if payload is None else json.dumps(payload).encode())
        handler = object.__new__(server.Handler)
        handler.path = path
        handler.headers = {"content-length": str(len(body)), **(headers or {})}
        handler.rfile = io.BytesIO(body)
        handler.close_connection = False
        if connection is not None:
            handler.connection = connection
        sent = []
        handler._send = lambda status, response: sent.append((status, response))
        getattr(server.Handler, f"do_{method}")(handler)
        return sent, handler

    def test_health_is_ready_only_with_a_warm_pool(self):
        sent, _ = self.call("GET", "/health")
        status, body = sent[0]
        self.assertEqual((status, body["status"], body["model"]), (200, "ready", server.MODEL_NAME))
        self.assertEqual(body["pool"]["workers"], 2)
        self.use_pool(make_pool(2, start=False)[0])
        self.assertEqual(
            self.call("GET", "/health")[0],
            [(503, {"status": "loading", "model": server.MODEL_NAME})],
        )
        self.use_pool(None)
        self.assertEqual(self.call("GET", "/health")[0][0][1]["status"], "loading")
        failed = server.InferencePool(
            server.plan_pool(1, memory_for(1)),
            lambda index: FakeWorker(index, ready_error="RuntimeError: model warm-up failed"),
        )
        failed.start()
        self.use_pool(failed)
        self.assertEqual(
            self.call("GET", "/health")[0],
            [(503, {"status": "failed", "error": "RuntimeError: model warm-up failed"})],
        )

    def test_unknown_paths_are_404(self):
        self.assertEqual(self.call("GET", "/nope")[0], [(404, {"error": "not found"})])
        self.assertEqual(self.call("POST", "/nope", {})[0], [(404, {"error": "not found"})])

    def test_request_framing_errors_are_unchanged(self):
        sent, _ = self.call("POST", "/tokenize", raw=b"{}", headers={"content-length": "x"})
        self.assertEqual(sent, [(400, {"error": "invalid content-length"})])
        too_large = str(server.MAX_BODY_BYTES + 1)
        sent, handler = self.call("POST", "/tokenize", raw=b"", headers={"content-length": too_large})
        self.assertEqual(sent, [(413, {"error": f"request body exceeds {server.MAX_BODY_BYTES} bytes"})])
        self.assertTrue(handler.close_connection)
        sent, _ = self.call("POST", "/tokenize", raw=b"{not json")
        self.assertEqual(sent, [(400, {"error": "invalid JSON body"})])

    def test_a_pool_that_is_not_ready_answers_503(self):
        self.use_pool(make_pool(1, start=False)[0])
        sent, _ = self.call("POST", "/tokenize", {"text": "吴恩达"})
        self.assertEqual(sent, [(503, {"error": "model is still loading"})])

    def test_a_single_text_returns_a_list_of_sentences(self):
        sent, _ = self.call("POST", "/tokenize", {"text": "吴恩达 与 人工智能", "coarse": True})
        self.assertEqual(sent, [(200, [["吴恩达", "与", "人工智能"]])])
        # A flat answer from the model is wrapped into the same shape.
        self.use_pool(make_pool(1, tokenizer=lambda _texts: ["人工智能"])[0])
        self.assertEqual(self.call("POST", "/tokenize", {"text": "人工智能"})[0], [(200, [["人工智能"]])])
        sent, _ = self.call("POST", "/tokenize", {"text": 3})
        self.assertEqual(sent, [(400, {"error": "text must be a string"})])

    def test_a_batch_returns_one_token_list_per_text(self):
        sent, _ = self.call("POST", "/tokenize/batch", {"texts": ["a b", "c"], "coarse": True})
        self.assertEqual(sent, [(200, {"batch": [["a", "b"], ["c"]]})])
        sent, _ = self.call("POST", "/tokenize/batch/", {"texts": []})
        self.assertEqual(sent, [(200, {"batch": []})])
        sent, _ = self.call("POST", "/tokenize/batch", {"texts": ["a", 1]})
        self.assertEqual(sent, [(400, {"error": "texts must be an array of strings"})])
        sent, _ = self.call("POST", "/tokenize/batch", {"texts": ["a"] * (server.MAX_BATCH_TEXTS + 1)})
        self.assertEqual(sent, [(400, {"error": f"texts exceeds {server.MAX_BATCH_TEXTS} items"})])

    def test_texts_are_bounded_before_inference(self):
        pool, workers = make_pool(1)
        self.use_pool(pool)
        self.call("POST", "/tokenize/batch", {"texts": ["长" * 30_000]})
        self.assertEqual(len(workers[0].calls[0][0]), 20_000)

    def test_a_misaligned_batch_is_refused(self):
        self.use_pool(make_pool(1, tokenizer=lambda texts: [["only-one"]])[0])
        sent, _ = self.call("POST", "/tokenize/batch", {"texts": ["a", "b"]})
        self.assertEqual(sent, [(500, {"error": "tokenizer returned a misaligned batch"})])

    def test_an_inference_failure_is_500_and_frees_the_worker(self):
        def broken(texts):
            raise RuntimeError(f"inference detail contains {texts}")

        pool, _ = make_pool(1, tokenizer=broken)
        self.use_pool(pool)
        sent, _ = self.call("POST", "/tokenize", {"text": "request-content-must-not-enter-logs"})
        self.assertEqual(sent, [(500, {"error": "tokenizer inference failed"})])
        self.assertIsInstance(pool.acquire(BULK, 0.05), server._Ticket)

    def test_a_full_queue_answers_429(self):
        with mock.patch.object(server, "INFERENCE_QUEUE_TIMEOUT_SECONDS", 0.05):
            held = [self.pool.acquire(INTERACTIVE, 1) for _ in range(2)]
            sent, _ = self.call("POST", "/tokenize", {"text": "忙"})
            self.assertEqual(sent, [(429, {"error": "tokenizer is busy"})])
            for ticket in held:
                self.pool.release(ticket)

    def test_the_priority_header_chooses_the_lane_and_old_clients_are_bulk(self):
        lanes = []
        original = self.pool.acquire

        def recording(lane, timeout, abandoned=None):
            lanes.append(lane)
            return original(lane, timeout, abandoned)

        self.pool.acquire = recording
        for value in ("interactive", " Interactive ", "bulk", "urgent", None):
            headers = {} if value is None else {server.PRIORITY_HEADER: value}
            self.call("POST", "/tokenize", {"text": "词"}, headers=headers)
        self.assertEqual(lanes, [INTERACTIVE, INTERACTIVE, BULK, BULK, BULK])

    def test_only_a_labelled_query_reaches_the_reserved_worker(self):
        # Two workers: one for bulk, one held back. With bulk's share taken, an
        # unlabelled request waits out its timeout and a labelled one does not.
        with mock.patch.object(server, "INFERENCE_QUEUE_TIMEOUT_SECONDS", 0.05):
            writer = self.pool.acquire(BULK, 1)
            sent, _ = self.call("POST", "/tokenize", {"text": "写入"})
            self.assertEqual(sent, [(429, {"error": "tokenizer is busy"})])
            sent, _ = self.call(
                "POST", "/tokenize", {"text": "查询"}, headers={server.PRIORITY_HEADER: "interactive"}
            )
            self.assertEqual(sent, [(200, [["查询"]])])
            self.pool.release(writer)

    def test_a_request_whose_caller_hung_up_gets_no_inference_and_no_answer(self):
        pool, workers = make_pool(1)
        self.use_pool(pool)
        held = pool.acquire(BULK, 1)
        ours, theirs = socket.socketpair()
        self.addCleanup(ours.close)
        outcome = {}

        def request():
            outcome["sent"], outcome["handler"] = self.call(
                "POST", "/tokenize", {"text": "abandoned"}, connection=ours
            )

        waiter = threading.Thread(target=request)
        waiter.start()
        self.assertTrue(wait_until(lambda: pool.describe()["queued"][BULK] == 1))
        theirs.close()
        pool.release(held)
        waiter.join(5)
        self.assertEqual(outcome["sent"], [])
        self.assertTrue(outcome["handler"].close_connection)
        self.assertEqual(workers[0].calls, [])


# ---------------------------------------------------------------------------
# The worker process body, in process
# ---------------------------------------------------------------------------


class FakeConnection:
    def __init__(self, inbox=()):
        self.inbox = list(inbox)
        self.sent = []

    def recv(self):
        if not self.inbox:
            raise EOFError
        return self.inbox.pop(0)

    def send(self, message):
        self.sent.append(message)


class WorkerBodyTest(unittest.TestCase):
    def setUp(self):
        sigint = signal.getsignal(signal.SIGINT)
        self.addCleanup(signal.signal, signal.SIGINT, sigint)
        patcher = mock.patch.dict(sys.modules)
        patcher.start()
        self.addCleanup(patcher.stop)

    def install(self, tokenizer, on_load=None):
        model_ref = object()

        def load(requested):
            if on_load:
                on_load()
            return tokenizer if requested is model_ref else None

        sys.modules["hanlp"] = types.SimpleNamespace(
            pretrained=types.SimpleNamespace(
                tok=types.SimpleNamespace(COARSE_ELECTRA_SMALL_ZH=model_ref)
            ),
            load=load,
        )

    def run_worker(self, inbox=(), threads=None):
        connection = FakeConnection(inbox)
        log = io.StringIO()
        with contextlib.redirect_stderr(log):
            server._worker_main(connection, "COARSE_ELECTRA_SMALL_ZH", threads)
        return connection.sent, log.getvalue()

    def test_a_worker_warms_up_before_reporting_ready_then_serves(self):
        calls = []

        def tokenizer(texts):
            calls.append(texts)
            if texts == [server.WARMUP_TEXT]:
                return [["吴恩达", "与", "人工智能"]]
            return [("吴恩达", "与", "人工智能")]

        self.install(tokenizer)
        sent, _ = self.run_worker(inbox=[["吴恩达与人工智能。"]])
        self.assertEqual(calls, [[server.WARMUP_TEXT], ["吴恩达与人工智能。"]])
        # Tuples become lists, so only builtins cross back to the front.
        self.assertEqual(sent, [("ready", os.getpid()), ("ok", [["吴恩达", "与", "人工智能"]])])

    def test_an_empty_warm_up_fails_closed(self):
        self.install(lambda _texts: [[]])
        sent, log = self.run_worker()
        self.assertEqual(sent, [("failed", "RuntimeError: model warm-up failed")])
        self.assertIn("RuntimeError", log)

    def test_a_broken_warm_up_never_logs_the_text(self):
        def broken(texts):
            raise RuntimeError(f"inference detail contains {texts}")

        self.install(broken)
        sent, log = self.run_worker()
        self.assertEqual(sent, [("failed", "RuntimeError: model warm-up failed")])
        self.assertIn("RuntimeError", log)
        self.assertNotIn(server.WARMUP_TEXT, log)

    def test_an_inference_failure_is_reported_without_the_request_text(self):
        secret = "request-content-must-not-enter-logs"

        def tokenizer(texts):
            if texts == [secret]:
                raise RuntimeError(f"inference detail contains {texts}")
            return [text.split() for text in texts]

        self.install(tokenizer)
        sent, log = self.run_worker(inbox=[[secret], ["still serving"]])
        self.assertEqual(sent[1:], [("error", None), ("ok", [["still", "serving"]])])
        self.assertIn("RuntimeError", log)
        self.assertNotIn(secret, log)

    def test_thread_limits_are_in_place_before_the_model_loads(self):
        seen = {}
        torch = types.SimpleNamespace(set_num_threads=lambda count: seen.setdefault("torch", count))
        sys.modules["torch"] = torch
        self.install(
            lambda texts: [text.split() or [text] for text in texts],
            on_load=lambda: seen.update({name: os.environ.get(name) for name in server.THREAD_ENV_NAMES}),
        )
        with mock.patch.dict(os.environ):
            self.run_worker(threads=3)
        self.assertEqual(seen, {"OMP_NUM_THREADS": "3", "MKL_NUM_THREADS": "3", "TORCH_NUM_THREADS": "3", "torch": 3})


# ---------------------------------------------------------------------------
# End to end: the real server, real worker processes, a stub model
# ---------------------------------------------------------------------------

STUB_HANLP = '''
import os
import time
import types

LOG = os.environ["STUB_HANLP_LOG"]
THREADS = ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "TORCH_NUM_THREADS")


class Tokenizer:
    def __call__(self, texts):
        out = []
        for text in texts:
            with open(LOG, "a", encoding="utf-8") as handle:
                handle.write(f"{os.getpid()}\\t{text}\\n")
            if text.startswith("sleep:"):
                time.sleep(float(text.split(":", 1)[1]))
                out.append(["slept"])
            elif text == "env":
                out.append([os.environ.get(name, "") for name in THREADS] + [str(os.getpid())])
            elif text == "crash":
                os._exit(3)
            elif text.startswith("raise:"):
                raise RuntimeError(f"inference detail contains {text}")
            else:
                out.append(text.split())
        return out


pretrained = types.SimpleNamespace(tok=types.SimpleNamespace(COARSE_ELECTRA_SMALL_ZH="stub-model"))


def load(identifier):
    assert identifier == "stub-model"
    return Tokenizer()
'''

# The test host has no cgroup limits, so the launcher reports those of a
# 6-CPU pod with room for three workers: 3 workers x 2 threads, 1 reserved.
LAUNCHER = '''
import sys

sys.path.insert(0, sys.argv[1])
import server

if __name__ == "__main__":
    server.HOST = "127.0.0.1"
    server.cgroup_cpu_limit = lambda: 6
    server.cgroup_memory_limit = lambda: server.FRONT_MEMORY_BYTES + 3 * server.WORKER_MEMORY_BYTES
    server.main()
'''

NO_PROXY = urllib.request.build_opener(urllib.request.ProxyHandler({}))


class EndToEndTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        (root / "stub").mkdir()
        (root / "stub" / "hanlp.py").write_text(STUB_HANLP)
        (root / "launch.py").write_text(LAUNCHER)
        self.log = root / "tokenized.log"
        self.log.touch()
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            self.port = probe.getsockname()[1]
        env = {
            name: value
            for name, value in os.environ.items()
            if not name.startswith("PYTHON")
            and name not in ("MAX_CONCURRENT_INFERENCES", *server.THREAD_ENV_NAMES)
        }
        env.update(
            PORT=str(self.port),
            PYTHONPATH=str(root / "stub"),
            PYTHONDONTWRITEBYTECODE="1",
            PYTHONUNBUFFERED="1",
            STUB_HANLP_LOG=str(self.log),
            MAX_BODY_BYTES="1024",
            INFERENCE_QUEUE_TIMEOUT_SECONDS="10",
        )
        self.stderr_path = root / "server.stderr"
        stderr = open(self.stderr_path, "wb")
        self.addCleanup(stderr.close)
        self.process = subprocess.Popen(
            [sys.executable, str(root / "launch.py"), str(DEPLOY_DIR)],
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=stderr,
        )
        self.addCleanup(self.stop)
        ready = wait_until(lambda: self.health()[0] == 200 or self.process.poll() is not None, 30, 0.05)
        if not ready or self.process.poll() is not None:
            self.fail(f"server never became ready:\n{self.stderr_path.read_text()}")

    def stop(self):
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(10)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(5)

    def http(self, method, path, payload=None, headers=None, raw=None, timeout=20):
        data = raw if raw is not None else (None if payload is None else json.dumps(payload).encode())
        request = urllib.request.Request(
            f"http://127.0.0.1:{self.port}{path}",
            data=data,
            method=method,
            headers={"content-type": "application/json", **(headers or {})},
        )
        try:
            with NO_PROXY.open(request, timeout=timeout) as response:
                return response.status, json.loads(response.read()), response.headers
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read()), error.headers

    def health(self):
        try:
            status, body, _ = self.http("GET", "/health", timeout=2)
            return status, body
        except OSError:
            return None, None

    def batch(self, texts, interactive=False):
        headers = {server.PRIORITY_HEADER: "interactive"} if interactive else {}
        return self.http("POST", "/tokenize/batch", {"texts": texts, "coarse": True}, headers)

    def tokenized(self, text):
        return [line.split("\t", 1)[1] for line in self.log.read_text().splitlines()].count(text)

    def in_background(self, function, *args):
        result = {}

        def target():
            result["value"] = function(*args)
            result["finished"] = time.monotonic()

        thread = threading.Thread(target=target)
        thread.start()
        self.addCleanup(thread.join, 30)
        return thread, result

    def test_the_http_contract_holds_over_the_wire(self):
        status, body = self.health()
        self.assertEqual((status, body["status"], body["model"]), (200, "ready", "COARSE_ELECTRA_SMALL_ZH"))
        pool = body["pool"]
        self.assertEqual(
            (pool["workers"], pool["liveWorkers"], pool["threadsPerWorker"], pool["reservedForInteractive"]),
            (3, 3, 2, 1),
        )
        status, tokens, headers = self.http("POST", "/tokenize", {"text": "吴恩达 与 人工智能", "coarse": True})
        self.assertEqual((status, tokens), (200, [["吴恩达", "与", "人工智能"]]))
        self.assertEqual(headers["content-type"], "application/json; charset=utf-8")
        self.assertEqual(self.batch(["a b", "c"])[:2], (200, {"batch": [["a", "b"], ["c"]]}))
        self.assertEqual(self.batch([])[:2], (200, {"batch": []}))
        self.assertEqual(self.http("GET", "/nope")[:2], (404, {"error": "not found"}))
        status, body, _ = self.http("POST", "/tokenize", raw=b"x" * 2048)
        self.assertEqual((status, body), (413, {"error": "request body exceeds 1024 bytes"}))

    def test_each_worker_is_its_own_process_with_an_even_thread_share(self):
        calls = [self.in_background(self.batch, ["sleep:0.4", "env"], True) for _ in range(3)]
        for thread, _ in calls:
            thread.join(10)
        answers = [result["value"][1]["batch"][1] for _, result in calls]
        self.assertTrue(all(answer[:3] == ["2", "2", "2"] for answer in answers), answers)
        pids = {answer[3] for answer in answers}
        self.assertEqual(len(pids), 3)
        self.assertNotIn(str(self.process.pid), pids)

    def test_a_query_does_not_wait_behind_long_bulk_batches(self):
        writers = [self.in_background(self.batch, ["sleep:1.5"]) for _ in range(2)]
        self.assertTrue(wait_until(lambda: self.tokenized("sleep:1.5") == 2))
        third_thread, third = self.in_background(self.batch, ["third writer"])
        # Bulk has its two workers; the third writer waits although one is idle.
        self.assertTrue(wait_until(lambda: self.health()[1]["pool"]["queued"]["bulk"] == 1))
        started = time.monotonic()
        status, body, _ = self.batch(["查询"], interactive=True)
        finished = time.monotonic()
        self.assertEqual((status, body), (200, {"batch": [["查询"]]}))
        self.assertLess(finished - started, 1.0)
        self.assertNotIn("finished", third)
        third_thread.join(10)
        self.assertEqual(third["value"][:2], (200, {"batch": [["third", "writer"]]}))
        self.assertGreater(third["finished"], finished)
        for thread, result in writers:
            thread.join(10)
            self.assertEqual(result["value"][0], 200)

    def test_a_request_abandoned_in_the_queue_is_never_tokenized(self):
        sleepers = [self.in_background(self.batch, ["sleep:1.0"], True) for _ in range(3)]
        self.assertTrue(wait_until(lambda: self.tokenized("sleep:1.0") == 3))
        body = json.dumps({"texts": ["abandoned marker"]}).encode()
        caller = socket.create_connection(("127.0.0.1", self.port))
        caller.sendall(
            b"POST /tokenize/batch HTTP/1.1\r\nHost: hanlp\r\ncontent-type: application/json\r\n"
            + f"content-length: {len(body)}\r\n\r\n".encode()
            + body
        )
        self.assertTrue(wait_until(lambda: self.health()[1]["pool"]["queued"]["bulk"] == 1))
        caller.close()
        for thread, _ in sleepers:
            thread.join(10)
        self.assertTrue(wait_until(lambda: self.health()[1]["pool"]["skippedDisconnected"] == 1))
        self.assertEqual(self.tokenized("abandoned marker"), 0)
        self.assertEqual(self.batch(["after"])[:2], (200, {"batch": [["after"]]}))

    def test_a_failing_or_dying_worker_is_contained_and_replaced(self):
        secret = "raise:request-content-must-not-enter-logs"
        self.assertEqual(self.batch([secret])[:2], (500, {"error": "tokenizer inference failed"}))
        self.assertEqual(self.batch(["crash"])[:2], (500, {"error": "tokenizer inference failed"}))
        # The rest keep serving while the dead worker is replaced.
        self.assertEqual(self.health()[0], 200)
        self.assertEqual(self.batch(["meanwhile"])[:2], (200, {"batch": [["meanwhile"]]}))
        self.assertTrue(wait_until(
            lambda: self.health()[1]["pool"]["replacedWorkers"] == 1
            and self.health()[1]["pool"]["liveWorkers"] == 3,
            15,
        ))
        log = self.stderr_path.read_text()
        self.assertIn("RuntimeError", log)
        self.assertIn("replacing it", log)
        self.assertNotIn("request-content-must-not-enter-logs", log)

    def test_sigterm_stops_the_server_and_every_worker(self):
        calls = [self.in_background(self.batch, ["sleep:0.3", "env"], True) for _ in range(3)]
        for thread, _ in calls:
            thread.join(10)
        pids = [int(result["value"][1]["batch"][1][3]) for _, result in calls]

        def gone(pid):
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return True
            return False

        self.process.send_signal(signal.SIGTERM)
        self.assertEqual(self.process.wait(10), 0)
        self.assertTrue(wait_until(lambda: all(gone(pid) for pid in pids), 10))


if __name__ == "__main__":
    unittest.main(verbosity=2)
