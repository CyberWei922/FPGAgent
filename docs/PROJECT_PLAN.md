# VibeFPGA Lab 项目总规划书

> 适用赛事：**2026 Qoder 高校创造力大赛**（天池地址：`https://tianchi.aliyun.com/competition/entrance/532536`）  
> 参赛赛道：**StudyHack 学习科研**  
> 协作仓库：`https://github.com/CyberWei922/qoderationability`

---

## 1. 项目定位、核心痛点与最终整体预期

### 1.1 我们解决什么真实问题？
微电子、集成电路、电子信息、自动化及计算机专业学生在学习《数字逻辑》《FPGA 与 Verilog 设计》时，普遍卡在四个现实痛点：
1. **硬件与环境门槛极高**：FPGA 开发板价格贵、实验室排期紧，Vivado 安装包动辄 50GB+，macOS 学生甚至无法原生安装。
2. **“能编译但波形不对”的黑盒挫败感**：初学者最难掌握的不是语法，而是时序逻辑、阻塞/非阻塞赋值、Latch 隐患以及 Testbench 编写。
3. **传统聊天 AI 教硬件会胡说八道**：通用大模型看不到代码实际运行出的波形与寄存器状态，容易在改 Bug 时“修好一处、改坏另一处”。
4. **外行与入门者难以建立电路直觉**：面对几十行 Verilog 代码，初学者看不到“按下开发板按键后，电信号究竟如何一步步流过逻辑门并点亮 LED”。

### 1.2 产品形态与最终整体预期
我们打造一个**打开即用、免登录、免填 API Key** 的浏览器端 **「AI 虚拟 FPGA 实验室（VibeFPGA Lab）」**，核心差异化在于将往届验证有效的 **Harness 可验证智能体闭环** 与 **慢动作门级信号流可视化** 融合到同一张网页工作台：

1. **一句话造硬件（Spec-to-Board）**：用户输入一句自然语言（如“做一个红 5 绿 4 黄 1 的交通灯，按 KEY0 紧急全红，数码管倒计时”），页面透明展示智能体如何先拆解**设计蓝图 + 引脚表 + 状态转移图**，再生成 Verilog，并在浏览器内自动跑完 **Lint 体检 + 确定性自测 + 失败自动修复**，验证通过后直接“烧录”到虚拟板卡上运行。
2. **慢动作看信号穿过逻辑门（视觉核心杀手锏）**：浏览器实时将代码映射为 20–40 个可读节点的**教学级门电路结构图**。用户可切换 **`实时` / `0.2x 慢动作` / `单步传播`**，按下按键后，高电平发光脉冲会沿着导线逐级穿过非门、与门、选择器、触发器并点亮红灯，底部同步用白话播报信号路径——让完全不懂 Verilog 的评委 10 秒内看懂电路原理。
3. **真仿真、真外设、真体检**：右侧虚拟 FPGA 开发板配备可点击按键、可拨动开关、LED、交通灯、4 位七段数码管和实时波形示波器；所有代码修改毫秒级触发静态 Lint 体检、首个出错周期红框标注和无回退验证。
4. **AI 硬件故障诊所（Bug Clinic）**：把原项目“变异体负对照（Mutation Testing）”思维反向用于教学——一键向当前正常电路注入典型真实硬件 Bug（阻塞赋值错用、忘写复位、锁存器、位宽截断等），板卡立刻出现异常现象，由“会看示波器的 AI 助教”按三档提示引导学生排错。

