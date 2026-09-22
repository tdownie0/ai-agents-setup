#!/usr/bin/env bash
# Two-level A/B runner for repo-map prefix-caching.
# Level control = OPENCODE_REPO_MAP=off, treatment = on. Emits one JSONL row
# per rep (token usage + wall latency) to $OUT for scripts/bench/analyze.mjs.
# Usage: ab.sh [worktree]   env: REPS, PROMPT, OUT
set -euo pipefail

REPS="${REPS:-4}"
PROMPT="${PROMPT:-Reply with exactly: ISO-BENCH}"
OUT="${OUT:-/tmp/opencode/ab-results.jsonl}"
LOG="${OPENCODE_LOG:-/home/devuser/.local/share/opencode/log/opencode.log}"
BENCH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKTREE="${1:-$(pwd)}"

if [ ! -f "$LOG" ]; then
  echo "error: opencode log not found at $LOG" >&2
  exit 1
fi

cd "$WORKTREE"
: > "$OUT"

run_level() {
  local level="$1"
  shift
  for rep in $(seq 1 "$REPS"); do
    local before after sid start end ms
    before=$(wc -l < "$LOG")
    start=$EPOCHREALTIME
    timeout 120 env "$@" opencode run "$PROMPT" >/dev/null 2>&1 ||
      echo "warning: run failed (level=$level rep=$rep)" >&2
    end=$EPOCHREALTIME
    after=$(wc -l < "$LOG")
    sid=$(sed -n "$((before + 1)),${after}p" "$LOG" | grep "message=stream" |
      grep -oE 'session\.id=ses_[A-Za-z0-9]+' | tail -1 | cut -d= -f2) || true
    if [ -z "$sid" ]; then
      echo "warning: no session captured (level=$level rep=$rep)" >&2
      continue
    fi
    ms=$(awk -v s="$start" -v e="$end" 'BEGIN { printf "%.0f", (e - s) * 1000 }')
    LVL="$level" REP="$rep" LATENCY_MS="$ms" bun "$BENCH_DIR/query-session.mjs" "$sid" >> "$OUT"
  done
}

echo "level=control (OPENCODE_REPO_MAP=off)"
run_level control OPENCODE_REPO_MAP=off
echo "level=treatment (OPENCODE_REPO_MAP=on)"
run_level treatment OPENCODE_REPO_MAP=on

echo "results: $OUT" >&2