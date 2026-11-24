---
name: sv-sequential
description: Preserve clock, reset, enable, and old-state semantics when generating or repairing sequential RTL.
---

Follow the task's interface, reset, enable, and exact acceptance/output edges. Use nonblocking state assignments and one driver per register. Synchronous reset has only the clock event in always_ff; asynchronous reset also has the specified reset edge. Do not substitute initialization or clock gating.

Serial bit order describes arrival order, not the insertion end: trace one complete word to derive the shift direction. For edge capture, derive the history register's behavior during reset separately from the sticky output's reset.

The example below applies ONLY to this contract: two registered stages, global CE, synchronous active-high reset, and invalid bubbles that hold output data. Adapt these choices when the task differs.

| Event | State immediately after the edge |
|---|---|
| Enabled N accepts transaction T | s1=f(T), s1_valid=1; output uses the OLD s1 entry |
| Next enabled N+1 | data_o=f(T), valid_o=1; output is stage 2 |
| ce=0, reset=0 | ALL data and valid registers hold |
| ce=1, old s1_valid=0 | valid_o=0; data_o holds; next s1_valid=valid_i |
| reset=1 | All registers clear, even when ce=0 |

N and N+1 count enabled edges; stalled physical edges add no transfers. An invalid input at N+1 does not cancel T's output on that edge. Downstream logic uses s1 with s1_valid, never live data_i with an older valid. data_o IS the second register: adding s2 then data_o would create an unwanted third stage for this contract.

After a repair, trace every new register into the real output dependency path. Adding unused operand registers does not fix an arithmetic expression that still reads live inputs.

```systemverilog
module xor_pipe2 (
    input  logic clk, reset, ce, valid_i,
    input  logic [7:0] data_i,
    output logic [7:0] data_o,
    output logic valid_o
);
    logic [7:0] s1;
    logic s1_valid;
    always_ff @(posedge clk) begin
        if (reset) begin
            s1 <= '0;
            s1_valid <= 1'b0;
            data_o <= '0;
            valid_o <= 1'b0;
        end else if (ce) begin
            s1_valid <= valid_i;
            if (valid_i) s1 <= data_i ^ 8'h5a;
            valid_o <= s1_valid;
            if (s1_valid) data_o <= s1;
        end
    end
endmodule
```

Check back-to-back transactions, stalled valid outputs, bubbles, and reset during a stall. Single-register example: [enabled register](assets/example.sv). Sources and boundaries: [notes](references/notes.md).