### 1.3 面向评委的 30 秒黄金体验路径
- **0 秒（开箱即亮）**：首页默认加载“智能交通灯”预置案例（零 Token 秒开），右侧板卡红绿灯与数码管已在运行，评委点一下 `KEY0` 立刻触发紧急全红。
- **10 秒（慢动作顿悟）**：拨动速度滑块到 `0.2x 慢动作` 或点击 `单步传播`，再次按下 `KEY0`，中间画布逐级亮起发光脉冲并播报信号流向。
- **20 秒（实时 AI 创造）**：在顶部输入一句新需求，观看左栏透明智能体完成“蓝图 → 代码 → 本地自测修复 → 上板亮灯 + 重绘门级图”。
- **30 秒（教学深度）**：点击 `故障诊所`，体验“故障注入 → 波形首个出错周期标红 → 苏格拉底引导修复 → 无回退绿灯通过”。

### 1.4 最终验收质量目标
- 浏览器仿真 + Lint 引擎通过 **≥ 50 条自动化单元测试**（覆盖组合逻辑、时序逻辑、FSM、位宽、6 类 Lint 与反例定位），测试结果写入参赛帖作为工程可信度证据。
- 内置 **4–5 个零 Token 经典预置案例**（交通灯、4 位密码锁、序列检测器、数字秒表、四人抢答器），断网或额度耗尽时全部核心仿真与板卡交互依然 100% 可用。
- 公网部署至 **Qoder Sites**，无痕浏览器与移动端核验无报错、免填 Key 即可直接触发实时 AI 生成与诊断。
- 页面与帖子清晰声明 **Known Limitations（明确支持的可综合 Verilog 教学子集，不做布局布线与门级物理延迟）**。

---

## 2. 整体系统架构与具体实现方案

### 2.1 三栏工作台界面布局

```text
┌───────────────────────────────────────────────────────────────────────────────────┐
│ [输入框] 用一句话描述想做的硬件电路（如：带紧急制动按钮的交通灯）      [AI 生成]   │
│ 预置案例：[交通灯][密码锁][序列检测器][秒表]  速度：[实时|0.2x|单步] [故障诊所][设置]│
├───────────────────────┬───────────────────────────────┬───────────────────────────┤
│ 左栏：透明智能体与代码 │ 中栏（主舞台）：动态门级信号图  │ 右栏：虚拟 FPGA 开发板     │
│ [Tab1 蓝图]           │                               │  LED[7:0] / 交通灯组       │
│  • 行为要点与引脚表   │  输入端口 ──► 组合逻辑门 ──►  │  4 位七段数码管            │
│  • Mermaid 状态转移图 │  DFF 触发器 ──► 输出外设      │  KEY[3:0] / SW[7:0] / CLK  │
│ [Tab2 自测与AI诊断]   │                               ├───────────────────────────┤
│  • Lint/自测绿灯流水线│  • dagre 从左到右自动排布     │ 迷你波形示波器             │
│  • 苏格拉底三档引导   │  • SVG 高电平发光脉冲逐级传播 │  • 实时时钟/输入/输出波形  │
│ [Tab3 Verilog 代码]   │  • 底部白话信号流播报条       │  • 红框标出首个出错周期    │
└───────────────────────┴───────────────────────────────┴───────────────────────────┘
```

### 2.2 统一虚拟开发板顶层硬件接口（强制规范）
为了消除引脚错配并降低解析复杂度，所有预置工程与 AI 生成的 Verilog 统一对接同一套虚拟板卡顶层端口：

```verilog
module top (
    input         clk,      // 板载时钟（前端可控频率 / 暂停 / 单步）
    input         rst_n,    // 低有效同步/异步复位按键
    input  [3:0]  key,      // 4 个板载按键（按下=1，松开=0）
    input  [7:0]  sw,       // 8 个拨码开关
    output [7:0]  led,      // 8 颗板载 LED
    output [2:0]  traffic,  // [2]=红灯, [1]=黄灯, [0]=绿灯
    output [15:0] seg       // 4 位七段数码管，每 4 位对应 1 个十六进制/BCD 数字
);
```

### 2.3 五大核心模块技术实现

