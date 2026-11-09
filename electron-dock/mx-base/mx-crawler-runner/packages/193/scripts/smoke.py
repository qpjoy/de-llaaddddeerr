"""Real requests; run from the project directory after setup."""
import argparse
import json
from pathlib import Path
from mingxi_google_play import collect

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--all', action='store_true')
parser.add_argument('--runtime-dir', default='.runtime')
parser.add_argument('--output-dir', type=Path, default=Path('data/verification'))
args = parser.parse_args()
args.output_dir.mkdir(parents=True, exist_ok=True)
app_id = 'com.google.android.apps.translate'
jobs = [('app', {'app_id': app_id}), ('search', {'term': 'Google Translate', 'num': 3}),
        ('reviews', {'app_id': app_id})]
if args.all:
    jobs += [('list', {'category': 'TOOLS', 'num': 3}), ('developer', {'developer_id': 'Google LLC', 'num': 3}),
             ('suggest', {'term': 'translate'}), ('similar', {'app_id': app_id}),
             ('permissions', {'app_id': app_id}), ('datasafety', {'app_id': app_id}), ('categories', {})]
statuses = {}
for operation, options in jobs:
    result = collect(operation, **options, runtime_dir=args.runtime_dir)
    (args.output_dir / f'{operation}.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    statuses[operation] = result['status']
    print(operation, result['status'], len(result['data']['items']), flush=True)
(args.output_dir / 'summary.json').write_text(json.dumps(statuses, indent=2), encoding='utf-8')
raise SystemExit(0 if all(status == 'success' for status in statuses.values()) else 1)
