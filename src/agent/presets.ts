// 队友 2：5 个零 Token 预置案例（离线可用，不消耗任何大模型额度）。
// 每个案例包含完整蓝图、Mermaid 状态图、教学子集 Verilog、自测向量与故障诊所关卡。
import type { PresetProject, TestVectorStep } from '../types/contracts';
import {
  makeBuzzerBugs,
  makeSequenceDetectorBugs,
  makeSnakeBugs,
  makeStopwatchBugs,
} from './bugClinic';
import { MOCK_PRESETS } from './mockPresets';

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

// ============================================================
// 16×8 单色 OLED 贪吃蛇（V3 屏幕 + 方向键游戏案例）
// ============================================================

export const SNAKE_CODE = `module top (
    input            clk,
    input            rst_n,
    input      [3:0] key,
    input      [7:0] sw,
    output     [7:0] led,
    output     [2:0] traffic,
    output    [15:0] seg,
    output     [3:0] tone,
    output reg [3:0] screen_x,
    output reg [2:0] screen_y,
    output reg [7:0] screen_data,
    output reg [1:0] screen_cmd
);
    localparam ST_INIT = 2'd0;
    localparam ST_PLAY = 2'd1;
    localparam ST_OVER = 2'd2;

    localparam DIR_UP    = 2'd0;
    localparam DIR_DOWN  = 2'd1;
    localparam DIR_LEFT  = 2'd2;
    localparam DIR_RIGHT = 2'd3;

    localparam TILE_EMPTY = 8'h00;
    localparam TILE_HEAD  = 8'h83;
    localparam TILE_BODY  = 8'h84;
    localparam TILE_FOOD  = 8'h85;

    reg [1:0] state;
    reg [3:0] sub;
    reg [1:0] dir;
    reg [1:0] next_dir;
    reg [5:0] slen;
    reg [3:0] sx [0:31];
    reg [2:0] sy [0:31];
    reg [3:0] food_x;
    reg [2:0] food_y;
    reg [3:0] prev_hx;
    reg [2:0] prev_hy;
    reg [3:0] tail_x;
    reg [2:0] tail_y;
    reg [3:0] score_lo;
    reg [3:0] score_hi;
    reg [7:0] lfsr;
    reg       ate_r;
    reg [3:0] tone_r;

    reg [1:0] eff_dir;
    reg [3:0] cand_x;
    reg [2:0] cand_y;
    reg       hit_wall;
    reg       will_eat;
    reg       hit_self;
    reg       food_busy;

    wire [4:0] tail_idx;
    assign tail_idx = (slen > 6'd31) ? 5'd31 : (slen[4:0] - 5'd1);

    integer j;
    integer k;

    always @(*) begin
        eff_dir = next_dir;
        if (key[0] && dir != DIR_DOWN)       eff_dir = DIR_UP;
        else if (key[1] && dir != DIR_UP)    eff_dir = DIR_DOWN;
        else if (key[2] && dir != DIR_RIGHT) eff_dir = DIR_LEFT;
        else if (key[3] && dir != DIR_LEFT)  eff_dir = DIR_RIGHT;

        cand_x   = sx[0];
        cand_y   = sy[0];
        hit_wall = 1'b0;
        case (eff_dir)
            DIR_UP: begin
                if (sy[0] == 3'd0) hit_wall = 1'b1;
                else cand_y = sy[0] - 3'd1;
            end
            DIR_DOWN: begin
                if (sy[0] == 3'd7) hit_wall = 1'b1;
                else cand_y = sy[0] + 3'd1;
            end
            DIR_LEFT: begin
                if (sx[0] == 4'd0) hit_wall = 1'b1;
                else cand_x = sx[0] - 4'd1;
            end
            default: begin
                if (sx[0] == 4'd15) hit_wall = 1'b1;
                else cand_x = sx[0] + 4'd1;
            end
        endcase

        will_eat = (!hit_wall) && (cand_x == food_x) && (cand_y == food_y);

        hit_self = 1'b0;
        for (j = 0; j < 32; j = j + 1) begin
            if ((j < slen) && (will_eat || ((j + 1) < slen))) begin
                if ((sx[j] == cand_x) && (sy[j] == cand_y)) begin
                    hit_self = 1'b1;
                end
            end
        end

        food_busy = 1'b0;
        for (j = 0; j < 32; j = j + 1) begin
            if ((j < slen) && (sx[j] == food_x) && (sy[j] == food_y)) begin
                food_busy = 1'b1;
            end
        end
    end

    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            state       <= ST_INIT;
            sub         <= 4'd0;
            dir         <= DIR_RIGHT;
            next_dir    <= DIR_RIGHT;
            slen        <= 6'd3;
            sx[0]       <= 4'd6; sy[0] <= 3'd3;
            sx[1]       <= 4'd5; sy[1] <= 3'd3;
            sx[2]       <= 4'd4; sy[2] <= 3'd3;
            for (k = 3; k < 32; k = k + 1) begin
                sx[k] <= 4'd0;
                sy[k] <= 3'd0;
            end
            food_x      <= 4'd10;
            food_y      <= 3'd3;
            prev_hx     <= 4'd6;
            prev_hy     <= 3'd3;
            tail_x      <= 4'd4;
            tail_y      <= 3'd3;
            score_lo    <= 4'd0;
            score_hi    <= 4'd0;
            lfsr        <= 8'h5A;
            ate_r       <= 1'b0;
            tone_r      <= 4'd0;
            screen_x    <= 4'd0;
            screen_y    <= 3'd0;
            screen_data <= TILE_EMPTY;
            screen_cmd  <= 2'b10;
        end else begin
            lfsr       <= {lfsr[6:0], lfsr[7] ^ lfsr[5] ^ lfsr[4] ^ lfsr[3]};
            tone_r     <= 4'd0;
            screen_cmd <= 2'b00;

            case (state)
                ST_INIT: begin
                    case (sub)
                        4'd0: begin
                            screen_x    <= food_x;
                            screen_y    <= food_y;
                            screen_data <= TILE_FOOD;
                            screen_cmd  <= 2'b01;
                            sub         <= 4'd1;
                        end
                        4'd1: begin
                            screen_x    <= sx[2];
                            screen_y    <= sy[2];
                            screen_data <= TILE_BODY;
                            screen_cmd  <= 2'b01;
                            sub         <= 4'd2;
                        end
                        4'd2: begin
                            screen_x    <= sx[1];
                            screen_y    <= sy[1];
                            screen_data <= TILE_BODY;
                            screen_cmd  <= 2'b01;
                            sub         <= 4'd3;
                        end
                        default: begin
                            screen_x    <= sx[0];
                            screen_y    <= sy[0];
                            screen_data <= TILE_HEAD;
                            screen_cmd  <= 2'b01;
                            state       <= ST_PLAY;
                            sub         <= 4'd0;
                        end
                    endcase
                end

                ST_PLAY: begin
                    if (key[0] && dir != DIR_DOWN)       next_dir <= DIR_UP;
                    else if (key[1] && dir != DIR_UP)    next_dir <= DIR_DOWN;
                    else if (key[2] && dir != DIR_RIGHT) next_dir <= DIR_LEFT;
                    else if (key[3] && dir != DIR_LEFT)  next_dir <= DIR_RIGHT;

                    case (sub)
                        4'd0: begin
                            if (hit_wall || hit_self) begin
                                state      <= ST_OVER;
                                sub        <= 4'd0;
                                tone_r     <= 4'd15;
                                screen_cmd <= 2'b10;
                            end else begin
                                dir      <= eff_dir;
                                next_dir <= eff_dir;
                                prev_hx  <= sx[0];
                                prev_hy  <= sy[0];
                                tail_x   <= sx[tail_idx];
                                tail_y   <= sy[tail_idx];

                                for (k = 31; k > 0; k = k - 1) begin
                                    sx[k] <= sx[k - 1];
                                    sy[k] <= sy[k - 1];
                                end
                                sx[0] <= cand_x;
                                sy[0] <= cand_y;

                                screen_x    <= cand_x;
                                screen_y    <= cand_y;
                                screen_data <= TILE_HEAD;
                                screen_cmd  <= 2'b01;

                                if (will_eat) begin
                                    ate_r  <= 1'b1;
                                    tone_r <= 4'd14;
                                    if (slen < 6'd32) slen <= slen + 6'd1;
                                    if (score_lo == 4'd9) begin
                                        score_lo <= 4'd0;
                                        if (score_hi < 4'd9) score_hi <= score_hi + 4'd1;
                                    end else begin
                                        score_lo <= score_lo + 4'd1;
                                    end
                                    food_x <= food_x + 4'd5 + {2'd0, lfsr[1:0]};
                                    food_y <= food_y + 3'd3 + {2'd0, lfsr[2]};
                                end else begin
                                    ate_r <= 1'b0;
                                    if (eff_dir != dir) tone_r <= 4'd13;
                                end
                                sub <= 4'd1;
                            end
                        end

                        4'd1: begin
                            screen_x    <= prev_hx;
                            screen_y    <= prev_hy;
                            screen_data <= TILE_BODY;
                            screen_cmd  <= 2'b01;
                            sub         <= 4'd2;
                        end

                        4'd2: begin
                            if (ate_r) begin
                                if (food_busy) begin
                                    food_x <= food_x + 4'd3;
                                    food_y <= food_y + 3'd1;
                                end else begin
                                    screen_x    <= food_x;
                                    screen_y    <= food_y;
                                    screen_data <= TILE_FOOD;
                                    screen_cmd  <= 2'b01;
                                    ate_r       <= 1'b0;
                                    sub         <= 4'd3;
                                end
                            end else begin
                                screen_x    <= tail_x;
                                screen_y    <= tail_y;
                                screen_data <= TILE_EMPTY;
                                screen_cmd  <= 2'b01;
                                sub         <= 4'd3;
                            end
                        end

                        default: begin
                            screen_x    <= food_x;
                            screen_y    <= food_y;
                            screen_data <= TILE_FOOD;
                            screen_cmd  <= 2'b01;
                            sub         <= 4'd0;
                        end
                    endcase
                end

                default: begin
                    case (sub)
                        4'd0:  begin screen_x <= 4'd3;  screen_y <= 3'd3; screen_data <= 8'h47; screen_cmd <= 2'b01; sub <= 4'd1;  end
                        4'd1:  begin screen_x <= 4'd4;  screen_y <= 3'd3; screen_data <= 8'h41; screen_cmd <= 2'b01; sub <= 4'd2;  end
                        4'd2:  begin screen_x <= 4'd5;  screen_y <= 3'd3; screen_data <= 8'h4D; screen_cmd <= 2'b01; sub <= 4'd3;  end
                        4'd3:  begin screen_x <= 4'd6;  screen_y <= 3'd3; screen_data <= 8'h45; screen_cmd <= 2'b01; sub <= 4'd4;  end
                        4'd4:  begin screen_x <= 4'd7;  screen_y <= 3'd3; screen_data <= 8'h20; screen_cmd <= 2'b01; sub <= 4'd5;  end
                        4'd5:  begin screen_x <= 4'd8;  screen_y <= 3'd3; screen_data <= 8'h4F; screen_cmd <= 2'b01; sub <= 4'd6;  end
                        4'd6:  begin screen_x <= 4'd9;  screen_y <= 3'd3; screen_data <= 8'h56; screen_cmd <= 2'b01; sub <= 4'd7;  end
                        4'd7:  begin screen_x <= 4'd10; screen_y <= 3'd3; screen_data <= 8'h45; screen_cmd <= 2'b01; sub <= 4'd8;  end
                        4'd8:  begin screen_x <= 4'd11; screen_y <= 3'd3; screen_data <= 8'h52; screen_cmd <= 2'b01; sub <= 4'd9;  end
                        4'd9:  begin screen_x <= 4'd5;  screen_y <= 3'd5; screen_data <= 8'h52; screen_cmd <= 2'b01; sub <= 4'd10; end
                        4'd10: begin screen_x <= 4'd6;  screen_y <= 3'd5; screen_data <= 8'h3A; screen_cmd <= 2'b01; sub <= 4'd11; end
                        4'd11: begin screen_x <= 4'd7;  screen_y <= 3'd5; screen_data <= 8'h52; screen_cmd <= 2'b01; sub <= 4'd12; end
                        4'd12: begin screen_x <= 4'd8;  screen_y <= 3'd5; screen_data <= 8'h53; screen_cmd <= 2'b01; sub <= 4'd13; end
                        4'd13: begin screen_x <= 4'd9;  screen_y <= 3'd5; screen_data <= 8'h54; screen_cmd <= 2'b01; sub <= 4'd14; end
                        default: begin screen_cmd <= 2'b00; end
                    endcase
                end
            endcase
        end
    end

    assign led     = {state == ST_OVER, 5'd0, ate_r, state == ST_PLAY};
    assign traffic = (state == ST_OVER) ? 3'b100 : ((state == ST_PLAY) ? 3'b001 : 3'b010);
    assign seg     = {8'd0, score_hi, score_lo};
    assign tone    = tone_r;
endmodule
`;

