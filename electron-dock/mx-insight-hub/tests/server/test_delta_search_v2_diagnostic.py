"""Exercise the real read-only diagnostic against a bounded ORM boundary."""
import ast
from contextlib import redirect_stdout
import copy
import hashlib
from datetime import datetime, timezone
import io
import json
import os
from pathlib import Path
import runpy
import sys
import tempfile
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch
from uuid import uuid4


SCRIPT = Path(__file__).resolve().parents[2] / "server/ops/diagnose-delta-search-v2.py"
MODULE = runpy.run_path(str(SCRIPT), run_name="search_v2_diagnostic_test")
PRIVATE = "private-query-cursor-key-error-secret"
PLAN_ID, RUN_ID, STEP_ID, REQUEST_ID = (str(uuid4()) for _ in range(4))
NOW = datetime(2026, 10, 17, 15, 3, tzinfo=timezone.utc)
LIMIT = MODULE["LIMIT"]


class Cursor:
    def __init__(self, connection):
        self.connection = connection

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def execute(self, sql):
        assert sql.startswith(("BEGIN TRANSACTION", "SET LOCAL", "ROLLBACK", "SELECT current_database()")), sql
        self.connection.commands.append(sql)
        if self.connection.fail_sql and sql.startswith(self.connection.fail_sql):
            raise RuntimeError(PRIVATE)

    def fetchone(self):
        return (PRIVATE, "10.0.0.9", 5432, NOW)


class Connection:
    vendor, alias, in_atomic_block, autocommit = "postgresql", "default", False, True

    def __init__(self):
        self.commands, self.queries, self.slices = [], [], []
        self.fail_sql = None

    def cursor(self):
        return Cursor(self)

    def get_autocommit(self):
        return self.autocommit


def matches(row, filters):
    for key, expected in filters.items():
        parts = key.split("__")
        operation = parts.pop() if parts[-1] in {"in", "has_key"} else None
        field = "__".join(parts)
        if field in row:
            actual = row[field]
        else:
            actual = row
            for part in parts:
                actual = actual.get(part) if isinstance(actual, dict) else None
        if operation == "in":
            matched = actual in expected
        elif operation == "has_key":
            matched = isinstance(actual, dict) and expected in actual
        else:
            matched = actual == expected
        if not matched:
            return False
    return True


class Query:
    """No write/external methods; every read checks the transaction and limits."""
    def __init__(self, connection, rows, *, model, fields=None):
        self.connection, self.rows, self.model, self.fields = connection, rows, model, fields

    def clone(self, rows=None, fields=None):
        return Query(self.connection, self.rows if rows is None else rows, model=self.model,
                     fields=self.fields if fields is None else fields)

    def using(self, alias):
        assert alias == self.connection.alias
        assert self.connection.commands[0] == "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"
        return self

    def filter(self, **filters):
        self.connection.queries.append((self.model, "filter", filters))
        return self.clone([row for row in self.rows if matches(row, filters)])

    def exclude(self, **filters):
        self.connection.queries.append((self.model, "exclude", filters))
        return self.clone([row for row in self.rows if not matches(row, filters)])

    def distinct(self):
        return self.clone(list({row["id"]: row for row in self.rows}.values()))

    def values(self, *fields):
        return self.clone(fields=fields)

    def order_by(self, *fields):
        assert fields == ("-created_at", "-id")
        return self

    def first(self):
        return next(iter(self), None)

    def count(self):
        self.connection.queries.append((self.model, "count", None))
        return len(self.rows)

    def __iter__(self):
        return iter([{key: row[key] for key in self.fields} for row in self.rows])

    def __getitem__(self, item):
        assert isinstance(item, slice) and item.start is None and item.stop == LIMIT + 1 and item.step is None
        self.connection.slices.append((self.model, item.stop))
        return list(self)[item]


