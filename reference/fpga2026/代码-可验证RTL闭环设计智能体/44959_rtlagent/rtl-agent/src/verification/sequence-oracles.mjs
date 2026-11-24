import {invariant} from '../dual/snapshot.mjs';
import {requiresMealy} from './source-consistency.mjs';
const check=(ok,message)=>invariant(ok,'TEST_PLAN_INVALID',message);
// Prompts wrap prose lines; a quote matches across any whitespace run.
const compact=s=>String(s).replace(/\s+/g,' ').trim();

// Selected C 86b8384 sequence_detector_v2 and mealy_table interpreters, with
// explicit output phase and state-fair bounded probes. No C budgets/fallback.
export function compileSequenceOracle(method,p,{task,port,timing,emit,uncovered,calculations}){
 if(!['sequence_detector_v2','mealy_table'].includes(method))return false;
 timing(false);
 if(method==='sequence_detector_v2'){
  port(p.data,'input',1);port(p.out,'output',1);
  check(task.spec.includes(p.pattern),'Sequence pattern must occur literally in the source');
  check(typeof p.timing_quote==='string'&&compact(task.spec).includes(compact(p.timing_quote)),'Output timing must quote the original source exactly');
  check(p.timing==='mealy'?requiresMealy(p.timing_quote)||/before[^.;]*(?:edge|clock)/i.test(p.timing_quote):
   !requiresMealy(task.spec)&&/register(?:ed)?|after[^.;]*(?:edge|clock)|on[^.;]*(?:edge|clock)/i.test(p.timing_quote),'Output timing quote does not establish the selected Mealy/registered phase');
  let history='',latched=0,registered=0,rows=0;
  const send=(bit,reset=false)=>{
   if(rows+(reset?1:2)>88)return false;
   const d={[p.data]:bit,[p.reset.port]:reset?p.reset.active:1-p.reset.active};
   if(reset){history='';latched=0;registered=0;emit(d,{[p.out]:0},p.reset.kind==='async'?0:1);rows++;return true;}
   const nextHistory=(history+bit).slice(-p.pattern.length),hit=Number(nextHistory===p.pattern),value=p.output==='sticky'?latched||hit:hit;
   emit(d,{[p.out]:p.timing==='mealy'?value:registered},0);rows++;
   history=hit&&!p.overlap?'':nextHistory;if(hit)latched=1;registered=value;
   emit({},p.timing==='registered'?{[p.out]:registered}:{},1);rows++;return true;
  };
  const stream=bits=>{for(const bit of bits)if(!send(+bit))return false;return true;};
  let border=0;for(let n=1;n<p.pattern.length;n++)if(p.pattern.startsWith(p.pattern.slice(-n)))border=n;
  // Maximal overlap and consecutive complete words have priority. No idle bit
  // is inserted between words or between the shared prefix and suffix.
  for(const bits of [p.pattern+p.pattern.slice(border),p.pattern+p.pattern]){
   if(rows+1+2*bits.length>88){uncovered.push('Budget excludes an additional consecutive-pattern probe.');continue;}
   send(0,true);stream(bits);
  }
  if(rows+4+2*p.pattern.length<=88){send(0,true);send(+p.pattern[0]);send(1,true);stream(p.pattern);}
  else uncovered.push('Mid-prefix reset plus a complete subsequent word exceeds the bounded budget.');
  // Incorrect prefix fallback must also be exercised, not just clean matches.
  let seed=0x5eed1234;while(rows+2<=88){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;send((seed>>>0)&1);}
  uncovered.push('Bounded literal sequence checks. Overlap and pulse/sticky policy remain source-declared, not inferred from a reference implementation.');
  calculations.push({method,oracle:'cpu_pattern_history',pre_edge_sampling:true,output_timing:p.timing,maximal_border:border,candidate_read:false});
 }else{
  p.events.forEach(n=>port(n,'input',1));p.outputs.forEach(n=>port(n,'output',1));
  const combinations=2**p.events.length,budget=Math.min(88,Math.floor(512/p.outputs.length));
  check(p.initial<p.rows.length&&p.rows.every(r=>r.next.length===combinations&&r.next.every(n=>n<p.rows.length)&&r.out.length===combinations&&r.out.every(bits=>bits.length===p.outputs.length)),'Mealy table dimensions or destination invalid');
  check(p.reset_outputs===null||p.reset_outputs.length===p.outputs.length,'Reset output gating width mismatch');
  check(!requiresMealy(task.spec)||p.rows.some(r=>r.out.some(bits=>String(bits)!==String(r.out[0]))),'Source requires Mealy input dependence but all output columns are Moore-only');
  const drive=v=>Object.fromEntries(p.events.map((n,i)=>[n,(v>>(p.events.length-1-i))&1]));
  const outputs=(state,v)=>Object.fromEntries(p.outputs.map((n,i)=>[n,p.rows[state].out[v][i]]));
  const paths=new Map([[p.initial,[]]]),queue=[p.initial];
  for(const s of queue)for(let v=0;v<combinations;v++){const n=p.rows[s].next[v];if(!paths.has(n)){paths.set(n,[...paths.get(s),v]);queue.push(n);}}
  let count=0;const probes=new Set(),observed=p.outputs.map(()=>new Set());
  const probe=(state,v)=>{
   const path=paths.get(state);if(count+1+2*(path.length+1)>budget)return false;
   emit({[p.reset.port]:p.reset.active,...drive(0)},p.reset_outputs?Object.fromEntries(p.outputs.map((n,i)=>[n,p.reset_outputs[i]])):{},p.reset.kind==='async'?0:1);count++;
   let current=p.initial;
   for(const event of [...path,v]){
    emit({[p.reset.port]:1-p.reset.active,...drive(event)},outputs(current,event),0);
    p.rows[current].out[event].forEach((b,i)=>observed[i].add(b));probes.add(current+':'+event);
    emit({}, {},1);current=p.rows[current].next[event];count+=2;
   }return true;
  };
  for(let i=0;i<p.outputs.length;i++)for(const value of [0,1])if(!observed[i].has(value)){
   const witness=[...paths.keys()].flatMap(s=>Array.from({length:combinations},(_,v)=>[s,v])).find(([s,v])=>p.rows[s].out[v][i]===value);
   if(witness)probe(...witness);
  }
  for(let v=0;v<combinations;v++)for(const s of paths.keys())if(!probes.has(s+':'+v))probe(s,v);
  check(probes.size>0,'No reachable Mealy probe');
  const missing=p.rows.map((_,i)=>i).filter(s=>!paths.has(s));if(missing.length)uncovered.push('Unreachable Mealy source states: '+missing.join(','));
  for(let i=0;i<p.outputs.length;i++)for(const v of [0,1])if(!observed[i].has(v))uncovered.push('Unobserved Mealy output '+p.outputs[i]+'='+v);
  uncovered.push('Mealy transitions observed '+probes.size+'/'+paths.size*combinations+'. Outputs settle before active edges; no registered-output latency is assumed.');
  calculations.push({method,oracle:'cpu_mealy_table',pre_edge_sampling:true,candidate_read:false});
 }
 return true;
}
