import json
from mingxi_google_play import collect

result = collect('app', app_id='com.google.android.apps.translate')
print(json.dumps(result, ensure_ascii=False, indent=2))
raise SystemExit(0 if result['status'] == 'success' else 1)
