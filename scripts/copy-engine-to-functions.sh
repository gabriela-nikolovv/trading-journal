#!/usr/bin/env bash
# Edge Functions only bundle files under supabase/functions, so copy the
# pure-JS sync modules (no PDF code) next to the function before deploying.
set -euo pipefail
dest="$(dirname "$0")/../supabase/functions/_shared/engine"
mkdir -p "$dest"
for f in money csv normalize dedupe positionEngine syncPlanner syncEngine propreportsClient tradeStats dailySnapshots currentR marketData positionAnalytics taxonomy; do
  cp "$(dirname "$0")/../packages/engine/src/$f.js" "$dest/$f.js"
done
echo "engine copied to $dest"
