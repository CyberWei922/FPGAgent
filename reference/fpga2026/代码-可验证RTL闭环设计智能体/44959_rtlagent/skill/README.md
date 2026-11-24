# Skill package

Six RTL skills in the AMD `SKILL.md` format. Each folder has `SKILL.md` (rules), `assets/example.sv` (a small self-written example that synthesizes on the target part) and `references/notes.md` (where the rules came from). `index.json` lists keywords used to pick skills for a task. None of the skills contains a task answer.

| Skill | Use when | Not for |
| --- | --- | --- |
| `sv-combinational` | Combinational outputs, mux priority, defaults, latch avoidance | Clocked behaviour |
| `sv-sequential` | Registers, reset polarity and synchrony, enables, pipeline latency, data/valid alignment | Pure combinational logic |
| `sv-fsm` | State machines: transition tables, Moore vs Mealy output timing, serial pattern detection with overlap | Datapath arithmetic |
| `sv-fifo` | Queues and buffers: full/empty, simultaneous push/pop, pointer wrap | Single registers |
| `sv-width-sign` | Arithmetic widths, sign extension, shifts, truncation | Control logic |
| `vivado-sv` | SystemVerilog constructs that Vivado 2026.1 accepts for elaboration and synthesis | Tool selection or timing closure |

## Deterministic skills

The agent's program code calls the underlying deterministic tools. These new folders provide standalone CLI access to that same code; the agent does not load these documents as prompts. They are not in `index.json`. The original six prompt skills and their selection remain unchanged.

| Skill | Use when | Not for |
| --- | --- | --- |
| `spec-selftest` | Compile source-cited method parameters into CPU expectations, a checker and a negative control; optionally simulate | Complete correctness proofs or invented source behavior |
| `rtl-interface-check` | Compare port names, directions and numeric widths before Vivado | Functional verification or arbitrary elaboration |
| `rtl-lint-rules` | Locate the six bounded pyslang findings used by the agent | Replacing Vivado checks; a missing dependency is a skip |
| `rtl-pitfalls` | Query ten lessons tied to our archived run evidence | General advice without run evidence |

Each folder contains `SKILL.md`, `scripts/` and original `examples/` with expected output. Use Node >=22.19 and install existing dependencies with `npm ci --prefix rtl-agent`. Keep the full exported package together. Use `skill/<name>/scripts/<name>.mjs` or `competition/skill/<name>/scripts/<name>.mjs`; both locate the same `rtl-agent/src/` by walking ancestors. Each CLI has `--help`. Vivado is optional; lint needs pyslang 12.0.0. Evidence paths in the pitfalls identify our audit archive and may require access to that archive.