def fixture(*, plan_exists=True, run_count=1, step_count=1):
    connection = Connection()
    stream = {"state": "unknown", "page_number": 1, "request_id": REQUEST_ID,
              "idempotency_key": PRIVATE, "next_cursor": PRIVATE,
              "payload": {"platform": "facebook", "query": PRIVATE, "cursor": PRIVATE}}
    scope = {"platform": "facebook", "queries": [PRIVATE], "cold_start_group_key": str(uuid4()),
             "_search_contract": {"version": 2, "private": PRIVATE},
             "cold_start_redispatch_block": {"code": "request_outcome_unknown", "request_id": REQUEST_ID},
             "_facebook_page_requests": {"version": 1, "streams": {PRIVATE: stream}}}
    runs = [{"id": index + 1, "public_key": RUN_ID, "plan_id": 7, "run_kind": "plan_collection",
             "status": "failed", "trigger_source": "cold_start", "platform_scope": copy.deepcopy(scope),
             "created_at": NOW, "collected_count": 0, "new_content_count": 0, "duplicate_count": 0, "actor_count": 0,
             "spider_steps__spider_name": "data_query.raw",
             "spider_steps__params__platform": "facebook", "spider_steps__status": "failed"}
            for index in range(run_count)]
    steps = [{"id": index + 1, "public_key": STEP_ID, "run_id": run["id"], "spider_name": "data_query.raw",
              "status": "failed", "created_at": NOW, "collected_count": 0, "new_content_count": 0, "duplicate_count": 0, "actor_count": 0,
              "error_message": PRIVATE + " request_outcome_unknown status=404",
              "params": {"platform": "facebook", "query": PRIVATE, "cursor": PRIVATE,
                         "_facebook_page_request_version": 1,
                         "_collector": {"request_ids": [REQUEST_ID, PRIVATE], "failed_request_id": REQUEST_ID,
                                        "request_dispatched": True, "page_number": 1, "pages_done": 0,
                                        "private": PRIVATE}}}
             for run in runs for index in range(step_count)]
    plans = [{"id": 7, "public_key": PLAN_ID, "enabled": True}] if plan_exists else []
    models = SimpleNamespace(**{
        name: SimpleNamespace(objects=Query(connection, rows, model=name))
        for name, rows in (("CollectionPlan", plans), ("CollectionRun", runs), ("CollectionRunSpiderStep", steps), ("CollectionItem", []))
    })
    return connection, models, runs, steps


def mock_modules(connection, models):
    modules = {name: ModuleType(name) for name in ("django", "django.conf", "django.db", "data_hub")}
    modules["django.conf"].settings = SimpleNamespace(DATA_QUERY_HUB_API_BASE_URL="https://user:password@hub.example/api/v2/?token=" + PRIVATE)
    modules["django.db"].connection = connection
    modules["data_hub"].models = models
    return modules


