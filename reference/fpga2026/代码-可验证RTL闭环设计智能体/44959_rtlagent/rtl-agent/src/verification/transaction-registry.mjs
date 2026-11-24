import {z} from 'zod';
import {EXPRESSION_NODES} from './expression-schema.mjs';
const obj=x=>z.object(x).strict(),name=z.string().regex(/^[A-Za-z_]\w*$/).max(100),quote=z.string().min(8).max(800);
const bound=obj({cycles:z.number().int().min(1).max(128),quote});
export const TRANSACTION_PARAMS=obj({
 clock:obj({port:name,edge:z.enum(['posedge','negedge'])}),
 reset:obj({port:name,active:z.union([z.literal(0),z.literal(1)]),kind:z.enum(['sync','async','unspecified']),quote}),
 operands:z.array(name).min(1).max(4),nodes:EXPRESSION_NODES,
 outputs:z.array(obj({port:name,value:z.string().regex(/^[#$][A-Za-z_]\w*$/).max(102)})).min(1).max(4),
 timing:z.union([
  obj({kind:z.literal('fixed'),cycles:z.number().int().min(1).max(64),input_valid:name.nullable(),output_valid:name.nullable(),quote}),
  obj({kind:z.literal('valid'),input_valid:name,output_valid:name,max_wait:bound.nullable(),quote}),
  obj({kind:z.literal('start_done'),start:name,done:name,busy:name.nullable(),start_behavior:z.enum(['pulse','hold_until_done','unspecified']),done_behavior:z.enum(['pulse','held']),max_wait:bound.nullable(),quote})
 ]),
 invalid:obj({kind:z.enum(['zero','hold']),quote}).nullable()
});
export const TRANSACTION_DEFINITION={params:TRANSACTION_PARAMS,review:false,
 description:'Opt-in latency_transaction v2: arithmetic transactions, not an internal algorithm model. Every port has exactly one role. reset.quote must state polarity. If reset type is absent, use kind=unspecified: two initial idle reset clocks, one idle clock after release, no in-flight reset. Explicit sync/async also requires clearing/cancellation evidence for its in-flight reset probe. operands are data inputs only. outputs contains result buses only (valid/done/busy are timing roles). nodes uses the SAME bounded comb_expr AST with explicit operand widths, $operand and #earlierNode refs; no state or DUT outputs. Use resize before wider arithmetic; signed multiplication requires sign-extension before mul. No division/remainder, floating point, BCD, sign-magnitude, arbitrary input domains or masks. timing has ONE form: fixed cycles is pipeline depth INCLUDING the input-acceptance edge (one register=1); output_valid is optional and requires input_valid. valid accepts on EVERY edge with input_valid=1 and observes output_valid after edges, in input order; no ready/backpressure. start_done has start_behavior=pulse for an explicit one-edge start pulse, hold_until_done for explicit held start, or unspecified when duration is absent. Unspecified drives start and operands held until done, then deasserts; all variants leave at least one idle edge before another start. One outstanding transaction, optional active-high busy. done_behavior=pulse counts every high edge; held requires done to clear at new start before rising for that result. All handshake controls are active high. timing.quote must support the chosen contract. max_wait=null uses bounded 64-cycle waiting disclosed as uncovered, never a guessed latency; an explicit bound needs its own source quote. invalid=null skips data whenever result is invalid; zero/hold requires explicit source text. CPU chooses boundary/asymmetric/fixed-seed inputs, back-to-back bursts and bubbles, and checks ordered outputs, missing/extra completions. Unknown result semantics or timing => reason, not invented assumptions.',
 focus:['source-backed transaction timing','ordered accepted-input snapshots','source-bounded reset coverage','aggregate expression CPU limits'],
 limits:['default off','one clock and reset','4 operands/results','64 samples','fixed depth <=64','wait <=128','no backpressure or division']};
export const transactionsEnabled=()=>process.env.AGENT_VERIFICATION_TRANSACTIONS==='1';
export function transactionEligible({expected}){
 if(!transactionsEnabled())return false;
 // Menu eligibility is not a semantic claim. Clock/reset/timing, result
 // function and unsupported division are still checked by the compiler.
 const ports=expected?.ports??[];
 if(expected?.unresolved?.length||ports.length>16||new Set(ports.map(p=>p.name)).size!==ports.length||!ports.every(p=>['input','output'].includes(p.direction)&&Number.isInteger(p.width)&&p.width>=1&&p.width<=4096))return false;
 const ins=ports.filter(p=>p.direction==='input'),outs=ports.filter(p=>p.direction==='output');
 return ins.some(p=>p.width>1)&&ins.filter(p=>p.width>1).length<=4&&ins.filter(p=>p.width===1).length>=2&&ins.length<=7&&outs.length>=1&&outs.length<=6;
}
