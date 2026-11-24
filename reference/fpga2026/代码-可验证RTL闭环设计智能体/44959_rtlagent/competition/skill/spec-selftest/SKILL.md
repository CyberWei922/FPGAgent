---
name: spec-selftest
description: Compile source-cited method parameters into CPU expectations and a SystemVerilog self-test without starting the agent.
---
## Purpose

Use the agent's method registry, parameter validator, CPU oracle and testbench renderer from a CLI.

## When to use / When not to use

| Use when | Do not use for |
| --- | --- |
| A supported partial method describes specified behavior | Proving complete functional correctness |
| Parameters cite original specification line IDs | Inventing reset values, latency or event priority |
| An independent check of the generated checker is available | Treating a negative control as proof of semantic correctness |

## Inputs / Outputs

| Input | Meaning |
| --- | --- |
| `--spec FILE` | UTF-8 specification. `S1`, `S2`, etc. address its nonempty lines. Ranges are supported by the agent validator. |
| `--params FILE` | Strict method JSON: `method`, `sources`, `params`; or the agent's unsupported object |
| `--interface FILE` | Optional Verilog module declaration. Otherwise parse the specification. |
| `--top NAME` | Optional fallback top. Reject a conflict with a parsed module name. |
| `--out NEW_DIR` | A directory that does not exist |
| `--expressions` | Opt in to the registry's bounded expression methods |

| Output / exit | Meaning |
| --- | --- |
| `ready` / 0 | CPU scenarios or transaction expectations, coverage and expected comparison count |
| `rejected` / 1 | Original `compileTestMethod` error code and message |
| `unsupported` / 1 | The existing compiler cannot safely construct this check |
| `error` / 2 | Input, rendering or filesystem failure |
| `tb.sv`, `negative-control.sv` | Generated checker and deliberately wrong RTL |
| `plan.json`, `calculations.json` | Compiled method and CPU calculation records |
| `run.status: skipped` / 0 | Generation succeeded; Vivado was unavailable. No simulation claim. |

With `--run`, exit 0 requires the DUT to pass and the negative control to complete with detected mismatches. Compilation or infrastructure failure is not a detected negative control. A failed run exits 1.

## Usage

Run from the repository or exported package root. Install the existing agent dependencies first: `npm ci --prefix rtl-agent`.

```sh
SKILLS=rtl-agent/skills
# In an export use SKILLS=skill or SKILLS=competition/skill.
EX="$SKILLS/spec-selftest/examples"
OUT="$(mktemp -d)/xor-check"
node "$SKILLS/spec-selftest/scripts/spec-selftest.mjs" --list-methods
node "$SKILLS/spec-selftest/scripts/spec-selftest.mjs" \
  --spec "$EX/prompt.txt" --interface "$EX/interface.sv" \
  --params "$EX/method.json" --out "$OUT"
```

Optional simulation (use another new output directory):

```sh
node "$SKILLS/spec-selftest/scripts/spec-selftest.mjs" \
  --spec "$EX/prompt.txt" --params "$EX/method.json" \
  --out "$(mktemp -d)/run" --run --rtl "$EX/dut.sv" \
  --vivado-bin /tools/Xilinx/2026.1/Vivado/bin
```

The CLI also checks `VIVADO_BIN`, then `PATH`. It requires Vivado 2026.1 and runs the two checks sequentially.

## Example

`examples/` is original. The two 2-bit inputs produce 16 XOR comparisons. For `left=2`, `right=3`, the CPU expectation is `value=1`.

| File | Expected result |
| --- | --- |
| `method.json` | `expected.json`: `ready`, 16 comparisons; generated files match `expected-tb.sv` and `expected-negative-control.sv` |
| `rejected-method.json` | `expected-rejected.json`: exit 1, `TEST_PLAN_INVALID`; the citation is not an address |

## Limits

Keep the complete package beside the skills. A copied skill folder alone cannot import the agent. CPU arithmetic does not validate model-filled semantics. Read `coverage`, `uncovered`, and the cited source before using a failure to repair a DUT. No official reference or official testbench is used.

## Source in the agent

| Source / function | Agent phase |
| --- | --- |
| `verification/registry.mjs`: `METHOD_IDS`, `METHOD_REGISTRY`, `eligibleMethods`, `methodOutputSchema` | Method selection and structured output schema |
| `verification/methods.mjs`: `compileTestMethod` | Parameter, source and oracle compilation |
| `verification/plan.mjs`: `compileScenarioPlan` | Plan validation and executable sequencing |
| `self-check.mjs`: `renderVectorTestbench`, `negativeControlRtl` | Checker preparation and negative control |
| `vivado.mjs`: `inspectVivado`, `checkRtl` | Compile and simulation checks |

Paths above are under `rtl-agent/src/`. This CLI imports them. It does not change agent prompts or register a skill in `index.json`.
