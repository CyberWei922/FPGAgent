import {z} from 'zod';
import {SEQUENTIAL_DEFINITIONS} from './sequential-registry.mjs';
import {requiresMealy,literalSequence,adderNumberSystemAllowed} from './source-consistency.mjs';
import {TRANSACTION_DEFINITION,transactionEligible} from './transaction-registry.mjs';
// One registration hook keeps shared registry changes isolated from E.
export function registerOracleMethods(definitions){
 Object.assign(definitions,SEQUENTIAL_DEFINITIONS);
 definitions.latency_transaction=TRANSACTION_DEFINITION;
 definitions.bcd_counter={...definitions.bcd_counter,params:definitions.bcd_counter.params.extend({enable:z.string().regex(/^[A-Za-z_]\w*$/).nullable().optional()}),description:definitions.bcd_counter.description+' Optional enable is an active-high INPUT count gate, distinct from enables OUTPUT carry flags. CPU checks every decimal carry and full wrap using constant-control batches, and checks enable hold and mid-count reset.'};
 const prior=definitions.shift_register;
 definitions.shift_register={...prior,params:prior.params.extend({storage:z.object({bits:z.number().int().min(2).max(256),tap:z.number().int().min(0).max(255),quote:z.string().min(6).max(600)}).strict().optional()}),
  description:prior.description+' For a fixed output tap/slice narrower than the internal chain, provide storage:{bits,tap,quote}: independent internal bit count, LSB index of the observed slice, and exact source wording supporting BOTH. Do not infer internal depth from output width. Missing depth/tap or direction evidence is rejected.'};
}

// Structural role capacity plus affirmative edge-triggered timing, never a
// benchmark identifier or a method-name keyword. Compilation binds exact roles.
export function oracleMethodEligible(id,{expected,spec}){
 if(id==='latency_transaction')return transactionEligible({expected,spec});
 if(id==='adder'&&!adderNumberSystemAllowed(spec))return false;
 const smallSequence=literalSequence(spec)&&expected.ports.filter(p=>p.direction==='input').length===3&&expected.ports.filter(p=>p.direction==='output').length===1&&expected.ports.every(p=>p.width===1);
 if(['fsm','moore_table','bounded_moore'].includes(id)&&(requiresMealy(spec)||smallSequence))return false;
 if(!Object.hasOwn(SEQUENTIAL_DEFINITIONS,id))return null;
 const ins=expected.ports.filter(p=>p.direction==='input'),outs=expected.ports.filter(p=>p.direction==='output');
 const bits=ins.filter(p=>p.width===1).length;
 const affirmative=spec.replace(/[^.!?]*(?:not depend on|no|without|not used)[^.!?]*(?:clock|edge)[^.!?]*[.!?]?/gi,'');
 if(!/\b(?:posedge|negedge)|(?:positive|negative|rising|falling)\s+edge|synchronous|clock cycles?|sequential circuit/i.test(affirmative)||bits<2)return false;
 if(id==='sequence_detector_v2')return Boolean(smallSequence);
 if(id==='mealy_table')return ins.every(p=>p.width===1)&&outs.every(p=>p.width===1)&&ins.length>=3&&ins.length<=7&&outs.length<=8;
 if(id==='framed_stream_v2')return bits>=3&&ins.length===3&&outs.length<=2&&outs.some(p=>p.width===1);
 if(id==='controlled_counter_v2')return outs.length<=2&&ins.length<=6;
 if(id==='rotate_v2')return outs.length===1&&ins.length<=5&&ins.some(p=>p.width===outs[0].width);
 if(id==='priority_update_v2'&&ins.every(p=>p.width===1)&&outs.every(p=>p.width===1))return ins.length<=5&&outs.length<=3;
 return outs.length===1&&outs[0].width<=256&&ins.length<=6;
}
