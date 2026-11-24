---
name: sv-width-sign
description: Diagnose arithmetic width, signedness, extension, shift, and truncation errors in RTL.
---

- Record each operand's width and signedness, the required intermediate range, and the specified output overflow behavior.
- A negative based literal has unary minus before the whole literal: -12'sd7 is valid; 12'sd-7 is invalid. Size signed bounds so their value is representable and use the same signed comparison domain as the intermediate.
- When full precision is required, size signed multiplication/addition intermediates for the complete mathematical range and extend operands before arithmetic. A later cast cannot recover bits discarded in a narrow intermediate.
- Zero-extend unsigned values; sign-extend signed values. $signed changes interpretation, not width. Concatenations and part-selects need explicit signed treatment when used arithmetically.
- Example: `logic signed [7:0] a; logic signed [11:0] ax; assign ax = $signed({{4{a[7]}}, a});`. For `a=-8'sd1`, ax stays -1 (`12'hfff`); `{4'b0,a}` gives +255. Appending zeros changes scale instead of extending the value.
- For W-bit signed addends, declare `logic signed [W:0] ax, bx, sum, lo, hi;` and sign-extend inputs into ax/bx before `assign sum = ax + bx;`. Size wider for larger expressions. Set lo/hi from the specified output bounds. Compare `sum > hi` / `sum < lo` in this signed domain; exact endpoints are in range.
- Avoid accidental signed/unsigned mixing and unsized constants in datapaths. Make comparison operands compatible.
- >>> sign-fills only when its left operand is signed; >> is logical. Parenthesize shifts and arithmetic.
- Preserve specified wrap, saturation, or truncation. For saturation, compare the full-width signed result before narrowing; equality with a bound is not overflow. Do not invent overflow protection.
- Test zero, -1, signed minimum/maximum, and unsigned maximum as applicable.

Example: [widened signed sum](assets/example.sv). Details: [notes](references/notes.md).