#### 模块 1：浏览器纯 TS 可综合 Verilog 子集仿真引擎（`src/engine/parser.ts`, `simulator.ts`）
- **支持子集（明确边界）**：
  - 模块声明与端口、`wire` / `reg`（含向量位宽如 `[7:0]`）、`localparam` / `parameter`；
  - 连续赋值 `assign`；
  - 组合块 `always @(*)` / `always_comb`（支持 `if / else if / else`、`case / default`、阻塞赋值 `=`）；
  - 时序块 `always @(posedge clk)` / `always @(posedge clk or negedge rst_n)`（支持非阻塞赋值 `<=`）；
  - 运算符：算术（`+ - *`）、逻辑/按位（`& | ^ ~ ! && ||`）、比较（`== != < <= > >=`）、移位（`<< >> >>>`）、三目 `? :`、位拼接 `{a, b}` 与位切片 `sig[hi:lo]`；
  - 字面量：`4'b1010`、`8'hFF`、`3'd5`、十进制整数。
- **求值机制**：
  - 每个时钟拍 `step(inputs)` 执行：采样输入 → 计算时序块右值并暂存下一拍值 → 统一提交非阻塞赋值（保证并发语义正确）→ 组合块与 `assign` 迭代收敛（上限 16 轮，超限报组合环警告）→ 输出 `BoardOutputs` 并写入波形环形缓冲。

#### 模块 2：教学级 RTL-门混合网表与慢动作信号流（`src/engine/netlist.ts` + `src/components/GateCanvas.tsx`）
- **为什么不展平为全门级？** 32 位计数器展平成基础门会产生数千节点，评委根本看不懂。
- **教学级混合抽象**：将 AST 节点映射为 **20–40 个可读硬件积木**：
  - 端口节点：`INPUT`（KEY/SW/RST）、`OUTPUT`（LED/TRAFFIC/SEG）
  - 组合逻辑门：`AND`、`OR`、`NOT`、`XOR`、`MUX`、`CMP`、`ADD`
  - 时序积木：`DFF`（寄存器/状态机触发器）
- **拓扑分层与慢动作动画**：
  - `netlist.ts` 对每条连线和节点计算拓扑层级 `level`（`0` 为输入端口，依次向右递增），并输出每个节点当前拍的逻辑值 `value` 及是否发生跳变 `changed`。
  - `GateCanvas.tsx` 用 `dagre` 自动做 `rankdir: 'LR'` 排布；在 `0.2x 慢动作` 或 `单步传播` 模式下，按 `level = 0 → maxLevel` 逐层激活 SVG 导线发光脉冲动画，并结合当前跳变路径生成底部一行中文白话播报。

#### 模块 3：前端静态 Lint 体检 & 确定性自测（`src/engine/linter.ts`, `selftest.ts`）
- **静态 Lint（直接移植原项目 `rtl-lint-rules` 与 `rtl-interface-check` 精华）**：
  1. `PORT_MISMATCH`：顶层模块端口与虚拟板卡定义不一致（名/方向/位宽）；
  2. `SEQ_BLOCKING_ASSIGN`：时序 `always @(posedge clk)` 块中误用阻塞赋值 `=`；
  3. `COMB_NONBLOCKING_ASSIGN`：组合 `always @(*)` 块中误用非阻塞赋值 `<=`；
  4. `INFERRED_LATCH`：组合块 `if` 缺 `else` 或 `case` 缺 `default`；
  5. `UNDRIVEN_OR_UNASSIGNED`：输出端口未驱动或状态变量读取但从未赋值；
  6. `MULTI_DRIVER_OR_SHIFT`：同一变量被多个过程块驱动，或无符号数误用算术右移 `>>>`。
- **确定性自测与无回退**：
  - 输入标准 JSON 测试用例（每拍激励 + 期望输出掩码），由纯 TS 仿真内核独立执行；
  - 精准捕获**首个失配周期 `firstFailure.cycle`** 及期望/实际差异信号，回传给示波器画红框；
  - 对比上一版通过的检查点集合，若出现“旧通过点变失败”则标记 `regressedCycles`，防止改坏已有功能。

