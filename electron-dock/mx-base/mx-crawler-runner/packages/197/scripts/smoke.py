import json
from pathlib import Path
from mingxi_market_197 import collect

result=collect(['40439'])
path=Path('data/verification/live.json')
path.parent.mkdir(parents=True,exist_ok=True)
path.write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
print(result['status'],path)
raise SystemExit(0 if result['status']=='success' and result['data']['items'] else 1)
