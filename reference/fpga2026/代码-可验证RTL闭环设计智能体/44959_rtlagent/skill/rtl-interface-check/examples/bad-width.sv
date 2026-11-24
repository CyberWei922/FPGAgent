module LaneCopy(input wire [4:0] payload, output wire [3:0] result);
  assign result = payload[3:0];
endmodule
