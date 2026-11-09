"""Explicit bounded calls; no network by default."""
import argparse, json
from audiosource_222 import invoke
parser=argparse.ArgumentParser()
parser.add_argument('--operation',choices=['stats','discover','collect','list_records','download'],default='stats')
parser.add_argument('--run-dir',required=True)
args=parser.parse_args()
params={'run_dir':args.run_dir}
if args.operation=='discover':params.update({'limit': 3, 'offset': 0})
result=invoke({'operation':args.operation,'params':params})
print(json.dumps(result,ensure_ascii=False))
raise SystemExit(0 if result['status'] in {'success','no_data'} else 1)
