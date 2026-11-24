module SignedShift(input logic [6:0] data, output logic [6:0] result);
  assign result = $signed(data) >>> 2;
endmodule
