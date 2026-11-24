// Original Moore protocol: IDLE --start--> BUSY --finish--> DONE --> IDLE.
module moore_job_control (
    input  logic clk, rst, start, finish,
    output logic busy, done
);
    typedef enum logic [1:0] {IDLE = 2'd0, BUSY = 2'd1, DONE = 2'd2} state_t;
    state_t state, next_state;
    always_ff @(posedge clk) begin
        if (rst) state <= IDLE;
        else state <= next_state;
    end
    always_comb begin
        next_state = state;
        busy = 1'b0;
        done = 1'b0;
        case (state)
            IDLE: if (start) next_state = BUSY;
            BUSY: begin
                busy = 1'b1;
                if (finish) next_state = DONE;
            end
            DONE: begin
                done = 1'b1;
                next_state = IDLE;
            end
            default: next_state = IDLE;
        endcase
    end
endmodule
