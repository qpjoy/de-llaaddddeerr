"""Incident recovery tests: real validation and transaction orchestration, no broker."""
import ast
import copy
from contextlib import contextmanager, redirect_stdout
from datetime import datetime, timedelta, timezone
import hashlib
import io
import json
import os
from pathlib import Path
import runpy
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[2] / "server/ops/recover-delta-raw-admission.py"
M = runpy.run_path(str(SCRIPT), run_name="recovery_test")
G = M["recover"].__globals__
NOW = datetime(2026, 10, 18, 1, 0, tzinfo=timezone.utc)
PRIVATE = "private-query-key-error-secret"


class Row(SimpleNamespace):
    def save(self, update_fields):
        assert self.db.active and not self.db.readonly
        self.db.saves.append((self.kind, tuple(update_fields)))
        if self.db.fail_save == self.kind:
            raise RuntimeError(PRIVATE)


class Query:
    def __init__(self, db, rows, kind):
        self.db, self.rows, self.kind = db, rows, kind

    def using(self, alias):
        assert alias == "default" and self.db.active
        return self

    def select_for_update(self, nowait):
        assert nowait is True and self.db.active and not self.db.readonly
        self.db.locks.append(self.kind)
        return self

    def filter(self, **conditions):
        self.db.queries.append((self.kind, conditions))
        return Query(self.db, [row for row in self.rows if all(str(getattr(row, key)) == str(value) for key, value in conditions.items())], self.kind)

    def first(self):
        return next(iter(self.rows), None)

    def exists(self):
        return bool(self.rows)

    def order_by(self, field):
        assert field == "id"
        return Query(self.db, sorted(self.rows, key=lambda row: row.id), self.kind)

    def __getitem__(self, selection):
        assert selection == slice(None, 2)
        return self.rows[selection]


class Cursor:
    def __init__(self, db): self.db = db
    def __enter__(self): return self
    def __exit__(self, *args): return False

    def execute(self, sql):
        self.db.sql.append(sql)
        if sql.startswith("BEGIN TRANSACTION"):
            assert not self.db.active
            self.db.active = True; self.db.readonly = True
        elif sql == "ROLLBACK":
            self.db.active = False; self.db.readonly = False
        else:
            assert self.db.active and sql.startswith(("SET LOCAL", "SELECT current_database()"))
        if self.db.fail_sql and sql.startswith(self.db.fail_sql):
            raise RuntimeError(PRIVATE)

    def fetchone(self): return (PRIVATE, "10.1.2.3", 5432)


class DB:
    vendor, alias, in_atomic_block = "postgresql", "default", False
    def __init__(self):
        self.active = self.readonly = False
        self.sql, self.saves, self.locks, self.queries, self.rows = [], [], [], [], []
        self.fail_save = self.fail_sql = None
        self.commits = self.rollbacks = 0
    def get_autocommit(self): return not self.active
    def cursor(self): return Cursor(self)

    @contextmanager
    def atomic(self, using):
        assert using == "default" and not self.active
        saved = [(row, copy.deepcopy({key: value for key, value in vars(row).items() if key != "db"})) for row in self.rows]
        self.active = self.in_atomic_block = True
        try:
            yield
            self.commits += 1
        except BaseException:
            self.rollbacks += 1
            for row, values in saved:
                row.__dict__.clear(); row.__dict__.update(values, db=self)
            raise
        finally:
            self.active = self.in_atomic_block = False


