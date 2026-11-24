# MODEL.md

本文件与 `manifest.json`、`REPORT.md` 保持一致。更新于 2026-10-28。

方案使用一个主模型和两个辅助模型，三者都是本地开源权重，运行在同一张 GPU 上，由 `serve/start.sh` 用 llama.cpp 启动：

- **主模型** SiliconMind-V1-Qwen3-8B：唯一写 RTL 的模型。官方基线 `run_baseline.sh` 使用同一个服务、同一份量化、同一套上下文与思考设置。
- **辅助模型** Qwen3.8-27B：做规划、为自测选择检查方法并填写参数、复核和失败诊断。**不生成代码**；测试台和期望值由程序（CPU）根据它填写的结构化参数计算。
- **辅助模型** Qwen3.8-27B-DSpark：27B 的推测解码草稿头，只在 27B 进程内部加速推理，不单独产生输出。

## 1. 模型（主模型）

| 项 | 内容 |
| --- | --- |
| 模型名称 | SiliconMind-V1-Qwen3-8B（服务名 `siliconmind-v1-qwen3-8b-q6-cloud`） |
| 基座 | AS-SiliconMind/SiliconMind-V1-Qwen3-8B（Qwen3-8B 系列的硬件代码模型） |
| 来源 | https://huggingface.co/thuniverse-ai/SiliconMind-V1-Qwen3-8B-GGUF |
| 版本号（revision） | `11a6c35ef3693c18c32bc82c30599de9a5d0a61e` |
| 文件 | `SiliconMind-V1-Qwen3-8B-Q6_K.gguf`，6,725,899,744 字节 |
| 权重校验和 | `sha256: 8c31e966b4cd1cff7d309513a571c7fff0cf5a9e4f8f277af1026635516b3921` |
| 参数量 | 8B |
| 许可证 | Apache-2.0 |

## 2. 量化与显存

| 项 | 内容 |
| --- | --- |
| 量化方式 | GGUF Q6_K（主模型）；UD-Q4_K_M（27B）；Q4_K_M（DSpark 草稿） |
| 量化工具与版本 | 使用发布方的公开量化文件，本团队未重新量化 |
| **实测显存占用** | 三个模型同时加载、连续解题时峰值 **31.28 GiB**（全卡已用显存，含运行时开销） |
| 各进程显存（加载完成后） | 8B 主模型进程 10.73 GiB；27B 辅助模型进程（含 DSpark 草稿头）19.63 GiB；全卡合计 30.40 GiB。解题中 KV 缓存与临时缓冲上升，峰值见上一行 |
| 测量方式 | 全卡：`rocm-smi --showmeminfo vram`，每 2～5 秒采样，60 题全量、90 题配对、145 题全量（峰值 31.18 GiB）与多轮小样本实测；各进程：`rocm-smi --showpids`（2026-10-28，封存候选版本） |
| 测量硬件 | Radeon PRO W7900（赛事方 Radeon Cloud 实例，即初赛与决赛环境） |

## 3. 上下文配置

| 项 | 主模型 8B | 辅助模型 27B |
| --- | --- | --- |
| `--ctx-size` | 32768，`--parallel 2`，`--kv-unified`（两个槽共享，单个请求最多可用 32768） | 20480，`--parallel 1` |
| 单次输出上限 | 智能体 12288（`LLM_MAX_TOKENS`）；基线 16384（`baseline.py` 原样） | 6144 |
| RoPE 外推 | 无 | 无 |
| 思考设置 | 开启（`manifest.json` → `generation`：`enable_thinking: true`），服务级思考预算 2048 token；智能体与基线一致 | 开启，思考预算 2048 token |

基线请求的题面加 16384 输出不超过 32768，满足 FAQ Q22 的要求。

## 4. 推理栈

| 项 | 内容 |
| --- | --- |
| 后端 | llama.cpp（镜像预装的 `/opt/llamacpp/llama-server`，build f114f91，sha256 `290708d22f8b495d36b8aedd0afb0cdc081c415548f855e6a950a75dd742ad97`） |
| 关键启动参数 | 见 `competition/serve/start.mjs` 与 `competition/serve/dual-models.mjs`：`--n-gpu-layers 999 --split-mode none --jinja --reasoning on --reasoning-budget 2048`；27B 另加 `--spec-type draft-dspark --spec-draft-n-max 7` |
| 并发策略 | 单卡两个 llama.cpp 进程：8B 在 127.0.0.1:8000（两槽，用于并行重抽候选），27B 在 127.0.0.1:8001（单槽）；投题服务在 127.0.0.1:7860 串行处理请求 |
| 采样 | 智能体：8B temperature 1.0；27B temperature 0.8、top_p 0.95；其余采样参数取 llama.cpp 服务端默认值（8B top_p 0.95，两者 top_k 40、min_p 0.05、repeat_penalty 1.0）。基线：`baseline.py` 原样（temperature 0、top_p 1.0） |
| 8B 采样插件 | `third_party/llama-author-control`：仅预加载到 8B 进程、仅作用于带标记的智能体请求（分阶段 DRY 与有界收束提示），基线请求不受影响；后端版本不符时自动不加载 |

## 5. 微调

否。三个模型均直接使用公开发布的权重。

## 6. 辅助模型

| 项 | Qwen3.8-27B | Qwen3.8-27B-DSpark 草稿 |
| --- | --- | --- |
| 名称与用途 | `qwen3.8-27b-q4-cloud`：规划、自测方法选择与参数、语义复核、失败诊断；不生成 RTL | `qwen3.8-27b-dspark-draft`：27B 的推测解码草稿，仅用于加速 27B |
| 基座 / 参数量 | Qwen3.8-27B / 27B | RadixArk/Qwen3.8-27B-DSpark / 草稿头 |
| 来源与版本 | https://huggingface.co/unsloth/Qwen3.8-27B-GGUF ，revision `287999af67436bfaa4f4ee09dc34af328a495ba6`，文件 `Qwen3.8-27B-UD-Q4_K_M.gguf`（16,464,440,224 字节，sha256 `322e194ff79741c7baa497c240f677f54b201b0efab44ca8e50f122b39123482`），Apache-2.0 | https://huggingface.co/Anbeeld/Qwen3.8-27B-DSpark-GGUF ，revision `77843de41a67edb1c6294d641ea38fa78f9c8124`，文件 `Qwen3.8-27B-DSpark-Q4_K_M.gguf`（1,104,595,648 字节，sha256 `02307a130d58ad478996c640753f2fe5f813f548c48e1881b7df56506ca7d545`），许可证见上游模型卡 |
| 运行位置与显存 | 同一张 GPU，llama.cpp 127.0.0.1:8001；与草稿头同一进程，加载后 19.63 GiB（权重约 15.3 GiB + KV 缓存与运行时） | 同一张 GPU，加载在 27B 进程内；权重约 1.03 GiB，计入左侧 19.63 GiB |
| 是否经训练或微调 | 否 | 否 |
| 权重位置 | 公开地址，见上 | 公开地址，见上 |

## 7. 声明

- [x] 上述模型为可本地部署的开源权重，非商用 API
- [x] 单卡运行；三个模型合计实测峰值 31.28 GiB
- [x] `run_baseline.sh` 使用与 `run.sh` 完全相同的主模型、量化方式与上下文配置
- [x] 未经微调
- [x] 本文件内容与 `manifest.json` 一致；`REPORT.md` 将在作品提交前同步
