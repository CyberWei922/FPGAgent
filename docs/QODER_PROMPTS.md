# Qoder 分角色开工提示词手册（第二轮 · V2 契约版）

> **同步前提**：本手册面向基于最新 `main`（含首版三端联调与 V2 冻结契约）启动的**第二轮开发**。每位成员先在本地同步最新 `main`，再切出或合并到各自开发分支（队长 `feat/ui-core`、队友 1 `feat/engine`、队友 2 `feat/agent`），随后把对应角色的提示词粘贴给 Qoder 即可零冲突开工。

---

## 一、队长（全栈统筹 + UI 改版 + 多服务商 API/模型切换 + 云端检索与部署）第二轮提示词

> **专属目录**：`src/types/contracts.ts`、`src/services/`、`src/components/`、`src/App.tsx`、`functions/`、`tests/platform.test.ts`

```text
请先阅读 docs/PROJECT_PLAN.md、docs/DATA_CONTRACTS.md、src/types/contracts.ts 以及当前 src/services/、src/components/、src/App.tsx 和 functions/。项目为 2026 Qoder 高校创造力大赛 StudyHack 赛道的 FPGAgent，目前已完成第一轮三端合并，现基于最新 main 与 V2 冻结契约推进第二轮开发。

我是队长，负责契约、服务层、前端 UI/布局与 Qoder Sites 云函数部署，请不要修改 src/engine/ 和 src/agent/ 的业务实现。请按以下目标分步实现：

1. 多服务商 API 预设、自动拉取模型与连通测试（src/services/）：
   - 按 contracts.ts 的 LLMProviderPreset 与 LLMModelOption，内置国内常用 OpenAI 兼容服务商预设：DeepSeek、智谱 GLM、通义千问（DashScope）、硅基流动（SiliconFlow）、月之暗面（Kimi），同时保留「站点默认」和「自定义 OpenAI 兼容」；选中预设后自动填充 baseUrl 与默认模型，用户只需填写 API Key。
   - 为 LLMClient 实现 listModels()（自动请求服务商 /models 拉取模型列表；支持浏览器直连或通过云函数代理绕过 CORS，失败时优雅回退到预设推荐列表）与 testConnection()（返回连通状态与耗时），并支持 chat({ model }) 按次覆盖模型。
   - 实现基于云函数代理的 WebResearchClient（search 与 fetchPage），并在前端装配 createAgentRuntime({ llm, engine, research }) 时注入。

2. 设置面板重构与对话内模型实时切换（src/components/ + src/App.tsx）：
   - 重新设计 API 设置面板：支持服务商预设切换、Key 输入与本地持久化、点击/自动刷新模型列表、模型下拉选择、一键测连、站点剩余额度展示、以及「允许联网查阅 Verilog 规范」开关。
   - 在对话输入区（首页与工作台）加入紧凑的模型选择器与联网开关，允许用户在对话过程中随时切换模型并即时透传给 runHarness / diagnose / injectBug 的 options.model 与 options.enableWebResearch。

3. 网页整体布局优化与第二轮核心功能补齐：
   - 优化首页到三栏工作台的布局比例、层级与响应体验；在按需展开的案例库中完整呈现全部 5 个预置案例（首页仍保持清爽）。
   - 接通「故障诊所」完整教学闭环：注入预置或 AI 故障 → 板卡/波形标红首拍 → 三档苏格拉底提示 → 一键应用修复并复测。
   - 将蓝图面板中的 Mermaid stateDiagram-v2 状态机真正渲染为可读图形（异常时回退显示源码）。
   - 在 GateCanvas 接入 NetlistGraph.levelNarrations 与拓扑层级，实现 0.2x 慢动作和单步逐级发光与白话播报，并与波形时间点联动；消费 CompileResult.metadata 高亮实际用到的板卡外设与示波器内部信号；补齐 .v 与 tb_top.v 导出入口。

4. 云函数扩展与公网交付（functions/）：
   - 扩展云函数端点：/agent（支持透传可选 model）、/models（可选辅助代理）和 /research（联网搜索与网页正文提取，必须做好协议/内网 IP 的 SSRF 防护、超时控制、正文截断与限流）。
   - 提交前运行 npm run build、npm run test:platform、npm test，并在浏览器完整验收设置面板、模型拉取与切换、5 案例、故障诊所和慢动作逐级信号流。
```

---

## 二、队友 1（硬件仿真引擎完善 + 网页移植加固 + 广范围鲁棒性测试）第二轮提示词

> **专属目录**：`src/engine/`、`tests/engine.test.ts`（不修改任何 React 前端、云函数和 `src/agent/` 文件）

