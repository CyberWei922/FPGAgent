// 队友 2：5 个零 Token 预置案例（离线可用，不消耗任何大模型额度）。
// 每个案例包含完整蓝图、Mermaid 状态图、教学子集 Verilog、自测向量与故障诊所关卡。
import type { PresetProject, TestVectorStep } from '../types/contracts';
import {
  makeBuzzerBugs,
  makePasswordLockBugs,
  makeSequenceDetectorBugs,
  makeStopwatchBugs,
} from './bugClinic';
import { MOCK_PRESETS } from './mockPresets';

// ============================================================
// 4 位数字密码锁
// ============================================================

export const PASSWORD_LOCK_CODE = `module top (
    input         clk,
    input         rst_n,
    input  [3:0]  key,
    input  [7:0]  sw,
    output [7:0]  led,
    output [2:0]  traffic,
    output [15:0] seg
);
    localparam P1 = 4'd1;
    localparam P2 = 4'd2;
    localparam P3 = 4'd3;
    localparam P4 = 4'd4;

    reg [1:0] step;
    reg       unlocked;
    reg       key0_d;

    wire key0_press;
    wire lock_press;
    assign key0_press = key[0] & ~key0_d;
    assign lock_press = key[1];

    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            step     <= 2'd0;
            unlocked <= 1'b0;
            key0_d   <= 1'b0;
        end else begin
            key0_d <= key[0];
            if (lock_press) begin
                step     <= 2'd0;
                unlocked <= 1'b0;
            end else if (key0_press) begin
                if (step == 2'd0) begin
                    if (sw[3:0] == P1) step <= 2'd1; else step <= 2'd0;
                end else if (step == 2'd1) begin
                    if (sw[3:0] == P2) step <= 2'd2; else step <= 2'd0;
                end else if (step == 2'd2) begin
                    if (sw[3:0] == P3) step <= 2'd3; else step <= 2'd0;
                end else begin
                    if (sw[3:0] == P4) begin
                        step     <= 2'd0;
                        unlocked <= 1'b1;
                    end else begin
                        step <= 2'd0;
                    end
                end
            end
        end
    end

    assign led = {7'd0, unlocked};
    assign seg = {12'd0, 2'b00, step};
    assign traffic = 3'b000;
endmodule
`;

const PASSWORD_LOCK_VECTORS: TestVectorStep[] = [
  { cycle: 0, inputs: { rst_n: 0, key: 0, sw: 0 }, expect: { led: 0, seg: 0 }, note: '复位后关闭开锁灯，进度清零' },
  { cycle: 1, inputs: { rst_n: 1, key: 0, sw: 1 }, expect: { seg: 0 }, note: '松开复位，准备输入' },
  { cycle: 2, inputs: { rst_n: 1, key: 1, sw: 1 }, expect: { seg: 1 }, note: 'KEY0 提交数字 1，进度变为 1' },
  { cycle: 3, inputs: { rst_n: 1, key: 0, sw: 2 }, expect: { seg: 1 }, note: '松开 KEY0，等待下一位' },
  { cycle: 4, inputs: { rst_n: 1, key: 1, sw: 2 }, expect: { seg: 2 }, note: '提交数字 2，进度变为 2' },
  { cycle: 5, inputs: { rst_n: 1, key: 0, sw: 3 }, expect: { seg: 2 }, note: '松开 KEY0' },
  { cycle: 6, inputs: { rst_n: 1, key: 1, sw: 3 }, expect: { seg: 3 }, note: '提交数字 3，进度变为 3' },
  { cycle: 7, inputs: { rst_n: 1, key: 0, sw: 4 }, expect: { seg: 3 }, note: '松开 KEY0' },
  { cycle: 8, inputs: { rst_n: 1, key: 1, sw: 4 }, expect: { led: 1, seg: 0 }, note: '提交数字 4，开锁且进度复位' },
  { cycle: 9, inputs: { rst_n: 1, key: 0, sw: 9 }, expect: { led: 1 }, note: '开锁后保持点亮' },
  { cycle: 10, inputs: { rst_n: 1, key: 1, sw: 9 }, expect: { led: 1 }, note: '开锁状态下错误数字不会上锁' },
  { cycle: 11, inputs: { rst_n: 1, key: 2, sw: 0 }, expect: { led: 0, seg: 0 }, note: 'KEY1 重新上锁并清空进度' },
  { cycle: 12, inputs: { rst_n: 1, key: 0, sw: 1 }, expect: { seg: 0 }, note: '重新开始输入' },
  { cycle: 13, inputs: { rst_n: 1, key: 1, sw: 1 }, expect: { seg: 1 }, note: '提交数字 1，进度变为 1' },
  { cycle: 14, inputs: { rst_n: 0, key: 0, sw: 0 }, expect: { led: 0, seg: 0 }, note: '中途复位：开锁灯熄灭且密码进度清零' },
];

