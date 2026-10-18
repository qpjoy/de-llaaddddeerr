import copy
from contextlib import nullcontext, redirect_stdout
import io
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch


PATH = Path(__file__).resolve().parents[2] / "server/ops/verify-twitter-query-compat.py"
SPEC = importlib.util.spec_from_file_location("twitter_compat_check", PATH)
CHECK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECK)
ORIGINAL = (
    '("外交" OR "外交部" OR "外交政策" OR "外交关系" OR "外交动态" OR "外交表态" '
    'OR "外交事件" OR "外交议题" OR "外交回应" OR "外交澄清") '
    'AND NOT ("广告" OR "营销" OR "重复搬运") AND '
    '(("diplomacy" OR "foreign policy" OR "diplomatic relations") AND '
    '("statement" OR "response" OR "clarification" OR "update") -ad -marketing -repost)'
)


def rejection(**changes):
    body = {"error": {"code": "social_upstream_rejected", "message": "supplier refused",
                     "details": {"upstreamStatus": 400, "outcome": "rejected", "retryable": False,
                                 "requestId": CHECK.REQUEST_ID}}, "requestId": CHECK.REQUEST_ID}
    body["error"]["details"].update(changes)
    return (f"data_query.hub_standard_request_failed status=502 request_id={CHECK.REQUEST_ID} "
            f"operation=raw platform=twitter message={body}")


def payload():
    return {"platform": "twitter", "keyword": ORIGINAL, "count": 20, "limit": 20, "page": 1,
            "startTime": "2026-10-15T09:18:59.946001+00:00",
            "endTime": "2026-10-16T09:18:59.946001+00:00"}


def step():
    return SimpleNamespace(status="failed", error_message=rejection(), params={**payload(), "_collector": {
        "failed_request_id": CHECK.REQUEST_ID, "request_dispatched": True, "pages_done": 0,
        "page_number": 1, "pagination": {}, "unique_rows": 0}})


class ResponseError(Exception):
    def __init__(self, body, status):
        self.body = body
        self.status_code = status
        self.request_id = body.get("requestId")


class FakeDelta:
    def __init__(self, *, status=200, response=None, failure=None, double=False):
        self.posts = []
        self.sessions = []
        self.status, self.failure, self.double = status, failure, double
        self.response = response or {"requestId": "11111111-1111-4111-8111-111111111111",
                                   "data": {"items": [{"text": "PRIVATE TEXT"}], "pageInfo": {"hasMore": True}}}
        self.requests = SimpleNamespace(Session=self.session)
        self._hub_http_post = lambda *a, **kw: self.fail_unpatched()
        self.run_with_model_network_routes = lambda *a, **kw: self.fail_unpatched()

    def fail_unpatched(self):
        raise AssertionError("production transport/route fallback should be scoped")

    def hub_search_request_path(self, operation, source):
        return "/api/v2/data/search" if "_search_contract" in source else "/api/v1/data/search"

    def hub_search_request_payload(self, operation, source):
        result = {"platform": source["platform"], "query": source.get("query") or source["keyword"],
                  "pageSize": source.get("count", 20)}
        if source.get("cursor"):
            result["cursor"] = source["cursor"]
        if "_search_contract" in source:
            result["timeWindow"] = source["_search_contract"]["timeWindow"]
        return result

    def model_network_routes(self, **kwargs):
        return [SimpleNamespace(proxy_url="http://configured-route"), SimpleNamespace(proxy_url=None)]

    def session(self):
        session = SimpleNamespace(trust_env=True, proxies={}, closed=False)
        self.sessions.append(session)

        def post(url, **kwargs):
            self.posts.append((url, kwargs))
            if self.failure:
                raise self.failure
            return SimpleNamespace(status_code=self.status, json=lambda: self.response)

        session.post = post
        session.close = lambda: setattr(session, "closed", True)
        return session

    def hub_legacy_search_data(self, operation, source, *, idempotency_key):
        def send(route):
            return self._hub_http_post("https://configured-hub/api/search", payload=self.hub_search_request_payload(operation, source),
                headers={"Authorization": "Bearer SECRET TOKEN", "Idempotency-Key": idempotency_key},
                timeout=90, proxy_url=route.proxy_url)
        response = self.run_with_model_network_routes(send, target_url="https://configured-hub/api/search")
        if self.double:
            self.run_with_model_network_routes(send, target_url="https://configured-hub/api/search")
        if response.status_code != 200:
            raise ResponseError(self.response, response.status_code)
        return response.json()


