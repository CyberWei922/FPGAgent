#!/usr/bin/env bash
# Starts every resident process (8B main model on :8000, 27B auxiliary model
# with its draft on :8001, and the submission API on 127.0.0.1:7860) with
# setsid, then returns 0 once all are ready. Safe to run again.
set -eo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Instance settings (Vivado license, paths) come from the caller's shell, which
# sources /workspace/env.sh per the official README; nothing is overridden here.
NODE="${NODE_BIN:-$(command -v node || true)}"
if [ -z "$NODE" ]; then
  for candidate in /usr/local/bin/node /workspace/tools/node-v24.15.0-linux-x64/bin/node; do
    if [ -x "$candidate" ]; then NODE="$candidate"; break; fi
  done
fi
if [ -z "$NODE" ]; then echo 'Node.js 24 is required (set NODE_BIN)' >&2; exit 1; fi
export PATH="$(dirname "$NODE"):$PATH"
exec "$NODE" "$ROOT/start.mjs"
