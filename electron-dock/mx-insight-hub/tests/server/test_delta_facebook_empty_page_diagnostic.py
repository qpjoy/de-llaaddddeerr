import ast
import json
from pathlib import Path
import runpy
from types import SimpleNamespace
import unittest
from uuid import uuid4

SCRIPT = Path(__file__).resolve().parents[2] / "server/ops/diagnose-delta-facebook-empty-page.py"
MODULE = runpy.run_path(str(SCRIPT), run_name="delta_empty_page_test")
inspect_delta = MODULE["inspect_delta"]
STEP_ID, PLAN_ID, HUB_ID = (MODULE[key] for key in ("STEP_ID", "PLAN_ID", "HUB_REQUEST_ID"))
PRIVATE = "private-query-token-cursor-content"


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

    def fetchone(self):
        return (PRIVATE, "10.0.0.2", 5432, "2026-10-17T09:00:00Z")


class Connection:
    vendor, alias, in_atomic_block = "postgresql", "default", False

    def __init__(self):
        self.commands, self.queries = [], []

    def cursor(self):
        return Cursor(self)

    def get_autocommit(self):
        return True


class Query:
    """Read-only ORM boundary; execute the real diagnostic and its projections."""
    def __init__(self, connection, rows, fields=None):
        self.connection, self.rows, self.fields = connection, rows, fields

    def using(self, alias):
        assert alias == "default"
        assert self.connection.commands[0].endswith("REPEATABLE READ READ ONLY")
        return self

    def filter(self, **filters):
        self.connection.queries.append(filters)
        return Query(self.connection, [row for row in self.rows if all(row.get(key) == value for key, value in filters.items())])

    def values(self, *fields):
        assert "params" not in fields and "platform_scope" not in fields
        assert all("log" not in name and "error_message" not in name for name in fields)
        return Query(self.connection, self.rows, fields)

    def first(self):
        return next(iter(self), None)

    def order_by(self, *fields):
        return self

    def count(self):
        return len(self.rows)

    def __iter__(self):
        return iter([{key: row[key] for key in self.fields} for row in self.rows])

    def __getitem__(self, item):
        return list(self)[item]


def fixture(*, found=True, plan=PLAN_ID, plan_exists=True):
    connection = Connection()
    group, run_id, task_id = str(uuid4()), str(uuid4()), str(uuid4())
    row = dict.fromkeys(MODULE["STEP_FIELDS"])
    row.update({"public_key": STEP_ID, "run_id": 42, "status": "failed", "order": 0, "collected_count": 0,
                "params__platform": "facebook", "params___collector__page_number": 1,
                "params__startTime": "2026-09-17T00:00:00Z", "params__endTime": "2026-10-17T00:00:00Z",
                "params___collector__pages_done": 0, "params___collector__request_ids": [HUB_ID],
                "run__public_key": run_id, "run__plan_id": 7, "run__plan__public_key": plan,
                "run__plan__enabled": True, "run__status": "failed", "run__trigger_source": "cold_start",
                "run__celery_task_id": task_id, "run__collected_count": 0,
                "run__platform_scope__platform": "facebook", "run__platform_scope__cold_start_group_key": group,
                "run__platform_scope__cold_start_window": {"start": "2026-09-17T00:00:00Z", "end": "2026-10-17T00:00:00Z"},
                "run__platform_scope__cold_start_paging": {"page_number": 1, "pages_completed": 0,
                    "has_more": None, "exhausted": False, "pagination": {"next_cursor": PRIVATE}},
                "created_at": None, "params": {"query": PRIVATE}, "log": PRIVATE})
    retry = {**row, "public_key": str(uuid4())}
    state = {"plan_id": 7, "platform": "facebook", "status": "failed", "group_key": group,
             "attempt_count": 1, "retained_content_count": 0, "completed_at": None, "updated_at": None}
    run = {"public_key": run_id, "plan_id": 7, "trigger_source": "cold_start", "platform_scope__cold_start_group_key": group,
           "status": "failed", "collected_count": 0}
    models = SimpleNamespace(
        CollectionPlan=SimpleNamespace(objects=Query(connection, [{"id": 7, "public_key": PLAN_ID}] if plan_exists else [])),
        CollectionRunSpiderStep=SimpleNamespace(objects=Query(connection, [row, retry] if found else [])),
        CollectionPlanColdStartState=SimpleNamespace(objects=Query(connection, [state])),
        CollectionRun=SimpleNamespace(objects=Query(connection, [run])),
    )
    return connection, models, row


