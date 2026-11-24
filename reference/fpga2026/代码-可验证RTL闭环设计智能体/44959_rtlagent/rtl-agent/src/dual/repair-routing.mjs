import {validateObservationResult,decodeObservation,observationMatches} from '../harness/observations.mjs';
import {indexUnits,lex} from './unit-index.mjs';
import {selectCandidate} from './evidence-policy.mjs';
import {programmaticRepairFallback,REPAIR_FALLBACK_VERSION} from '../harness/repair-policy.mjs';

export const REPAIR_ROUTING_VERSION='evidence-repair-routing.v1';
export function repairFocus(evidence){
  try{return observations(evidence).map(t=>{
    const first=t.mismatches[0];
    const previous=first?t.rows.filter(r=>r.step<first.step&&observationMatches(r,first.port)).at(-1):null;
    return {check_id:t.check_id,first_mismatch:first??null,previous_correct:previous?{step:previous.step,edge:previous.edge,inputs:previous.inputs,actual:previous.actual,expect:previous.expect,...(previous.masks?{masks:previous.masks}:{})}:null,complete_history_follows:true};
  });}catch{return [];}
}
function observations(evidence){
  const traces=evidence.checks.filter(c=>c.stage==='simulate'&&['pass','fail'].includes(c.status)).map(c=>{
    if(!c.evidence?.observation)throw Error('missing_observation');
    const result=validateObservationResult(JSON.parse(c.evidence.observation));
    if(result.status!=='complete')throw Error('incomplete_observation');
    const t=decodeObservation(result.view);
    if(t.candidate_sha256!==evidence.candidate_sha256||Boolean(t.failures)!==(c.status==='fail'))throw Error('stale_observation');
    return {check_id:c.id,...t};
  });
  if(!traces.length)throw Error('missing_simulation');return traces;
}
export function classifyRepair({base,evidence,task,plan,ignoreStages=[],cexFirst=false,diagnosisFirst=false}){
  const result={version:REPAIR_ROUTING_VERSION,route:'diagnose_27b',failure_kind:'functional',scope:'unknown',difficulty:'unknown',unit_ids:[],reasons:[],candidate_sha256:base.sha256};
  if(evidence.infrastructure_error||evidence.checks.some(c=>['error','timeout'].includes(c.status)))return {...result,route:'infrastructure',failure_kind:'infrastructure',reasons:['execution_error_is_not_an_RTL_diagnosis']};
  const failed=evidence.checks.filter(c=>c.status==='fail'&&!ignoreStages.includes(c.stage));
  if(!failed.length)return {...result,route:'stop',failure_kind:'none',reasons:['no_confirmed_failure']};
  if(failed.some(c=>['compile','interface'].includes(c.stage)))return {...result,route:'direct_8b',failure_kind:'compile_interface',difficulty:'low',reasons:['compiler_or_interface_diagnostic_available; semantic_difficulty_unassessed']};
  if(failed.some(c=>c.stage==='lint'))return {...result,route:'direct_8b',failure_kind:'lint',difficulty:'low',scope:'unknown',reasons:['static_lint_findings_require_mechanical_repair']};
  if(!failed.some(c=>c.stage==='simulate'))return {...result,reasons:['non_simulation_failure_requires_diagnosis']};
  let traces;
  try{traces=observations(evidence);}catch{return {...result,route:'checker_review',failure_kind:'checker_uncertain',reasons:['complete_current_observation_unavailable']};}
  const tb=task.testbench??{},assurance=tb.assurance??{};
  const identityOk=!traces.some(t=>t.plan_sha256!==tb.observation?.plan_sha256||t.bench_sha256!==tb.observerBenchSha256);
  // Counterexample-first (opt-in): a complete current observation is enough to
  // hand the first mismatch straight to the 8B; an unresolved failure then
  // escalates to diagnosis through the existing direct->diagnose rule.
  if(!cexFirst&&(assurance.review_verdict!=='accept'||!identityOk))return {...result,route:'checker_review',failure_kind:'checker_uncertain',reasons:['expected_rule_or_trace_identity_needs_review']};
  const mismatch=traces.flatMap(t=>t.mismatches),ports=[...new Set(mismatch.map(m=>m.port))],index=indexUnits(base.rtl);
  const seq=traces.some(t=>t.clock_port!==null),method=assurance.method??'unknown';
  // Only a single combinational driver reading top inputs is a proven bounded
  // edit region. A parser fallback means unknown localization, never global.
  if(!seq&&index.ok&&ports.length===1){
    const drivers=index.units.filter(u=>u.writes?.includes(ports[0]));
    const inputs=new Set(traces[0].ports.filter(p=>p.direction==='input').map(p=>p.name));
    if(drivers.length===1&&drivers[0].kind==='assign'&&drivers[0].identifiers.every(x=>inputs.has(x)||x===ports[0])){
      result.scope='local';result.unit_ids=[drivers[0].unit_id];
    }
  }
  const high=seq&&(plan?.timing_risk==='high'||!['register','register_enable','counter'].includes(method));
  result.difficulty=high?'high':seq?'moderate':result.scope==='local'?'low':'unknown';
  // Diagnosis-first (opt-in, requires cexFirst): the 27B diagnoses every
  // functional counterexample before the 8B repairs it; the counterexample-only
  // 8B repair stays available afterwards (see runRoutedRepairs).
  result.route=cexFirst&&diagnosisFirst?'diagnose_27b':cexFirst||!high?'direct_8b':'diagnose_27b';
  result.reasons=[seq?'clocked_history_requires_cycle_semantics':'combinational_observed_counterexample',index.ok?'source_units_indexed':'source_localization_unknown',result.scope==='local'?'single_output_driver_reads_only_inputs':'no_proven_local_edit_boundary'];
  const rows=traces.reduce((n,t)=>n+t.rows.length,0);
  // Error-difficulty signals, recorded for later routing analysis only.
  result.facts={method,clocked:seq,failed_ports:ports,first_mismatch:mismatch[0]??null,comparisons:traces.reduce((n,t)=>n+t.checks,0),failures:mismatch.length,
    failure_ratio:traces.reduce((n,t)=>n+t.checks,0)?mismatch.length/traces.reduce((n,t)=>n+t.checks,0):null,
    first_mismatch_position:mismatch[0]&&rows?mismatch[0].step/rows:null,checker_reviewed:assurance.review_verdict==='accept',trace_identity_ok:identityOk,
    assurance_kind:assurance.kind??tb.origin??null};
  if(cexFirst)result.reasons.push(diagnosisFirst?'diagnosis_first_then_counterexample':high?'counterexample_first_overrides_high_difficulty':'counterexample_first',...(assurance.review_verdict==='accept'&&identityOk?[]:['checker_not_reviewed_direct_repair_still_selected_by_full_replay']));
  return result;
}

