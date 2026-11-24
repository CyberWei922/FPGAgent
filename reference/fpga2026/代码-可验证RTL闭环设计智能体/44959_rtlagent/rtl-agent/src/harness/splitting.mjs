import {invariant} from '../dual/snapshot.mjs';
import {planProse} from '../planner/prose.mjs';

export const SPLIT_PATTERNS=['none','control_datapath','state_domains','compute_storage','multiple_fsms','repeated_kernel'];
const check=(ok,message)=>invariant(ok,'PLAN_INVALID',message);
const exact=(o,keys)=>check(o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).length===keys.length&&keys.every(k=>Object.hasOwn(o,k)),'Invalid structural split fields');
const short=(s,n)=>{check(typeof s==='string'&&s.trim()&&s.length<=n,'Invalid split explanation');planProse(s);};

export const SPLIT_GUIDANCE=`Replace subjective split benefit with a structural candidate. Required split_decision={"pattern":"none|control_datapath|state_domains|compute_storage|multiple_fsms|repeated_kernel","responsibilities":[{"name":"short responsibility","refs":[1],"state":"owned state, or none for combinational logic"}],"coupling":"specific signals and same-cycle/cross-cycle interaction","blocker":"none|trivial|source_uncertain|latency_change|unsupported_boundary","reason":"one concrete reason"}.
Markers: protocol/controller plus meaningful capture/packing/arithmetic datapath; distinct state stores with different update rules; substantial combinational computation plus state storage; multiple FSMs with distinct jobs; repeated nontrivial computation. On a marker, propose TWO or THREE source-backed responsibilities for the harness to evaluate. No independent state/handshake is required. Shared clock, same-cycle priority, combinational feed-forward and registered feedback are NOT rejection reasons. Preserve the original cycle behavior. Pure combinational modules are allowed. Do not split a tiny mapping, a lone counter, individual FSM states or arbitrary halves of one transition table. Those use pattern none, blocker trivial, zero/one responsibility; coupling may be an empty string because there is no proposed module boundary. Do not invent a datapath absent from the source. refs are existing 1-based requirement numbers. For a real marker use blocker none unless the ORIGINAL source leaves the boundary ambiguous, would require extra latency, or needs unsupported clocks/inout. Detail a real blocker; do not substitute vague coupling or interface overhead. decomposition is advisory: the harness decides whether to request exact interfaces. Do not output ports yet.`;

export function structuralSplit(raw,requirements) {
  exact(raw,['pattern','responsibilities','coupling','blocker','reason']);
  check(SPLIT_PATTERNS.includes(raw.pattern),'Unknown split marker');
  check(['none','trivial','source_uncertain','latency_change','unsupported_boundary'].includes(raw.blocker),'Unknown split blocker');
  check(Array.isArray(raw.responsibilities)&&raw.responsibilities.length<=3,'At most three responsibilities');
  // No boundary is proposed for pattern none. Do not ask a second model call
  // to invent coupling prose; real structural candidates still require it.
  if(raw.pattern==='none'&&typeof raw.coupling==='string'&&!raw.coupling.trim())check(raw.coupling.length<=500,'Invalid split explanation');
  else short(raw.coupling,500);
  short(raw.reason,400);
  const names=new Set();
  for(const r of raw.responsibilities){
    exact(r,['name','refs','state']);short(r.name,120);short(r.state,180);
    check(!names.has(r.name),'Duplicate split responsibility');names.add(r.name);
    check(Array.isArray(r.refs)&&r.refs.length>0&&new Set(r.refs).size===r.refs.length&&r.refs.every(n=>Number.isSafeInteger(n)&&n>=1&&n<=requirements.length),'Split refs must identify existing requirements');
  }
  if(raw.pattern==='none')check(raw.responsibilities.length<=1&&raw.blocker!=='none','No marker requires a concrete no-split reason');
  else check(raw.responsibilities.length>=2&&raw.blocker!=='trivial','A structural marker needs 2-3 responsibilities; shared timing is not a triviality blocker');
  return {candidate:raw.pattern!=='none'&&raw.blocker==='none',reason:raw.pattern==='none'?'no_structural_marker':raw.blocker==='none'?'structural_candidate:'+raw.pattern:'split_blocker:'+raw.blocker};
}
