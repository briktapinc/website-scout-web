from pathlib import Path
env = Path('/root/website-scout-web/.env').read_text().splitlines()
d = dict(l.split('=', 1) for l in env if '=' in l and not l.startswith('#'))
sec = d.get('SESSION_SECRET', '')
print('APP_URL=', d.get('APP_URL'))
print('NODE_ENV=', d.get('NODE_ENV'))
print('SESSION_SECRET_LEN=', len(sec))
print('SESSION_OK=', len(sec) >= 24 and sec != 'dev-change-me')