#### 模块 4：前端 Harness 智能体闭环 + 案例/故障库（`src/agent/`）
- 复用原项目 [REPORT.md](../reference/fpga2026/代码-可验证RTL闭环设计智能体/44959_rtlagent/REPORT.md) 的核心思想，构建可视化状态机：
  1. **阶段 1（规划）**：调用大模型生成结构化蓝图（行为要点、引脚映射、Mermaid 状态转移图、自测向量 JSON）；
  2. **阶段 2（编码）**：携带精简交接蓝图 + 原项目 `skill/` 提炼的 Verilog 规范，生成符合 `top` 接口的 Verilog；
  3. **阶段 3（本地确定性验证）**：调用 `linter.ts` + `simulator.ts` + `selftest.ts`；
  4. **阶段 4（最多 2 轮分流自动修复）**：
     - 语法/Lint 错 → 直接带错误行号修复；
     - 功能失配 → 携带**首个反例波形切片**进行诊断修复，并执行无回退校验；
  5. **阶段 5（教学模式）**：在“AI 助教”或“故障诊所”模式下，提供 `只给线索 / 指出错因 / 对比修复` 三档苏格拉底引导。

#### 模块 5：Qoder Sites 云函数代理与四层额度风控（`functions/index.ts` + `src/services/llmClient.ts`）
- **四层防爆省钱设计**：
  1. **零 Token 预置案例**：首页 4–5 个经典案例（交通灯、密码锁、序列检测器、秒表、抢答器）自带完整预生成蓝图、代码、自测断言与故障模板，点击秒开不消耗任何 API；
  2. **服务端 Secret 藏 Key**：API Key 只存放在 Qoder Sites 环境变量中，绝不写入前端代码或 Git 仓库；
  3. **云函数防刷与免费额度模型**：使用阿里云百炼免费新手额度（如 `qwen-plus` / `qwen-turbo`）或智谱免费 Flash 模型，并在云函数中加入 `Origin/Referer` 校验、单 IP 每日次数限制（如 8 次/天）及云平台日消费硬封顶（如 5 元/天）；
  4. **优雅降级 + BYOK**：超出免费次数后本地仿真/门级图/板卡/Lint 仍 100% 可用，同时允许用户在设置面板填入自己的 OpenAI 兼容 API Key（仅存 `localStorage`）。

---

## 3. 三人团队模块分工与零冲突协作

> 设计原则：**将所有 Web 框架、SVG 渲染与云函数部署收拢到全栈队长；让两位无网站开发经验的队友完全专注纯 TypeScript 逻辑、Prompt 与单元测试，无需接触 React/CSS/部署。**

### 3.1 队长（全栈统筹 + 网站前端开发 + 云函数部署）
- **专属目录**：`src/types/contracts.ts`、`src/services/`、`src/components/`、`src/App.tsx`、`functions/index.ts`、`vite.config.ts`
- **工作清单**：
  1. 在 Qoder 中初始化 `React + TypeScript + Vite + Tailwind CSS + Vitest` 工程，配置好 `npm run test:engine` 和 `npm run test:agent` 脚本；
  2. 维护 [`src/types/contracts.ts`](../src/types/contracts.ts)，在 `main` 发布两位队友共用的接口。用 `createRtlEngine()` 分别为板卡与 Harness 创建独立实例，再用 `createAgentRuntime({ llm, engine })` 注入后者与模型客户端；
  3. 维护 `src/services/llmClient.ts` 的云函数代理、Node 直连和浏览器 BYOK 三种模式。工作台订阅 `onTrace` 展示步骤，按 `LLMError.code` 处理额度耗尽、连接错误和取消；
  4. 开发前端 UI：三栏工作台、顶部指挥条、**动态门级信号流画布（`dagre` + SVG 发光脉冲 + 白话播报）**、**虚拟 FPGA 开发板**、**迷你波形示波器（红框反例）**、左栏透明智能体面板；
  5. 开发 `functions/index.ts`（Qoder Sites Server Function），配置服务端 Secret 与限流；
  6. 统筹 Git 分支合并、全链路联调，完成 **Qoder Sites 公网部署**与最终体验验收。