// Complete replay must use identical stimuli, expectations and observation IDs.
// A smaller total failure count cannot compensate for losing an old pass.
export function selectRoutedCandidate(base,candidate,oldEvidence,newEvidence){
  const stage=selectCandidate(base,candidate,oldEvidence,newEvidence);
  if(!['verified_improvement','no_verified_improvement'].includes(stage.reason))return stage;
  if(base.sha256===candidate.sha256)return {accepted:false,reason:'unchanged_candidate'};
  if(!oldEvidence.checks.some(c=>c.stage==='simulate'&&['pass','fail'].includes(c.status)))return stage;
  let before,after;
  try{before=observations(oldEvidence);after=observations(newEvidence);}catch{return {accepted:false,reason:'observation_unavailable'};}
  let fixed=0;
  for(const old of before){
    const next=after.find(t=>t.check_id===old.check_id);
    if(!next||old.plan_sha256!==next.plan_sha256||old.bench_sha256!==next.bench_sha256||JSON.stringify(old.ports)!==JSON.stringify(next.ports)||old.rows.length!==next.rows.length)return {accepted:false,reason:'observation_identity_changed'};
    for(let i=0;i<old.rows.length;i++){
      const a=old.rows[i],b=next.rows[i];
      if(a.step!==b.step||a.time_ns!==b.time_ns||a.edge!==b.edge||JSON.stringify(a.inputs)!==JSON.stringify(b.inputs)||JSON.stringify(a.expect)!==JSON.stringify(b.expect)||JSON.stringify(a.masks??{})!==JSON.stringify(b.masks??{})||JSON.stringify(a.because)!==JSON.stringify(b.because))return {accepted:false,reason:'observation_stimuli_changed'};
      for(const port of Object.keys(a.expect)){
        const was=observationMatches(a,port),now=observationMatches(b,port);
        if(was&&!now)return {accepted:false,reason:'observation_regression',step:a.step,port};
        if(!was&&now)fixed++;
      }
    }
  }
  return stage.accepted?stage:fixed?{accepted:true,reason:'partial_observation_improvement',improved_observations:fixed}:{accepted:false,reason:'no_verified_improvement'};
}

