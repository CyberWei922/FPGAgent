import { describe, expect, it } from 'vitest';
import {
  buildNetlist,
  createRtlEngine,
  elaborate,
  lintVerilog,
  parseVerilog,
  runDeterministicSelfTest,
  SimulationSession,
  tokenizeVerilogForHighlight,
} from '../src/engine/index';
import { MOCK_PRESETS } from '../src/agent/mockPresets';
import { PRESETS } from '../src/agent/presets';
import type { BoardInputs, TestVectorStep } from '../src/types/contracts';

const DEFAULT_IN: BoardInputs = { rst_n: 1, key: 0, sw: 0 };

const preset = MOCK_PRESETS[0];
const idle = { rst_n: 1 as const, key: 0, sw: 0 };

describe('0. M0 冻结契约冒烟测试 (RtlEngine)', () => {
  it('compile 合法代码返回 ok 与网表', () => {
    const result = createRtlEngine().compile(preset.verilogCode);
    expect(result.ok).toBe(true);
    expect(result.netlist?.nodes.length).toBeGreaterThan(0);
  });

  it('compile 空代码返回 PARSE_ERROR', () => {
    const result = createRtlEngine().compile('');
    expect(result.ok).toBe(false);
    expect(result.issues[0].code).toBe('PARSE_ERROR');
  });

  it('step 的 cycle 从 0 开始，reset 后重新计数', () => {
    const engine = createRtlEngine();
    engine.compile(preset.verilogCode);
    expect(engine.step(idle).sample.cycle).toBe(0);
    expect(engine.step(idle).sample.cycle).toBe(1);
    engine.reset();
    expect(engine.step(idle).sample.cycle).toBe(0);
  });

  it('网表的边只引用存在的节点，level 不超过 maxLevel', () => {
    const engine = createRtlEngine();
    engine.compile(preset.verilogCode);
    const { netlist } = engine.step(idle);
    const ids = new Set(netlist.nodes.map((n) => n.id));
    for (const e of netlist.edges) {
      expect(ids.has(e.from) && ids.has(e.to)).toBe(true);
    }
    for (const n of netlist.nodes) expect(n.level).toBeLessThanOrEqual(netlist.maxLevel);
  });

  it('交通灯预置案例自测全部通过', () => {
    const result = createRtlEngine().runSelfTest(preset.verilogCode, preset.testVectors);
    expect(result.passed).toBe(true);
    expect(result.totalChecks).toBeGreaterThan(0);
    expect(result.waveform).toHaveLength(preset.testVectors.length);
  });

  it('错误期望会给出首个反例与回退周期', () => {
    const vectors = preset.testVectors.map((v) => ({ ...v }));
    const firstGreen = vectors.findIndex((vector) => vector.expect?.traffic === 0b001);
    vectors[firstGreen].expect = { traffic: 0b100 };
    const previous = createRtlEngine().runSelfTest(preset.verilogCode, preset.testVectors).passedCycles;
    const result = createRtlEngine().runSelfTest(preset.verilogCode, vectors, previous);
    expect(result.passed).toBe(false);
    expect(result.firstFailure).toMatchObject({ cycle: firstGreen, signal: 'traffic', expected: 0b100, actual: 0b001 });
    expect(result.regressedCycles).toEqual([firstGreen]);
  });

  it('runSelfTest 不影响当前运行实例', () => {
    const engine = createRtlEngine();
    engine.compile(preset.verilogCode);
    engine.step(idle);
    engine.runSelfTest(preset.verilogCode, preset.testVectors);
    expect(engine.step(idle).sample.cycle).toBe(1);
  });
});

function buildSession(code: string): SimulationSession {
  const parsed = parseVerilog(code);
  expect(parsed.errors).toEqual([]);
  expect(parsed.ast).toBeDefined();
  return new SimulationSession(elaborate(parsed.ast!));
}

describe('1. 词法与语法解析 (parser.ts)', () => {
  it('支持二进制/八进制/十进制/十六进制字面量与下划线分隔', () => {
    const code = `
      module top(
        input clk,
        input rst_n,
        input [3:0] key,
        input [7:0] sw,
        output [7:0] led,
        output [2:0] traffic,
        output [15:0] seg
      );
        assign led = 8'b1010_0101;
        assign traffic = 3'o5;
        assign seg = 16'h12_AB;
      endmodule
    `;
    const sim = buildSession(code);
    const { sample } = sim.step(DEFAULT_IN);
    expect(sample.outputs.led).toBe(0b10100101);
    expect(sample.outputs.traffic).toBe(5);
    expect(sample.outputs.seg).toBe(0x12ab);
  });

  it('同时兼容 ANSI 与非 ANSI 端口声明风格', () => {
    const nonAnsi = `
      module top(clk, rst_n, key, sw, led, traffic, seg);
        input clk;
        input rst_n;
        input [3:0] key;
        input [7:0] sw;
        output [7:0] led;
        output [2:0] traffic;
        output [15:0] seg;
        assign led = sw;
        assign traffic = key[2:0];
        assign seg = {8'h00, sw};
      endmodule
    `;
    const sim = buildSession(nonAnsi);
    const { sample } = sim.step({ rst_n: 1, key: 0b0110, sw: 0x3c });
    expect(sample.outputs.led).toBe(0x3c);
    expect(sample.outputs.traffic).toBe(0b110);
    expect(sample.outputs.seg).toBe(0x003c);
  });

  it('支持 parameter/localparam 常量表达式及参数化位宽', () => {
    const code = `
      module top #(parameter W = 4) (
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        localparam SHIFT = W - 1;
        wire [W-1:0] low_nib;
        assign low_nib = sw[3:0];
        assign led = {low_nib, 4'd0} | SHIFT;
        assign traffic = 3'd0;
        assign seg = 16'd0;
      endmodule
    `;
    const sim = buildSession(code);
    const { sample } = sim.step({ rst_n: 1, key: 0, sw: 0x05 });
    expect(sample.outputs.led).toBe((5 << 4) | 3);
  });

  it('正确解析运算符优先级（算术 > 移位 > 比较 > 位运算 > 三目）', () => {
    const code = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        assign led = (sw + 1 * 2 == 8'd10) ? (8'd1 << 3) | 8'd1 : 8'd0;
        assign traffic = 3'd0;
        assign seg = 16'd0;
      endmodule
    `;
    const sim = buildSession(code);
    expect(sim.step({ rst_n: 1, key: 0, sw: 8 }).sample.outputs.led).toBe(9);
    expect(sim.step({ rst_n: 1, key: 0, sw: 7 }).sample.outputs.led).toBe(0);
  });

  it('支持位拼接、位复制与位切片', () => {
    const code = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        assign led = {sw[3:0], sw[7:4]};
        assign traffic = {3{key[0]}};
        assign seg = {4{key}};
      endmodule
    `;
    const sim = buildSession(code);
    const { sample } = sim.step({ rst_n: 1, key: 0b0101, sw: 0xa3 });
    expect(sample.outputs.led).toBe(0x3a);
    expect(sample.outputs.traffic).toBe(0b111);
    expect(sample.outputs.seg).toBe(0x5555);
  });

  it('支持注释与预处理指令忽略', () => {
    const code = `
      \`timescale 1ns/1ps
      /* 多行注释
         说明模块功能 */
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        // 单行注释
        assign led = ~sw;
        assign traffic = 3'b000;
        assign seg = 16'h0000;
      endmodule
    `;
    const sim = buildSession(code);
    expect(sim.step({ rst_n: 1, key: 0, sw: 0x0f }).sample.outputs.led).toBe(0xf0);
  });

  it('语法错误返回精确行号与中文解释（缺分号 / 缺 endmodule / 非法进制）', () => {
    const missingSemi = `module top(input clk, output [7:0] led);
  assign led = 8'd1
endmodule`;
    const r1 = parseVerilog(missingSemi);
    expect(r1.ast).toBeUndefined();
    expect(r1.errors[0].code).toBe('PARSE_ERROR');
    expect(r1.errors[0].line).toBe(3);
    expect(r1.errors[0].message).toContain('期望');

    const badLiteral = `module top(input clk, output [7:0] led);
  assign led = 4'b1020;
endmodule`;
    const r2 = parseVerilog(badLiteral);
    expect(r2.errors[0].code).toBe('PARSE_ERROR');
    expect(r2.errors[0].line).toBe(2);
    expect(r2.errors[0].message).toContain('二进制');
  });
});

