import {invariant} from '../dual/snapshot.mjs';
import {validateExpressionProgram,evaluateExpressionProgram,expressionLiteral} from './expressions.mjs';
import {TRANSACTION_PARAMS,transactionsEnabled} from './transaction-registry.mjs';
import {adderNumberSystemAllowed} from './source-consistency.mjs';
const check=(ok,message)=>invariant(ok,'TEST_PLAN_INVALID',message),mask=w=>(1n<<BigInt(w))-1n;
// Presentation normalization only: preserve token order, words, decimal
// numbers, identifiers and operators (notably '-' and Verilog apostrophes).
const compact=s=>' '+(s.toLowerCase().replace(/[“”]/g,'"').replace(/[‘’]/g,"'").replace(/[–—]/g,'-').match(/[a-z_$][\w$]*|\d+(?:\.\d+)?|[^\s.,:;!?()\"]/g)??[]).join(' ')+' ';
const object=x=>x&&typeof x==='object'&&!Array.isArray(x);
const exactKeys=(x,list)=>check(object(x)&&Object.keys(x).length===list.length&&list.every(k=>Object.hasOwn(x,k)),'Unexpected transaction plan fields');
const literal=(v,w)=>`${w}'h${v.toString(16)}`;

export function compileTransactionMethod(raw,{task,expected,resolveSources}){
 const refs=resolveSources(raw.sources,task);
 const value={schema_version:2,status:'ready',transaction:raw.params,constraints:refs.map((r,i)=>({id:'C'+(i+1),quote:r.quote,claim:'Source behavior for transaction result and timing.'}))};
 const plan=compileTransactionPlan(value,{spec:task.spec,expected});
 return {value,calculations:[{operation:'transaction-expression-batch',...plan.transaction.cpu,candidate_read:false}],coverage:plan.coverage};
}

export function compileTransactionPlan(raw,{spec,expected}){
 check(transactionsEnabled(),'latency_transaction is disabled; set AGENT_VERIFICATION_TRANSACTIONS=1 explicitly');
 exactKeys(raw,['schema_version','status','transaction','constraints']);
 check(raw.schema_version===2&&raw.status==='ready','Invalid transaction envelope');
 const parsed=TRANSACTION_PARAMS.safeParse(raw.transaction);check(parsed.success,parsed.success?'':parsed.error.issues.slice(0,3).map(e=>e.path.join('.')+': '+e.message).join('; '));
 const p=parsed.data,t=p.timing,ports=expected.ports??[],byName=new Map(ports.map(p=>[p.name,p])),used=new Set();
 check(/^[A-Za-z_]\w*$/.test(expected.top)&&ports.length>0&&ports.length<=16&&!expected.unresolved?.length&&byName.size===ports.length&&ports.every(p=>/^[A-Za-z_]\w*$/.test(p.name)&&['input','output'].includes(p.direction)&&Number.isInteger(p.width)&&p.width>=1&&p.width<=4096),'Resolved bounded transaction interface required');
 const role=(name,direction,width)=>{const r=byName.get(name);check(r?.direction===direction&&(!width||r.width===width)&&!used.has(name),'Invalid/duplicate transaction role: '+name);used.add(name);return r;};
 role(p.clock.port,'input',1);role(p.reset.port,'input',1);
 const inputs=p.operands.map(n=>role(n,'input')),outputs=p.outputs.map(o=>role(o.port,'output'));
 check(inputs.some(p=>p.width>1)&&outputs.reduce((n,p)=>n+p.width,0)<=4096,'Multibit operands and bounded results required');
 if(t.kind==='start_done'){role(t.start,'input',1);role(t.done,'output',1);if(t.busy)role(t.busy,'output',1);}
 else{if(t.input_valid)role(t.input_valid,'input',1);if(t.output_valid)role(t.output_valid,'output',1);check(!t.output_valid||t.input_valid,'Fixed output-valid without input-valid is unsupported');}
 check(used.size===ports.length,'Every port must have a transaction role; no ready/backpressure or ignored controls');
 check(Array.isArray(raw.constraints)&&raw.constraints.length>=1&&raw.constraints.length<=8,'Source constraints required');
 const ids=new Set();for(const c of raw.constraints){exactKeys(c,['id','quote','claim']);check(/^C\d{1,2}$/.test(c.id)&&!ids.has(c.id)&&typeof c.quote==='string'&&c.quote.length>=6&&c.quote.length<=2000&&compact(spec).includes(compact(c.quote))&&c.claim==='Source behavior for transaction result and timing.','Transaction source must quote original behavior');ids.add(c.id);}
 const source=raw.constraints.map(c=>c.quote).join('\n');
 const cite=q=>check(compact(spec).includes(compact(q))&&compact(source).includes(compact(q)),'Transaction timing/reset quote must occur in cited original sources');
 cite(t.quote);cite(p.reset.quote);
 check(adderNumberSystemAllowed(spec),'Transaction expressions support ordinary binary/two-complement only');
 check(!/\b(?:divid\w*|division|quotient|remainder|modulo)\b|\budiv\b|\burem\b/i.test(source),'Division/remainder unavailable until the expression API provides udiv/urem');
 check(/\breset\b|\brst\b/i.test(p.reset.quote),'Reset quote must identify reset');
 const resetKind=/\basynchronous\b|\basync\b/i.test(p.reset.quote)?'async':/\bsynchronous\b|\bsync\b/i.test(p.reset.quote)?'sync':null;
 const active=/active[- ]low/i.test(p.reset.quote)?0:/active[- ]high/i.test(p.reset.quote)?1:null;
 check((resetKind??'unspecified')===p.reset.kind&&active===p.reset.active,'Reset polarity and kind require matching source evidence; absent kind must be unspecified');
 if(p.reset.kind!=='unspecified')check(/clear|cancel|discard|flush|idle/i.test(p.reset.quote),'In-flight reset requires explicit clearing/cancellation evidence');
 const edge=p.clock.edge==='posedge'?/rising|positive|posedge/i:/falling|negative|negedge/i;
 check(edge.test(source),'Clock edge needs explicit source evidence');
 check(!/active[- ]low/i.test(t.quote),'Only active-high transaction controls are supported');
 const hasName=(q,n)=>new RegExp('(?<![A-Za-z0-9_])'+n+'(?![A-Za-z0-9_])','i').test(q);
 const number=(q,n)=>new RegExp('\\b'+n+'\\b').test(q);
 if(t.kind==='fixed')check(number(t.quote,t.cycles)&&/cycles?|stages?|latency|edges?/i.test(t.quote),'Fixed latency must copy an explicit source cycle count');
 else if(t.kind==='valid')check(hasName(t.quote,t.input_valid)&&hasName(t.quote,t.output_valid)&&/valid|enable|accepted/i.test(t.quote),'Input/output-valid timing needs source evidence for both ports');
 else{
  check(hasName(t.quote,t.start)&&hasName(t.quote,t.done)&&/start|accept/i.test(t.quote)&&/done|complet/i.test(t.quote),'Start/done contract needs source evidence for both ports');
  // Inspect the start clause, not a nearby done pulse or reset instruction.
  const startClauses=t.quote.split(/[.;\n]/).filter(q=>hasName(q,t.start));
  const pulse=startClauses.some(q=>/\bstart\b[^.;]*?(?:pulses?|one[- ]cycle|single[- ]cycle)/i.test(q));
  const held=startClauses.some(q=>/\bstart\b[^.;]*?(?:hold|held|remain|keep)[^.;]*?(?:until|through)[^.;]*?(?:done|complet)/i.test(q));
  check(!(pulse&&held)&&t.start_behavior===(pulse?'pulse':held?'hold_until_done':'unspecified'),'Start pulse/hold must match explicit source; absent duration must be unspecified');
  check(t.done_behavior==='held'?/hold|held|until.*start/i.test(t.quote):/pulse|one[- ]cycle|single[- ]cycle/i.test(t.quote),'Done pulse/held behavior must be explicit');
  if(t.busy)check(hasName(t.quote,t.busy)&&/busy/i.test(t.quote),'Busy role needs source evidence');
 }
 if(t.kind==='fixed'&&t.input_valid)check(hasName(t.quote,t.input_valid),'Input enable role needs source evidence');
 if(t.kind==='fixed'&&t.output_valid)check(hasName(t.quote,t.output_valid),'Output valid role needs source evidence');
 const wait=t.kind==='fixed'?t.cycles:(t.max_wait?.cycles??64);
 if(t.max_wait){cite(t.max_wait.quote);check(number(t.max_wait.quote,wait)&&/within|at most|maximum|no more than|latency/i.test(t.max_wait.quote)&&/cycles?|edges?/i.test(t.max_wait.quote),'Maximum wait must copy an explicit upper bound');}
 if(p.invalid){cite(p.invalid.quote);check(p.invalid.kind==='zero'?/zero|clear|\b0\b/i.test(p.invalid.quote):/hold|held|retain|unchanged/i.test(p.invalid.quote),'Invalid-output rule needs explicit hold/zero source');check(/invalid|not valid|valid.*(?:low|zero|0)|not.*(?:done|complete)/i.test(p.invalid.quote),'Data behavior must explicitly apply to invalid result cycles');}
 const program=validateExpressionProgram(p.nodes,inputs);
 for(const o of p.outputs)check(program.types[o.value]?.width===byName.get(o.port).width,'Transaction result width/reference mismatch');
 const tokens=source.match(/(?<![\w'])-?(?:\d+'[sS]?[bBoOdDhH][\da-fA-F_]+|0[xX][\da-fA-F_]+|0[bB][01_]+|\d+)(?![\w'])/g)??[];
 for(const n of p.nodes)if(n.op==='literal'){
  const value=expressionLiteral(n.value,n.width);
  check(["'0","'1",'0','1'].includes(n.value)||tokens.some(s=>{try{return expressionLiteral(s,n.width)===value;}catch{return false;}}),'Transaction literal must copy a cited source constant');
 }
 // CPU—not the model—selects all values. Distinguish operand order, include
 // both sides of the sign boundary, and always reserve fixed-seed samples.
 const vectors=[];
 const add=values=>vectors.push(Object.fromEntries(inputs.map((p,i)=>[p.name,values[i]&mask(p.width)])));
 add(inputs.map(()=>0n));add(inputs.map(p=>mask(p.width)));
 for(let lane=0;lane<inputs.length;lane++)for(let mode=0;mode<6;mode++){
  add(inputs.map((p,i)=>{const sign=1n<<BigInt(p.width-1);return i===lane?[1n,sign,sign-1n,sign+1n,mask(p.width),mask(p.width)-1n][mode]:BigInt(2*i+3);}));
 }
 let seed=0x6d2b79f5;const next=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return BigInt(seed>>>0);};
 while(vectors.length<40)add(inputs.map(p=>{let v=0n;for(let b=0;b<p.width;b+=32)v=(v<<32n)|next();return v;}));
 let operations=0,workUnits=0;
 const samples=vectors.map(values=>{
  operations+=program.operations;workUnits+=program.workUnits;
  check(operations<=600000&&workUnits<=16000000,'Transaction aggregate expression CPU budget exceeded');
  const env=evaluateExpressionProgram(program,values);
  return {drive:Object.fromEntries(inputs.map(p=>[p.name,literal(values[p.name],p.width)])),expect:Object.fromEntries(p.outputs.map(o=>[o.port,literal(env.get(o.value),byName.get(o.port).width)]))};
 });
 const uncovered=['Partial transaction checks, not proof of result-function semantics or exhaustive data coverage.','Dynamic transaction traces are diagnostic text only; fixed-step observation/repair trace format is not available.',p.reset.kind==='unspecified'?'Reset type unspecified: initial-only reset held for two idle clocks, then one idle clock after release; in-flight reset and cancellation are not tested.':'Reset discards an in-flight probe; its pre-reset result is deliberately not asserted.'];
 if(t.kind!=='fixed'&&!t.max_wait)uncovered.push('No source maximum wait: fixed Harness cap of 64 cycles per result; timeout is a DUT failure, not an inferred latency.');
 if(!p.invalid)uncovered.push('Result data is not compared on invalid cycles.');
 if(t.kind==='fixed'&&!t.input_valid)uncovered.push('No input-valid: inputs are accepted on every edge. No bubbles or independent output-count assertion; only the finite latency-aligned result prefix is checked.');
 if(t.kind==='start_done')uncovered.push('Single outstanding start/done only; starts while busy are not issued. At least one idle clock separates starts.'+(t.start_behavior==='unspecified'?' Start duration unspecified: hold start and operands until done, then deassert; no pulse-only claim.':''));
 if(t.kind==='fixed'&&t.cycles===1)uncovered.push('One-register latency completes on the acceptance edge, so the reset probe cannot be interrupted while in flight.');
 const expectedChecks=samples.length*outputs.length+2+(p.invalid?1:0);
 check(expectedChecks<=512,'Transaction comparison budget exceeded');
 return {schema_version:1,source_schema_version:2,status:'ready',clock:p.clock,constraints:structuredClone(raw.constraints),steps:[],expectedChecks,
  transaction:{version:2,params:p,wait,samples,cpu:{evaluations:samples.length,operations,workUnits}},
  coverage:{kind:'partial',method:'latency_transaction',semantic_correctness:'unproven',comparisons:expectedChecks,transaction_count:samples.length,uncovered,unchecked_outputs:[]}};
}
