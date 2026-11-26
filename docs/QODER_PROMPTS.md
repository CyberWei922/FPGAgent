# Qoder 分角色开工提示词手册（第三轮 · V3 契约版）

> **同步前提**：本手册面向基于最新 `main`（含第二轮最终版 `baf3004` 与 V3 冻结契约）启动的**第三轮开发**。每位成员先在本地同步最新 `main`，再切出或合并到各自开发分支（队长 `feat/ui-core`、队友 1 `feat/engine`、队友 2 `feat/agent`），随后把对应角色的提示词直接粘贴给 Qoder 即可零冲突开工。

---

## 一、队长（契约与限流升级 + 左侧「板卡配置」重构 + 中间主视区 16×8 大屏与蜂鸣器 + 部署）第三轮提示词

> **专属目录**：`src/types/contracts.ts`、`src/services/`、`src/components/`、`src/App.tsx`、`functions/`、`tests/function.test.ts`、`tests/llmClient.test.ts`、`tests/streaming.test.ts`

```text
请先阅读 docs/PROJECT_PLAN.md、docs/DATA_CONTRACTS.md、src/types/contracts.ts 以及当前 src/services/、src/components/、src/App.tsx 和 functions/。项目为 2026 Qoder 高校创造力大赛 StudyHack 赛道的 FPGAgent，第二轮最终版与 V3 冻结契约已合入 main，现启动第三轮开发。

我是队长，负责公共契约、云函数与服务层、前端 UI/交互和 Qoder Sites 部署，请不要修改 src/engine/ 和 src/agent/ 的业务实现。请按以下目标分步实现：

1. 云函数与服务层按项目扣次限流升级（functions/ + src/services/llmClient.ts + tests/function.test.ts）：
   - 将站点默认免费每日限额从 8 次调整为 6 次（DAILY_LIMIT_PER_IP=6、DAILY_LIMIT_PER_BROWSER=6），保留主渠道（阿里云百炼）+ 备用渠道（AMD Radeon Cloud）双渠道自动容灾与默认模型切换。
   - 在前端每次发起 runHarness / diagnose / injectBug 时生成唯一 runId，透传到 LLMCallOptions.runId 并在 /functions/v1/app/agent 请求体中发送给云函数。
   - 云函数按 (主体 Key, 北京时间当日, runId) 去重计费：同一轮项目生成/修改/自动修复闭环内的多次模型调用只扣 1 次每日额度（同时对单 runId 设置安全子调用上限如 8 次防滥用）；本地浏览器额度缓存同步按 runId 去重，在模型下拉框与设置面板准确显示“今日剩余 X / 6 次”。
   - 补充 tests/function.test.ts 单测，覆盖同 runId 多次子请求仅扣 1 次、不同 runId 正常扣次、超 6 次返回 QUOTA_EXCEEDED 及子调用上限保护。

2. 左侧「诊所」升级为「板卡配置」面板（src/components/ + src/App.tsx）：
   - 将左侧导航栏原「诊所」入口升级为「板卡配置」（Board Config），提供 3 套开箱预设模板（「经典教学板」「屏显终端板」「游戏创客板」）以及自定义外设勾选（LED、交通灯、数码管、16×8 字符/图块 OLED 屏、蜂鸣器）。
   - 切换板卡配置时同步更新当前 BoardProfile 状态，生成/追问时传入 runtime.runHarness(prompt, { ..., boardProfile, runId })；载入带有 boardProfileId / requiredPeripherals 的预置案例时自动切到对应板卡配置。
   - 保留原有故障诊所功能入口（可收纳到板卡配置下方二级区域或工具入口），确保既有故障教学能力不丢失。

3. 中间主视区 16×8 字符/图块 OLED 屏幕与蜂鸣器交互（src/components/ + src/App.tsx）：
   - 新建独立 Canvas 组件渲染 16×8 字符/图块混合屏幕（每格 8×8 像素，视觉等效 128×64 宽屏 OLED，按 docs/DATA_CONTRACTS.md 第 2.2 节严格实现 0x20..0x7E ASCII 字库与 0x80..0x8F 全部 16 个内置游戏/UI 图块），消费 SignalSample.screenBuffer，并在桌面端与移动端均保持高清晰度与满帧流畅。
   - 当当前电路使用 screen 外设（metadata.usedOutputs 包含 'screen' 或当前板卡启用 screen）时，中间工作台主视区新增并默认展示「虚拟屏幕」大视图，同时保留一键切回「门级网表」Tab 查看电路结构。
   - 为带屏模式新增键盘方向键 / WASD（及屏幕下方触屏方向键）直连虚拟板卡 key[3:0] 的便捷操控，并增加高速/游戏时钟档位（优先调用 engine.stepBatch(inputs, steps) 单帧批量推进，若引擎尚未实现则优雅降级为多次 step），避免刷屏或小游戏卡顿。
   - 接入 Web Audio API 实现板载蜂鸣器（消费 SignalSample.extendedOutputs.tone，严格按 docs/DATA_CONTRACTS.md 第 2.3 节 0..15 音阶/音效频率表发声），在板卡与屏幕工具栏提供一键静音开关。

4. 验证与联调准备：
   - 确保 npm run build、npm run test:platform 和 npm test 全部通过，在浏览器端实测板卡配置切换、16×8 屏幕大视图与门级网表切换、高速档流畅度、蜂鸣器发声/静音以及同 runId 仅扣 1 次额度。
```

