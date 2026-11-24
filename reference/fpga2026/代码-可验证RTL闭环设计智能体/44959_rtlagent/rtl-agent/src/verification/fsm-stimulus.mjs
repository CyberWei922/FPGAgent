// Source-table-only stimulus. Product-machine BFS finds a shortest observable
// distinction; equivalent semantic states are reported, never invented apart.
export function fsmStimulus({states,initial,vectors,advance,outputs,budget=88}){
 const signature=s=>outputs.map(o=>states.get(s).outputs[o.name]).join('');
 const paths=new Map([[initial,[]]]),queue=[initial];
 while(queue.length){const s=queue.shift();for(const v of vectors){const n=advance(s,v);if(!paths.has(n)){paths.set(n,[...paths.get(s),v]);queue.push(n);}}}
 const distinguish=(a,b)=>{
  const queue=[[a,b,[]]],seen=new Set();
  while(queue.length){const [x,y,seq]=queue.shift(),key=x+':'+y;if(seen.has(key))continue;seen.add(key);
   if(signature(x)!==signature(y))return seq;
   for(const v of vectors)queue.push([advance(x,v),advance(y,v),[...seq,v]]);
  }return null;
 };
 const chunks=[],covered=new Set(),observed=new Map(outputs.map(o=>[o.name,new Set()]));let used=0;
 const add=(events,tag)=>{if(used+events.length+1>budget)return false;used+=events.length+1;chunks.push({events,tag});let s=initial;
  for(const v of [null,...events]){if(v)s=advance(s,v);covered.add(s);for(const o of outputs)observed.get(o.name).add(states.get(s).outputs[o.name]);}return true;};
 // Rare output values first: reaching an alarm/end phase cannot be starved by
 // dozens of input combinations belonging to the initial state.
 for(const o of outputs)for(const bit of [0,1]){
  if(observed.get(o.name).has(bit))continue;
  const witness=[...paths].filter(([s])=>states.get(s).outputs[o.name]===bit).sort((a,b)=>a[1].length-b[1].length)[0];
  if(witness)add(witness[1],'output-value witness');
 }
 const candidates=new Map(),equivalent=[];
 for(const [s,path]of paths){const byInput=[];
  for(let vi=0;vi<vectors.length;vi++){
   const v=vectors[vi],next=advance(s,v),suffixes=new Map();
   for(const other of states.keys())if(other!==next){const suffix=distinguish(next,other);
    if(suffix===null){equivalent.push([next,other]);continue;}
    suffixes.set(JSON.stringify(suffix),suffix);
   }
   byInput.push([...suffixes.values()].sort((a,b)=>b.length-a.length).map(suffix=>({events:[...path,v,...suffix],key:s+':'+vi,suffix:suffix.length})));
  }
  // Cover other input transitions before spending more budget on alternative
  // suffixes of the same transition. State fairness alone is insufficient.
  const list=[];
  for(let depth=0;depth<Math.max(...byInput.map(a=>a.length));depth++)for(const input of byInput)if(input[depth])list.push(input[depth]);
  candidates.set(s,list);
 }
 const tested=new Set(),suffixChecks=[];
 // Round-robin states, not nested state/input loops with break outer.
 const reserve=Math.min(24,Math.floor(budget/3)),transitionLimit=budget-reserve;
 for(let round=0;round<128;round++){
  let any=false;
  for(const [s,list]of candidates){const c=list[round];if(!c)continue;any=true;
   if(used+c.events.length+1<=transitionLimit&&add(c.events,'transition with distinguishing suffix')){tested.add(c.key);suffixChecks.push({state:s,transition:c.key,suffix_length:c.suffix});}
  }if(!any)break;
 }
 // Long repetition plus deterministic random continuation has no inserted idle
 // between patterns. It also exercises prefix/suffix overlap across probes.
 let seed=0x5eed1234;const random=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return vectors[(seed>>>0)%vectors.length];};
 const stream=[];for(const v of vectors.slice(0,2))stream.push(...Array(6).fill(v));
  if(budget-used>1)add(stream.slice(0,Math.min(12,budget-used-1)),'long repeated inputs');
  while(budget-used>1){const length=Math.min(12,budget-used-1);add(Array.from({length},random),'fixed-seed random overlap');}
 const missingStates=[...states.keys()].filter(s=>!covered.has(s)),missingOutputs=outputs.flatMap(o=>[0,1].filter(b=>!observed.get(o.name).has(b)).map(b=>o.name+'='+b));
 return {chunks,coverage:{reachable:[...paths.keys()],observed_states:[...covered],uncovered_states:missingStates,
  missing_output_values:missingOutputs,targeted_transitions:tested.size,total_reachable_transitions:paths.size*vectors.length,
  suffix_checks:suffixChecks,equivalent_state_pairs:[...new Set(equivalent.map(p=>p.sort().join('/')))],seed:'0x5eed1234'}};
}
