# Agent source

The agent keeps its development layout so that the code that was validated is the code that is submitted. This folder points to it.

| Path | Role |
| --- | --- |
| `competition/agent/main.mjs` | Entry called by `run.sh`: reads `prompt.txt`, parses the port list from the prompt, runs the agent, writes `solution.v` and `trace.jsonl` |
| `competition/agent/dual-entry.mjs` | Connects the entry to the two-model controller |
| `competition/agent/interface.mjs` | Deterministic interface check (module name, port names, directions, widths) |
| `competition/agent/resample-vote.mjs` | Candidate voting on CPU self-test evidence |
| `rtl-agent/src/dual/controller.mjs` | Control flow: plan → self-test preparation → 8B draft → Vivado checks → resample / counterexample repair → final selection |
| `rtl-agent/src/planner/` | 27B planning and prompts; 8B request construction |
| `rtl-agent/src/verification/` | Self-test methods: the 27B picks a method and fills structured parameters, the CPU computes stimulus and expected values, a deliberate mutant must fail first |
| `rtl-agent/src/harness/` | Counterexample diagnosis, repair routing, candidate evidence |
| `rtl-agent/src/mcp-*.mjs`, `rtl-agent/src/vivado*.mjs` | Vivado xvlog / xelab / xsim / synth_design tools |
| `competition/serve/` | Service start, HTTP API, per-request process supervision |

Retry and fallback policy, context management and failure analysis are described in `REPORT.md`.