### 3.2 队友 1（硬件/仿真移植，零 Web 门槛）
- **专属目录**：`src/engine/`、`tests/engine.test.ts`
- **接口交付**：`src/engine/index.ts` 保留 `createRtlEngine: RtlEngineFactory`，把实现从 Mock 切换到真实引擎。`step` 每次返回 `sample` 与 `netlist`，`runSelfTest` 保持运行中的板卡状态。使用 `npm run test:engine` 独立验收。
- **工作清单**：
  1. `src/engine/parser.ts`：实现可综合 Verilog 教学子集词法/语法解析器，给出清晰行号错误；
  2. `src/engine/simulator.ts`：实现周期精确仿真引擎，固定输出 `BoardOutputs`（LED/交通灯/数码管）和波形历史；
  3. `src/engine/netlist.ts`：将 AST 编译为教学级门/模块网表（`AND/OR/NOT/XOR/MUX/CMP/ADD/DFF`），完成拓扑分层与逐拍信号跳变标记；
  4. `src/engine/linter.ts`：参考 `reference/fpga2026/.../skill/rtl-lint-rules` 与 `rtl-interface-check`，实现 6 条静态规则检查；
  5. `src/engine/selftest.ts`：按同一组 `TestVectorStep[]` 执行独立自测，输出 `firstFailure`、`passedCycles` 和 `regressedCycles`。周期从 0 起算，时序用例显式拉低 `rst_n`；
  6. `tests/engine.test.ts`：编写 **≥ 50 条回归测试用例**（涵盖 5 个经典电路及各类错误样例）。

### 3.3 队友 2（AI 调用与提示词 + 案例/故障库，零 Web 门槛）
- **专属目录**：`src/agent/`、`tests/agent.test.ts`
- **接口交付**：`src/agent/index.ts` 保留 `createAgentRuntime: AgentRuntimeFactory`，消费注入的 `LLMClient` 和 `RtlEngine`，通过 `AgentRuntime` 交付 `runHarness`、`presets`、`diagnose` 和 `injectBug`。用替身依赖运行 `npm run test:agent`，实测模型时可另用本地 `.env.local`。
- **工作清单**：
  1. `src/agent/prompts.ts`：从 `reference/fpga2026/.../skill/` 提炼精简高效的 Verilog 写作规则与严格 JSON Schema（规划蓝图、生成代码、反例苏格拉底诊断、故障注入）；
  2. `src/agent/harness.ts`：参考 `reference/fpga2026/.../REPORT.md`，实现规划、生成、Lint、自测及最多 2 轮修复。用同一组向量比较 `passedCycles` 与 `regressedCycles`，通过 `onTrace` 回调和 `HarnessResult` 交付过程及最佳候选，并接收取消信号；
  3. `src/agent/presets.ts`：精心打磨 **4–5 个零 Token 预置案例**（交通灯、4 位密码锁、序列检测器、数字秒表、抢答器）——每个案例包含完整的中文需求、蓝图、Mermaid 状态图、经过队友 1 仿真器验证的 Verilog、自测断言；
  4. `src/agent/bugClinic.ts`：参考 `reference/fpga2026/.../skill/rtl-pitfalls`，为预置案例编写 **6–8 个典型硬件故障注入模板**（附带故障现象说明、三档苏格拉底提示和标准修复方案）；
  5. 负责整理参赛发帖文档素材（产品 5 步上手指南、Known Limitations 边界说明、团队分工与 Qoder 过程截图汇总）。

---

## 4. 协作推进阶段（按里程碑，不绑定死天数）

