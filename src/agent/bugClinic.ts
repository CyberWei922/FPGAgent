// 队友 2：故障诊所题库（源自 rtl-pitfalls 的真实硬件踩坑）与 LLM 故障注入。
// 每个预置案例挂 1-2 个故障关卡：symptom 可在板卡/波形上观察，三档苏格拉底提示 + 标准修复代码。
import type { BugClinicCase, LLMClient } from '../types/contracts';
import { buildInjectBugMessages, parseBugCaseResponse } from './prompts';

function replaceOnce(code: string, from: string, to: string, label: string): string {
  if (!code.includes(from)) {
    throw new Error(`故障模板失效（${label}）：在固定代码中找不到目标片段，请同步更新 bugClinic.ts`);
  }
  return code.replace(from, to);
}

function lineOf(code: string, needle: string): number {
  const index = code.indexOf(needle);
  return index < 0 ? 1 : code.slice(0, index).split('\n').length;
}

/** 4 位密码锁：复位分支漏掉状态寄存器的复位。 */
export function makePasswordLockBugs(fixedCode: string): BugClinicCase[] {
  const from = `        if (!rst_n) begin
            step     <= 2'd0;
            unlocked <= 1'b0;
            key0_d   <= 1'b0;
        end else begin`;
  const to = `        if (!rst_n) begin
            key0_d   <= 1'b0;
        end else begin`;
  return [
    {
      id: 'password-missing-reset',
      title: '隐蔽故障：复位漏掉密码进度寄存器',
      pitfallTag: 'missing-reset',
      symptom: '上电后数码管随机显示进度，偶尔一上电就亮起开锁指示灯',
      buggyCode: replaceOnce(fixedCode, from, to, 'password-missing-reset'),
      diagnosis: {
        level1Hint: '复位那一拍，所有需要记住状态的寄存器都回到已知值了吗？',
        level2Cause:
          '复位分支只清了 key0_d，step 与 unlocked 没有复位：仿真初值不确定，上板后进度和开锁状态可能随机。',
        level3PatchCode: fixedCode,
        highlightLine: lineOf(fixedCode, 'if (!rst_n)'),
        highlightCycle: 0,
      },
    },
  ];
}

/** 1011 序列检测器：状态机转移写错导致漏检（重叠前缀丢失）。 */
export function makeSequenceDetectorBugs(fixedCode: string): BugClinicCase[] {
  return [
    {
      id: 'sequence-fsm-transition',
      title: '隐蔽故障：状态机漏掉重叠前缀',
      pitfallTag: 'fsm-transition',
      symptom: '连续输入 1、1 之后，再输入 0、1、1 检测灯不亮；从单个 1 开始的序列才有机会命中',
      buggyCode: replaceOnce(
        fixedCode,
        'if (din) state <= S1; else state <= S2;',
        'if (din) state <= S0; else state <= S2;',
        'sequence-fsm-transition',
      ),
      diagnosis: {
        level1Hint: '已经收到一个 1 之后又收到 1，最长的“已匹配后缀”还保留着吗？',
        level2Cause:
          'S1（已收到一个 1）遇到 din=1 时错误回到 S0，而正确做法是保持 S1；否则以 "11" 开头的 1011 重叠序列会被漏检。',
        level3PatchCode: fixedCode,
        highlightLine: lineOf(fixedCode, 'S1: begin'),
      },
    },
    {
      id: 'sequence-hit-sticky',
      title: '隐蔽故障：命中标志只置位不清零',
      pitfallTag: 'missing-clear',
      symptom: '第一次检测到 1011 后 LED 一直亮着，后续输入任何序列都无法熄灭',
      buggyCode: replaceOnce(
        fixedCode,
        `        end else begin
            hit <= 1'b0;
            case (state)`,
        `        end else begin
            case (state)`,
        'sequence-hit-sticky',
      ),
      diagnosis: {
        level1Hint: '这个 LED 表示“本拍命中”，它每一拍都应该被重新计算吗？',
        level2Cause: '正常分支缺少 hit <= 1\'b0 清零，检测到一次后 hit 恒为 1，指示灯常亮。',
        level3PatchCode: fixedCode,
        highlightLine: lineOf(fixedCode, 'case (state)'),
        highlightCycle: 5,
      },
    },
  ];
}

/** 数字秒表：BCD 进位链断裂，十位不增长。 */
export function makeStopwatchBugs(fixedCode: string): BugClinicCase[] {
  return [
    {
      id: 'stopwatch-bcd-carry',
      title: '隐蔽故障：BCD 进位链缺失',
      pitfallTag: 'bcd-carry',
      symptom: '计时从 0009 直接回到 0000，十位数字永远不增长',
      buggyCode: replaceOnce(fixedCode, "end else d1 <= d1 + 4'd1;", 'end else d1 <= d1;', 'stopwatch-bcd-carry'),
      diagnosis: {
        level1Hint: '个位从 9 回到 0 的那一拍，应该向哪一位进位？',
        level2Cause: '个位清零时没有让十位加 1，BCD 进位链断裂，计时永远停在个位。',
        level3PatchCode: fixedCode,
        highlightLine: lineOf(fixedCode, "d1 <= d1 + 4'd1"),
        highlightCycle: 12,
      },
    },
  ];
}

/** 四人抢答器：锁存条件被删掉，后按者会覆盖先按者。 */
export function makeBuzzerBugs(fixedCode: string): BugClinicCase[] {
  return [
    {
      id: 'buzzer-missing-lock',
      title: '隐蔽故障：抢答结果没有锁存',
      pitfallTag: 'missing-lock',
      symptom: '先按下的选手灯会被后按下的选手覆盖，无法裁定第一个按下的人',
      buggyCode: replaceOnce(fixedCode, 'end else if (!locked) begin', 'end else begin', 'buzzer-missing-lock'),
      diagnosis: {
        level1Hint: '抢答器“先到先得”的语义，依赖哪个条件一直保持？',
        level2Cause: '分支条件删掉了 !locked 判断，锁存后仍继续仲裁，后按下的按键会改写 winner。',
        level3PatchCode: fixedCode,
        highlightLine: lineOf(fixedCode, 'if (!locked)'),
      },
    },
  ];
}

/** 运行时故障注入：交给大模型生成一个隐蔽 Bug（inject_bug 动作）。 */
export async function requestInjectedBug(llm: LLMClient, code: string): Promise<BugClinicCase> {
  const response = await llm.chat({
    action: 'inject_bug',
    messages: buildInjectBugMessages(code),
    jsonMode: true,
  });
  return parseBugCaseResponse(response.text, code);
}