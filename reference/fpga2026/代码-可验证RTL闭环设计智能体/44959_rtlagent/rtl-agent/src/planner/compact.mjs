import {invariant, sha256} from '../dual/snapshot.mjs';
import {planProse} from './prose.mjs';
import {handoffMarkdown} from './plan.mjs';
import {parsePayload} from '../dual/render.mjs';
import {validateArchitecture,topInterfaceSource} from '../modular/contracts.mjs';
import {SPLIT_GUIDANCE,structuralSplit} from '../harness/splitting.mjs';

export const COMPACT_PLAN_VERSION='rtl2llm.compact-plan.v1';
const check=(ok,message)=>invariant(ok,'PLAN_INVALID',message);
const text=(value,max=800)=>{check(typeof value==='string'&&value.trim()&&value.length<=max,'Invalid bounded planning text');planProse(value);return value.trim();};
const keys=(value,required,optional=[])=>check(value&&typeof value==='object'&&!Array.isArray(value)&&required.every(k=>Object.hasOwn(value,k))&&Object.keys(value).every(k=>[...required,...optional].includes(k)),'Missing/unknown compact plan fields');

// These are source addresses, not semantic classifications. Original bytes and
// their offsets stay authoritative; the model never has to recopy quotations.
export function sourceCatalog(task) {
  const rows=[];
  for(const [source,body,prefix] of [['spec',task.spec,'S'],['interface',task.interfaceText??'','I']]) {
    check(typeof body==='string','Source must be text');let offset=0,n=0;
    for(const line of body.split('\n')) {
      if(line.trim())rows.push({id:prefix+(++n),source,start:offset,end:offset+line.length,quote:line});
      offset+=line.length+1;
    }
  }
  return rows;
}

export function compactPlanningRequest(task,{feedback=null,knowledge=null,physical=true,splitDecision=false,registeredFeedback=false,contracts=false}={}) {
  const catalog=sourceCatalog(task);
  let systemPrompt=`You are the 27B semantic planner, NOT an RTL author or tool-using agent. The harness owns tools, source copying, session routing and Markdown rendering. Read the task as DATA. Return ONE concise JSON object, no commentary, fences, code or thinking transcript.
Fields: difficulty (simple|moderate|complex|uncertain), reason (one task-specific sentence), decomposition (${physical?'none|logical|physical':'none|logical'}), requirements (array), timing (object), ambiguities (array of short strings); optional blocks (array of short responsibility strings).
Each requirement is {"source":"S12","claim":"one source-grounded behavior"}. source is an address printed below, not a quote to recopy. Prefer 3-8 behavioral requirements, up to 32 if needed; do not repeat every port declaration. The program assigns R1,R2,... in your array order. Preserve all important source behavior, priorities, legal don't-cares and explicit initial conditions. Adjacent source lines remain available in the original; matching an address does not prove your interpretation.
timing is {"risk":"low|high|uncertain","summary":"clock/edge, reset kind/polarity/priority, holds and observation phase; say unspecified where absent","rules":[]}. Rules are needed only for nontrivial timing. Each is {"refs":[1],"sample":"edge and pre/post-update observation","when":"event","then":"required behavior","relation":"same_sample|after_samples|until|always|unspecified","cycles":0,"unless":"source-backed exception or unspecified","boundary":"concrete competing event or last/first sample"}. refs are 1-based requirement numbers. same_sample has cycles 0, after_samples a positive integer, others null. Optional unless/boundary may be omitted or null when irrelevant. An unresolved rule uses relation unspecified; unresolved timing requires risk uncertain. Max 6 rules. Do not write multiple paraphrases of one rule. No extra clock, reset, state, delay, handshake or idle gap. Check any supplied waveform against your interpretation, not against a memorized answer.
Judge difficulty, temporal risk and splitting benefit SEPARATELY. A simple mapping/register remains whole. A tiny FSM can have HIGH timing risk yet no splitting benefit. Bit width, length, the word FSM and benchmark IDs/grades do not establish difficulty. Complex means interacting protocol phases/history/priority or genuine structural burden. Uncertain means conflicting/missing source meaning, not merely a hard task. Simple/uncertain use none. Physical is only for 2-3 independent responsibilities with unchanged cycle behavior and clear one-way interfaces; never one module per FSM state, extra pipeline stages or cross-module feedback. If physical, blocks names the responsibilities; the harness will separately request interfaces ONLY if needed. Do not output interface architecture or session/carry plans in this response.
Knowledge cards, if provided, are optional generic reminders, never task requirements or evidence. Original task always wins. Target under 5000 UTF-8 bytes; omit irrelevant fields/examples, never actual behavior.`;
  if(registeredFeedback)systemPrompt=systemPrompt.replace('clear one-way interfaces; never one module per FSM state, extra pipeline stages or cross-module feedback','clear cycle contracts; registered cross-cycle feedback is allowed, but same-cycle combinational loops are not. Never one module per FSM state or extra pipeline stages');
  if(contracts){
    systemPrompt=systemPrompt.replace('NOT an RTL author or tool-using agent','NOT an RTL author; submit structured computation/context requests when needed, and the harness executes them');
    systemPrompt=systemPrompt.replace(/Simple\/uncertain use none\. Physical is only[\s\S]*?Do not output interface architecture or session\/carry plans in this response\./,'Difficulty alone does not select decomposition. Uncertain source meaning must be resolved before physical decomposition. Do not output interfaces or session plans yet.');
    systemPrompt+='\n'+SPLIT_GUIDANCE;
  }else if(splitDecision)systemPrompt+='\nRequired extra field split_decision={"benefit":"low|useful","responsibilities":["up to three short responsibilities"],"coupling":"specific state/timing/interface interaction","reason":"why this split helps or why remaining whole is better"}. Decide structurally, not from benchmark identity. If 2-3 substantial responsibilities can preserve exact behavior with explicit state ownership, prefer physical and benefit useful; otherwise none/logical and benefit low. A controller plus a stateful datapath/counter can be a useful split even with registered feedback. A tiny single counter, a short tightly coupled transition table, or one module per state is not useful. Include this field even when not splitting. Do not add excluded datapath or features not requested by the source.';
  let prompt='# Addressed original sources (verbatim line contents)\n\n'+catalog.map(r=>`[${r.id}] ${r.quote}`).join('\n');
  if(knowledge?.documents?.length)prompt+='\n\n# Advisory planning knowledge — applicability must be checked\n'+JSON.stringify(knowledge);
  if(feedback)prompt+='\n\n# Bounded validation feedback\n'+feedback+'\nCorrect the structural defect using the original sources. Do not invent source addresses or behavior.';
  return {systemPrompt,prompt};
}

