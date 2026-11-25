# FPGAgent 统一数据契约（V2 · 第二轮冻结版）

冻结版以 [`src/types/contracts.ts`](../src/types/contracts.ts) 为准。三位成员直接从该文件导入类型。**V2 全部新增字段与方法均为可选，100% 向后兼容首版代码与全部既有测试。** 字段或语义有变动时，在群内同步后由队长统一修改。

| 接口 | 协作方 | 用途 |
| --- | --- | --- |
| `BoardInputs`、`BoardOutputs`、`SignalSample` | 队长、队友 1 | 板卡输入与输出采样。每次 `step` 执行一次时钟上升沿，返回该拍采样和网表。 |
| `NetlistGraph`（含 `levelNarrations`） | 队友 1 → 队长 | 绘制节点、导线、逐层慢动作传播与分层中文信号说明。 |
| `RtlEngine`、`CompileResult`、`CircuitMetadata`、`SelfTestResult` | 队友 1 → 队长、队友 2 | 编译、电路元数据、Lint、确定性自测、波形及可选 `tb_top.v` Testbench 导出。 |
| `LLMProviderPreset`、`LLMModelOption`、`LLMClient`、`LLMError` | 队长 → 队友 2 | 国内常用 API 服务商预设、自动拉取 `/models` 模型列表、连接测试、按次切模型、可选流式增量、取消信号与额度。 |
| `WebResearchClient`、`WebReference`、`WebPageContent` | 队长/云函数 → 队友 2 | 可选联网检索与网页正文提取接口，供智能体查阅 Verilog 规范或参考实例。 |
| `AgentRuntime`、`HarnessRunOptions`、`HarnessPreviousContext`、`HarnessResult`、`HarnessTraceEvent` | 队友 2 → 队长 | 启动生成/多轮修改闭环、透传模型与联网开关、接收步骤回调与引用来源、载入案例、诊断及故障注入。 |

## 1. 仿真、元数据与自测（队长 ↔ 队友 1）

- `src/engine/index.ts` 导出 `createRtlEngine: RtlEngineFactory`。板卡与 Harness 各使用一个实例。`runSelfTest` 使用独立的仿真状态，调用结束后板卡继续原来的周期。
- `step` 从周期 0 开始计数，`reset()` 后重新计数。测试向量的 `cycle` 等于数组下标。时序电路的用例应显式拉低 `rst_n` 完成电路复位。`expect` 只比对提供的输出字段。
- `passedCycles` 记录至少有一个断言且所有断言均通过的周期。Harness 复用同一组向量，把上一候选的 `passedCycles` 传给新一轮自测，`regressedCycles` 指出先前通过、现在失败的周期。
- 组合逻辑未在迭代上限内收敛时，自测失败并通过 `firstUnstableCycle` 报告首个未收敛周期，即使该拍输出碰巧吻合断言。`firstFailure` 用于稳定输出的首个失配。
- `traffic` 位 2、1、0 分别对应红、黄、绿灯。`seg` 由高到低分为四组 4 位数字，最高组在显示器左边。
- **V2 新增**：
  - `NetlistGraph.levelNarrations`：按拓扑层级 `0..maxLevel` 提供逐级中文说明，配合节点的 `level` 与 `changed` 驱动慢动作逐级点亮。
  - `CompileResult.metadata`：返回模块名、实际使用的板卡输入/输出端口以及内部关键寄存器列表（含位宽），供前端动态渲染板卡与示波器内部信号。
  - `RtlEngine.exportTestbench?(code, vectors)`：可选导出标准 Verilog Testbench（`tb_top.v`），与 `.v` 源码一并供用户下载到 Vivado / Icarus Verilog 运行。

## 2. 大模型、服务商预设与模型切换（队长 → 队友 2）

- `LLMProviderPreset` 定义内置的常用服务商预设（如 DeepSeek、智谱 GLM、通义千问 DashScope、硅基流动 SiliconFlow、月之暗面 Kimi、自定义 OpenAI 兼容服务），用户选中预设后自动填充 `baseUrl` 与推荐模型，仅需填写 API Key。
- `LLMClient.listModels?()` 自动请求服务商 `/models`（浏览器直连或经云函数代理规避跨域），返回 `LLMModelOption[]` 供设置面板和左侧对话底栏实时选择和切换模型。
- `LLMClient.testConnection?()` 用于设置页一键验证连通性与耗时。
- `LLMClient.chat(options)` 支持 `options.model` 单次覆盖当前模型，以及可选 `options.onDelta` 流式回调；返回 `{ text, remainingQuota?, model? }`。调用方仍统一用 `isLLMError` 收窄错误并按 `code` 处理。

## 3. 联网检索与网页读取（队长/云函数 → 队友 2）

- `WebResearchClient` 通过 `createAgentRuntime({ llm, engine, research })` 可选注入，不要求 `src/agent/` 依赖任何浏览器或网络库：
  - `search(query, { limit?, signal? })` 返回候选网页列表 `WebReference[]`（标题、URL、摘要、来源）；
  - `fetchPage?(url, { maxChars?, signal? })` 读取指定网页正文摘要 `WebPageContent`。
- 当 `research` 已注入且 `enableWebResearch !== false` 时，智能体可在需求涉及不熟悉算法/协议、Verilog 语法规范存疑或修复受阻时进入 `researching` 阶段，检索规范或参考代码并将精简证据注入提示词，同时通过 `HarnessTraceEvent.meta.sources` 与 `HarnessResult.references` 透出引用来源。
- **优雅降级铁律**：未注入 `research`、用户关闭联网、或搜索/网页读取超时报错时，智能体不得中断主流程，应记录提示后自动回退到纯模型闭环继续完成电路生成。

## 4. 智能体运行时与多轮对话（队友 2 → 队长）

- `src/agent/index.ts` 保留 `createAgentRuntime: AgentRuntimeFactory`。
- `runHarness(prompt, options)` 接收：
  - `options.model`：用户在对话中选择的模型名，需透传给本轮所有 `llm.chat` 调用；
  - `options.previousContext`：上一版蓝图、Verilog 代码、测试向量与对话历史，用于多轮增量修改并保持已有核心功能不回退；
  - `options.enableWebResearch`：控制本轮是否允许调用 `research`；
  - `options.onTrace` / `options.onAssistantDelta`：实时回传步骤状态（含 `meta`）与可选流式摘要。
- `HarnessResult` 在原有字段基础上可额外返回 `assistantSummary`（左侧对话框通俗总结）、`suggestedFilename`（建议的 `.v` 导出文件名）、`remainingQuota`、`modelUsed` 与 `references`。
- `diagnose(input, options?)` 与 `injectBug(code, options?)` 支持传入 `{ signal?, model? }`。
- `PresetProject` 新增可选 `category`、`difficulty`、`boardHint`，供案例库分类展示与板卡适配。
