"""Command-line entry; invokes the same collect function as the SDK."""
import argparse,json
from pathlib import Path
from .client import collect
from .config import INPUT_KINDS,MARKET


def main(argv=None):
    p=argparse.ArgumentParser(description=MARKET+' application metadata collector')
    p.add_argument('inputs',nargs='+',help='Explicit package names or numeric market identifiers')
    p.add_argument('--input-kind',choices=INPUT_KINDS,default=INPUT_KINDS[0])
    p.add_argument('--history',action='store_true')
    p.add_argument('--history-limit',type=int,default=3)
    p.add_argument('--concurrency',type=int,default=2)
    p.add_argument('--timeout',type=float,default=90)
    p.add_argument('--request-timeout',type=float,default=15)
    p.add_argument('--delay',type=float,default=.5)
    p.add_argument('--max-requests',type=int,default=50)
    p.add_argument('--work-dir',default='data')
    p.add_argument('--output',type=Path)
    args=vars(p.parse_args(argv));output=args.pop('output')
    try:result=collect(**args)
    except ValueError as exc:p.error(str(exc))
    text=json.dumps(result,ensure_ascii=False,indent=2)+'\n'
    if output:
        output.parent.mkdir(parents=True,exist_ok=True);output.write_text(text,encoding='utf-8')
    else:print(text,end='')
    return 0 if result['status']=='success' else 1