class TwitterCompatibilityVerificationTests(unittest.TestCase):
    def snapshot(self, *, scope=None, item=None):
        item = item or step()
        scope = scope or {"platform": "twitter"}

        class Rows(list):
            def filter(self, **kwargs):
                self.last_filter = kwargs
                return self
            def order_by(self, *args):
                return self
            def values_list(self, *args, **kwargs):
                return self

        steps = Rows([item])
        run = SimpleNamespace(status="failed", trigger_source="cold_start", run_kind="plan_collection",
                              plan=SimpleNamespace(monitor_target_type="content", enabled=True, expire_time=None,
                                                   runs=Rows([scope])), collected_count=0, platform_scope=scope,
                              spider_steps=steps)
        manager = SimpleNamespace(select_related=lambda *a: SimpleNamespace(get=lambda **kw: run))
        modules = {"django": SimpleNamespace(), "django.db": SimpleNamespace(
            connection=SimpleNamespace(vendor="sqlite"), transaction=SimpleNamespace(atomic=nullcontext)),
            "django.utils": SimpleNamespace(timezone=SimpleNamespace(now=lambda: None)),
            "data_hub": SimpleNamespace(), "data_hub.models": SimpleNamespace(CollectionRun=SimpleNamespace(objects=manager))}
        with patch.dict(sys.modules, modules):
            result = CHECK.load_snapshot()
        self.assertEqual(steps.last_filter["params___collector__failed_request_id"], CHECK.REQUEST_ID)
        return result

    def test_snapshot_accepts_saved_v1_failure_without_modern_ledger(self):
        source, evidence = self.snapshot()
        self.assertEqual(source, payload())
        self.assertFalse(evidence["hasDurablePageLedger"])
        self.assertIsNone(evidence["originalIdempotencyKeySha256"])

    def test_snapshot_v2_requires_exact_original_ledger(self):
        original = step()
        original.params["_search_contract"] = {"version": 2, "timeWindow": {"from": "fixture"}}
        with self.assertRaises(CHECK.VerificationRefused):
            self.snapshot(item=original)
        page = CHECK.page_payload(original)
        scope = {"platform": "twitter", CHECK.LEDGER_KEY: {"version": 1, "streams": {"original": {
            "payload": page, "state": "pending", "page_number": 1, "request_id": "", "idempotency_key": "original-page"}}}}
        source, evidence = self.snapshot(scope=scope, item=original)
        self.assertEqual(source, page)
        self.assertEqual(evidence["originalIdempotencyKeySha256"], CHECK.digest("original-page"))
        for state in ("unknown", "delivered"):
            changed = copy.deepcopy(scope)
            changed[CHECK.LEDGER_KEY]["streams"]["original"]["state"] = state
            with self.subTest(state=state), self.assertRaises(CHECK.VerificationRefused):
                self.snapshot(scope=changed, item=original)

    def test_snapshot_never_treats_unknown_as_saved_rejection(self):
        scope = {"platform": "twitter", CHECK.BLOCK_KEY: {"code": "request_outcome_unknown"}}
        with self.assertRaises(CHECK.VerificationRefused):
            self.snapshot(scope=scope)

    def test_original_and_reviewed_candidate_keep_all_literal_conditions(self):
        self.assertEqual(CHECK.digest(ORIGINAL), CHECK.QUERY_SHA256)
        expected = ORIGINAL.replace('AND NOT ("广告" OR "营销" OR "重复搬运")', '-"广告" -"营销" -"重复搬运"')
        expected = expected.replace(" AND ", " ").replace('(("diplomacy"', '("diplomacy"')[:-1]
        self.assertEqual(CHECK.CANDIDATE, expected)
        self.assertEqual(len(CHECK.CANDIDATE), 257)

    def test_candidate_matches_production_hub_compiler_exactly(self):
        module = (PATH.parent.parent / "contracts/twitter-search-query.mjs").as_uri()
        code = ("import { compileTwitterSearchQuery } from " + json.dumps(module)
                + "; let input=''; for await (const chunk of process.stdin) input+=chunk; "
                  "process.stdout.write(compileTwitterSearchQuery(JSON.parse(input)).providerQuery);")
        result = subprocess.run(["node", "--input-type=module", "-e", code], input=json.dumps(ORIGINAL),
                                text=True, capture_output=True, check=True)
        self.assertEqual(result.stdout, CHECK.CANDIDATE)

    def test_default_dry_run_does_not_send_or_mutate_payload(self):
        source, fake = payload(), FakeDelta()
        before = copy.deepcopy(source)
        result = CHECK.verify(source, fake)
        self.assertEqual(source, before)
        self.assertEqual(fake.posts, [])
        self.assertEqual(result["mode"], "dry_run")
        self.assertFalse(result["mayConsumeQuota"])
        self.assertEqual(result["deltaBusinessWrites"], 0)

    def test_live_uses_existing_auth_first_route_once_without_redirects(self):
        fake = FakeDelta()
        result = CHECK.verify(payload(), fake, execute=True, case="control")
        self.assertEqual(result["outcome"], "delivered")
        self.assertEqual(result["resultCount"], 1)
        self.assertTrue(result["hasMore"])
        self.assertEqual(len(fake.posts), 1)
        self.assertEqual(fake.posts[0][1]["headers"]["Authorization"], "Bearer SECRET TOKEN")
        self.assertIs(fake.posts[0][1]["allow_redirects"], False)
        self.assertFalse(fake.sessions[0].trust_env)
        self.assertEqual(fake.sessions[0].proxies, {"http": "http://configured-route", "https": "http://configured-route"})
        self.assertTrue(fake.sessions[0].closed)
        rendered = json.dumps(result)
        for withheld in ("SECRET", "PRIVATE TEXT", ORIGINAL, CHECK.CANDIDATE, "configured-route", "configured-hub"):
            self.assertNotIn(withheld, rendered)
        self.assertFalse(result["coldStartResumed"])

    def test_fixed_idempotency_identity_stable_across_invocations(self):
        a = CHECK.verify(payload(), FakeDelta())
        b = CHECK.verify(payload(), FakeDelta())
        self.assertEqual(a["idempotencyKey"], b["idempotencyKey"])
        self.assertEqual(a["idempotencyKey"], "delta-twitter-compat-9550db06c446a75a9d5640d5941925250a2e2aae")
        self.assertEqual(a["case"], "candidate")

    def test_explicit_control_is_one_separate_fixed_query_not_cold_start_recovery(self):
        source, fake = payload(), FakeDelta()
        before = copy.deepcopy(source)
        result = CHECK.verify(source, fake, execute=True, case="control")
        self.assertEqual(source, before)
        self.assertEqual(len(fake.posts), 1)
        self.assertEqual(fake.posts[0][1]["json"], {"platform": "twitter", "query": "OpenAI", "pageSize": 20, "type": "stable"})
        self.assertEqual(result["case"], "control")
        self.assertFalse(result["isProductionQuery"])
        self.assertFalse(result["coldStartResumed"])
        self.assertEqual(result["queryPurpose"], "supplier_availability_control")
        self.assertEqual(result["retentionModeOverride"], "stable")
        self.assertEqual(result["candidateQuerySha256"], CHECK.digest("OpenAI"))
        self.assertNotEqual(result["idempotencyKey"], CHECK.verify(source, FakeDelta())["idempotencyKey"])
        self.assertEqual(result["idempotencyKey"], CHECK.verify(source, FakeDelta(), case="control")["idempotencyKey"])

    def test_control_remains_dry_by_default_and_unknown_cases_refused(self):
        fake = FakeDelta()
        result = CHECK.verify(payload(), fake, case="control")
        self.assertEqual(result["mode"], "dry_run")
        self.assertEqual(fake.posts, [])
        with self.assertRaises(CHECK.VerificationRefused):
            CHECK.verify(payload(), fake, execute=True, case="both")
        self.assertEqual(fake.posts, [])

    def test_live_candidate_is_disabled_even_with_execution_permission(self):
        fake = FakeDelta()
        with self.assertRaisesRegex(CHECK.VerificationRefused, "candidate_already_rejected_no_more_dispatch"):
            CHECK.verify(payload(), fake, execute=True)
        self.assertEqual(fake.posts, [])

    def test_main_default_execute_env_cannot_accidentally_repeat_candidate(self):
        fake, output = FakeDelta(), io.StringIO()
        with patch.dict(sys.modules, {"llm": SimpleNamespace(data_query=fake)}), \
                patch.object(CHECK, "load_snapshot", return_value=(payload(), {})), \
                patch.dict(os.environ, {"MX_TWITTER_QUERY_VERIFY": "1"}, clear=True), redirect_stdout(output):
            CHECK.main()
        result = json.loads(output.getvalue())
        self.assertEqual(result["mode"], "refused")
        self.assertEqual(result["errorCode"], "candidate_already_rejected_no_more_dispatch")
        self.assertEqual(fake.posts, [])

    def test_main_explicit_control_overrides_wrong_or_missing_environment(self):
        fake, output = FakeDelta(), io.StringIO()
        with patch.dict(sys.modules, {"llm": SimpleNamespace(data_query=fake)}), \
                patch.object(CHECK, "load_snapshot", return_value=(payload(), {"hasDurablePageLedger": False})), \
                patch.dict(os.environ, {"MX_TWITTER_QUERY_VERIFY": "0", "MX_TWITTER_QUERY_VERIFY_CASE": "candidate"}, clear=True), \
                redirect_stdout(output):
            CHECK.main(case="control", execute=True)
        result = json.loads(output.getvalue())
        self.assertEqual(result["diagnosticRevision"], "twitter-query-compat-check.v2")
        self.assertEqual(result["case"], "control")
        self.assertFalse(result["isProductionQuery"])
        self.assertEqual(fake.posts[0][1]["json"], {"platform": "twitter", "query": "OpenAI", "pageSize": 20, "type": "stable"})
        self.assertEqual(len(fake.posts), 1)

    def test_revision_checked_entrypoint_does_not_run_old_main(self):
        # This is the exact guard used by the explicit Django shell -c wrapper.
        wrapper = ("n={'__name__':'twitter_compat_payload'}; exec(compile(sys.stdin.read(),'<twitter-query-check>','exec'),n); "
                   "n.get('REVISION')=='twitter-query-compat-check.v2' or sys.exit('Outdated diagnostic; no HTTP sent'); "
                   "n['main'](case='control',execute=True)")
        old = "REVISION='twitter-query-compat-check.v1'\ndef main():\n raise RuntimeError('must not dispatch')\n"
        with patch.object(sys, "stdin", io.StringIO(old)), self.assertRaisesRegex(SystemExit, "Outdated diagnostic"):
            exec(wrapper, {"sys": sys})

    def test_transport_timeout_does_not_try_second_route(self):
        fake = FakeDelta(failure=TimeoutError("PRIVATE URL TOKEN"))
        result = CHECK.verify(payload(), fake, execute=True, case="control")
        self.assertEqual(len(fake.posts), 1)
        self.assertEqual(result["errorCode"], "transport_or_response_error")
        self.assertFalse(result["automaticRetryAllowed"])
        self.assertNotIn("PRIVATE", json.dumps(result))

    def test_second_helper_dispatch_refused_before_http(self):
        fake = FakeDelta(double=True)
        result = CHECK.verify(payload(), fake, execute=True, case="control")
        self.assertEqual(len(fake.posts), 1)
        self.assertEqual(result["errorCode"], "second_or_changed_http_attempt_refused")

    def test_upstream_rejection_is_printed_without_error_text_or_body(self):
        body = {"requestId": CHECK.REQUEST_ID, "error": {"code": "social_upstream_rejected", "message": "PRIVATE",
                "details": {"upstreamStatus": 400, "requestId": "original-acquisition-id"}}}
        result = CHECK.verify(payload(), FakeDelta(status=502, response=body), execute=True, case="control")
        self.assertEqual(result["httpStatus"], 502)
        self.assertEqual(result["upstreamStatus"], 400)
        self.assertEqual(result["errorCode"], "social_upstream_rejected")
        self.assertEqual(result["detailsRequestId"], "original-acquisition-id")
        self.assertEqual(result["requestId"], CHECK.REQUEST_ID)
        self.assertNotIn("PRIVATE", json.dumps(result))

    def test_redirect_is_terminal(self):
        fake = FakeDelta(status=307)
        result = CHECK.verify(payload(), fake, execute=True, case="control")
        self.assertEqual(result["httpStatus"], 307)
        self.assertEqual(len(fake.posts), 1)

    def test_200_empty_partial_page_is_not_reported_as_complete_coverage(self):
        body = {"data": {"items": [], "status": "partial", "pageInfo": {"hasMore": True},
                "warnings": [{"code": "PUBLISHED_TIME_UNAVAILABLE", "message": "PRIVATE TEXT"}],
                "meta": {"effectiveWindow": {"upstreamFiltering": "unsupported", "deliveryFiltering": "exact"},
                         "capabilities": {"coverageComplete": False},
                         "limitations": [{"code": "source_coverage_not_guaranteed"}], "providerCalls": 2}}}
        result = CHECK.verify(payload(), FakeDelta(response=body), execute=True, case="control")
        self.assertEqual(result["resultCount"], 0)
        self.assertEqual(result["dataStatus"], "partial")
        self.assertEqual(result["warningCodes"], ["PUBLISHED_TIME_UNAVAILABLE"])
        self.assertEqual(result["effectiveWindow"]["upstreamFiltering"], "unsupported")
        self.assertIs(result["coverageComplete"], False)
        self.assertEqual(result["providerCalls"], 2)
        self.assertNotIn("PRIVATE TEXT", json.dumps(result))

    def test_changed_query_cursor_page_size_and_alias_are_refused(self):
        for changes in ({"keyword": "外交"}, {"cursor": "saved-cursor"}, {"page": 2},
                        {"count": 10}, {"query": ORIGINAL, "keyword": "other"}):
            with self.subTest(changes=changes), self.assertRaises(CHECK.VerificationRefused):
                CHECK.verify({**payload(), **changes}, FakeDelta(), execute=True, case="control")

    def test_v2_preserves_frozen_window_and_query_only_changes(self):
        contract = {"version": 2, "timeWindow": {"from": "2026-10-15T09:18:59.946Z",
                    "to": "2026-10-16T09:18:59.946Z", "timezone": "Asia/Shanghai", "boundary": "[from,to)"}}
        source = {**payload(), "_search_contract": contract}
        candidate, wire, path, key = CHECK.prepare(source, FakeDelta())
        self.assertEqual(candidate["_search_contract"], contract)
        self.assertEqual(wire["timeWindow"], contract["timeWindow"])
        self.assertEqual(path, "/api/v2/data/search")
        self.assertNotEqual(key, CHECK.prepare(payload(), FakeDelta())[3])

    def test_only_saved_structured_400_is_accepted(self):
        CHECK.saved_rejection(rejection())
        for changes in ({"upstreamStatus": 500}, {"outcome": "unknown"}, {"retryable": True},
                        {"requestId": "different"}, {"upstreamStatus": "400"}):
            with self.subTest(changes=changes), self.assertRaises(CHECK.VerificationRefused):
                CHECK.saved_rejection(rejection(**changes))
        with self.assertRaises(CHECK.VerificationRefused):
            CHECK.saved_rejection("__import__('os').system('echo must-not-run')")

    def test_original_step_requires_first_page_zero_ingested_and_matching_request(self):
        original = step()
        self.assertEqual(CHECK.page_payload(original), payload())
        for field, value in (("pages_done", 1), ("failed_request_id", "other"), ("page_number", 2),
                             ("request_dispatched", False), ("unique_rows", 1), ("pagination", {"cursor": "x"})):
            changed = step()
            changed.params["_collector"][field] = value
            with self.subTest(field=field), self.assertRaises(CHECK.VerificationRefused):
                CHECK.page_payload(changed)

    def test_unknown_cross_version_block_is_not_retry_permission(self):
        self.assertTrue(CHECK.scope_blocks_twitter({CHECK.BLOCK_KEY: {"code": "request_outcome_unknown"}}))
        self.assertTrue(CHECK.scope_blocks_twitter({"platform": "twitter", CHECK.BLOCK_KEY: {"code": "request_outcome_unknown"}}))
        self.assertFalse(CHECK.scope_blocks_twitter({"platform": "facebook", CHECK.BLOCK_KEY: {"code": "request_outcome_unknown"}}))
        self.assertTrue(CHECK.scope_blocks_twitter({CHECK.LEDGER_KEY: {"streams": {"p": {"state": "unknown", "payload": {"platform": "twitter"}}}}}))
        self.assertTrue(CHECK.scope_blocks_twitter({CHECK.LEDGER_KEY: {"streams": {"p": {"state": "unknown", "payload": {}}}}}))
        self.assertFalse(CHECK.scope_blocks_twitter({"platform": "twitter"}))


if __name__ == "__main__":
    unittest.main()
