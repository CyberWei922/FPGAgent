# 时序逻辑用法边界

适用于寄存器、使能、复位和旧值/新值混淆。规格优先：题目要求异步复位时，不能因为综合指南倾向同步复位就改掉接口行为；不得擅加同步器或流水级。

原创样例 `enabled_word` 是默认 8 位、`WIDTH >= 1` 的使能寄存器。`rst_n` 为**同步低有效**复位，优先于 `load`；仅在 `clk` 上升沿更新，`load=0` 保持。首次有效复位前不承诺初值。它不是任何计数器题目的参考答案。

验证建议：在非零状态下同时拉低 `rst_n`、拉高 `load`，应复位；两次上升沿之间改变复位不应立即改变 `q`。索引中的 5 ns 只用于样例综合时钟约束。

来源：[AMD UG901 v2026.1](https://docs.amd.com/r/en-US/ug901-vivado-synthesis/SystemVerilog-Support)；[Sutherland 与 Mills，DVCon 2014 原文](https://sutherland-hdl.com/papers/2014-DVCon_ASIC-FPGA_SV_Synthesis_paper.pdf)，第 3–4 页。此处是针对项目的短规则与原创例子，不复制来源代码。完整来源范围见 [资料表](../../../docs/systemverilog-sources.md)。
