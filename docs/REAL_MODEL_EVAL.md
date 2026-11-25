# 真实模型评测清单（V2）

> 执行人：队友 2　｜　分支：`feat/agent`　｜　用例文件：[tests/realModel.eval.test.ts](../tests/realModel.eval.test.ts)
> 目标：用真实大模型跑通 3 个全新电路 + 每条一次追改，证明多轮上下文、自动修复与结果字段在真实链路可用。

## 1. 前置条件

1. 本地存在 `.env.local`（已被 `.gitignore` 的 `.env.*` 覆盖，**严禁提交**）：

```bash
LLM_API_KEY=你的测试Key
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_MODEL=deepseek-chat
```

第二家模型（GLM / 通义）评测时只改 `LLM_BASE_URL` 与 `LLM_MODEL` 重跑，不需要改代码。
`vite.config.ts` 只把 `LLM_` 前缀变量注入测试进程；显式开关 `EVAL_REAL=1` 用于防止误跑消耗 Token。

> 注意：当前 `createProxyClient` / `createDirectClient` 尚未把单次调用的 `options.model` 发给上游，模型由 `LLM_MODEL` 决定；UI 侧模型切换要等队长补齐该透传后才会生效。

## 2. 运行命令

Git Bash：

```bash
EVAL_REAL=1 npx vitest run tests/realModel.eval.test.ts --reporter=verbose
```

PowerShell：

```powershell
$env:EVAL_REAL="1"; npx vitest run tests/realModel.eval.test.ts --reporter=verbose
```

未设置 `EVAL_REAL=1` 或没有 `LLM_API_KEY` 时，该文件整组跳过，`npm test` 不消耗 Token。

## 3. 评测案例

| # | 电路 | 初始需求要点 | 追改指令 | 考察点 |
| --- | --- | --- | --- | --- |
| 1 | PWM 调光灯 | `sw[1:0]` 四档占空比 25/50/75/100%，`led[0]` 输出 PWM，`led[7:4]` 显示档位，复位默认 50% | 默认档改 25%，`traffic[0]` 在 100% 档常亮 | 计数器分频、档位映射、改默认值不破坏其他行为 |
| 2 | 按键长短按检测器 | KEY0 连续按住 8 拍为长按；短按 LED0 亮 2 拍，长按 LED1 亮 3 拍；`seg` 显示按住拍数 | 阈值改 4 拍，短按指示改 LED2 | 边沿检测、计时器重置、追改只动局部 |
| 3 | 两位 BCD 加减计数器 | KEY0 加一、KEY1 减一；`sw[0]` 控制 99→00 / 00→99；`seg[7:0]` 两位 BCD；99 时常亮 | 增加 KEY2 清零；常亮条件改成 ≥90 | BCD 进位借位、按键脉冲、新增按键不引入锁存 |

三个题目均不在预置案例内，用于验证泛化而不是背题库。

## 4. 自动断言（每条电路）

初始生成：

- `result.ok === true`（Lint 无 error 且确定性自测全过）
- trace 出现 `planning:pass`、`coding:pass`、`done:pass`
- `blueprint.behaviors`、`testVectors` 非空
- `assistantSummary` 非空，`suggestedFilename` 以 `.v` 结尾

追改（携带 `previousContext`：蓝图 + 代码 + 向量 + 简短历史）：

- `result.ok === true`
- trace 出现 `planning:pass`、`done:pass`
- `assistantSummary` 非空，`suggestedFilename` 以 `.v` 结尾

`repairRounds`、耗时、`modelUsed`、断言通过数由 `[eval]` 日志输出，作为质量观察项记录，不作为硬门槛。

## 5. 结果记录模板

| 日期 | 模型 | 案例 | 初始 ok | 初始修复轮数 | 初始断言 | 追改 ok | 追改修复轮数 | 追改断言 | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-11-25 | deepseek-chat | PWM 调光灯 |  |  |  |  |  |  |  |
| 2026-11-25 | deepseek-chat | 长短按检测器 |  |  |  |  |  |  |  |
| 2026-11-25 | deepseek-chat | BCD 加减计数器 |  |  |  |  |  |  |  |

要求：至少 1 家模型全部通过；若时间允许，用第二家模型完整重跑并补一张表。通过后把结论回填到 [TEAMMATE2-DELIVERY.md](TEAMMATE2-DELIVERY.md) 第 6 节，并保留一次 `--reporter=verbose` 输出截图作为 M4 素材。

## 6. 失败排查

| 现象 | 含义 | 处理 |
| --- | --- | --- |
| 报 `NOT_CONFIGURED` | Key 未注入或被判非法 | 检查 `.env.local` 变量名与 Base URL 是否 https |
| 报 `QUOTA_EXCEEDED` / 429 | 账号限流或额度用尽 | 换 Key/换模型，或隔日重跑 |
| 报 `TIMEOUT` | 单次生成超时 | 重跑该案例；连续出现则记录 prompt 与轮次反馈给队友 2 |
| `initial.ok=false` 且修复 2 轮仍失败 | 模型能力/子集限制 | 记录 `assistantSummary` 与 trace 截图，判断是题目过难还是回归缺陷 |
| 追改后行为被破坏 | 多轮上下文未生效 | 记录追改前后代码 diff，反馈给队友 2 |
| `BAD_RESPONSE` | JSON 解析失败 | 属容错范围外的新格式，保留原始输出（勿含 Key）反馈 |

## 7. 成本与时长

每条电路 2 次 harness（初始 + 追改），每次 2–6 次模型调用；3 条合计约 12–24 次调用，DeepSeek 下单轮通常 1–3 分钟。建议集中一次跑完，避免中断。

## 8. 当前阻塞

- 云端代理链路（队长）：云函数部署与 Secret 未配置前，只能用本地 `.env.local` 直连评测
- UI 链路（队长）：模型选择器、查阅开关、`modelUsed`/额度/trace 来源展示尚未接入，评测目前走无头用例而非页面