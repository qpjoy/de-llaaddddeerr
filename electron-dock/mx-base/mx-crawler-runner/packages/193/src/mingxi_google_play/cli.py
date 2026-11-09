"""Command line interface; stdout contains only the result JSON."""
import argparse
import json
from pathlib import Path
from .client import collect, OPERATIONS


def main() -> int:
    parser = argparse.ArgumentParser(description='Google Play public data — source row 193')
    parser.add_argument('operation', choices=OPERATIONS)
    for name in ('app_id', 'term', 'developer_id', 'num', 'next_page_token', 'category'):
        parser.add_argument('--' + name.replace('_', '-'), type=int if name == 'num' else str)
    for name, default, kind in [('lang', 'en', str), ('country', 'us', str), ('sort', 'newest', str),
            ('collection', 'TOP_FREE', str), ('max_pages', 1, int), ('timeout', 90, float),
            ('request_timeout', 15, float), ('max_requests', 20, int), ('work_dir', 'data', str),
            ('runtime_dir', '.runtime', str)]:
        parser.add_argument('--' + name.replace('_', '-'), default=default, type=kind)
    parser.add_argument('--direct', action='store_true', help='Ignore environment proxy; use direct connection')
    parser.add_argument('--output', type=Path)
    args = vars(parser.parse_args())
    output = args.pop('output')
    args['proxy'] = '' if args.pop('direct') else None
    try:
        result = collect(**args)
    except ValueError as error:
        parser.error(str(error))
    text = json.dumps(result, ensure_ascii=False, indent=2)
    if output:
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(text, encoding='utf-8')
    else:
        print(text)
    return 0 if result['status'] == 'success' else 1
