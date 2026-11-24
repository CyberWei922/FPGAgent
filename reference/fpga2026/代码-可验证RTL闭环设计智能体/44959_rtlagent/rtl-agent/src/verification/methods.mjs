import {invariant,sha256} from '../dual/snapshot.mjs';
import {sourceCatalog} from '../planner/compact.mjs';
import {compileScenarioPlan} from './plan.mjs';
import {createCalculator,CALCULATOR_VERSION} from '../harness/calculator.mjs';

import {CHECK_METHOD_LIBRARY,METHOD_IDS,eligibleMethods,methodDescription,methodOutputSchema,validateMethodShape,filterMethodKnowledge} from './registry.mjs';
import {compileExtended} from './extended.mjs';
import {compileCombinational} from './combinational.mjs';
import {compileExpressionMethod} from './expressions.mjs';
import {fsmStimulus} from './fsm-stimulus.mjs';
import {checkFsmEventScope} from './source-consistency.mjs';
import {compileTransactionMethod} from './transaction.mjs';
import {attachTableMetadata} from './table-policy.mjs';
import {methodSemanticMessage} from './parameter-errors.mjs';
export {CHECK_METHOD_LIBRARY} from './registry.mjs';
export const TEST_METHODS_VERSION='rtl2llm.test-methods.v5';
const check=(ok,msg)=>invariant(ok,'TEST_PLAN_INVALID',msg);
const compact=s=>s.replace(/\s+/g,' ').trim();
const object=x=>x&&typeof x==='object'&&!Array.isArray(x);
const keys=(x,list)=>check(object(x)&&Object.keys(x).length===list.length&&list.every(k=>Object.hasOwn(x,k)),'Expected fields: '+list.join(','));
const mask=w=>(1n<<BigInt(w))-1n;

// Addresses are presentation, not model arithmetic. Expand bounded ranges using
// actual catalog offsets so blank lines and punctuation remain source-exact.
export function resolveTestSources(addresses,task){
  const rows=sourceCatalog({spec:task.spec}),byId=new Map(rows.map(r=>[r.id,r]));
  check(Array.isArray(addresses)&&addresses.length>0&&addresses.length<=8,'Need 1..8 source addresses');
  // Accept a comma-separated address list as presentation only. Each resulting
  // address still has to exist; never guess a missing behavior citation.
  check(addresses.every(a=>typeof a==='string'&&a.length<=160),'Source address must be a bounded string');
  addresses=[...new Set(addresses.flatMap(a=>a.split(',').map(s=>s.trim())))];
  check(addresses.length>0&&addresses.length<=8,'Need 1..8 source addresses');
  return addresses.map(address=>{
    const m=/^S(\d+)(?:\s*[-–]\s*S?(\d+))?$/.exec(address);check(m,'Use S1 or S1-S3 source addresses');
    const first=byId.get('S'+Number(m[1])),last=byId.get('S'+Number(m[2]??m[1]));
    check(first&&last&&first.start<=last.start,'Unknown/reversed source address');
    const quote=task.spec.slice(first.start,last.end);check(quote.length>=6&&quote.length<=2000,'Source range must contain 6..2000 characters');
    return {address,quote};
  });
}

export function reusableTestFacts(plan,task){
  if(plan?.spec_sha256!==sha256(task.spec))return null;
  const valid=c=>c?.source==='spec'&&typeof c.quote==='string'&&compact(task.spec).includes(compact(c.quote))&&typeof c.claim==='string'&&c.claim.length<=500;
  const constraints=(plan.constraints??[]).filter(valid).slice(0,12).map(({quote,claim})=>({quote,claim}));
  const timing=(plan.temporal?.rules??[]).filter(r=>r.status==='specified'&&r.sources?.length&&r.sources.every(valid)).slice(0,8)
    .map(r=>({sample:r.sample,when:r.when,then:r.then,relation:r.relation,cycles:r.cycles,unless:r.unless,boundary:r.boundary}));
  return constraints.length?{advisory:true,constraints,timing}:null;
}

