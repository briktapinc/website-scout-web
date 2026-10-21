#!/usr/bin/env python3
import json
import urllib.error
import urllib.request

url = "https://bitpype.com/api/v1/portal/access"
payload = json.dumps({"email": "elyayertey@gmail.com"}).encode()
req = urllib.request.Request(
    url,
    data=payload,
    headers={"Content-Type": "application/json"},
    method="POST",
)
try:
    with urllib.request.urlopen(req, timeout=30) as r:
        print(r.status, r.read().decode())
except urllib.error.HTTPError as e:
    print("HTTP", e.code, e.read().decode())
except Exception as e:
    print("ERR", e)
