#!/usr/bin/env bash
#
# cll — launch a Claude Code session on the claude-broker channel and capture
# the full terminal transcript to a per-session log file, while staying fully
# interactive (Claude runs inside a pty via `script`).
#
# Usage:   ./scripts/cll.sh [label]      # label defaults to "default"
#
# The transcript lands under:
#   ${CLAUDE_BROKER_LOG_DIR:-$HOME/.local/state/claude-broker/logs}/<label>/transcript-<ts>.log
# Watch it from another terminal with:
#   claude-broker logs <label> --transcript -f
#
# Prefer the shell function? Add this to your profile instead:
#   eval "$(claude-broker shell-init)"     # gives you a `cll` function
set -euo pipefail

label="${1:-default}"
root="${CLAUDE_BROKER_LOG_DIR:-$HOME/.local/state/claude-broker/logs}"
dir="$root/$label"
mkdir -p "$dir"

ts="$(date +%Y%m%d-%H%M%S)"
file="$dir/transcript-$ts.log"
cmd="claude --dangerously-skip-permissions"

export CLAUDE_BROKER_SESSION_ID="$label"
export CLAUDE_BROKER_SESSION_LABEL="$label"

if command -v script >/dev/null 2>&1; then
  printf 'claude-broker: session %s\n  transcript: %s\n  watch:      claude-broker logs %s --transcript -f\n  job log:    claude-broker logs %s -f\n' \
    "$label" "$file" "$label" "$label"
  if script --version >/dev/null 2>&1; then
    exec script -q -e -f -c "$cmd" "$file"      # util-linux
  else
    exec script -q "$file" $cmd                 # BSD/macOS
  fi
else
  # No 'script' tool — launch without a transcript. The daemon job log still
  # captures job I/O. Install 'script' for full-transcript capture:
  #   Fedora: sudo dnf install -y util-linux-script
  #   Debian/Ubuntu: sudo apt install -y bsdutils
  printf 'claude-broker: session %s (no transcript: the "script" tool is not installed)\n  enable transcripts -> Fedora: sudo dnf install -y util-linux-script | Debian: sudo apt install -y bsdutils\n  job log:    claude-broker logs %s -f\n' \
    "$label" "$label"
  exec $cmd
fi
