---
name: sv-fifo
description: Implement single-clock FIFO acceptance, boundary cases, occupancy, and specified read latency.
---

- Fix the contract first: depth, width, reset, accepted reads/writes, full/empty simultaneous requests, and standard versus fall-through read behavior.
- Derive push/pop from the specified pre-edge conditions. Update pointers, memory, and occupancy from accepted operations, not raw requests.
- Occupancy needs to represent 0 through DEPTH. Handle pointer wrap explicitly for non-power-of-two depth and avoid zero-width declarations at DEPTH=1.
- On an accepted operation, use `if (ptr == DEPTH-1) ptr <= '0; else ptr <= ptr + 1'b1;`. Width overflow wraps at a power of two, not DEPTH: at depth 3, index 2 must advance to 0, never 3. Use `PTR_W = (DEPTH > 1) ? $clog2(DEPTH) : 1`; `DEPTH=1` keeps pointers at zero.
- For simultaneous accepted push/pop, occupancy holds; preserve ordering and the specified read-during-write result.
- Reset metadata and required outputs. Do not reset every memory entry unless the contract requires observable clearing.
- Keep read-data validity and latency explicit; do not substitute FWFT for registered read.
- With ready/valid or pipelined reads, distinguish a request, an accepted queue operation, and consumption of returned data. A pending result may outlive the pop that produced it; hold it while its output protocol applies backpressure.
- Derive simultaneous consume/accept from the task's capacity and pre-edge handshake rules. An example does not require replacement, bypass, or a mandatory bubble in other protocols.
- This is not a CDC recipe: dual-clock FIFOs need a separate verified design.

Example: [fixed 4x8 FIFO](assets/example.sv). Exact boundary protocol: [notes](references/notes.md). The task overrides it.
