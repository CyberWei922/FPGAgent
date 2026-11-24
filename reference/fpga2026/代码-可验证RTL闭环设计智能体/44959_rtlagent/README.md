# 44959_rtlagent — RTL track submission

A locally deployed RTL agent. An 8B code model writes the RTL; a 27B auxiliary model plans and prepares self-tests but never writes code; deterministic programs run Vivado, compute expected values, check interfaces and select candidates.

## Layout

| Path | Content |
| --- | --- |
| `Dockerfile` | Builds on the organizer base image; installs pinned Node dependencies and offline pyslang wheels |
| `manifest.json`, `model/MODEL.md` | Main model, auxiliary models, sources/revisions/hashes, context, thinking settings, measured VRAM |
| `serve/start.sh` | Starts every resident process with `setsid` and returns 0 when ready (idempotent) |
| `run.sh` | Single task: `./run.sh <task_dir> <out_dir>` → `solution.v`, `trace.jsonl` |
| `run_baseline.sh`, `baseline.py` | Official baseline, unmodified |
| `agent/` | Where the agent source lives (see `agent/README.md`) |
| `skill/` | Skill package (`skill/README.md`, one folder per skill) |
| `competition/` | Entry scripts, configuration, HTTP service (`competition/serve/`) |
| `rtl-agent/` | Agent engine: controller, planner, self-test methods, Vivado tools |
| `REPORT.md` | Design report |

## Start

1. Put the three weight files from `model/MODEL.md` in `/workspace/models` (or set `MAIN_MODEL_PATH`, `AUX_MODEL_PATH`, `DRAFT_MODEL_PATH`).
2. Install Node dependencies once: `cd rtl-agent && npm ci --omit=dev --ignore-scripts` (done during `docker build`).
3. Set `FPGACHINA_TOKEN` (and the Vivado license variables in `/workspace/env.sh`), then run `bash serve/start.sh`.

`serve/start.sh` starts, in this order:
- llama.cpp with the 8B main model on `127.0.0.1:8000` (also used by the baseline);
- llama.cpp with the 27B auxiliary model and its DSpark draft on `127.0.0.1:8001`;
- the submission API on `127.0.0.1:7860` (`/v1/health`, `/v1/solve`, `/v1/jobs/<id>`, bearer token required).

It verifies weight sizes and SHA-256, writes the frozen agent configuration, checks readiness and VRAM, and records everything in `$SERVICE_STATE_DIR` (default `/var/tmp/rtl-agent-service`). Expose only port 7860 through `rc-tunnel`.

The competition configuration is fixed in `competition/serve/start.mjs` (`PRODUCTION_AGENT_ENV`); no extra environment variables are needed. Everything runs offline.

## Per request

`mode=agent` runs `run.sh`; `mode=baseline` runs `run_baseline.sh` against the same 8B service with the same thinking settings. Each request runs in its own process group, is stopped before `deadline_s`, and its workspace is removed afterwards. The latest valid RTL is always written to `solution.v`, so a stopped request still returns its best candidate.