const PASSWORD_LOCK_BLUEPRINT: PresetProject['blueprint'] = {
  title: '4 位数字密码锁',
  summary: '依次输入 1、2、3、4 解锁；KEY0 提交当前拨码数字，KEY1 重新上锁，LED0 指示开锁。',
  behaviors: [
    '复位后密码进度为 0，LED0 熄灭',
    'KEY0 出现上升沿时提交 sw[3:0] 当前数字',
    '数字与当前期望位一致则进度加一，不一致则进度清零',
    '第 4 位正确后 LED0 常亮，直到 KEY1 重新上锁',
    'KEY1 按下时进度清零并关闭 LED0',
  ],
  pinMappings: [
    { port: 'key[0]', role: '提交密码位' },
    { port: 'key[1]', role: '重新上锁' },
    { port: 'sw[3:0]', role: '密码数字输入' },
    { port: 'led[0]', role: '开锁指示灯' },
    { port: 'seg[3:0]', role: '已输入正确位数' },
  ],
  mermaidFsm: `stateDiagram-v2
    [*] --> STEP0
    STEP0 --> STEP1: KEY0 且数字=1
    STEP1 --> STEP2: KEY0 且数字=2
    STEP2 --> STEP3: KEY0 且数字=3
    STEP3 --> UNLOCKED: KEY0 且数字=4
    STEP0 --> STEP0: 数字错误
    STEP1 --> STEP0: 数字错误
    STEP2 --> STEP0: 数字错误
    STEP3 --> STEP0: 数字错误
    UNLOCKED --> STEP0: KEY1 重新上锁`,
};

// ============================================================
// 1011 序列检测器
// ============================================================

export const SEQUENCE_DETECTOR_CODE = `module top (
    input         clk,
    input         rst_n,
    input  [3:0]  key,
    input  [7:0]  sw,
    output [7:0]  led,
    output [2:0]  traffic,
    output [15:0] seg
);
    localparam S0 = 2'd0;
    localparam S1 = 2'd1;
    localparam S2 = 2'd2;
    localparam S3 = 2'd3;

    reg [1:0] state;
    reg       hit;
    wire      din;

    assign din = key[0];

    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            state <= S0;
            hit   <= 1'b0;
        end else begin
            hit <= 1'b0;
            case (state)
                S0: begin
                    if (din) state <= S1; else state <= S0;
                end
                S1: begin
                    if (din) state <= S1; else state <= S2;
                end
                S2: begin
                    if (din) state <= S3; else state <= S0;
                end
                S3: begin
                    if (din) begin
                        hit   <= 1'b1;
                        state <= S1;
                    end else begin
                        state <= S2;
                    end
                end
                default: state <= S0;
            endcase
        end
    end

    assign led = {7'd0, hit};
    assign seg = {12'd0, 2'b00, state};
    assign traffic = 3'b000;
endmodule
`;

const SEQUENCE_DETECTOR_VECTORS: TestVectorStep[] = [
  { cycle: 0, inputs: { rst_n: 0, key: 0, sw: 0 }, expect: { led: 0 }, note: '复位回到 S0，检测灯熄灭' },
  { cycle: 1, inputs: { rst_n: 1, key: 1, sw: 0 }, expect: { led: 0 }, note: '输入 1' },
  { cycle: 2, inputs: { rst_n: 1, key: 1, sw: 0 }, note: '输入 1（重叠前缀）' },
  { cycle: 3, inputs: { rst_n: 1, key: 0, sw: 0 }, note: '输入 0' },
  { cycle: 4, inputs: { rst_n: 1, key: 1, sw: 0 }, note: '输入 1，已匹配 101' },
  { cycle: 5, inputs: { rst_n: 1, key: 1, sw: 0 }, expect: { led: 1 }, note: '输入 1，命中 1011' },
  { cycle: 6, inputs: { rst_n: 1, key: 0, sw: 0 }, expect: { led: 0 }, note: '命中只亮一拍' },
  { cycle: 7, inputs: { rst_n: 1, key: 1, sw: 0 }, note: '输入 1，重新累积' },
  { cycle: 8, inputs: { rst_n: 1, key: 1, sw: 0 }, expect: { led: 1 }, note: '重叠命中第二次 1011' },
  { cycle: 9, inputs: { rst_n: 1, key: 0, sw: 0 }, expect: { led: 0 }, note: '再次熄灭' },
];

