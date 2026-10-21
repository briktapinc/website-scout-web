#!/bin/bash
set -euo pipefail
html=$(curl -sS http://127.0.0.1:3080/portal.html)
echo "$html" | grep -o 'portal.js?v=[^"]*' | head -1
curl -sS 'http://127.0.0.1:3080/js/portal.js?v=chattabs1' -o /tmp/portal-served.js
python3 - <<'PY'
js = open('/tmp/portal-served.js', encoding='utf-8').read()
idx = js.find('modulesPaneTabs.addEventListener')
assert idx >= 0, 'handler missing from served JS'
slice = js[idx:idx+700]
assert 'isChatbot' in slice and "'settings'" in slice and "'inbox'" in slice
assert "moduleState.current !== 'bookings'" not in slice
print('served_handler_ok')
print(slice[:400])
PY