const SNAKE_VECTORS: TestVectorStep[] = [
  {
    cycle: 0,
    inputs: { rst_n: 0, key: 0, sw: 0 },
    expect: { led: 0, seg: 0 },
    expectScreen: [{ x: 6, y: 3, code: 0x00 }],
    note: '复位清屏并初始化蛇身与食物位置',
  },
  { cycle: 1, inputs: { rst_n: 1, key: 0, sw: 0 }, expectScreen: [{ x: 10, y: 3, code: 0x85 }], note: '绘制初始食物 (10,3)' },
  { cycle: 2, inputs: { rst_n: 1, key: 0, sw: 0 }, expectScreen: [{ x: 4, y: 3, code: 0x84 }], note: '绘制初始蛇尾 (4,3)' },
  { cycle: 3, inputs: { rst_n: 1, key: 0, sw: 0 }, expectScreen: [{ x: 5, y: 3, code: 0x84 }], note: '绘制初始蛇身 (5,3)' },
  {
    cycle: 4,
    inputs: { rst_n: 1, key: 0, sw: 0 },
    expect: { led: 1, seg: 0 },
    expectScreen: [
      { x: 6, y: 3, code: 0x83 },
      { x: 5, y: 3, code: 0x84 },
      { x: 4, y: 3, code: 0x84 },
      { x: 10, y: 3, code: 0x85 },
    ],
    note: '绘制初始蛇头 (6,3)，进入运行态',
  },
  { cycle: 5, inputs: { rst_n: 1, key: 0, sw: 0 }, expectScreen: [{ x: 7, y: 3, code: 0x83 }], note: '向右前进一步，蛇头抵达 (7,3)' },
  { cycle: 6, inputs: { rst_n: 1, key: 0, sw: 0 }, expectScreen: [{ x: 6, y: 3, code: 0x84 }], note: '原蛇头 (6,3) 转为蛇身' },
  { cycle: 7, inputs: { rst_n: 1, key: 0, sw: 0 }, expectScreen: [{ x: 4, y: 3, code: 0x00 }], note: '擦除旧蛇尾 (4,3)' },
  { cycle: 8, inputs: { rst_n: 1, key: 0, sw: 0 }, note: '完成第 1 步移动节拍' },
  { cycle: 9, inputs: { rst_n: 1, key: 0, sw: 0 }, note: '第 2 步：蛇头抵达 (8,3)' },
  { cycle: 10, inputs: { rst_n: 1, key: 0, sw: 0 }, note: '更新蛇身' },
  { cycle: 11, inputs: { rst_n: 1, key: 0, sw: 0 }, note: '擦除旧尾 (5,3)' },
  { cycle: 12, inputs: { rst_n: 1, key: 0, sw: 0 }, note: '完成第 2 步' },
  { cycle: 13, inputs: { rst_n: 1, key: 0, sw: 0 }, note: '第 3 步：蛇头抵达 (9,3)' },
  { cycle: 14, inputs: { rst_n: 1, key: 0, sw: 0 }, note: '更新蛇身' },
  { cycle: 15, inputs: { rst_n: 1, key: 0, sw: 0 }, note: '擦除旧尾 (6,3)' },
  { cycle: 16, inputs: { rst_n: 1, key: 0, sw: 0 }, note: '完成第 3 步' },
  {
    cycle: 17,
    inputs: { rst_n: 1, key: 0, sw: 0 },
    expect: { seg: 1 },
    expectTone: 14,
    expectScreen: [{ x: 10, y: 3, code: 0x83 }],
    note: '蛇头吃到食物 (10,3)：得分 +1 并触发得分音',
  },
  { cycle: 18, inputs: { rst_n: 1, key: 0, sw: 0 }, expectScreen: [{ x: 9, y: 3, code: 0x84 }], note: '蛇身增长保留旧尾 (7,3)' },
  { cycle: 19, inputs: { rst_n: 1, key: 0, sw: 0 }, expectScreen: [{ x: 7, y: 3, code: 0x84 }], note: '刷新新食物并保持 4 节蛇身' },
  { cycle: 20, inputs: { rst_n: 1, key: 2, sw: 0 }, note: '按下 KEY1 (S / ↓) 锁存向下转向' },
  {
    cycle: 21,
    inputs: { rst_n: 1, key: 0, sw: 0 },
    expectScreen: [{ x: 10, y: 4, code: 0x83 }],
    note: '按方向键成功向下拐弯至 (10,4)',
  },
  { cycle: 22, inputs: { rst_n: 1, key: 0, sw: 0 }, expectScreen: [{ x: 10, y: 3, code: 0x84 }], note: '拐点转为蛇身' },
  { cycle: 23, inputs: { rst_n: 1, key: 0, sw: 0 }, expectScreen: [{ x: 7, y: 3, code: 0x00 }], note: '擦除新尾 (7,3)' },
];

