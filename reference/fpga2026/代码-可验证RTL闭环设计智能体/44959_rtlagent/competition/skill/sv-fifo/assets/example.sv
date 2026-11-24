// Original 4x8, one-clock, registered-read FIFO; no fall-through or bypass.
// Acceptance uses pre-edge full/empty. Full+read+write accepts only read;
// empty+read+write accepts only write. Reset wins over both requests.
module sync_fifo4x8 (
    input  logic clk, rst, wr_en, rd_en,
    input  logic [7:0] din,
    output logic [7:0] dout,
    output logic rd_valid, full, empty
);
    logic [7:0] mem [0:3];
    logic [1:0] wr_ptr, rd_ptr;
    logic [2:0] count;
    logic push, pop;
    assign full = (count == 3'd4);
    assign empty = (count == 3'd0);
    assign push = wr_en && !full;
    assign pop = rd_en && !empty;

    always_ff @(posedge clk) begin
        if (rst) begin
            wr_ptr <= 2'd0;
            rd_ptr <= 2'd0;
            count <= 3'd0;
            dout <= 8'd0;
            rd_valid <= 1'b0;
        end else begin
            rd_valid <= pop;
            if (push) begin
                mem[wr_ptr] <= din;
                wr_ptr <= wr_ptr + 2'd1;
            end
            if (pop) begin
                dout <= mem[rd_ptr];
                rd_ptr <= rd_ptr + 2'd1;
            end
            case ({push, pop})
                2'b10: count <= count + 3'd1;
                2'b01: count <= count - 3'd1;
                default: count <= count;
            endcase
        end
    end
endmodule
