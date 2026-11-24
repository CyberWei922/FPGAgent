# FPGAgent 统一数据契约

冻结版以 [`src/types/contracts.ts`](../src/types/contracts.ts) 为准。三位成员直接从该文件导入类型。字段或语义有变动时，在群内同步后由队长统一修改。

| 接口 | 协作方 | 用途 |
| --- | --- | --- |
| `BoardInputs`、`BoardOutputs`、`SignalSample` | 队长、队友 1 | 板卡输入与输出采样。每次 `step` 执行一次时钟上升沿，返回该拍采样和网表。 |
| `NetlistGraph` | 队友 1 → 队长 | 绘制节点、导线、逐层传播和中文信号说明。 |
| `RtlEngine`、`SelfTestResult` | 队友 1 → 队长、队友 2 | 编译、Lint、确定性自测及波形。 |
| `AgentRuntime`、`HarnessResult`、`HarnessTraceEvent` | 队友 2 → 队长 | 启动生成闭环、接收进度回调、载入预置案例、诊断及生成故障练习。 |
| `LLMClient`、`LLMError`、`LLMErrorCode` | 队长 → 队友 2 | 统一大模型调用、取消信号、额度及错误处理。 |

## 仿真与自测

- `src/engine/index.ts` 导出 `createRtlEngine: RtlEngineFactory`。板卡与 Harness 各使用一个实例。`runSelfTest` 使用独立的仿真状态，调用结束后板卡继续原来的周期。
- `step` 从周期 0 开始计数，`reset()` 后重新计数。测试向量的 `cycle` 等于数组下标。时序电路的用例应显式拉低 `rst_n` 完成电路复位。`expect` 只比对提供的输出字段。
- `passedCycles` 记录至少有一个断言且所有断言均通过的周期。Harness 复用同一组向量，把上一候选的 `passedCycles` 传给新一轮自测，`regressedCycles` 指出先前通过、现在失败的周期。
- 组合逻辑未在迭代上限内收敛时，自测失败并通过 `firstUnstableCycle` 报告首个未收敛周期，即使该拍输出碰巧吻合断言。`firstFailure` 用于稳定输出的首个失配。
- `traffic` 位 2、1、0 分别对应红、黄、绿灯。`seg` 由高到低分为四组 4 位数字，最高组在显示器左边。

## 智能体与大模型

- `src/agent/index.ts` 导出 `createAgentRuntime: AgentRuntimeFactory`，由调用方注入 `LLMClient` 和 `RtlEngine`。调用 `runHarness(prompt, { onTrace, signal })` 时，`onTrace` 接收步骤，返回值 `HarnessResult` 提供最佳候选、Lint、自测（编译成功时）和修复轮数。`presets`、`diagnose(input)` 和 `injectBug(code)` 分别提供离线案例、分档诊断和故障模板。
- `LLMClient.chat` 成功返回 `text`，代理模式也可返回 `remainingQuota`。用 `isLLMError` 收窄错误并按 `code` 处理。`QUOTA_EXCEEDED` 时可继续使用预置案例或自带 API Key，`ABORTED` 表示调用方已取消。
- 首版已接入真实引擎和 Harness，前端仍使用以上工厂入口。首页预设的生成进度是演示，编译、自测、波形与门级图来自真实引擎。