class DiagnosticTest(unittest.TestCase):
    def test_exact_run_keeps_plan_boundary_and_never_reads_other_runs_steps_or_items(self):
        connection, models, runs, steps = fixture(run_count=3)
        runs[1]["public_key"] = str(uuid4())
        runs[2]["public_key"] = str(uuid4())
        result = MODULE["inspect_delta"](connection, models, PLAN_ID, RUN_ID, REQUEST_ID)
        self.assertTrue(result["selectedRunFound"])
        self.assertEqual(result["selectedRunKey"], RUN_ID)
        self.assertEqual(result["specifiedBlockerRequestId"], REQUEST_ID)
        self.assertEqual(len(result["recentRuns"]), 1)
        for name, action, filters in connection.queries:
            if action == "filter" and name in {"CollectionRunSpiderStep", "CollectionItem"} and "run_id" in filters:
                self.assertEqual(filters["run_id"], 1)
        runs[0]["plan_id"] = 999
        connection.commands.clear(); connection.queries.clear()
        missing = MODULE["inspect_delta"](connection, models, PLAN_ID, RUN_ID)
        self.assertFalse(missing["selectedRunFound"])
        self.assertEqual(missing["recentRuns"], [])
        self.assertEqual(missing["unknownRuns"], [])
        self.assertFalse(any(name in {"CollectionRunSpiderStep", "CollectionItem"} for name, _, _ in connection.queries))
        self.assertEqual(connection.commands[-1], "ROLLBACK")

    def test_optional_identifiers_are_strict_and_missing_plan_cannot_be_bypassed(self):
        for options, expected in (({"plan_key": None, "run_key": RUN_ID}, "valid_plan_key_required"),
                ({"run_key": ""}, "valid_run_key_required"), ({"run_key": RUN_ID.replace("-", "")}, "valid_run_key_required"),
                ({"run_key": "{" + RUN_ID + "}"}, "valid_run_key_required"),
                ({"blocker_request_id": ""}, "valid_blocker_request_id_required"),
                ({"blocker_request_id": PRIVATE}, "valid_blocker_request_id_required")):
            connection, models, _, _ = fixture()
            with self.subTest(options=options), self.assertRaisesRegex(ValueError, expected):
                MODULE["inspect_delta"](connection, models, **{"plan_key": PLAN_ID, **options})
            self.assertEqual(connection.commands, [])
            self.assertEqual(connection.queries, [])

    def test_payload_key_and_stream_digests_keep_exact_identity_without_private_values(self):
        connection, models, runs, _ = fixture()
        stream = next(iter(runs[0]["platform_scope"]["_facebook_page_requests"]["streams"].values()))
        stream["payload"]["query"] = "台湾" + PRIVATE
        result = MODULE["inspect_delta"](connection, models, PLAN_ID, RUN_ID)
        entry = result["recentRuns"][0]["streams"][0]
        digest = hashlib.sha256(PRIVATE.encode()).hexdigest()
        self.assertEqual(entry["streamSha256"], digest)
        self.assertEqual(entry["idempotencyKeySha256"], digest)
        self.assertEqual(entry["payloadSha256"], hashlib.sha256(json.dumps(stream["payload"], ensure_ascii=False,
            sort_keys=True, separators=(",", ":")).encode()).hexdigest())
        self.assertEqual(MODULE["payload_sha256"]({"b": 2, "a": 1}), MODULE["payload_sha256"]({"a": 1, "b": 2}))
        self.assertNotEqual(entry["payloadSha256"], MODULE["payload_sha256"]({**stream["payload"], "cursor": "changed"}))
        self.assertNotIn(PRIVATE, json.dumps(result)); self.assertNotIn("台湾", json.dumps(result, ensure_ascii=False))
        self.assertIsNone(MODULE["payload_sha256"](PRIVATE))

    def test_error_text_requires_fixed_message_status_code_and_exact_blocker_without_exposing_text(self):
        _, _, _, steps = fixture()
        step = steps[0]
        base = f"{PRIVATE} status=409 request_outcome_unknown {MODULE['PROTOCOL_BLOCK_MESSAGE']} {REQUEST_ID}"
        step["error_message"] = base
        expected = {"exactMessagePresent": True, "mentions409": True, "specifiedBlockerIdPresent": True, "allRequiredTextPresent": True}
        report = MODULE["summarize_step"](step, REQUEST_ID)
        self.assertEqual(report["protocolBlockEvidence"], expected)
        self.assertNotIn(PRIVATE, json.dumps(report))
        self.assertNotIn(MODULE["PROTOCOL_BLOCK_MESSAGE"], json.dumps(report))
        for error in (base.replace("status=409", "status=4090"), base.replace("request_outcome_unknown", "request_in_progress"),
                      base.replace("request_outcome_unknown", "request_outcome_unknownish"),
                      base.replace(MODULE["PROTOCOL_BLOCK_MESSAGE"], "A search outcome is unresolved"), base.replace(REQUEST_ID, str(uuid4())),
                      base.replace(REQUEST_ID, REQUEST_ID + "0")):
            step["error_message"] = error
            self.assertFalse(MODULE["summarize_step"](step, REQUEST_ID)["protocolBlockEvidence"]["allRequiredTextPresent"])
        step["error_message"] = base
        self.assertIsNone(MODULE["summarize_step"](step)["protocolBlockEvidence"]["specifiedBlockerIdPresent"])
        self.assertFalse(MODULE["summarize_step"](step)["protocolBlockEvidence"]["allRequiredTextPresent"])

    def test_success_and_item_evidence_does_not_treat_unknown_or_truncated_lists_as_zero_coverage(self):
        connection, models, runs, steps = fixture(step_count=3)
        steps[0]["status"] = "succeeded"; steps[0]["collected_count"] = 4
        steps[0]["new_content_count"] = 3; steps[0]["duplicate_count"] = 1
        steps[0]["params"]["_collector"].update(pages_done=2, unique_rows=4, raw_row_count=5)
        del steps[1]["params"]["_facebook_page_request_version"]
        runs[0]["platform_scope"]["cold_start_paging"] = {"pages_completed": 2, "page_number": 3}
        models.CollectionItem.objects.rows.extend([{"run_id": 1, "is_new_content": True, "body": PRIVATE},
                                                  {"run_id": 1, "is_new_content": False, "body": PRIVATE},
                                                  {"run_id": 999, "is_new_content": True, "body": PRIVATE}])
        report = MODULE["inspect_delta"](connection, models, PLAN_ID, RUN_ID)["recentRuns"][0]
        self.assertEqual(report["stepEvidenceCounts"], {"scope": "returned_search_steps_only", "complete": True,
            "modernPageMarker": 2, "legacyOrMissingPageMarker": 1, "succeeded": 1, "positivePagesDone": 1, "positiveCollectedCount": 1})
        self.assertEqual(report["pageEvidence"]["completedPages"], 2)
        self.assertEqual(report["steps"][0]["uniqueRows"], 4)
        self.assertEqual(report["steps"][0]["newContentCount"], 3)
        self.assertEqual(report["storedItemEvidence"], {"itemCount": 2, "newContentItemCount": 1})
        self.assertNotIn(PRIVATE, json.dumps(report))

    def test_read_only_snapshot_sanitizes_real_projection_and_rolls_back(self):
        connection, models, runs, steps = fixture()
        before = copy.deepcopy((runs, steps))
        result = MODULE["inspect_delta"](connection, models, PLAN_ID)
        self.assertTrue(result["readOnly"])
        self.assertEqual(result["providerCalls"], 0)
        self.assertTrue(result["planFound"])
        self.assertTrue(result["planEnabled"])
        self.assertEqual(result["legacyFacebookCandidates"], [])
        run = result["unknownRuns"][0]
        self.assertTrue(run["unknownBlockPresent"])
        self.assertEqual(run["unknownRequestId"], REQUEST_ID)
        self.assertEqual(run["streams"][0]["requestId"], REQUEST_ID)
        self.assertTrue(run["streams"][0]["idempotencyKeyPresent"])
        self.assertTrue(run["streams"][0]["cursorPresent"])
        self.assertEqual(run["steps"][0]["requestIds"], [REQUEST_ID])
        self.assertTrue(run["steps"][0]["mentionsUnknown"])
        self.assertTrue(run["steps"][0]["mentions404"])
        serialized = json.dumps(result)
        self.assertNotIn(PRIVATE, serialized)
        self.assertNotIn("10.0.0.9", serialized)
        self.assertRegex(result["databaseIdentitySha256"], r"^[0-9a-f]{64}$")
        self.assertEqual((runs, steps), before)
        self.assertEqual(connection.commands, ["BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
            "SET LOCAL statement_timeout = '5s'", "SET LOCAL lock_timeout = '1s'",
            "SET LOCAL idle_in_transaction_session_timeout = '10s'",
            "SELECT current_database(), inet_server_addr()::text, inet_server_port(), now()", "ROLLBACK"])
        self.assertEqual(connection.queries[0], ("CollectionPlan", "filter", {"public_key": PLAN_ID}))

    def test_missing_plan_never_expands_to_other_plans_or_runs(self):
        connection, models, _, _ = fixture(plan_exists=False)
        result = MODULE["inspect_delta"](connection, models, PLAN_ID)
        self.assertFalse(result["planFound"])
        self.assertNotIn("recentRuns", result)
        self.assertEqual(connection.queries, [("CollectionPlan", "filter", {"public_key": PLAN_ID})])
        self.assertEqual(connection.commands[-1], "ROLLBACK")

    def test_invalid_input_and_non_dedicated_connection_do_not_query_database(self):
        for field, value, expected in ((None, None, "valid_plan_key_required"), ("vendor", "sqlite", "postgresql_required"),
                                       ("in_atomic_block", True, "dedicated_connection_required"),
                                       ("autocommit", False, "dedicated_connection_required")):
            connection, models, _, _ = fixture()
            if field:
                setattr(connection, field, value)
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, expected):
                MODULE["inspect_delta"](connection, models, PLAN_ID if field else PRIVATE)
            self.assertEqual(connection.commands, [])
            self.assertEqual(connection.queries, [])

    def test_database_and_projection_failures_always_roll_back(self):
        for fail in ("SET LOCAL statement_timeout", "SELECT current_database()", "projection"):
            connection, models, runs, _ = fixture()
            if fail == "projection":
                del runs[0]["status"]
            else:
                connection.fail_sql = fail
            with self.subTest(fail=fail), self.assertRaises((RuntimeError, KeyError)):
                MODULE["inspect_delta"](connection, models, PLAN_ID)
            self.assertEqual(connection.commands[-1], "ROLLBACK")

    def test_candidates_require_same_plan_and_only_legacy_without_ledger(self):
        connection, models, runs, _ = fixture(run_count=3)
        del runs[0]["platform_scope"]["_facebook_page_requests"]
        runs[1]["plan_id"] = 999
        runs[2]["spider_steps__params__platform"] = "twitter"
        result = MODULE["inspect_delta"](connection, models, PLAN_ID)
        self.assertEqual(len(result["recentRuns"]), 2)
        self.assertEqual(len(result["legacyFacebookCandidates"]), 1)
        self.assertFalse(result["legacyFacebookCandidates"][0]["ledgerPresent"])
        self.assertIn(("CollectionRun", "filter", {"plan_id": 7, "run_kind": "plan_collection"}), connection.queries)

    def test_limits_apply_to_runs_steps_streams_and_request_ids(self):
        connection, models, runs, steps = fixture(run_count=LIMIT + 3, step_count=LIMIT + 2)
        streams = runs[0]["platform_scope"]["_facebook_page_requests"]["streams"]
        entry = copy.deepcopy(next(iter(streams.values())))
        streams.update({str(index) + PRIVATE: copy.deepcopy(entry) for index in range(LIMIT + 2)})
        steps[0]["params"]["_collector"]["request_ids"] = [REQUEST_ID] * (LIMIT + 5)
        result = MODULE["inspect_delta"](connection, models, PLAN_ID)
        self.assertEqual(len(result["recentRuns"]), LIMIT)
        self.assertTrue(result["recentRunsTruncated"])
        self.assertTrue(result["unknownRunsTruncated"])
        run = result["recentRuns"][0]
        self.assertEqual(len(run["streams"]), LIMIT)
        self.assertTrue(run["streamsTruncated"])
        self.assertEqual(len(run["steps"]), LIMIT)
        self.assertTrue(run["stepsTruncated"])
        self.assertFalse(run["stepEvidenceCounts"]["complete"])
        self.assertFalse(run["pageEvidence"]["streamCountsComplete"])
        self.assertEqual(len(run["steps"][0]["requestIds"]), LIMIT)
        self.assertTrue(run["steps"][0]["requestIdsTruncated"])
        self.assertTrue(all(limit == LIMIT + 1 for _, limit in connection.slices))
        self.assertLessEqual(len(connection.slices), 3 + 3 * LIMIT)
        self.assertNotIn(PRIVATE, json.dumps(result))

    def test_hub_urls_strip_credentials_query_fragment_and_unknown_paths(self):
        for base in ("https://username:" + PRIVATE + "@hub.example:8443/api/v2/?token=" + PRIVATE + "#" + PRIVATE,
                     "https://hub.example/" + PRIVATE + "?token=" + PRIVATE,
                     "https://username:" + PRIVATE + "@[::1]:8443/api/?token=" + PRIVATE):
            result = MODULE["safe_hub_urls"](base)
            rendered = json.dumps(result)
            self.assertNotIn(PRIVATE, rendered)
            self.assertNotIn("username", rendered)
            self.assertNotIn("@", rendered)
            self.assertNotIn("?", rendered)
            self.assertNotIn("#", rendered)
            self.assertIn("v2", result)
        self.assertEqual(MODULE["safe_hub_urls"]("https://hub.example/api/v2/")["v2"],
                         "https://hub.example/api/v2/api/v2/data/search")
        for value in ("file:///tmp/private", "https://hub.example:badport", "https://[broken", "garbage"):
            self.assertEqual(MODULE["safe_hub_urls"](value), {"error": "invalid_hub_base_url"})

    def test_summary_handles_missing_and_malformed_legacy_metadata_without_leaks(self):
        row = {"public_key": PRIVATE, "status": PRIVATE, "trigger_source": PRIVATE, "created_at": PRIVATE,
               "collected_count": True, "platform_scope": {"platform": PRIVATE, "cold_start_group_key": PRIVATE,
                    "_facebook_page_requests": {"version": PRIVATE, "streams": {PRIVATE: PRIVATE}},
                    "cold_start_redispatch_block": {"request_id": PRIVATE}}}
        step = {"public_key": PRIVATE, "params": {"platform": PRIVATE, "_collector": PRIVATE},
                "status": PRIVATE, "created_at": PRIVATE, "error_message": PRIVATE}
        result = MODULE["summarize_run"](row, [step])
        self.assertNotIn(PRIVATE, json.dumps(result))
        self.assertIsNone(result["runKey"])
        self.assertIsNone(result["collectedCount"])
        self.assertIsNone(result["steps"][0]["requestDispatched"])
        self.assertTrue(result["steps"][0]["errorPresent"])
        step["params"] = {}
        self.assertFalse(MODULE["summarize_step"](step)["modernPageMarker"])
        step["params"]["_facebook_page_request_version"] = True
        self.assertFalse(MODULE["summarize_step"](step)["modernPageMarker"])

    def test_django_shell_entry_point_reads_source_without_executing_it(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "data_hub").mkdir()
            (root / "llm").mkdir()
            (root / "data_hub/facebook_page_requests.py").write_text(
                "raise RuntimeError('must never execute')\ndef facebook_step_requires_reconciliation(step):\n    return True\n")
            (root / "llm/data_query.py").write_text("raise RuntimeError('must never execute')\n")
            connection, models, _, _ = fixture()
            models.__file__ = str(root / "data_hub/models.py")
            output = io.StringIO()
            with patch.dict(sys.modules, mock_modules(connection, models)), \
                    patch.dict(os.environ, {"MX_DIAGNOSTIC_PLAN_KEY": PLAN_ID, "MX_DIAGNOSTIC_RUN_KEY": RUN_ID,
                        "MX_DIAGNOSTIC_BLOCKER_REQUEST_ID": REQUEST_ID}), redirect_stdout(output):
                runpy.run_path(str(SCRIPT), run_name="django.core.management.commands.shell")
            result = json.loads(output.getvalue())
            self.assertTrue(result["planFound"])
            self.assertEqual(result["selectedRunKey"], RUN_ID)
            self.assertTrue(result["selectedRunFound"])
            self.assertEqual(result["specifiedBlockerRequestId"], REQUEST_ID)
            self.assertTrue(result["code"]["facebookPageRequests"]["modernStepGuardPresent"])
            self.assertTrue(result["code"]["dataQuery"]["available"])
            self.assertNotIn(PRIVATE, output.getvalue())
            self.assertEqual(connection.commands[-1], "ROLLBACK")

    def test_missing_old_code_does_not_prevent_database_report(self):
        with tempfile.TemporaryDirectory() as temporary:
            connection, models, _, _ = fixture()
            models.__file__ = str(Path(temporary) / "data_hub/models.py")
            output = io.StringIO()
            with patch.dict(sys.modules, mock_modules(connection, models)), \
                    patch.dict(os.environ, {"MX_DIAGNOSTIC_PLAN_KEY": PLAN_ID}), redirect_stdout(output):
                MODULE["main"]()
            result = json.loads(output.getvalue())
            self.assertTrue(result["planFound"])
            self.assertFalse(result["code"]["facebookPageRequests"]["available"])
            self.assertFalse(result["code"]["dataQuery"]["available"])
            self.assertNotIn(temporary, output.getvalue())

    def test_main_suppresses_raw_failure_details(self):
        connection, models, _, _ = fixture()
        connection.fail_sql = "SELECT current_database()"
        output = io.StringIO()
        with patch.dict(sys.modules, mock_modules(connection, models)), \
                patch.dict(os.environ, {"MX_DIAGNOSTIC_PLAN_KEY": PLAN_ID}), redirect_stdout(output), \
                self.assertRaises(SystemExit) as failure:
            MODULE["main"]()
        self.assertEqual(failure.exception.code, 1)
        self.assertEqual(json.loads(output.getvalue()), {"error": "diagnostic_read_failed"})
        self.assertNotIn(PRIVATE, output.getvalue())
        self.assertEqual(connection.commands[-1], "ROLLBACK")

    def test_main_missing_or_invalid_environment_identifiers_never_query(self):
        for env, error in (({"MX_DIAGNOSTIC_RUN_KEY": RUN_ID}, "valid_plan_key_required"),
                ({"MX_DIAGNOSTIC_PLAN_KEY": PLAN_ID, "MX_DIAGNOSTIC_RUN_KEY": ""}, "valid_run_key_required"),
                ({"MX_DIAGNOSTIC_PLAN_KEY": PLAN_ID, "MX_DIAGNOSTIC_BLOCKER_REQUEST_ID": PRIVATE}, "valid_blocker_request_id_required")):
            connection, models, _, _ = fixture()
            output = io.StringIO()
            with self.subTest(env=env), patch.dict(sys.modules, mock_modules(connection, models)), \
                    patch.dict(os.environ, env, clear=True), redirect_stdout(output), self.assertRaises(SystemExit):
                MODULE["main"]()
            self.assertEqual(json.loads(output.getvalue()), {"error": error})
            self.assertEqual(connection.commands, [])
            self.assertEqual(connection.queries, [])

    def test_script_has_no_mutations_http_calls_or_task_dispatch(self):
        tree = ast.parse(SCRIPT.read_text())
        methods = {node.func.attr for node in ast.walk(tree)
                   if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)}
        self.assertFalse(methods & {"save", "update", "create", "delete", "delay", "apply_async", "send_task",
                                    "post", "put", "patch", "get_or_create", "update_or_create", "commit"})
        imports = {alias.name for node in ast.walk(tree) if isinstance(node, ast.Import) for alias in node.names}
        self.assertFalse(imports & {"requests", "httpx", "urllib.request", "celery", "subprocess", "socket"})


if __name__ == "__main__":
    unittest.main()