describe('2. 组合逻辑求值与收敛 (simulator.ts)', () => {
  it('支持 assign 基本门运算与归约运算符', () => {
    const code = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        assign led[0] = &key;
        assign led[1] = |key;
        assign led[2] = ^key;
        assign led[7:3] = 5'd0;
        assign traffic = 3'd0;
        assign seg = 16'd0;
      endmodule
    `;
    const sim = buildSession(code);
    expect(sim.step({ rst_n: 1, key: 0b1111, sw: 0 }).sample.outputs.led).toBe(0b011);
    expect(sim.step({ rst_n: 1, key: 0b0100, sw: 0 }).sample.outputs.led).toBe(0b110);
    expect(sim.step({ rst_n: 1, key: 0b0000, sw: 0 }).sample.outputs.led).toBe(0b000);
  });

  it('支持 always @(*) 与 always_comb 中的 if/else 优先级', () => {
    const code = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output reg [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        always_comb begin
          if (key[0])
            led = 8'h01;
          else if (key[1])
            led = 8'h02;
          else
            led = sw;
        end
        assign traffic = 3'd0;
        assign seg = 16'd0;
      endmodule
    `;
    const sim = buildSession(code);
    expect(sim.step({ rst_n: 1, key: 0b0011, sw: 0xaa }).sample.outputs.led).toBe(0x01);
    expect(sim.step({ rst_n: 1, key: 0b0010, sw: 0xaa }).sample.outputs.led).toBe(0x02);
    expect(sim.step({ rst_n: 1, key: 0b0000, sw: 0xaa }).sample.outputs.led).toBe(0xaa);
  });

  it('支持 case 多分支标签与 default 译码', () => {
    const code = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output reg [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        always @(*) begin
          case (key[1:0])
            2'd0: led = 8'h11;
            2'd1, 2'd2: led = 8'h22;
            default: led = 8'hff;
          endcase
        end
        assign traffic = 3'd0;
        assign seg = 16'd0;
      endmodule
    `;
    const sim = buildSession(code);
    expect(sim.step({ rst_n: 1, key: 0, sw: 0 }).sample.outputs.led).toBe(0x11);
    expect(sim.step({ rst_n: 1, key: 1, sw: 0 }).sample.outputs.led).toBe(0x22);
    expect(sim.step({ rst_n: 1, key: 2, sw: 0 }).sample.outputs.led).toBe(0x22);
    expect(sim.step({ rst_n: 1, key: 3, sw: 0 }).sample.outputs.led).toBe(0xff);
  });

  it('多级倒序 assign 组合链能够迭代收敛到正确稳态', () => {
    const code = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        wire [7:0] s1, s2, s3;
        assign led = s3 + 8'd1;
        assign s3 = s2 + 8'd1;
        assign s2 = s1 + 8'd1;
        assign s1 = sw + 8'd1;
        assign traffic = 3'd0;
        assign seg = 16'd0;
      endmodule
    `;
    const sim = buildSession(code);
    const out = sim.step({ rst_n: 1, key: 0, sw: 10 });
    expect(out.combLoopDetected).toBe(false);
    expect(out.sample.outputs.led).toBe(14);
  });

  it('存在组合环路时在 16 轮上限安全终止并上报 combLoopDetected', () => {
    const code = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        wire ring;
        assign ring = ~ring;
        assign led = {7'd0, ring};
        assign traffic = 3'd0;
        assign seg = 16'd0;
      endmodule
    `;
    const sim = buildSession(code);
    const out = sim.step(DEFAULT_IN);
    expect(out.combLoopDetected).toBe(true);
    const result = createRtlEngine().runSelfTest(code, [{ cycle: 0, inputs: DEFAULT_IN, expect: out.sample.outputs }], [0]);
    expect(result).toMatchObject({ passed: false, passedChecks: 0, passedCycles: [], regressedCycles: [0], firstUnstableCycle: 0 });
  });

  it('组合块先赋默认值再覆盖时可正常收敛', () => {
    const sim = buildSession(`
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output reg [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        always @(*) begin
          led = 8'd0;
          if (key[0]) led = sw;
        end
        assign traffic = 3'd0;
        assign seg = 16'd0;
      endmodule
    `);
    const result = sim.step({ rst_n: 1, key: 1, sw: 7 });
    expect(result.combLoopDetected).toBe(false);
    expect(result.sample.outputs.led).toBe(7);
  });

  it('除数为 0 时安全返回 0 而不产生 NaN', () => {
    const code = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        assign led = sw / key;
        assign traffic = 3'd0;
        assign seg = 16'd0;
      endmodule
    `;
    const sim = buildSession(code);
    expect(sim.step({ rst_n: 1, key: 0, sw: 20 }).sample.outputs.led).toBe(0);
    expect(sim.step({ rst_n: 1, key: 4, sw: 20 }).sample.outputs.led).toBe(5);
  });
});

describe('3. 时序逻辑、NBA 并发语义与位宽符号 (simulator.ts)', () => {
  it('异步低电平复位 always @(posedge clk or negedge rst_n) 正常工作', () => {
    const code = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output reg [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        always @(posedge clk or negedge rst_n) begin
          if (!rst_n)
            led <= 8'h55;
          else
            led <= led + 8'd1;
        end
        assign traffic = 3'd0;
        assign seg = 16'd0;
      endmodule
    `;
    const sim = buildSession(code);
    expect(sim.step({ rst_n: 0, key: 0, sw: 0 }).sample.outputs.led).toBe(0x55);
    expect(sim.step({ rst_n: 1, key: 0, sw: 0 }).sample.outputs.led).toBe(0x56);
    expect(sim.step({ rst_n: 1, key: 0, sw: 0 }).sample.outputs.led).toBe(0x57);
    expect(sim.step({ rst_n: 0, key: 0, sw: 0 }).sample.outputs.led).toBe(0x55);
  });

  it('同步复位 always @(posedge clk) 内 if (!rst_n) 正常工作', () => {
    const code = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output reg [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        always @(posedge clk) begin
          if (!rst_n)
            led <= 8'd0;
          else
            led <= sw;
        end
        assign traffic = 3'd0;
        assign seg = 16'd0;
      endmodule
    `;
    const sim = buildSession(code);
    expect(sim.step({ rst_n: 1, key: 0, sw: 0x42 }).sample.outputs.led).toBe(0x42);
    expect(sim.step({ rst_n: 0, key: 0, sw: 0x42 }).sample.outputs.led).toBe(0);
  });

  it('非阻塞赋值 <= 原子并发提交（a <= b; b <= a 正确互换）', () => {
    const code = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        reg [3:0] a, b;
        always @(posedge clk or negedge rst_n) begin
          if (!rst_n) begin
            a <= 4'hA;
            b <= 4'h5;
          end else begin
            a <= b;
            b <= a;
          end
        end
        assign led = {a, b};
        assign traffic = 3'd0;
        assign seg = 16'd0;
      endmodule
    `;
    const sim = buildSession(code);
    expect(sim.step({ rst_n: 0, key: 0, sw: 0 }).sample.outputs.led).toBe(0xa5);
    expect(sim.step({ rst_n: 1, key: 0, sw: 0 }).sample.outputs.led).toBe(0x5a);
    expect(sim.step({ rst_n: 1, key: 0, sw: 0 }).sample.outputs.led).toBe(0xa5);
  });

  it('寄存器位宽截断与溢出回绕正确', () => {
    const code = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        reg [2:0] cnt;
        always @(posedge clk or negedge rst_n) begin
          if (!rst_n) cnt <= 3'd6;
          else cnt <= cnt + 3'd1;
        end
        assign led = {5'd0, cnt};
        assign traffic = 3'd0;
        assign seg = 16'd0;
      endmodule
    `;
    const sim = buildSession(code);
    expect(sim.step({ rst_n: 0, key: 0, sw: 0 }).sample.outputs.led).toBe(6);
    expect(sim.step({ rst_n: 1, key: 0, sw: 0 }).sample.outputs.led).toBe(7);
    expect(sim.step({ rst_n: 1, key: 0, sw: 0 }).sample.outputs.led).toBe(0);
    expect(sim.step({ rst_n: 1, key: 0, sw: 0 }).sample.outputs.led).toBe(1);
  });

  it('支持位切片非阻塞赋值与左值拼接赋值', () => {
    const code = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output reg [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        reg [3:0] hi, lo;
        always @(posedge clk or negedge rst_n) begin
          if (!rst_n) begin
            led <= 8'h00;
            {hi, lo} <= 8'h3C;
          end else begin
            led[7:4] <= hi;
            led[3:0] <= lo;
          end
        end
        assign traffic = 3'd0;
        assign seg = 16'd0;
      endmodule
    `;
    const sim = buildSession(code);
    expect(sim.step({ rst_n: 0, key: 0, sw: 0 }).sample.outputs.led).toBe(0x00);
    expect(sim.step({ rst_n: 1, key: 0, sw: 0 }).sample.outputs.led).toBe(0x3c);
  });

  it('正确区分有符号 signed >>> 算术右移与无符号 >>> 逻辑补零', () => {
    const code = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        wire signed [7:0] s_in = sw;
        wire [7:0] u_in = sw;
        assign led = $signed(sw) >>> 2;
        assign seg = { (u_in >>> 2), (s_in >>> 2) };
        assign traffic = 3'd0;
      endmodule
    `;
    const sim = buildSession(code);
    // 0x80 = -128 in signed 8-bit; arithmetic >>> 2 => 0xE0 (-32); unsigned >>> 2 => 0x20 (32)
    const { sample } = sim.step({ rst_n: 1, key: 0, sw: 0x80 });
    expect(sample.outputs.led).toBe(0xe0);
    expect(sample.outputs.seg).toBe(0x20e0);
  });

  it('reset() 能彻底清零内部寄存器并将 cycle 归零', () => {
    const code = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output reg [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        always @(posedge clk) led <= led + 8'd1;
        assign traffic = 3'd0;
        assign seg = 16'd0;
      endmodule
    `;
    const sim = buildSession(code);
    sim.step(DEFAULT_IN);
    sim.step(DEFAULT_IN);
    const s3 = sim.step(DEFAULT_IN).sample;
    expect(s3.cycle).toBe(2);
    expect(s3.outputs.led).toBe(3);

    sim.reset();
    const s1 = sim.step(DEFAULT_IN).sample;
    expect(s1.cycle).toBe(0);
    expect(s1.outputs.led).toBe(1);
  });
});

describe('4. 经典硬件电路端到端仿真验证', () => {
  it('智能十字路口交通灯（绿4 -> 黄1 -> 红5 + KEY0 紧急全红 + 数码管倒计时）', () => {
    const trafficVerilog = `
      module top(
        input clk,
        input rst_n,
        input [3:0] key,
        input [7:0] sw,
        output [7:0] led,
        output reg [2:0] traffic,
        output [15:0] seg
      );
        localparam S_GREEN  = 2'd0;
        localparam S_YELLOW = 2'd1;
        localparam S_RED    = 2'd2;

        reg [1:0] state;
        reg [3:0] timer;

        always @(posedge clk or negedge rst_n) begin
          if (!rst_n) begin
            state <= S_GREEN;
            timer <= 4'd4;
          end else if (key[0]) begin
            state <= S_RED;
            timer <= 4'd5;
          end else if (timer > 4'd1) begin
            timer <= timer - 4'd1;
          end else begin
            case (state)
              S_GREEN:  begin state <= S_YELLOW; timer <= 4'd1; end
              S_YELLOW: begin state <= S_RED;    timer <= 4'd5; end
              default:  begin state <= S_GREEN;  timer <= 4'd4; end
            endcase
          end
        end

        always @(*) begin
          case (state)
            S_GREEN:  traffic = 3'b001;
            S_YELLOW: traffic = 3'b010;
            default:  traffic = 3'b100;
          endcase
        end

        assign led = {5'd0, traffic};
        assign seg = {12'h000, timer};
      endmodule
    `;

    const sim = buildSession(trafficVerilog);
    // Reset -> Green, timer=4
    let s = sim.step({ rst_n: 0, key: 0, sw: 0 }).sample;
    expect(s.outputs.traffic).toBe(0b001);
    expect(s.outputs.seg).toBe(4);

    // Count down Green: 3 -> 2 -> 1 -> transition to Yellow(1)
    expect(sim.step(DEFAULT_IN).sample.outputs).toMatchObject({ traffic: 0b001, seg: 3 });
    expect(sim.step(DEFAULT_IN).sample.outputs).toMatchObject({ traffic: 0b001, seg: 2 });
    expect(sim.step(DEFAULT_IN).sample.outputs).toMatchObject({ traffic: 0b001, seg: 1 });
    expect(sim.step(DEFAULT_IN).sample.outputs).toMatchObject({ traffic: 0b010, seg: 1 });

    // Yellow(1) -> Red(5)
    expect(sim.step(DEFAULT_IN).sample.outputs).toMatchObject({ traffic: 0b100, seg: 5 });

    // Count down Red: 4 -> 3 -> 2 -> 1 -> Green(4)
    for (let t = 4; t >= 1; t--) {
      expect(sim.step(DEFAULT_IN).sample.outputs).toMatchObject({ traffic: 0b100, seg: t });
    }
    expect(sim.step(DEFAULT_IN).sample.outputs).toMatchObject({ traffic: 0b001, seg: 4 });

    // Press KEY0 emergency -> immediate Red(5)
    s = sim.step({ rst_n: 1, key: 0b0001, sw: 0 }).sample;
    expect(s.outputs.traffic).toBe(0b100);
    expect(s.outputs.seg).toBe(5);
  });

  it('两段式 FSM：1011 重叠序列检测器（sw[0] 串行输入 -> led[0] 命中）', () => {
    const seqDetector = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        localparam S0 = 3'd0, S1 = 3'd1, S10 = 3'd2, S101 = 3'd3, S1011 = 3'd4;
        reg [2:0] state, next_state;
        wire din = sw[0];

        always @(*) begin
          case (state)
            S0:    next_state = din ? S1 : S0;
            S1:    next_state = din ? S1 : S10;
            S10:   next_state = din ? S101 : S0;
            S101:  next_state = din ? S1011 : S10;
            S1011: next_state = din ? S1 : S10;
            default: next_state = S0;
          endcase
        end

        always @(posedge clk or negedge rst_n) begin
          if (!rst_n) state <= S0;
          else state <= next_state;
        end

        assign led = {7'd0, (state == S1011)};
        assign traffic = 3'd0;
        assign seg = {13'd0, state};
      endmodule
    `;

    const sim = buildSession(seqDetector);
    sim.step({ rst_n: 0, key: 0, sw: 0 });

    // Feed 1, 0, 1, 1, 0, 1, 1 (overlapping 1011 twice!)
    const bits = [1, 0, 1, 1, 0, 1, 1];
    const hits = bits.map((b) => sim.step({ rst_n: 1, key: 0, sw: b }).sample.outputs.led & 1);
    expect(hits).toEqual([0, 0, 0, 1, 0, 0, 1]);
  });

  it('4 位 BCD 数字秒表（key[0] 使能计数，seg[15:0] 正确十进制进位）', () => {
    const stopwatch = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        reg [3:0] d0, d1;
        always @(posedge clk or negedge rst_n) begin
          if (!rst_n) begin
            d0 <= 4'd0;
            d1 <= 4'd0;
          end else if (key[0]) begin
            if (d0 == 4'd9) begin
              d0 <= 4'd0;
              d1 <= (d1 == 4'd9) ? 4'd0 : (d1 + 4'd1);
            end else begin
              d0 <= d0 + 4'd1;
            end
          end
        end
        assign seg = {8'h00, d1, d0};
        assign led = {d1, d0};
        assign traffic = 3'd0;
      endmodule
    `;

    const sim = buildSession(stopwatch);
    sim.step({ rst_n: 0, key: 0, sw: 0 });
    // Run 12 cycles with key[0] = 1 -> BCD should be 0x0012
    let lastSeg = 0;
    for (let i = 0; i < 12; i++) {
      lastSeg = sim.step({ rst_n: 1, key: 1, sw: 0 }).sample.outputs.seg;
    }
    expect(lastSeg).toBe(0x0012);

    // Pause (key[0] = 0) -> holds at 0x0012
    expect(sim.step({ rst_n: 1, key: 0, sw: 0 }).sample.outputs.seg).toBe(0x0012);
  });

  it('4 位数字密码锁（sw[3:0] 输入数字，key[0] 确认，key[1] 清除，密码 1-2-3-4）', () => {
    const lockVerilog = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output reg [7:0] led, output [2:0] traffic, output reg [15:0] seg
      );
        reg [2:0] cnt;
        always @(posedge clk or negedge rst_n) begin
          if (!rst_n) begin
            cnt <= 3'd0;
            seg <= 16'h0000;
            led <= 8'h00;
          end else if (key[1]) begin
            cnt <= 3'd0;
            seg <= 16'h0000;
            led <= 8'h00;
          end else if (key[0] && cnt < 3'd4) begin
            seg <= {seg[11:0], sw[3:0]};
            cnt <= cnt + 3'd1;
            if (cnt == 3'd3) begin
              if ({seg[11:0], sw[3:0]} == 16'h1234)
                led <= 8'h01;
              else
                led <= 8'h02;
            end
          end
        end
        assign traffic = led[0] ? 3'b001 : (led[1] ? 3'b100 : 3'b000);
      endmodule
    `;
    const sim = buildSession(lockVerilog);
    sim.step({ rst_n: 0, key: 0, sw: 0 });

    // Enter wrong password 1-2-3-5
    for (const d of [1, 2, 3, 5]) {
      sim.step({ rst_n: 1, key: 0b0001, sw: d });
    }
    expect(sim.step({ rst_n: 1, key: 0, sw: 0 }).sample.outputs).toMatchObject({
      led: 0x02,
      traffic: 0b100,
      seg: 0x1235,
    });

    // Clear with key[1], then enter correct password 1-2-3-4
    sim.step({ rst_n: 1, key: 0b0010, sw: 0 });
    for (const d of [1, 2, 3, 4]) {
      sim.step({ rst_n: 1, key: 0b0001, sw: d });
    }
    expect(sim.step({ rst_n: 1, key: 0, sw: 0 }).sample.outputs).toMatchObject({
      led: 0x01,
      traffic: 0b001,
      seg: 0x1234,
    });
  });

  it('四人抢答器（sw[0] 主持人允许抢答，key[3:0] 锁定首位抢答选手）', () => {
    const buzzerVerilog = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output reg [7:0] led, output [2:0] traffic, output reg [15:0] seg
      );
        reg locked;
        always @(posedge clk or negedge rst_n) begin
          if (!rst_n || !sw[0]) begin
            locked <= 1'b0;
            led <= 8'h00;
            seg <= 16'h0000;
          end else if (!locked && (key != 4'd0)) begin
            locked <= 1'b1;
            if (key[0]) begin led <= 8'h01; seg <= 16'h0001; end
            else if (key[1]) begin led <= 8'h02; seg <= 16'h0002; end
            else if (key[2]) begin led <= 8'h04; seg <= 16'h0003; end
            else begin led <= 8'h08; seg <= 16'h0004; end
          end
        end
        assign traffic = locked ? 3'b100 : (sw[0] ? 3'b001 : 3'b010);
      endmodule
    `;
    const sim = buildSession(buzzerVerilog);
    // Host not ready (sw[0] = 0)
    expect(sim.step({ rst_n: 1, key: 0b0100, sw: 0 }).sample.outputs).toMatchObject({
      led: 0,
      seg: 0,
      traffic: 0b010,
    });
    // Host enables round, player 3 (key[2]) buzzes first
    expect(sim.step({ rst_n: 1, key: 0b0100, sw: 1 }).sample.outputs).toMatchObject({
      led: 0x04,
      seg: 0x0003,
      traffic: 0b100,
    });
    // Player 1 tries after lock -> remains locked to player 3
    expect(sim.step({ rst_n: 1, key: 0b0001, sw: 1 }).sample.outputs).toMatchObject({
      led: 0x04,
      seg: 0x0003,
    });
  });
});

describe('5. 教学级门网表与白话播报 (netlist.ts)', () => {
  const trafficCode = `
    module top(
      input clk, input rst_n, input [3:0] key, input [7:0] sw,
      output [7:0] led, output reg [2:0] traffic, output [15:0] seg
    );
      reg [1:0] state;
      always @(posedge clk or negedge rst_n) begin
        if (!rst_n) state <= 2'd0;
        else if (key[0]) state <= 2'd2;
        else state <= state + 2'd1;
      end
      always @(*) begin
        case (state)
          2'd0: traffic = 3'b001;
          2'd1: traffic = 3'b010;
          default: traffic = 3'b100;
        endcase
      end
      assign led = {5'd0, traffic};
      assign seg = {14'd0, state};
    endmodule
  `;

  it('生成包含 INPUT / MUX / DFF / OUTPUT 的可读教学级网表，节点数控制在 40 以内', () => {
    const elab = elaborate(parseVerilog(trafficCode).ast!);
    const session = new SimulationSession(elab);
    const graph = buildNetlist(elab).evaluate(session.getSignalsSnapshot());

    expect(graph.nodes.length).toBeGreaterThanOrEqual(8);
    expect(graph.nodes.length).toBeLessThanOrEqual(40);
    const kinds = new Set(graph.nodes.map((n) => n.kind));
    expect(kinds.has('INPUT')).toBe(true);
    expect(kinds.has('DFF')).toBe(true);
    expect(kinds.has('MUX')).toBe(true);
    expect(kinds.has('OUTPUT')).toBe(true);
  });

  it('拓扑层级从 INPUT(0) 递增至 OUTPUT(maxLevel)', () => {
    const elab = elaborate(parseVerilog(trafficCode).ast!);
    const session = new SimulationSession(elab);
    const graph = buildNetlist(elab).evaluate(session.getSignalsSnapshot());

    const inputs = graph.nodes.filter((n) => n.kind === 'INPUT');
    const outputs = graph.nodes.filter((n) => n.kind === 'OUTPUT');
    expect(inputs.every((n) => n.level === 0)).toBe(true);
    expect(outputs.every((n) => n.level >= 2)).toBe(true);
    expect(graph.maxLevel).toBeGreaterThanOrEqual(2);
  });

  it('按下 KEY0 后对应节点与导线 changed=true 且生成含红灯的白话播报', () => {
    const elab = elaborate(parseVerilog(trafficCode).ast!);
    const session = new SimulationSession(elab);
    const netlist = buildNetlist(elab);

    session.step({ rst_n: 0, key: 0, sw: 0 });
    session.step({ rst_n: 1, key: 0b0001, sw: 0 });
    const graph = netlist.evaluate(session.getSignalsSnapshot());

    const keyNode = graph.nodes.find((n) => n.id === 'in_key');
    const trafficNode = graph.nodes.find((n) => n.id === 'out_traffic');
    expect(keyNode?.changed).toBe(true);
    expect(trafficNode?.value).toBe(0b100);
    expect(trafficNode?.changed).toBe(true);
    expect(graph.edges.some((e) => e.changed)).toBe(true);
    expect(graph.narration).toContain('→');
    expect(graph.narration).toContain('红灯');
  });

  it('无信号变化时输出稳态白话播报', () => {
    const simpleComb = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        assign led = sw;
        assign traffic = 3'd0;
        assign seg = 16'd0;
      endmodule
    `;
    const elab = elaborate(parseVerilog(simpleComb).ast!);
    const session = new SimulationSession(elab);
    const netlist = buildNetlist(elab);
    session.step(DEFAULT_IN);
    session.step(DEFAULT_IN);
    const graph = netlist.evaluate(session.getSignalsSnapshot());
    expect(graph.narration).toContain('稳态');
  });

  it('基础逻辑门 assign 能正确映射为 AND / OR / NOT / XOR / ADD / CMP 节点', () => {
    const gatesCode = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        wire w_and = sw[0] & sw[1];
        wire w_or  = sw[2] | sw[3];
        wire w_xor = sw[4] ^ sw[5];
        wire w_not = ~sw[6];
        wire w_cmp = (key == 4'd5);
        wire [7:0] w_add = sw + 8'd1;
        assign led = w_add;
        assign traffic = {w_and, w_or, w_xor};
        assign seg = {14'd0, w_not, w_cmp};
      endmodule
    `;
    const elab = elaborate(parseVerilog(gatesCode).ast!);
    const session = new SimulationSession(elab);
    const graph = buildNetlist(elab).evaluate(session.getSignalsSnapshot());
    const kinds = new Set(graph.nodes.map((n) => n.kind));
    expect(kinds.has('AND')).toBe(true);
    expect(kinds.has('OR')).toBe(true);
    expect(kinds.has('XOR')).toBe(true);
    expect(kinds.has('NOT')).toBe(true);
    expect(kinds.has('CMP')).toBe(true);
    expect(kinds.has('ADD')).toBe(true);
  });

  it('四位加法绘出真实的进位链，位拼接和常量不产生 MUX', () => {
    const engine = createRtlEngine();
    const result = engine.compile(`
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        wire [4:0] sum = {1'b0, sw[3:0]} + {1'b0, key};
        assign led = {3'b0, sum};
        assign seg = {11'b0, sum};
        assign traffic = 3'b0;
      endmodule
    `);
    expect(result.ok).toBe(true);
    const { sample, netlist } = engine.step({ rst_n: 1, key: 1, sw: 15 });
    expect(sample.outputs).toEqual({ led: 16, seg: 16, traffic: 0 });
    expect(netlist.nodes.map((node) => node.kind)).not.toContain('MUX');
    expect(netlist.nodes.map((node) => node.kind)).toEqual(expect.arrayContaining(['AND', 'XOR', 'OR', 'CONST']));
    const nodes = new Map(netlist.nodes.map((node) => [node.id, node]));
    expect(netlist.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ signalName: 'C2', width: 1, value: 1 }),
      expect.objectContaining({ signalName: 'C4', width: 1, value: 1 }),
    ]));
    expect(netlist.edges.some((edge) => nodes.get(edge.from)?.kind === 'CONST' && edge.to === 'out_traffic')).toBe(true);
  });

  it('累加器从触发器 Q 反馈到加法器，时钟与低有效清零各接自己的引脚', () => {
    const engine = createRtlEngine();
    const result = engine.compile(`
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        reg [7:0] key_num;
        always @(posedge clk or negedge rst_n)
          if (!rst_n) key_num <= 8'd0;
          else if (sw[0]) key_num <= key_num + key;
        assign led = key_num;
        assign seg = 16'd0;
        assign traffic = 3'd0;
      endmodule
    `);
    expect(result.ok).toBe(true);
    const graph = engine.step({ rst_n: 1, key: 2, sw: 1 }).netlist;
    const add = graph.nodes.find((node) => node.kind === 'ADD');
    const mux = graph.nodes.find((node) => node.kind === 'MUX');
    expect(add?.value).toBe(4);
    expect(graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 'dff_key_num', to: add?.id, value: 2 }),
      expect.objectContaining({ from: add?.id, to: mux?.id, toPin: '1' }),
      expect.objectContaining({ to: mux?.id, toPin: 'S', width: 1 }),
      expect.objectContaining({ from: mux?.id, to: 'dff_key_num', toPin: 'D', value: 4 }),
      expect.objectContaining({ from: 'in_clk', to: 'dff_key_num', toPin: 'CLK' }),
      expect.objectContaining({ from: 'in_rst_n', to: 'dff_key_num', toPin: 'CLR', activeLow: true }),
      expect.objectContaining({ from: 'dff_key_num', to: 'out_led', width: 8, value: 2 }),
    ]));
  });

  it('时序块的独立位赋值不会隐藏其他寄存器的加法', () => {
    const engine = createRtlEngine();
    const result = engine.compile(`module top(
      input clk, input rst_n, input [3:0] key, input [7:0] sw,
      output reg [7:0] led, output [2:0] traffic, output [15:0] seg
    );
      reg [3:0] count;
      always @(posedge clk) begin
        count <= count + 4'd1;
        led[0] <= ~key[0];
      end
      assign seg = {12'd0, count};
      assign traffic = 3'd0;
    endmodule`);
    expect(result.ok).toBe(true);
    expect(result.netlist?.nodes.some((node) => node.kind === 'XOR')).toBe(true);
    expect(result.netlist?.edges.find((edge) => edge.to === 'dff_count' && edge.toPin === 'D')?.value).toBe(1);
  });

  it('动态位宽加法的连接值与仿真输出一致', () => {
    const engine = createRtlEngine();
    const result = engine.compile(`module top(
      input clk, input rst_n, input [3:0] key, input [7:0] sw,
      output [7:0] led, output [2:0] traffic, output [15:0] seg
    );
      assign led = sw[key[2:0]:0] + 1'b1;
      assign seg = 16'd0;
      assign traffic = 3'd0;
    endmodule`);
    expect(result.ok).toBe(true);
    const { sample, netlist } = engine.step({ rst_n: 1, key: 4, sw: 17 });
    expect(sample.outputs.led).toBe(18);
    expect(netlist.edges.find((edge) => edge.to === 'out_led')).toMatchObject({ width: 8, value: 18 });
  });

  it('有声明偏移和类型转换的取位分别走不同的物理位线', () => {
    const engine = createRtlEngine();
    const result = engine.compile(`module top(
      input clk, input rst_n, input [3:0] key, input [7:0] sw,
      output [7:0] led, output [2:0] traffic, output [15:0] seg
    );
      wire [11:4] data = sw;
      assign led = {6'd0, $unsigned(data)[4], data[4]};
      assign seg = 16'd0;
      assign traffic = 3'd0;
    endmodule`);
    expect(result.ok).toBe(true);
    const { sample, netlist } = engine.step({ rst_n: 1, key: 0, sw: 1 });
    expect(sample.outputs.led).toBe(1);
    expect(netlist.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ fromPin: '[4]', toPin: '[0]', value: 1 }),
      expect.objectContaining({ fromPin: '[8]', toPin: '[1]', value: 0 }),
    ]));
  });

  it('网表节点携带 sourceLine 供前端点击门高亮源码', () => {
    const elab = elaborate(parseVerilog(trafficCode).ast!);
    const session = new SimulationSession(elab);
    const graph = buildNetlist(elab).evaluate(session.getSignalsSnapshot());
    const dff = graph.nodes.find((n) => n.kind === 'DFF');
    expect(dff?.sourceLine).toBeGreaterThan(0);
  });
});

describe('6. 六类静态 Lint 体检 (linter.ts)', () => {
  const lint = (code: string) => {
    const parsed = parseVerilog(code);
    expect(parsed.errors).toEqual([]);
    return lintVerilog(elaborate(parsed.ast!));
  };

  it('规范 7 端口标准设计零告警通过', () => {
    const clean = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output reg [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        always @(posedge clk or negedge rst_n) begin
          if (!rst_n) led <= 8'd0;
          else led <= sw;
        end
        assign traffic = key[2:0];
        assign seg = {8'h00, led};
      endmodule
    `;
    expect(lint(clean)).toEqual([]);
  });

  it('PORT_MISMATCH：缺少标准端口时报错', () => {
    const issues = lint(`
      module top(input clk, input rst_n, output [7:0] led);
        assign led = 8'd0;
      endmodule
    `);
    expect(issues.some((i) => i.code === 'PORT_MISMATCH' && i.severity === 'error')).toBe(true);
  });

  it('PORT_MISMATCH：端口位宽或方向不匹配时报错', () => {
    const issues = lint(`
      module top(
        input clk, input rst_n, input [2:0] key, input [7:0] sw,
        input [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        assign traffic = key;
        assign seg = 16'd0;
      endmodule
    `);
    const portIssues = issues.filter((i) => i.code === 'PORT_MISMATCH');
    expect(portIssues.length).toBeGreaterThanOrEqual(2);
  });

  it('PORT_MISMATCH：声明非板卡未知端口时报错', () => {
    const issues = lint(`
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output [7:0] led, output [2:0] traffic, output [15:0] seg,
        output extra_pin
      );
        assign led = 8'd0; assign traffic = 3'd0; assign seg = 16'd0; assign extra_pin = 1'b0;
      endmodule
    `);
    expect(issues.some((i) => i.code === 'PORT_MISMATCH' && i.message.includes('extra_pin'))).toBe(true);
  });

  it('SEQ_BLOCKING_ASSIGN：时序块混用阻塞赋值 "=" 告警', () => {
    const issues = lint(`
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output reg [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        always @(posedge clk) begin
          led = sw;
        end
        assign traffic = 3'd0; assign seg = 16'd0;
      endmodule
    `);
    expect(issues.some((i) => i.code === 'SEQ_BLOCKING_ASSIGN')).toBe(true);
  });

  it('COMB_NONBLOCKING_ASSIGN：组合块混用非阻塞赋值 "<=" 告警', () => {
    const issues = lint(`
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output reg [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        always @(*) begin
          led <= sw;
        end
        assign traffic = 3'd0; assign seg = 16'd0;
      endmodule
    `);
    expect(issues.some((i) => i.code === 'COMB_NONBLOCKING_ASSIGN')).toBe(true);
  });

  it('INFERRED_LATCH：组合块 if 缺少 else 告警', () => {
    const issues = lint(`
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output reg [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        always @(*) begin
          if (key[0]) led = sw;
        end
        assign traffic = 3'd0; assign seg = 16'd0;
      endmodule
    `);
    expect(issues.some((i) => i.code === 'INFERRED_LATCH')).toBe(true);
  });

  it('INFERRED_LATCH：组合块 case 缺少 default 告警', () => {
    const issues = lint(`
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output reg [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        always @(*) begin
          case (key[1:0])
            2'd0: led = 8'h01;
            2'd1: led = 8'h02;
          endcase
        end
        assign traffic = 3'd0; assign seg = 16'd0;
      endmodule
    `);
    expect(issues.some((i) => i.code === 'INFERRED_LATCH')).toBe(true);
  });

  it('INFERRED_LATCH 正例：组合块开头赋默认值后写单分支 if 不误报 Latch', () => {
    const issues = lint(`
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output reg [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        always @(*) begin
          led = 8'd0;
          if (key[0]) led = sw;
        end
        assign traffic = 3'd0; assign seg = 16'd0;
      endmodule
    `);
    expect(issues.some((i) => i.code === 'INFERRED_LATCH')).toBe(false);
  });

  it('UNDRIVEN_OR_UNASSIGNED：输出端口未驱动告警', () => {
    const issues = lint(`
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        assign led = sw;
        assign seg = 16'd0;
      endmodule
    `);
    expect(
      issues.some((i) => i.code === 'UNDRIVEN_OR_UNASSIGNED' && i.message.includes('traffic'))
    ).toBe(true);
  });

  it('UNDRIVEN_OR_UNASSIGNED：内部变量读取但从未赋值告警', () => {
    const issues = lint(`
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        reg [7:0] ghost_reg;
        assign led = ghost_reg;
        assign traffic = 3'd0; assign seg = 16'd0;
      endmodule
    `);
    expect(
      issues.some((i) => i.code === 'UNDRIVEN_OR_UNASSIGNED' && i.message.includes('ghost_reg'))
    ).toBe(true);
  });

  it('MULTI_DRIVER：同一信号被两个 always 块同时驱动报错', () => {
    const issues = lint(`
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output reg [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        always @(posedge clk) led <= sw;
        always @(posedge clk) led <= 8'hFF;
        assign traffic = 3'd0; assign seg = 16'd0;
      endmodule
    `);
    expect(issues.some((i) => i.code === 'MULTI_DRIVER' && i.severity === 'error')).toBe(true);
  });

  it('MULTI_DRIVER：同一信号混用 assign 与 always 块报错', () => {
    const issues = lint(`
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output reg [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        assign led = sw;
        always @(posedge clk) led <= 8'd0;
        assign traffic = 3'd0; assign seg = 16'd0;
      endmodule
    `);
    expect(issues.some((i) => i.code === 'MULTI_DRIVER')).toBe(true);
  });

  it('UNSIGNED_ARITH_SHIFT：无符号数使用 >>> 告警，使用 $signed 后不告警', () => {
    const bad = lint(`
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        assign led = sw >>> 2;
        assign traffic = 3'd0; assign seg = 16'd0;
      endmodule
    `);
    expect(bad.some((i) => i.code === 'UNSIGNED_ARITH_SHIFT')).toBe(true);

    const good = lint(`
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        assign led = $signed(sw) >>> 2;
        assign traffic = 3'd0; assign seg = 16'd0;
      endmodule
    `);
    expect(good.some((i) => i.code === 'UNSIGNED_ARITH_SHIFT')).toBe(false);
  });
});

describe('7. 确定性自测、首个反例定位与无回退检测 (selftest.ts)', () => {
  it.each(PRESETS)('真实引擎通过 $name 的全部预置断言', (preset) => {
    const engine = createRtlEngine();
    expect(engine.compile(preset.verilogCode).ok).toBe(true);
    const result = engine.runSelfTest(preset.verilogCode, preset.testVectors);
    expect(result.totalChecks).toBeGreaterThan(0);
    expect(result.passed).toBe(true);
  });
  const goodCounter = `
    module top(
      input clk, input rst_n, input [3:0] key, input [7:0] sw,
      output reg [7:0] led, output [2:0] traffic, output [15:0] seg
    );
      always @(posedge clk or negedge rst_n) begin
        if (!rst_n) led <= 8'd0;
        else led <= led + 8'd1;
      end
      assign traffic = 3'b001;
      assign seg = {8'h00, led};
    endmodule
  `;

  const vectors: TestVectorStep[] = [
    { cycle: 1, inputs: { rst_n: 0, key: 0, sw: 0 }, expect: { led: 0, seg: 0 }, note: '复位清零' },
    { cycle: 2, inputs: { rst_n: 1, key: 0, sw: 0 }, expect: { led: 1 }, note: '第1拍递增' },
    { cycle: 3, inputs: { rst_n: 1, key: 0, sw: 0 }, expect: { led: 2, traffic: 1 }, note: '第2拍递增' },
    { cycle: 4, inputs: { rst_n: 1, key: 0, sw: 0 }, expect: { led: 3 }, note: '第3拍递增' },
  ];

  it('全部断言匹配时 passed=true 且返回完整波形', () => {
    const res = runDeterministicSelfTest(goodCounter, vectors);
    expect(res.passed).toBe(true);
    expect(res.totalChecks).toBe(6);
    expect(res.passedChecks).toBe(6);
    expect(res.firstFailure).toBeUndefined();
    expect(res.regressedCycles).toEqual([]);
    expect(res.waveform).toHaveLength(4);
  });

  it('精准捕获首个失配周期 firstFailure（含 signal/expected/actual/note）', () => {
    const buggyCounter = goodCounter.replace('led <= led + 8\'d1;', 'led <= led + 8\'d2;');
    const res = runDeterministicSelfTest(buggyCounter, vectors);
    expect(res.passed).toBe(false);
    expect(res.firstFailure).toEqual({
      cycle: 2,
      signal: 'led',
      expected: 1,
      actual: 2,
      note: '第1拍递增',
    });
  });

  it('无回退检测：上一版通过的周期被改坏时准确上报 regressedCycles', () => {
    const regressedCode = goodCounter.replace('if (!rst_n) led <= 8\'d0;', 'if (!rst_n) led <= 8\'d5;');
    const res = runDeterministicSelfTest(regressedCode, vectors, [1, 2]);
    expect(res.passed).toBe(false);
    expect(res.regressedCycles).toEqual([1, 2]);
  });

  it('仅新增未通过周期失败而旧周期仍通过时 regressedCycles 为空', () => {
    const partialCode = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output reg [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        always @(posedge clk or negedge rst_n) begin
          if (!rst_n) led <= 8'd0;
          else if (led < 8'd2) led <= led + 8'd1;
        end
        assign traffic = 3'b001;
        assign seg = {8'h00, led};
      endmodule
    `;
    const res = runDeterministicSelfTest(partialCode, vectors, [1, 2, 3]);
    expect(res.passed).toBe(false);
    expect(res.firstFailure?.cycle).toBe(4);
    expect(res.regressedCycles).toEqual([]);
  });

  it('代码存在语法错误时 passed=false 且所有上一版通过周期记为回退', () => {
    const res = runDeterministicSelfTest('module broken(', vectors, [1, 2]);
    expect(res.passed).toBe(false);
    expect(res.passedChecks).toBe(0);
    expect(res.totalChecks).toBe(6);
    expect(res.regressedCycles).toEqual([1, 2]);
    expect(res.waveform).toEqual([]);
  });

  it('无 expect 字段的纯激励拍不计入 totalChecks 但仍记录波形', () => {
    const stimOnly: TestVectorStep[] = [
      { cycle: 1, inputs: { rst_n: 0, key: 0, sw: 0 } },
      { cycle: 2, inputs: { rst_n: 1, key: 0, sw: 0 }, expect: { led: 1 } },
    ];
    const res = runDeterministicSelfTest(goodCounter, stimOnly);
    expect(res.passed).toBe(true);
    expect(res.totalChecks).toBe(1);
    expect(res.waveform).toHaveLength(2);
  });
});

describe('8. RtlEngine 对外契约全链路集成 (index.ts)', () => {
  it('compile 失败时返回 ok: false 且包含中文 PARSE_ERROR', () => {
    const engine = createRtlEngine();
    const res = engine.compile('module top(input clk); assign a = ; endmodule');
    expect(res.ok).toBe(false);
    expect(res.issues.length).toBeGreaterThan(0);
    expect(res.issues[0].code).toBe('PARSE_ERROR');
  });

  it('端口不匹配时 compile 返回 ok: false 且附带 PORT_MISMATCH 诊断', () => {
    const engine = createRtlEngine();
    const res = engine.compile('module top(input clk, output [7:0] led); assign led = 8\'d1; endmodule');
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => i.code === 'PORT_MISMATCH')).toBe(true);
  });

  it('故障诊所模式：仅含 warning 类 Lint 告警的代码仍可 ok: true 上板仿真观察异常', () => {
    const engine = createRtlEngine();
    const res = engine.compile(`
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output reg [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        always @(posedge clk) led = sw;
        assign traffic = 3'd0; assign seg = 16'd0;
      endmodule
    `);
    expect(res.ok).toBe(true);
    expect(res.issues.some((i) => i.code === 'SEQ_BLOCKING_ASSIGN')).toBe(true);
    expect(engine.step({ rst_n: 1, key: 0, sw: 0x2a }).sample.outputs.led).toBe(0x2a);
  });

  it('compile 成功后 reset() / step() 返回真实 NetlistGraph 与 SignalSample，runSelfTest 可直接调用', () => {
    const engine = createRtlEngine();
    const code = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        reg [7:0] acc;
        always @(posedge clk or negedge rst_n) begin
          if (!rst_n) acc <= 8'd0;
          else acc <= acc + sw;
        end
        assign led = acc;
        assign traffic = 3'b001;
        assign seg = {8'h00, acc};
      endmodule
    `;
    const res = engine.compile(code);
    expect(res.ok).toBe(true);
    expect(res.issues).toEqual([]);
    expect(res.netlist?.nodes.length).toBeGreaterThan(0);

    engine.reset();
    const s1 = engine.step({ rst_n: 1, key: 0, sw: 5 });
    expect(s1.sample.cycle).toBe(0);
    expect(s1.sample.outputs.led).toBe(5);
    expect(s1.sample.internals.acc).toBe(5);
    expect(s1.netlist.nodes.some((n) => n.changed)).toBe(true);

    const st = engine.runSelfTest(code, [
      { cycle: 1, inputs: { rst_n: 0, key: 0, sw: 0 }, expect: { led: 0 } },
      { cycle: 2, inputs: { rst_n: 1, key: 0, sw: 9 }, expect: { led: 9 } },
    ]);
    expect(st.passed).toBe(true);
  });
});

describe('9. V2 Verilog 语法子集扩展 (parser.ts / simulator.ts)', () => {
  it('支持单目归约运算符 ~& / ~| / ~^ / ^~', () => {
    const code = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        assign led[0] = ~&key;
        assign led[1] = ~|key;
        assign led[2] = ~^key;
        assign led[3] = ^~key;
        assign led[7:4] = 4'd0;
        assign traffic = 3'd0;
        assign seg = 16'd0;
      endmodule
    `;
    const sim = buildSession(code);
    // key=4'b1111: ~&=0, ~|=0, ~^=1 (even 1s), ^~=1
    expect(sim.step({ rst_n: 1, key: 0b1111, sw: 0 }).sample.outputs.led).toBe(0b1100);
    // key=4'b0000: ~&=1, ~|=1, ~^=1 (0 ones -> even), ^~=1
    expect(sim.step({ rst_n: 1, key: 0b0000, sw: 0 }).sample.outputs.led).toBe(0b1111);
    // key=4'b0010: ~&=1, ~|=0, ~^=0 (1 one -> odd), ^~=0
    expect(sim.step({ rst_n: 1, key: 0b0010, sw: 0 }).sample.outputs.led).toBe(0b0001);
  });

  it('支持双目同或 ~^ / ^~ 与全等比较 === / !==', () => {
    const code = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        assign led[3:0] = sw[3:0] ~^ key;
        assign led[7:4] = sw[7:4] ^~ key;
        assign traffic[0] = (sw[3:0] === key);
        assign traffic[1] = (sw[3:0] !== key);
        assign traffic[2] = 1'b0;
        assign seg = 16'd0;
      endmodule
    `;
    const sim = buildSession(code);
    const out = sim.step({ rst_n: 1, key: 0b1010, sw: 0b1010_1010 }).sample.outputs;
    expect(out.led).toBe(0xff);
    expect(out.traffic).toBe(0b001);
    const out2 = sim.step({ rst_n: 1, key: 0b1010, sw: 0b0101_0101 }).sample.outputs;
    expect(out2.led).toBe(0x00);
    expect(out2.traffic).toBe(0b010);
  });

  it('支持 casez 中的 ? 与 z 通配符匹配', () => {
    const code = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output reg [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        always @(*) begin
          casez (key)
            4'b1???: led = 8'd4;
            4'b01zz: led = 8'd3;
            4'b001?: led = 8'd2;
            4'b0001: led = 8'd1;
            default: led = 8'd0;
          endcase
        end
        assign traffic = 3'd0;
        assign seg = 16'd0;
      endmodule
    `;
    const sim = buildSession(code);
    expect(sim.step({ rst_n: 1, key: 0b1001, sw: 0 }).sample.outputs.led).toBe(4);
    expect(sim.step({ rst_n: 1, key: 0b0111, sw: 0 }).sample.outputs.led).toBe(3);
    expect(sim.step({ rst_n: 1, key: 0b0010, sw: 0 }).sample.outputs.led).toBe(2);
    expect(sim.step({ rst_n: 1, key: 0b0001, sw: 0 }).sample.outputs.led).toBe(1);
    expect(sim.step({ rst_n: 1, key: 0b0000, sw: 0 }).sample.outputs.led).toBe(0);
  });

  it('支持 casex 中的 x / z / ? 通配符匹配', () => {
    const code = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output reg [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        always @(*) begin
          casex (key)
            4'b1xxx: led = 8'hA0;
            4'b01xz: led = 8'h50;
            default: led = 8'h0F;
          endcase
        end
        assign traffic = 3'd0;
        assign seg = 16'd0;
      endmodule
    `;
    const sim = buildSession(code);
    expect(sim.step({ rst_n: 1, key: 0b1101, sw: 0 }).sample.outputs.led).toBe(0xa0);
    expect(sim.step({ rst_n: 1, key: 0b0101, sw: 0 }).sample.outputs.led).toBe(0x50);
    expect(sim.step({ rst_n: 1, key: 0b0011, sw: 0 }).sample.outputs.led).toBe(0x0f);
  });

  it('支持有界静态 for 循环展开（8 位位序反转）', () => {
    const code = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output reg [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        integer i;
        always @(*) begin
          for (i = 0; i < 8; i = i + 1) begin
            led[i] = sw[7 - i];
          end
        end
        assign traffic = 3'd0;
        assign seg = 16'd0;
      endmodule
    `;
    const engine = createRtlEngine();
    const res = engine.compile(code);
    expect(res.ok).toBe(true);
    expect(engine.step({ rst_n: 1, key: 0, sw: 0b1011_0001 }).sample.outputs.led).toBe(0b1000_1101);
  });

  it('支持 for 循环内联 int 声明与 ++ / += / -- 步进语法', () => {
    const code = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output reg [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        always @(*) begin
          led = 8'd0;
          for (int i = 0; i < 8; i += 2) begin
            led[i] = sw[i];
          end
          for (int j = 7; j >= 1; j -= 2) begin
            led[j] = ~sw[j];
          end
        end
        assign traffic = 3'd0;
        assign seg = 16'd0;
      endmodule
    `;
    const sim = buildSession(code);
    // sw=0x00 -> even bits 0, odd bits 1 -> 0b10101010 = 0xAA
    expect(sim.step({ rst_n: 1, key: 0, sw: 0x00 }).sample.outputs.led).toBe(0xaa);
    // sw=0xFF -> even bits 1, odd bits 0 -> 0b01010101 = 0x55
    expect(sim.step({ rst_n: 1, key: 0, sw: 0xff }).sample.outputs.led).toBe(0x55);
  });

  it('支持 for 循环结合 localparam 在时序块内批量移位', () => {
    const code = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output reg [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        localparam W = 8;
        integer k;
        always @(posedge clk or negedge rst_n) begin
          if (!rst_n) begin
            led <= 8'd0;
          end else begin
            led[0] <= sw[0];
            for (k = 1; k < W; k = k + 1) begin
              led[k] <= led[k - 1];
            end
          end
        end
        assign traffic = 3'd0;
        assign seg = 16'd0;
      endmodule
    `;
    const sim = buildSession(code);
    sim.step({ rst_n: 0, key: 0, sw: 0 });
    expect(sim.step({ rst_n: 1, key: 0, sw: 1 }).sample.outputs.led).toBe(0b0000_0001);
    expect(sim.step({ rst_n: 1, key: 0, sw: 0 }).sample.outputs.led).toBe(0b0000_0010);
    expect(sim.step({ rst_n: 1, key: 0, sw: 1 }).sample.outputs.led).toBe(0b0000_0101);
  });

  it('支持 Verilog 综合属性 (* ... *) 且不干扰 always @(*)', () => {
    const code = `
      (* keep_hierarchy = "yes" *)
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output reg [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        (* mark_debug = "true" *) wire [7:0] inv_sw = ~sw;
        always @(*) begin
          led = inv_sw;
        end
        assign traffic = 3'd0;
        assign seg = 16'd0;
      endmodule
    `;
    const engine = createRtlEngine();
    expect(engine.compile(code).ok).toBe(true);
    expect(engine.step({ rst_n: 1, key: 0, sw: 0x0f }).sample.outputs.led).toBe(0xf0);
  });

  it('安全忽略 assign #1 与非阻塞 <= #1 仿真延时语法', () => {
    const code = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output reg [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        always @(posedge clk or negedge rst_n) begin
          if (!rst_n) led <= #1 8'd0;
          else led <= #1 sw;
        end
        assign #1 traffic = key[2:0];
        assign seg = 16'd0;
      endmodule
    `;
    const sim = buildSession(code);
    sim.step({ rst_n: 0, key: 0, sw: 0x33 });
    const out = sim.step({ rst_n: 1, key: 0b101, sw: 0x77 }).sample.outputs;
    expect(out.led).toBe(0x77);
    expect(out.traffic).toBe(0b101);
  });

  it('支持 Verilog-1995 分离式端口方向与 reg 声明风格', () => {
    const code = `
      module top(clk, rst_n, key, sw, led, traffic, seg);
        input clk, rst_n;
        input [3:0] key;
        input [7:0] sw;
        output [7:0] led;
        output [2:0] traffic;
        output [15:0] seg;
        reg [7:0] led;
        always @(posedge clk or negedge rst_n) begin
          if (!rst_n) led <= 8'd0;
          else led <= sw + {4'd0, key};
        end
        assign traffic = 3'b001;
        assign seg = 16'h1234;
      endmodule
    `;
    const engine = createRtlEngine();
    const res = engine.compile(code);
    expect(res.ok).toBe(true);
    expect(res.issues).toEqual([]);
    engine.step({ rst_n: 0, key: 0, sw: 0 });
    expect(engine.step({ rst_n: 1, key: 3, sw: 10 }).sample.outputs.led).toBe(13);
  });

  it('支持块注释 /* ... */ 穿插在模块头部与表达式中间', () => {
    const code = `
      module /* 顶层 */ top(
        input clk, /* 时钟 */ input rst_n,
        input [3:0] key, input [7:0] sw,
        output [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        assign led = (sw /* 输入 */ & 8'hF0) | {4'd0, key};
        assign traffic = 3'd0;
        assign seg = 16'd0;
      endmodule
    `;
    const sim = buildSession(code);
    expect(sim.step({ rst_n: 1, key: 0x5, sw: 0xa0 }).sample.outputs.led).toBe(0xa5);
  });

  it('支持有符号 $signed 比较与符号扩展截断', () => {
    const code = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        wire signed [3:0] a = $signed(sw[3:0]);
        wire signed [3:0] b = $signed(sw[7:4]);
        assign led[0] = (a < b);
        assign led[1] = ($unsigned(a) < $unsigned(b));
        assign led[7:2] = 6'd0;
        assign traffic = 3'd0;
        assign seg = 16'd0;
      endmodule
    `;
    const sim = buildSession(code);
    // a = 4'hF (-1 signed, 15 unsigned), b = 4'h1 (+1 signed, 1 unsigned)
    const out = sim.step({ rst_n: 1, key: 0, sw: 0x1f }).sample.outputs;
    expect(out.led).toBe(0b01); // signed: -1 < 1 (true), unsigned: 15 < 1 (false)
  });

  it('支持嵌套 for 循环展开计算 4 位 popcount', () => {
    const code = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output reg [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        integer i;
        always @(*) begin
          led = 8'd0;
          for (i = 0; i < 8; i = i + 1) begin
            led = led + {7'd0, sw[i]};
          end
        end
        assign traffic = 3'd0;
        assign seg = 16'd0;
      endmodule
    `;
    const sim = buildSession(code);
    expect(sim.step({ rst_n: 1, key: 0, sw: 0b1011_0110 }).sample.outputs.led).toBe(5);
    expect(sim.step({ rst_n: 1, key: 0, sw: 0xff }).sample.outputs.led).toBe(8);
  });

  it('支持 genvar 声明与局部参数表达式计算位宽', () => {
    const code = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        localparam HALF = 4;
        localparam FULL = HALF * 2;
        genvar g;
        wire [FULL-1:0] merged = {sw[HALF-1:0], key};
        assign led = merged;
        assign traffic = 3'd0;
        assign seg = 16'd0;
      endmodule
    `;
    const sim = buildSession(code);
    expect(sim.step({ rst_n: 1, key: 0x3, sw: 0x0c }).sample.outputs.led).toBe(0xc3);
  });
});

describe('10. V2 契约能力 (levelNarrations / metadata / exportTestbench / 5 预置案例)', () => {
  it('NetlistGraph.levelNarrations 长度等于 maxLevel + 1 且逐层非空', () => {
    const engine = createRtlEngine();
    const res = engine.compile(preset.verilogCode);
    expect(res.ok).toBe(true);
    expect(res.netlist?.levelNarrations).toBeDefined();
    expect(res.netlist!.levelNarrations!.length).toBe(res.netlist!.maxLevel + 1);
    for (const line of res.netlist!.levelNarrations!) {
      expect(line.length).toBeGreaterThan(0);
    }
  });

  it('交通灯按下 KEY0 后 levelNarrations 清晰呈现输入激励与红灯输出响应', () => {
    const engine = createRtlEngine();
    engine.compile(preset.verilogCode);
    engine.step({ rst_n: 0, key: 0, sw: 0 });
    for (let i = 0; i < 6; i++) {
      engine.step({ rst_n: 1, key: 0, sw: 0 });
    }
    const { netlist } = engine.step({ rst_n: 1, key: 1, sw: 0 });
    expect(netlist.levelNarrations).toBeDefined();
    expect(netlist.levelNarrations![0]).toContain('KEY[3:0]');
    expect(netlist.levelNarrations!.some((s) => s.includes('红灯'))).toBe(true);
  });

  it('稳态无跳变周期的 levelNarrations 每层均给出稳态说明', () => {
    const code = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        assign led = sw;
        assign traffic = 3'b001;
        assign seg = 16'd0;
      endmodule
    `;
    const engine = createRtlEngine();
    engine.compile(code);
    engine.step({ rst_n: 1, key: 0, sw: 0x12 });
    const { netlist } = engine.step({ rst_n: 1, key: 0, sw: 0x12 });
    expect(netlist.levelNarrations![0]).toContain('保持稳定');
    expect(netlist.levelNarrations!.some((s) => s.includes('稳态'))).toBe(true);
  });

  it('CompileResult.metadata 准确提取 moduleName、usedInputs、usedOutputs 与 internalSignals', () => {
    const code = `
      module demo_counter(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        reg [3:0] cnt;
        reg flag;
        always @(posedge clk or negedge rst_n) begin
          if (!rst_n) begin
            cnt <= 4'd0;
            flag <= 1'b0;
          end else if (key[0]) begin
            cnt <= cnt + 4'd1;
            flag <= ~flag;
          end
        end
        assign led = {3'd0, flag, cnt};
        assign traffic = 3'd0;
        assign seg = 16'd0;
      endmodule
    `;
    const engine = createRtlEngine();
    const res = engine.compile(code);
    expect(res.ok).toBe(true);
    expect(res.metadata).toEqual({
      moduleName: 'demo_counter',
      usedInputs: ['rst_n', 'key'],
      usedOutputs: ['led', 'traffic', 'seg'],
      internalSignals: [
        { name: 'cnt', width: 4 },
        { name: 'flag', width: 1 },
      ],
    });
  });

  it('CompileResult.metadata 在端口不匹配时仍安全返回 ok: false 与 metadata', () => {
    const bad = `
      module partial_mod(input clk, output [7:0] led);
        assign led = 8'h55;
      endmodule
    `;
    const res = createRtlEngine().compile(bad);
    expect(res.ok).toBe(false);
    expect(res.metadata?.moduleName).toBe('partial_mod');
    expect(res.metadata?.usedOutputs).toEqual(['led']);
  });

  it('exportTestbench 输出标准 tb_top.v（含 timescale、DUT 例化、波形 dump 与断言）', () => {
    const engine = createRtlEngine();
    const tb = engine.exportTestbench!(preset.verilogCode, preset.testVectors.slice(0, 3));
    expect(tb).toContain('`timescale 1ns/1ps');
    expect(tb).toContain('module tb_top;');
    expect(tb).toContain('top dut (');
    expect(tb).toContain('$dumpfile("tb_top.vcd");');
    expect(tb).toContain('always #5 clk = ~clk;');
    expect(tb).toContain('@(posedge clk); #1;');
    expect(tb).toContain('ALL TESTS PASSED');
    expect(tb).toContain('endmodule');
  });

  it('exportTestbench 准确序列化 led / traffic / seg 断言与周期注释', () => {
    const vectors: TestVectorStep[] = [
      { cycle: 0, inputs: { rst_n: 0, key: 0, sw: 0 }, expect: { led: 0, seg: 0 }, note: '复位' },
      { cycle: 1, inputs: { rst_n: 1, key: 5, sw: 0xab }, expect: { led: 0xab, traffic: 0b100, seg: 0x1234 }, note: '检查输出' },
    ];
    const tb = createRtlEngine().exportTestbench!('module my_alu(input clk); endmodule', vectors);
    expect(tb).toContain('my_alu dut (');
    expect(tb).toContain('// Cycle 0: 复位');
    expect(tb).toContain("key = 4'h5; sw = 8'hab;");
    expect(tb).toContain("if (led !== 8'hab)");
    expect(tb).toContain("if (traffic !== 3'b100)");
    expect(tb).toContain("if (seg !== 16'h1234)");
  });

  it('exportTestbench 对语法残缺代码不抛异常并优雅回退到 top', () => {
    const tb = createRtlEngine().exportTestbench!('not valid verilog @@@', [
      { cycle: 0, inputs: DEFAULT_IN },
    ]);
    expect(tb).toContain('top dut (');
    expect(tb).toContain('endmodule');
  });

  for (const p of PRESETS) {
    it(`预置案例全量 V2 验收：${p.name} (${p.id})`, () => {
      const engine = createRtlEngine();
      const compiled = engine.compile(p.verilogCode);
      expect(compiled.ok).toBe(true);
      expect(compiled.metadata?.moduleName).toBeTruthy();
      expect(compiled.metadata?.usedOutputs.length).toBeGreaterThan(0);
      expect(compiled.netlist?.levelNarrations?.length).toBe((compiled.netlist?.maxLevel ?? 0) + 1);

      const st = engine.runSelfTest(p.verilogCode, p.testVectors);
      expect(st.passed).toBe(true);
      expect(st.totalChecks).toBeGreaterThan(0);
      expect(st.firstFailure).toBeUndefined();

      const tb = engine.exportTestbench!(p.verilogCode, p.testVectors);
      expect(tb).toContain('module tb_top;');
      expect(tb).toContain('endmodule');
    });
  }
});

describe('11. 广范围 AI 常见全新电路回归库 (10+ 类经典数字电路)', () => {
  it('电路 1：8 位双向流水灯（sw[0]=0 循环左移，sw[0]=1 循环右移）', () => {
    const code = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output reg [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        always @(posedge clk or negedge rst_n) begin
          if (!rst_n) led <= 8'b0000_0001;
          else if (sw[0]) led <= {led[0], led[7:1]};
          else led <= {led[6:0], led[7]};
        end
        assign traffic = 3'd0;
        assign seg = 16'd0;
      endmodule
    `;
    const sim = buildSession(code);
    expect(sim.step({ rst_n: 0, key: 0, sw: 0 }).sample.outputs.led).toBe(0b0000_0001);
    expect(sim.step({ rst_n: 1, key: 0, sw: 0 }).sample.outputs.led).toBe(0b0000_0010);
    expect(sim.step({ rst_n: 1, key: 0, sw: 0 }).sample.outputs.led).toBe(0b0000_0100);
    expect(sim.step({ rst_n: 1, key: 0, sw: 1 }).sample.outputs.led).toBe(0b0000_0010);
    expect(sim.step({ rst_n: 1, key: 0, sw: 1 }).sample.outputs.led).toBe(0b0000_0001);
    expect(sim.step({ rst_n: 1, key: 0, sw: 1 }).sample.outputs.led).toBe(0b1000_0000);
  });

  it('电路 2：参数化模 N 计数器（MOD=6，满值归零并产生进位脉冲）', () => {
    const code = `
      module top #(parameter MOD = 6)(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        reg [3:0] cnt;
        always @(posedge clk or negedge rst_n) begin
          if (!rst_n) cnt <= 4'd0;
          else if (cnt == MOD - 1) cnt <= 4'd0;
          else cnt <= cnt + 4'd1;
        end
        assign led = {3'd0, (cnt == MOD - 1), cnt};
        assign traffic = 3'd0;
        assign seg = {12'd0, cnt};
      endmodule
    `;
    const sim = buildSession(code);
    sim.step({ rst_n: 0, key: 0, sw: 0 });
    const seq: number[] = [];
    for (let i = 0; i < 7; i++) {
      seq.push(sim.step({ rst_n: 1, key: 0, sw: 0 }).sample.outputs.seg);
    }
    expect(seq).toEqual([1, 2, 3, 4, 5, 0, 1]);
  });

  it('电路 3：双位 BCD 计数器（00-99 十进制进位）', () => {
    const code = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        reg [3:0] ones, tens;
        always @(posedge clk or negedge rst_n) begin
          if (!rst_n) begin
            ones <= 4'd0;
            tens <= 4'd0;
          end else if (ones == 4'd9) begin
            ones <= 4'd0;
            tens <= (tens == 4'd9) ? 4'd0 : (tens + 4'd1);
          end else begin
            ones <= ones + 4'd1;
          end
        end
        assign led = {tens, ones};
        assign traffic = 3'd0;
        assign seg = {8'd0, tens, ones};
      endmodule
    `;
    const sim = buildSession(code);
    sim.step({ rst_n: 0, key: 0, sw: 0 });
    for (let i = 0; i < 11; i++) sim.step({ rst_n: 1, key: 0, sw: 0 });
    expect(sim.step({ rst_n: 1, key: 0, sw: 0 }).sample.outputs.seg).toBe(0x0012);
  });

  it('电路 4：4 位 PWM 发生器（占空比精确匹配 sw[3:0]/16）', () => {
    const code = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        reg [3:0] pwm_cnt;
        always @(posedge clk or negedge rst_n) begin
          if (!rst_n) pwm_cnt <= 4'd0;
          else pwm_cnt <= pwm_cnt + 4'd1;
        end
        assign led = {7'd0, (pwm_cnt < sw[3:0])};
        assign traffic = 3'd0;
        assign seg = 16'd0;
      endmodule
    `;
    const sim = buildSession(code);
    sim.step({ rst_n: 0, key: 0, sw: 5 });
    let highCount = 0;
    for (let i = 0; i < 16; i++) {
      highCount += sim.step({ rst_n: 1, key: 0, sw: 5 }).sample.outputs.led & 1;
    }
    expect(highCount).toBe(5);
  });

  it('电路 5：4 分频时钟分频器（每 2 拍翻转一次输出）', () => {
    const code = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        reg [1:0] cnt;
        reg clk_div;
        always @(posedge clk or negedge rst_n) begin
          if (!rst_n) begin
            cnt <= 2'd0;
            clk_div <= 1'b0;
          end else if (cnt == 2'd1) begin
            cnt <= 2'd0;
            clk_div <= ~clk_div;
          end else begin
            cnt <= cnt + 2'd1;
          end
        end
        assign led = {7'd0, clk_div};
        assign traffic = 3'd0;
        assign seg = 16'd0;
      endmodule
    `;
    const sim = buildSession(code);
    sim.step({ rst_n: 0, key: 0, sw: 0 });
    const waves = Array.from({ length: 8 }, () => sim.step({ rst_n: 1, key: 0, sw: 0 }).sample.outputs.led);
    expect(waves).toEqual([0, 1, 1, 0, 0, 1, 1, 0]);
  });

  it('电路 6：简易 4 位 ALU（支持 8 种算术与位运算）', () => {
    const code = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output reg [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        wire [3:0] a = sw[3:0];
        wire [3:0] b = sw[7:4];
        always @(*) begin
          case (key[2:0])
            3'd0: led = {4'd0, a} + {4'd0, b};
            3'd1: led = {4'd0, a} - {4'd0, b};
            3'd2: led = {4'd0, a & b};
            3'd3: led = {4'd0, a | b};
            3'd4: led = {4'd0, a ^ b};
            3'd5: led = {4'd0, a ~^ b};
            3'd6: led = {4'd0, a << 1};
            default: led = {4'd0, a >> 1};
          endcase
        end
        assign traffic = 3'd0;
        assign seg = 16'd0;
      endmodule
    `;
    const sim = buildSession(code);
    // a=6 (0110), b=3 (0011) -> sw=0x36
    expect(sim.step({ rst_n: 1, key: 0, sw: 0x36 }).sample.outputs.led).toBe(9);
    expect(sim.step({ rst_n: 1, key: 1, sw: 0x36 }).sample.outputs.led).toBe(3);
    expect(sim.step({ rst_n: 1, key: 2, sw: 0x36 }).sample.outputs.led).toBe(2);
    expect(sim.step({ rst_n: 1, key: 3, sw: 0x36 }).sample.outputs.led).toBe(7);
    expect(sim.step({ rst_n: 1, key: 4, sw: 0x36 }).sample.outputs.led).toBe(5);
    expect(sim.step({ rst_n: 1, key: 5, sw: 0x36 }).sample.outputs.led).toBe(0xa);
    expect(sim.step({ rst_n: 1, key: 6, sw: 0x36 }).sample.outputs.led).toBe(12);
    expect(sim.step({ rst_n: 1, key: 7, sw: 0x36 }).sample.outputs.led).toBe(3);
  });

  it('电路 7：8 位串入并出移位寄存器（SIPO）', () => {
    const code = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output reg [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        always @(posedge clk or negedge rst_n) begin
          if (!rst_n) led <= 8'd0;
          else if (key[0]) led <= {led[6:0], sw[0]};
        end
        assign traffic = 3'd0;
        assign seg = 16'd0;
      endmodule
    `;
    const sim = buildSession(code);
    sim.step({ rst_n: 0, key: 0, sw: 0 });
    sim.step({ rst_n: 1, key: 1, sw: 1 });
    sim.step({ rst_n: 1, key: 1, sw: 0 });
    sim.step({ rst_n: 1, key: 1, sw: 1 });
    // key[0]=0 保持不变
    expect(sim.step({ rst_n: 1, key: 0, sw: 1 }).sample.outputs.led).toBe(0b0000_0101);
  });

  it('电路 8：自动售货机状态机（满 3 元出货并正确找零）', () => {
    const code = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output reg [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        reg [1:0] credit;
        always @(posedge clk or negedge rst_n) begin
          if (!rst_n) begin
            credit <= 2'd0;
            led <= 8'd0;
          end else begin
            led <= 8'd0;
            if (key[1]) begin
              if (credit == 2'd0) credit <= 2'd2;
              else if (credit == 2'd1) begin credit <= 2'd0; led <= 8'b0000_0001; end
              else begin credit <= 2'd0; led <= 8'b0000_0011; end
            end else if (key[0]) begin
              if (credit == 2'd2) begin credit <= 2'd0; led <= 8'b0000_0001; end
              else credit <= credit + 2'd1;
            end
          end
        end
        assign traffic = 3'd0;
        assign seg = {14'd0, credit};
      endmodule
    `;
    const sim = buildSession(code);
    sim.step({ rst_n: 0, key: 0, sw: 0 });
    // 投 2 元 -> credit=2
    expect(sim.step({ rst_n: 1, key: 0b0010, sw: 0 }).sample.outputs.seg).toBe(2);
    // 再投 2 元 -> 满 4 元，出货(bit0) + 找零 1 元(bit1)，credit 归 0
    const out = sim.step({ rst_n: 1, key: 0b0010, sw: 0 }).sample.outputs;
    expect(out.led).toBe(0b11);
    expect(out.seg).toBe(0);
  });

  it('电路 9：3 拍按键消抖器（过滤单拍毛刺，连续 3 拍确认）', () => {
    const code = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output reg [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        reg [2:0] shift_key;
        always @(posedge clk or negedge rst_n) begin
          if (!rst_n) begin
            shift_key <= 3'b000;
            led <= 8'd0;
          end else begin
            shift_key <= {shift_key[1:0], key[0]};
            if ({shift_key[1:0], key[0]} == 3'b111) led[0] <= 1'b1;
            else if ({shift_key[1:0], key[0]} == 3'b000) led[0] <= 1'b0;
          end
        end
        assign traffic = 3'd0;
        assign seg = 16'd0;
      endmodule
    `;
    const sim = buildSession(code);
    sim.step({ rst_n: 0, key: 0, sw: 0 });
    // 毛刺：1 拍高后回低 -> led[0] 仍为 0
    expect(sim.step({ rst_n: 1, key: 1, sw: 0 }).sample.outputs.led).toBe(0);
    expect(sim.step({ rst_n: 1, key: 0, sw: 0 }).sample.outputs.led).toBe(0);
    // 连续 3 拍高 -> 第 3 拍稳定拉高
    expect(sim.step({ rst_n: 1, key: 1, sw: 0 }).sample.outputs.led).toBe(0);
    expect(sim.step({ rst_n: 1, key: 1, sw: 0 }).sample.outputs.led).toBe(0);
    expect(sim.step({ rst_n: 1, key: 1, sw: 0 }).sample.outputs.led).toBe(1);
  });

  it('电路 10：8 位奇偶校验器（同时输出奇校验与偶校验位）', () => {
    const code = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        assign led[0] = ^sw;
        assign led[1] = ~^sw;
        assign led[7:2] = 6'd0;
        assign traffic = 3'd0;
        assign seg = 16'd0;
      endmodule
    `;
    const sim = buildSession(code);
    expect(sim.step({ rst_n: 1, key: 0, sw: 0b0000_0111 }).sample.outputs.led).toBe(0b01);
    expect(sim.step({ rst_n: 1, key: 0, sw: 0b0000_1111 }).sample.outputs.led).toBe(0b10);
  });

  it('电路 11：4-2 优先编码器（基于 casez + valid 标志）', () => {
    const code = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output reg [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        always @(*) begin
          casez (key)
            4'b1???: led = 8'b0000_0111; // valid=1, code=3
            4'b01??: led = 8'b0000_0110; // valid=1, code=2
            4'b001?: led = 8'b0000_0101; // valid=1, code=1
            4'b0001: led = 8'b0000_0100; // valid=1, code=0
            default: led = 8'b0000_0000; // valid=0
          endcase
        end
        assign traffic = 3'd0;
        assign seg = 16'd0;
      endmodule
    `;
    const sim = buildSession(code);
    expect(sim.step({ rst_n: 1, key: 0b1010, sw: 0 }).sample.outputs.led).toBe(0b111);
    expect(sim.step({ rst_n: 1, key: 0b0101, sw: 0 }).sample.outputs.led).toBe(0b110);
    expect(sim.step({ rst_n: 1, key: 0b0000, sw: 0 }).sample.outputs.led).toBe(0b000);
  });

  it('电路 12：3-8 译码器与 4 选 1 多路选择器组合', () => {
    const code = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        assign led = 8'b0000_0001 << key[2:0];
        wire [1:0] mux_out = (key[1:0] == 2'd0) ? sw[1:0] :
                             (key[1:0] == 2'd1) ? sw[3:2] :
                             (key[1:0] == 2'd2) ? sw[5:4] : sw[7:6];
        assign traffic = {1'b0, mux_out};
        assign seg = 16'd0;
      endmodule
    `;
    const sim = buildSession(code);
    const out = sim.step({ rst_n: 1, key: 2, sw: 0b11_10_01_00 }).sample.outputs;
    expect(out.led).toBe(0b0000_0100);
    expect(out.traffic).toBe(0b010);
  });
});

describe('12. 异常语法、模糊压测、边界位宽与长周期性能', () => {
  it('超深括号嵌套不触发栈溢出，返回中文 PARSE_ERROR', () => {
    const deep = '('.repeat(200) + 'sw' + ')'.repeat(200);
    const code = `module top(input clk, input rst_n, input [3:0] key, input [7:0] sw, output [7:0] led, output [2:0] traffic, output [15:0] seg); assign led = ${deep}; assign traffic = 0; assign seg = 0; endmodule`;
    const res = createRtlEngine().compile(code);
    expect(res.ok).toBe(false);
    expect(res.issues[0].code).toBe('PARSE_ERROR');
    expect(res.issues[0].message).toContain('嵌套');
  });

  it('超深 if 嵌套不触发栈溢出，返回中文 PARSE_ERROR', () => {
    const deepIf = 'if (key[0]) '.repeat(150) + 'led = 8\'d1;';
    const code = `module top(input clk, input rst_n, input [3:0] key, input [7:0] sw, output reg [7:0] led, output [2:0] traffic, output [15:0] seg); always @(*) begin led = 0; ${deepIf} end assign traffic = 0; assign seg = 0; endmodule`;
    const res = createRtlEngine().compile(code);
    expect(res.ok).toBe(false);
    expect(res.issues[0].code).toBe('PARSE_ERROR');
  });

  it('未闭合块注释 /* 返回精确行号 PARSE_ERROR', () => {
    const code = `module top(input clk);\n/* unclosed comment\nassign led = 0;\nendmodule`;
    const res = parseVerilog(code);
    expect(res.errors[0].code).toBe('PARSE_ERROR');
    expect(res.errors[0].line).toBe(2);
    expect(res.errors[0].message).toContain('注释');
  });

  it('未闭合综合属性 (* 返回 PARSE_ERROR', () => {
    const code = `(* keep = "true"\nmodule top(input clk); endmodule`;
    const res = parseVerilog(code);
    expect(res.errors[0].code).toBe('PARSE_ERROR');
    expect(res.errors[0].line).toBe(1);
    expect(res.errors[0].message).toContain('属性');
  });

  it('非法中文标点返回带行列号的 PARSE_ERROR', () => {
    const code = `module top(input clk)；\nendmodule`;
    const res = parseVerilog(code);
    expect(res.errors[0].code).toBe('PARSE_ERROR');
    expect(res.errors[0].line).toBe(1);
    expect(res.errors[0].column).toBeGreaterThan(1);
  });

  it('非法位宽 0\'b0 与 64\'h1 返回 PARSE_ERROR', () => {
    const r0 = parseVerilog(`module top(input clk); assign led = 0'b0; endmodule`);
    const r64 = parseVerilog(`module top(input clk); assign led = 64'h1; endmodule`);
    expect(r0.errors[0].code).toBe('PARSE_ERROR');
    expect(r64.errors[0].code).toBe('PARSE_ERROR');
  });

  it('非法八进制字面量 4\'o89 与空数字 4\'b 返回 PARSE_ERROR', () => {
    const rOct = parseVerilog(`module top(input clk); assign led = 4'o89; endmodule`);
    const rEmpty = parseVerilog(`module top(input clk); assign led = 4'b; endmodule`);
    expect(rOct.errors[0].code).toBe('PARSE_ERROR');
    expect(rEmpty.errors[0].code).toBe('PARSE_ERROR');
  });

  it('缺少 end / endcase / endmodule 均返回准确中文提示', () => {
    const rEnd = parseVerilog(`module top(input clk); always @(*) begin led = 0; endmodule`);
    const rCase = parseVerilog(`module top(input clk); always @(*) case(key) 0: led = 0; endmodule`);
    const rMod = parseVerilog(`module top(input clk); assign led = 0;`);
    expect(rEnd.errors[0].message).toContain('end');
    expect(rCase.errors[0].message).toContain('endcase');
    expect(rMod.errors[0].message).toContain('endmodule');
  });

  it('畸形模糊输入集合对 compile 与 runSelfTest 均不抛未捕获异常', () => {
    const fuzzInputs = [
      '',
      '   \n\t  ',
      'module',
      'module top(',
      'module top(); always @(posedge) endmodule',
      'module top(); assign = ; endmodule',
      'module top(); for (i = 0; i < ; i++) led = 1; endmodule',
      'module top(); assign led = {4{}}; endmodule',
      'module top(); assign led = $unknown(1); endmodule',
      'module top(); reg [7:0] a = 1 + * 2; endmodule',
    ];
    const engine = createRtlEngine();
    for (const bad of fuzzInputs) {
      expect(() => engine.compile(bad)).not.toThrow();
      const c = engine.compile(bad);
      expect(c.ok).toBe(false);
      expect(c.issues.length).toBeGreaterThan(0);

      expect(() => engine.runSelfTest(bad, [{ cycle: 0, inputs: DEFAULT_IN, expect: { led: 0 } }])).not.toThrow();
      const st = engine.runSelfTest(bad, [{ cycle: 0, inputs: DEFAULT_IN, expect: { led: 0 } }]);
      expect(st.passed).toBe(false);
    }
  });

  it('32 位边界算术溢出回绕与有符号右移符号位保持', () => {
    const code = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        wire [31:0] max_u = 32'hFFFF_FFFF;
        wire [31:0] wrapped = max_u + 32'd1;
        wire signed [7:0] neg = -8'sd16;
        wire signed [7:0] shifted = neg >>> 2;
        assign led = shifted;
        assign traffic = {2'd0, (wrapped == 32'd0)};
        assign seg = 16'd0;
      endmodule
    `;
    const sim = buildSession(code);
    const out = sim.step(DEFAULT_IN).sample.outputs;
    expect(out.traffic).toBe(1);
    expect(out.led).toBe(0xfc); // -16 >>> 2 = -4 = 8'hFC
  });

  it('位索引越界写入安全忽略不崩溃', () => {
    const code = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output reg [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        always @(*) begin
          led = sw;
          led[12] = 1'b1;
        end
        assign traffic = 3'd0;
        assign seg = 16'd0;
      endmodule
    `;
    const sim = buildSession(code);
    expect(sim.step({ rst_n: 1, key: 0, sw: 0x3a }).sample.outputs.led).toBe(0x3a);
  });

  it('超长静态 for 循环在 MAX_FOR_ITERATIONS 上限处安全截断不卡死', () => {
    const code = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output [7:0] led, output [2:0] traffic, output reg [15:0] seg
      );
        integer i;
        always @(*) begin
          seg = 16'd0;
          for (i = 0; i < 1000; i = i + 1) begin
            seg = seg + 16'd1;
          end
        end
        assign led = 8'd0;
        assign traffic = 3'd0;
      endmodule
    `;
    const engine = createRtlEngine();
    expect(engine.compile(code).ok).toBe(true);
    // V3 MAX_FOR_ITERATIONS = 256 iterations capped
    expect(engine.step(DEFAULT_IN).sample.outputs.seg).toBe(256);
  });

  it('MULTI_DRIVER 阻断编译并返回 error 级别告警', () => {
    const code = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        assign led = sw;
        assign led = ~sw;
        assign traffic = 3'd0;
        assign seg = 16'd0;
      endmodule
    `;
    const res = createRtlEngine().compile(code);
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => i.code === 'MULTI_DRIVER' && i.severity === 'error')).toBe(true);
  });

  it('1000 拍长周期连续仿真性能与计数准确性验证', () => {
    const code = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        reg [15:0] cnt;
        always @(posedge clk or negedge rst_n) begin
          if (!rst_n) cnt <= 16'd0;
          else cnt <= cnt + 16'd1;
        end
        assign led = cnt[7:0];
        assign traffic = cnt[2:0];
        assign seg = cnt;
      endmodule
    `;
    const engine = createRtlEngine();
    expect(engine.compile(code).ok).toBe(true);
    const t0 = performance.now();
    engine.step({ rst_n: 0, key: 0, sw: 0 });
    let lastSeg = 0;
    for (let i = 0; i < 1000; i++) {
      lastSeg = engine.step({ rst_n: 1, key: 0, sw: 0 }).sample.outputs.seg;
    }
    const elapsed = performance.now() - t0;
    expect(lastSeg).toBe(1000);
    expect(elapsed).toBeLessThan(1000);
  });
});

describe('13. Verilog 语法着色器 (highlight.ts)', () => {
  const reconstruct = (code: string) =>
    tokenizeVerilogForHighlight(code)
      .map((line) => line.tokens.map((t) => t.value).join(''))
      .join('\n');

  it('精准分类关键字、类型、板卡端口、位宽字面量、系统函数、指令、注释与运算符', () => {
    const code = [
      '`timescale 1ns/1ps',
      'module top(input clk, output reg [7:0] led);',
      '  localparam W = $clog2(16);',
      "  always @(posedge clk) led <= 8'hA5 ^~ 8'b10??_01xz; // 注释",
      'endmodule',
    ].join('\n');

    const lines = tokenizeVerilogForHighlight(code);
    expect(lines).toHaveLength(5);
    expect(lines.map((l) => l.line)).toEqual([1, 2, 3, 4, 5]);
    expect(reconstruct(code)).toBe(code);

    expect(lines[0].tokens[0]).toEqual({ kind: 'directive', value: '`timescale' });
    expect(lines[1].tokens.some((t) => t.kind === 'keyword' && t.value === 'module')).toBe(true);
    expect(lines[1].tokens.some((t) => t.kind === 'type' && t.value === 'input')).toBe(true);
    expect(lines[1].tokens.some((t) => t.kind === 'port' && t.value === 'clk')).toBe(true);
    expect(lines[1].tokens.some((t) => t.kind === 'port' && t.value === 'led')).toBe(true);
    expect(lines[2].tokens.some((t) => t.kind === 'sysfn' && t.value === '$clog2')).toBe(true);
    expect(lines[3].tokens.some((t) => t.kind === 'number' && t.value === "8'hA5")).toBe(true);
    expect(lines[3].tokens.some((t) => t.kind === 'number' && t.value === "8'b10??_01xz")).toBe(true);
    expect(lines[3].tokens.some((t) => t.kind === 'operator' && t.value === '<=')).toBe(true);
    expect(lines[3].tokens.some((t) => t.kind === 'operator' && t.value === '^~')).toBe(true);
    expect(lines[3].tokens.some((t) => t.kind === 'comment' && t.value === '// 注释')).toBe(true);
  });

  it('正确处理多行块注释与综合属性，且不将 always @(*) 误判为属性', () => {
    const code = [
      '/* 第一行注释',
      '   第二行注释 */',
      '(* fsm_encoding = "one_hot",',
      '   keep = "true" *)',
      'always @(*) begin',
      '  $display("hi \\"fpga\\"");',
      'end',
    ].join('\n');

    const lines = tokenizeVerilogForHighlight(code);
    expect(reconstruct(code)).toBe(code);
    expect(lines[0].tokens).toEqual([{ kind: 'comment', value: '/* 第一行注释' }]);
    expect(lines[1].tokens).toEqual([{ kind: 'comment', value: '   第二行注释 */' }]);
    expect(lines[2].tokens).toEqual([{ kind: 'attribute', value: '(* fsm_encoding = "one_hot",' }]);
    expect(lines[3].tokens).toEqual([{ kind: 'attribute', value: '   keep = "true" *)' }]);
    expect(lines[4].tokens.some((t) => t.kind === 'attribute')).toBe(false);
    expect(lines[4].tokens.some((t) => t.kind === 'operator' && t.value === '*')).toBe(true);
    expect(lines[5].tokens.some((t) => t.kind === 'string' && t.value === '"hi \\"fpga\\""')).toBe(true);
  });

  it('对全部 5 个预置案例源码与未闭合畸形片段均可无损切分且不抛错', () => {
    for (const p of PRESETS) {
      const normalized = p.verilogCode.replace(/\r\n/g, '\n');
      expect(reconstruct(p.verilogCode)).toBe(normalized);
    }

    const malformed = [
      '',
      '/* 未闭合注释\nmodule top',
      '(* 未闭合属性',
      '"未闭合字符串',
      "4'h",
      '@@@ ###',
    ];
    for (const sample of malformed) {
      expect(() => tokenizeVerilogForHighlight(sample)).not.toThrow();
      expect(reconstruct(sample)).toBe(sample.replace(/\r\n/g, '\n'));
    }
  });
});

// ============================================================
// 14. V3 1D/2D 定长寄存器数组：解析、仿真、边界、Lint 与 MEM 网表
// ============================================================
describe('14. V3 1D/2D 定长寄存器数组', () => {
  it('1D 升序与降序定长数组声明、非阻塞写入与读取正常', () => {
    const code = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        reg [7:0] asc_mem [0:3];
        reg [7:0] desc_mem [3:0];
        always @(posedge clk or negedge rst_n) begin
          if (!rst_n) begin
            asc_mem[0] <= 8'h11;
            asc_mem[1] <= 8'h22;
            desc_mem[3] <= 8'hAA;
            desc_mem[2] <= 8'hBB;
          end else if (key[0]) begin
            asc_mem[0] <= asc_mem[1];
            asc_mem[1] <= asc_mem[0];
          end
        end
        assign led = sw[0] ? desc_mem[3] : asc_mem[0];
        assign traffic = 3'd0;
        assign seg = {asc_mem[0], asc_mem[1]};
      endmodule
    `;
    const engine = createRtlEngine();
    const res = engine.compile(code);
    expect(res.ok).toBe(true);
    expect(res.issues.filter((i) => i.severity === 'error')).toHaveLength(0);

    // rst_n = 0 初始化
    let s = engine.step({ rst_n: 0, key: 0, sw: 0 }).sample;
    expect(s.outputs.led).toBe(0x11);
    expect(s.outputs.seg).toBe(0x1122);

    // 切到 desc_mem[3]
    s = engine.step({ rst_n: 1, key: 0, sw: 1 }).sample;
    expect(s.outputs.led).toBe(0xaa);

    // 非阻塞交换 asc_mem[0] 与 asc_mem[1]
    s = engine.step({ rst_n: 1, key: 1, sw: 0 }).sample;
    expect(s.outputs.led).toBe(0x22);
    expect(s.outputs.seg).toBe(0x2211);
  });

  it('1D 数组支持变量下标动态读写', () => {
    const code = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        reg [7:0] ram [0:15];
        wire [3:0] addr = sw[3:0];
        always @(posedge clk) begin
          if (key[0]) begin
            ram[addr] <= {4'hA, sw[7:4]};
          end
        end
        assign led = ram[addr];
        assign traffic = 3'd0;
        assign seg = 16'd0;
      endmodule
    `;
    const engine = createRtlEngine();
    expect(engine.compile(code).ok).toBe(true);

    // 写 addr=5, val=0xA3
    engine.step({ rst_n: 1, key: 1, sw: 0x35 });
    // 写 addr=9, val=0xA7
    engine.step({ rst_n: 1, key: 1, sw: 0x79 });
    // 读回 addr=5
    expect(engine.step({ rst_n: 1, key: 0, sw: 0x05 }).sample.outputs.led).toBe(0xa3);
    // 读回 addr=9
    expect(engine.step({ rst_n: 1, key: 0, sw: 0x09 }).sample.outputs.led).toBe(0xa7);
  });

  it('1D 数组支持 parameter / localparam 定义位宽与深度', () => {
    const code = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        localparam DEPTH = 8;
        localparam WIDTH = 8;
        reg [WIDTH-1:0] buf_mem [0:DEPTH-1];
        integer i;
        always @(posedge clk or negedge rst_n) begin
          if (!rst_n) begin
            for (i = 0; i < DEPTH; i = i + 1) begin
              buf_mem[i] <= i * 8'd10;
            end
          end
        end
        assign led = buf_mem[sw[2:0]];
        assign traffic = 3'd0;
        assign seg = 16'd0;
      endmodule
    `;
    const engine = createRtlEngine();
    const compiled = engine.compile(code);
    expect(compiled.ok).toBe(true);
    expect(compiled.metadata?.arrays).toEqual([
      { name: 'buf_mem', elementWidth: 8, dimensions: [8] },
    ]);

    engine.step({ rst_n: 0, key: 0, sw: 0 });
    expect(engine.step({ rst_n: 1, key: 0, sw: 5 }).sample.outputs.led).toBe(50);
    expect(engine.step({ rst_n: 1, key: 0, sw: 7 }).sample.outputs.led).toBe(70);
  });

  it('2D 定长寄存器数组支持双重索引读写与嵌套 for 初始化', () => {
    const code = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        reg [7:0] grid [0:3][0:3];
        integer r, c;
        always @(posedge clk or negedge rst_n) begin
          if (!rst_n) begin
            for (r = 0; r < 4; r = r + 1) begin
              for (c = 0; c < 4; c = c + 1) begin
                grid[r][c] <= (r << 4) | c;
              end
            end
          end else if (key[0]) begin
            grid[sw[3:2]][sw[1:0]] <= 8'hFF;
          end
        end
        assign led = grid[sw[3:2]][sw[1:0]];
        assign traffic = 3'd0;
        assign seg = 16'd0;
      endmodule
    `;
    const engine = createRtlEngine();
    const compiled = engine.compile(code);
    expect(compiled.ok).toBe(true);
    expect(compiled.metadata?.arrays).toEqual([
      { name: 'grid', elementWidth: 8, dimensions: [4, 4] },
    ]);

    engine.step({ rst_n: 0, key: 0, sw: 0 });
    // r=2, c=3 -> 0x23
    expect(engine.step({ rst_n: 1, key: 0, sw: (2 << 2) | 3 }).sample.outputs.led).toBe(0x23);
    // 写入 (2,3) = 0xFF
    expect(engine.step({ rst_n: 1, key: 1, sw: (2 << 2) | 3 }).sample.outputs.led).toBe(0xff);
    // 其他位置不受影响 (1,2) -> 0x12
    expect(engine.step({ rst_n: 1, key: 0, sw: (1 << 2) | 2 }).sample.outputs.led).toBe(0x12);
  });

  it('支持数组元素位切片读取与位切片写入', () => {
    const code = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        reg [7:0] regs [0:3];
        always @(posedge clk or negedge rst_n) begin
          if (!rst_n) begin
            regs[0] <= 8'h00;
          end else if (key[0]) begin
            regs[0][3:0] <= sw[3:0];
          end else if (key[1]) begin
            regs[0][7:4] <= sw[3:0];
          end
        end
        assign led = {regs[0][7:4], regs[0][3:0]};
        assign traffic = 3'd0;
        assign seg = {12'd0, regs[0][7:4]};
      endmodule
    `;
    const engine = createRtlEngine();
    expect(engine.compile(code).ok).toBe(true);

    engine.step({ rst_n: 0, key: 0, sw: 0 });
    engine.step({ rst_n: 1, key: 1, sw: 0x05 });
    const s = engine.step({ rst_n: 1, key: 2, sw: 0x0a }).sample;
    expect(s.outputs.led).toBe(0xa5);
    expect(s.outputs.seg).toBe(0x000a);
  });

  it('数组动态索引越界读取返回 0 且越界写入安全忽略不崩溃', () => {
    const code = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        reg [7:0] small_arr [0:3];
        always @(posedge clk) begin
          if (key[0]) small_arr[sw[3:0]] <= 8'h5A;
        end
        assign led = small_arr[sw[3:0]];
        assign traffic = 3'd0;
        assign seg = 16'd0;
      endmodule
    `;
    const engine = createRtlEngine();
    expect(engine.compile(code).ok).toBe(true);

    // 越界写入 idx=12
    expect(() => engine.step({ rst_n: 1, key: 1, sw: 12 })).not.toThrow();
    // 越界读取 idx=12 返回 0
    expect(engine.step({ rst_n: 1, key: 0, sw: 12 }).sample.outputs.led).toBe(0);
    // 合法写入 idx=2 仍正常
    expect(engine.step({ rst_n: 1, key: 1, sw: 2 }).sample.outputs.led).toBe(0x5a);
  });

  it('reset() 能将数组全部元素彻底清零', () => {
    const code = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        reg [7:0] mem [0:3];
        always @(posedge clk) begin
          if (key[0]) mem[sw[1:0]] <= 8'hC3;
        end
        assign led = mem[sw[1:0]];
        assign traffic = 3'd0;
        assign seg = 16'd0;
      endmodule
    `;
    const engine = createRtlEngine();
    expect(engine.compile(code).ok).toBe(true);
    expect(engine.step({ rst_n: 1, key: 1, sw: 1 }).sample.outputs.led).toBe(0xc3);

    engine.reset();
    expect(engine.step({ rst_n: 1, key: 0, sw: 1 }).sample.outputs.led).toBe(0x00);
  });

  it('ARRAY_BOUNDS_OR_DIM 检测超限数组维度（>4096）并阻断编译', () => {
    const code = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        reg [7:0] huge [0:8191];
        assign led = huge[sw];
        assign traffic = 3'd0;
        assign seg = 16'd0;
      endmodule
    `;
    const res = createRtlEngine().compile(code);
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => i.code === 'ARRAY_BOUNDS_OR_DIM' && i.severity === 'error')).toBe(true);
  });

  it('ARRAY_BOUNDS_OR_DIM 检测静态常数下标越界告警', () => {
    const code = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        reg [7:0] arr [0:3];
        always @(posedge clk) begin
          arr[0] <= sw;
        end
        assign led = arr[7];
        assign traffic = 3'd0;
        assign seg = 16'd0;
      endmodule
    `;
    const res = createRtlEngine().compile(code);
    expect(res.issues.some((i) => i.code === 'ARRAY_BOUNDS_OR_DIM')).toBe(true);
  });

  it('含数组模块在网表中生成聚合 MEM 节点而非展开成海量 DFF', () => {
    const code = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        reg [7:0] vram [0:63];
        always @(posedge clk) begin
          if (key[0]) vram[sw[5:0]] <= sw;
        end
        assign led = vram[sw[5:0]];
        assign traffic = 3'd0;
        assign seg = 16'd0;
      endmodule
    `;
    const res = createRtlEngine().compile(code);
    expect(res.ok).toBe(true);
    const memNodes = res.netlist!.nodes.filter((n) => n.kind === 'MEM');
    expect(memNodes.length).toBe(1);
    expect(memNodes[0].label).toContain('vram');
    expect(res.netlist!.nodes.length).toBeLessThan(30);
  });
});

// ============================================================
// 15. V3 扩展外设端口（tone 蜂鸣器 & 16x8 OLED 屏幕）与确定性显存
// ============================================================
describe('15. V3 tone 蜂鸣器与 16x8 屏幕显存状态机', () => {
  it('声明 tone 端口时输出 extendedOutputs.tone 且 metadata.usedOutputs 包含 tone', () => {
    const code = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output [7:0] led, output [2:0] traffic, output [15:0] seg,
        output [3:0] tone
      );
        assign led = sw;
        assign traffic = 3'd0;
        assign seg = 16'd0;
        assign tone = sw[3:0];
      endmodule
    `;
    const engine = createRtlEngine();
    const compiled = engine.compile(code);
    expect(compiled.ok).toBe(true);
    expect(compiled.metadata?.usedOutputs).toContain('tone');
    expect(compiled.metadata?.usedOutputs).not.toContain('screen');

    const s1 = engine.step({ rst_n: 1, key: 0, sw: 0x09 }).sample;
    expect(s1.extendedOutputs?.tone).toBe(9);
    expect(s1.extendedOutputs?.screen).toBeUndefined();
    expect(s1.screenBuffer).toBeUndefined();

    const s2 = engine.step({ rst_n: 1, key: 0, sw: 0x00 }).sample;
    expect(s2.extendedOutputs?.tone).toBe(0);
  });

  it('纯经典端口模块保持 100% 向后兼容，不产生 extendedOutputs 与 screenBuffer', () => {
    const engine = createRtlEngine();
    const compiled = engine.compile(PRESETS[0].verilogCode);
    expect(compiled.ok).toBe(true);
    expect(compiled.metadata?.usedOutputs).not.toContain('tone');
    expect(compiled.metadata?.usedOutputs).not.toContain('screen');

    const sample = engine.step(DEFAULT_IN).sample;
    expect(sample.extendedOutputs).toBeUndefined();
    expect(sample.screenBuffer).toBeUndefined();
  });

  it('可选端口位宽不匹配（如 tone 非 4-bit 或 screen_x 非 4-bit）触发 PORT_MISMATCH', () => {
    const badTone = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output [7:0] led, output [2:0] traffic, output [15:0] seg,
        output [1:0] tone
      );
        assign led = 8'd0; assign traffic = 3'd0; assign seg = 16'd0; assign tone = 2'd1;
      endmodule
    `;
    const r1 = createRtlEngine().compile(badTone);
    expect(r1.ok).toBe(false);
    expect(r1.issues.some((i) => i.code === 'PORT_MISMATCH')).toBe(true);

    const badScreenWidth = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output [7:0] led, output [2:0] traffic, output [15:0] seg,
        output [2:0] screen_x, output [2:0] screen_y, output [7:0] screen_data, output [1:0] screen_cmd
      );
        assign led = 8'd0; assign traffic = 3'd0; assign seg = 16'd0;
        assign screen_x = 3'd0; assign screen_y = 3'd0; assign screen_data = 8'd0; assign screen_cmd = 2'd0;
      endmodule
    `;
    const r2 = createRtlEngine().compile(badScreenWidth);
    expect(r2.ok).toBe(false);
    expect(r2.issues.some((i) => i.code === 'PORT_MISMATCH')).toBe(true);
  });

  it('screen_* 端口仅声明不完整子集时触发 PORT_MISMATCH', () => {
    const partialScreen = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output [7:0] led, output [2:0] traffic, output [15:0] seg,
        output [3:0] screen_x, output [2:0] screen_y
      );
        assign led = 8'd0; assign traffic = 3'd0; assign seg = 16'd0;
        assign screen_x = 4'd0; assign screen_y = 3'd0;
      endmodule
    `;
    const res = createRtlEngine().compile(partialScreen);
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => i.code === 'PORT_MISMATCH')).toBe(true);
  });

  const SCREEN_DRIVER_CODE = `
    module top(
      input clk, input rst_n, input [3:0] key, input [7:0] sw,
      output [7:0] led, output [2:0] traffic, output [15:0] seg,
      output [3:0] screen_x, output [2:0] screen_y,
      output [7:0] screen_data, output [1:0] screen_cmd
    );
      // key[1:0] 控制 cmd，sw[3:0] 控制 x，sw[6:4] 控制 y，sw[7] 选字符 'A'(0x41) 或 'Z'(0x5A)
      assign led = sw;
      assign traffic = 3'd0;
      assign seg = 16'd0;
      assign screen_cmd = key[1:0];
      assign screen_x = sw[3:0];
      assign screen_y = sw[6:4];
      assign screen_data = sw[7] ? 8'h5A : 8'h41;
    endmodule
  `;

  it('screen_cmd = 2\'b00（无操作）不修改 screenBuffer', () => {
    const engine = createRtlEngine();
    const compiled = engine.compile(SCREEN_DRIVER_CODE);
    expect(compiled.ok).toBe(true);
    expect(compiled.metadata?.usedOutputs).toContain('screen');

    const s = engine.step({ rst_n: 1, key: 0, sw: 0x12 }).sample;
    expect(s.screenBuffer).toHaveLength(128);
    expect(s.screenBuffer!.every((v) => v === 0)).toBe(true);
    expect(s.extendedOutputs?.screen).toEqual({ x: 2, y: 1, data: 0x41, cmd: 0 });
  });

  it('screen_cmd = 2\'b01（写入）精确写入 (x, y) 且保留其他单元格', () => {
    const engine = createRtlEngine();
    expect(engine.compile(SCREEN_DRIVER_CODE).ok).toBe(true);

    // 写 (x=3, y=2) = 'A' (0x41) -> index = 2*16 + 3 = 35
    const s1 = engine.step({ rst_n: 1, key: 1, sw: (2 << 4) | 3 }).sample;
    expect(s1.screenBuffer![2 * 16 + 3]).toBe(0x41);

    // 再写 (x=15, y=7) = 'Z' (0x5A) -> index = 7*16 + 15 = 127
    const s2 = engine.step({ rst_n: 1, key: 1, sw: 0x80 | (7 << 4) | 15 }).sample;
    expect(s2.screenBuffer![2 * 16 + 3]).toBe(0x41);
    expect(s2.screenBuffer![127]).toBe(0x5a);
  });

  it('screen_cmd = 2\'b10（清屏）清空全部 128 格', () => {
    const engine = createRtlEngine();
    expect(engine.compile(SCREEN_DRIVER_CODE).ok).toBe(true);

    engine.step({ rst_n: 1, key: 1, sw: (1 << 4) | 5 });
    const cleared = engine.step({ rst_n: 1, key: 2, sw: 0 }).sample;
    expect(cleared.screenBuffer!.every((v) => v === 0)).toBe(true);
  });

  it('screen_cmd = 2\'b11（清屏并立即写入）清空旧内容并仅写入当前 (x, y)', () => {
    const engine = createRtlEngine();
    expect(engine.compile(SCREEN_DRIVER_CODE).ok).toBe(true);

    // 先写 (0,0)='A' 和 (4,4)='A'
    engine.step({ rst_n: 1, key: 1, sw: 0x00 });
    engine.step({ rst_n: 1, key: 1, sw: (4 << 4) | 4 });

    // cmd=3 清屏并写入 (2,3)='Z' (0x5A)
    const s = engine.step({ rst_n: 1, key: 3, sw: 0x80 | (3 << 4) | 2 }).sample;
    expect(s.screenBuffer![0]).toBe(0);
    expect(s.screenBuffer![4 * 16 + 4]).toBe(0);
    expect(s.screenBuffer![3 * 16 + 2]).toBe(0x5a);
    expect(s.screenBuffer!.filter((v) => v !== 0)).toHaveLength(1);
  });

  it('engine.reset() 彻底清空 screenBuffer 并将 cycle 归零', () => {
    const engine = createRtlEngine();
    expect(engine.compile(SCREEN_DRIVER_CODE).ok).toBe(true);

    engine.step({ rst_n: 1, key: 1, sw: (5 << 4) | 1 });
    engine.reset();
    const afterReset = engine.step({ rst_n: 1, key: 0, sw: 0 }).sample;
    expect(afterReset.cycle).toBe(0);
    expect(afterReset.screenBuffer!.every((v) => v === 0)).toBe(true);
  });

  it('screenBuffer 快照为独立拷贝，外部篡改不影响引擎内部显存', () => {
    const engine = createRtlEngine();
    expect(engine.compile(SCREEN_DRIVER_CODE).ok).toBe(true);

    const s1 = engine.step({ rst_n: 1, key: 1, sw: 0x01 }).sample;
    expect(s1.screenBuffer![1]).toBe(0x41);
    s1.screenBuffer![1] = 0x99;
    s1.screenBuffer![0] = 0x88;

    const s2 = engine.step({ rst_n: 1, key: 0, sw: 0 }).sample;
    expect(s2.screenBuffer![1]).toBe(0x41);
    expect(s2.screenBuffer![0]).toBe(0x00);
  });
});

// ============================================================
// 16. V3 stepBatch 单帧多拍高速步进
// ============================================================
describe('16. V3 stepBatch 单帧多拍步进', () => {
  const COUNTER_SCREEN_CODE = `
    module top(
      input clk, input rst_n, input [3:0] key, input [7:0] sw,
      output [7:0] led, output [2:0] traffic, output [15:0] seg,
      output [3:0] screen_x, output [2:0] screen_y,
      output [7:0] screen_data, output [1:0] screen_cmd
    );
      reg [6:0] ptr;
      always @(posedge clk or negedge rst_n) begin
        if (!rst_n) ptr <= 7'd0;
        else ptr <= ptr + 7'd1;
      end
      assign led = {1'b0, ptr};
      assign traffic = 3'd0;
      assign seg = {9'd0, ptr};
      assign screen_x = ptr[3:0];
      assign screen_y = ptr[6:4];
      assign screen_data = 8'h41 + {4'd0, ptr[3:0]};
      assign screen_cmd = 2'b01;
    endmodule
  `;

  it('stepBatch(inputs, 16) 连续推进 16 拍并准确返回 waveformDelta 与末拍快照', () => {
    const engine = createRtlEngine();
    expect(engine.compile(COUNTER_SCREEN_CODE).ok).toBe(true);

    // 先复位 1 拍
    engine.step({ rst_n: 0, key: 0, sw: 0 });
    const batch = engine.stepBatch!({ rst_n: 1, key: 0, sw: 0 }, 16);
    expect(batch.waveformDelta).toHaveLength(16);
    expect(batch.waveformDelta![0].cycle).toBe(1);
    expect(batch.sample.cycle).toBe(16);
    expect(batch.sample.outputs.led).toBe(16);
  });

  it('stepBatch 单帧 16 拍扫描写满一整行 16 格且显存全部落盘', () => {
    const engine = createRtlEngine();
    expect(engine.compile(COUNTER_SCREEN_CODE).ok).toBe(true);

    engine.step({ rst_n: 0, key: 0, sw: 0 });
    const batch = engine.stepBatch!({ rst_n: 1, key: 0, sw: 0 }, 16);
    // ptr 依次为 1..16，其中 ptr=1..15 写入 row 0 col 1..15，ptr=16 写入 row 1 col 0
    for (let x = 1; x < 16; x++) {
      expect(batch.sample.screenBuffer![x]).toBe(0x41 + x);
    }
    expect(batch.sample.screenBuffer![16]).toBe(0x41);
  });

  it('stepBatch 对异常步数参数进行 [1, 256] 边界钳位', () => {
    const engine = createRtlEngine();
    expect(engine.compile(COUNTER_SCREEN_CODE).ok).toBe(true);

    const bZero = engine.stepBatch!(DEFAULT_IN, 0);
    expect(bZero.waveformDelta).toHaveLength(1);

    const bNeg = engine.stepBatch!(DEFAULT_IN, -10);
    expect(bNeg.waveformDelta).toHaveLength(1);

    const bHuge = engine.stepBatch!(DEFAULT_IN, 999);
    expect(bHuge.waveformDelta).toHaveLength(256);
  });

  it('未编译状态下调用 stepBatch 安全返回空快照与空网表', () => {
    const engine = createRtlEngine();
    const res = engine.stepBatch!(DEFAULT_IN, 8);
    expect(res.sample.cycle).toBe(0);
    expect(res.netlist.nodes).toHaveLength(0);
    expect(res.waveformDelta).toHaveLength(1);
  });

  it('stepBatch 遇到组合环路时在 netlist.narration 中标注组合环路保护', () => {
    const loopCode = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        wire a, b;
        assign a = ~b;
        assign b = a;
        assign led = {7'd0, a};
        assign traffic = 3'd0;
        assign seg = 16'd0;
      endmodule
    `;
    const engine = createRtlEngine();
    expect(engine.compile(loopCode).ok).toBe(true);
    const res = engine.stepBatch!(DEFAULT_IN, 4);
    expect(res.netlist.narration).toContain('[组合环路保护]');
  });
});

// ============================================================
// 17. V3 自测断言（expectTone / expectScreen）与 exportTestbench
// ============================================================
describe('17. V3 自测断言与 Testbench 导出', () => {
  const V3_DEMO_CODE = `
    module top(
      input clk, input rst_n, input [3:0] key, input [7:0] sw,
      output [7:0] led, output [2:0] traffic, output [15:0] seg,
      output [3:0] tone,
      output [3:0] screen_x, output [2:0] screen_y,
      output [7:0] screen_data, output [1:0] screen_cmd
    );
      assign led = sw;
      assign traffic = 3'd0;
      assign seg = 16'd0;
      assign tone = key[3:0];
      assign screen_x = sw[3:0];
      assign screen_y = sw[6:4];
      assign screen_data = 8'h48; // 'H'
      assign screen_cmd = sw[7] ? 2'b01 : 2'b00;
    endmodule
  `;

  it('runSelfTest 验证 expectTone 通过与失败反例报告', () => {
    const passVecs: TestVectorStep[] = [
      { cycle: 0, inputs: { rst_n: 1, key: 5, sw: 0 }, expectTone: 5, note: 'beep 5' },
      { cycle: 1, inputs: { rst_n: 1, key: 0, sw: 0 }, expectTone: 0, note: 'mute' },
    ];
    const okRes = runDeterministicSelfTest(V3_DEMO_CODE, passVecs);
    expect(okRes.passed).toBe(true);
    expect(okRes.totalChecks).toBe(2);
    expect(okRes.passedChecks).toBe(2);

    const failVecs: TestVectorStep[] = [
      { cycle: 0, inputs: { rst_n: 1, key: 5, sw: 0 }, expectTone: 3, note: 'wrong tone' },
    ];
    const failRes = runDeterministicSelfTest(V3_DEMO_CODE, failVecs);
    expect(failRes.passed).toBe(false);
    expect(failRes.firstFailure).toMatchObject({
      cycle: 0,
      signal: 'tone',
      expected: 3,
      actual: 5,
    });
  });

  it('runSelfTest 验证 expectScreen 多格断言通过与失败坐标定位', () => {
    const passVecs: TestVectorStep[] = [
      {
        cycle: 0,
        inputs: { rst_n: 1, key: 0, sw: 0x80 | (1 << 4) | 2 },
        expectScreen: [{ x: 2, y: 1, code: 0x48 }],
      },
      {
        cycle: 1,
        inputs: { rst_n: 1, key: 0, sw: 0x80 | (3 << 4) | 5 },
        expectScreen: [
          { x: 2, y: 1, code: 0x48 },
          { x: 5, y: 3, code: 0x48 },
          { x: 0, y: 0, code: 0x00 },
        ],
      },
    ];
    const okRes = runDeterministicSelfTest(V3_DEMO_CODE, passVecs);
    expect(okRes.passed).toBe(true);
    expect(okRes.totalChecks).toBe(4);
    expect(okRes.passedChecks).toBe(4);

    const failVecs: TestVectorStep[] = [
      {
        cycle: 0,
        inputs: { rst_n: 1, key: 0, sw: 0x80 | (1 << 4) | 2 },
        expectScreen: [{ x: 2, y: 1, code: 0x49 }],
        note: 'expect I',
      },
    ];
    const failRes = runDeterministicSelfTest(V3_DEMO_CODE, failVecs);
    expect(failRes.passed).toBe(false);
    expect(failRes.firstFailure).toMatchObject({
      cycle: 0,
      signal: 'screen',
      screenCoord: { x: 2, y: 1 },
      expected: 0x49,
      actual: 0x48,
    });
  });

  it('expectScreen 越界坐标安全判失败而不抛出异常', () => {
    const vecs: TestVectorStep[] = [
      {
        cycle: 0,
        inputs: DEFAULT_IN,
        expectScreen: [{ x: 16, y: 0, code: 0 }],
      },
    ];
    const res = runDeterministicSelfTest(V3_DEMO_CODE, vecs);
    expect(res.passed).toBe(false);
    expect(res.firstFailure?.signal).toBe('screen');
    expect(res.firstFailure?.screenCoord).toEqual({ x: 16, y: 0 });
  });

  it('V3 自测断言同样支持 regressedCycles 无回退检测', () => {
    const vecs: TestVectorStep[] = [
      { cycle: 0, inputs: { rst_n: 1, key: 1, sw: 0 }, expectTone: 1 },
      { cycle: 1, inputs: { rst_n: 1, key: 2, sw: 0 }, expectTone: 9 },
    ];
    const res = runDeterministicSelfTest(V3_DEMO_CODE, vecs, [0, 1]);
    expect(res.passed).toBe(false);
    expect(res.passedCycles).toEqual([0]);
    expect(res.regressedCycles).toEqual([1]);
  });

  it('exportTestbench 对含 tone/screen 端口的模块自动导出对应 wire、例化与检查语句', () => {
    const engine = createRtlEngine();
    const tb = engine.exportTestbench!(V3_DEMO_CODE, [
      {
        cycle: 0,
        inputs: { rst_n: 1, key: 4, sw: 0x85 },
        expectTone: 4,
        expectScreen: [{ x: 5, y: 0, code: 0x48 }],
      },
    ]);
    expect(tb).toContain('wire [3:0] tone;');
    expect(tb).toContain('wire [3:0] screen_x;');
    expect(tb).toContain('wire [2:0] screen_y;');
    expect(tb).toContain('wire [7:0] screen_data;');
    expect(tb).toContain('wire [1:0] screen_cmd;');
    expect(tb).toContain('.tone(tone)');
    expect(tb).toContain('.screen_cmd(screen_cmd)');
    expect(tb).toContain("if (tone !== 4'h4)");
    expect(tb).toContain('screen_mem');
    expect(tb).toContain("8'h48");
  });

  it('exportTestbench 对经典模块保持精简，不强行输出 tone 或 screen 端口', () => {
    const engine = createRtlEngine();
    const tb = engine.exportTestbench!(PRESETS[0].verilogCode, [
      { cycle: 0, inputs: { rst_n: 0, key: 0, sw: 0 }, expect: { traffic: 1 } },
    ]);
    expect(tb).not.toContain('screen_x');
    expect(tb).not.toContain('.tone(');
  });
});

// ============================================================
// 18. V3 端到端真实硬件场景集成测试
// ============================================================
describe('18. V3 端到端真实硬件场景（终端 / 贪吃蛇 / 2D 帧缓冲 / 电子琴 / 全屏刷屏性能）', () => {
  it('场景 1：16x8 ASCII 文本终端（ROM 数组 + stepBatch 一帧刷出 "HELLO FPGA!"）', () => {
    const code = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output [7:0] led, output [2:0] traffic, output [15:0] seg,
        output [3:0] screen_x, output [2:0] screen_y,
        output [7:0] screen_data, output [1:0] screen_cmd
      );
        reg [7:0] msg [0:10];
        reg [3:0] idx;
        reg [3:0] wr_x;
        reg [7:0] wr_ch;
        reg wr_en;
        always @(posedge clk or negedge rst_n) begin
          if (!rst_n) begin
            msg[0]  <= 8'h48; // H
            msg[1]  <= 8'h45; // E
            msg[2]  <= 8'h4C; // L
            msg[3]  <= 8'h4C; // L
            msg[4]  <= 8'h4F; // O
            msg[5]  <= 8'h20; // space
            msg[6]  <= 8'h46; // F
            msg[7]  <= 8'h50; // P
            msg[8]  <= 8'h47; // G
            msg[9]  <= 8'h41; // A
            msg[10] <= 8'h21; // !
            idx <= 4'd0;
            wr_x <= 4'd0;
            wr_ch <= 8'h00;
            wr_en <= 1'b0;
          end else if (idx < 4'd11) begin
            wr_x <= idx;
            wr_ch <= msg[idx];
            wr_en <= 1'b1;
            idx <= idx + 4'd1;
          end else begin
            wr_en <= 1'b0;
          end
        end
        assign led = {4'd0, idx};
        assign traffic = 3'd0;
        assign seg = 16'd0;
        assign screen_x = wr_x;
        assign screen_y = 3'd2;
        assign screen_data = wr_ch;
        assign screen_cmd = wr_en ? 2'b01 : 2'b00;
      endmodule
    `;
    const engine = createRtlEngine();
    expect(engine.compile(code).ok).toBe(true);

    engine.step({ rst_n: 0, key: 0, sw: 0 });
    const res = engine.stepBatch!({ rst_n: 1, key: 0, sw: 0 }, 12);
    const row2 = res.sample.screenBuffer!.slice(2 * 16, 2 * 16 + 11);
    const text = String.fromCharCode(...row2);
    expect(text).toBe('HELLO FPGA!');
  });

  it('场景 2：简易贪吃蛇核心逻辑（1D 坐标队列数组 + 按键转向 + 吃食物触发 tone + 图块绘制）', () => {
    const code = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output [7:0] led, output [2:0] traffic, output [15:0] seg,
        output [3:0] tone,
        output [3:0] screen_x, output [2:0] screen_y,
        output [7:0] screen_data, output [1:0] screen_cmd
      );
        reg [3:0] sx [0:3];
        reg [2:0] sy [0:3];
        reg [3:0] food_x;
        reg [2:0] food_y;
        reg ate;
        integer k;

        always @(posedge clk or negedge rst_n) begin
          if (!rst_n) begin
            sx[0] <= 4'd4; sy[0] <= 3'd3;
            sx[1] <= 4'd3; sy[1] <= 3'd3;
            sx[2] <= 4'd2; sy[2] <= 3'd3;
            sx[3] <= 4'd1; sy[3] <= 3'd3;
            food_x <= 4'd6; food_y <= 3'd3;
            ate <= 1'b0;
          end else begin
            for (k = 3; k > 0; k = k - 1) begin
              sx[k] <= sx[k-1];
              sy[k] <= sy[k-1];
            end
            // key[0]=右, key[1]=下
            if (key[1]) begin
              sx[0] <= sx[0];
              sy[0] <= sy[0] + 3'd1;
            end else begin
              sx[0] <= sx[0] + 4'd1;
              sy[0] <= sy[0];
            end
            ate <= ((sx[0] + 4'd1) == food_x) && (sy[0] == food_y) && !key[1];
          end
        end

        assign led = {4'd0, sx[0]};
        assign traffic = 3'd0;
        assign seg = {4'd0, sx[0], 5'd0, sy[0]};
        assign tone = ate ? 4'd8 : 4'd0;
        assign screen_x = sx[0];
        assign screen_y = sy[0];
        assign screen_data = 8'h81; // 蛇头图块
        assign screen_cmd = rst_n ? 2'b01 : 2'b00;
      endmodule
    `;
    const engine = createRtlEngine();
    const compiled = engine.compile(code);
    expect(compiled.ok).toBe(true);
    expect(compiled.metadata?.arrays?.map((a) => a.name).sort()).toEqual(['sx', 'sy']);

    // 复位
    engine.step({ rst_n: 0, key: 0, sw: 0 });
    // 第 1 拍向右走到 (5,3)
    const s1 = engine.step({ rst_n: 1, key: 0, sw: 0 }).sample;
    expect(s1.outputs.led).toBe(5);
    expect(s1.extendedOutputs?.tone).toBe(0);
    expect(s1.screenBuffer![3 * 16 + 5]).toBe(0x81);

    // 第 2 拍向右走到 (6,3) 吃到食物 -> tone = 8
    const s2 = engine.step({ rst_n: 1, key: 0, sw: 0 }).sample;
    expect(s2.outputs.led).toBe(6);
    expect(s2.extendedOutputs?.tone).toBe(8);
    expect(s2.screenBuffer![3 * 16 + 6]).toBe(0x81);

    // 第 3 拍按 key[1] 向下走到 (6,4)
    const s3 = engine.step({ rst_n: 1, key: 2, sw: 0 }).sample;
    expect(s3.screenBuffer![4 * 16 + 6]).toBe(0x81);
    expect(s3.extendedOutputs?.tone).toBe(0);
  });

  it('场景 3：2D 帧缓冲数组 fb[0:3][0:3] 逐拍扫描输出到屏幕', () => {
    const code = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output [7:0] led, output [2:0] traffic, output [15:0] seg,
        output [3:0] screen_x, output [2:0] screen_y,
        output [7:0] screen_data, output [1:0] screen_cmd
      );
        reg [7:0] fb [0:3][0:3];
        reg [3:0] scan;
        integer y, x;
        always @(posedge clk or negedge rst_n) begin
          if (!rst_n) begin
            for (y = 0; y < 4; y = y + 1)
              for (x = 0; x < 4; x = x + 1)
                fb[y][x] <= ((x + y) & 1) ? 8'h80 : 8'h2E;
            scan <= 4'd0;
          end else begin
            scan <= scan + 4'd1;
          end
        end
        assign led = {4'd0, scan};
        assign traffic = 3'd0;
        assign seg = 16'd0;
        assign screen_x = {2'b00, scan[1:0]};
        assign screen_y = {1'b0, scan[3:2]};
        assign screen_data = fb[scan[3:2]][scan[1:0]];
        assign screen_cmd = rst_n ? 2'b01 : 2'b00;
      endmodule
    `;
    const engine = createRtlEngine();
    expect(engine.compile(code).ok).toBe(true);

    engine.step({ rst_n: 0, key: 0, sw: 0 });
    const res = engine.stepBatch!({ rst_n: 1, key: 0, sw: 0 }, 16);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        expect(res.sample.screenBuffer![y * 16 + x]).toBe((x + y) % 2 === 1 ? 0x80 : 0x2e);
      }
    }
  });

  it('场景 4：4-bit 简易电子琴（sw 选音阶驱动 tone + seg 显示音符）', () => {
    const code = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output [7:0] led, output [2:0] traffic, output [15:0] seg,
        output reg [3:0] tone
      );
        always @(*) begin
          case (1'b1)
            sw[7]: tone = 4'd8;
            sw[6]: tone = 4'd7;
            sw[5]: tone = 4'd6;
            sw[4]: tone = 4'd5;
            sw[3]: tone = 4'd4;
            sw[2]: tone = 4'd3;
            sw[1]: tone = 4'd2;
            sw[0]: tone = 4'd1;
            default: tone = 4'd0;
          endcase
        end
        assign led = sw;
        assign traffic = 3'd0;
        assign seg = {12'd0, tone};
      endmodule
    `;
    const vecs: TestVectorStep[] = [
      { cycle: 0, inputs: { rst_n: 1, key: 0, sw: 0x00 }, expect: { seg: 0 }, expectTone: 0 },
      { cycle: 1, inputs: { rst_n: 1, key: 0, sw: 0x01 }, expect: { seg: 1 }, expectTone: 1 },
      { cycle: 2, inputs: { rst_n: 1, key: 0, sw: 0x10 }, expect: { seg: 5 }, expectTone: 5 },
      { cycle: 3, inputs: { rst_n: 1, key: 0, sw: 0x80 }, expect: { seg: 8 }, expectTone: 8 },
    ];
    const res = runDeterministicSelfTest(code, vecs);
    expect(res.passed).toBe(true);
    expect(res.passedChecks).toBe(8);
  });

  it('场景 5：stepBatch(in, 128) 全屏 128 格刷新性能 < 200ms 且全格精确命中', () => {
    const code = `
      module top(
        input clk, input rst_n, input [3:0] key, input [7:0] sw,
        output [7:0] led, output [2:0] traffic, output [15:0] seg,
        output [3:0] screen_x, output [2:0] screen_y,
        output [7:0] screen_data, output [1:0] screen_cmd
      );
        reg [6:0] cnt;
        always @(posedge clk or negedge rst_n) begin
          if (!rst_n) cnt <= 7'd0;
          else cnt <= cnt + 7'd1;
        end
        assign led = {1'b0, cnt};
        assign traffic = 3'd0;
        assign seg = 16'd0;
        assign screen_x = cnt[3:0];
        assign screen_y = cnt[6:4];
        assign screen_data = 8'h20 + {1'b0, cnt[5:0]};
        assign screen_cmd = rst_n ? 2'b01 : 2'b00;
      endmodule
    `;
    const engine = createRtlEngine();
    expect(engine.compile(code).ok).toBe(true);
    engine.step({ rst_n: 0, key: 0, sw: 0 });

    const t0 = performance.now();
    const batch = engine.stepBatch!({ rst_n: 1, key: 0, sw: 0 }, 128);
    const elapsed = performance.now() - t0;

    expect(elapsed).toBeLessThan(200);
    expect(batch.sample.screenBuffer).toHaveLength(128);
    for (let i = 0; i < 128; i++) {
      expect(batch.sample.screenBuffer![i]).toBe(0x20 + (i & 0x3f));
    }
  });
});