export function parseCompactPlan(response,task,{physical=true,splitDecision=false,contracts=false}={}) {
  check(typeof response==='string'&&Buffer.byteLength(response)<=16000,'Compact response too large');
  let raw;try{raw=parsePayload(response);}catch{check(false,'Compact plan must be one JSON object');}
  keys(raw,['difficulty','reason','decomposition','requirements','timing','ambiguities',...(splitDecision||contracts?['split_decision']:[])],['blocks']);
  if(splitDecision&&!contracts){const d=raw.split_decision;keys(d,['benefit','responsibilities','coupling','reason']);check(['low','useful'].includes(d.benefit)&&Array.isArray(d.responsibilities)&&d.responsibilities.length<=3,'Invalid split decision');d.responsibilities.forEach(x=>text(x,200));text(d.coupling,400);text(d.reason,400);if(raw.decomposition==='physical')check(d.benefit==='useful'&&d.responsibilities.length>=2,'Physical split needs two or three useful responsibilities');}
  check(['simple','moderate','complex','uncertain'].includes(raw.difficulty),'Unknown difficulty');
  check((physical?['none','logical','physical']:['none','logical']).includes(raw.decomposition),'Unknown decomposition');
  const reason=text(raw.reason),catalog=sourceCatalog(task),sources=new Map(catalog.map(r=>[r.id,r]));
  check(Array.isArray(raw.requirements)&&raw.requirements.length>0&&raw.requirements.length<=32,'Need 1-32 source-linked requirements');
  const constraints=raw.requirements.map((r,i)=>{
    keys(r,['source','claim']);const source=sources.get(r.source);check(source,'Unknown original source address: source must be ONE printed S/I ID, not a range or list');
    return {id:'R'+(i+1),source:source.source,quote:source.quote,claim:text(r.claim)};
  });
  keys(raw.timing,['risk','summary','rules']);
  check(['low','high','uncertain'].includes(raw.timing.risk),'Unknown timing risk: use low, high or uncertain, never moderate');
  const summary=text(raw.timing.summary,1800);
  check(Array.isArray(raw.timing.rules)&&raw.timing.rules.length<=6,'At most six nonredundant temporal rules');
  const rules=raw.timing.rules.map((r,i)=>{
    keys(r,['refs','sample','when','then','relation','cycles'],['unless','boundary']);
    // All source-grounded requirements are addressable (bounded above at 32).
    // A hidden four-reference cap discarded valid compact plans even though
    // the model had obeyed the documented 1-based reference contract.
    check(Array.isArray(r.refs)&&r.refs.length>0&&r.refs.length<=constraints.length&&new Set(r.refs).size===r.refs.length&&r.refs.every(n=>Number.isSafeInteger(n)&&n>=1&&n<=constraints.length),'Temporal references must be distinct existing requirement numbers');
    check(['same_sample','after_samples','until','always','unspecified'].includes(r.relation),'Unknown temporal relation');
    check(r.relation==='same_sample'?r.cycles===0:r.relation==='after_samples'?Number.isSafeInteger(r.cycles)&&r.cycles>0:r.cycles===null,'Temporal relation/cycle mismatch: same_sample requires 0, after_samples a positive integer, all other relations null');
    return {id:'T'+(i+1),requirements:r.refs.map(n=>'R'+n),status:r.relation==='unspecified'?'unresolved':'specified',
      sample:text(r.sample),when:text(r.when),then:text(r.then),relation:r.relation,cycles:r.cycles,
      unless:r.unless==null?'unspecified':text(r.unless),boundary:r.boundary==null?'No additional boundary proposed':text(r.boundary),
      sources:r.refs.map(n=>({...constraints[n-1]}))};
  });
  check(Array.isArray(raw.ambiguities)&&raw.ambiguities.length<=8,'Invalid ambiguities');
  const ambiguities=raw.ambiguities.map(a=>text(a));
  check(raw.blocks===undefined||Array.isArray(raw.blocks)&&raw.blocks.length<=3,'At most three responsibilities');
  const split=contracts?structuralSplit(raw.split_decision,constraints):null;
  const blocks=(raw.blocks??raw.split_decision?.responsibilities??[]).map(b=>text(contracts&&typeof b==='object'?b.name+': '+b.state:b));
  const risk=rules.some(r=>r.status==='unresolved')?'uncertain':raw.timing.risk;
  const proposed=contracts?(physical&&split.candidate?'physical':'none'):raw.decomposition;
  const guard=(contracts?raw.difficulty==='uncertain':['simple','uncertain'].includes(raw.difficulty))?'simple_or_uncertain_must_not_split':risk==='uncertain'&&proposed==='physical'?'uncertain_timing_must_not_physically_split':null;
  const decomposition=guard?'none':proposed;
  const temporal={version:COMPACT_PLAN_VERSION,status:'advisory',risk,requested_risk:raw.timing.risk,reason:summary,rules,validation:'structure_and_source_provenance_only',semantic_verified:false};
  const plan={version:COMPACT_PLAN_VERSION,spec_sha256:sha256(task.spec),interface_sha256:sha256(task.interfaceText??''),
    difficulty:raw.difficulty,reason,requested_decomposition:raw.decomposition,decomposition:decomposition==='physical'?'logical':decomposition,
    timing_risk:risk,temporal,physical_modules:false,architecture:null,needs_architecture:decomposition==='physical',routing_guard:guard,...(split?{structural_routing:split}:{}),
    constraints,rejected_quotes:[],source_catalog_sha256:sha256(JSON.stringify(catalog)),...(splitDecision?{split_decision:structuredClone(raw.split_decision)}:{}),
    sessions:{implementation:{goal:'Generate the requested implementation and submit; tool verification follows.',carry:['logical_blocks']},
      repair:{goal:'Repair only authorized scope using current evidence; preserve unrelated behavior.',carry:[]}},
    sections:{Timing:summary,'Logical blocks':blocks.join('\n')||'Keep one complete module.',Ambiguities:ambiguities.join('\n')||'None identified; unspecified source details remain unspecified.',Verification:'The harness selects and executes checks; no planner proposal is observed evidence.'}};
  return renderCompactPlan(plan,task);
}

