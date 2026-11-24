`timescale 1ns/1ps
module rtl_selfcheck_tb;
integer __rtl_check_checks = 0;
integer __rtl_check_failures = 0;
integer __rtl_check_reported = 0;
integer __rtl_check_fd;
reg [1:0] left;
reg [1:0] right;
wire [1:0] value;
ParityPair __rtl_check_dut(.left(left), .right(right), .value(value));
initial begin
  left = 2'h0;
  right = 2'h0;
  #2;
  __rtl_check_checks = __rtl_check_checks + 1;
  if (value !== 2'h0) begin
    __rtl_check_failures = __rtl_check_failures + 1;
    if (__rtl_check_reported == 0) begin
      __rtl_check_reported = 1;
      $display("RTL_SELFTEST_FAIL step=0 port=value expected=%h actual=%h constraints=C1", 2'h0, value);
      $display("RTL_SELFTEST_INPUT left=%h", left);
      $display("RTL_SELFTEST_INPUT right=%h", right);
    end
  end
  left = 2'h1;
  right = 2'h0;
  #2;
  __rtl_check_checks = __rtl_check_checks + 1;
  if (value !== 2'h1) begin
    __rtl_check_failures = __rtl_check_failures + 1;
    if (__rtl_check_reported == 0) begin
      __rtl_check_reported = 1;
      $display("RTL_SELFTEST_FAIL step=1 port=value expected=%h actual=%h constraints=C1", 2'h1, value);
      $display("RTL_SELFTEST_INPUT left=%h", left);
      $display("RTL_SELFTEST_INPUT right=%h", right);
    end
  end
  left = 2'h2;
  right = 2'h0;
  #2;
  __rtl_check_checks = __rtl_check_checks + 1;
  if (value !== 2'h2) begin
    __rtl_check_failures = __rtl_check_failures + 1;
    if (__rtl_check_reported == 0) begin
      __rtl_check_reported = 1;
      $display("RTL_SELFTEST_FAIL step=2 port=value expected=%h actual=%h constraints=C1", 2'h2, value);
      $display("RTL_SELFTEST_INPUT left=%h", left);
      $display("RTL_SELFTEST_INPUT right=%h", right);
    end
  end
  left = 2'h3;
  right = 2'h0;
  #2;
  __rtl_check_checks = __rtl_check_checks + 1;
  if (value !== 2'h3) begin
    __rtl_check_failures = __rtl_check_failures + 1;
    if (__rtl_check_reported == 0) begin
      __rtl_check_reported = 1;
      $display("RTL_SELFTEST_FAIL step=3 port=value expected=%h actual=%h constraints=C1", 2'h3, value);
      $display("RTL_SELFTEST_INPUT left=%h", left);
      $display("RTL_SELFTEST_INPUT right=%h", right);
    end
  end
  left = 2'h0;
  right = 2'h1;
  #2;
  __rtl_check_checks = __rtl_check_checks + 1;
  if (value !== 2'h1) begin
    __rtl_check_failures = __rtl_check_failures + 1;
    if (__rtl_check_reported == 0) begin
      __rtl_check_reported = 1;
      $display("RTL_SELFTEST_FAIL step=4 port=value expected=%h actual=%h constraints=C1", 2'h1, value);
      $display("RTL_SELFTEST_INPUT left=%h", left);
      $display("RTL_SELFTEST_INPUT right=%h", right);
    end
  end
  left = 2'h1;
  right = 2'h1;
  #2;
  __rtl_check_checks = __rtl_check_checks + 1;
  if (value !== 2'h0) begin
    __rtl_check_failures = __rtl_check_failures + 1;
    if (__rtl_check_reported == 0) begin
      __rtl_check_reported = 1;
      $display("RTL_SELFTEST_FAIL step=5 port=value expected=%h actual=%h constraints=C1", 2'h0, value);
      $display("RTL_SELFTEST_INPUT left=%h", left);
      $display("RTL_SELFTEST_INPUT right=%h", right);
    end
  end
  left = 2'h2;
  right = 2'h1;
  #2;
  __rtl_check_checks = __rtl_check_checks + 1;
  if (value !== 2'h3) begin
    __rtl_check_failures = __rtl_check_failures + 1;
    if (__rtl_check_reported == 0) begin
      __rtl_check_reported = 1;
      $display("RTL_SELFTEST_FAIL step=6 port=value expected=%h actual=%h constraints=C1", 2'h3, value);
      $display("RTL_SELFTEST_INPUT left=%h", left);
      $display("RTL_SELFTEST_INPUT right=%h", right);
    end
  end
  left = 2'h3;
  right = 2'h1;
  #2;
  __rtl_check_checks = __rtl_check_checks + 1;
  if (value !== 2'h2) begin
    __rtl_check_failures = __rtl_check_failures + 1;
    if (__rtl_check_reported == 0) begin
      __rtl_check_reported = 1;
      $display("RTL_SELFTEST_FAIL step=7 port=value expected=%h actual=%h constraints=C1", 2'h2, value);
      $display("RTL_SELFTEST_INPUT left=%h", left);
      $display("RTL_SELFTEST_INPUT right=%h", right);
    end
  end
  left = 2'h0;
  right = 2'h2;
  #2;
  __rtl_check_checks = __rtl_check_checks + 1;
  if (value !== 2'h2) begin
    __rtl_check_failures = __rtl_check_failures + 1;
    if (__rtl_check_reported == 0) begin
      __rtl_check_reported = 1;
      $display("RTL_SELFTEST_FAIL step=8 port=value expected=%h actual=%h constraints=C1", 2'h2, value);
      $display("RTL_SELFTEST_INPUT left=%h", left);
      $display("RTL_SELFTEST_INPUT right=%h", right);
    end
  end
  left = 2'h1;
  right = 2'h2;
  #2;
  __rtl_check_checks = __rtl_check_checks + 1;
  if (value !== 2'h3) begin
    __rtl_check_failures = __rtl_check_failures + 1;
    if (__rtl_check_reported == 0) begin
      __rtl_check_reported = 1;
      $display("RTL_SELFTEST_FAIL step=9 port=value expected=%h actual=%h constraints=C1", 2'h3, value);
      $display("RTL_SELFTEST_INPUT left=%h", left);
      $display("RTL_SELFTEST_INPUT right=%h", right);
    end
  end
  left = 2'h2;
  right = 2'h2;
  #2;
  __rtl_check_checks = __rtl_check_checks + 1;
  if (value !== 2'h0) begin
    __rtl_check_failures = __rtl_check_failures + 1;
    if (__rtl_check_reported == 0) begin
      __rtl_check_reported = 1;
      $display("RTL_SELFTEST_FAIL step=10 port=value expected=%h actual=%h constraints=C1", 2'h0, value);
      $display("RTL_SELFTEST_INPUT left=%h", left);
      $display("RTL_SELFTEST_INPUT right=%h", right);
    end
  end
  left = 2'h3;
  right = 2'h2;
  #2;
  __rtl_check_checks = __rtl_check_checks + 1;
  if (value !== 2'h1) begin
    __rtl_check_failures = __rtl_check_failures + 1;
    if (__rtl_check_reported == 0) begin
      __rtl_check_reported = 1;
      $display("RTL_SELFTEST_FAIL step=11 port=value expected=%h actual=%h constraints=C1", 2'h1, value);
      $display("RTL_SELFTEST_INPUT left=%h", left);
      $display("RTL_SELFTEST_INPUT right=%h", right);
    end
  end
  left = 2'h0;
  right = 2'h3;
  #2;
  __rtl_check_checks = __rtl_check_checks + 1;
  if (value !== 2'h3) begin
    __rtl_check_failures = __rtl_check_failures + 1;
    if (__rtl_check_reported == 0) begin
      __rtl_check_reported = 1;
      $display("RTL_SELFTEST_FAIL step=12 port=value expected=%h actual=%h constraints=C1", 2'h3, value);
      $display("RTL_SELFTEST_INPUT left=%h", left);
      $display("RTL_SELFTEST_INPUT right=%h", right);
    end
  end
  left = 2'h1;
  right = 2'h3;
  #2;
  __rtl_check_checks = __rtl_check_checks + 1;
  if (value !== 2'h2) begin
    __rtl_check_failures = __rtl_check_failures + 1;
    if (__rtl_check_reported == 0) begin
      __rtl_check_reported = 1;
      $display("RTL_SELFTEST_FAIL step=13 port=value expected=%h actual=%h constraints=C1", 2'h2, value);
      $display("RTL_SELFTEST_INPUT left=%h", left);
      $display("RTL_SELFTEST_INPUT right=%h", right);
    end
  end
  left = 2'h2;
  right = 2'h3;
  #2;
  __rtl_check_checks = __rtl_check_checks + 1;
  if (value !== 2'h1) begin
    __rtl_check_failures = __rtl_check_failures + 1;
    if (__rtl_check_reported == 0) begin
      __rtl_check_reported = 1;
      $display("RTL_SELFTEST_FAIL step=14 port=value expected=%h actual=%h constraints=C1", 2'h1, value);
      $display("RTL_SELFTEST_INPUT left=%h", left);
      $display("RTL_SELFTEST_INPUT right=%h", right);
    end
  end
  left = 2'h3;
  right = 2'h3;
  #2;
  __rtl_check_checks = __rtl_check_checks + 1;
  if (value !== 2'h0) begin
    __rtl_check_failures = __rtl_check_failures + 1;
    if (__rtl_check_reported == 0) begin
      __rtl_check_reported = 1;
      $display("RTL_SELFTEST_FAIL step=15 port=value expected=%h actual=%h constraints=C1", 2'h0, value);
      $display("RTL_SELFTEST_INPUT left=%h", left);
      $display("RTL_SELFTEST_INPUT right=%h", right);
    end
  end
  __rtl_check_fd = $fopen("selftest_result.txt", "w");
  if (__rtl_check_fd == 0) $fatal(1, "Self-check completion file could not be opened");
  $fwrite(__rtl_check_fd, "checks=%0d failures=%0d\n", __rtl_check_checks, __rtl_check_failures);
  $fclose(__rtl_check_fd);
  $display("RTL_SELFTEST_COMPLETE checks=%0d failures=%0d", __rtl_check_checks, __rtl_check_failures);
  $finish;
end
endmodule
