---
name: vivado-sv
description: Handle Vivado SystemVerilog support and synthesis diagnostics while preserving the RTL contract.
---

- Target the configured Vivado version, not every feature in the newest language standard. Parse .sv in SystemVerilog mode; a tool-mode error is not evidence to change behavior.
- Prefer fixed-size packed vectors, fixed-size arrays, explicit ports, static loop bounds, and supported always_ff/always_comb forms.
- Before emitting RTL, check procedural targets: plain `output q` is a net; an output assigned in an always block needs `output logic`/`output reg`, or an internal variable plus `assign`. Preserve port names, widths and timing; do not mistake adding a variable type for changing the interface.
- Target Vivado 2026.1. Do not give one variable conflicting procedural writers. If initialization is required, preserve the specified initial value and verify the chosen process form with the configured Vivado; do not add initial values merely to guess hidden tests.
- Use identifiers such as `bit_count` and `rx_byte`; `bit` and `byte` are SystemVerilog keywords.
- Keep DUT RTL separate from testbench delays, file I/O, classes, randomization, and simulation-control tasks.
- Distinguish packed bit fields from unpacked array dimensions; preserve bit ordering at ports and concatenations.
- RAM/ROM inference depends on read latency and reset style. Preserve the task's read behavior rather than changing cycles to obtain a resource type.
- Synthesis success does not prove functionality or timing closure. A 5 ns clock constraint is not an RTL #delay and does not authorize another pipeline stage.

Closed-run repair: use the supplied specification, candidate and diagnostics without requesting a person, waveform, testbench, file or external tool. Return complete RTL, not a plan or patch. Do not claim checks were run by you.

Fix the earliest failure by type. For syntax errors, change the offending syntax while preserving behavior. For simulation mismatches, first trace the failing output back to the accepted transaction using pre-edge register values; inputs printed at the failing edge may belong to a later transaction. A late valid cannot be repaired by changing arithmetic alone. Check the valid path, data source at each stage, and then the signed numeric range. Make a functional change that explains the counterexample; unchanged logic with new comments or names is not a repair. Follow the original specification, not an inferred special case from one test vector.

Example: [small registered ROM](assets/example.sv). Version and tool boundaries: [notes](references/notes.md).