const SEQUENCE_DETECTOR_BLUEPRINT: PresetProject['blueprint'] = {
  title: '1011 序列检测器',
  summary: '用 KEY0 作为串行数据输入，检测 1011；命中时 LED0 亮一拍，支持重叠检测。',
  behaviors: [
    '复位后状态机回到 S0',
    '每个时钟上升沿采样 key[0] 作为串行输入',
    '识别 1011 后 hit 置 1 一拍，并保留重叠前缀重新开始',
    'LED0 指示本拍是否检测成功',
    '数码管最低位显示当前状态编号',
  ],
  pinMappings: [
    { port: 'key[0]', role: '串行数据输入' },
    { port: 'led[0]', role: '序列命中指示' },
    { port: 'seg[3:0]', role: '当前状态编号' },
  ],
  mermaidFsm: `stateDiagram-v2
    [*] --> S0
    S0 --> S0: din=0
    S0 --> S1: din=1
    S1 --> S1: din=1
    S1 --> S2: din=0
    S2 --> S3: din=1
    S2 --> S0: din=0
    S3 --> S1: din=1 / 命中
    S3 --> S2: din=0`,
};

// ============================================================
// 数字秒表
// ============================================================

export const STOPWATCH_CODE = `module top (
    input         clk,
    input         rst_n,
    input  [3:0]  key,
    input  [7:0]  sw,
    output [7:0]  led,
    output [2:0]  traffic,
    output [15:0] seg
);
    reg [3:0] d0;
    reg [3:0] d1;
    reg [3:0] d2;
    reg [3:0] d3;
    reg       running;
    reg       key0_d;
    reg       key1_d;

    wire start_press;
    wire reset_press;
    assign start_press = key[0] & ~key0_d;
    assign reset_press = key[1] & ~key1_d;

    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            d0      <= 4'd0;
            d1      <= 4'd0;
            d2      <= 4'd0;
            d3      <= 4'd0;
            running <= 1'b0;
            key0_d  <= 1'b0;
            key1_d  <= 1'b0;
        end else begin
            key0_d <= key[0];
            key1_d <= key[1];
            if (reset_press) begin
                d0 <= 4'd0;
                d1 <= 4'd0;
                d2 <= 4'd0;
                d3 <= 4'd0;
            end else if (start_press) begin
                running <= ~running;
            end else if (running) begin
                if (d0 == 4'd9) begin
                    d0 <= 4'd0;
                    if (d1 == 4'd9) begin
                        d1 <= 4'd0;
                        if (d2 == 4'd9) begin
                            d2 <= 4'd0;
                            if (d3 == 4'd9) d3 <= 4'd0; else d3 <= d3 + 4'd1;
                        end else d2 <= d2 + 4'd1;
                    end else d1 <= d1 + 4'd1;
                end else d0 <= d0 + 4'd1;
            end
        end
    end

    assign seg = {d3, d2, d1, d0};
    assign led = {7'd0, running};
    assign traffic = 3'b000;
endmodule
`;