---

## 二、队友 1（引擎 V3：定长寄存器数组 + 16×8 屏幕显存 & 蜂鸣器外设 + 高速步进与自测）第三轮提示词

> **专属目录**：`src/engine/`、`tests/engine.test.ts`（不修改任何 React 前端、云函数和 `src/agent/` 文件）

```text
请先阅读 docs/PROJECT_PLAN.md、docs/DATA_CONTRACTS.md、src/types/contracts.ts 以及当前 src/engine/ 和 tests/engine.test.ts。项目为 FPGAgent，第二轮最终版与 V3 冻结契约已合入 main，现基于最新 main 启动第三轮开发。

我是负责 engine 分支（feat/engine）的成员，只修改 src/engine/ 和 tests/engine.test.ts。核心目标是：在 100% 兼容 V1/V2 既有 129 条引擎单测的前提下，补齐 V3 契约所需的寄存器数组、16×8 屏幕显存与蜂鸣器外设仿真、高速批量步进以及自测升级。请分步实现：

1. 定长寄存器数组支持（ast.ts / parser.ts / simulator.ts / linter.ts / netlist.ts / index.ts）：
   - 解析并仿真 1D 与 2D 定长 reg/logic 数组声明，如 `reg [7:0] buf [0:15];`、`reg [3:0] grid [0:7][0:15];`（支持正向 `[0:N-1]` 与反向 `[N-1:0]` 边界，且支持用 localparam/parameter 表达式定义边界）。
   - 支持表达式读取（`buf[i]`、`grid[y][x]`、数组元素位选/切片如 `buf[i][3:0]`）以及阻塞/非阻塞赋值左值（`buf[i] <= val;`、`grid[y][x] <= val;`）。
   - 合理放宽有界静态 `for` 循环上限（如 256）以支持清屏或数组初始化循环，保持死循环保护不放松。
   - 适配 linter.ts：正确识别数组读写与驱动，不对合法数组操作误报 UNDRIVEN_OR_UNASSIGNED / INFERRED_LATCH；对明显越界或非法维度声明给出 ARRAY_BOUNDS_OR_DIM 诊断提示。
   - 适配 netlist.ts 与 index.ts：将寄存器数组聚合为单个 `kind: 'MEM'` 的教学存储块节点（避免把 128 格数组炸成上百个散节点），并在 CompileResult.metadata.arrays 中填充 ArrayDescriptor（名称、元素位宽、维度）。

2. V3 扩展外设端口（16×8 屏幕 + 蜂鸣器）与确定性显存状态机（linter.ts / simulator.ts / index.ts）：
   - 在 BOARD_PORT_SPECS 中登记 V3 可选输出端口：`tone[3:0]`、`screen_x[3:0]`、`screen_y[2:0]`、`screen_data[7:0]`、`screen_cmd[1:0]`。未声明这些可选端口的老模块保持 0 报错（100% 向后兼容）。
   - 在 SimulationSession 中维护 128 字节确定性显存（Uint8Array(128)，reset() 清零），按 docs/DATA_CONTRACTS.md 第 2.2 节语义在每拍提交后根据 screen_cmd 更新显存（00 无操作 / 01 写入 y*16+x / 10 清屏 / 11 清屏并写入）。
   - 当模块声明并使用了 tone 或 screen_* 时：在 SignalSample 中填充 extendedOutputs（tone / screen）与 screenBuffer（128 字节副本），并在 CompileResult.metadata.usedOutputs 中纳入 'tone' 和/或 'screen'。

3. 高速批量步进与 V3 自测/Testbench 升级（simulator.ts / index.ts / selftest.ts）：
   - 实现 `RtlEngine.stepBatch(inputs, steps)`：连续推进 steps 个上升沿（做好 steps 范围保护，如 1..256），仅在末拍重算 NetlistGraph，显著提升带屏小游戏与刷屏刷新效率。
   - 升级 selftest.ts：在保留原有 led/traffic/seg 比对的基础上，支持 TestVectorStep.expectTone（0..15）与 expectScreen（ScreenCellExpectation[] 逐格比对 screenBuffer[y*16+x]）；失配时在 SelfTestFailure 中准确回传 signal: 'tone' | 'screen' 及 screenCoord: { x, y }。
   - 同步升级 exportTestbench(code, vectors)：当模块包含 tone 或 screen_* 端口时，自动在导出的 tb_top.v 中声明并连线对应端口与断言。

4. 全面单测与性能验证（tests/engine.test.ts）：
   - 保持既有全部 129 条单测 100% 通过，并新增 ≥ 35 条 V3 测试：1D/2D 数组读写与 for 初始化、数组越界保护与 MEM 网表聚合、16×8 屏幕写入/覆盖/清屏/清屏并写、蜂鸣器输出、stepBatch 与逐拍一致性及耗时检查、expectTone/expectScreen 通过与失配定位（含 screenCoord）、以及带屏小游戏（如迷你贪吃蛇/跑酷）长周期仿真验证。
   - 提交前确保 npm run test:engine 与 npm run build 全部通过。
```

