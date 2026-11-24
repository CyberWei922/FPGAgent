module ParityPair(input wire [1:0] left, right, output wire [1:0] value);
  assign value = left ^ right;
endmodule
