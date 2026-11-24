import {invariant} from '../dual/snapshot.mjs';
import {sourceCatalog} from '../planner/compact.mjs';
import {compileTestMethod,resolveTestSources,CHECK_METHOD_LIBRARY} from './methods.mjs';
import {compileScenarioPlan,SEMANTIC_REVIEW_REASON_MAX} from './plan.mjs';
import {verificationProse} from './prose.mjs';

const check=(ok,msg)=>invariant(ok,'TEST_SEMANTICS_UNCERTAIN',msg);
const object=x=>x&&typeof x==='object'&&!Array.isArray(x);
export const SEMANTIC_REVIEW_SCHEMA={type:'object',properties:{verdict:{type:'string',enum:['accept','revise','reset_only','uncertain']},patches:{type:'array',items:{type:'object',properties:{path:{type:'string'},value:{},source:{type:'string'}},required:['path','value','source'],additionalProperties:false},maxItems:8},reason:{type:'string',minLength:1,maxLength:SEMANTIC_REVIEW_REASON_MAX}},required:['verdict','patches','reason'],additionalProperties:false};

export function needsSemanticReview(raw){return CHECK_METHOD_LIBRARY[raw?.method]?.review===true;}
const editable=(method,path)=>/^\/(?:initial|select_a|table|boundary|left|priority|clock\/edge|reset\/(?:active|kind|value)|states\/\d+\/(?:outputs\/[A-Za-z_]\w*|transitions\/\d+\/(?:next|when\/[A-Za-z_]\w*)))$/.test(path)||({counter:/^\/(?:reset_value|low|high)$/,edge:/^\/(?:kind|reset\/history)$/,lfsr:/^\/(?:seed|taps\/\d+)$/,indexed_mux:/^\/invalid$/,moore_table:/^\/(?:initial|rows\/\d+\/(?:out|next)\/\d+)$/,bounded_moore:/^\/(?:initial|rows\/\d+\/(?:out|next)\/\d+)$/,state_logic:/^\/(?:encoding|rows\/\d+\/(?:outputs|next)\/\d+|next_outputs\/\d+\/bit)$/,shift_register:/^\/modes\/\d+\/(?:direction|amount)$/,packet_collector:/^\/(?:start_bit|start_value)$/,window_count:/^\/(?:window|ones)$/})[method]?.test(path);
export function semanticFields(raw){
  const leaves=[];
  const walk=(v,path)=>{
    if(editable(raw.method,path)){leaves.push({field:'F'+(leaves.length+1),path,value:v});return;}
    if(v&&typeof v==='object')for(const [k,x]of Object.entries(v))walk(x,path+'/'+k);
  };
  walk(raw.params,'');return leaves;
}
export function semanticReviewRequest({task,expected},raw){
  const fields=semanticFields(raw);
  const schema={...SEMANTIC_REVIEW_SCHEMA,properties:{...SEMANTIC_REVIEW_SCHEMA.properties,patches:{...SEMANTIC_REVIEW_SCHEMA.properties.patches,items:{type:'object',properties:{field:{type:'string',enum:fields.map(f=>f.field)},value:{anyOf:[{type:'string'},{type:'number'},{type:'array',items:{type:'string'}}]},source:{type:'string'}},required:['field','value','source'],additionalProperties:false}}}};
  if(!fields.length)schema.properties.patches={type:'array',items:{type:'object'},maxItems:0};
  const comb=raw.method==='comb_expr';
  if(comb)schema.properties.verdict={type:'string',enum:['accept','uncertain']};
  return {schema,systemPrompt:`Review ONLY the semantic parameters of this partial RTL test method against the ORIGINAL SPECIFICATION. This is a fresh bounded review, not a DUT diagnosis. There is no implementation, reference or observed output. Do not calculate vectors, write code, redesign, or repeat the full plan. Source addresses are supplied by the Harness.
Check ONLY this method's review focus supplied below. A source citation alone does not prove interpretation. For register/shift_register, an unspecified reset value must be represented as unspecified and then a full overwrite establishes known state; revise that field instead of rejecting all useful checks. For shift direction, movement toward higher numeric bit indices is LEFT shift; movement toward lower indices is RIGHT shift. Insertion into Q[0] requires LEFT, regardless of drawing direction. For serial shifting, distinguish temporal word order from physical insertion position: MSB-first word assembly appends successive bits at LSB (left shift); only an explicit source insertion position chooses otherwise. For a Moore table, verify event order, current-state output timing and ignored inputs separately per state.\n
${comb?'Return ONLY {"verdict":"accept|uncertain","patches":[],"reason":"one short source-based conclusion"}. Only explicit accept permits this checker. Do not revise or patch expressions. If any interpretation, operation width, signedness, slice or concatenation order is wrong or uncertain, return uncertain. accept confirms parameters, not full coverage.':'Return ONLY {"verdict":"accept|revise|reset_only|uncertain","patches":[],"reason":"one short source-based conclusion"}. accept confirms parameters, not full coverage. If a local defect is clear, use revise and <=8 patches {"field":"F1","value":"correct value","source":"S1"}. Choose ONLY supplied field IDs; the program owns paths and packaging. Never rename/reorder ports or states, add/remove transitions/taps, or change the method. If input order is wrong, return uncertain. Cite behavior text for every change. For FSM/register only, reset_only approves ONLY specified reset outputs when subsequent behavior cannot be justified. Unknown reset output cannot be approved. uncertain means no trustworthy subset.'} Make ONE pass over the supplied parameters. Compare explicit source rows directly; do not derive Boolean equations, rewrite tables, invent implementations, or enumerate stimuli. Stop at the first clear local defect, or accept immediately once the listed focus agrees. Do not repeat a completed check or invent a defect to provide patches. Submit immediately.`,
    prompt:'# Original specification\n'+sourceCatalog({spec:task.spec}).map(r=>'['+r.id+'] '+r.quote).join('\n')+'\n\n# Interface\n'+JSON.stringify(expected)+'\n\n# Proposed semantic parameters (unvalidated hypotheses)\n'+JSON.stringify(raw)+'\n\n# Editable semantic fields\n'+JSON.stringify(fields)+'\n\n# Method review focus\n'+JSON.stringify(CHECK_METHOD_LIBRARY[raw.method])};
}