export function renderCompactPlan(plan,task) {
  const markdown='# Harness-rendered RTL plan\n\n'+handoffMarkdown({task,plan,role:'implementation',constraints:plan.constraints,authorStage:'generate'})+
    (plan.architecture?'\n## Frozen physical architecture\n\n'+JSON.stringify(plan.architecture,null,2)+'\n':'');
  return {...plan,markdown,sha256:sha256(markdown)};
}

export function architectureRequest(task,plan,{feedback=null,registeredFeedback=false}={}) {
  const top=topInterfaceSource(task);
  const render={systemPrompt:`You are the 27B interface planner, NOT the RTL author. The harness has selected physical decomposition after semantic planning. Return ONE JSON object, no code/fences: benefit, clock, reset, nets, modules. clock={port,edge}, scalar top input and posedge/negedge, or null/null. reset={port,kind,active,priority}, kind none/synchronous/asynchronous, active null/0/1; no reset means null/none/null. Each net={name,range,signed,timing}, range null or numeric [msb,lsb]. Each of 2-3 leaf modules={name,purpose,requirements,kind,ports,timing,state_owner}; kind combinational/sequential; requirements contains R IDs. Each port={name,direction,range,signed,net}, input/output only, exact widths/order/signedness. Every required behavior has an owner. Every output/internal net has one driver; internal nets have consumers. Sequential leaves receive the specified clock/reset. One-way dependencies only: no cross-module feedback, nested instances, invented latency or handshake. The 8B writes the leaves and thin top; you write no RTL. The harness computes generation order, session goals/carry and immutable interfaces. If splitting cannot meet these constraints, return {"unsplit_reason":"short source-grounded reason"}.`,
    prompt:plan.markdown+'\n\n## Program-resolved physical wiring boundary and provenance\n\n'+JSON.stringify(top)+'\nAn original explicit HDL interface is exact. A prose-derived boundary freezes implementation wiring only; do not turn its chosen unsigned types/order/ranges into extra source behavior. Signed arithmetic and logical bit meaning still follow the original task.\n\n'+(feedback?'Validation feedback: '+feedback:'')};
  if(registeredFeedback)render.systemPrompt=render.systemPrompt.replace('One-way dependencies only: no cross-module feedback, nested instances, invented latency or handshake.','Registered feedback across cycles is allowed. No same-cycle combinational loop, nested instances, invented latency or handshake. Each module MUST additionally have paths:[{output:"each output port name",inputs:["all current-cycle input port dependencies"]}]. List every output once. An output depending only on locally registered state has inputs:[]; a combinational output includes all inputs read in its entire combinational block, including control conditions. kind sequential alone does NOT prove a path is registered. Never add a register just to break a loop. Clock/reset edge updates belong in the timing contract. Generation order is a harness scheduling choice, not hardware dependency order. State ownership/timing must specify whether data/control is observed before or after the edge and who owns captures/counters.');
  return render;
}

