import {invariant} from '../dual/snapshot.mjs';
const check=(ok,message)=>invariant(ok,'TEST_PLAN_INVALID',message);

// Small synchronous Boolean networks. Tables are source semantics, never DUT
// values. Unknown startup is a SET of states, not an invented all-zero state.
export function compileBoundedUpdate(p,{task,port,timing,emit,uncovered,calculations}){
 timing(false);p.inputs.forEach(n=>port(n,'input',1));p.outputs.forEach(o=>port(o.port,'output',1));
 const states=2**p.state_bits,alphabet=2**p.inputs.length,size=states*alphabet;
 check(p.next.length===size&&p.next.every(n=>n<states),'Next-state table must cover every old-state/input combination');
 check(p.outputs.every(o=>o.values.length===size),'Output tables must cover settled CURRENT state and input');
 check(p.reset_value<states,'Reset value exceeds state width');
 check(!(p.reset&&p.initial),'Use reset or explicit initial state, not both');
 if(p.initial)check(p.initial.value===0&&task.spec.replace(/\s+/g,' ').includes(p.initial.quote.replace(/\s+/g,' '))&&/initial(?:ly)?[^.!?]*\bzero\b/i.test(p.initial.quote),
  'Initial all-zero state needs an exact affirmative source quote; otherwise initialize by overwrite');
 const drive=v=>({...Object.fromEntries(p.inputs.map((n,i)=>[n,(v>>(p.inputs.length-1-i))&1])),...(p.reset?{[p.reset.port]:1-p.reset.active}:{})});
 const output=(s,v)=>Object.fromEntries(p.outputs.map(o=>[o.port,o.values[s*alphabet+v]]));
 const next=(s,v)=>p.next[s*alphabet+v];
 let state=p.initial?0:null,rows=0;
 const seen=new Set(),observed=new Map(p.outputs.map(o=>[o.port,new Set()]));
 const send=(d,e,n)=>{check(rows<89,'Bounded update exceeds scenario budget');emit(d,e,n);rows++;for(const [k,v] of Object.entries(e))observed.get(k).add(v);};
 if(p.reset){state=p.reset_value;send({...drive(0),[p.reset.port]:p.reset.active},output(state,0),p.reset.kind==='async'?0:1);}
 else if(p.initial)send(drive(0),output(state,0),0);
 else{
  const start=Array.from({length:states},(_,i)=>i),queue=[{set:start,path:[]}],visited=new Set([start.join(',')]);let sync=null;
  for(let i=0;i<queue.length&&!sync;i++){
   const node=queue[i];if(node.path.length>=8)continue;
   for(let v=0;v<alphabet;v++){
    const set=[...new Set(node.set.map(s=>next(s,v)))].sort((a,b)=>a-b),path=[...node.path,v];
    if(set.length===1){sync={state:set[0],path};break;}
    const key=set.join(',');if(!visited.has(key)){visited.add(key);queue.push({set,path});}
   }
  }
  check(sync,'No bounded full-state overwrite/synchronizing sequence; unknown startup cannot be assumed');
  for(const v of sync.path)send(drive(v),{},1);
  state=sync.state;send(drive(sync.path.at(-1)),output(state,sync.path.at(-1)),0);
  calculations.push({operation:'known_state_synchronization',all_start_states:states,input_sequence:sync.path,final_state:state});
 }
 const step=v=>{
  if(rows+2>88)return false;
  // cycles=0 settles inputs without clocking, so combinational and registered
  // outputs are distinguished on BOTH sides of the edge.
  send(drive(v),output(state,v),0);seen.add(state+':'+v);state=next(state,v);send(drive(v),output(state,v),1);return true;
 };
 const pathTo=target=>{
  const queue=[{s:state,path:[]}],visited=new Set([state]);
  for(const node of queue){if(node.s===target)return node.path;for(let v=0;v<alphabet;v++){const s=next(node.s,v);if(!visited.has(s)){visited.add(s);queue.push({s,path:[...node.path,v]});}}}return null;
 };
 // Input-major rounds avoid spending the budget on one early state's inputs.
 const unreachable=new Set();for(let v=0;v<alphabet;v++)for(let s=0;s<states;s++){
  if(seen.has(s+':'+v))continue;const path=pathTo(s);
  if(path===null){unreachable.add(s);continue;}
  if(rows+2*(path.length+1)>88)continue;
  for(const a of path)step(a);step(v);
 }
 let seed=0x5eed1234;while(rows+2<=88){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;step((seed>>>0)%alphabet);}
 if(unreachable.size)uncovered.push('Unreachable Boolean states: '+[...unreachable].join(', '));
 const missing=[];for(let s=0;s<states;s++)for(let v=0;v<alphabet;v++)if(!seen.has(s+':'+v))missing.push(s+':'+v);
 if(missing.length)uncovered.push('Uncovered Boolean transitions (state:input): '+missing.join(', '));
 for(const [name,values] of observed)for(const value of [0,1])if(!values.has(value))uncovered.push('Unobserved output '+name+'='+value);
 calculations.push({operation:'bounded_boolean_update',state_bits:p.state_bits,table_entries:size,transitions_observed:seen.size,pre_edge_sampling:true,candidate_read:false});
 uncovered.push('At most three state bits and three scalar data inputs; table correctness remains source/model dependent. No inferred startup, multi-clock or bus protocol.');
}
