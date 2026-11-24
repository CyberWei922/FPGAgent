# 比赛环境版本

原目标来自2026-10-15会议PPT的 **W7900/gfx1100验证镜像**，记录在 versions.json，不是决赛R9700镜像的已确认版本。10月17日实测实例另有具名清单，详见文末；通过 RTL_ENVIRONMENT_PROFILE 显式选择。

这些是PPT公布的镜像预装版本；本项目选择它们作为当前验证目标，不据此新增“其他兼容版本一律违规”的比赛规则。

| 组件 | 验证期目标 |
| --- | --- |
| Ubuntu | 24.04 |
| Python | 3.14，允许该系列补丁版本 |
| ROCm用户态 | 10.0.0 |
| HIP | 7.15，允许补丁版本 |
| PyTorch | 2.12.0+rocm10.0.0 |
| vLLM | 0.27.1 |
| llama.cpp | b1326，官方ROCm预编译版 |
| Vivado | 2026.1 |
| 项目额外需要的Node.js | 24系列；Docker固定24.15.0 |

## 云实例怎么用

1. 在官方云实例解压验证包，准备本地权重。
2. 将 cloud.env.example 复制为 competition/config/cloud.local.env，填写令牌、模型名、权重及llama-server路径，然后在终端 source 该文件。
3. 运行包根目录 `bash serve/check-environment.sh --image`：检查镜像各组件，保存实测JSON；发现不一致时会列出实际版本。
4. 运行 `bash serve/start.sh`。启动器会自动检查当前推理路线所需版本，版本不符时先停止，避免跑题后才暴露问题。

在开发仓库中，对应脚本位于 competition/serve/。检查结果默认保存到 SERVICE_STATE_DIR/environment.json；不记录令牌，不下载模型，不联网安装依赖。

默认GGUF/llama.cpp路线不使用PyTorch或vLLM，启动检查会记录它们但不把未使用组件的不匹配当作运行障碍。`--image`全量检查要求这些组件与当前所选清单一致；未选择时使用PPT清单。vLLM路线则严格检查PyTorch版本与其HIP构建；CPU版或CUDA版不能替代。

llama.cpp除核对所选清单的版号与声明的二进制哈希，还要通过--list-devices识别ROCm设备；同版号的CPU版也不能通过正式启动检查。设备枚举不是模型推理测试，不作为GPU性能验收。

## 今天已准备与边界

- Python脚本只依赖标准库，没有额外pip依赖。
- ROCm、PyTorch、vLLM由官方镜像提供，不通过普通PyPI安装包覆盖。constraints.txt只约束今后新增的Python依赖，并不是安装清单。
- Docker 构建检查 Python 3.14；ROCm/HIP 与实际使用的推理后端在启动前核验。PyTorch/vLLM 另由全量镜像检查记录，GGUF 路线不安装或覆盖它们。
- 官方run_baseline.sh保持原样，仍调用python3；检查器也会核对这个解释器为3.14，避免Agent与基线误用不同环境系列。
- 本机Windows旧ROCm7.14脚本继续作为历史开发工具；正式云端配置不引用Windows运行库路径。
- Python3.14的本地测试可独立执行，不能代替Linux/GPU兼容测试。官方镜像、目标 GPU 显存峰值与 Linux EDA 授权须用真实云实例验证。
- 所有版本通过检查也不等于已完成GPU、功能、离线或R9700验收；manifest中这些状态继续保持待验收。

官方镜像标签以及R9700最终版本仍需后续公告。公告变化后更新具名版本清单并重新验收，不把旧验证期目标静默当成决赛版本。

## 2026-10-16 本地准备结果

WSL Ubuntu 24.04.4 已独立准备 CPython 3.14.8、Node 24.15.0、ROCm 10.0.0、HIP 7.15.26333。没有替换 Ubuntu 系统 Python，没有安装 PyTorch/vLLM。7800 XT 的 GPU 枚举、GGUF 加载与 HIP 显存读取已实际执行。

本地 llama.cpp 采用上游 b10423 源码归档，程序实际报 build 0，精确来源见 [MODEL.md](../model/MODEL.md)。这是本地兼容性验证构建，尚未满足镜像 b1326 版本目标；正式检查器仍保留该目标，没有修改检测结果来放行。

官方 Ross MCP 2026.9.1 的 Windows/Linux 文件均核对官方 MD5，并记录 SHA256，见 [official-mcp.json](official-mcp.json)。默认云端验证配置现选择自制持久版 `fixed_persistent`；原自制 `fixed` 与官方 `amd_ross` 均可显式切换。本地 Windows 已做多轮真实对照、故障恢复与启动超时测试，Linux Vivado 全链路仍待云实例。官方程序保留在包内 `competition/vendor/ross/vivado-mcp-server-linux-amd64-2026.9.1` 作为备选，Linux MCP 的协议与工具枚举此前已通过。

本地开发准备脚本在本目录，Q4/Windows EDA 桥接在 `competition/development/`；两者不导入正式包。大文件写入前会检查 WSL 所在的 Windows 物理盘空间，避免只看虚拟磁盘显示的 1 TB 容量。WSL 已从 C 盘迁至 F 盘，继续用原来的 Ubuntu 名称进入。

## 2026 年 10 月 17 日云实例补充

官方 FAQ 明确验证实例为 W7900 系列 48 GB、16 核 CPU、55 GB 内存，方案仍按单卡 32 GB 设计。/workspace 是 25 GB 持久盘，权重放 /workspace/models；/tmp 是 4 GB 内存盘，EDA_TMP 使用 /var/tmp/eda，AGENT_TMP、SELFTEST_TMP 和 TMPDIR 使用 /var/tmp。重启仅保留 /workspace。

授权地址默认 2100@vivado-lic.fpgachina.svc.cluster.local，FLEXLM_TIMEOUT=300000000；在启动服务前设置，真实席位仍需仿真和综合确认。镜像自带 llama.cpp 还需核对 ROCBLAS_TENSILE_LIBPATH=/opt/llamacpp/rocblas/library 并启用 --jinja。cloud.env.example 已同步这些值；实际工具版本继续采集并与 versions.json 比较，不伪记为通过。

实际首个 W7900D 实例的预装构建与 PPT 有差异：Python 3.14.7、vLLM 0.27.1.dev5+gf46a9dfe2.d20260827.rocm100、llama.cpp build 1 / f114f91。已另建 versions-cloud-w7900d-20261017.json，并固定 llama-server 的完整 SHA256；通过 RTL_ENVIRONMENT_PROFILE 显式选择，不覆盖原 PPT 目标。本次实测版本核对和三道参考题 L3 已通过，模型与完整验收另记。
