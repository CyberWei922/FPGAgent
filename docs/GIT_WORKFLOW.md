# 团队 Git 协同开发指南（防冲突版）

本仓库地址：`https://github.com/CyberWei922/qoderationability`

---

## 1. 目录所有权（绝对防冲突铁律）

三个人只修改自己负责的目录，**不跨界改动别人的业务代码**：

| 成员 | 专属开发分支 | 负责范围 | 接口交付 |
| --- | --- | --- | --- |
| **队长（全栈/前端/部署）** | `feat/ui-core` | `src/types/`、`src/components/`、`src/services/`、`src/App.tsx`、`functions/`、工程配置及平台测试 | 维护 V2 契约、多服务商 API 预设/模型列表与云端 `WebResearchClient` 代理，向 Agent 注入 `{ llm, engine, research }`，升级设置面板、对话切模型与工作台布局。 |
| **队友 1（仿真与验证引擎）** | `feat/engine` | `src/engine/`、`tests/engine.test.ts` | 保留 `createRtlEngine(): RtlEngine` 导出，完善网页端 Verilog 子集编译/仿真、补齐 `levelNarrations`/`metadata`/`exportTestbench`，并通过 ≥120 条广范围回归与异常压测。 |
| **队友 2（AI 闭环与案例库）** | `feat/agent` | `src/agent/`、`tests/agent.test.ts`、参赛文案素材 | 保留 `createAgentRuntime({ llm, engine, research }): AgentRuntime` 导出，实现多模型透传与国产模型容错、联网检索/网页读取与降级、多轮增量修改和真实模型评测。 |

接口以 [冻结契约](../src/types/contracts.ts) 为准，行为约定见 [数据契约说明](DATA_CONTRACTS.md)。涉及公共字段或跨目录调整时，由队长协调合入 `main`，两条开发分支再同步。**第二轮开发统一在 V2 契约合入 `main` 后，从最新 `main` 拉齐各自开发分支再开工。**

---

## 2. 首次克隆与切分支（两位队友照着敲即可）

```bash
# 首次克隆后进入仓库，安装依赖并验证 M0 基线
git clone https://github.com/CyberWei922/qoderationability.git
cd qoderationability
npm ci
npm test
```

已有本地仓库时，先在 `main` 执行 `git pull --ff-only`，再运行 `npm ci` 和 `npm test`。从更新后的 `main` 创建与自己分工对应的分支，只执行下表中的一条命令。

| 成员 | 创建开发分支 | 模块验收 |
| --- | --- | --- |
| 队长 | `git switch -c feat/ui-core` | `npm run build`、`npm run test:platform` |
| 队友 1 | `git switch -c feat/engine` | `npm run test:engine` |
| 队友 2 | `git switch -c feat/agent` | `npm run test:agent` |

```sh
# 若本地已有开发分支，以队友 1 为例，切回分支并合入最新基线
git switch feat/engine
git merge main
```

---

## 3. 日常开发、自测与提交流程

每次写完一个小功能（比如队友 1 写完 `parser.ts`，或队友 2 写完交通灯预置案例），按下面 4 步走：

```bash
# 第 1 步：跑自己模块的测试（确保没报错再提交）
# 队友 1：npm run test:engine
# 队友 2：npm run test:agent
# 队长：  npm run build && npm run test:platform

# 第 2 步：拉取 main 最新进度（防止落后太多）
git fetch origin
git merge origin/main

# 第 3 步：暂存本次改动的明确文件，提交前检查暂存区（以队友 1 为例）
git add src/engine/simulator.ts tests/engine.test.ts
git diff --cached --check
git diff --cached --stat
git commit -m "feat(engine): 完成 always 块周期仿真与波形记录"

# 第 4 步：推送到自己的远程分支
git push -u origin HEAD
```

推上去之后，在 GitHub 仓库页面点击 **Compare & pull request** 提一个 PR 到 `main`，通知队长审查合并。

---

## 4. Commit 信息规范（简洁明了）

- `feat(engine): ...` — 仿真引擎/网表/Lint 新功能
- `feat(agent): ...` — Prompt/Harness/预置案例/故障诊所新功能
- `feat(ui): ...` — 前端板卡/门级动画/界面新功能
- `fix(...): ...` — 修复 Bug
- `test(...): ...` — 补充单元测试
- `docs: ...` — 更新文档或参赛材料

---

## 5. 两条绝对红线

1. **严禁提交任何 API Key / `.env` 文件**：本仓库目前为公开仓库，本地调试用的密钥只能放在 `.env.local`（已被 `.gitignore` 忽略），提交前用 `git status` 检查一遍。
2. **全程使用 Qoder 开发并随手截图**：每完成一个核心模块或修掉一个关键 Bug，截一张 Qoder 对话/代码生成/测试通过的图存进本地文件夹，最终交给队友 2 汇总写进天池参赛帖。
