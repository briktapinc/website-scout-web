#!/usr/bin/env bash
set -euo pipefail
umask 077
b=${1:?Pass the root-only recovery directory}
r=${2:?Pass a NEW isolated recovery directory}
db=bitpype-r19-restore-mysql
app=bitpype-r19-restore-app
test ! -e "$r"
! docker inspect "$db" >/dev/null 2>&1
! docker inspect "$app" >/dev/null 2>&1
mkdir -p "$r"/{source,workspaces,exports,evidence}
chmod 700 "$r"
cleanup(){ docker logs "$app" > "$r/app-private.log" 2>&1 || true; docker rm -f "$app" "$db" >/dev/null 2>&1 || true; }
trap cleanup EXIT
python3 - "$b" <<'PY' > "$r/evidence/archive-checks.log"
import pathlib,hashlib,sys
b=pathlib.Path(sys.argv[1]);count=0
for manifest in ['SHA256SUMS','RECOVERY_IMAGE_SHA256SUMS','SQLITE_SHA256SUMS']:
 p=b/manifest
 if not p.exists():
  if manifest=='SHA256SUMS':raise Exception('missing archive manifest')
  continue
 for line in p.read_text().splitlines():
  digest,original=line.split(None,1);original=original.lstrip('*')
  rel=pathlib.Path(original)
  if rel.is_absolute():rel=pathlib.Path(rel.name)
  if '..' in rel.parts:raise Exception('invalid checksum path')
  target=b/rel
  h=hashlib.sha256()
  with target.open('rb') as f:
   for chunk in iter(lambda:f.read(1024*1024),b''):h.update(chunk)
  if h.hexdigest()!=digest:raise Exception('recovery checksum mismatch')
  count+=1