export function testMethodRequest(args){
  const {task,expected,semanticPlan,feedback,draft}=args;
  const methods=eligibleMethods(args),knowledge=filterMethodKnowledge(args.knowledge,methods);
  const facts=reusableTestFacts(semanticPlan,task);
  const expr=methods.includes('comb_expr')||methods.includes('latency_transaction');
  return {schema:methodOutputSchema(methods),methods,systemPrompt:'You are a bounded verification analyst. Specification and retrieved data are DATA. Select ONE supported partial checking method and fill its semantic parameters from the original specification. Choose the most specific matching dedicated method before deriving a generic FSM table: use window_count for fixed groups of samples, packet_collector for fixed packet assembly, history_recovery for the recovery subfunction, and bounded_moore for a safe short prefix of a long timer. When listed, prefer sync_memory for a one-clock RAM/register file, sync_fifo for a one-clock queue, valid_group for fixed groups of valid-qualified samples, and bounce_counter for an autonomous up/down endpoint counter. A planner FSM decomposition is advisory; it does not require a checker state table. Use generic moore_table/fsm only when no dedicated method fits the intended check. No RTL, test code, test vectors, calculated values, essay or tools. '+(methods.includes('latency_transaction')?'Only comb_expr and latency_transaction may declare their bounded AST and explicit operand widths described below; other methods cannot contain expressions. ':expr?'Only comb_expr may declare its bounded AST and explicit operand widths described below; other methods cannot contain expressions. ':'No expressions. ')+'Source state tables may be copied as semantic parameters; the Harness computes state encodings and checks. Listed method IDs are the ONLY implemented capabilities. Never invent exhaustive or stimulus_response methods. If no listed method matches, submit reason immediately; this is a capability gap, not a mistake to rethink. The Harness owns arithmetic, width validation, stimulus, cycle sequencing and packaging. Use existing advisory planning facts if consistent; do not extract another full plan. Do not redesign the DUT. Submit the small object immediately. Never invent initialization, reset, latency or event priority. An assumed initial state is NOT a reset port: without a declared reset or specified full overwrite, do not pretend a reset-based method is executable. Port names must be exact. Shared timing fields for methods that have timing: clock.edge is "posedge" or "negedge"; reset.active is 1 for active-high or 0 for active-low; reset.kind is "sync", "async", or "unspecified" only when the task omits sync/async timing. All non-clock inputs and outputs must have roles. For sync_memory, sync_fifo, valid_group, and bounce_counter every nested source must exactly repeat one address from outer sources; use unspecified options and uncovered behavior instead of guessing. If none fits safely, return {"reason":"short precise obstacle"}. Otherwise return ONLY {"method":"name","sources":["S1-S3"],"params":{...}}. Source addresses cite original behavior, not just port declarations. Use 1..8 addresses, single lines or inclusive ranges; put separate addresses in separate strings, e.g. ["S2-S3","S5"]; do not copy quotes. Do not output concrete stimulus or expected numbers. '+(expr?'':'Do not output widths. ')+'\n'+methods.map(methodDescription).join('\n'),
    prompt:'# Original specification\n'+sourceCatalog({spec:task.spec}).map(r=>'['+r.id+'] '+r.quote).join('\n')+'\n\n# Interface\n'+JSON.stringify(expected)+'\n\n# Existing source-checked planning facts\n'+JSON.stringify(facts)+'\n\n# Advisory method reminders\n'+JSON.stringify(knowledge??null)+(feedback?'\n\n# Correct this parameter defect only\n'+feedback+'\n# Previous unvalidated object\n'+JSON.stringify(draft):'')};
}

// The decoder constrains only the small outer envelope. Method parameters still
// undergo strict CPU validation. This is off until the actual backend is probed.
export const TEST_METHOD_ENVELOPE_SCHEMA=methodOutputSchema();

