# Qoder 分角色开工提示词手册

每位成员克隆本仓库并在 **Qoder** 中打开后，直接把对应角色的首轮提示词粘贴给 Qoder，即可按统一契约零冲突启动开发。

---

## 一、队长（全栈统筹 + 前端 + 云函数）首轮提示词

> **使用时机**：第 1 步（M0 阶段），在 `main` 或 `feat/ui-core` 分支上运行。

```text
请先阅读仓库里的 docs/PROJECT_PLAN.md 和 docs/DATA_CONTRACTS.md。
我们要参加 2026 Qoder 高校创造力大赛（StudyHack 赛道），开发「VibeFPGA Lab：AI 驱动的可验证浏览器虚拟 FPGA 实验室」，最终部署到 Qoder Sites。

我是团队队长，负责项目初始化、数据契约冻结、全部前端界面与 Qoder Sites 云函数代理。请先帮我完成 M0 骨架搭建，严格遵守以下要求：

1. 在仓库根目录初始化 React + TypeScript + Vite + Tailwind CSS + Vitest 工程（安装 dagre、@types/dagre、mermaid、lucide-react），保留现有的 docs/、reference/ 和 .gitignore。
2. 根据 docs/DATA_CONTRACTS.md 创建冻结契约文件 src/types/contracts.ts。
3. 在 package.json 中配置好给两位队友使用的独立测试脚本：
   - "test:engine": "vitest run tests/engine.test.ts"
   - "test:agent": "vitest run tests/agent.test.ts"
4. 创建 src/services/llmClient.ts（支持 3 种模式：浏览器走 /functions/v1/agent、用户 BYOK 自填 Key、以及 Node 命令行读环境变量测试），以及 Qoder Sites 云函数骨架 functions/v1/agent.ts（从服务端环境变量读取 LLM_API_KEY，带单 IP 每日限流和 Referer 校验，绝不把密钥写到前端）。
5. 为 src/engine/index.ts 和 src/agent/index.ts 先写一份可运行的 Mock 桩实现，让前端能立刻启动预览。
6. 搭建高质感深色硬件实验室风格的三栏主工作台（TopBar、AgentPanel、GateCanvas、FpgaBoard、Waveform）：
   - FpgaBoard：可点击 KEY[3:0]、可拨动 SW[7:0]、发光 LED[7:0]、红黄绿交通灯、4 位七段数码管、CLK 频率/单步控制；
   - GateCanvas：基于 dagre 自动排版 SVG 门级电路图，支持“实时 / 0.2x 慢动作 / 单步传播”按 level 逐级发光脉冲动画，以及底部白话信号流播报条；
   - Waveform：实时逻辑分析仪波形，支持对首个出错周期画红框高亮。

请先给出实现计划，再分步创建文件并运行 npm run build 验证通过。
```

---

## 二、队友 1（硬件与仿真移植，零 Web 门槛）首轮提示词

> **使用时机**：队长合入 M0 骨架到 `main` 后，队友 1 切到 `feat/engine` 分支运行。

