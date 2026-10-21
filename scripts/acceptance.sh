#!/usr/bin/env bash
# What the timeline shows during a clean run.
set -euo pipefail
cd "$(dirname "$0")/.."

SIM=http://localhost:5002

curl -sf $SIM/health >/dev/null || { echo "simulator is not up -- run: docker compose up -d"; exit 1; }
curl -sf localhost:3000 >/dev/null || { echo "web is not up -- run: cd web && pnpm dev"; exit 1; }

# Warn about anything you switched on. These checks want a clean run, so a knob
# left on will fail them for a reason that is not your code.
noisy=$(curl -sf $SIM/health | python3 -c '
import json, sys
c = json.load(sys.stdin)["config"]
on = []
if c["fail_step"]:        on.append("FAIL_STEP=" + c["fail_step"])
if c["reorder_pct"]:      on.append("REORDER_PCT=%d" % c["reorder_pct"])
if c["duplicate_pct"]:    on.append("DUPLICATE_PCT=%d" % c["duplicate_pct"])
if c["socket_kill_ms"]:   on.append("SOCKET_KILL_MS=%d" % c["socket_kill_ms"])
if c["socket_reject_ms"]: on.append("SOCKET_REJECT_MS=%d" % c["socket_reject_ms"])
print(", ".join(on))')

if [ -n "$noisy" ]; then
  echo
  echo "NOTE: the lab is set to misbehave ($noisy)."
  echo "      These checks want a clean run. Restart with: docker compose up -d simulator"
  echo
fi

cd web && pnpm exec playwright test e2e/timeline.spec.ts