const SNAKE_BLUEPRINT: PresetProject['blueprint'] = {
  title: '16×8 OLED 贪吃蛇',
  summary: '在 16×8 单色 OLED 屏上运行完整贪吃蛇：KEY0–KEY3（WASD / 方向键）控制上下左右，吃食物增长并计分，撞墙或撞身进入结束画面。',
  behaviors: [
    '复位后清屏并在 (6,3) 初始化 3 节蛇身，(10,3) 放置初始食物，默认向右移动',
    '每拍持续采样 KEY0(上/W)、KEY1(下/S)、KEY2(左/A)、KEY3(右/D) 锁存下一方向，禁止 180° 直接掉头',
    '采用增量显存绘制（仅刷新新蛇头、旧蛇头与旧蛇尾），在 16×8 单色 OLED 上零闪烁流畅运行',
    '蛇头到达食物坐标时长度加 1、数码管 BCD 得分递增并由 LFSR 避开蛇身生成新食物',
    '撞到屏幕边界或自身时清屏显示 GAME OVER，按 RST (R) 立即重开一局',
  ],
  pinMappings: [
    { port: 'key[0]', role: '向上转向（W / ↑）' },
    { port: 'key[1]', role: '向下转向（S / ↓）' },
    { port: 'key[2]', role: '向左转向（A / ←）' },
    { port: 'key[3]', role: '向右转向（D / →）' },
    { port: 'rst_n', role: '硬件复位 / 重新开始（R）' },
    { port: 'screen_x/y/data/cmd', role: '16×8 单色 OLED 显存写入与清屏端口' },
    { port: 'seg[7:0]', role: '2 位 BCD 当前得分' },
    { port: 'tone[3:0]', role: '转向、吃食物与撞墙提示音' },
  ],
  mermaidFsm: `stateDiagram-v2
    [*] --> ST_INIT
    ST_INIT --> ST_PLAY: 初始画面绘制完成
    ST_PLAY --> ST_PLAY: 移动 / 转向 / 吃食物
    ST_PLAY --> ST_OVER: 撞墙或撞到自身
    ST_OVER --> ST_INIT: rst_n=0 复位重开`,
};

export const PRESETS: PresetProject[] = [
  {
    ...MOCK_PRESETS[0],
    category: '状态机与定时',
    difficulty: 'beginner',
    boardHint: 'traffic',
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
  {
    id: 'snake',
    name: 'OLED 贪吃蛇',
    prompt: '在 16×8 单色 OLED 屏幕上做一个贪吃蛇游戏，用 KEY0-KEY3（WASD / 方向键）控制上下左右移动，吃食物变长并记分，撞墙显示 GAME OVER',
    blueprint: SNAKE_BLUEPRINT,
    verilogCode: SNAKE_CODE,
    testVectors: SNAKE_VECTORS,
    bugs: makeSnakeBugs(SNAKE_CODE),
    category: 'OLED 游戏',
    difficulty: 'intermediate',
    boardHint: 'general',
    boardProfileId: 'arcade',
    requiredPeripherals: ['led', 'seg', 'screen', 'tone'],
  },
];