# Qoder 分角色开工提示词手册

每位成员克隆本仓库并在 **Qoder** 中打开后，直接把对应角色的首轮提示词粘贴给 Qoder，即可按统一契约零冲突启动开发。

---

## 一、队长（全栈统筹 + 前端 + 云函数）开工提示词

> **使用时机**：M0 骨架在 `main` 验收后，从 `main` 切到 `feat/ui-core` 继续工作台开发。

```text
请先阅读 docs/PROJECT_PLAN.md、docs/DATA_CONTRACTS.md、src/types/contracts.ts 和现有 src/App.tsx。项目为 2026 Qoder 高校创造力大赛 StudyHack 赛道的 VibeFPGA Lab。

我是队长，负责契约、前端和 Qoder Sites 云函数。基于现有 M0 项目推进 M1，按以下接口交接：

1. 板卡与 Harness 分别使用 createRtlEngine() 的实例。工作台通过 createAgentRuntime({ llm: createBrowserLLMClient(), engine }) 获取案例和生成运行时，订阅 onTrace 展示步骤。
2. 在现有 TopBar、AgentPanel、GateCanvas、VirtualBoard 和 Waveform 上继续实现逐层传播、板卡与反例交互。M1 继续使用 Mock 工厂，等队友实现后按同一入口联调。
3. 维护 src/services/llmClient.ts 的三个调用模式与 LLMError。保留 functions/index.ts 作为 Qoder Sites Edge Function 入口，浏览器同源调用 /functions/v1/app/agent。服务端 Key 使用 LLM_API_KEY。
4. 提交前运行 npm run build、npm run test:platform 和 npm test，并在浏览器验证交通灯、KEY0、拨码和单步操作。
```

---

## 二、队友 1（硬件与仿真移植，零 Web 门槛）首轮提示词

> **使用时机**：队长合入 M0 骨架到 `main` 后，队友 1 切到 `feat/engine` 分支运行。

```text
请先阅读 docs/PROJECT_PLAN.md、docs/DATA_CONTRACTS.md 和 src/types/contracts.ts，并参考 reference/fpga2026/代码-可验证RTL闭环设计智能体/44959_rtlagent/skill/rtl-lint-rules/SKILL.md 与 rtl-interface-check/SKILL.md 中的规则思路。

我是团队里负责硬件与仿真移植的成员，只负责 src/engine/ 和 tests/engine.test.ts，不需要修改任何 React 前端界面文件。

请用纯 TypeScript 实现以下模块。保留 src/engine/index.ts 的 createRtlEngine: RtlEngineFactory 导出，将工厂切换到真实 RtlEngine。队长和 Harness 依赖这个同名入口。

1. src/engine/parser.ts：
   - 解析可综合 Verilog 教学子集（统一顶层端口 clk, rst_n, key[3:0], sw[7:0], led[7:0], traffic[2:0], seg[15:0]）；
   - 支持 wire/reg 向量、localparam/parameter、assign、always @(*) / always_comb、always @(posedge clk [or negedge rst_n])、if/else、case/default、阻塞=与非阻塞<=、位拼接{}、位切片[hi:lo]、常见位运算/算术/比较/移位/三目运算符；
   - 语法错误必须返回精确行号与中文解释。
2. src/engine/simulator.ts：
   - 周期精确仿真内核：正确区分非阻塞 <=（上升沿统一提交）和阻塞 =（组合块迭代收敛，防组合环死循环）；
   - 每次 step(inputs) 处理一个上升沿，返回 { sample: SignalSample, netlist: NetlistGraph }，从周期 0 起算。reset() 后重新计数。
3. src/engine/netlist.ts：
   - 将 AST 映射为 20-40 个可读节点的教学级混合网表（INPUT/OUTPUT/AND/OR/NOT/XOR/MUX/CMP/ADD/DFF）；
   - 计算每个节点的拓扑层级 level（从 0 递增）和每拍 changed 跳变标志，并生成简明的中文白话信号流播报 narration。
4. src/engine/linter.ts：
   - 实现 6 类静态 Lint 检查：端口匹配、时序块阻塞赋值、组合块非阻塞赋值、潜在 Latch（缺 else/default）、未驱动输出/未赋值状态变量、多驱动与无符号 >>> 算术右移。
5. src/engine/selftest.ts：
   - 使用独立仿真状态按 TestVectorStep[] 执行自测。cycle 等于数组下标，时序用例显式驱动 rst_n=0。每拍仅比对 expect 提供的字段，输出 firstFailure、passedCycles，并用 previousPassedCycles 计算 regressedCycles。
6. tests/engine.test.ts：
   - 编写至少 50 条 Vitest 单元测试，覆盖交通灯、密码锁、序列检测器、秒表、组合逻辑、6 类 Lint 报错、反例定位与无回退检测，并运行 npm run test:engine 确保全部通过。
```

