---
name: sv-combinational
description: Repair inferred latches and implement complete combinational decoding with the specified priority.
---

The task defines default outputs and priority; do not inherit them from the example.

- Use always_comb with blocking assignments, or a continuous assignment, for combinational logic.
- Assign every written output and temporary on every path. Defaults at block entry may be overridden by later branches; a self-assignment is not a combinational default.
- Compute a temporary before using it. Avoid read-before-write ordering and combinational feedback.
- Give each driven variable one driver. Make if/else ordering match the required priority.
- Use ordinary case unless wildcard matching is explicitly required. Do not hide unknowns with casex.
- unique/priority are semantic and optimization promises, not latch fixes; use them only when the input contract justifies them.
- Test no match and multiple simultaneous requests, not only one-hot inputs.

Example: [priority mux](assets/example.sv). Boundaries and sources: [notes](references/notes.md).
