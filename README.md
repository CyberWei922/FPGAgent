# VibeFPGA Lab · AI 驱动的可验证浏览器虚拟 FPGA 实验室

> **参赛项目**：2026 Qoder 高校创造力大赛 · `StudyHack 学习科研` 赛道  
> **一句话定位**：不用买开发板、不用装 50GB Vivado，打开网页输入一句自然语言，AI 智能体自动规划蓝图、编写 Verilog、在浏览器里完成确定性自测与修复，并以**慢动作门级信号流动画**直观展示电流如何逐级穿过逻辑门、点亮虚拟 FPGA 开发板。

---

## 文档导航

| 文档 | 用途 | 适合谁看 |
| --- | --- | --- |
| [`docs/PROJECT_PLAN.md`](docs/PROJECT_PLAN.md) | 完整项目规划书（产品预期、系统架构、技术方案、三人分工、里程碑与提交清单） | 全体成员 |
| [`docs/DATA_CONTRACTS.md`](docs/DATA_CONTRACTS.md) | 前后端/三模块统一的 TypeScript 数据契约（开发前先冻结） | 全体成员 |
| [`docs/GIT_WORKFLOW.md`](docs/GIT_WORKFLOW.md) | 零冲突 Git 协同开发规范、分支命名与 PR 合并指南 | 全体成员（尤其无 Web 经验队友） |
| [`docs/QODER_PROMPTS.md`](docs/QODER_PROMPTS.md) | 三位成员各自可直接粘贴进 Qoder 的首轮开工提示词 | 队长 / 队友 1 / 队友 2 |
| [`reference/fpga2026/`](reference/fpga2026/) | 往届 FPGA 赛题输入资产（设计报告、技能规范 `skill/`、踩坑库与参考思路） | 队友 1、队友 2 查阅提炼 |

---

## 三人团队分工速览

| 角色 | 负责范围 | 核心目录 | 工作方式 |
| --- | --- | --- | --- |
| **队长（全栈统筹 + 前端 + 云端部署）** | 项目初始化、契约冻结、三栏交互界面、**动态门级信号流画布**、**虚拟 FPGA 板卡与示波器**、Qoder Sites 云函数代理与公网部署 | `src/types/`、`src/components/`、`src/App.tsx`、`functions/` | 全栈开发 + PR 审查合并 + 部署验收 |
| **队友 1（硬件与仿真移植）** | 浏览器纯 TS Verilog 子集解析与周期仿真、AST 转教学门级网表与拓扑分层、6 条前端静态 Lint、确定性自测/首个反例/无回退校验、50+ 条单测 | `src/engine/`、`tests/engine.test.ts` | **零 Web 门槛**：纯 TS 算法，本地运行 `npm run test:engine` 验收 |
| **队友 2（AI 智能体与内容）** | 提炼 `skill/` 规范为 System Prompt & 严格 JSON Schema、前端 Harness 闭环状态机、4–5 个零 Token 预置案例、基于 `rtl-pitfalls` 的「故障诊所」Bug 库与参赛文案 | `src/agent/`、`tests/agent.test.ts` | **零 Web 门槛**：调用队长封装的 `callLLM()`，本地运行 `npm run test:agent` 调优 |

---

## 仓库目录规划（Qoder 初始化后）

```text
qoderationability/
├── docs/                   # 项目规划书、数据契约、Git 协同规范、Qoder 启动提示词
├── reference/fpga2026/     # 参考资料（仅供团队查阅提炼规则，决赛提交源码前可剥离）
├── src/
│   ├── types/              # 【队长冻结】contracts.ts 统一数据接口
│   ├── engine/             # 【队友 1】Verilog 解析、周期仿真、门级网表、Lint、确定性自测
│   ├── agent/              # 【队友 2】Harness 闭环、Prompt/Schema、预置案例、故障诊所
│   ├── services/           # 【队长】极简 callLLM() 客户端与 BYOK 配置封装
│   ├── components/         # 【队长】TopBar、AgentPanel、GateCanvas、FpgaBoard、Waveform
│   └── App.tsx             # 【队长】三栏工作台主入口
├── functions/
│   └── v1/agent.ts         # 【队长】Qoder Sites Server Function（藏 Key + IP 限流代理）
└── tests/
    ├── engine.test.ts      # 【队友 1】50+ 条引擎与 Lint 回归测试
    └── agent.test.ts       # 【队友 2】Prompt JSON 稳定性与闭环验收测试
```

---

## 重要合规提醒（2026 Qoder 高校创造力大赛）

1. **全新代码开发**：`reference/fpga2026/` 仅作为领域知识、规则思想和踩坑证据的参考，新项目的全部应用代码必须由团队在 **Qoder** 中重新设计与编写，并保留各阶段 Qoder 协作截图。
2. **保护密钥安全**：严禁将任何大模型 API Key 提交到本公开仓库，云端密钥统一配置在 Qoder Sites 服务端 Secret 环境变量中。
3. **决赛代码清理**：若进入决赛需提交作品源代码，建议在发布分支移除 `reference/fpga2026/`，保持提交包纯粹干净。
