from pathlib import Path

p = Path('/etc/nginx/nginx.conf')
lines = p.read_text().splitlines(True)
out = []
for ln in lines:
    stripped = ln.strip()
    # Drop the broken leftover map line from a prior bad sed
    if stripped.startswith('map') and '$http_upgrade' not in stripped and 'connection_upgrade' not in stripped:
        continue
    out.append(ln)
p.write_text(''.join(out))
print('removed broken map line(s)')
print(''.join(out[11:22]))
