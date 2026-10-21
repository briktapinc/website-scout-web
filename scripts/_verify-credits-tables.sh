#!/usr/bin/env bash
set -euo pipefail
cd /root/website-scout-web

# BOM-safe env load
if [[ -f .env ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
    line="${line#$'\xEF\xBB\xBF'}"
    export "$line"
  done < .env
fi

MU="${MYSQL_USER:-scout}"
MP="${MYSQL_PASSWORD:-scout}"
MD="${MYSQL_DATABASE:-website_scout}"

echo "== tables =="
docker compose exec -T mysql mysql -N -u"$MU" -p"$MP" "$MD" -e "SHOW TABLES LIKE 'credit%';"

echo "== credit_balances =="
docker compose exec -T mysql mysql -u"$MU" -p"$MP" "$MD" -e "DESCRIBE credit_balances;"

echo "== credit_ledger =="
docker compose exec -T mysql mysql -u"$MU" -p"$MP" "$MD" -e "DESCRIBE credit_ledger;"

echo "== app query =="
docker compose exec -T app node <<'NODE'
const credits = require('./server/credits');
(async () => {
  const bal = await credits.getBalance(1);
  const ledger = await credits.listLedger(1, { limit: 5 });
  console.log(JSON.stringify({ ok: true, balance: bal, ledgerRows: ledger.length }));
})().catch((e) => {
  console.error('FAIL', e.message);
  process.exit(1);
});
NODE

echo "== recent app logs (errors) =="
docker logs website-scout-web-app-1 --tail=80 2>&1 | grep -Ei 'credit_balances|ER_NO_SUCH_TABLE|Cannot find module' || echo "(no credit/table/module errors in last 80 lines)"

echo "verify-credits-tables done"