export function preservesRepairScope(before,after,unitIds=[]){
  if(!unitIds.length)return true;
  const a=indexUnits(before),b=indexUnits(after);
  if(!a.ok||!b.ok||a.units.length!==b.units.length)return false;
  const tokens=s=>lex(s).map(t=>t.value).join(' ');
  // All read-only bytes except comments/whitespace must retain their tokens.
  const complement=(rtl,index)=>{
    const spans=index.units.filter(u=>unitIds.includes(u.unit_id));let at=0,out='';
    for(const u of spans){out+=Buffer.from(rtl).subarray(at,u.start_byte).toString();at=u.end_byte;out+=' ';}
    return out+Buffer.from(rtl).subarray(at).toString();
  };
  try{return unitIds.every(id=>a.units.some(u=>u.unit_id===id)&&b.units.some(u=>u.unit_id===id))&&tokens(complement(before,a))===tokens(complement(after,b));}catch{return false;}
}

export async function runRoutedRepairs({base,evidence,task,plan,stopped,canAuthor,author,verify,diagnose,accept,emit,cexFirst=false,diagnosisFirst=false,repairFallbacks=false,repairBudget=()=>({})}){
  let current=base,ev=evidence,reason='REPAIR_CALL_LIMIT',diagnosed=false,diagnosis=null,directAttempted=false;
  const history=[],routes=[],seen=new Set([base.sha256]),ignore=new Set();
  while(!stopped()){
    const classification=classifyRepair({base:current,evidence:ev,task,plan,ignoreStages:[...ignore],cexFirst,diagnosisFirst});
    const route=classification.route==='direct_8b'&&classification.failure_kind!=='lint'&&directAttempted?{...classification,route:'diagnose_27b',classified_route:classification.route,reasons:[...classification.reasons,'direct_attempt_did_not_resolve_failure']}
      // Diagnosis-first: once the diagnosed attempt is spent, one counterexample-only 8B repair remains.
      :diagnosisFirst&&diagnosed&&!directAttempted&&classification.route==='diagnose_27b'&&classification.failure_kind==='functional'?{...classification,route:'direct_8b',classified_route:classification.route,reasons:[...classification.reasons,'counterexample_after_diagnosis']}
      :classification;
    routes.push(route);emit('repair_route','selected',route);
    if(['stop','infrastructure'].includes(route.route)){reason=route.route==='stop'?(ev.checks.some(c=>c.stage==='simulate'&&c.status==='pass')?'self_test_passed':'no_confirmed_failure'):'TOOL_INFRA_FAILURE';break;}
    if(!canAuthor()){reason='REPAIR_CALL_LIMIT';break;}
    const needsDiagnosis=route.route!=='direct_8b';
    let fallback=null;
    if(needsDiagnosis){
      if(diagnosed){reason=diagnosisFirst?'diagnosed_attempt_completed':'DIAGNOSIS_ATTEMPT_LIMIT';break;}
      const policyArgs={enabled:repairFallbacks,cexFirst,testbench:task.testbench,route};
      fallback=programmaticRepairFallback({...policyArgs,budget:repairFallbacks?repairBudget():undefined});
      if(!fallback){
        diagnosed=true;diagnosis=await diagnose(current,ev,route);
        const p=diagnosis?.message?.payload;
        if(!p){reason='DIAGNOSIS_UNAVAILABLE';if(diagnosisFirst){emit('repair_route','diagnosis_unusable',{reason});continue;}break;}
        if(p.verdict==='checker_suspect'||p.issues?.some(i=>i.category==='checker')){
          fallback=programmaticRepairFallback({...policyArgs,verdict:p.verdict});
          if(!fallback){reason='CHECKER_UNCERTAIN';if(diagnosisFirst){emit('repair_route','diagnosis_unusable',{reason});continue;}break;}
        }
        if(!fallback&&(p.verdict!=='issues_found'||!p.issues?.length)){reason='DIAGNOSIS_UNCERTAIN';if(diagnosisFirst){emit('repair_route','diagnosis_unusable',{reason});continue;}break;}
      }
    }else if(route.failure_kind!=='lint')directAttempted=true;
    if(fallback){
      // Exactly one attempt within the original shared cap/deadline. Do NOT
      // feed the suspect oracle diagnosis to the author or open correction,
      // re-diagnosis or rejected-guided continuation paths here.
      emit('repair_route','fallback',{version:REPAIR_FALLBACK_VERSION,...fallback,candidate_sha256:current.sha256});
      if(stopped()||!canAuthor()){reason=stopped()?'BUDGET_EXHAUSTED':'REPAIR_CALL_LIMIT';break;}
      const direct={...route,route:'direct_8b',classified_route:route.route,reasons:[...route.reasons,fallback.reason]};
      try{
        const candidate=await author({base:current,evidence:ev,route:direct,diagnosis:null});
        if(seen.has(candidate.sha256)){reason='REPEATED_CANDIDATE';break;}
        const next=await verify(candidate),selection=selectRoutedCandidate(current,candidate,ev,next);
        history.push({candidate_id:candidate.id,parent_id:current.id,fallback:fallback.reason,...selection});
        emit('select',selection.accepted?'accepted':'rejected',{candidate_sha256:candidate.sha256,fallback:fallback.reason,...selection});
        if(selection.accepted){current=candidate;ev=next;await accept(current,ev);}
        reason=next.infrastructure_error?'TOOL_INFRA_FAILURE':ev.checks.some(c=>c.stage==='simulate'&&c.status==='pass')&&!ev.checks.some(c=>c.status==='fail')?'self_test_passed':'fallback_attempt_completed';
      }catch(error){reason=error.code??'OUTPUT_INVALID';emit('repair_route','rejected',{reason,fallback:fallback.reason});}
      break;
    }
    let candidate;
    const lintOnly=route.failure_kind==='lint';
    try{candidate=await author({base:current,evidence:ev,route,diagnosis:needsDiagnosis?diagnosis:null,lintOnly});}
    catch(error){
      emit('repair_route','rejected',{reason:error.code??'OUTPUT_INVALID'});
      // Mechanical packaging defects need no new causal diagnosis. One bounded
      // author correction uses the same original snapshot and shared call cap.
      if(!lintOnly&&['LOCAL_REPAIR_INVALID','PATCH_SCOPE_VIOLATION'].includes(error.code)){
        if(!canAuthor()||stopped()){reason='REPAIR_ARTIFACT_INVALID';break;}
        emit('repair_route','artifact_correction',{reason:error.code,candidate_sha256:current.sha256});
        try{candidate=await author({base:current,evidence:ev,route,diagnosis:needsDiagnosis?diagnosis:null,artifactFeedback:String(error.message).slice(0,400)});}
        catch(next){emit('repair_route','rejected',{reason:next.code??'OUTPUT_INVALID'});reason='REPAIR_ARTIFACT_INVALID';if(diagnosisFirst&&needsDiagnosis&&!directAttempted)continue;break;}
      }else{if(needsDiagnosis){reason=error.code??'OUTPUT_INVALID';if(diagnosisFirst&&!directAttempted)continue;break;}continue;}
    }
    finally{if(lintOnly)ignore.add('lint');}
    if(seen.has(candidate.sha256)){
      emit('repair_route','escalate',{reason:'direct_attempt_no_change',candidate_sha256:candidate.sha256});
      if(needsDiagnosis){reason='REPEATED_CANDIDATE';if(diagnosisFirst&&!directAttempted)continue;break;}continue;
    }
    seen.add(candidate.sha256);
    let next=await verify(candidate);
    if(next.checks.some(c=>['compile','interface'].includes(c.stage)&&c.status==='fail')&&!next.infrastructure_error&&canAuthor()&&!stopped()){
      emit('repair_route','compile_draft',{candidate_sha256:candidate.sha256});
      try{candidate=await author({base:candidate,evidence:next,route:{...route,unit_ids:[],scope:'unknown',failure_kind:'compile_interface'},diagnosis:null,compileOnly:true});next=await verify(candidate);}catch(error){emit('repair_route','compile_recovery_failed',{reason:error.code??'OUTPUT_INVALID'});}
    }
    const selection=selectRoutedCandidate(current,candidate,ev,next);
    history.push({candidate_id:candidate.id,parent_id:current.id,...selection});emit('select',selection.accepted?'accepted':'rejected',{candidate_sha256:candidate.sha256,...selection});
    if(selection.accepted){current=candidate;ev=next;await accept(current,ev);}
    if(next.infrastructure_error){reason='TOOL_INFRA_FAILURE';break;}
    if(needsDiagnosis){
      // Counterexample mode: a rejected guided repair often fixes the diagnosed
      // defect but breaks another observation. With budget left, continue once
      // from it with its own first mismatch; acceptance is still decided by a
      // full replay against the current incumbent, so it can never be worse.
      if(cexFirst&&!selection.accepted&&!next.infrastructure_error&&next.checks.some(c=>c.stage==='simulate'&&c.status==='fail')&&canAuthor()&&!stopped()){
        emit('repair_route','continue_from_guided',{candidate_sha256:candidate.sha256,rejected_reason:selection.reason});
        directAttempted=true;
        try{
          const follow=await author({base:candidate,evidence:next,route:{...route,route:'direct_8b',unit_ids:[],scope:'unknown',reasons:[...route.reasons,'continue_from_rejected_guided_candidate']},diagnosis:null});
          if(!seen.has(follow.sha256)){
            seen.add(follow.sha256);const after=await verify(follow);
            const second=selectRoutedCandidate(current,follow,ev,after);
            history.push({candidate_id:follow.id,parent_id:candidate.id,continuation:true,...second});emit('select',second.accepted?'accepted':'rejected',{candidate_sha256:follow.sha256,continuation:true,...second});
            if(second.accepted){current=follow;ev=after;await accept(current,ev);}
          }
        }catch(error){emit('repair_route','rejected',{reason:error.code??'OUTPUT_INVALID',continuation:true});}
      }
      const passed=ev.checks.some(c=>c.stage==='simulate'&&c.status==='pass')&&!ev.checks.some(c=>c.status==='fail');
      if(diagnosisFirst&&!passed&&!directAttempted&&!next.infrastructure_error){reason='diagnosed_attempt_completed';continue;}
      reason=cexFirst?(passed?'self_test_passed':'diagnosed_attempt_completed')
        :(selection.accepted&&ev.checks.some(c=>c.stage==='simulate'&&c.status==='pass')?'self_test_passed':'diagnosed_attempt_completed');break;
    }
  }
  return {candidate:current,evidence:ev,reason:stopped()?'BUDGET_EXHAUSTED':reason,history,routes};
}
