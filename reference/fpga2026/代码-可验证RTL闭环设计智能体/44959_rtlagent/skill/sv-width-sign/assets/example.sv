// Original example: exact sum of two signed 8-bit values, no saturation.
module signed_widen_add (
    input  logic signed [7:0] a,
    input  logic signed [7:0] b,
    output logic signed [8:0] sum
);
    logic signed [8:0] wide_a;
    logic signed [8:0] wide_b;
    assign wide_a = {a[7], a};
    assign wide_b = {b[7], b};
    assign sum = wide_a + wide_b;
endmodule