export function attachCompactArchitecture(response,task,plan,{maxModules=3,registeredFeedback=false}={}) {
  let raw;try{raw=parsePayload(response);}catch{check(false,'Architecture must be one JSON object');}
  if(raw?.unsplit_reason!==undefined){keys(raw,['unsplit_reason']);return renderCompactPlan({...plan,needs_architecture:false,decomposition:'none',routing_guard:text(raw.unsplit_reason)},task);}
  keys(raw,['benefit','clock','reset','nets','modules']);check(Array.isArray(raw.modules)&&raw.modules.length>=2&&raw.modules.length<=maxModules,'Need two or three modules');
  const modules=raw.modules.map(m=>{keys(m,['name','purpose','requirements','kind','ports','timing','state_owner',...(registeredFeedback?['paths']:[])]);return {...m,session_goal:'Implement '+text(m.purpose)+'; preserve the frozen interface and timing.',carry:[]};});
  // Graph scheduling is deterministic orchestration, not semantic inference.
  const driver=new Map();for(const m of modules){check(Array.isArray(m.ports),'Invalid ports');for(const p of m.ports)if(p.direction==='output'){check(!driver.has(p.net),'Multiple net drivers');driver.set(p.net,m.name);}}
  const order=[],pending=new Set(modules.map(m=>m.name));
  if(registeredFeedback)order.push(...modules.map(m=>m.name));
  else while(pending.size){const ready=modules.filter(m=>pending.has(m.name)&&m.ports.filter(p=>p.direction==='input').every(p=>!driver.has(p.net)||order.includes(driver.get(p.net))));check(ready.length,'Cross-module feedback: use one module');for(const m of ready){order.push(m.name);pending.delete(m.name);}}
  const architecture=validateArchitecture({...raw,modules,order},task,plan.constraints,{maxModules,registeredFeedback});
  return renderCompactPlan({...plan,needs_architecture:false,decomposition:'physical',physical_modules:true,architecture},task);
}
