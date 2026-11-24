# 组合逻辑用法边界

本技能针对完整赋值、优先级与多驱动，不把题目明确要求的锁存器改造成组合电路。`always_comb` 表达组合意图，并不会替作者补齐遗漏分支；`unique` 也不是“消除 latch”的开关。

原创样例 `priority_word_mux` 输入三路 8 位数据及 `req[2:0]`。优先级为 `req[2] > req[1] > req[0]`，分别选 `word2/word1/word0`。无请求时 `valid=0, selected=0, data=0`；`selected=0` 只有在 `valid=1` 时代表选择第零路。无时钟、无延迟承诺。

验证至少覆盖 `req=000、001、010、100、011、111`；修改 `word*` 时不需要额外时钟。样例默认值与优先级不可替代新题目的要求。

来源：[Sutherland 与 Mills，Can My Synthesis Compiler Do That?](https://sutherland-hdl.com/papers/2014-DVCon_ASIC-FPGA_SV_Synthesis_paper.pdf)，DVCon 2014；[AMD UG901 v2026.1](https://docs.amd.com/r/en-US/ug901-vivado-synthesis/SystemVerilog-Support)。来源介绍过程块与分支语义，本项目自行选择简洁 mux 例子。见 [资料表](../../../docs/systemverilog-sources.md)。
