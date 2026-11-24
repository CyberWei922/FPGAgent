// Original example: WIDTH >= 1; synchronous active-low reset wins over load.
module enabled_word #(
    parameter integer WIDTH = 8
) (
    input  logic             clk,
    input  logic             rst_n,
    input  logic             load,
    input  logic [WIDTH-1:0] d,
    output logic [WIDTH-1:0] q
);
    always_ff @(posedge clk) begin
        if (!rst_n)
            q <= '0;
        else if (load)
            q <= d;
    end
endmodule
