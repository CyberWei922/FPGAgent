---
name: rtl-interface-check
description: Compare a specification interface with RTL port names, directions and widths using the agent's interface checker.
---
## Purpose

Catch interface differences before a Vivado run.

## When to use / When not to use

| Use when | Do not use for |
| --- | --- |
| Port names and numeric widths can be parsed | Functional verification |
| A prompt or explicit module declaration defines the interface | Elaborating arbitrary parameter expressions |

## Inputs / Outputs

| Input | Meaning |
| --- | --- |
| `--spec FILE`, `--rtl FILE`, `--top NAME` | Required UTF-8 specification, candidate RTL and top |
| `--interface FILE` | Optional authoritative Verilog module declaration |

JSON lists expected and actual ports, name/direction/width comparisons, unresolved fields, and the original check result. Unknown widths produce `width_match: null`.

| Exit | Status |
| --- | --- |
| 0 | `match` |
| 1 | `mismatch` |
| 2 | `unknown` or CLI `error` |

A direction difference from prompt bullets is advisory to the agent (`blocking: false` when it is the only difference). It still exits 1 here. An explicit interface makes direction differences blocking. A known difference takes precedence over unresolved fields.

## Usage

Run from the repository or exported package root.

```sh
SKILLS=rtl-agent/skills
# In an export use SKILLS=skill or SKILLS=competition/skill.
EX="$SKILLS/rtl-interface-check/examples"
node "$SKILLS/rtl-interface-check/scripts/rtl-interface-check.mjs" \
  --spec "$EX/prompt.txt" --rtl "$EX/dut.sv" --top LaneCopy
```

## Example

The original `LaneCopy` example copies a 5-bit payload.

| RTL | Expected JSON / exit |
| --- | --- |
| `examples/dut.sv` | `examples/expected.json`, `match` / 0 |
| `examples/bad-width.sv` | `examples/expected-bad-width.json`, `mismatch` / 1; result is 4 bits instead of 5 |

## Limits

This is the existing bounded parser, not a SystemVerilog elaborator. Keep unknown results unknown. A match does not prove behavior. Keep the full package beside the skills.

## Source in the agent

| Source / function | Agent phase |
| --- | --- |
| `competition/agent/interface.mjs`: `expectedInterface`, `moduleInterface`, `checkInterface` | Interface extraction and pre-Vivado candidate guard in `dual-entry.mjs` |

The CLI imports these functions. It is not registered in `index.json` and adds no prompt text.