const STOPWATCH_VECTORS: TestVectorStep[] = [
  { cycle: 0, inputs: { rst_n: 0, key: 0, sw: 0 }, expect: { led: 0, seg: 0 }, note: '复位后清零并暂停' },
  { cycle: 1, inputs: { rst_n: 1, key: 0, sw: 0 }, expect: { led: 0, seg: 0 }, note: '释放复位仍暂停' },
  { cycle: 2, inputs: { rst_n: 1, key: 1, sw: 0 }, expect: { led: 1, seg: 0 }, note: 'KEY0 启动计时' },
  { cycle: 3, inputs: { rst_n: 1, key: 0, sw: 0 }, expect: { seg: 1 }, note: '运行一拍，个位为 1' },
  { cycle: 4, inputs: { rst_n: 1, key: 0, sw: 0 }, note: '继续计时' },
  { cycle: 5, inputs: { rst_n: 1, key: 0, sw: 0 }, note: '继续计时' },
  { cycle: 6, inputs: { rst_n: 1, key: 0, sw: 0 }, note: '继续计时' },
  { cycle: 7, inputs: { rst_n: 1, key: 0, sw: 0 }, note: '继续计时' },
  { cycle: 8, inputs: { rst_n: 1, key: 0, sw: 0 }, note: '继续计时' },
  { cycle: 9, inputs: { rst_n: 1, key: 0, sw: 0 }, note: '继续计时' },
  { cycle: 10, inputs: { rst_n: 1, key: 0, sw: 0 }, note: '继续计时' },
  { cycle: 11, inputs: { rst_n: 1, key: 0, sw: 0 }, expect: { seg: 0x0009 }, note: '个位计到 9' },
  { cycle: 12, inputs: { rst_n: 1, key: 0, sw: 0 }, expect: { seg: 0x0010 }, note: '进位后显示 0010' },
  { cycle: 13, inputs: { rst_n: 1, key: 1, sw: 0 }, expect: { led: 0, seg: 0x0010 }, note: 'KEY0 暂停，显示保持' },
  { cycle: 14, inputs: { rst_n: 1, key: 0, sw: 0 }, expect: { led: 0, seg: 0x0010 }, note: '暂停期间不再计时' },
  { cycle: 15, inputs: { rst_n: 1, key: 2, sw: 0 }, expect: { seg: 0 }, note: 'KEY1 清零' },
  { cycle: 16, inputs: { rst_n: 1, key: 0, sw: 0 }, expect: { seg: 0 }, note: '清零后保持暂停' },
];

const STOPWATCH_BLUEPRINT: PresetProject['blueprint'] = {
  title: '4 位 BCD 数字秒表',
  summary: 'KEY0 启停计时，KEY1 清零；数码管以 BCD 形式显示 0000 到 9999。',
  behaviors: [
    '复位后显示 0000 且暂停',
    'KEY0 上升沿切换运行/暂停',
    'KEY1 上升沿把四位 BCD 清零',
    '运行时每拍个位加一，9 后归零并向高位进位',
    'LED0 指示当前是否在计时',
  ],
  pinMappings: [
    { port: 'key[0]', role: '启动/暂停' },
    { port: 'key[1]', role: '清零' },
    { port: 'seg', role: '四位计时显示' },
    { port: 'led[0]', role: '运行指示' },
  ],
  mermaidFsm: `stateDiagram-v2
    [*] --> PAUSED
    PAUSED --> RUNNING: KEY0
    RUNNING --> PAUSED: KEY0
    RUNNING --> RUNNING: KEY1 清零
    PAUSED --> PAUSED: KEY1 清零`,
};

// ============================================================
// 四人抢答器
// ============================================================

export const BUZZER_CODE = `module top (
    input         clk,
    input         rst_n,
    input  [3:0]  key,
    input  [7:0]  sw,
    output [7:0]  led,
    output [2:0]  traffic,
    output [15:0] seg
);
    reg       locked;
    reg [1:0] winner;

    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            locked <= 1'b0;
            winner <= 2'd0;
        end else if (!locked) begin
            if (key[3]) begin
                winner <= 2'd3;
                locked <= 1'b1;
            end else if (key[2]) begin
                winner <= 2'd2;
                locked <= 1'b1;
            end else if (key[1]) begin
                winner <= 2'd1;
                locked <= 1'b1;
            end else if (key[0]) begin
                winner <= 2'd0;
                locked <= 1'b1;
            end
        end
    end

    assign led = ~locked ? 8'd0 :
                 (winner == 2'd0) ? 8'h01 :
                 (winner == 2'd1) ? 8'h02 :
                 (winner == 2'd2) ? 8'h04 : 8'h08;
    assign seg = {12'd0, 2'b00, winner};
    assign traffic = 3'b000;
endmodule
`;

