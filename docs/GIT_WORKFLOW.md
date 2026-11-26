# 团队 Git 协同开发指南（第三轮 · V3 契约防冲突版）

本仓库地址：`https://github.com/CyberWei922/FPGAgent`

---

## 1. 目录所有权（绝对防冲突铁律）

三个人只修改自己负责的目录，**不跨界改动别人的业务代码**：

| 成员 | 专属开发分支 | 负责范围 | 第三轮（V3）核心交付 |
| --- | --- | --- | --- |
| **队长（全栈/前端/云函数/部署）** | `feat/ui-core` | `src/types/`、`src/components/`、`src/services/`、`src/App.tsx`、`functions/`、`tests/function.test.ts`、`tests/llmClient.test.ts`、`tests/streaming.test.ts`、工程配置 | 维护 V3 冻结契约；云函数限流改为每日 6 次且按 `runId` 单项目扣 1 次；左侧「诊所」升级为「板卡配置」；中间主视区新增 16×8 OLED Canvas 屏幕视图（可切回门级网表）与高速档位、Web Audio 蜂鸣器与方向键操控；完成联调与 Qoder Sites 公网发布。 |
| **队友 1（仿真与验证引擎）** | `feat/engine` | `src/engine/`、`tests/engine.test.ts` | 保留 `createRtlEngine(): RtlEngine` 导出；引擎新增 1D/2D 定长寄存器数组支持、`tone`/`screen_*` 可选端口与 128 字节内置显存状态机、`stepBatch` 高速批量步进、`expectTone`/`expectScreen` 自测断言、`MEM` 网表聚合节点与 `tb_top.v` 同步升级，通过 ≥160 条全量单测。 |
| **队友 2（AI 闭环与案例库，GitHub: `fzd1210-beep`）** | `feat/agent` | `src/agent/`、`tests/agent.test.ts`、参赛文档素材 | 保留 `createAgentRuntime({ llm, engine, research }): AgentRuntime` 导出；在核心编排不改动的前提下透传 `runId` 与 `boardProfile`；按板卡配置动态注入屏幕/蜂鸣器协议与数组规范；扩展 `normalizeTestVectors` 支持 `expectTone`/`expectScreen`；新增 2+ 个带屏/带蜂鸣器零 Token 旗舰案例并通过真实模型评测。 |

接口以 [冻结契约](../src/types/contracts.ts) 为准，行为约定见 [数据契约说明](DATA_CONTRACTS.md)。涉及公共字段或跨目录调整时，由队长协调合入 `main`，两条开发分支再同步。**第三轮开发统一在 V3 契约与分工文档合入 `main` 后，从最新 `main` 拉齐各自开发分支再开工。**

---

## 2. 同步最新基线与切分支（两位队友照着敲即可）

```bash
# 首次克隆
git clone https://github.com/CyberWei922/FPGAgent.git
cd FPGAgent
npm ci
npm test
```

已有本地仓库时，先同步最新 `main`（含第二轮最终版与 V3 冻结契约），再合并到各自开发分支：

```sh
git fetch origin
git switch main
git pull --ff-only origin main
npm ci
npm test
```

随后只执行与自己角色对应的那一条命令：

| 成员 | 切到并同步开发分支 | 模块验收命令 |
| --- | --- | --- |
| 队长 | `git switch -C feat/ui-core main`（或 `git switch feat/ui-core && git merge main`） | `npm run build`、`npm run test:platform` |
| 队友 1 | `git switch -C feat/engine main`（或 `git switch feat/engine && git merge main`） | `npm run test:engine` |
| 队友 2 | `git switch -C feat/agent main`（或 `git switch feat/agent && git merge main`） | `npm run test:agent` |

---

## 3. 日常开发、自测与提交流程

每次写完一个小功能（比如队友 1 写完寄存器数组解析，或队友 2 写完动态屏幕 Prompt），按下面 4 步走：

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
git commit -m "feat(engine): 支持 1D/2D 定长寄存器数组与 16x8 屏幕显存仿真"

# 第 4 步：推送到自己的远程分支
git push -u origin HEAD
```

推上去之后，在 GitHub 仓库页面点击 **Compare & pull request** 提一个 PR 到 `main`，通知队长审查合并。

---

## 4. Commit 信息规范（简洁明了）

- `feat(engine): ...` — 仿真引擎/数组/外设显存/网表/Lint 新功能
- `feat(agent): ...` — Prompt/Harness/板卡协议/预置案例新功能
- `feat(ui): ...` — 前端板卡配置/16×8 屏幕/蜂鸣器/门级动画新功能
- `feat(platform): ...` — 云函数限流/双渠道容灾/部署配置
- `fix(...): ...` — 修复 Bug
- `test(...): ...` — 补充单元测试
- `docs: ...` — 更新契约、升级计划或参赛材料

---

## 5. 两条绝对红线

1. **严禁提交任何 API Key / `.env` / `.qoder.site` 本地配置文件**：本仓库为公开仓库，本地调试密钥只能放在 `.env.local`（已被 `.gitignore` 忽略），提交前用 `git status` 检查一遍。
2. **全程使用 Qoder 开发并随手截图**：每完成一个核心模块或修掉一个关键 Bug，截一张 Qoder 对话/代码生成/测试通过的图存进本地文件夹，最终交给队友 2 汇总写进天池参赛帖。
