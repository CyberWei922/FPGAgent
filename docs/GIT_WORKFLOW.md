# 团队 Git 协同开发指南（防冲突版）

本仓库地址：`https://github.com/CyberWei922/qoderationability`

---

## 1. 目录所有权（绝对防冲突铁律）

三个人只修改自己负责的目录，**不跨界改动别人的业务代码**：

| 成员 | 专属开发分支 | 只修改这些目录 |
| --- | --- | --- |
| **队长（全栈/前端/部署）** | `feat/ui-core` | `src/types/`、`src/components/`、`src/services/`、`src/App.tsx`、`functions/` |
| **队友 1（仿真与验证引擎）** | `feat/engine` | `src/engine/`、`tests/engine.test.ts` |
| **队友 2（AI 闭环与案例库）** | `feat/agent` | `src/agent/`、`tests/agent.test.ts`、`docs/`（参赛文案素材） |

> 如果确实需要改动 `src/types/contracts.ts`，在群里说一声，由队长改完合入 `main`，大家再同步一次即可。

---

## 2. 首次克隆与切分支（两位队友照着敲即可）

```bash
# 1. 克隆仓库
git clone https://github.com/CyberWei922/qoderationability.git
cd qoderationability

# 2. 创建并切换到自己的专属开发分支
# 队友 1 执行：
git checkout -b feat/engine
# 队友 2 执行：
git checkout -b feat/agent
# 队长执行：
git checkout -b feat/ui-core
```

---

## 3. 日常开发、自测与提交流程

每次写完一个小功能（比如队友 1 写完 `parser.ts`，或队友 2 写完交通灯预置案例），按下面 4 步走：

```bash
# 第 1 步：跑自己模块的测试（确保没报错再提交）
# 队友 1：npm run test:engine
# 队友 2：npm run test:agent
# 队长：  npm run build

# 第 2 步：拉取 main 最新进度（防止落后太多）
git fetch origin
git merge origin/main

# 第 3 步：暂存并提交（写清楚改了什么）
git add .
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