export function applySemanticReview(raw,review,args){
  check(object(review)&&Object.keys(review).length===3&&['verdict','patches','reason'].every(k=>Object.hasOwn(review,k)),'Invalid semantic review envelope');
  check(['accept','revise','reset_only','uncertain'].includes(review.verdict)&&Array.isArray(review.patches)&&review.patches.length<=8&&typeof review.reason==='string'&&review.reason.trim()&&review.reason.length<=SEMANTIC_REVIEW_REASON_MAX,'Invalid bounded semantic review');
  verificationProse(review.reason);
  if(raw.method==='comb_expr'&&review.verdict!=='accept')return {value:{schema_version:2,status:'unsupported',reason:'Combinational expression review did not explicitly accept: '+review.verdict},calculations:[],coverage:{kind:'unsupported',semantic_review:review}};
  check(review.verdict==='revise'?review.patches.length>0:review.patches.length===0,'Patches require revise');
  if(review.verdict==='uncertain')return {value:{schema_version:2,status:'unsupported',reason:'Semantic review uncertain: '+review.reason},calculations:[],coverage:{kind:'unsupported',semantic_review:review}};
  const revised=structuredClone(raw),seen=new Set();
  for(let patch of review.patches){
    if(object(patch)&&Object.hasOwn(patch,'field')){
      check(Object.keys(patch).length===3&&['field','value','source'].every(k=>Object.hasOwn(patch,k)),'Invalid semantic field change');
      const field=semanticFields(raw).find(f=>f.field===patch.field);check(field,'Unknown semantic field ID');
      patch={path:field.path,value:patch.value,source:patch.source};
    }
    check(object(patch)&&Object.keys(patch).length===3&&['path','value','source'].every(k=>Object.hasOwn(patch,k)),'Invalid semantic patch');
    check(typeof patch.path==='string'&&!seen.has(patch.path),'Duplicate/invalid semantic path');seen.add(patch.path);
    check(editable(revised.method,patch.path),'Patch cannot change structural roles');
    resolveTestSources([patch.source],args.task);
    const segments=patch.path.slice(1).split('/');let parent=revised.params;
    for(const key of segments.slice(0,-1)){check(object(parent)||Array.isArray(parent),'Missing semantic patch parent');check(Object.hasOwn(parent,key),'Missing semantic patch path');parent=parent[key];}
    const key=segments.at(-1);check(parent&&Object.hasOwn(parent,key),'Cannot add semantic leaves');parent[key]=structuredClone(patch.value);
  }
  const compiled=compileTestMethod(revised,args);
  if(review.verdict==='reset_only'){
    const p=revised.params;
    check(['fsm','register'].includes(revised.method)&&p.reset&&p.reset.value!=='unspecified','Reset-only subset unavailable');
    const row=compiled.value.scenarios[0].steps[0];
    check(Number(BigInt(row.drive[p.reset.port]))===Number(p.reset.active),'First sample is not reset');
    compiled.value.scenarios[0].steps=[row];
    compiled.value.uncovered.push('Semantic review approved reset outputs only; all transition/capture/hold behavior remains untested. '+review.reason);
  }
  const normalized=compileScenarioPlan(compiled.value,{spec:args.task.spec,expected:args.expected});
  compiled.coverage={...compiled.coverage,comparisons:normalized.expectedChecks,source_steps:compiled.value.scenarios[0].steps.length,semantic_correctness:'reviewed_not_proven',semantic_review:review};
  // CPU-authored metadata is retained with the plan and passed to diagnosis.
  compiled.value.assurance={version:1,method:raw.method,semantic_correctness:'reviewed_not_proven',review_verdict:review.verdict,reason:review.reason};
  return compiled;
}

// A self-generated oracle can be wrong. A failed simulation alone must not
// trigger regeneration after a reviewer abstains or questions the checker.
export function routeSelfTestRepair(checks,review){
  const failed=(checks??[]).filter(c=>c.status==='fail');
  if(failed.some(c=>c.infrastructure_error))return {kind:'infrastructure',repair:false};
  if(!failed.length)return {kind:'no_confirmed_failure',repair:false};
  if(failed.some(c=>['compile','interface'].includes(c.stage)))return {kind:'compile_or_interface',repair:true};
  const payload=review?.message?.payload??review?.payload??review;
  const issues=payload?.issues??[],evidence=new Set(failed.map(c=>c.evidence?.id));
  const actionable=issues.filter(i=>i.category!=='checker'&&i.evidence_ids?.some(id=>evidence.has(id)));
  if(payload?.verdict==='issues_found'&&actionable.length)return {kind:'rtl',repair:true};
  // A confirmed compiler/interface failure still has a deterministic fix path.
  if(payload?.verdict==='checker_suspect'||issues.some(i=>i.category==='checker'))return {kind:'checker_suspect',repair:false};
  return {kind:'diagnosis_uncertain',repair:false};
}
