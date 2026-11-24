import {sourceCatalog} from '../planner/compact.mjs';
import {adaptPayload} from '../dual/render.mjs';
import {invariant} from '../dual/snapshot.mjs';
import {diagnosticProse} from '../dual/contracts.mjs';
import {codeCatalog,resolveLocations} from './code-references.mjs';
import {indexUnits} from '../dual/unit-index.mjs';
import {DIAGNOSIS_LIMITS as bounds} from './repair-policy.mjs';
import {readableObservation,diagnosisEvidenceSection} from './diagnosis-evidence.mjs';

const check=(ok,message)=>invariant(ok,'AUX_PROTOCOL_INVALID',message);
const keys=(o,names)=>check(o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).length===names.length&&names.every(k=>Object.hasOwn(o,k)),'Missing/unknown diagnosis fields');
const short=(s,max)=>{check(typeof s==='string'&&s.trim()&&s.length<=max,'Invalid bounded diagnosis text');diagnosticProse(s);return s;};
export function functionalCoverage(checks=[]){
  const simulations=checks.filter(c=>c.stage==='simulate');
  const status=!simulations.length?'not_run':simulations.some(c=>c.status==='fail')?'failed':simulations.every(c=>c.status==='pass')?'partial_pass':'inconclusive';
  return {status,executed:simulations.some(c=>['pass','fail'].includes(c.status)),checks:simulations.map(c=>({id:c.id,status:c.status})),functional_verified:false};
}
export function diagnosticCatalog(req,{compact=false,simple=false}={}){
  const p=req.payload;
  return Object.fromEntries([...sourceCatalog({spec:p.spec_text,interfaceText:p.interface_text??''}).map(r=>[r.id,r]),
    ...p.evidence.map((e,i)=>['E'+(i+1),e]),...p.units.map(u=>[u.unit_id,{...u,text:Buffer.from(p.candidate.rtl).subarray(u.start_byte,u.end_byte).toString('utf8')}]),...(simple?Object.entries(codeCatalog(p.candidate.rtl)):[]),...(compact?p.constraints.map((c,i)=>['A'+(i+1),c]):[]),...(compact&&p.repair_context?.previous_candidate?[['P1',p.repair_context.previous_candidate]]:[])]);
}
export function diagnosticRequest(req,{checks=[],compact=false,simple=false,selfTestScope=null,selfTestAssurance=null,evidenceBrief=null}={}){
  const p=req.payload,catalog=diagnosticCatalog(req,{compact,simple}),prior=p.repair_context?.previous_issues??[];
  // Keep the complete authorized catalog available to fetch_context, while
  // sending RTL exactly once and only the first failed evidence in full.
  const focused=simple&&prior.length>0;
  // Review the queued defect, not a later pipeline failure exposed by its fix.
  // Syntax-only batches begin with current compiler evidence, even on pass.
  const compilerOnly=focused&&prior.every(i=>i.category==='syntax');
  const first=(compilerOnly?checks.find(c=>c.stage==='compile'):null)??checks.find(c=>c.status==='fail'),evidenceKeys=Object.keys(catalog).filter(k=>/^E\d+$/.test(k));
  const firstKey=evidenceKeys.find(k=>catalog[k].id===first?.evidence?.id)??evidenceKeys[0];
  const compactCatalog=compact?Object.fromEntries(Object.entries(catalog).filter(([key])=>!/^C\d+$/.test(key)).map(([key,v])=>{
    if(/^[SI]\d+$/.test(key))return [key,v.quote];
    if(/^A\d+$/.test(key))return [key,{id:v.id,claim:v.claim,source_address:Object.entries(catalog).find(([k,r])=>/^[SI]\d+$/.test(k)&&r.quote===v.quote)?.[0]??null,advisory_only:true}];
    if(key==='P1')return [key,{id:v.id,sha256:v.sha256,available:'fetch_context for previous candidate RTL'}];
    if(/^E\d+$/.test(key))return [key,key===firstKey?Object.fromEntries(Object.entries(v).filter(([k])=>k!=='observation')):{id:v.id,source:v.source,available:'fetch_context by this E address; not yet inspected'}];
    return [key,{unit_id:v.unit_id,kind:v.kind,start_byte:v.start_byte,end_byte:v.end_byte,summary:v.summary}];
  })):catalog;
  const constraints=compact?p.constraints.map((c,i)=>({id:c.id,source_address:Object.entries(catalog).find(([k,v])=>/^[SI]\d+$/.test(k)&&v.quote===c.quote)?.[0]??null,advisory_address:'A'+(i+1)})):p.constraints;
  const repairContext=compact&&p.repair_context?{...p.repair_context,previous_candidate:{id:p.repair_context.previous_candidate?.id,sha256:p.repair_context.previous_candidate?.sha256,context_address:'P1'},previous_issues:prior.map(i=>({id:i.id,category:i.category,scope:i.scope,unit_ids:i.unit_ids,explanation:i.explanation,repair_goal:i.repair_goal}))}:p.repair_context;
  const deliveredRefs=compact?Object.keys(catalog).filter(k=>k!=='P1'&&(!/^E\d+$/.test(k)||k===firstKey)):Object.keys(catalog);
  const simplePrompt=`Return {"verdict":"issues_found|no_issue_found|uncertain|checker_suspect","issues":[{"where":["C3"],"refs":["S1","E1"],"cause":"one sentence","goal":"required behavior, no RTL"}]}. Submit the first confirmed problem immediately in evidence order. At most ${bounds.issues} already evidenced independent problems; never search, rank or discuss additional problems. One is enough. Each issue needs original source S/I and current observed E references. where is 1-${bounds.locations} current code line C references, listed unit IDs, or ["whole"] when uncertain. Known C IDs accidentally repeated in refs are routed to where by the harness. Cause/goal <=${bounds.text} characters. Never quote HDL or provide replacement expressions; code is referenced only by location. Hashes, categories, preservation and Markdown are handled by the harness. Optional limitations: at most four short strings. ${prior.length?'This is a focused repair review: assess EVERY supplied old issue and search for no new problems. A newly exposed failure at a later pipeline stage belongs to a separate diagnosis, not this review. For an old syntax-only issue, check its corrected source location and current compiler result; do not simulate or trace functional behavior to assess syntax. Once old assessments are determined, submit immediately. Return assessments:[{issue_id:"old ID",status:"resolved|still_present|uncertain|prior_diagnosis_invalid",refs:["current E ID"],reason:"short explanation"}]. For still_present also provide where, original S/I refs and goal within that assessment; the harness creates the fresh issue. Return issues:[]; do not repeat the same issue twice. A moved line is not a resolved bug. A passing partial test is not proof of uncovered behavior.':'Omit assessments; no previous issues need review.'}`;
  return {deliveredRefs,systemPrompt:simple?simplePrompt:`Return {"verdict":"issues_found|no_issue_found|uncertain|checker_suspect","issues":[{"target":"one listed unit ID or whole","category":"syntax|logic|timing|width|reset|interface|checker","sources":["S1"],"evidence":["E1"],"cause":"short causal explanation","goal":"required corrected behavior","preserve":["unchanged behavior"]}],"limitations":["precise limitation"],"assessments":[{"issue_id":"previous ID","status":"resolved|still_present|uncertain|prior_diagnosis_invalid","evidence":["E1"],"reason":"short reason"}]}. At most ONE primary new issue, cause and goal each <=500 characters, at most 4 preserve/limitation items. Empty lists where none. Select source/evidence IDs, NEVER copy quotes or predict hashes. target=whole when no safe listed unit exists or a change spans units. An invalid local target is downgraded to whole, never a guessed local edit. Missing history/checker uncertainty means abstain, not speculative repair. Every old issue needs one assessment; when still_present reuse its issue_id through its matching assessment (one primary issue maximum). No RTL.`,
    prompt:(focused?'# Focused queue review\nAssess only the supplied previous issue IDs. Current later-stage failures are deferred to the next diagnosis batch after this repair is accepted. Do not analyze new mismatches or fetch their traces in this call.\n\n':'')+'# Functional verification coverage\n'+JSON.stringify(functionalCoverage(checks))+'\nCompile/interface/synthesis passes do NOT establish functional correctness. If simulation is not_run or inconclusive, retain that limitation and do a bounded source-vs-code review; do not invent an executed mismatch or discard a source-grounded hypothesis merely because compilation passed. A static hypothesis is not a tool-confirmed failure.\n\n# Self-test scope and semantic review (fallible, not proof)\n'+JSON.stringify({coverage:selfTestScope,assurance:selfTestAssurance})+'\nCheck the expected rule against the original source before attributing a mismatch to RTL. A reviewed or non-vacuous test can still have an incorrect oracle. A partial pass says nothing about uncovered behavior.\n\n# Current check statuses — begin at the first failed check, if any\n'+JSON.stringify(checks.map(c=>({id:c.id,stage:c.stage,status:c.status,evidence_address:Object.entries(catalog).find(([key,v])=>key.startsWith('E')&&v.id===c.evidence?.id)?.[0]??null})))+(evidenceBrief?diagnosisEvidenceSection(evidenceBrief):'')+'\n\n# Current original sources and authorized targets\n'+JSON.stringify(compactCatalog)+(compact&&catalog[firstKey]?.observation?'\n\n# Full observation for '+firstKey+' (program produced; no omitted steps; expected values remain hypotheses)\n'+(evidenceBrief?readableObservation(catalog[firstKey],p.candidate.rtl):catalog[firstKey].observation):'')+'\n\n# Current candidate (verbatim lines after Cn labels; read only)\n'+(simple?p.candidate.rtl.split('\n').map((line,i)=>'C'+(i+1)+' | '+line).join('\n'):p.candidate.rtl)+'\n\n# Previous repair context (data)\n'+JSON.stringify(repairContext??null)+'\n\n# Advisory constraints\n'+JSON.stringify(constraints)+'\nOnly current E addresses may support findings. Previous issue IDs: '+JSON.stringify(prior.map(i=>i.id))+(compact?'\nEvidence marked available has NOT been supplied. Fetch it before citing or assessing it. Unit offsets address the single current candidate above.':'')};
}
export function expandDiagnosis(raw,req,{checks,simple=false}={}){
  const locations=new Map();
  if(simple){
    const c=diagnosticCatalog(req,{simple:true}),previous=req.payload.repair_context?.previous_issues??[];
    check(raw&&typeof raw==='object'&&!Array.isArray(raw),'Diagnosis must be an object');
    check(Object.keys(raw).every(k=>['verdict','issues','limitations','assessments'].includes(k)),'Unknown small diagnosis field');
    check(Array.isArray(raw.issues)&&raw.issues.length<=bounds.issues,'Report only the first two problems');
    check(raw.assessments===undefined||Array.isArray(raw.assessments)&&raw.assessments.length<=2,'Invalid assessment list');
    const refs=xs=>{check(Array.isArray(xs)&&xs.length<=bounds.references&&new Set(xs).size===xs.length&&xs.every(x=>/^[SIEC][1-9]\d*$/.test(x)&&c[x]),'Unknown source/evidence reference');return {sources:xs.filter(x=>/^[SI]/.test(x)),evidence:xs.filter(x=>/^E/.test(x))};};
    const issue=(i,issueId)=>{
      check(i&&typeof i==='object'&&!Array.isArray(i),'Issue must be an object');
      check(Object.keys(i).every(k=>['where','refs','cause','goal'].includes(k)),'Only where, refs, cause, goal are needed');
      // Reference namespaces are deterministic. Repeating an authorized code
      // address beside source/evidence IDs must not discard a useful finding.
      if(Array.isArray(i.refs)&&i.refs.every(x=>typeof x==='string'))i={...i,where:[...new Set([...(Array.isArray(i.where)?i.where:[]),...i.refs.filter(x=>/^C[1-9]\d*$/.test(x)&&c[x])])]};
      check(Array.isArray(i.where)&&i.where.length>0&&i.where.length<=bounds.locations&&new Set(i.where).size===i.where.length,'Provide 1-'+bounds.locations+' distinct current code locations');
      check(i.where.every(x=>typeof x==='string'&&(x==='whole'||/^C[1-9]\d*$/.test(x)&&c[x]||req.payload.units.some(u=>u.unit_id===x))),'Unknown current code location ID');
      const cs=i.where.filter(x=>/^C\d+$/.test(x));locations.set(issueId,resolveLocations(req.payload.candidate.rtl,cs));
      // Resolve every line to its containing parsed unit. Several C references
      // in the same unit remain one local edit, without asking the model again.
      const rtl=req.payload.candidate.rtl,index=indexUnits(rtl),mapped=i.where.filter(x=>req.payload.units.some(u=>u.unit_id===x));
      for(const ref of cs){
        const line=Number(ref.slice(1)),text=c[ref].text,prefix=rtl.split('\n').slice(0,line-1).join('\n'),offset=Buffer.byteLength(prefix)+(line>1?1:0),start=offset+Buffer.byteLength(text.match(/^\s*/)[0]),end=offset+Buffer.byteLength(text.trimEnd());
        const unit=index.units?.find(u=>u.start_byte<=start&&u.end_byte>=end);
        if(unit)mapped.push(unit.unit_id);else mapped.push('whole');
      }
      const targets=[...new Set(mapped)],unit=!i.where.includes('whole')&&targets.length===1&&req.payload.units.some(u=>u.unit_id===targets[0])?targets[0]:'whole';
      return {target:unit,category:checks?.find(x=>x.status==='fail')?.stage==='compile'?'syntax':'logic',...refs(i.refs),cause:i.cause,goal:i.goal,preserve:[],_id:issueId};
    };
    const issues=raw.issues.map((i,n)=>issue(i,'I'+(n+1)));
    const assessments=(raw.assessments??[]).map(a=>{
      check(a&&typeof a==='object'&&!Array.isArray(a),'Assessment must be an object');
      check(Object.keys(a).every(k=>['issue_id','status','refs','reason','where','goal'].includes(k)),'Unknown assessment field');
      if(a.status==='still_present'){
        check(previous.some(p=>p.id===a.issue_id),'Unknown old issue');
        issues.push(issue({where:a.where,refs:a.refs,cause:a.reason,goal:a.goal},a.issue_id));
      }
      return {issue_id:a.issue_id,status:a.status,evidence:refs(a.refs).evidence,reason:a.reason};
    });
    check(issues.length<=2&&(!previous.length||raw.issues.length===0),'Review only the two queued issues; do not discover new ones during review');
    raw={verdict:raw.verdict,issues,assessments,limitations:raw.limitations??[]};
  }
  keys(raw,['verdict','issues','limitations','assessments']);
  check(['issues_found','no_issue_found','uncertain','checker_suspect'].includes(raw.verdict),'Unknown verdict');
  check(Array.isArray(raw.issues)&&raw.issues.length<=(simple?2:1),'At most '+(simple?'two':'one')+' primary issues');
  check(Array.isArray(raw.limitations)&&raw.limitations.length<=4&&Array.isArray(raw.assessments),'Invalid diagnosis arrays');
  const c=diagnosticCatalog(req),limits=raw.limitations.map(x=>short(x,300));
  const ev=ids=>{check(Array.isArray(ids)&&ids.length<=8&&new Set(ids).size===ids.length&&ids.every(x=>/^E[1-9]\d*$/.test(x)&&c[x]),'Unknown current evidence address');return ids.map(x=>c[x].id);};
  const assessments=raw.assessments.map(a=>{keys(a,['issue_id','status','evidence','reason']);return {issue_id:a.issue_id,status:a.status,evidence_ids:ev(a.evidence),reason:short(a.reason,500)};});
  const still=assessments.filter(a=>a.status==='still_present');check(still.length<=(simple?2:1),'Too many still-present issues');
  const issues=raw.issues.map((i,n)=>{
    keys(i,['target','category','sources','evidence','cause','goal','preserve',...(simple?['_id']:[])]);
    check(['syntax','logic','timing','width','reset','interface','checker'].includes(i.category),'Unknown issue category');
    check(typeof i.target==='string'&&i.target.length<=80,'Invalid target');
    check(Array.isArray(i.sources)&&i.sources.length>0&&i.sources.length<=8&&new Set(i.sources).size===i.sources.length&&i.sources.every(x=>/^[SI][1-9]\d*$/.test(x)&&c[x]),'Unknown original source address');
    check(Array.isArray(i.preserve)&&i.preserve.length<=4,'Invalid preservation list');
    const local=req.payload.units.some(u=>u.unit_id===i.target);
    if(i.target!=='whole'&&!local)limits.push('Unknown local target was downgraded to whole design repair. No invented unit ID was authorized.');
    return {id:simple?i._id:still[0]?.issue_id??'I'+(n+1),...(simple?{code_locations:locations.get(i._id)}:{}),category:({width:'type_width',reset:'timing',interface:'spec_misunderstanding'})[i.category]??i.category,severity:'major',scope:local?'local':'global',unit_ids:local?[i.target]:[],
      requirement_quotes:i.sources.map(x=>({source:c[x].source,quote:c[x].quote})),evidence_ids:ev(i.evidence),explanation:short(i.cause,500),
      repair_goal:short(i.goal,500)+(i.preserve.length?' Preserve:\n'+i.preserve.map(x=>short(x,200)).join('\n'):'')};
  });
  check(issues.every(i=>i.evidence_ids.length),'An actionable diagnosis requires observed evidence');
  const coverage=checks?functionalCoverage(checks):null;
  const unverified=coverage&&['not_run','inconclusive'].includes(coverage.status);
  if(unverified)limits.splice(3,Math.max(0,limits.length-3),'Functional simulation unavailable or inconclusive; compilation and synthesis do not verify behavior.');
  return adaptPayload(req,{verdict:unverified&&raw.verdict==='no_issue_found'?'uncertain':raw.verdict,issues,limitations:limits,repair_assessments:assessments});
}
