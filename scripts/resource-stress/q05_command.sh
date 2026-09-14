#!/bin/sh
# Must be invoked by q05_rounds.sh in an explicitly approved window.
set -eu
: "${Q05_WT:?}" "${Q05_ROUND_DIR:?}" "${Q05_ROUND_N:?}" "${Q05_PREBUILT:?}"
exec python3 -B "$Q05_WT/scripts/resource-stress/cli.py" measure-command \
  --repo "$Q05_WT" --out "$Q05_ROUND_DIR/rss-wall" --name "q05-round$Q05_ROUND_N" \
  --cwd "$Q05_WT/apps/web/ui" \
  -- env PLAYWRIGHT_ARTIFACT_ONLY=1 BEIAN_Q05_DIST="$Q05_PREBUILT" RF09_MEASURE_DIR="$Q05_ROUND_DIR/measure" \
  "$Q05_WT/node_modules/.bin/playwright" test e2e/mockup-preview-upgrade.spec.ts \
  --grep 'Q05 切代|代表尺寸 PNG' --output "$Q05_ROUND_DIR/test-results" --reporter=line --max-failures=1
