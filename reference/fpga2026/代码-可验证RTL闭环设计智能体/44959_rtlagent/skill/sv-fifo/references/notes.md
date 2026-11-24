# 同步 FIFO 的明确协议

本技能只覆盖单时钟 FIFO。异步 FIFO、AXI Stream 包边界、不同读写位宽和跨时钟域均不由这个例子保证。

原创 `sync_fifo4x8` 固定容量 4、数据 8 位，`clk` 上升沿、同步高有效复位。`push = wr_en && !full`，`pop = rd_en && !empty`，条件均看**边沿前**占用量；复位优先且不接受读写。

| 边沿前状态 | 同时请求读写的结果 |
|---|---|
| 空 | 只接受写，读不旁路；该沿 `rd_valid=0` |
| 1–3 个元素 | 两者都接受，读出最老元素，占用量不变 |
| 满 | 只接受读；不会因为本拍将读出就提前允许写入 |

接受读的边沿后，`dout` 更新，`rd_valid=1`；无读时 `dout` 保持，`rd_valid=0`。最后一个元素被读出的同一沿后可同时 `empty=1`、`rd_valid=1`。复位将指针、计数、输出清零，不清 memory；未写槽位在该协议下不可见。二位指针自然模 4 回绕，不能直接改成非二次幂深度。

验证建议覆盖空读、满写、三种同时请求、填满后连续排空、多轮回绕、非空复位和数据顺序。它不是 XPM 的替代实现：XPM 的标志延迟、复位忙信号与可选模式不同。

来源：[AMD UG974 v2026.1 / XPM_FIFO_SYNC](https://docs.amd.com/r/en-US/ug974-vivado-ultrascale-libraries/XPM_FIFO_SYNC)，用于核对边界接受条件与读模式区别；[UG901 v2026.1](https://docs.amd.com/r/en-US/ug901-vivado-synthesis)，用于 RAM 读写时序背景。上述小 FIFO 协议与代码由本项目原创，资源映射以工具报告为准。见 [资料表](../../../docs/systemverilog-sources.md)。
