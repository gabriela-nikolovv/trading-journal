#!/usr/bin/env bash
# The website runs the SAME tested engine modules in the browser. This copies the browser-safe ones
# (and the report fonts) into web/. It runs automatically in the GitHub Pages deploy workflow.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
dest="$root/web/js/engine"
mkdir -p "$dest" "$root/web/assets/fonts"
for f in money format calendar pnlSchemas reportTotals weeklyReport weeklyReportPdfCore currentR positionAnalytics taxonomy tradeStats statistics schemaSeries weekBuilder dailySnapshots; do
  cp "$root/packages/engine/src/$f.js" "$dest/$f.js"
done
cp "$root/packages/engine/assets/fonts/"*.ttf "$root/web/assets/fonts/"
echo "engine copied to $dest"
