// M0 占位预置案例：队友 2 在此基础上打磨并补齐 5 个案例。
import type { PresetProject, TestVectorStep } from '../types/contracts';

const TRAFFIC_CODE = `module top (
    input         clk,
    input         rst_n,
    input  [3:0]  key,
    input  [7:0]  sw,
    output [7:0]  led,
    output [2:0]  traffic,
    output [15:0] seg
);
    localparam S_RED = 2'd0, S_GREEN = 2'd1, S_YELLOW = 2'd2;

    reg [1:0] state;
    reg [3:0] timer;
    reg       heartbeat;

    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            state     <= S_RED;
            timer     <= 4'd5;
            heartbeat <= 1'b0;
        end else begin
            heartbeat <= ~heartbeat;
            if (key[0]) begin
                state <= S_RED;
                timer <= 4'd5;
            end else if (timer == 4'd1) begin
                case (state)
                    S_RED:   begin state <= S_GREEN;  timer <= 4'd4; end
                    S_GREEN: begin state <= S_YELLOW; timer <= 4'd1; end
                    default: begin state <= S_RED;    timer <= 4'd5; end
                endcase
            end else begin
                timer <= timer - 4'd1;
            end
        end
    end

    assign traffic = key[0]             ? 3'b100 :
                     (state == S_RED)   ? 3'b100 :
                     (state == S_GREEN) ? 3'b001 : 3'b010;
    assign seg = {12'd0, timer};
    assign led = {heartbeat, sw[6:0]};
endmodule
`;

const RED = 0b100;
const GREEN = 0b001;
const YELLOW = 0b010;

function vectors(): TestVectorStep[] {
  const plan: [key: number, traffic?: number, seg?: number, note?: string][] = [
    [0, RED, 4, '复位后红灯，倒计时从 5 开始递减'],
    [0], [0], [0, RED, 1],
    [0, GREEN, 4, '红灯 5 拍后切换绿灯'],
    [0], [0], [0, GREEN, 1],
    [0, YELLOW, 1, '绿灯 4 拍后切换黄灯'],
    [0, RED, 5, '黄灯 1 拍后回到红灯'],
    [0], [0], [0], [0],
    [0, GREEN, 4],
    [1, RED, 5, '按下 KEY0 立即紧急全红并重置倒计时'],
    [0, RED, 4, '松开 KEY0 后红灯继续倒计时'],
  ];
  return [
    { cycle: 0, inputs: { rst_n: 0, key: 0, sw: 0 }, expect: { traffic: RED, seg: 5 }, note: '复位使红灯点亮' },
    ...plan.map(([key, traffic, seg, note], index): TestVectorStep => ({
      cycle: index + 1,
      inputs: { rst_n: 1, key, sw: 0 },
      expect: traffic === undefined ? undefined : { traffic, seg },
      note,
    })),
  ];
}

export const MOCK_PRESETS: PresetProject[] = [
  {
    id: 'traffic-light',
    name: '智能十字路口交通灯',
    prompt: '做一个红 5 绿 4 黄 1 的交通灯，按 KEY0 紧急全红，数码管倒计时',
    blueprint: {
      title: '智能十字路口交通灯',
      summary: '红灯 5 拍 → 绿灯 4 拍 → 黄灯 1 拍循环，KEY0 紧急全红，数码管显示剩余拍数。',
      behaviors: [
        '复位后进入红灯状态，倒计时为 5',
        '每个时钟上升沿倒计时减 1，减到 1 时切换到下一个灯色',
        '按下 KEY0 时立即强制红灯并把倒计时重置为 5',
        '数码管最低位显示当前剩余拍数',
        'LED7 为心跳灯，LED6..0 镜像拨码开关',
      ],
      pinMappings: [
        { port: 'key[0]', role: '紧急全红制动按钮' },
        { port: 'rst_n', role: '低有效复位' },
        { port: 'traffic[2]', role: '红灯' },
        { port: 'traffic[1]', role: '黄灯' },
        { port: 'traffic[0]', role: '绿灯' },
        { port: 'seg[3:0]', role: '倒计时数码管' },
        { port: 'led[7]', role: '心跳灯' },
      ],
      mermaidFsm: `stateDiagram-v2
    [*] --> RED
    RED --> GREEN: timer==1
    GREEN --> YELLOW: timer==1
    YELLOW --> RED: timer==1
    GREEN --> RED: KEY0
    YELLOW --> RED: KEY0`,
    },
    verilogCode: TRAFFIC_CODE,
    testVectors: vectors(),
    bugs: [
      {
        id: 'traffic-width-truncation',
        title: '隐蔽故障：倒计时寄存器位宽不足',
        pitfallTag: 'width-truncation',
        symptom: '红灯几乎一闪而过，数码管从不显示 5 和 4',
        buggyCode: TRAFFIC_CODE.replace('reg [3:0] timer;', 'reg [1:0] timer;'),
        diagnosis: {
          level1Hint: '数码管上最大能看到几？这个数字需要几个二进制位才能存下？',
          level2Cause: 'timer 被声明为 2 位，赋值 5 (3\'b101) 时高位被截断成 1，红灯只维持 1 拍。',
          level3PatchCode: TRAFFIC_CODE,
          highlightLine: 13,
          highlightCycle: 0,
        },
      },
      {
        id: 'traffic-yellow-duration',
        title: '隐蔽故障：黄灯时长多一拍',
        pitfallTag: 'timing-constant',
        symptom: '黄灯比规格多亮一拍，第 9 拍数码管显示 2 而不是 1，整段路口切换节奏错后',
        buggyCode: TRAFFIC_CODE.replace(
          "S_GREEN: begin state <= S_YELLOW; timer <= 4'd1; end",
          "S_GREEN: begin state <= S_YELLOW; timer <= 4'd2; end",
        ),
        diagnosis: {
          level1Hint: '需求是“红 5 绿 4 黄 1”，切到黄灯时倒计时初值应该是几？',
          level2Cause: '进入黄灯时把 timer 写成了 2，实际黄灯维持 2 拍；自测第 9 拍期望 seg=1，实际为 2。',
          level3PatchCode: TRAFFIC_CODE,
          highlightLine: 29,
          highlightCycle: 9,
        },
      },
    ],
  },
];
