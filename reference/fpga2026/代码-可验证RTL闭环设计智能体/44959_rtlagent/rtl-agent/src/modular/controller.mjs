import {invariant,sha256,snapshot,id} from '../dual/snapshot.mjs';
import {selectCandidate} from '../dual/evidence-policy.mjs';
import {checkModuleSource,exactKeys,boundedProse} from './contracts.mjs';
import {parseModularPlan} from './plan.mjs';
import {parseCompactPlan,attachCompactArchitecture} from '../planner/compact.mjs';
import {sharedMarkdown} from './handoff.mjs';
import {projectSnapshot,replaceModule,revisionImpact} from './project.mjs';

const retriable=new Set(['OUTPUT_INVALID','MODEL_TRUNCATED','MODULE_INTERFACE_MISMATCH','MODULE_SOURCE_INVALID','MODULE_WIRING_MISMATCH','MODULE_PATH_UNPROVEN','DEPENDENCY_UNRESOLVED','MODULE_COMPILE_FAILED']);
export function validateModuleDiagnosis(value,project,failed,compact=false) {
  const text=value=>boundedProse(value,{diagnostic:true});
  exactKeys(value,['action','target','evidence_ids','reason',...(compact?['goal','preserve']:[])]);text(value.reason);
  if(compact){text(value.goal);invariant(Array.isArray(value.preserve)&&value.preserve.length<=4,'OUTPUT_INVALID');value.preserve.forEach(text);}
  invariant(['repair_module','revise_contract','stop'].includes(value.action),'OUTPUT_INVALID','Unknown modular diagnosis action');
  invariant(value.action==='repair_module'?project.modules.some(m=>m.name===value.target):value.target===null,'OUTPUT_INVALID','Invalid repair target');
  invariant(Array.isArray(value.evidence_ids)&&new Set(value.evidence_ids).size===value.evidence_ids.length&&value.evidence_ids.every(id=>failed.some(c=>c.evidence?.id===id)),'OUTPUT_INVALID','Diagnosis must cite current failed checks');
  invariant(value.action==='stop'||value.evidence_ids.length>0,'OUTPUT_INVALID','No repair without observed failure');return value;
}

