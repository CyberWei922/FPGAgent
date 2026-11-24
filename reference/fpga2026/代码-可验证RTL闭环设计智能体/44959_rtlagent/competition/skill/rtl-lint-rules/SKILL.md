---
name: rtl-lint-rules
description: Run the agent's six bounded pyslang lint rules and report rule codes with source locations.
---
## Purpose

Find known data-flow and signedness mistakes before a costly Vivado run.

## When to use / When not to use

| Use when | Do not use for |
| --- | --- |
| Checking one bounded RTL source with a resolved top | Replacing Vivado compilation, synthesis or simulation |
| Locating a supported static finding | Claiming no warnings means functional correctness |

## Inputs / Outputs

Use `--rtl FILE --top NAME`. Optionally set `--python EXECUTABLE` or `SLANG_PYTHON`. Use `--work-dir DIR` to retain the agent's `rtl-lint.json`; otherwise temporary files are removed.

| Exit / status | Meaning |
| --- | --- |
| 0 / `pass` | None of the six selected rules fired |
| 1 / `fail` | Findings include code, severity, line, column, message and source line |
| 0 / `skipped` | Interpreter or pinned helper dependency unavailable; installation guidance is printed |
| 2 / `unknown` or `error` | No reliable rule result, including a crashed helper |

`pass` with reason `parse_or_elaboration_errors_left_to_vivado` is not a compile pass. `otherCodes` records other warning counts. The CLI omits volatile `durationMs` from stdout; retained `rtl-lint.json` keeps it.

| Rule from `RTL_LINT_RULES` | Check / reason |
| --- | --- |
| `-Wstatic-init-value` | Signal-dependent static initialization runs once, not continuously. Historical audit: `static-declaration-initializer` in `rtl-pitfalls`. |
| `-Wunassigned-variable` | A read variable has no assignment. Historical audit: `unassigned-state-variable`. |
| `-Wundriven-port` | An output has no driver. Historical audit: `undriven-output`. |
| `-Wunsigned-arith-shift` | Unsigned `>>>` fills with zeros. Historical audit: `unsigned-arithmetic-shift`. |
| `-Wmultiple-always-assigns` | A variable has conflicting procedural owners. Historical audit: `multiple-procedural-drivers`. |
| `-Wmixed-var-assigns` | A variable mixes continuous and procedural assignment. Keep one owner. No qualifying historical case is claimed in the pitfalls data. |

These are pyslang diagnostics. Do not interpret them as measured Vivado error codes. The included historical archive is a lint audit, not a new Vivado reproduction.

## Usage

Run from the repository or exported package root.

```sh
SKILLS=rtl-agent/skills
# In an export use SKILLS=skill or SKILLS=competition/skill.
EX="$SKILLS/rtl-lint-rules/examples"
node "$SKILLS/rtl-lint-rules/scripts/rtl-lint-rules.mjs" \
  --rtl "$EX/dut.sv" --top SignedShift
```

Install with the same command as `competition/Dockerfile` (Linux pinned wheels):

```sh
python3 -B competition/environment/install-slang.py \
  --wheel-dir competition/vendor/pyslang/wheels \
  --target competition/vendor/pyslang/site-packages
```

On other platforms use an environment with `pyslang==12.0.0`, then pass its Python path using `--python`. Do not run the Linux wheel installer on macOS.

## Example

| Original example | Expected JSON / exit with pyslang 12.0.0 |
| --- | --- |
| `examples/dut.sv` | `examples/expected.json`, unsigned arithmetic shift at line 2, column 19 / 1 |
| `examples/clean.sv` | `examples/expected-clean.json`, no selected findings / 0 |

The clean example uses `$signed` because it intends sign extension. A zero-fill specification should use `>>`.

## Limits

Use one file, at most 131072 bytes, with no external include or pragma directives. The existing helper bounds time and findings (16 here). Missing dependencies are skips, not passes. Keep the full package beside the skills.

## Source in the agent

| Source / function | Agent phase |
| --- | --- |
| `rtl-agent/src/rtl-lint.mjs`: `RTL_LINT_RULES`, `runRtlLint` | Candidate guard after interface comparison in `competition/agent/dual-entry.mjs` |
| `rtl-agent/src/rtl-lint.py` | Offline pyslang 12.0.0 helper |
| `rtl-agent/src/vivado.mjs`: `runProcess` | Existing bounded process runner |

No checking logic is copied. This CLI is absent from `index.json` and adds no prompt text.