---

## 三、队友 2（Agent V3：板卡感知动态 Prompt + V3 断言校验 + runId 透传 + 带屏/蜂鸣器旗舰案例，GitHub: `fzd1210-beep`）第三轮提示词

> **专属目录**：`src/agent/`、`tests/agent.test.ts`、参赛文档素材（不修改前端 React、云函数和 `src/engine/` 代码）

```text
请先阅读 docs/PROJECT_PLAN.md、docs/DATA_CONTRACTS.md、src/types/contracts.ts 以及当前 src/agent/ 和 tests/agent.test.ts。项目为 FPGAgent，第二轮最终版与 V3 冻结契约已合入 main，现基于最新 main 启动第三轮开发。

我是负责 agent 分支（feat/agent）的成员，只修改 src/agent/ 和 tests/agent.test.ts。核心原则：Agent 主闭环架构保持稳定不大改，重点聚焦“板卡感知提示词 + V3 断言解析 + runId 透传 + 带屏/蜂鸣器旗舰案例与真实模型评测”。请分步实现：

1. Harness 轻量透传（harness.ts / bugClinic.ts）：
   - 在 runHarness(prompt, options)、diagnose(input, options) 与 injectBug(code, options) 中接收 options.runId 与 options.boardProfile。
   - 将同一 options.runId 原样透传给本轮内所有 llm.chat({ ..., runId }) 调用，配合云函数实现“整个项目生成/修复闭环只扣 1 次每日额度”。
   - 在自测失败摘要与修复提示词中，友好展示 tone 和 screen(x,y) 的首个失配信息（消费 SelfTestFailure.screenCoord），帮助模型精准修好屏幕坐标或字符编码错误。

2. 板卡感知动态 Prompt 与 V3 向量校验（prompts.ts）：
   - 根据传入的 boardProfile?.peripherals 动态构建 top 模块接口说明：
     * 未启用 screen / tone（如经典教学板）时，保持原有精简 8 端口模板，避免多余端口分散模型注意力；
     * 启用 tone 时，注入 `output [3:0] tone` 及 docs/DATA_CONTRACTS.md 第 2.3 节 0..15 音阶/提示音编码表；
     * 启用 screen 时，注入 `screen_x/y/data/cmd` 端口语义、16×8 显存更新规则以及第 2.2 节 0x20..0x7E ASCII 与 0x80..0x8F 全部内置 8×8 图块编码表，并明确引导模型利用定长 reg 数组（如 `reg [3:0] snake_x [0:15]`）和增量刷新（每拍只改移动格，少做整屏重绘）写出简洁、一次编译通过的代码。
   - 升级 normalizeTestVectors：放行并校验 V3 可选字段 `expectTone`（整数 0..15）与 `expectScreen`（数组项 `{ x: 0..15, y: 0..7, code: 0..255 }`），且允许某条测试向量仅通过 expectTone 或 expectScreen 构成有效断言。

3. 新增 V3 零 Token 旗舰预置案例（presets.ts / mockPresets.ts / bugClinic.ts）：
   - 保留原有 5 个经典案例（交通灯、密码锁、序列检测器、秒表、抢答器）100% 兼容并补齐 `boardProfileId: 'classic'`。
   - 新增至少 2 个带 16×8 屏幕 + 蜂鸣器的零 Token 旗舰案例（带完整蓝图、Verilog、逐拍自测向量与故障诊所关卡，并标注 `boardProfileId` 与 `requiredPeripherals`）：
     1. 屏显小游戏案例（如「像素跑酷 / 躲避障碍」或「迷你贪吃蛇」，使用 KEY 控制方向/跳跃、16×8 屏幕显示角色/障碍/分数、蜂鸣器播放得分与碰撞音效，展示数组 + 增量刷屏）；
     2. 屏显互动/文字终端案例（如「交互式电子琴与乐谱屏」或「FPGA 状态信息屏 + 提示音」，展示多行 ASCII 文字渲染与蜂鸣器 1~12 音阶演奏）。
   - 注意：在队友 1 合入 V3 引擎前，先确保新增案例代码严格遵守 V3 契约与现有测试约定；如在联调前需兼容当前 main 的 V2 引擎，请在测试中对 V3 新案例使用符合 V3 契约的 Stub 或待合并后用真引擎全量验通。

4. 离线单测与真实模型评测（tests/agent.test.ts + docs/REAL_MODEL_EVAL.md）：
   - 在 tests/agent.test.ts 补充 V3 单测：覆盖 runId 跨 plan/generate/repair 全程透传、经典/屏显/游戏不同 boardProfile 下动态 Prompt 差异、expectTone / expectScreen 合法与非法输入清洗、screenCoord 失败反馈注入修复 Prompt、以及新旗舰案例结构校验，确保 npm run test:agent 100% 离线通过。
   - 使用本地真实模型（如 qwen3.8-flash / deepseek-v4.1-flash）实测 16×8 文字看板与小游戏需求，记录一次通过率并持续收敛 Prompt，更新参赛评测素材。
```