class Fixture:
    def __init__(self):
        self.db = DB()
        self.models = SimpleNamespace()
        self.published = []
        def row(kind, pk, **values):
            value = Row(db=self.db, kind=kind, id=pk, pk=pk, **values)
            self.db.rows.append(value)
            setattr(self.models, kind, SimpleNamespace(objects=Query(self.db, [value], kind)))
            return value
        contract = {"version": 2, "timeWindow": {"from": "2026-09-17T00:00:00+08:00", "to": "2026-10-17T16:14:21.006+00:00",
                                                     "timezone": "Asia/Shanghai", "boundary": "[from,to)"}}
        self.payload = {"platform": "twitter", "keyword": PRIVATE, "count": 20, "page": 1,
                        "_search_contract": contract, M["MARKER"]: 1}
        self.stream = hashlib.sha256(json.dumps(["/api/v1/search/raw", "twitter", PRIVATE, None, "正文"], ensure_ascii=False).encode()).hexdigest()[:24]
        self.entry = {"state": "unknown", "page_number": 1, "request_id": M["BLOCKER"], "next_cursor": "",
                      "idempotency_key": PRIVATE, "payload": copy.deepcopy(self.payload)}
        self.scope = {"platform": "twitter", "platforms": ["twitter"], "cold_start_group_key": M["GROUP"], "queries": [PRIVATE],
                      "cold_start_window": {"start": contract["timeWindow"]["from"], "end": "2026-10-17T16:14:21.006149+00:00"}, "_search_contract": contract,
                      M["LEDGER"]: {"version": 1, "streams": {self.stream: self.entry}},
                      M["BLOCK"]: {"version": 1, "code": "request_outcome_unknown", "request_id": M["BLOCKER"]},
                      "cold_start_paging": {"page_number": 1, "pages_completed": 0, "pagination": {}, "exhausted": False}, "followup_run_ids": [100]}
        self.plan = row("CollectionPlan", 7, public_key=M["PLAN"], enabled=True, expire_time=None,
                        monitor_target_type="content", platforms=["twitter"], platform_rules=[], spider_config={"collector": "data_query"}, updated_at=NOW)
        self.cold = row("CollectionPlanColdStartState", 8, plan_id=7, platform="twitter", group_key=M["GROUP"], status="failed", reason="cold_start_failed",
                        collection_policy_snapshot={"cold_start_max_items": 100}, retained_content_count=12, attempt_count=1,
                        error_message=PRIVATE, started_at=NOW-timedelta(hours=1), deferred_at=None, completed_at=NOW, updated_at=NOW)
        counters = dict.fromkeys(M["COUNTERS"], 0)
        self.run = row("CollectionRun", 9, public_key=M["RUN"], plan_id=7, query_group_id=None, run_kind="plan_collection", trigger_source="cold_start",
                       status="failed", platform_scope=self.scope, celery_task_id="old-task-id", error_message=PRIVATE, finished_at=NOW,
                       collection_policy_snapshot={"twitter": {"cold_start_max_items": 100}}, updated_at=NOW, **counters)
        error_body = {"requestId": M["BLOCKER"], "error": {"code": "request_outcome_unknown", "message": M["MESSAGE"],
                      "details": {"requestId": M["BLOCKER"], "automaticRetryAllowed": False}}}
        self.error = (f"data_query.hub_standard_request_failed status=409 request_id={M['BLOCKER']} operation=raw platform=twitter message={error_body}")
        self.collector = {"request_dispatched": True, "failed_request_id": M["BLOCKER"], "request_ids": [M["BLOCKER"]],
                          "endpoint": "/api/v1/search/raw", "page_number": 1, "pages_done": 0, "unique_rows": 0, "raw_row_count": 0, "pagination": {}}
        self.step = row("CollectionRunSpiderStep", 10, public_key=M["STEP"], run_id=9, query_group_id=None, status="failed", spider_name="data_query.raw",
                        spider_type="正文", params={**copy.deepcopy(self.payload), "_collector": self.collector}, error_message=self.error, updated_at=NOW, **counters)
        self.runtime = row("DataHubRuntimeState", 1, collection_paused=False, collection_platform_pauses={}, updated_at=NOW)
        self.models.CollectionItem = SimpleNamespace(objects=Query(self.db, [], "CollectionItem"))
        self.models.CollectionQueryGroup = SimpleNamespace(objects=Query(self.db, [], "CollectionQueryGroup"))
        self.constants = {"STREAM_SHA": M["text_digest"](self.stream), "PAYLOAD_SHA": M["digest"](self.payload), "KEY_SHA": M["text_digest"](PRIVATE),
                          "DATABASE_SHA": hashlib.sha256(json.dumps((PRIVATE, "10.1.2.3", 5432)).encode()).hexdigest()}
        self.receipt = {"revision": M["REVISION"], "planKey": M["PLAN"], "runKey": M["RUN"], "blockerRequestId": M["BLOCKER"],
                        "idempotencyKeySha256": self.constants["KEY_SHA"], "payloadSha256": self.constants["PAYLOAD_SHA"],
                        "checkedAt": (NOW-timedelta(minutes=1)).isoformat(), "protocolStoreSha256": M["STORE_SHA"],
                        "legacyRawVerified": True, "pageIdentityAbsent": True, "ready": True}

    def publish(self, run_id, task_id):
        assert not self.db.active and self.db.commits == 1
        assert run_id == self.run.pk and task_id == self.run.celery_task_id and self.run.status == "pending"
        assert self.run.platform_scope[M["BLOCK"]]["reason"] == "raw_admission_dispatch_prepared"
        assert self.run.platform_scope[M["BLOCK"]]["task_id"] == task_id
        self.published.append((run_id, task_id))

    def call(self, **kwargs):
        with patch.dict(G, {**self.constants, "verify_runtime_source": lambda models: {"raw_admission_recovery.py": "1"*64, "tasks.py": "2"*64}}):
            return M["recover"](self.db, self.db, self.models, receipt=kwargs.pop("receipt", self.receipt), now=NOW,
                                publisher=kwargs.pop("publisher", self.publish), guard_check=kwargs.pop("guard_check", lambda plan, cold: False), **kwargs)

    def preview(self): return self.call()["previewSha256"]


