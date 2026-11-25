# 队友 2 交付说明：AI 闭环、故障题库与参赛文案素材

> 分支：`feat/agent`（只推分支，不建 PR）
> 依赖契约：[src/types/contracts.ts](../src/types/contracts.ts)
> 模块验收：`npm run test:agent`（25 个用例，全部使用替身 LLM / 引擎，不消耗 Token）

## 1. 交付物清单

| 文件 | 作用 | 验收证据 |
| --- | --- | --- |
| [src/agent/prompts.ts](../src/agent/prompts.ts) | 五个动作的 System Prompt（规划/生成/修复/诊断/故障注入）、板卡接口、可综合 Verilog 子集、严格 JSON Schema 与鲁棒解析 | 围栏/夹带文字/纯文本三种输出均可解析；非法字段抛 `BAD_RESPONSE` |
| [src/agent/harness.ts](../src/agent/harness.ts) | 规划→生成→Lint→确定性自测→最多 2 轮修复→无回退择优；`onTrace` 进度、`AbortSignal` 取消、按动作设置 temperature | 25 个测试覆盖通过路径、Lint 失败修复、连续失败、未收敛修复、额度中断、取消 |
| [src/agent/presets.ts](../src/agent/presets.ts) | 5 个零 Token 预置案例：交通灯、四位密码锁、1011 序列检测器、数字秒表、四人抢答器 | 已用 `feat/engine` 真实引擎逐案验证：20/20、19/19、6/6、15/15、9/9 断言全部通过 |
| [src/agent/bugClinic.ts](../src/agent/bugClinic.ts) | 7 个算法注入故障（漏复位、状态机转移、标志不清零、BCD 进位、锁存缺失、位宽截断、时序块阻塞赋值）+ LLM 故障注入入口 | 7 个故障均可被自测或 Lint 观测；修复代码全部编译并自测通过；`highlightLine` 已逐行核对 |
| [src/agent/index.ts](../src/agent/index.ts) | 对前端暴露 `createAgentRuntime({ llm, engine })`，不引用任何具体模型/引擎实现 | 前端零改动接入（[src/App.tsx](../src/App.tsx)） |
| [tests/agent.test.ts](../tests/agent.test.ts) | 25 个单元测试 | `npm run test:agent` 25/25 |
| 本文档 | 故障诊所交互规范 + 参赛文案草稿 + 交接事项 | — |

## 2. 本轮打磨内容（feat/agent 最新提交）

- **Schema 归一化加固**：`testVectors` 首拍强制 `rst_n=0`；非数字的 `expect` 字段直接忽略，不再静默折算成 `0` 造成假断言；`inject_bug` 补充解析 `highlightCycle`。
- **按动作设置 temperature**：plan 0.3、generate 0.2、repair 0.2、diagnose / inject_bug 0.5，降低代码类动作的随机性。
- **组合逻辑未收敛路径**：`firstUnstableCycle` 已贯通解析、修复载荷、trace 文案与测试。
- **测试扩充**：25 个用例覆盖首拍复位、非法 expect、未收敛修复、温度配置、故障高亮行/周期。

## 3. 故障诊所交互规范（交给队长的最小 UI 方案）

数据全部来自 `runtime.presets[].bugs`，**不消耗 Token**；LLM 注入（`runtime.injectBug`）作为"随机加练"可选。

1. **入口**：工作台"电路资料"侧栏新增第 4 个页签「故障诊所」；或预置案例卡片右下角「挑战故障」。
2. **选关**：列出当前案例的 1–2 个故障关卡（`title` + `pitfallTag`），显示"未通过/已通过"状态（本地内存即可）。
3. **现象**：点开显示 `symptom`，提供"载入故障电路"按钮——把 `buggyCode` 装进现有编辑器并编译（Lint 告警会自然出现）；自测失败时高亮 `highlightCycle`，Lint 告警时高亮 `highlightLine`。
4. **三档提示**：依次解锁 `diagnosis.level1Hint` → `level2Cause` → `level3PatchCode`；第 3 档提供"载入修复代码"按钮。
5. **验收**：修复代码编译 + 自测通过后标记关卡完成；展示 `pitfallTag` 对应的知识点小结。

建议 API（无需改契约）：
- 选关：`preset.bugs[i]`
- 判分：`engine.compile(bug.diagnosis.level3PatchCode)` + `engine.runSelfTest(...)`（或直接载入）
- 可选加练：`runtime.injectBug(currentCode)`

## 4. 参赛文案草稿（天池帖子素材）

**一句话介绍**：FPGAgent 是一个浏览器里的 AI 硬件助教——用中文说出想做的电路，它给出蓝图、可综合 Verilog、逐拍自测与门级波形，学生改代码就能立刻看到 Lint 与波形反例。

**5 步上手指南**（无需登录、无需填 Key）：
1. 打开站点，在输入框描述需求，或点「做一个智能交通灯」预设。
2. 等待规划/生成/自测三段进度完成，左侧栏查看蓝图、行为要点与引脚映射。
3. 中间门级画布看信号逐层传播，支持拖动缩放、0.2× 慢动作、单步执行。
4. 右侧实时波形 + 虚拟板卡：拨 SW、按 KEY、点 RST，观察 LED/数码管/交通灯变化。
5. 在「Verilog」页签改代码点「编译并自测」；失败时看 Lint 告警与首个反例拍，再迭代（自动修复最多 2 轮）。

**团队分工**：
- 队长：前端工作台、板卡/网表动画、云函数代理、Qoder Sites 部署
- 队友 1：Verilog 解析、周期仿真、教学网表、静态 Lint、确定性自测引擎
- 队友 2：Prompt 与 JSON 契约、规划生成修复闭环、预置案例与故障题库、参赛文案

**Known Limitations**（如实声明）：
- 仅支持教学级可综合 Verilog 子集（不允许 for/数组/模块实例化/除法等），复杂设计会触发 Lint 或修复失败
- 自测向量由模型生成，覆盖不全时"通过"不代表功能完全正确
- 免 Key 体验按 IP 每日限次（默认 8 次），计数在函数冷启动后重置
- 故障诊所目前提供算法注入的 7 个关卡，LLM 随机注入需要模型额度
- 状态图目前展示 Mermaid 源码（渲染待接入）；BYOK 要求接口支持浏览器跨域调用

**Qoder 过程截图清单**（M4 补齐）：
- 三线并行开发：契约冻结、`npm test` 全绿、合并冲突解决
- 真实引擎联调：5 个预置案例亮灯、波形容差、Lint 反例
- AI 闭环：一次完整 runHarness 的 trace、修复前后对比
- 故障诊所：三档提示逐级解锁
- 部署：公网链接、无痕模式 5 步跑通

## 5. 交接事项（阻塞项）

| 事项 | 负责方 | 状态 |
| --- | --- | --- |
| 故障诊所 UI 入口（按第 3 节规范） | 队长 | 待接入 |
| 云函数部署、Secret、ALLOWED_ORIGINS、公网链接 | 队长 | 待部署；之后才能做真实模型调优 |
| 额度显示 / 重复失败 trace / `repairRounds` 展示 / Mermaid 渲染 | 队长 | 建议项，不影响验收 |
| `mockPresets.ts` 迁移（`tests/engine.test.ts` 仍直接引用） | 队友 2 + 队友 1 | 需先同步引用方式 |

## 6. 本地复现

```bash
npm run test:agent      # 25 个 Agent 单元测试
npm run typecheck       # 严格类型检查
npm test                # 全量 108+ 用例
npm run build           # 生产构建
```