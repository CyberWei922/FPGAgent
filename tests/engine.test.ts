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
