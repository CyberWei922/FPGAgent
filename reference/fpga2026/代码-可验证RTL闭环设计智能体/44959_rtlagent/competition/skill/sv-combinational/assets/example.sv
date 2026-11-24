// Original example: request 2 has highest priority; valid qualifies selected.
module priority_word_mux (
    input  logic [2:0] req,
    input  logic [7:0] word0, word1, word2,
    output logic       valid,
    output logic [1:0] selected,
    output logic [7:0] data
);
    always_comb begin
        valid = 1'b0;
        selected = 2'd0;
        data = 8'd0;
        if (req[2]) begin
            valid = 1'b1;
            selected = 2'd2;
            data = word2;
        end else if (req[1]) begin
            valid = 1'b1;
            selected = 2'd1;
            data = word1;
        end else if (req[0]) begin
            valid = 1'b1;
            selected = 2'd0;
            data = word0;
        end
    end
endmodule
