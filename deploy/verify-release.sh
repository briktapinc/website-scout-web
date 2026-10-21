#!/usr/bin/env bash
# Synthetic integration gate. Never connects to production databases or publishes ports.
set -euo pipefail
image=${1:?Pass a tested image ID or tag}
out=${2:?Pass an evidence directory}
mkdir -p "$out"
name="bitpype-ci-mysql-$$"
cleanup(){ docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker run -d --name "$name" --network none --memory 1g --tmpfs /var/lib/mysql:rw,nosuid,size=1g \
 -e MYSQL_ROOT_PASSWORD=synthetic-ci-only -e MYSQL_DATABASE=website_scout \
 mysql@sha256:7dcddc01f13bab2f15cde676d44d01f61fc9f99fe7785e86196dfc07d358ae2b > "$out/mysql-container.txt"
ready=0
for n in $(seq 1 90);do
 if docker exec "$name" sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql --protocol=TCP -h127.0.0.1 -uroot -N -e "SELECT 1"' >/dev/null 2>&1;then ready=1;break;fi
 sleep 1
done
test "$ready" = 1
run(){ docker run --rm --network container:"$name" --memory 1g \
 -e DB_DRIVER=mysql -e MYSQL_HOST=127.0.0.1 -e MYSQL_USER=root -e MYSQL_PASSWORD=synthetic-ci-only -e MYSQL_DATABASE=website_scout \
 --entrypoint node "$image" "$1"; }
run tests/mysql-oauth-integration.cjs > "$out/oauth-mysql.json"
# Separate schema prevents fixtures from contaminating each other.
docker exec "$name" sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot -e "DROP DATABASE website_scout; CREATE DATABASE website_scout"'
run tests/mysql-jobs-integration.cjs > "$out/jobs-mysql.json"
docker run --rm --network none --memory 1g --entrypoint node "$image" tests/run-regressions.cjs > "$out/regressions.log"
# Only OCR language-data retrieval requires outbound access; all content is synthetic.
docker run --rm --memory 1g --entrypoint node "$image" tests/knowledge-ocr-check.cjs > "$out/ocr.json"
docker run --rm --entrypoint npm "$image" audit --omit=dev --json > "$out/audit.json"
echo 'Release integration gates passed'
