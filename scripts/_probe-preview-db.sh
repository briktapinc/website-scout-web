#!/bin/sh
set -e
DB=/app/data/workspaces/1/websitescout.db
echo "=== websites ==="
sqlite3 "$DB" "SELECT id, name, COALESCE(preview_url,'(null)'), COALESCE(preview_path,'(null)'), status FROM websites LIMIT 20;"
echo "=== cf settings ==="
sqlite3 "$DB" "SELECT key, CASE WHEN key='cf.api_token' THEN '(set len='||length(value)||')' ELSE value END FROM settings WHERE key LIKE 'cf.%';"
echo "=== platform defaults cf ==="
python3 - <<'PY'
import json
p='/app/data/workspaces/platform-defaults.json'
try:
  d=json.load(open(p))
except Exception as e:
  print('no defaults', e); raise SystemExit
items = d if isinstance(d, list) else (d.get('settings') or d.get('defaults') or d)
if isinstance(items, dict):
  items=[{'key':k,'value':v} for k,v in items.items()]
for x in items:
  k=x.get('key') if isinstance(x,dict) else None
  if k and str(k).startswith('cf.'):
    v=x.get('value','')
    if k=='cf.api_token':
      print(k, '(set)' if v else '(empty)')
    else:
      print(k, '=', v)
PY
