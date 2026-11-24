// Shared by routing, prompts, validation and actual model requests. Original
// problem difficulty and current repair difficulty are deliberately distinct.
import {HANDWRITTEN_TABLE_METHODS} from '../verification/table-policy.mjs';
export const REPAIR_POLICY_VERSION='bounded-repair.v2';
export const REPAIR_FALLBACK_VERSION='programmatic-cex-fallback.v2';
// Explicit, closed classification, not registry membership. CPU evaluation does
// not validate a model-written oracle (E observed 3/27 comb_expr false alarms).
// "trusted" means eligible for ONE bounded repair, never semantic correctness.
export const REPAIR_METHOD_TRUST=Object.freeze({
 constant:true,adder:true,logic:true,addsub:true,packed_mux:true,priority_encoder:true,
 kmap:true,popcount:true,mux:true,indexed_mux:true,register:true,shift:true,
 shift_register:true,bcd_counter:true,grid_life:true,packet_collector:true,
 history_recovery:true,window_count:true,counter:true,edge:true,lfsr:true,
 sequence_detector_v2:true,rotate_v2:true,controlled_counter_v2:true,
 framed_stream_v2:true,lfsr_v2:true,
 fsm:false,moore_table:false,bounded_moore:false,mealy_table:false,state_logic:false,
 comb_expr:false,latency_transaction:false,register_expr:false,automaton:false,
 // Compiler summaries do not identify this union's variant. Boolean tables
 // are untrusted; missing variant provenance must not promote the whole family.
 priority_update_v2:false,
});
export const REPAIR_TEMPLATE_TRUST=Object.freeze({
 bit_reversal:true,population_count:true,sticky_falling_capture:true,
 right_galois_lfsr:true,edge_triggered_register:true,bounded_range_counter:true,
 byte_packet_boundary:true,serial_frame_boundary:true,consecutive_one_framing:true,
});
const explicitlyTrusted=(table,key)=>Object.hasOwn(table,key)&&table[key]===true;
// Table metadata overrides any other claim. Unknown methods, future templates,
// missing variant provenance and raw vectors remain untrusted, even if reviewed.
export function checkerRepairProvenance(tb={}){
 tb??={};
 const table=tb.handwritten_table??tb.coverage?.table_safety;
 const method=table?.method??tb.generator?.method??tb.assurance?.method;
 if(table||HANDWRITTEN_TABLE_METHODS.includes(method))return {eligible:false,kind:'handwritten_table',method:method??null,states:table?.states??null};
 if(method&&!explicitlyTrusted(REPAIR_METHOD_TRUST,method))return {eligible:false,kind:'untrusted_method',method};
 if(tb.generator?.kind==='specification_template'&&explicitlyTrusted(REPAIR_TEMPLATE_TRUST,tb.generator.family))return {eligible:true,kind:'specification_template',family:tb.generator.family};
 if(tb.generator?.kind==='computed_method'&&explicitlyTrusted(REPAIR_METHOD_TRUST,method))return {eligible:true,kind:'computed_method',method};
 return {eligible:false,kind:'unknown'};
}
export function diagnosisFitsRepairBudget(b={}){
 const {remainingMs,diagnosisMs,authorCapMs,verificationReserveMs,minStageMs}=b;
 if(![remainingMs,diagnosisMs,authorCapMs,verificationReserveMs,minStageMs].every(Number.isFinite)||diagnosisMs<=0||authorCapMs<=0||verificationReserveMs<0||minStageMs<=0)return {fits:true,reason:'budget_unavailable'};
 // Reserve the observed duration of the preceding 8B repair (including failed
 // calls), bounded by existing caps. With no timing, use the existing author
 // cap. This is scheduling evidence, NOT a guarantee the next call will finish.
 const repairReserveMs=Math.min(authorCapMs,Math.max(minStageMs,Number.isFinite(b.lastRepairMs)&&b.lastRepairMs>0?b.lastRepairMs:authorCapMs));
 const requiredMs=diagnosisMs+repairReserveMs+verificationReserveMs;
 return {fits:remainingMs>=requiredMs,remainingMs,diagnosisMs,repairReserveMs,verificationReserveMs,requiredMs};
}
// Shared verbatim by the runtime and offline routing replay. `verdict` omitted
// means the pre-diagnosis scheduling decision; null/uncertain is not a retry.
export function programmaticRepairFallback({enabled=false,cexFirst=false,testbench,route,budget,verdict}){
 if(!enabled||!cexFirst||route?.failure_kind!=='functional'||route.facts?.trace_identity_ok!==true)return null;
 const provenance=checkerRepairProvenance(testbench);
 if(!provenance.eligible)return null;
 if(verdict===undefined){const fit=diagnosisFitsRepairBudget(budget);return fit.fits===false?{reason:'diagnosis_would_consume_repair_reserve',provenance,budget:fit}:null;}
 return verdict==='checker_suspect'?{reason:'programmatic_checker_suspect_retry',provenance,diagnosis_verdict:verdict}:null;
}
export const DIAGNOSIS_LIMITS=Object.freeze({issues:2,locations:12,references:12,text:500,toolRounds:1});
export function repairPolicy(route={}){
 const difficulty=['low','moderate','high','unknown'].includes(route.difficulty)?route.difficulty:'unknown';
 return {version:REPAIR_POLICY_VERSION,difficulty,thinking:difficulty==='low'?'low':'medium',
   band:difficulty==='low'?'simple':difficulty==='moderate'?'moderate':'complex_or_unknown'};
}
export function diagnosisTurn(route,{remainingMs,round}){
 const policy=repairPolicy(route),final=round>0;
 const finalReserveMs=Math.min(60000,Math.floor(remainingMs*0.4));
 return {...policy,final,finalReserveMs:final?0:finalReserveMs,
   timeoutMs:Math.max(1,final?remainingMs:remainingMs-finalReserveMs),
   reasoningTokens:final?(policy.difficulty==='low'?512:768):(policy.difficulty==='low'?1024:1536),
   maxTokens:final?2048:3072};
}
export const DIAGNOSIS_NUMERIC_GUIDANCE='Use the supplied observations and original sources first. Direct constants and explicit one-bit literal boolean operations (0/1 AND/OR/NOT) need no tool. Reuse delivered arithmetic facts. For derived multibit values, signed/truncated arithmetic, masks, bit indexes, counts or packed values, request exact CPU arithmetic with explicit operands, width and signedness. Never guess absent operands. A calculator result proves only its declared operation, not a branch, cycle or oracle. X/Z and scheduling require semantic analysis, not binary arithmetic. If a calculation is used, include calculation_checks:[{calc:"c1",equals:"exact returned integer"}] in the final JSON; the harness checks and removes it. Do not expand a whole truth table or replay an entire test suite when the first mismatch identifies the bounded question.';

export const TOOL_REGISTRY=Object.freeze({
 need_context:{stages:['plan_semantics','plan_architecture','plan_test','diagnose_failure','review_repair'],effect:'read_only',maxItems:8,retry:'one bounded continuation; never re-fetch delivered IDs'},
 need_calculation:{stages:['plan_semantics','plan_architecture','plan_test','diagnose_failure','review_repair'],effect:'read_only',maxItems:16,retry:'snapshot/operation/arguments cache; invalid operands never inferred'},
});
export function contextToolGuidance({stage,refs,delivered,calculatorGuidance,final=false}){
 if(final)return 'Final submission state. No further tool requests. Use delivered facts for the pending question and submit the stage JSON, or a precise uncertain result with issues:[]. Do not restart analysis.';
 const tool=TOOL_REGISTRY.need_context;
 return (tool.stages.includes(stage)?'For specifically MISSING evidence only, return {"status":"need_context","refs":["known ID"]}; at most '+tool.maxItems+' IDs. Already delivered (do not request): '+JSON.stringify([...delivered])+'. Available but NOT delivered: '+JSON.stringify([...refs].filter(id=>!delivered.has(id)))+'. No paths or commands. ':'')+calculatorGuidance;
}
