# FPGAgent · AI 驱动的可验证浏览器虚拟 FPGA 实验室

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

| 角色 | 负责范围 | 核心目录 | 接口与验收 |
| --- | --- | --- | --- |
| **队长（全栈统筹 + 前端 + 云端部署）** | 维护冻结契约、门级信号图、虚拟板卡、波形、模型代理与 Qoder Sites 部署 | `src/types/`、`src/components/`、`src/services/`、`src/App.tsx`、`functions/` | 提供 `LLMClient`，在工作台接入 `RtlEngine` 与 `AgentRuntime`。运行 `npm run build`、`npm run test:platform`。 |
| **队友 1（硬件与仿真移植）** | 纯 TS Verilog 解析、周期仿真、教学网表、Lint、自测与回退定位 | `src/engine/`、`tests/engine.test.ts` | 通过 `createRtlEngine()` 交付真实引擎。运行 `npm run test:engine`，目标至少 50 条回归测试。 |
| **队友 2（AI 智能体与内容）** | Prompt 与 JSON Schema、Harness 闭环、4–5 个离线案例、故障诊所和参赛文案 | `src/agent/`、`tests/agent.test.ts` | 通过 `createAgentRuntime({ llm, engine })` 交付智能体，调用注入的 `llm.chat()` 与引擎。运行 `npm run test:agent`。 |

两位队友可以从 M0 的 `main` 切出各自分支。公共入口和自测语义见 [冻结契约](src/types/contracts.ts) 与 [协作流程](docs/GIT_WORKFLOW.md)。

---

## 本地启动

使用 Node.js 22.13 或更新版本。仓库的 `.npmrc` 将 npm 下载源设为华为云镜像。在仓库根目录运行：

```sh
npm ci
npm run dev
npm test
npm run build
```

FPGAgent 从对话首页开始。可以输入电路需求，也可以点击交通灯或四位密码锁演示。进入仿真后可继续提需求，点击左侧「蓝图」查看电路资料。

首页的两条预设提示词演示生成流程，并使用真实 RTL 引擎编译、验算与运行对应电路，无需 API Key。自由输入和继续修改走真实 Harness。要调用模型，可在「API 设置」保存支持浏览器跨域请求及 `json_object` 响应格式的 OpenAI 兼容服务地址、模型名和 Key。

本地使用「站点默认」模式时，保持 Vite 运行，并在另一终端启动 Deno 代理。先按 `.env.example` 准备 `.env.local`，再运行：

```sh
deno run --env-file=.env.local --allow-net --allow-env=LLM_API_KEY,LLM_BASE_URL,LLM_MODEL,ALLOWED_ORIGINS,DAILY_LIMIT_PER_IP dev/function-local.ts
```

前端通过 `/functions/v1/app/agent` 请求代理。队友 1 可以运行 `npm run test:engine`，队友 2 可以运行 `npm run test:agent`。

## 仓库目录规划

```text
qoderationability/
├── docs/                   # 项目规划书、数据契约、Git 协同规范、Qoder 启动提示词
├── reference/fpga2026/     # 参考资料（仅供团队查阅提炼规则，决赛提交源码前可剥离）
├── src/
│   ├── types/              # 【队长冻结】contracts.ts 统一数据接口
│   ├── engine/             # 【队友 1】Verilog 解析、周期仿真、门级网表、Lint、确定性自测
│   ├── agent/              # 【队友 2】Harness 闭环、Prompt/Schema、预置案例、故障诊所
│   ├── services/           # 【队长】LLMClient 实现与 BYOK 配置
│   ├── components/         # 【队长】TopBar、AgentPanel、GateCanvas、VirtualBoard、Waveform
│   └── App.tsx             # 【队长】三栏工作台主入口
├── functions/
│   └── index.ts            # 【队长】Qoder Sites Edge Function 入口
└── tests/
    ├── engine.test.ts      # 【队友 1】50+ 条引擎与 Lint 回归测试
    └── agent.test.ts       # 【队友 2】Prompt JSON 稳定性与闭环验收测试
```

---

## 重要合规提醒（2026 Qoder 高校创造力大赛）

1. **全新代码开发**：`reference/fpga2026/` 仅作为领域知识、规则思想和踩坑证据的参考，新项目的全部应用代码必须由团队在 **Qoder** 中重新设计与编写，并保留各阶段 Qoder 协作截图。
2. **保护密钥安全**：严禁将任何大模型 API Key 提交到本公开仓库，云端密钥统一配置在 Qoder Sites 服务端 Secret 环境变量中。
3. **决赛代码清理**：若进入决赛需提交作品源代码，建议在发布分支移除 `reference/fpga2026/`，保持提交包纯粹干净。
