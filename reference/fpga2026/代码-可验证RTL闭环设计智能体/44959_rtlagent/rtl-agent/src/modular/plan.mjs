import {planningRequest, parsePlan, fallbackPlan} from '../planner/plan.mjs';
import {invariant, sha256} from '../dual/snapshot.mjs';
import {MODULAR_VERSION, validateArchitecture} from './contracts.mjs';

const MODULE_INSTRUCTIONS = `
PHASE 2 — SELECTIVE PHYSICAL MODULARITY:
Routing decomposition is none, logical or physical. Simple/uncertain tasks MUST use none. Timing difficulty and splitting benefit are separate: a small tightly coupled FSM should normally remain whole. Physical requires clear independent responsibilities and unchanged external cycle behavior. Never split one FSM state per module or invent pipeline stages/handshakes. Unsupported exact interfaces, multiple clocks, cross-module feedback or unclear timing use none/logical.
Insert ## Modules immediately before ## Session handoff. For none/logical write only: none
For physical, write ONE JSON object (no code fence) with exactly these fields:
{"benefit":"why boundaries reduce implementation burden without changing behavior","clock":{"port":null,"edge":null},"reset":{"port":null,"kind":"none","active":null,"priority":"source-backed priority, or unspecified"},"nets":[],"modules":[],"order":[]}
clock: a scalar top input and posedge/negedge, or null/null for combinational designs. reset: scalar top input, synchronous/asynchronous, active 0/1; absent reset uses null/none/null. Do not invent a clock/reset.
Each internal net has exactly {"name":"signal_name","range":null,"signed":false,"timing":"when it is valid and when the consumer samples it; state holds, simultaneous/back-to-back events"}. range is null for scalar, or numeric [msb,lsb].
Each of 2-3 leaf modules has exactly {"name":"LeafName","purpose":"one clear responsibility","requirements":["R1"],"kind":"combinational","ports":[],"timing":"exact sampling/latency/reset/priority contract","state_owner":"which state this module alone owns, or none","session_goal":"specific implementation conversation goal","carry":["verification","previous_attempts"]}.
Each port has exactly {"name":"port_name","direction":"input","range":null,"signed":false,"net":"top_port_or_internal_net"}. Directions input/output only. Ports and net ranges/signedness must match exactly. Each output/internal net has exactly one driver. All internal nets have consumers. Every accepted Requirement R ID must be assigned to a module; overlapping responsibility is allowed only where the requirement spans an interface. No executable RTL/testbench or expressions in connections. The 8B also writes a thin top containing only nets and instances; all functional logic belongs in leaf modules.
order lists each leaf name once, producers before consumers. The top is generated LAST automatically and is not listed as a leaf. No nested physical modules or cross-module feedback in this version. All sequential leaves receive the declared clock and reset. Contract validity does not prove temporal truth.
The existing implementation/repair session sections remain mandatory. Each leaf's session_goal specializes implementation; its carry can optionally request verification and previous_attempts. Original spec, exact interface, shared timing, local requirements, current module contract, neighbor contracts and (on repair) exact target code/evidence are ALWAYS carried by the program and cannot be removed.
Keep notes concise (target under 16000 UTF-8 bytes, hard limit 24000). Prefer 1-12 source requirements; up to 32 are accepted when necessary, without dropping real requirements solely to fit twelve lines. No other schema extensions.
`;

export function modularPlanningRequest(task, {nl2spec=true, feedback=null}={}) {
  const r=planningRequest(task,{nl2spec,feedback});
  r.systemPrompt=r.systemPrompt
    .replace('Decomposition is none or logical (NOT physical modules in phase 1). Simple/uncertain tasks use none. Even a complex tightly coupled FSM may use none; logical blocks only when named responsibilities have a clear benefit WITHOUT adding latency, states, resets or handshakes. Phase 1 always asks the 8B author for ONE complete top module.', 'Choose none/logical for one whole module, or physical according to the phase-2 contract below. Each 8B conversation writes exactly one module, not the whole project.')
    .replace('decomposition: none|logical','decomposition: none|logical|physical')
    .replace('Use 1-12 such lines.','Prefer 1-12 such lines; up to 32 when necessary.')
    .replace('One responsibility for simple tasks; otherwise only justified logical responsibilities within one module.','Responsibilities and split benefit; no physical split unless Routing selects physical.')
    .replaceAll('12000','16000')+MODULE_INSTRUCTIONS;
  if(feedback&&!nl2spec)r.prompt+='\n\n## Previous validation feedback\n\n'+feedback;
  return r;
}
export function parseModularPlan(markdown,task,{nl2spec=true,maxModules=3}={}) {
  invariant(typeof markdown==='string'&&Buffer.byteLength(markdown)<=24000,'PLAN_INVALID','Phase-2 plan exceeds 24000 bytes');
  const text=markdown.replace(/\r\n/g,'\n').trim();
  const matches=[...text.matchAll(/^## Modules\n([\s\S]*?)(?=^## |$(?![\s\S]))/gm)];
  invariant(matches.length===1&&text.slice(matches[0].index+matches[0][0].length).startsWith('## Session handoff'),'PLAN_MODULE_INVALID','Exactly one Modules section before Session handoff required');
  const physical=/^decomposition: physical$/m.test(text);
  const baseText=text.slice(0,matches[0].index)+text.slice(matches[0].index+matches[0][0].length);
  const plan=parsePlan(physical?baseText.replace(/^decomposition: physical$/m,'decomposition: logical'):baseText,task,{nl2spec,maxRequirements:32,maxBytes:24000});
  const body=matches[0][1].trim();
  let architecture=null,guard=null;
  if(physical) {
    // Do not parse/execute a physical plan on a route that must stay whole.
    if(['simple','uncertain'].includes(plan.difficulty)||plan.timing_risk==='uncertain')guard='simple_or_uncertain_must_not_physically_split';
    else {
      let raw;try{raw=JSON.parse(body);}catch{invariant(false,'PLAN_MODULE_INVALID','Modules must be one JSON object, without fences');}
      architecture=validateArchitecture(raw,task,plan.constraints,{maxModules});
    }
  } else invariant(body==='none','PLAN_MODULE_INVALID','An unsplit plan must have Modules: none');
  return {...plan,version:MODULAR_VERSION,markdown:text+'\n',sha256:sha256(text+'\n'),
    requested_decomposition:physical?'physical':plan.requested_decomposition,
    decomposition:architecture?'physical':guard?'none':plan.decomposition,physical_modules:Boolean(architecture),
    architecture,routing_guard:guard??plan.routing_guard};
}
export function unsplitPlan(plan,reason) {
  return {...plan,decomposition:'none',physical_modules:false,architecture:null,routing_guard:reason};
}
export function modularFallback(task,reason,{nl2spec=true}={}) {
  return {...fallbackPlan(task,reason,{nl2spec}),version:MODULAR_VERSION,architecture:null};
}
