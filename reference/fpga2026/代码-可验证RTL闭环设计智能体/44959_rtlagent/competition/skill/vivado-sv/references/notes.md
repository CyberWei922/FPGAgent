# Vivado 支持范围与阶段边界

以 Vivado 2026.1 为准。不能仅据 IEEE 1800-2023 的语言定义推断 Vivado 对全部构造的仿真与综合支持。`xvlog -sv` 与综合端 `read_verilog -sv` 是解析模式；模块功能出错时不能只改文件后缀，也不能绕过失败阶段。

原创 `tiny_sync_rom` 是 4x8 常量表：地址 0、1、2、3 对应十六进制 `12、A5、3C、96`，拼接中左项为高四位。`en=1` 时在上升沿更新输出，`en=0` 保持；没有复位，首次有效读取前输出未定义。这个小表通常适合逻辑资源，但具体映射由综合决定，不承诺推断为块 RAM。题目需要异步读或复位时必须改写，不能套用样例周期。

顶层 `tiny_sync_rom`，`clk`，样例时钟约束 5 ns。5 ns 不是 `timescale`，不是行为模型中的延时，也不等于时序已经收敛。编译、功能仿真和综合各有独立结论；许可证、工具路径或版本错误应交给外层控制器，不能用 RTL 修复。

来源：[UG900 v2026.1，Standalone SystemVerilog](https://docs.amd.com/r/en-US/ug900-vivado-logic-simulation/Running-SystemVerilog-in-Standalone-or-prj-Mode)；[UG901 v2026.1，SystemVerilog Support](https://docs.amd.com/r/en-US/2026.1/ug901-vivado-synthesis/SystemVerilog-Support)；[IEEE 1800-2023 标准入口](https://standards.ieee.org/ieee/1800/7743/)。此处没有复制标准或厂商实例。见 [资料表](../../../docs/systemverilog-sources.md)。
