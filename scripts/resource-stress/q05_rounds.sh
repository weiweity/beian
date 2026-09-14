#!/bin/sh
# Portable successor to the 2026-09-13 external driver. Explicit window, no retry.
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RECEIPT="$SCRIPT_DIR/q05_receipt.py"
ROUNDS=${Q05_ROUND_COUNT:-3}
CMD_FILE=${Q05_ROUND_CMD_FILE:-$SCRIPT_DIR/q05_command.sh}
if [ "${Q05_WINDOW_CONFIRMED:-}" != "1" ]; then
  echo 'REFUSE_UNCONFIRMED_WINDOW' >&2
  exit 2
fi
for VALUE in "${Q05_WT:-}" "${Q05_PREBUILT:-}" "${Q05_ROUNDS_PARENT:-}"; do
  case "$VALUE" in /*) ;; *) echo 'REFUSE_EXPLICIT_ABSOLUTE_PATH_REQUIRED' >&2; exit 2 ;; esac
done
case "$ROUNDS" in ''|*[!0-9]*|0*) echo 'REFUSE_ROUND_COUNT' >&2; exit 2 ;; esac
if [ "${#ROUNDS}" -gt 3 ] || [ "$ROUNDS" -gt 100 ] || [ ! -f "$CMD_FILE" ]; then
  echo 'REFUSE_ARGUMENTS' >&2
  exit 2
fi
WT=$Q05_WT
PREBUILT=$Q05_PREBUILT
PARENT=$Q05_ROUNDS_PARENT
python3 -B "$RECEIPT" --repo "$WT" --artifact-dir "$PREBUILT" --check-output "$PARENT" || exit 2
# The entire run root, then each round, must be new. Never resume/overwrite a run.
mkdir "$PARENT" || exit 3
N=1
while [ "$N" -le "$ROUNDS" ]; do
  ROUND_DIR="$PARENT/round$N"
  mkdir "$ROUND_DIR" || exit 3
  printf '%s\n' "$CMD_FILE" > "$ROUND_DIR/command-source.txt"
  cp "$CMD_FILE" "$ROUND_DIR/command.txt"
  # Execute the saved command, so the receipt hashes exactly the bytes executed.
  set +e
  python3 -B "$RECEIPT" --snapshot-only --repo "$WT" --artifact-dir "$PREBUILT" \
    --output-file "$ROUND_DIR/before.json" > "$ROUND_DIR/preflight.stdout" 2> "$ROUND_DIR/preflight.stderr"
  BEFORE_RC=$?
  set -e
  printf '%s\n' "$BEFORE_RC" > "$ROUND_DIR/preflight.exitcode"
  if [ "$BEFORE_RC" -ne 0 ]; then
    echo "PREFLIGHT_FAILED: round${N}; no command started" >&2
    exit 5
  fi
  if [ "$N" -gt 1 ]; then
    if ! cmp -s "$PARENT/round1/before.json" "$ROUND_DIR/before.json" || \
       ! cmp -s "$PARENT/round1/command.txt" "$ROUND_DIR/command.txt"; then
      echo "ROUND_IDENTITY_CHANGED: round${N}; no command started" >&2
      exit 5
    fi
  fi
  STARTED=$(date +%s)
  set +e
  Q05_ROUND_DIR="$ROUND_DIR" Q05_ROUND_N="$N" Q05_WT="$WT" Q05_PREBUILT="$PREBUILT" \
    sh "$ROUND_DIR/command.txt" > "$ROUND_DIR/stdout.log" 2> "$ROUND_DIR/stderr.log"
  RC=$?
  ENDED=$(date +%s)
  printf '%s\n' "$RC" > "$ROUND_DIR/exitcode"
  python3 -B "$RECEIPT" --round-dir "$ROUND_DIR" --round-number "$N" --exit-code "$RC" \
    --started-epoch "$STARTED" --ended-epoch "$ENDED" --command-file "$ROUND_DIR/command.txt" \
    --repo "$WT" --artifact-dir "$PREBUILT" --window-confirmed 1 --before-file "$ROUND_DIR/before.json" \
    > "$ROUND_DIR/receipt-path.txt" 2> "$ROUND_DIR/receipt.err"
  RECEIPT_RC=$?
  set -e
  printf '%s\n' "$RECEIPT_RC" > "$ROUND_DIR/receipt.exitcode"
  if [ "$RC" -ne 0 ]; then
    echo "ROUND_FAILED: round${N} exit=${RC}; no retry" >&2
    exit 4
  fi
  if [ "$RECEIPT_RC" -ne 0 ]; then
    echo "RECEIPT_FAILED: round${N} exit=${RECEIPT_RC}; no next round" >&2
    exit 5
  fi
  echo "ROUND_OK: round${N}"
  N=$((N + 1))
done
echo "ALL_ROUNDS_OK: ${ROUNDS}; observations only, not formal budgets"