// The caller owns the single request lane, absolute deadline, trace, cancellation
// and total model-call budget. No concurrent promises or untracked model calls.
export async function runModularProject({task,plan:initialPlan,constraints,cfg,adapters,call,deadline,stopped,
  verifyModule,verification,save,saveMarkdown,saveCandidate,publish,onIncumbent,emit,remainingAuthorCalls,
  selfTestScope=null,selfTestAssurance=null}) {
  let plan=initialPlan,project=null,evidence=null,reason='no_confirmed_failure',recoveryCalls=0,repairCalls=0,revisions=0;
  const history=[],moduleChecks=[];
  const reserve=cfg.modular.verificationReserveMs;
  const enough=count=>remainingAuthorCalls()>=count&&deadline-Date.now()>=count*(cfg.modular.minGenerationMs+cfg.modular.moduleCheckMs)+reserve;
  const generate=async(name,sources,{base=null,observed=[],note='',stage='module_generate',remaining=1}={})=>{
    invariant(!stopped(),'BUDGET_EXHAUSTED');
    const available=deadline-Date.now()-reserve-remaining*cfg.modular.moduleCheckMs;
    const cap=Math.min(cfg.mainTimeoutMs,Math.floor(available/remaining));
    invariant(cap>=cfg.modular.minGenerationMs,'BUDGET_EXHAUSTED','Preserve remaining modules and whole-project verification time');
    if(stage!=='module_generate')repairCalls++;
    const args={task,plan,name,constraints,project:base,sources,evidence:observed,diagnosis:note};
    const response=await call(stage,'main',cap,{target_module:name,contract_sha256:plan.architecture.sha256,base_sha256:base?.sha256??null},ctx=>adapters.generateModule(args,ctx));
    await save('module-source',{name,contract_sha256:plan.architecture.sha256,rtl:response.rtl,sha256:sha256(response.rtl),parent_sha256:base?.sha256??null});
    try {checkModuleSource(response.rtl,plan.architecture,name);}
    catch(error) {error.moduleRtl=response.rtl;throw error;}
    const expected=sha256(response.rtl);
    const compiledHash=sha256(name===plan.architecture.top.name?[response.rtl,...plan.architecture.order.map(n=>sources[n])].join('\n'):response.rtl);
    let result;
    if(verifyModule)result=await call('verify_module',null,cfg.modular.moduleCheckMs,{target_module:name,sha256:expected},ctx=>verifyModule({name,rtl:response.rtl,architecture:plan.architecture,sources:{...sources,[name]:response.rtl}},ctx));
    else result={candidate_sha256:expected,compiled_source_sha256:compiledHash,infrastructure_error:false,checks:[{id:'compile',stage:'compile',status:'unknown',evidence:{id:id('module-evidence'),source:'compiler',summary:'No module compiler supplied; not verified'}}]};
    invariant(result?.candidate_sha256===expected&&result.compiled_source_sha256===compiledHash&&Array.isArray(result.checks)&&result.checks.length===1&&result.checks.every(c=>c.id==='compile'&&c.stage==='compile'&&['pass','fail','unknown','error','timeout'].includes(c.status)&&c.evidence?.id&&c.evidence?.summary),'STALE_SNAPSHOT','Module evidence not bound to exact compiled source/dependencies');
    await save('module-verification',{name,contract_sha256:plan.architecture.sha256,...result});moduleChecks.push({name,contract_sha256:plan.architecture.sha256,...result});
    invariant(!result.infrastructure_error&&!result.checks.some(c=>['error','timeout'].includes(c.status)),'TOOL_INFRA_FAILURE','Module tool failed; do not rewrite code based on infrastructure failure');
    return {rtl:response.rtl,checks:result.checks};
  };
  const build=async(stage='module_generate')=>{
    const names=[...plan.architecture.order,plan.architecture.top.name],sources=Object.create(null);
    invariant(enough(names.length),'MODULAR_BUDGET_INSUFFICIENT','Not enough budget for all modules, top and verification');
    await saveMarkdown('project-contract',sharedMarkdown(task,plan));await save('architecture',plan.architecture);
    for(let index=0;index<names.length;index++) {
      const name=names[index];let observed=[],note='',retry=false;
      for(;;) {
        try {
          const next=await generate(name,sources,{stage:retry?'module_repair':stage,observed,note,remaining:names.length-index});
          sources[name]=next.rtl;
          observed=next.checks.filter(c=>c.status==='fail').map(c=>c.evidence);
          invariant(!observed.length,'MODULE_COMPILE_FAILED','Module failed its isolated compiler check');
          break;
        } catch(error) {
          if(!retriable.has(error.code)||recoveryCalls>=cfg.maxRepairAttempts||stopped())throw error;
          if(typeof error.moduleRtl==='string')sources[name]=error.moduleRtl;
          recoveryCalls++;retry=true;note=`Previous attempt failed: ${error.code}. ${error.moduleRtl?error.message:''} Complete only this module; preserve its contract.`;
          emit('module_recovery','retry',{target_module:name,reason:error.code,recovery_calls:recoveryCalls});
        }
      }
    }
    return projectSnapshot(plan.architecture,sources,project);
  };
  try {
    project=await build();await saveCandidate(project);onIncumbent(project,null,plan);await publish(project,null);
    evidence=await verification(project);onIncumbent(project,evidence,plan);
    for(let round=0;round<cfg.maxRepairAttempts-recoveryCalls&&!stopped();round++) {
      if(evidence.infrastructure_error){reason='TOOL_INFRA_FAILURE';break;}
      const failed=evidence.checks.filter(c=>c.status==='fail'&&c.evidence);
      if(!failed.length)break;
      if(!cfg.enablePostReview||!cfg.auxModel){reason='MODULAR_DIAGNOSIS_UNAVAILABLE';break;}
      const answer=await call('module_diagnosis','aux',cfg.reviewTimeoutMs,{candidate_id:project.id,sha256:project.sha256},ctx=>adapters.diagnoseModules({task,plan,project,evidence:evidence.checks},{...ctx,selfTestScope,selfTestAssurance}));
      const decision=validateModuleDiagnosis(answer.value,project,failed,cfg.harness?.enabled);await save('module-diagnosis',{project_sha256:project.sha256,...decision});
      if(decision.action==='stop'){reason='CHECKER_UNCERTAIN';break;}
      let next,nextPlan=plan;
      if(decision.action==='revise_contract') {
        invariant(revisions<cfg.modular.maxContractRevisions,'CONTRACT_REVISION_LIMIT');revisions++;
        const revisionEnd=Date.now()+cfg.analyzeTimeoutMs;
        const response=await call('contract_revision','aux',cfg.analyzeTimeoutMs,{candidate_id:project.id,sha256:project.sha256,contract_sha256:plan.architecture.sha256},ctx=>adapters.plan(task,{...ctx,contractRevision:{previous_architecture:plan.architecture,diagnosis:decision,failed_checks:failed,project_sha256:project.sha256}}));
        nextPlan=cfg.plannerCompact?parseCompactPlan(response.markdown,task,{splitDecision:cfg.harness?.enabled}):parseModularPlan(response.markdown,task,{nl2spec:cfg.plannerNl2spec,maxModules:cfg.modular.maxModules});
        if(cfg.plannerCompact&&nextPlan.needs_architecture){
          const architecture=await call('contract_architecture','aux',Math.max(1,revisionEnd-Date.now()),{semantic_plan_sha256:nextPlan.sha256},ctx=>adapters.planArchitecture(task,nextPlan,ctx));
          nextPlan=attachCompactArchitecture(architecture.markdown,task,nextPlan,{maxModules:cfg.modular.maxModules,registeredFeedback:cfg.modular.registeredFeedback});
        }
        await saveMarkdown('revised-plan',nextPlan.markdown);
        if(nextPlan.physical_modules) {
          invariant(nextPlan.architecture.sha256!==plan.architecture.sha256,'NO_CHANGE');
          await save('contract-revision',{...revisionImpact(plan.architecture,nextPlan.architecture),diagnosis:decision});
          const before=plan;plan=nextPlan;
          try{next=await build('module_rebuild');}finally{plan=before;}
        } else {
          // An explicit planner revision may collapse an unsuitable split. The
          // 8B still authors all behavior; the old full project remains published
          // until the new whole-design candidate earns comparable improvement.
          repairCalls++;adapters.setPlan(nextPlan);
          try {
            const cap=Math.min(cfg.mainTimeoutMs,deadline-Date.now()-reserve);
            invariant(cap>=cfg.modular.minGenerationMs,'BUDGET_EXHAUSTED');
            const response=await call('module_unsplit_repair','main',cap,{candidate_id:project.id,sha256:project.sha256},ctx=>adapters.generateComplete({...task,previousCandidate:project.rtl,repairEvidence:failed.map(c=>c.evidence),regenerationReason:decision.reason},constraints.filter(c=>!c.id.startsWith('aux.')).concat(nextPlan.constraints.map(c=>({...c,id:'aux.'+c.id}))),ctx));
            next=snapshot(response.rtl,project);
          } finally {adapters.setPlan(plan);}
          await save('contract-revision',{old_contract_sha256:plan.architecture.sha256,new_contract_sha256:null,policy:'collapse_to_single_module',diagnosis:decision});
        }
      } else {
        const note=decision.reason+(decision.goal?'\nBehavioral repair goal: '+decision.goal+'\nPreserve: '+decision.preserve.join('; '):'');
        const nextModule=await generate(decision.target,Object.fromEntries(project.modules.map(m=>[m.name,m.rtl])),{base:project,observed:failed.map(c=>c.evidence),note,stage:'module_repair'});
        invariant(!nextModule.checks.some(c=>c.status==='fail'),'MODULE_COMPILE_FAILED');
        next=replaceModule(project,plan.architecture,decision.target,nextModule.rtl,{baseSha256:project.sha256,contractSha256:plan.architecture.sha256});
      }
      await saveCandidate(next);const nextEvidence=await verification(next);
      const targets=failed.filter(c=>decision.evidence_ids.includes(c.evidence.id)).map(c=>c.id);
      const selection=selectCandidate(project,next,evidence,nextEvidence,targets);
      history.push({candidate_id:next.id,parent_id:project.id,contract_sha256:next.architecture_sha256,...selection});
      await save('project-selection',history.at(-1));emit('project_select',selection.accepted?'accepted':'rejected',history.at(-1));
      if(selection.accepted){project=next;evidence=nextEvidence;plan=nextPlan;adapters.setPlan(plan);onIncumbent(project,evidence,plan);await publish(project,evidence);if(!plan.physical_modules)break;}
      else reason=selection.reason;
    }
    if(stopped())reason='BUDGET_EXHAUSTED';
    else if(evidence?.checks.some(c=>c.status==='fail')&&reason==='no_confirmed_failure')reason='MODULAR_REPAIR_LIMIT';
  } catch(error){reason=error.code??'OUTPUT_INVALID';emit('modular','stopped',{reason,candidate_sha256:project?.sha256??null});}
  return {candidate:project,evidence,plan,reason,history,module_checks:moduleChecks,repair_calls:repairCalls,recovery_calls:recoveryCalls,contract_revisions:revisions,
    allow_unsplit_fallback:!project&&!stopped()&&(retriable.has(reason)||['MODULAR_BUDGET_INSUFFICIENT','CONTEXT_OVERFLOW'].includes(reason))};
}
