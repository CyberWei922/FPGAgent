import { describe, expect, it } from 'vitest';
import {
  buildNetlist,
  createRtlEngine,
  elaborate,
  lintVerilog,
  parseVerilog,
  runDeterministicSelfTest,
  SimulationSession,
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
        output reg [7:0] led, output [2:0] traffic, output [15:0] seg
      );
        integer i;
        always @(*) begin
          led = 8'd0;
          for (i = 0; i < 1000; i = i + 1) begin
            led = led + 8'd1;
          end
        end
        assign traffic = 3'd0;
        assign seg = 16'd0;
      endmodule
    `;
    const engine = createRtlEngine();
    expect(engine.compile(code).ok).toBe(true);
    // 128 iterations capped -> 128
    expect(engine.step(DEFAULT_IN).sample.outputs.led).toBe(128);
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