---

## 三、队友 2（AI 调用、提示词与案例/故障库，零 Web 门槛）首轮提示词

> **使用时机**：队长合入 M0 骨架到 `main` 后，队友 2 切到 `feat/agent` 分支运行。

```text
请先阅读 docs/PROJECT_PLAN.md、docs/DATA_CONTRACTS.md 和 src/types/contracts.ts，并查阅以下参考资产提炼规则（注意：不要搬运旧代码，只提炼方法论与规则精华）：
- reference/fpga2026/代码-可验证RTL闭环设计智能体/44959_rtlagent/REPORT.md（重点看第 2 节 Harness 闭环和第 4 节自我验证与修复策略）
- reference/fpga2026/代码-可验证RTL闭环设计智能体/44959_rtlagent/skill/ 下的 6 个 sv-* 规范和 rtl-pitfalls/SKILL.md

我负责 AI 智能体闭环、提示词与案例库，代码范围为 src/agent/ 和 tests/agent.test.ts。保留 src/agent/index.ts 的 createAgentRuntime: AgentRuntimeFactory 导出，接收 { llm, engine } 注入，按 AgentRuntime 实现 runHarness、presets、diagnose 和 injectBug。测试注入按 action 返回数据的 Mock LLM 和满足 RtlEngine 的替身，便于和队友 1 并行。

请帮我用纯 TypeScript 实现以下模块：

1. src/agent/prompts.ts：
   - 提炼精简高效的 System Prompt 与严格 JSON Schema，分别用于 4 个动作：
     a) plan：将中文硬件需求拆解为 AgentBlueprint（行为要点、虚拟板卡引脚映射、Mermaid stateDiagram-v2 状态图）+ TestVectorStep[] 自测断言；
     b) generate：根据交接蓝图和我们支持的 Verilog 教学子集规范，生成符合虚拟板卡 top 端口的干净 Verilog 代码；
     c) repair / diagnose：结合 Lint 告警或仿真器抓出的首个出错周期波形切片，生成修复代码或三档苏格拉底教学诊断（level1Hint / level2Cause / level3PatchCode）；
     d) inject_bug：基于经典 RTL 踩坑规则，向正常代码注入一个隐蔽可复现的硬件 Bug。
   - 做好 JSON 鲁棒解析（兼容偶尔带 Markdown 代码围栏的输出，避免解析崩溃）。
2. src/agent/harness.ts：
   - 使用 llm.chat({ action, messages, jsonMode, signal }) 调模型。保留 LLMError.code 供 UI 处理额度和取消，取消后停止后续步骤。
   - 规划 -> 生成 -> 调用注入的 RtlEngine 编译与自测 -> 失败时最多 2 轮修复。沿用同一组测试向量，将最佳候选的 passedCycles 传给下一候选的 runSelfTest，用 regressedCycles 做无回退判断。
   - 通过 onTrace(event: HarnessTraceEvent) 发送阶段进度，返回 HarnessResult，包含最佳候选、issues、适用时的 selfTest 和 repairRounds。
3. src/agent/presets.ts 与 src/agent/bugClinic.ts：
   - 编写 5 个零 Token 预置经典硬件案例（智能十字路口交通灯、4 位数字密码锁、1011 序列检测器、数字秒表、四人抢答器），每个都包含完整的蓝图、Mermaid 状态图、可在本项目仿真子集下 100% 通过的 Verilog 代码、自测向量，以及至少 1-2 个「故障诊所」Bug 关卡（源自 rtl-pitfalls 真实踩坑）。
4. tests/agent.test.ts：
   - 编写 Vitest 单元测试验证：所有预置案例的 Verilog 与自测向量格式合法、JSON 解析容错正确、Mock LLM 下 Harness 闭环状态流转与无回退逻辑正常，并运行 npm run test:agent 确保全部通过。
```
