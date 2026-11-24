---
name: sv-fsm
description: Generate and repair FSM transitions, reset state, and Moore or Mealy output timing without adding cycles.
---

- Derive a transition table from the task: current state, condition priority, next state, and outputs for that cycle.
- Distinguish Moore outputs from Mealy outputs. Moving an output into a register can add a cycle and is not a harmless cleanup.
- Use named states with enough encoding bits. Assign enum labels, not arbitrary integers, to enum state variables.
- Keep the state register in one clocked block. Fully define next-state and output logic, including hold transitions.
- Preserve reset polarity, synchrony, and reset state. Define invalid-state behavior only as allowed by the task; a default branch alone does not prove hardware fault recovery.
- Check back-to-back requests, simultaneous transition conditions, reset while busy, and pulse duration.
- For framed receivers, distinguish a valid stop from recovery after an invalid frame; recovery alone does not validate the discarded data. For continuous windows, the output cycle may also consume the next window's first sample. For serial pattern detection, include the currently sampled bit. After every input, including a successful match, retain the longest suffix that is also a prefix of the target pattern. Check each transition against that invariant before emitting code.
- For transaction engines, distinguish reset, start, accepted beat, accepted end, and output consumption. Advance working state only on accepted events; an end/last flag on an unaccepted beat has no effect.
- Keep working accumulators/counters separate from a pending result. At an accepted end, publish the result including that beat at the specified latency, and restore working state to the next transaction's specified initial value. Clearing valid alone does not initialize an accumulator.
- During output backpressure, hold pending valid and result; handle reset/abort as specified. Decide from the task whether result consumption may coincide with input acceptance. Derive both handshakes from pre-edge state, preserving any required turnaround cycle.

Example: [Moore controller](assets/example.sv). Its protocol and sources: [notes](references/notes.md).
