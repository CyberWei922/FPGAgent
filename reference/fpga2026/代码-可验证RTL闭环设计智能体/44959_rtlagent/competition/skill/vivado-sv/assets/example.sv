// Original small ROM: en samples addr at a rising edge; otherwise data holds.
// No reset: data is unspecified before the first enabled read.
module tiny_sync_rom (
    input  logic clk, en,
    input  logic [1:0] addr,
    output logic [7:0] data
);
    logic [7:0] selected;
    always_comb begin
        case (addr)
            2'd0: selected = {4'h1, 4'h2};
            2'd1: selected = {4'hA, 4'h5};
            2'd2: selected = {4'h3, 4'hC};
            2'd3: selected = {4'h9, 4'h6};
            default: selected = 8'd0;
        endcase
    end
    always_ff @(posedge clk) begin
        if (en) data <= selected;
    end
endmodule