const BUZZER_VECTORS: TestVectorStep[] = [
  { cycle: 0, inputs: { rst_n: 0, key: 0, sw: 0 }, expect: { led: 0 }, note: '复位后没有获胜者' },
  { cycle: 1, inputs: { rst_n: 1, key: 2, sw: 0 }, expect: { led: 0x02 }, note: '选手 1 先按下，LED1 点亮' },
  { cycle: 2, inputs: { rst_n: 1, key: 8, sw: 0 }, expect: { led: 0x02 }, note: '选手 3 后按无效' },
  { cycle: 3, inputs: { rst_n: 1, key: 5, sw: 0 }, expect: { led: 0x02 }, note: '锁存后同时按多位也无效' },
  { cycle: 4, inputs: { rst_n: 0, key: 0, sw: 0 }, expect: { led: 0 }, note: '复位重新开始' },
  { cycle: 5, inputs: { rst_n: 1, key: 12, sw: 0 }, expect: { led: 0x08 }, note: '同时按下选手 2 和 3，编号大的获胜' },
  { cycle: 6, inputs: { rst_n: 1, key: 0, sw: 0 }, expect: { led: 0x08 }, note: '保持锁定' },
  { cycle: 7, inputs: { rst_n: 0, key: 0, sw: 0 }, expect: { led: 0 }, note: '再次复位' },
  { cycle: 8, inputs: { rst_n: 1, key: 5, sw: 0 }, expect: { led: 0x04 }, note: '同时按下选手 0 和 2，编号大的获胜' },
];

const BUZZER_BLUEPRINT: PresetProject['blueprint'] = {
  title: '四人抢答器',
  summary: '四位选手各按一个按键，先按下者被锁存并由 LED0-3 指示，复位后重新开始。',
  behaviors: [
    '复位后清除锁存与获胜者',
    '未锁存时检测 KEY0-KEY3，任意按键按下立即锁存',
    '同时按下多个按键时编号大的选手优先',
    '锁存后忽略后续按键，直到复位',
    'LED0-3 点亮对应获胜者，数码管显示获胜者编号',
  ],
  pinMappings: [
    { port: 'key[3:0]', role: '四位选手抢答按键' },
    { port: 'led[3:0]', role: '获胜指示灯' },
    { port: 'seg[3:0]', role: '获胜者编号' },
    { port: 'rst_n', role: '复位重新开始' },
  ],
  mermaidFsm: `stateDiagram-v2
    [*] --> IDLE
    IDLE --> LOCKED: 任一选手按下
    LOCKED --> IDLE: rst_n=0`,
};

// ============================================================

export const PRESETS: PresetProject[] = [
  {
    ...MOCK_PRESETS[0],
    category: '状态机与定时',
    difficulty: 'beginner',
    boardHint: 'traffic',
  },
  {
    id: 'password-lock',
    name: '4 位数字密码锁',
    prompt: '做一个 4 位数字密码锁：密码依次为 1、2、3、4，用拨码开关输入数字，KEY0 提交，KEY1 重新上锁，开锁后 LED0 常亮',
    blueprint: PASSWORD_LOCK_BLUEPRINT,
    verilogCode: PASSWORD_LOCK_CODE,
    testVectors: PASSWORD_LOCK_VECTORS,
    bugs: makePasswordLockBugs(PASSWORD_LOCK_CODE),
    category: '状态机与安全',
    difficulty: 'intermediate',
    boardHint: 'lock',
  },
  {
    id: 'sequence-detector',
    name: '1011 序列检测器',
    prompt: '用 KEY0 作为串行数据输入，检测 1011 序列，检测成功时 LED0 亮一拍，支持重叠检测',
    blueprint: SEQUENCE_DETECTOR_BLUEPRINT,
    verilogCode: SEQUENCE_DETECTOR_CODE,
    testVectors: SEQUENCE_DETECTOR_VECTORS,
    bugs: makeSequenceDetectorBugs(SEQUENCE_DETECTOR_CODE),
    category: '序列检测',
    difficulty: 'beginner',
    boardHint: 'general',
  },
  {
    id: 'stopwatch',
    name: '数字秒表',
    prompt: '做一个 4 位 BCD 数字秒表，KEY0 启停，KEY1 清零，数码管显示 0000 到 9999',
    blueprint: STOPWATCH_BLUEPRINT,
    verilogCode: STOPWATCH_CODE,
    testVectors: STOPWATCH_VECTORS,
    bugs: makeStopwatchBugs(STOPWATCH_CODE),
    category: '计数器',
    difficulty: 'intermediate',
    boardHint: 'counter',
  },
  {
    id: 'buzzer',
    name: '四人抢答器',
    prompt: '做一个四人抢答器，四位选手各按一个按键，先按下者锁定，LED0-3 指示获胜者，复位后重新开始',
    blueprint: BUZZER_BLUEPRINT,
    verilogCode: BUZZER_CODE,
    testVectors: BUZZER_VECTORS,
    bugs: makeBuzzerBugs(BUZZER_CODE),
    category: '状态机与仲裁',
    difficulty: 'intermediate',
    boardHint: 'general',
  },
];