class RecoveryTest(unittest.TestCase):
    def test_original_microsecond_window_matches_millisecond_contract_by_instant(self):
        f = Fixture()
        self.assertEqual(f.call()["status"], "preview_ready")
        f.scope["cold_start_window"]["end"] = "2026-10-18T00:14:21.006149+08:00"
        self.assertEqual(f.call()["status"], "preview_ready")
        f.scope["cold_start_window"]["end"] = "2026-10-18T00:14:21.007149+08:00"
        with self.assertRaisesRegex(M["RecoveryBlocked"], "local_window_changed"):
            f.call()

    def test_runtime_claim_helper_and_both_entry_integrations_require_exact_build(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); models = SimpleNamespace(__file__=str(root / "models.py"))
            expected = {}
            for name in M["RUNTIME_SHA256"]:
                content = ("# reviewed " + name).encode(); (root / name).write_bytes(content)
                expected[name] = hashlib.sha256(content).hexdigest()
            with patch.dict(G, {"RUNTIME_SHA256": expected}):
                self.assertEqual(M["verify_runtime_source"](models), expected)
                (root / "tasks.py").write_text("# old worker without claim or scheduler integration")
                with self.assertRaisesRegex(M["RecoveryBlocked"], "runtime_recovery_build_required"):
                    M["verify_runtime_source"](models)
                (root / "tasks.py").unlink()
                with self.assertRaisesRegex(M["RecoveryBlocked"], "runtime_recovery_build_required"):
                    M["verify_runtime_source"](models)

    def test_fixed_incident_identity_is_not_user_selectable(self):
        self.assertEqual(M["RUN"], "65a9f174-e611-4032-a759-fb64efcb540e")
        self.assertEqual(M["PAYLOAD_SHA"], "40ba477e6e7b6bbb5c58bdf40c978daa6d03d9bd3931a5637c78f7d2ad5ff43b")
        self.assertEqual(M["KEY_SHA"], "c7ef520abe008e7c8ba0555bdddd496a0b055e37bc37dd97bd0323884afa1c00")
        self.assertEqual(M["STREAM_SHA"], "de921845eb613631546a441aed80f0fd04022542a0f5e901c692472e0e0edbe5")

    def test_preview_readonly_stable_snapshot_no_private_fields_no_tasks(self):
        f = Fixture(); before = copy.deepcopy(f.scope)
        report = f.call()
        self.assertEqual(report["status"], "preview_ready"); self.assertTrue(report["readOnly"])
        self.assertEqual(report["followupCount"], 1); self.assertEqual(f.published, [])
        self.assertEqual(f.db.saves, []); self.assertEqual(f.db.locks, [])
        self.assertEqual(f.db.sql[0], "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        self.assertEqual(f.db.sql[-1], "ROLLBACK"); self.assertEqual(f.run.platform_scope, before)
        self.assertEqual(report["previewSha256"], f.preview())
        self.assertNotIn(PRIVATE, json.dumps(report)); self.assertNotIn("old-task-id", json.dumps(report))

    def test_receipt_missing_bad_scope_stale_future_type_and_schema_are_rejected_before_database(self):
        for patch_receipt in ({"runKey": M["PLAN"]}, {"ready": 1}, {"legacyRawVerified": False}, {"pageIdentityAbsent": False},
                              {"protocolStoreSha256": "0"*64}, {"extra": PRIVATE},
                              {"checkedAt": (NOW-timedelta(minutes=31)).isoformat()}, {"checkedAt": (NOW+timedelta(seconds=1)).isoformat()},
                              {"checkedAt": "2026-10-18T01:00:00"}):
            f = Fixture()
            with self.subTest(patch=patch_receipt), self.assertRaises(M["RecoveryBlocked"]):
                f.call(receipt={**f.receipt, **patch_receipt})
            self.assertEqual(f.db.sql, [])
        with self.assertRaisesRegex(M["RecoveryBlocked"], "hub_receipt_required"):
            M["load_receipt"](None)
        f = Fixture()
        with self.assertRaisesRegex(M["RecoveryBlocked"], "preview_sha256_required"):
            f.call(action="apply-and-resume")
        self.assertEqual(f.db.sql, [])

    def test_apply_preserves_exact_page_and_old_step_only_publishes_after_commit_once(self):
        f = Fixture(); before_step = copy.deepcopy({key: value for key, value in vars(f.step).items() if key != "db"})
        before_scope = copy.deepcopy(f.scope); before_cold_policy = copy.deepcopy(f.cold.collection_policy_snapshot)
        preview = f.preview()
        checked = []
        def guards(plan, cold):
            checked.append(True)
            self.assertNotIn(M["BLOCK"], f.run.platform_scope)
            self.assertTrue(f.db.active)
            return False
        report = f.call(action="apply-and-resume", expected_preview=preview, guard_check=guards)
        self.assertEqual(report["status"], "published"); self.assertEqual(len(f.published), 1); self.assertEqual(checked, [True])
        self.assertEqual(f.db.commits, 2)
        entry = f.run.platform_scope[M["LEDGER"]]["streams"][f.stream]
        self.assertEqual(entry["payload"], before_scope[M["LEDGER"]]["streams"][f.stream]["payload"])
        self.assertEqual(entry["idempotency_key"], PRIVATE); self.assertEqual(entry["state"], "pending")
        self.assertEqual(f.run.platform_scope["cold_start_window"], before_scope["cold_start_window"])
        self.assertEqual(f.run.platform_scope["followup_run_ids"], [100])
        self.assertEqual(f.run.platform_scope[M["AUDIT"]]["original_scope"], before_scope)
        self.assertEqual(f.run.platform_scope[M["AUDIT"]]["dispatch_state"], "published")
        self.assertEqual({key: value for key, value in vars(f.step).items() if key != "db"}, before_step)
        self.assertEqual(f.cold.status, "running"); self.assertEqual(f.cold.attempt_count, 2)
        self.assertEqual(f.cold.retained_content_count, 12); self.assertEqual(f.cold.collection_policy_snapshot, before_cold_policy)
        self.assertEqual(f.cold.group_key, M["GROUP"]); self.assertEqual(f.cold.started_at, NOW-timedelta(hours=1))
        self.assertEqual(f.run.status, "pending"); self.assertIsNone(f.run.finished_at)
        again = f.call(action="apply-and-resume", expected_preview=preview)
        self.assertEqual(again["status"], "already_recorded_no_publish"); self.assertEqual(len(f.published), 1)
        self.assertNotIn(PRIVATE, json.dumps(report))

    def test_cas_and_other_guard_failure_roll_back_every_write_before_publish(self):
        for mode in ("changed", "guard", "save"):
            f = Fixture(); preview = f.preview(); original = copy.deepcopy(f.scope)
            if mode == "changed": f.run.updated_at += timedelta(seconds=1)
            if mode == "save": f.db.fail_save = "CollectionPlanColdStartState"
            with self.subTest(mode=mode), self.assertRaises((M["RecoveryBlocked"], RuntimeError)):
                f.call(action="apply-and-resume", expected_preview=preview, guard_check=lambda plan, cold: mode == "guard")
            self.assertEqual(f.run.platform_scope, original); self.assertEqual(f.run.status, "failed")
            self.assertEqual(f.run.celery_task_id, "old-task-id"); self.assertEqual(f.cold.status, "failed")
            self.assertEqual(f.db.rollbacks, 1); self.assertEqual(f.published, [])

    def test_rejection_matrix_preserves_source_and_never_dispatches(self):
        mutations = [lambda f: setattr(f.plan, "enabled", False), lambda f: setattr(f.plan, "expire_time", NOW),
            lambda f: f.plan.spider_config.__setitem__("collector", " SPIDER "),
            lambda f: setattr(f.plan, "platform_rules", [{"platform": "twitter", "enabled": False}]),
            lambda f: setattr(f.plan, "platforms", ["facebook"]),
            lambda f: setattr(f.runtime, "collection_paused", True), lambda f: setattr(f.runtime, "collection_platform_pauses", {"twitter": {}}),
            lambda f: setattr(f.run, "plan_id", 999), lambda f: setattr(f.cold, "group_key", "other"),
            lambda f: setattr(f.step, "status", "running"), lambda f: setattr(f.run, "collected_count", 1),
            lambda f: setattr(f.step, "actor_count", 1), lambda f: f.entry.__setitem__("next_cursor", PRIVATE),
            lambda f: f.entry.__setitem__("idempotency_key", "changed"), lambda f: f.entry.__setitem__("state", "delivered"),
            lambda f: f.scope.__setitem__("queries", ["different"]), lambda f: f.scope.pop("queries"),
            lambda f: f.scope["cold_start_window"].__setitem__("start", "2026-09-18T00:00:00+08:00"),
            lambda f: f.collector.__setitem__("request_ids", [M["BLOCKER"], M["RUN"]]),
            lambda f: f.collector.__setitem__("pages_done", 1), lambda f: f.step.params.__setitem__("query", "changed"),
            lambda f: f.models.CollectionRunSpiderStep.objects.rows.append(f.step),
            lambda f: f.models.CollectionItem.objects.rows.append(SimpleNamespace(run_id=f.run.pk)),
            lambda f: f.models.DataHubRuntimeState.objects.rows.clear(),
            lambda f: setattr(f.step, "query_group_id", 99)]
        for change in mutations:
            f = Fixture(); change(f)
            with self.subTest(change=change), self.assertRaises(M["RecoveryBlocked"]): f.call()
            self.assertEqual(f.db.saves, []); self.assertEqual(f.published, [])

    def test_structured_error_parser_rejects_substring_forgery_mixed_ids_and_retry_allowed(self):
        f = Fixture(); M["validate_error"](f.error)
        for changed in (f.error.replace("status=409", "status=4090"), f.error + " extra", f.error.replace("False", "True"),
                        f.error.replace("'requestId': '" + M["BLOCKER"] + "', ", "", 1),
                        f.error.replace(M["MESSAGE"], M["MESSAGE"] + " changed"), f.error.replace("operation=raw", "operation=crawl"),
                        f.error.replace("'requestId': '" + M["BLOCKER"] + "'", "'requestId': '" + M["RUN"] + "'", 1),
                        f.error.replace("request_outcome_unknown", "request_outcome_unknownish")):
            with self.subTest(changed=changed), self.assertRaises(M["RecoveryBlocked"]): M["validate_error"](changed)

    def test_publish_exception_persists_guard_without_another_publish_or_page_change(self):
        f = Fixture(); preview = f.preview()
        def fail(run_id, task_id):
            f.publish(run_id, task_id)
            raise RuntimeError(PRIVATE)
        report = f.call(action="apply-and-resume", expected_preview=preview, publisher=fail)
        self.assertEqual(report["status"], "dispatch_unknown"); self.assertTrue(report["ambiguityGuardPersisted"])
        self.assertEqual(f.run.status, "failed")
        self.assertEqual(f.run.platform_scope[M["BLOCK"]]["reason"], "dispatch_unknown")
        self.assertEqual(f.run.platform_scope[M["LEDGER"]]["streams"][f.stream]["payload"], f.payload)
        self.assertEqual(f.run.platform_scope[M["AUDIT"]]["dispatch_state"], "dispatch_unknown")
        self.assertEqual(f.call(action="apply-and-resume", expected_preview=preview)["status"], "already_recorded_no_publish")
        self.assertEqual(len(f.published), 1); self.assertNotIn(PRIVATE, json.dumps(report))

    def test_process_death_between_commit_and_publish_preserves_prepared_hold_and_never_republishes(self):
        f = Fixture(); preview = f.preview()
        def die(run_id, task_id):
            self.assertFalse(f.db.active)
            self.assertEqual(f.run.platform_scope[M["BLOCK"]]["task_id"], task_id)
            raise KeyboardInterrupt()
        with self.assertRaises(KeyboardInterrupt):
            f.call(action="apply-and-resume", expected_preview=preview, publisher=die)
        self.assertEqual(f.db.commits, 1)
        self.assertEqual(f.run.platform_scope[M["BLOCK"]]["reason"], "raw_admission_dispatch_prepared")
        self.assertEqual(f.run.platform_scope[M["AUDIT"]]["dispatch_state"], "dispatch_prepared")
        self.assertEqual(f.call(action="apply-and-resume", expected_preview=preview)["status"], "already_recorded_no_publish")
        self.assertEqual(f.published, [])

    def test_publisher_exception_after_worker_claim_does_not_add_false_unknown_or_modify_run(self):
        for status in ("pending", "running", "succeeded"):
            f = Fixture(); preview = f.preview()
            def claimed(run_id, task_id):
                f.publish(run_id, task_id)
                f.run.platform_scope.pop(M["BLOCK"])
                f.run.platform_scope[M["AUDIT"]].update(execution_state="claimed", claimed_task_id=task_id, claimed_at=NOW.isoformat())
                f.run.status = status
                raise RuntimeError(PRIVATE)
            result = f.call(action="apply-and-resume", expected_preview=preview, publisher=claimed)
            self.assertTrue(result["manualReconcileRequired"])
            self.assertNotIn(M["BLOCK"], f.run.platform_scope)
            self.assertEqual(f.run.status, status)
            self.assertEqual(f.run.platform_scope[M["AUDIT"]]["dispatch_state"], "dispatch_unknown")

    def test_publisher_exception_replaces_invalid_guard_but_keeps_it_in_private_audit(self):
        for invalid in ({}, {"code": "request_outcome_unknown", "version": "1", "private": PRIVATE}):
            f = Fixture(); preview = f.preview()
            def fail(run_id, task_id):
                f.publish(run_id, task_id)
                f.run.platform_scope[M["BLOCK"]] = invalid
                raise RuntimeError(PRIVATE)
            report = f.call(action="apply-and-resume", expected_preview=preview, publisher=fail)
            self.assertEqual(f.run.platform_scope[M["BLOCK"]]["reason"], "dispatch_unknown")
            self.assertEqual(f.run.platform_scope[M["AUDIT"]]["block_before_dispatch_unknown"], invalid)
            self.assertNotIn(PRIVATE, json.dumps(report))

    def test_publish_ambiguity_does_not_erase_worker_success_or_existing_guard(self):
        for worker_state in ("running", "succeeded", "unknown"):
            f = Fixture(); preview = f.preview()
            def fail(run_id, task_id):
                f.publish(run_id, task_id)
                f.run.status = "succeeded" if worker_state == "succeeded" else "running"
                if worker_state == "succeeded":
                    f.run.platform_scope[M["LEDGER"]]["streams"][f.stream]["state"] = "delivered"
                    f.run.platform_scope.pop(M["BLOCK"])
                if worker_state == "unknown": f.run.platform_scope[M["BLOCK"]] = {"version": 1, "code": "request_outcome_unknown", "request_id": M["STEP"]}
                raise RuntimeError(PRIVATE)
            result = f.call(action="apply-and-resume", expected_preview=preview, publisher=fail)
            self.assertEqual(f.run.status, "succeeded" if worker_state == "succeeded" else "running")
            if worker_state == "succeeded": self.assertNotIn(M["BLOCK"], f.run.platform_scope)
            if worker_state == "unknown": self.assertEqual(f.run.platform_scope[M["BLOCK"]]["request_id"], M["STEP"])
            self.assertTrue(result["manualReconcileRequired"])

    def test_ambiguous_publish_persistence_failure_reports_possible_queue_and_never_retries(self):
        f = Fixture(); preview = f.preview()
        def fail(run_id, task_id):
            f.publish(run_id, task_id); f.db.fail_save = "CollectionRun"
            raise RuntimeError(PRIVATE)
        report = f.call(action="apply-and-resume", expected_preview=preview, publisher=fail)
        self.assertFalse(report["ambiguityGuardPersisted"]); self.assertTrue(report["mayAlreadyBeQueued"])
        self.assertEqual(len(f.published), 1); self.assertEqual(f.run.platform_scope[M["AUDIT"]]["dispatch_state"], "dispatch_prepared")
        self.assertNotIn(PRIVATE, json.dumps(report))

    def test_receipt_file_and_missing_input_main_are_safe_without_django(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "receipt.json"; path.write_text(json.dumps(Fixture().receipt))
            self.assertEqual(M["load_receipt"](path), Fixture().receipt)
            path.write_text(PRIVATE)
            with self.assertRaisesRegex(M["RecoveryBlocked"], "invalid_hub_receipt"): M["load_receipt"](path)
        output = io.StringIO()
        with patch.dict(os.environ, {}, clear=True), redirect_stdout(output), self.assertRaises(SystemExit): M["main"]()
        self.assertEqual(json.loads(output.getvalue())["code"], "hub_receipt_required")

    def test_production_publisher_is_single_run_after_commit_without_retry_helpers(self):
        source = SCRIPT.read_text(); tree = ast.parse(source)
        calls = [node for node in ast.walk(tree) if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "apply_async"]
        self.assertEqual(len(calls), 1)
        keywords = {item.arg: item.value for item in calls[0].keywords}
        self.assertIs(keywords["retry"].value, False)
        self.assertEqual(ast.unparse(keywords["args"]), "[run_id]")
        for forbidden in ("recover_plan_cold_start", "_resume_existing_cold_start", "create_retry_collection_run", "resume_collection"):
            self.assertNotIn(forbidden, source)
        imports = [name.name for node in ast.walk(tree) if isinstance(node, ast.Import) for name in node.names]
        imports += [node.module for node in ast.walk(tree) if isinstance(node, ast.ImportFrom)]
        self.assertNotIn("requests", imports); self.assertNotIn("urllib.request", imports)
        self.assertIn("from data_hub.tasks import run_collection_plan, cold_start_task_options", source)
        self.assertNotIn("ensure_platform_queries", source)


if __name__ == "__main__":
    unittest.main()
