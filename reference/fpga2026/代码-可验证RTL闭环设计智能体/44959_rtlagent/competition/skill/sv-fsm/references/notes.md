# 状态机用法边界

本技能适用于状态转移与输出差一拍问题。Moore/Mealy 是功能选择，不应仅为套用“两段式/三段式模板”改变题目要求。综合器可能重编码；不能把 RTL 的 `default` 分支当成经过验证的单粒子翻转恢复机制。

原创样例 `moore_job_control` 使用同步高有效 `rst`。IDLE 只在上升沿采纳 `start` 并进入 BUSY；BUSY 时 `busy=1`，在采到 `finish` 的上升沿进入 DONE；DONE 的 `done=1` 恰好保持一个状态周期，下一上升沿回 IDLE。`start` 在 BUSY/DONE 被忽略；IDLE 的 `finish` 被忽略。若 `start` 一直为高，回 IDLE 后下一沿可再次启动。输出由当前状态组合译码，不额外注册。

建议检查启动与完成同高、完成持续高、忙中复位和 `done` 单周期宽度。样例控制协议是原创约定，不是所有握手电路的规则。顶层/时钟见索引，5 ns 仅作样例约束。

来源：[AMD UG901 v2026.1](https://docs.amd.com/r/en-US/ug901-vivado-synthesis/SystemVerilog-Support)；[Sutherland 与 Mills，DVCon 2014 原文](https://sutherland-hdl.com/papers/2014-DVCon_ASIC-FPGA_SV_Synthesis_paper.pdf)，第 6–7 页的枚举类型讨论。见 [资料表](../../../docs/systemverilog-sources.md)。