export function compileTestMethod(raw,args){
  try{return compileValidatedMethod(raw,args);}catch(error){
    if(error.code==='TEST_PLAN_INVALID')error.message=methodSemanticMessage(error,raw);
    throw error;
  }
}
function compileValidatedMethod(raw,{task,expected,expressions=false}){
  raw=validateMethodShape(structuredClone(raw));
  if(raw.method==='latency_transaction')return compileTransactionMethod(raw,{task,expected,resolveSources:resolveTestSources});
  if(object(raw)&&Object.hasOwn(raw,'reason')){keys(raw,['reason']);check(typeof raw.reason==='string'&&raw.reason.trim()&&raw.reason.length<=240,'Invalid unsupported reason');return {value:{schema_version:2,status:'unsupported',reason:raw.reason},calculations:[],coverage:{kind:'unsupported'}};}
  if(raw.method==='bounded_moore'){
    const {max_edges,excluded,...params}=raw.params;
    check(new RegExp('\\b'+max_edges+'\\b').test(task.spec),'Bounded horizon must copy an explicit source cycle threshold');
    const compiled=compileTestMethod({method:'moore_table',sources:raw.sources,params},{task,expected});let edges=null;
    const active=Number(({high:1,low:0})[params.reset.active]??params.reset.active);
    for(const row of compiled.value.scenarios[0].steps){if(Number(BigInt(row.drive[params.reset.port]))===active)edges=0;else{check(edges!==null,'Bounded FSM needs reset before every path');edges+=row.cycles;check(edges<=max_edges,'Planned FSM path exceeds the source-backed finite horizon');}}
    compiled.value.uncovered.push(`Finite-prefix abstraction: at most ${max_edges} edges after each reset. Excluded behavior: ${excluded}`);
    attachTableMetadata(compiled.value,raw);
    compiled.coverage={...compiled.coverage,method:'bounded_moore',max_edges,excluded,method_profile:CHECK_METHOD_LIBRARY.bounded_moore};return compiled;
  }
  if(raw.method==='moore_table'){
    const p=raw.params;check(p.initial<p.rows.length&&p.rows.every(r=>r.out.length===p.outputs.length&&r.next.length===2**p.events.length&&r.next.every(n=>n<p.rows.length)),'Compact Moore table dimensions/destinations are inconsistent');
    const states=p.rows.map((r,i)=>({name:'N'+i,outputs:Object.fromEntries(p.outputs.map((n,j)=>[n,r.out[j]])),transitions:r.next.map((n,v)=>({when:Object.fromEntries(p.events.map((name,b)=>[name,(v>>(p.events.length-1-b))&1])),next:'N'+n}))}));
    const compiled=compileTestMethod({method:'fsm',sources:raw.sources,params:{clock:p.clock,reset:p.reset,initial:'N'+p.initial,states}},{task,expected});
    attachTableMetadata(compiled.value,raw);
    compiled.coverage={...compiled.coverage,method:'moore_table',method_profile:CHECK_METHOD_LIBRARY.moore_table};return compiled;
  }
  keys(raw,['method','sources','params']);check(METHOD_IDS.includes(raw.method),'Unsupported check method');
  check(Array.isArray(expected.ports)&&expected.ports.length>0&&expected.ports.length<=64&&!expected.unresolved?.length&&new Set(expected.ports.map(r=>r.name)).size===expected.ports.length&&expected.ports.every(r=>Number.isSafeInteger(r.width)&&r.width>0&&r.width<=4096),'Resolved bounded ports required');
  const refs=resolveTestSources(raw.sources,task),ports=new Map(expected.ports.map(p=>[p.name,p])),used=new Set(),p=raw.params,calculator=createCalculator(),calculations=[];
  raw.sources=refs.map(r=>r.address);
  if(raw.method==='comb_expr'){
    check(expressions,'Combinational expression method is disabled; enable verification.expressions explicitly');
    check(eligibleMethods({task,expected,expressions}).includes('comb_expr'),'Expression method requires a bounded combinational interface');
    return compileExpressionMethod(raw,{task,expected,resolveSources:resolveTestSources});
  }
  check(object(p),'params must be an object');
  const port=(name,direction,w)=>{const r=ports.get(name);check(r?.direction===direction&&(!w||r.width===w),'Invalid '+direction+' role: '+name);check(!used.has(name),'A port cannot have multiple roles: '+name);used.add(name);return r;};
  const bit=v=>{check(v===0||v===1||v==='0'||v==='1','Use bit 0 or 1');return Number(v);};
  let clock=null,reset=null;
  const timing=(needsValue=true,allowUnknown=false)=>{
    keys(p.clock,['port','edge']);port(p.clock.port,'input',1);check(['posedge','negedge'].includes(p.clock.edge),'Invalid active edge');clock=p.clock;
    if(p.reset!==null){keys(p.reset,['port','active','kind',...(needsValue?['value']:[])]);port(p.reset.port,'input',1);
      // Exact enum aliases observed in real calls; this changes representation,
      // never the selected polarity or reset behavior. Unknown words fail.
      p.reset.active=bit(({high:1,low:0})[p.reset.active]??p.reset.active);
      p.reset.kind=({synchronous:'sync',asynchronous:'async'})[p.reset.kind]??p.reset.kind;
      check(['sync','async'].includes(p.reset.kind),'Invalid reset kind');if(needsValue)check(['zero','ones',...(allowUnknown?['unspecified']:[])].includes(p.reset.value),'Reset value must be specified zero or ones');reset=p.reset;}
  };
  const calc=(op,w,args)=>{
    const request={id:'c'+(calculations.length+1),op,width:w,signed:false,args,source_refs:raw.sources};
    const response=calculator.handle({version:CALCULATOR_VERSION,requests:[request]},{snapshot:sha256(task.spec),allowedRefs:new Set(raw.sources)}),r=response.results[0];
    check(r.status==='ok',r.message??'Calculation failed');calculations.push({request,response});return BigInt(r.result.hex);
  };
  const hex=(v,w)=>'0x'+BigInt.asUintN(w,v).toString(16).padStart(Math.ceil(w/4),'0');
  // Port-width-derived asymmetric patterns. Never parse model-generated large
  // literals or use a DUT output as the next expected state.
  const pattern=(w,alternate=false)=>{let n=1n<<BigInt(w-1);for(let i=alternate?1:0;i<w;i+=3)n|=1n<<BigInt(i);return n&mask(w);};
  const rows=[];let first=true;
  const emit=(drive,expect,cycles=clock?1:0)=>{
    check(rows.length<90,'Method scenario exceeds bounded step budget');
    if(first){drive={...Object.fromEntries(expected.ports.filter(r=>r.direction==='input'&&r.name!==clock?.port).map(r=>[r.name,'0'])),...drive};first=false;}
    rows.push({drive:Object.fromEntries(Object.entries(drive).map(([n,v])=>[n,hex(BigInt(v),ports.get(n).width)])),cycles,
      expect:Object.fromEntries(Object.entries(expect).map(([n,v])=>[n,hex(calc('normalize',ports.get(n).width,{value:BigInt(v).toString()}),ports.get(n).width)])),because:refs.map((_,i)=>'C'+(i+1))});
  };
  const uncovered=['Partial method checks; other behaviors and long sequences remain unverified.'];
  const sourceInteger=(value,w)=>{
    // Small JSON integers and their quoted decimal spelling are identical.
    // Larger constants must stay strings so JSON parsing cannot round them.
    if(typeof value==='number'){check(Number.isSafeInteger(value)&&value>=0&&!Object.is(value,-0),'Source integer number must be exact and nonnegative');value=String(value);}
    check(typeof value==='string'&&value.length<=160&&/^(?:0|[1-9][0-9]*|0x[0-9a-fA-F]+)$/.test(value),'Use a copied nonnegative source integer');
    const n=BigInt(value);check(n<=mask(w),'Source integer exceeds port width');return n;
  };
  const deduplicateResetValue=(value,w)=>{
    if(object(p.reset)&&Object.hasOwn(p.reset,'value')){
      keys(p.reset,['port','active','kind','value']);
      check(sourceInteger(p.reset.value,w)===sourceInteger(value,w),'Conflicting duplicate reset value');
      delete p.reset.value;
    }
  };
  if(compileCombinational(raw.method,p,{expected,port,emit,pattern,uncovered,calculations})){
    // The declared semantic primitive owns the CPU oracle.
  }else if(compileExtended(raw.method,p,{task,expected,refs,port,emit,pattern,uncovered,calculations,timing,setClock:c=>{port(c.port,'input',1);clock=c;}})){
    // Registry-backed bounded semantic interpreter.
  }else if(raw.method==='counter'){
    keys(p,['out','clock','reset','reset_value','low','high','enable']);const q=port(p.out,'output');deduplicateResetValue(p.reset_value,q.width);timing(false);check(reset,'Counter requires a specified reset');
    const e=p.enable===null?null:port(p.enable,'input',1),low=sourceInteger(p.low,q.width),high=p.high==='width_max'?mask(q.width):sourceInteger(p.high,q.width),seed=sourceInteger(p.reset_value,q.width);
    check(low<high&&seed>=low&&seed<=high,'Counter reset and inclusive range are inconsistent');
    let state=seed;const control=on=>reset?{[reset.port]:on?reset.active:1-reset.active}:{};
    emit({...control(true),...(e?{[p.enable]:1}:{})},{[p.out]:state},reset.kind==='async'?0:1);
    const step=enabled=>{if(enabled)state=state===high?low:calc('add',q.width,{left:state.toString(),right:'1'});emit({...control(false),...(e?{[p.enable]:Number(enabled)}:{})},{[p.out]:state});};
    const period=high-low+1n,cycles=period<=64n?Number(period)+2:8;
    for(let n=0;n<cycles;n++){step(true);if(e&&n===1)step(false);}
    if(period>64n)uncovered.push('Counter period exceeds 64; only near-reset updates, hold and reset are checked; terminal rollover is untested.');
    state=seed;emit({...control(true),...(e?{[p.enable]:0}:{})},{[p.out]:state},reset.kind==='async'?0:1);step(true);
  }else if(raw.method==='edge'){
    keys(p,['data','out','clock','kind','reset']);const d=port(p.data,'input'),q=port(p.out,'output',d.width);check(['rising','falling','any'].includes(p.kind),'Unsupported edge pulse kind');
    if(p.reset){keys(p.reset,['port','active','kind','history','value']);check(['zero','ones','unspecified'].includes(p.reset.history)&&['zero','unspecified'].includes(p.reset.value),'Unknown edge reset semantics');}
    const details=p.reset?{history:p.reset.history,value:p.reset.value}:null;
    if(p.reset)p.reset={port:p.reset.port,active:p.reset.active,kind:p.reset.kind};timing(false);
    let previous=null;
    if(reset){
      emit({[reset.port]:reset.active,[p.data]:0},details.value==='zero'?{[p.out]:0}:{},reset.kind==='async'?0:1);
      if(details.history!=='unspecified')previous=details.history==='ones'?mask(q.width):0n;
    }
    const av=pattern(q.width),bv=calc('not',q.width,{value:av.toString()});
    for(const value of [0n,0n,av,av,bv,bv,mask(q.width),0n,0n]){
      const result=previous===null?null:p.kind==='any'?previous^value:p.kind==='rising'?(~previous)&value:previous&(~value);
      emit({...(reset?{[reset.port]:1-reset.active}:{}),[p.data]:value},result===null?{}:{[p.out]:result&mask(q.width)});previous=value;
    }
    if(!reset||details.history==='unspecified')uncovered.push('Unspecified startup/reset history is established before event comparisons, not asserted as zero.');
  }else if(raw.method==='lfsr'){
    keys(p,['out','clock','reset','seed','taps']);const q=port(p.out,'output');deduplicateResetValue(p.seed,q.width);timing(false);check(reset&&q.width>=2&&q.width<=256,'LFSR needs specified reset and 2..256 bits');
    check(Array.isArray(p.taps)&&p.taps.length>=1&&p.taps.length<=32&&new Set(p.taps).size===p.taps.length&&p.taps.every(n=>Number.isSafeInteger(n)&&n>=1&&n<=q.width)&&p.taps.includes(q.width),'One-based unique taps must include top position');
    const seed=sourceInteger(p.seed,q.width);check(seed!==0n,'Zero-seed lockup needs a different explicit method');let state=seed;
    const resetDrive=on=>({[reset.port]:on?reset.active:1-reset.active});
    emit(resetDrive(true),{[p.out]:state},reset.kind==='async'?0:1);
    let tapMask=0n;for(const tap of p.taps)tapMask|=1n<<BigInt(tap-1);
    for(let n=0;n<12;n++){
      const old=state;state=(old>>1n)^((old&1n)?tapMask:0n);
      calculations.push({method:'right-galois-lfsr-step',width:q.width,taps:p.taps,input:hex(old,q.width),output:hex(state,q.width),source_refs:raw.sources,snapshot:sha256(task.spec)});
      emit(resetDrive(false),{[p.out]:state});
    }
    emit(resetDrive(true),{[p.out]:seed},reset.kind==='async'?0:1);
    state=(seed>>1n)^((seed&1n)?tapMask:0n);emit(resetDrive(false),{[p.out]:state});
    uncovered.push('Only twelve feedback steps and reset recovery are checked; polynomial period is not proven.');
  }else if(raw.method==='popcount'){
    keys(p,['data','out']);const d=port(p.data,'input'),q=port(p.out,'output');
    check((1n<<BigInt(q.width))>BigInt(d.width),'Output cannot represent the population count');
    const values=d.width<=6?Array.from({length:2**d.width},(_,i)=>BigInt(i)):
      [...new Set([0n,mask(d.width),pattern(d.width),pattern(d.width,true),...Array.from({length:Math.min(d.width,64)},(_,i)=>1n<<BigInt(Math.floor(i*(d.width-1)/Math.max(1,Math.min(d.width,64)-1))))])];
    for(const v of values)emit({[p.data]:v},{[p.out]:calc('popcount',d.width,{value:v.toString()})},0);
    if(d.width>64)uncovered.push('Only sampled one-hot positions are checked for wide inputs.');
  }else if(raw.method==='mux'){
    keys(p,['a','b','select','out','select_a']);const a=port(p.a,'input'),b=port(p.b,'input',a.width);port(p.out,'output',a.width);port(p.select,'input',1);p.select_a=bit(p.select_a);
    const av=pattern(a.width),bv=calc('not',a.width,{value:av.toString()});
    for(const sel of [p.select_a,1-p.select_a])emit({[p.a]:av,[p.b]:bv,[p.select]:sel},{[p.out]:sel===p.select_a?av:bv},0);
    emit({[p.a]:bv,[p.b]:av},{[p.out]:av},0);
  }else if(raw.method==='indexed_mux'){
    keys(p,['data','select','out','invalid']);check(Array.isArray(p.data)&&p.data.length>=2&&p.data.length<=32,'Need 2..32 ordered named inputs');
    const q=port(p.out,'output'),s=port(p.select,'input');check(s.width<=8&&BigInt(p.data.length)<=1n<<BigInt(s.width),'Selector does not address the bounded input domain');
    p.data.forEach(n=>port(n,'input',q.width));check(['zero','ones','unspecified'].includes(p.invalid),'Invalid selector policy');
    const a=pattern(q.width),b=calc('not',q.width,{value:a.toString()});
    for(let selected=0;selected<p.data.length;selected++)for(const invert of [false,true]){
      const chosen=invert?b:a,other=invert?a:b;
      emit({[p.select]:selected,...Object.fromEntries(p.data.map((n,i)=>[n,i===selected?chosen:other]))},{[p.out]:chosen},0);
    }
    const domain=2**s.width;
    if(p.data.length<domain){
      if(p.invalid==='unspecified')uncovered.push('Unused selector values have unspecified outputs and are not asserted.');
      else for(const selected of new Set([p.data.length,domain-1]))emit({[p.select]:selected},{[p.out]:p.invalid==='zero'?0n:mask(q.width)},0);
    }
  }else if(raw.method==='register'){
    keys(p,['data','out','enable','clock','reset']);const d=port(p.data,'input'),q=port(p.out,'output',d.width),e=p.enable===null?null:port(p.enable,'input');timing(true,true);
    check(!e||q.width%e.width===0&&e.width<=16,'Enable lanes must divide data width, <=16 lanes');
    const driveReset=active=>reset?{[reset.port]:active?reset.active:1-reset.active}:{},enAll=e?mask(e.width):0n,av=pattern(q.width),bv=calc('not',q.width,{value:av.toString()});
    let state=av;
    if(reset&&reset.value!=='unspecified')emit({...driveReset(true),[p.data]:bv,...(e?{[p.enable]:enAll}:{})},{[p.out]:reset.value==='zero'?0n:mask(q.width)},reset.kind==='async'?0:1);
    emit({...driveReset(false),[p.data]:av,...(e?{[p.enable]:enAll}:{})},{[p.out]:state});
    if(e){
      emit({[p.data]:bv,[p.enable]:0},{[p.out]:state});
      const lane=q.width/e.width;
      for(let i=0;i<e.width;i++){
        const laneMask=((1n<<BigInt(lane))-1n)<<BigInt(i*lane);state=(state&~laneMask)|(bv&laneMask);
        emit({[p.data]:bv,[p.enable]:1n<<BigInt(i)},{[p.out]:state});
      }
    }else emit({[p.data]:bv},{[p.out]:bv});
    if(reset&&reset.value!=='unspecified')emit(driveReset(true),{[p.out]:reset.value==='zero'?0n:mask(q.width)},reset.kind==='async'?0:1);
    if(reset?.value==='unspecified')uncovered.push('Reset output value is unspecified; only deasserted-reset capture, hold and enables are checked after a known full overwrite.');
  }else if(raw.method==='shift'){
    keys(p,['out','clock','reset','push','reload','priority']);const q=port(p.out,'output');timing();check(reset,'Shift checks require a specified reset');
    if(p.push){keys(p.push,['enable','bit']);port(p.push.enable,'input',1);port(p.push.bit,'input',1);}
    if(p.reload){keys(p.reload,['enable','data','bit']);port(p.reload.enable,'input',1);port(p.reload.bit,'input',1);port(p.reload.data,'input',q.width);}
    const actions=['reload','push'].filter(k=>p[k]);check(actions.length&&Array.isArray(p.priority)&&p.priority.length===actions.length&&new Set(p.priority).size===actions.length&&p.priority.every(k=>actions.includes(k)),'List every action exactly once in priority');
    let state=reset.value==='zero'?0n:mask(q.width);const off=Object.fromEntries(actions.map(k=>[p[k].enable,0]));
    emit({...off,[reset.port]:reset.active},{[p.out]:state},reset.kind==='async'?0:1);
    const step=(drive)=>{
      const chosen=p.priority.find(k=>Number(drive[p[k].enable]??0)===1);
      if(chosen){const a=p[chosen],v=chosen==='reload'?BigInt(drive[a.data]):state;state=calc('shl',q.width,{value:v.toString(),amount:1});state=calc('or',q.width,{left:state.toString(),right:String(drive[a.bit])});}
      emit({[reset.port]:1-reset.active,...off,...drive},{[p.out]:state});
    };
    if(p.reload)step({[p.reload.enable]:1,[p.reload.data]:pattern(q.width),[p.reload.bit]:1});
    if(p.push){step({[p.push.enable]:1,[p.push.bit]:1});step({[p.push.enable]:1,[p.push.bit]:0});}
    step({});
    if(actions.length===2)step({[p.reload.enable]:1,[p.reload.data]:pattern(q.width,true),[p.reload.bit]:0,[p.push.enable]:1,[p.push.bit]:1});
    emit({[reset.port]:reset.active,...Object.fromEntries(actions.flatMap(k=>[[p[k].enable,1],[p[k].bit,1]]))},{[p.out]:reset.value==='zero'?0n:mask(q.width)},reset.kind==='async'?0:1);
  }else if(raw.method==='automaton'){
    keys(p,['data','out','load','clock','table','boundary','left']);const d=port(p.data,'input'),q=port(p.out,'output',d.width);port(p.load,'input',1);keys(p.clock,['port','edge']);port(p.clock.port,'input',1);check(['posedge','negedge'].includes(p.clock.edge),'Invalid active edge');clock=p.clock;
    check(typeof p.table==='string'&&/^[01]{8}$/.test(p.table),'Use 8 truth-table bits, ordered 111..000');p.boundary=bit(p.boundary);check(['higher','lower'].includes(p.left),'Invalid neighbor orientation');
    let state=pattern(q.width);emit({[p.load]:1,[p.data]:state},{[p.out]:state});
    for(let cycle=0;cycle<4;cycle++){
      let next=0n;const cell=i=>i<0||i>=q.width?p.boundary:Number((state>>BigInt(i))&1n);
      for(let i=0;i<q.width;i++){const l=cell(i+(p.left==='higher'?1:-1)),c=cell(i),r=cell(i+(p.left==='higher'?-1:1)),index=(l<<2)|(c<<1)|r;if(p.table[7-index]==='1')next|=1n<<BigInt(i);}
      calculations.push({method:'binary-neighborhood',width:q.width,table:p.table,boundary:p.boundary,left:p.left,input:hex(state,q.width),output:hex(next,q.width),source_refs:raw.sources,snapshot:sha256(task.spec)});
      state=next;emit({[p.load]:0},{[p.out]:state});
    }
    state=pattern(q.width,true);emit({[p.load]:1,[p.data]:state},{[p.out]:state});
  }else if(raw.method==='fsm'){
    keys(p,['clock','reset','initial','states']);timing(false);check(reset,'FSM checks require a specified reset');
    check(Array.isArray(p.states)&&p.states.length>=2&&p.states.length<=12,'Need 2..12 semantic states');
    const names=new Set(p.states.map(s=>s.name));check(names.size===p.states.length&&names.has(p.initial),'Unique states and specified initial state required');
    const outputs=expected.ports.filter(r=>r.direction==='output');outputs.forEach(r=>port(r.name,'output',1));
    const events=expected.ports.filter(r=>r.direction==='input'&&!used.has(r.name));check(events.length<=5,'At most five FSM event inputs');events.forEach(r=>port(r.name,'input',1));
    for(const s of p.states){keys(s,['name','outputs','transitions']);check(typeof s.name==='string'&&/^[A-Za-z]\w{0,31}$/.test(s.name),'Use short semantic state names');keys(s.outputs,outputs.map(r=>r.name));for(const n of Object.keys(s.outputs))s.outputs[n]=bit(s.outputs[n]);check(Array.isArray(s.transitions)&&s.transitions.length<=32,'At most 32 priority transitions per state');for(const t of s.transitions){keys(t,['when','next']);check(object(t.when)&&names.has(t.next),'Invalid FSM transition');for(const [n,v]of Object.entries(t.when)){check(events.some(r=>r.name===n),'Unknown FSM event');t.when[n]=bit(v);}}}
    const states=new Map(p.states.map(s=>[s.name,s])),vectors=Array.from({length:2**events.length},(_,i)=>Object.fromEntries(events.map((r,b)=>[r.name,(i>>b)&1])));
    const advance=(name,v)=>states.get(name).transitions.find(t=>Object.entries(t.when).every(([n,b])=>v[n]===b))?.next??name;
    calculations.push(...checkFsmEventScope({spec:task.spec,states,initial:p.initial,events,vectors,advance}));
    const stimulus=fsmStimulus({states,initial:p.initial,vectors,advance,outputs,budget:Math.min(88,Math.floor(512/outputs.length))});
    for(const {events:sequence}of stimulus.chunks){
      let state=p.initial;emit({[reset.port]:reset.active,...vectors[0]},states.get(state).outputs,reset.kind==='async'?0:1);
      for(const event of sequence){state=advance(state,event);emit({[reset.port]:1-reset.active,...event},states.get(state).outputs);}
    }
    check(stimulus.chunks.length>0,'No reachable FSM check');
    const coverage=stimulus.coverage;calculations.push({operation:'fsm-stimulus-v2',...coverage});
    if(coverage.uncovered_states.length)uncovered.push('FSM states not observed (unreachable or budget-limited): '+coverage.uncovered_states.join(', '));
    if(coverage.missing_output_values.length)uncovered.push('FSM output values not observed: '+coverage.missing_output_values.join(', '));
    uncovered.push(`FSM targeted transitions with distinguishing suffixes: ${coverage.targeted_transitions}/${coverage.total_reachable_transitions}. Equivalent states and untested transitions remain unproven.`);
  }
  check(used.size===ports.size,'Every port must have a declared semantic role');
  const value={schema_version:2,status:'ready',clock,constraints:refs.map((r,i)=>({id:'C'+(i+1),quote:r.quote,claim:'Source requirement for the selected '+raw.method+' partial check.'})),scenarios:[{id:'T1',description:'Harness-generated '+raw.method+' checks',steps:rows}],uncovered};
  attachTableMetadata(value,raw);
  const compiled=compileScenarioPlan(value,{spec:task.spec,expected});
  return {value,calculations,coverage:{kind:'partial',method:raw.method,semantic_correctness:'unproven',comparisons:compiled.expectedChecks,source_steps:rows.length,method_profile:CHECK_METHOD_LIBRARY[raw.method]}};
}
