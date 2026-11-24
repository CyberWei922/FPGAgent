#!/usr/bin/env bash
set -eo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export AGENT_CONFIG="${AGENT_CONFIG:-${SERVICE_STATE_DIR:-/var/tmp/rtl-agent-service}/config.json}"
export AGENT_DEADLINE_S="${AGENT_DEADLINE_S:-900}"
export LLM_BASE_URL="${LLM_BASE_URL:-http://127.0.0.1:8000/v1}"
export XILINXD_LICENSE_FILE="${XILINXD_LICENSE_FILE:-2100@vivado-lic.fpgachina.svc.cluster.local}"
export FLEXLM_TIMEOUT="${FLEXLM_TIMEOUT:-300000000}"
export EDA_TMP="${EDA_TMP:-/var/tmp/eda}" AGENT_TMP="${AGENT_TMP:-/var/tmp}" TMPDIR="${TMPDIR:-/var/tmp}"
if [ "$#" -ne 2 ]; then
  echo 'Usage: run.sh <task_dir> <out_dir>' >&2
  exit 2
fi
exec "${PYTHON_BIN:-python3}" "$ROOT/serve/process_runner.py" --timeout "$AGENT_DEADLINE_S" --grace 2 --cwd "$PWD" -- node "$ROOT/agent/main.mjs" --input "$1" --output "$2"
