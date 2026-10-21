#!/usr/bin/env bash
# Deploy Hands-off Muse mode to VPS container and smoke status + optional tick.
set -euo pipefail
ROOT=/root/website-scout-web
CTR=website-scout-web-app-1

cd "$ROOT"
for f in \
  server/museAgent.js \
  server/handsOff.js \
  server/jobs.js \
  server/domain.js \
  server/mcp.js \
  server/routes/domainApi.js \
  server/settingsKeys.js \
  src/ipc/system.js \
  public/js/api.js \
  public/js/app.js \
  renderer/settings.html \
  renderer/settings.js
do
  if [[ -f "$ROOT/$f" ]]; then
    docker exec "$CTR" mkdir -p "/app/$(dirname "$f")"
    docker cp "$ROOT/$f" "$CTR:/app/$f"
    echo "copied $f"
  else
    echo "skip missing $f"
  fi
done

docker compose restart app
for i in $(seq 1 40); do
  docker logs "$CTR" --tail 20 2>&1 | grep -q 'listening on' && echo up && break
  sleep 1
done

curl -sS https://bitpype.com/api/v1/health
echo

docker exec "$CTR" node -e '
const jobs = require("./server/jobs");
const muse = require("./server/museAgent");
const ho = require("./server/handsOff");
if (!jobs.JOB_TYPES.includes("hands_off") || !jobs.JOB_TYPES.includes("hands_off_digest")) {
  console.error("JOB_TYPES:FAIL");
  process.exit(1);
}
console.log("jobs:ok", jobs.JOB_TYPES.filter((t) => t.startsWith("hands_")).join(","));
console.log("museAgent:ok", typeof muse.runJobLoop === "function");
console.log("handsOff:ok", typeof ho.runTick === "function" && typeof ho.getStatus === "function");
const mcp = require("./server/mcp");
const names = mcp.toolDefs().map((t) => t.name);
if (!names.includes("handsOff.status") || !names.includes("handsOff.runNow")) {
  console.error("mcp:FAIL");
  process.exit(1);
}
console.log("mcp:ok handsOff.status,handsOff.runNow");
'

# Optional smoke: set HANDS_OFF_SMOKE_WS=1 (workspace id) to run one tick with force
if [[ -n "${HANDS_OFF_SMOKE_WS:-}" ]]; then
  echo "Smoke tick workspace ${HANDS_OFF_SMOKE_WS}…"
  docker exec -e WS="$HANDS_OFF_SMOKE_WS" "$CTR" node -e '
const domain = require("./server/domain");
const ws = Number(process.env.WS);
(async () => {
  const st = await domain.handsOffStatus(ws);
  console.log("status", JSON.stringify({
    enabled: st.enabled,
    paused: st.automationPaused,
    muse: st.museConfigured,
    lastRunAt: st.lastRunAt,
  }));
  const r = await domain.handsOffRunNow(ws, { force: true });
  console.log("tick", JSON.stringify({
    ok: r.ok,
    skipped: r.skipped,
    reason: r.reason,
    discovered: r.discovered,
    scored: r.scored,
    designJobs: r.designJobs,
    delivered: r.delivered,
    published: r.published,
    errors: (r.errors || []).slice(0, 5),
  }));
})().catch((e) => { console.error(e); process.exit(1); });
'
fi

echo DONE