| 里程碑 | 核心目标 | 参与人 | 验收出口 |
| --- | --- | --- | --- |
| **M0 · 骨架与契约冻结** | 发布 Vite 工作台、交通灯 Mock、`RtlEngine`、`AgentRuntime`、`LLMClient` 和 `LLMError` 到 `main` | 队长 | `npm ci`、`npm test`、`npm run build` 通过，浏览器可体验交通灯与生成步骤演示 |
| **M1 · 三线并行独立开发** | 队长完善板卡与逐层传播；队友 1 接入真实 `RtlEngine`；队友 2 接入真实 `AgentRuntime` | 三人并行 | 分别在 `feat/ui-core`、`feat/engine`、`feat/agent` 通过各自的模块验收 |
| **M2 · 本地硬核闭环联调** | 合并 `feat/engine` 到 `main`，前端接真仿真内核与真门级网表 | 队长 + 队友 1 | 5 个预置案例可在网页真亮灯、0.2x 慢动作看信号、改代码实时标红 Lint 与波形反例 |
| **M3 · AI 全链路与云函数联调** | 合并 `feat/agent` 到 `main`，接入 Qoder Sites 云函数代理与故障诊所 | 全体成员 | 输入全新中文需求能完整走通“蓝图 → 代码 → 自测修复 → 上板亮灯”，故障诊所可用 |
| **M4 · 公网部署与参赛交付** | 部署 Qoder Sites，无痕模式压测免 Key 体验、限流与降级；整理截图发天池论坛帖 | 队长主部署 + 队友 2 整文案 | 链接公网秒开、5 步内跑通、论坛提交审核通过 |

---

## 5. 原项目资产（`reference/fpga2026/`）合规复用映射

| 原项目资产位置 | 提取复用内容 | 新项目落地点 |
| --- | --- | --- |
| `skill/sv-combinational`、`sv-sequential`、`sv-fsm`、`sv-width-sign` | 组合/时序/状态机/位宽编码铁律 | `src/agent/prompts.ts`（精简为前端 AI 生成规则） |
| `skill/rtl-lint-rules`、`rtl-interface-check` | 6 类核心数据流告警与端口比对逻辑 | `src/engine/linter.ts`（纯 TS 全新重写） |
| `skill/rtl-pitfalls` | 10 条真实硬件踩坑证据（阻塞赋值、未驱动输出、无符号右移等） | `src/agent/bugClinic.ts`（转化为「故障诊所」题库） |
| `REPORT.md` 第 2/4 节 | Harness 六大部件：交接蓝图、CPU 确定性自测、首个反例、无回退择优 | `src/agent/harness.ts` & `src/engine/selftest.ts` |
| `serve/`、`Dockerfile`、`llama.cpp`、Vivado 后端 | **全部舍弃**（不适用于浏览器与 Qoder Sites） | 无 |

---

## 6. 天池比赛最终提交检查清单

- [ ] 全体队员完成 **天池实名认证** + **阿里云大学生认证**（截止前必须完成，否则取消获奖资格）。
- [ ] 在天池赛题页论坛发帖，标题注明赛道：`【StudyHack】VibeFPGA Lab：...`。
- [ ] 帖子包含以下全部必填项：
  1. **Qoder Sites 公网公开访问链接**（无需登录、无需填 Key 即可完整体验）；
  2. **使用的 Qoder 账号 UID** 及 **三人明确分工**；
  3. **作品介绍五件套**：自我介绍、作品是什么（一句话说清谁在什么场景用）、为什么做、怎么用（5 步内上手）、**用 Qoder 开发与部署的全过程（附多张真实截图凭证）**；
  4. **工程可信度补充**：自动化单测通过率（如 `58/58` 项通过）+ 坦诚声明 `Known Limitations`。
- [ ] （可选加分）同步发布至小红书/抖音/X 并填写官方钉钉表单冲刺社交传播奖。