```text
请先阅读 docs/PROJECT_PLAN.md、docs/DATA_CONTRACTS.md、src/types/contracts.ts 以及当前 src/engine/ 和 tests/engine.test.ts。项目为 FPGAgent，第一轮三端已合并至 main，现基于最新 main 和 V2 冻结契约开展第二轮开发。

我是负责 engine 分支（feat/engine）的成员，只修改 src/engine/ 和 tests/engine.test.ts。核心目标是：彻底夯实浏览器端纯 TS Verilog 编译与仿真内核，补齐 V2 契约能力，并通过大范围跨电路与异常压测，防止 AI 现场生成全新代码时出现解析或仿真异常。

请按以下要求推进：

1. 网页端编译与仿真子集扩展及异常加固（parser.ts / simulator.ts / linter.ts）：
   - 系统性覆盖大模型（DeepSeek/GLM/Qwen 等）生成 Verilog 时常见的合法语法与写法，包括但不限于：块注释 /* ... */、多种端口声明风格（如 output reg [7:0] led、非 ANSI 声明等）、localparam/parameter 常量表达式、拼接重复 {N{expr}}、单目归约运算符（& | ^ ~& ~| ~^）、casez/casex、有界静态 for 循环展开、有符号/无符号位宽截断与扩展、同步/异步复位组合。
   - 严防运行期崩溃与死循环：对组合逻辑震荡环、未声明变量、非法位宽/字面量、语法残缺、深层嵌套等异常代码绝不抛出未捕获异常，统一转化为带准确行号和中文建议的 LintIssue 或稳定的自测失败报告（firstUnstableCycle）。

2. 补齐 V2 契约新增能力（保持 100% 向后兼容）：
   - src/engine/netlist.ts：为 NetlistGraph 补齐 levelNarrations（覆盖拓扑层级 0..maxLevel 的逐级中文播报），确保交通灯「KEY0 → 逻辑门 → 红灯」等电路在慢动作/单步时可清晰逐层展示信号传播路径。
   - src/engine/index.ts（及 parser）：在 compile() 返回的 CompileResult 中填充 metadata（CircuitMetadata：moduleName、实际用到的 usedInputs/usedOutputs、internalSignals 名称及位宽），供前端动态高亮板卡外设与波形内部信号。
   - 实现 RtlEngine.exportTestbench(code, vectors)：将当前模块与自测向量导出为标准 tb_top.v，可直接供 Vivado / Icarus Verilog 验证。

3. 广范围回归与模糊压测（tests/engine.test.ts）：
   - 将单元测试扩充至至少 120 条，覆盖 10+ 类 AI 常见全新电路（如流水灯、模 N/BCD 计数器、PWM/分频器、简易 ALU、移位寄存器、自动售货机状态机、按键消抖、奇偶校验、译码器/多路选择器及全部 5 个预置案例），并加入异常语法、组合环、边界位宽、长周期仿真性能和无回退校验测试。
   - 提交前确保 npm run test:engine 与 npm run build 全部通过。
```

---

## 三、队友 2（AI 智能体升级：多模型切换适配 + 联网检索/网页读取 + 多轮修改与评测）第二轮提示词

> **专属目录**：`src/agent/`、`tests/agent.test.ts`、参赛文档素材（不修改前端 React、云函数和 `src/engine/` 代码）

```text
请先阅读 docs/PROJECT_PLAN.md、docs/DATA_CONTRACTS.md、src/types/contracts.ts 以及当前 src/agent/ 和 tests/agent.test.ts。项目为 FPGAgent，第一轮三端已合并至 main，现基于最新 main 和 V2 冻结契约开展第二轮开发。

我是负责 agent 分支（feat/agent）的成员，只修改 src/agent/ 和 tests/agent.test.ts。保留 src/agent/index.ts 的 createAgentRuntime: AgentRuntimeFactory 导出，升级消费 AgentRuntimeDeps = { llm, engine, research? }。

请用纯 TypeScript 完成以下第二轮升级：

1. 多模型选择透传与国产模型输出兼容（harness.ts / prompts.ts / bugClinic.ts）：
   - 在 runHarness(prompt, options)、diagnose(input, options) 和 injectBug(code, options) 中接收 options.model，透传到本轮所有 llm.chat({ ..., model }) 调用；在 HarnessTraceEvent.meta.model 与 HarnessResult.modelUsed 中回传实际执行的模型，并透传 remainingQuota。
   - 强化 prompts.ts 与 JSON 容错解析：稳定剥离推理模型可能输出的 <think>...</think> 思考段、Markdown 代码围栏或前后说明文字，兼容 DeepSeek、智谱 GLM、通义千问、Kimi 等不同国产模型的 JSON 与代码风格。

2. 联网检索与网页读取能力（research?: WebResearchClient）：
   - 接入注入的 research 客户端与 options.enableWebResearch 开关。
   - 设计合理的检索触发条件：当用户需求涉及不熟悉的硬件协议/算法、显式要求查阅 Verilog 规范或参考示例、或第 1 轮编译/自测修复受阻时，进入 researching 阶段，构造精准查询词调用 research.search(query)，对最相关条目按需调用 research.fetchPage(url) 提取正文摘要，将精简规范与代码要点注入规划或修复提示词。
   - 将本轮引用来源写入 HarnessTraceEvent.meta.sources 与 HarnessResult.references，方便前端展示可点击溯源链接。
   - 严格保证优雅降级：未注入 research、用户关闭联网、无搜索结果或网络/读取抛错超时时，绝不中断主流程，发出降级提示后平滑回退到纯模型闭环继续完成电路生成与验证。

3. 多轮增量对话修改与内容打磨（harness.ts / presets.ts / bugClinic.ts）：
   - 消费 options.previousContext（已有蓝图、Verilog、测试向量与对话历史），在用户追问修改电路时保留原有核心行为、增量演进代码与测试向量并尽量防止既有检查点回退。
   - 为 HarnessResult 产出清晰的 assistantSummary（对话区通俗说明）与 suggestedFilename（如 traffic_light.v）。
   - 为 5 个预置案例补齐 category、difficulty、boardHint 元数据，核验所有案例与故障诊所关卡在最新引擎下均稳定可用。

4. 离线单测与真实模型验收（tests/agent.test.ts）：
   - 使用 Mock LLM、Stub RtlEngine 和 Mock WebResearchClient 补齐单元测试：覆盖 model 透传、<think> 与围栏 JSON 容错、联网搜索/网页读取触发与异常降级、多轮上下文增量修改及 5 案例元数据校验，确保 npm run test:agent 100% 离线通过。
   - 另外使用本地 .env.local 搭配真实国产模型（如 DeepSeek / GLM）实测至少 3 类全新电路需求与追问修改，用独立断言检验生成质量并按实测问题继续优化 Prompt。
```
