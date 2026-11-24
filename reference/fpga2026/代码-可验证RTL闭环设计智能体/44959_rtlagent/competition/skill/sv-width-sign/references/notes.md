# 位宽与符号用法边界

用于算术、比较、移位、截断相关问题。“输出声明更宽”与“表达式中每一步都没有丢位”不是同一回事；应检查实际表达式上下文，不要把所有加法都机械改写。题目要模运算时必须保留回绕，不能擅改饱和。

原创样例 `signed_widen_add` 将两个有符号 8 位输入分别符号扩展为有符号 9 位，再相加。结果范围 `[-256, 254]` 完整落在 9 位有符号范围内；纯组合、没有时钟、饱和或额外周期。建议检查 `-128 + -128 = -256`、`127 + 127 = 254`、`-1 + 1 = 0`。

`$signed` 不增加位数；拼接结果先进入明确的有符号中间量，避免让后续表达式混入无符号操作数。这里没有声称任何工具告警都代表错误，也没有以消除告警为理由改变数学定义。

来源：[AMD UG901 v2026.1](https://docs.amd.com/r/en-US/ug901-vivado-synthesis/SystemVerilog-Support)；[Sutherland 与 Mills，DVCon 2014 原文](https://sutherland-hdl.com/papers/2014-DVCon_ASIC-FPGA_SV_Synthesis_paper.pdf)，第 16–17 页讨论显式转换与截断。标准入口见 [IEEE 1800-2023](https://standards.ieee.org/ieee/1800/7743/)；本项目未复制标准正文。见 [资料表](../../../docs/systemverilog-sources.md)。