class DiagnosticTest(unittest.TestCase):
    def test_exact_association_paging_and_retry_observations_without_private_data(self):
        connection, models, row = fixture()
        before = json.dumps(row, sort_keys=True)
        result = inspect_delta(connection, models)
        self.assertTrue(result["found"])
        self.assertTrue(result["association"]["expectedPlanMatches"])
        self.assertTrue(result["originalStep"]["hubRequestIdRecorded"])
        self.assertTrue(result["coldStartGroup"]["stateGroupMatches"])
        self.assertEqual(result["sameRunPage1StepCount"], 2)
        self.assertFalse(result["brokerStateChecked"])
        self.assertFalse(result["hubDateWindowChecked"])
        self.assertFalse(result["windowCoverageVerified"])
        self.assertEqual(result["run"]["paging"]["pagesCompleted"], 0)
        self.assertTrue(result["run"]["paging"]["nextCursorPresent"])
        self.assertEqual(result["originalStep"]["windowStart"], "2026-09-17T00:00:00+00:00")
        self.assertEqual(result["originalStep"]["windowEnd"], "2026-10-17T00:00:00+00:00")
        self.assertEqual(result["run"]["window"], {"start": result["originalStep"]["windowStart"], "end": result["originalStep"]["windowEnd"]})
        self.assertNotIn(PRIVATE, json.dumps(result))
        self.assertEqual(json.dumps(row, sort_keys=True), before)
        self.assertEqual(connection.commands, ["BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
            "SET LOCAL statement_timeout = '5s'", "SET LOCAL lock_timeout = '1s'",
            "SET LOCAL idle_in_transaction_session_timeout = '10s'",
            "SELECT current_database(), inet_server_addr()::text, inet_server_port(), now()", "ROLLBACK"])
        self.assertEqual(connection.queries[0], {"public_key": STEP_ID})

    def test_missing_and_wrong_plan_do_not_expand_queries(self):
        for args in ({"found": False, "plan_exists": False}, {"plan": str(uuid4())}):
            connection, models, _ = fixture(**args)
            result = inspect_delta(connection, models)
            self.assertEqual(len(connection.queries), 2 if args.get("found") is False else 1)
            self.assertNotIn("run", result)
            self.assertEqual(connection.commands[-1], "ROLLBACK")

    def test_missing_step_distinguishes_plan_presence_without_guessing_deletion_or_leaking_db_config(self):
        for exists in (False, True):
            connection, models, _ = fixture(found=False, plan_exists=exists)
            result = inspect_delta(connection, models, "prod")
            self.assertFalse(result["found"])
            self.assertEqual(result["configuredEnvironmentLabel"], "prod")
            self.assertRegex(result["databaseIdentitySha256"], r"^[0-9a-f]{64}$")
            self.assertNotIn(PRIVATE, json.dumps(result))
            self.assertNotIn("10.0.0.2", json.dumps(result))
            missing = result["missingStepContext"]
            self.assertEqual(missing["expectedPlanFound"], exists)
            self.assertEqual(missing["planRunCount"], 1 if exists else None)
            self.assertEqual(missing["planStepCount"], 0 if exists else None)
            self.assertFalse(missing["deletionHistoryChecked"])
            self.assertEqual(connection.commands[-1], "ROLLBACK")
        connection, models, _ = fixture(found=False)
        self.assertIsNone(inspect_delta(connection, models, "postgres://user:password@host/db")["configuredEnvironmentLabel"])

    def test_missing_old_request_metadata_is_not_a_false_match_and_no_broker_check(self):
        connection, models, row = fixture()
        row["params___collector__request_ids"] = []
        row["params___collector__failed_request_id"] = PRIVATE
        row["run__celery_task_id"] = PRIVATE
        result = inspect_delta(connection, models)
        self.assertFalse(result["originalStep"]["hubRequestIdRecorded"])
        self.assertIsNone(result["run"]["celeryTaskId"])
        self.assertTrue(result["run"]["celeryTaskIdPresent"])
        self.assertFalse(result["brokerStateChecked"])
        self.assertNotIn(PRIVATE, json.dumps(result))

    def test_query_failure_rolls_back_and_source_has_no_mutation_or_external_clients(self):
        connection, models, row = fixture()
        del row["run__status"]
        with self.assertRaises(KeyError):
            inspect_delta(connection, models)
        self.assertEqual(connection.commands[-1], "ROLLBACK")
        tree = ast.parse(SCRIPT.read_text())
        calls = {node.func.attr for node in ast.walk(tree) if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)}
        self.assertFalse(calls & {"save", "update", "create", "delete", "delay", "apply_async", "send_task", "inspect", "post"})
        imports = {node.module for node in ast.walk(tree) if isinstance(node, ast.ImportFrom)}
        self.assertEqual(imports, {"datetime", "uuid", "django.db", "django.conf", "data_hub"})
        connection.vendor = "sqlite"
        with self.assertRaisesRegex(ValueError, "postgresql_required"):
            inspect_delta(connection, models)


if __name__ == "__main__":
    unittest.main()