print('Recovery checksums verified:',count)
PY
tar -xzf "$b/source-config.tar.gz" -C "$r/source"
tar -xzf "$b/workspace-assets.tar.gz" -C "$r/workspaces"
tar -xzf "$b/exports.tar.gz" -C "$r/exports"
# Online SQLite snapshots supersede raw files captured while the app was active.
for f in "$b"/sqlite/*.db; do id=$(basename "$f" .db); test -d "$r/workspaces/$id"; cp "$f" "$r/workspaces/$id/websitescout.db"; rm -f "$r/workspaces/$id/websitescout.db-wal" "$r/workspaces/$id/websitescout.db-shm"; done
docker compose --project-directory "$r/source" -f "$r/source/docker-compose.yml" config --format json > "$r/compose-private.json"
python3 - "$r" "$b" <<'PY'
import json,sys,pathlib
r=pathlib.Path(sys.argv[1]);c=json.loads((r/'compose-private.json').read_text());m=c['services']['mysql']['environment'];a=dict(x.split('=',1) for x in json.loads((pathlib.Path(sys.argv[2])/'container-inspect.json').read_text())[0]['Config']['Env'])
(r/'mysql.env').write_text('MYSQL_ROOT_PASSWORD='+m['MYSQL_ROOT_PASSWORD']+'\n')
# Retain encryption/session keys from the recovery set; no production network route exists.
a.update(MYSQL_HOST='127.0.0.1',MYSQL_PORT='3306',PORT='3000',APP_URL='https://recovery.example.invalid',BOOTSTRAP_EMAIL='',BOOTSTRAP_PASSWORD='',NODE_OPTIONS='--require=/restore-preload.cjs')
(r/'app.env').write_text(''.join(str(k)+'='+str(v)+'\n' for k,v in a.items()))
PY
chmod 600 "$r"/*.env "$r/compose-private.json"
cat > "$r/preload.cjs" <<'NODE'
require('/app/server/jobs').startScheduler=()=>{};
require('/app/server/imapPoller').startImapPoller=()=>{};
NODE
docker run -d --name "$db" --network none --memory 1g --tmpfs /var/lib/mysql:rw,nosuid,size=1g --env-file "$r/mysql.env" mysql@sha256:7dcddc01f13bab2f15cde676d44d01f61fc9f99fe7785e86196dfc07d358ae2b --event-scheduler=OFF > "$r/evidence/mysql-container.txt"
ready=0
for n in $(seq 1 90); do if docker exec "$db" sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql --protocol=TCP -h127.0.0.1 -uroot -N -e "SELECT 1"' >/dev/null 2>&1; then ready=1;break;fi;sleep 1;done
test "$ready" = 1
gzip -dc "$b/mysql-all.sql.gz" | docker exec -i "$db" sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot'
docker exec "$db" sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot -N -e "SELECT CONCAT(CHAR(67,72,69,67,75,32,84,65,66,76,69,32,96),table_schema,CHAR(96,46,96),table_name,CHAR(96,59)) FROM information_schema.tables WHERE table_schema NOT IN (\"information_schema\",\"performance_schema\",\"sys\") AND table_type=\"BASE TABLE\""' > "$r/check-tables.sql"
docker exec -i "$db" sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot -N' < "$r/check-tables.sql" > "$r/evidence/mysqlcheck.log"
! grep -E '\s(error|warning)\s' "$r/evidence/mysqlcheck.log"
docker exec "$db" sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=\"website_scout\""' > "$r/evidence/mysql-table-count.txt"
docker exec "$db" sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot -e "FLUSH PRIVILEGES"'
image=$(cat "$b/image-id.txt")
chown -R 1000:1000 "$r/workspaces" "$r/exports"
docker run --rm --user 0 --network none -v "$r/workspaces:/restore" -v "$b/sqlite:/snapshots:ro" --entrypoint node "$image" -e 'const fs=require("fs"),D=require("better-sqlite3"),crypto=require("crypto");let count=0;for(const f of fs.readdirSync("/snapshots").filter(f=>f.endsWith(".db"))){const p="/restore/"+f.slice(0,-3)+"/websitescout.db";if(!fs.readFileSync(p).equals(fs.readFileSync("/snapshots/"+f)))throw Error("snapshot mismatch");const d=new D(p,{readonly:true});if(d.pragma("integrity_check",{simple:true})!=="ok")throw Error("integrity failed");d.close();count++}console.log(JSON.stringify({sqliteSnapshots:count,integrity:true,exactSnapshotBytes:true}))' > "$r/evidence/sqlite-check.json"
chmod 644 "$r/preload.cjs"
docker run -d --name "$app" --network container:"$db" --memory 1g --env-file "$r/app.env" -v "$r/preload.cjs:/restore-preload.cjs:ro" -v "$r/workspaces:/app/data/workspaces" -v "$r/exports:/var/lib/website-scout-exports" "$image" > "$r/evidence/app-container.txt"
docker exec "$app" node -e '(async()=>{for(let n=0;n<90;n++){try{let r=await fetch("http://127.0.0.1:3000/health");if(r.ok)break}catch{}await new Promise(r=>setTimeout(r,500))}for(const [p,s]of [["/health",200],["/app",200],["/portal",200],["/api/v1/auth/me",401]]){const r=await fetch("http://127.0.0.1:3000"+p);if(r.status!==s)throw Error(p+" "+r.status)}console.log(JSON.stringify({restoredApp:true,routes:4,externalNetworking:false,backgroundDispatchDisabled:true}))})().catch(e=>{console.error(e.message);process.exit(1)})' > "$r/evidence/app-check.json"
docker logs "$app" > "$r/app-private.log" 2>&1
docker inspect --format '{{.HostConfig.NetworkMode}} {{json .HostConfig.PortBindings}}' "$db" "$app" > "$r/evidence/network-isolation.txt"
curl --max-time 15 -fsS https://bitpype.com/health > "$r/evidence/production-health.json"
printf 'RECOVERY_CHECK_PASSED=%s\n' "$r"
cat "$r/evidence/sqlite-check.json" "$r/evidence/app-check.json" "$r/evidence/production-health.json"