```text
请先阅读 docs/PROJECT_PLAN.md、docs/DATA_CONTRACTS.md 和 src/types/contracts.ts，并参考 reference/fpga2026/代码-可验证RTL闭环设计智能体/44959_rtlagent/skill/rtl-lint-rules/SKILL.md 与 rtl-interface-check/SKILL.md 中的规则思路。

我是团队里负责硬件与仿真移植的成员，只负责 src/engine/ 和 tests/engine.test.ts，不需要修改任何 React 前端界面文件。

请帮我用纯 TypeScript 从零实现以下模块，并严格满足 src/types/contracts.ts 中的 RtlEngine 接口：

1. src/engine/parser.ts：
   - 解析可综合 Verilog 教学子集（统一顶层端口 clk, rst_n, key[3:0], sw[7:0], led[7:0], traffic[2:0], seg[15:0]）；
   - 支持 wire/reg 向量、localparam/parameter、assign、always @(*) / always_comb、always @(posedge clk [or negedge rst_n])、if/else、case/default、阻塞=与非阻塞<=、位拼接{}、位切片[hi:lo]、常见位运算/算术/比较/移位/三目运算符；
   - 语法错误必须返回精确行号与中文解释。
2. src/engine/simulator.ts：
   - 周期精确仿真内核：正确区分非阻塞 <=（上升沿统一提交）和阻塞 =（组合块迭代收敛，防组合环死循环）；
   - 每拍输出 BoardOutputs 与 SignalSample 波形记录。
3. src/engine/netlist.ts：
   - 将 AST 映射为 20-40 个可读节点的教学级混合网表（INPUT/OUTPUT/AND/OR/NOT/XOR/MUX/CMP/ADD/DFF）；
   - 计算每个节点的拓扑层级 level（从 0 递增）和每拍 changed 跳变标志，并生成简明的中文白话信号流播报 narration。
4. src/engine/linter.ts：
   - 实现 6 类静态 Lint 检查：端口匹配、时序块阻塞赋值、组合块非阻塞赋值、潜在 Latch（缺 else/default）、未驱动输出/未赋值状态变量、多驱动与无符号 >>> 算术右移。
5. src/engine/selftest.ts：
   - 根据 TestVectorStep[] 运行确定性自测，抓出首个出错周期 firstFailure，并支持传入上一版通过周期计算 regressedCycles（无回退检测）。
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

我是团队里负责 AI 智能体闭环、提示词与案例库的成员，只负责 src/agent/ 和 tests/agent.test.ts，不需要修改任何 React 前端界面和云函数部署文件。请直接调用队长封装好的 LLMClient 接口（src/types/contracts.ts）。

请帮我用纯 TypeScript 实现以下模块：

1. src/agent/prompts.ts：
   - 提炼精简高效的 System Prompt 与严格 JSON Schema，分别用于 4 个动作：
     a) plan：将中文硬件需求拆解为 AgentBlueprint（行为要点、虚拟板卡引脚映射、Mermaid stateDiagram-v2 状态图）+ TestVectorStep[] 自测断言；
     b) generate：根据交接蓝图和我们支持的 Verilog 教学子集规范，生成符合虚拟板卡 top 端口的干净 Verilog 代码；
     c) repair / diagnose：结合 Lint 告警或仿真器抓出的首个出错周期波形切片，生成修复代码或三档苏格拉底教学诊断（level1Hint / level2Cause / level3PatchCode）；
     d) inject_bug：基于经典 RTL 踩坑规则，向正常代码注入一个隐蔽可复现的硬件 Bug。
   - 做好 JSON 鲁棒解析（兼容偶尔带 Markdown 代码围栏的输出，避免解析崩溃）。
2. src/agent/harness.ts：
   - 实现前端可视化 Harness 状态机：规划 -> 生成 -> 调用 RtlEngine 做 Lint 与确定性自测 -> 若失败则分流触发最多 2 轮自动修复（做无回退校验，始终保留最佳候选）；
   - 通过 onTrace(event: HarnessTraceEvent) 回调实时吐出每一步状态给前端展示。
3. src/agent/presets.ts 与 src/agent/bugClinic.ts：
   - 编写 5 个零 Token 预置经典硬件案例（智能十字路口交通灯、4 位数字密码锁、1011 序列检测器、数字秒表、四人抢答器），每个都包含完整的蓝图、Mermaid 状态图、可在本项目仿真子集下 100% 通过的 Verilog 代码、自测向量，以及至少 1-2 个「故障诊所」Bug 关卡（源自 rtl-pitfalls 真实踩坑）。
4. tests/agent.test.ts：
   - 编写 Vitest 单元测试验证：所有预置案例的 Verilog 与自测向量格式合法、JSON 解析容错正确、Mock LLM 下 Harness 闭环状态流转与无回退逻辑正常，并运行 npm run test:agent 确保全部通过。
```
