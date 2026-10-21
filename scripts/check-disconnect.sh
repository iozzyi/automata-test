#!/usr/bin/env bash
# The socket goes away mid-run and the screen must say so.
#
# Restarts the simulator with SOCKET_KILL_MS on, runs the check, and puts it
# back however the check turns out.
set -euo pipefail
cd "$(dirname "$0")/.."

SIM=http://localhost:5002

curl -sf localhost:3000 >/dev/null || { echo "web is not up -- run: cd web && pnpm dev"; exit 1; }

restore() { docker compose up -d simulator >/dev/null 2>&1 || true; }
trap restore EXIT

echo "restarting the simulator with SOCKET_KILL_MS=4000"
SOCKET_KILL_MS=4000 docker compose up -d simulator >/dev/null
for _ in $(seq 1 30); do curl -sf $SIM/health >/dev/null && break; sleep 0.5; done

# A gap needs all three knobs. If dropping or reordering is also on, this check
# cannot tell a lost event from a dropped socket.
noisy=$(curl -sf $SIM/health | python3 -c '
import json, sys
c = json.load(sys.stdin)["config"]
on = []
if c["reorder_pct"]:   on.append("REORDER_PCT=%d" % c["reorder_pct"])
if c["duplicate_pct"]: on.append("DUPLICATE_PCT=%d" % c["duplicate_pct"])
print(", ".join(on))')

if [ -n "$noisy" ]; then
  echo
  echo "  NOTE  wire chaos is also on ($noisy). A reordered event looks the same"
  echo "        as one lost to a dropped socket, so this check cannot separate them."
  echo
fi

cd web && pnpm exec playwright test e2e/disconnect.spec.ts
