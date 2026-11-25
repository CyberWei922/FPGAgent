import type { TestVectorStep } from '../types/contracts';

export function deriveVerilogFilename(code: string, fallbackName?: string, suggested?: string): string {
  if (suggested && /\.v$/i.test(suggested.trim())) return suggested.trim();
  const match = code.match(/\bmodule\s+([a-zA-Z_][a-zA-Z0-9_]*)/);
  if (match && match[1] && match[1] !== 'top') return `${match[1]}.v`;
  if (fallbackName) {
    const slug = fallbackName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    if (slug) return `${slug}.v`;
  }
  return 'fpgagent_top.v';
}

export function downloadTextFile(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function buildFallbackTestbench(code: string, vectors: TestVectorStep[]): string {
  const moduleMatch = code.match(/\bmodule\s+([a-zA-Z_][a-zA-Z0-9_]*)/);
  const modName = moduleMatch?.[1] ?? 'top';
  const lines: string[] = [
    '`timescale 1ns/1ps',
    '',
    'module tb_top;',
    '  reg clk = 0;',
    '  reg rst_n = 0;',
    '  reg [3:0] key = 4\'d0;',
    '  reg [7:0] sw = 8\'d0;',
    '  wire [7:0] led;',
    '  wire [2:0] traffic;',
    '  wire [15:0] seg;',
    '',
    `  ${modName} dut (`,
    '    .clk(clk),',
    '    .rst_n(rst_n),',
    '    .key(key),',
    '    .sw(sw),',
    '    .led(led),',
    '    .traffic(traffic),',
    '    .seg(seg)',
    '  );',
    '',
    '  always #5 clk = ~clk;',
    '',
    '  integer errors = 0;',
    '',
    '  initial begin',
  ];

  for (const step of vectors) {
    lines.push(
      `    // Cycle ${step.cycle}${step.note ? `: ${step.note}` : ''}`,
      `    rst_n = 1'b${step.inputs.rst_n}; key = 4'h${(step.inputs.key & 0xf).toString(16)}; sw = 8'h${(step.inputs.sw & 0xff).toString(16).padStart(2, '0')};`,
      '    @(posedge clk); #1;',
    );
    if (step.expect?.led !== undefined) {
      lines.push(
        `    if (led !== 8'h${(step.expect.led & 0xff).toString(16).padStart(2, '0')}) begin $display("FAIL cycle ${step.cycle}: led=%h", led); errors = errors + 1; end`,
      );
    }
    if (step.expect?.traffic !== undefined) {
      lines.push(
        `    if (traffic !== 3'b${(step.expect.traffic & 0x7).toString(2).padStart(3, '0')}) begin $display("FAIL cycle ${step.cycle}: traffic=%b", traffic); errors = errors + 1; end`,
      );
    }
    if (step.expect?.seg !== undefined) {
      lines.push(
        `    if (seg !== 16'h${(step.expect.seg & 0xffff).toString(16).padStart(4, '0')}) begin $display("FAIL cycle ${step.cycle}: seg=%h", seg); errors = errors + 1; end`,
      );
    }
  }

  lines.push(
    '    if (errors == 0) $display("ALL TESTS PASSED");',
    '    else $display("FAILED WITH %0d ERRORS", errors);',
    '    $finish;',
    '  end',
    'endmodule',
    '',
  );
  return lines.join('\n');
}
