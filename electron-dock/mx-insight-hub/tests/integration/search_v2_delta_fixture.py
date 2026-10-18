"""Java fixture -> actual Delta business windows and wire builders, no ORM/network."""
import ast
from datetime import datetime, timedelta
import json
from pathlib import Path
import sys
from types import SimpleNamespace as NS
from unittest.mock import patch
from zoneinfo import ZoneInfo

delta, fixture_path = map(Path, sys.argv[1:3])
sys.path.insert(0, str(delta))
from data_hub.cold_start_range import cold_start_window
from data_hub.tests_facebook_cold_start_window import load, HELPER
from data_hub.tests_facebook_incremental_window import Runs
from llm.search_contract import SEARCH_CONTRACT_KEY, freeze_search_contract, search_plan_config
from llm.tests_facebook_hub_window import actual_dispatch_namespace

fixture = json.loads(fixture_path.read_text())
body = fixture['plan_create']
end = datetime.fromisoformat(fixture['run_created_at'])
plan = NS(monitor_target_type='content', spider_config=search_plan_config(body), runs=Runs())
assert plan.spider_config['search_api_version'] == 'v2'
assert body['cold_start_range'] == '30d'
ns = load('data_hub/facebook_collection.py', ['freeze_new_search_contract'],
          {**HELPER, 'timedelta': timedelta, 'ZoneInfo': ZoneInfo})
freeze_run = ns['freeze_new_search_contract']
dispatch = actual_dispatch_namespace()
# Use the production platform set, not the narrower Facebook unit-test seam.
tree = ast.parse((delta / 'llm/data_query.py').read_text())
constant = next(node for node in tree.body if isinstance(node, ast.Assign)
                and any(isinstance(target, ast.Name) and target.id == 'HUB_STANDARD_SEARCH_PLATFORMS' for target in node.targets))
exec(compile(ast.Module(body=[constant], type_ignores=[]), '<platform-set>', 'exec'), dispatch)
cases = []


def add(kind, platform, marker):
    source = {'platform': platform, 'query': body['topic'], 'count': 20, SEARCH_CONTRACT_KEY: marker}
    wire = dispatch['hub_search_request_payload']('raw', source)
    assert dispatch['hub_search_request_path']('raw', source) == '/api/v2/data/search'
    assert wire['timeWindow'] == marker['timeWindow']
    cases.append({'kind': kind, 'platform': platform, 'wire': wire})


for platform in body['platforms']:
    for kind in ('cold_start', 'scheduled'):
        scope = {'platform': platform, 'queries': [body['topic']], 'query_revision': 1}
        if kind == 'cold_start':
            start, stop = cold_start_window(body['cold_start_range'], end)
            scope['cold_start_window'] = {'start': start.isoformat(), 'end': stop.isoformat()}
        run = NS(run_kind='plan_collection', trigger_source=kind, plan=plan, platform_scope=scope, created_at=end)
        freeze_run(run)
        saved = json.loads(json.dumps(run.platform_scope[SEARCH_CONTRACT_KEY]))
        run.created_at += timedelta(days=3)
        freeze_run(run)
        assert run.platform_scope[SEARCH_CONTRACT_KEY] == saved, 'retry shifted a persisted window'
        add(kind, platform, saved)

with patch.dict(sys.modules, {'json_repair': NS(loads=json.loads)}):
    from agent_sources.monitoring_daily.v16.logic import inputs
    daily = inputs(fixture['daily_report'], body['platforms'], now=end + timedelta(minutes=1))
for direction in daily['directions']:
    assert direction['search_api_version'] == 'v2'
    for platform in direction['platforms']:
        add('daily_report', platform, freeze_search_contract(direction['from'], direction['to'], direction['timezone']))

legacy = dispatch['hub_search_request_payload']('raw', {'platform': 'facebook', 'query': body['topic'], 'count': 20})
assert legacy == {'platform': 'facebook', 'query': body['topic'], 'pageSize': 20}
assert dispatch['hub_search_request_path']('raw', legacy) == '/api/v1/data/search'
print(json.dumps({'cases': cases, 'legacy': legacy}, ensure_ascii=False))
