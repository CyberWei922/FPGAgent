import { writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { envelope, validateMessage } from './contracts.mjs';
import { buildRepairPackage } from './context-pack.mjs';
import { applyReplacement } from './patch-transaction.mjs';
import { indexUnits, portContract, directory as unitDirectory } from './unit-index.mjs';
import { comparable, checkerIdentity, selectCandidate } from './evidence-policy.mjs';
import { normalizeDual, modelIdentity } from './config.mjs';
import { createClients } from './clients.mjs';
import { createTrace } from './trace.mjs';
import { DualError, id, invariant, sha256, snapshot } from './snapshot.mjs';
import { recoverableNormalEmpty } from '../output-recovery.mjs';
import { mergeConstraints } from './constraints.mjs';
import { loadKnowledge, diagnosisQuery, repairQuery } from './knowledge.mjs';
import { selectIssueGroup, recordReview, repairReviewContext } from './issues.mjs';
import { createPlannerClients } from '../planner/clients.mjs';
import { parsePlan, fallbackPlan } from '../planner/plan.mjs';
import {parseModularPlan,modularFallback,unsplitPlan} from '../modular/plan.mjs';
import {runModularProject} from '../modular/controller.mjs';
import {parseCompactPlan,attachCompactArchitecture,renderCompactPlan} from '../planner/compact.mjs';
import {loadPlanningKnowledge} from '../planner/knowledge.mjs';
import {loadVerificationKnowledge} from '../verification/knowledge.mjs';
import {eligibleMethods} from '../verification/registry.mjs';
import {functionalCoverage} from '../harness/diagnosis.mjs';
import {routeSelfTestRepair} from '../verification/workflow.mjs';
import {runRoutedRepairs,preservesRepairScope,repairFocus,selectRoutedCandidate} from './repair-routing.mjs';
import {applyLocalRepair} from './local-repair.mjs';
import {repairPolicy} from '../harness/repair-policy.mjs';
import {counterexampleEvidence} from '../harness/diagnosis-cex.mjs';
import {normalizeResamplePolicy,runResamples,compileFailure,resamplePassed,RESAMPLE_VERSION} from './resample.mjs';
import {createResamplePlannerClients} from './resample-clients.mjs';

export async function runDual({config,task,checkers,verifyCandidate,verifyModule,prepareChecks,voteCandidates,clients,generate,signal,deadline:outerDeadline=Infinity,
  directory,onEvent,onCandidate=async()=>{},repairCheckpoint=null,append}) {
  const cfg=normalizeDual(config.dual??config,config.model??config.mainModel);
  const resamplePolicy=normalizeResamplePolicy(cfg.harness.resample,cfg);
  if(!resamplePolicy.enabled)delete cfg.harness.resample;
  const deadline=Math.min(outerDeadline,Date.now()+Math.min(cfg.totalTimeoutMs,cfg.verification.budgetSchedule?900000:Infinity));
  const trace=await createTrace({directory,taskId:task.id,deadline,protocol:cfg.protocolVersion,onEvent,append});
  const {emit,save}=trace, evidenceStore=new Map(),history=[];
  const adapters=clients??(cfg.plannerPhase1?(resamplePolicy.enabled?createResamplePlannerClients(cfg,generate):createPlannerClients(cfg,generate)):createClients(cfg,generate));
  let incumbent=null,incumbentEvidence=null,incumbentReview=null,attempts=0,auxCalls=0,modelCleanupUnconfirmed=false,auxUnavailable=false,reason='complete';
  let constraints=[],auxConstraints=[],preparedTask={...task},checkerSet=structuredClone(checkers),checkerHash=checkerIdentity(checkerSet);
  let knowledgeService=null;const issueLedger=[];
  const planningOptions={nl2spec:cfg.plannerNl2spec,...(cfg.plannerPhase2?{maxModules:cfg.modular.maxModules}:{})};
  const parsePlanning=cfg.plannerCompact?(s,t)=>parseCompactPlan(s,t,{physical:cfg.plannerPhase2,splitDecision:cfg.harness.enabled,contracts:cfg.harness.contracts}):cfg.plannerPhase2?parseModularPlan:parsePlan, fallbackPlanning=cfg.plannerPhase2?modularFallback:fallbackPlan;
  let plan=cfg.plannerPhase1?fallbackPlanning(task,'not_started',planningOptions):null;
  let modular=null,modularHandled=false,singleAttempts=0;
  let traceSummary;
  let lastRepairMs=null,lastAuthorMs=null;
  const sessionHistory=[];
  const saveMarkdown=async(name,text)=>{
    const file=path.join(directory,`${id(name)}.md`);
    await writeFile(file,text,{flag:'wx',mode:0o600});
    const loaded=await readFile(file,'utf8');
    invariant(sha256(loaded)===sha256(text),'STALE_SNAPSHOT','Handoff changed before loading');
    return {text:loaded,record:{file:path.basename(file),sha256:sha256(loaded)}};
  };
  const message=(kind,requestId,taskId,payload)=>envelope(kind,requestId,taskId,payload,cfg.protocolVersion);
  const stopped=()=>signal?.aborted||Date.now()>=deadline||modelCleanupUnconfirmed;
  const call=async(stage,role,cap,request,invoke)=>{
    invariant(!stopped()&&deadline-Date.now()>=cfg.minStageMs,'BUDGET_EXHAUSTED');
    if(cfg.plannerPhase2&&role==='main')invariant(attempts<=cfg.modular.maxAuthorCalls,'MODEL_CALL_LIMIT');
    if(role==='aux'){invariant(!cfg.harness.enabled||auxCalls<cfg.harness.maxAuxCalls,'MODEL_CALL_LIMIT','Shared auxiliary call cap');auxCalls++;}
    const requestId=request?.request_id??id(stage),started=Date.now(),abort=new AbortController();
    const candidateFields={candidate_id:request?.payload?.candidate?.id??request?.payload?.candidate_id??request?.candidate_id??null,parent_id:request?.parent_id??null,candidate_sha256:request?.payload?.candidate?.sha256??request?.payload?.base_sha256??request?.sha256??null};
    const reserve=cfg.verification.budgetSchedule&&['prepare_checks','test_plan','retrieve_verification'].includes(stage)?cfg.verification.postReserveMs:cfg.plannerPhase1?(['plan','plan_retry','plan_architecture','test_plan'].includes(stage)?240000:role?(cfg.plannerPhase2?cfg.modular.verificationReserveMs:90000):0):0;
    const end=Math.min(deadline-reserve,Date.now()+cap);
    invariant(end-Date.now()>=cfg.minStageMs,'BUDGET_EXHAUSTED','Reserve verification and return time');
    const combined=signal?AbortSignal.any([signal,abort.signal]):abort.signal;
    const record=await save('request',{stage,request_id:requestId,model_role:role,request,model:role?modelIdentity(role==='aux'?cfg.auxModel:cfg.mainModel):null});
    emit(stage,'start',{...candidateFields,request_id:requestId,model_role:role,request_record:record,model:role?modelIdentity(role==='aux'?cfg.auxModel:cfg.mainModel):null});
    let timer,abortListener,operation,settled=false;
    const streamSummary={thinking_chunks:0,thinking_characters:0,text_characters:0};
    const modelEvent=e=>{
      if(cfg.plannerPhase1&&e.type==='thinking_delta'){streamSummary.thinking_chunks++;streamSummary.thinking_characters+=e.characters??0;return;}
      if(cfg.plannerPhase1&&e.type==='text_delta'){streamSummary.text_characters+=e.delta?.length??0;return;}
      emit(stage,'model_event',{request_id:requestId,model_role:role,event:structuredClone(e)});
    };
    try {
      const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{abort.abort();reject(new DualError(role?'MODEL_TIMEOUT':'TOOL_INFRA_FAILURE'));},Math.max(1,end-Date.now()));
        abortListener=()=>reject(new DualError('BUDGET_EXHAUSTED','External cancellation'));signal?.addEventListener('abort',abortListener,{once:true});});
      operation=Promise.resolve().then(()=>invoke({requestId,deadline:end,...(stage==='regenerate_resample'?{cleanupDeadline:deadline}:{}),signal:combined,modelRole:role,
        reserveAuxCall:async details=>{invariant(role==='aux'&&!stopped()&&Date.now()<end&&auxCalls<cfg.harness.maxAuxCalls,'MODEL_CALL_LIMIT','Auxiliary continuation shares task budget');auxCalls++;emit('aux_continuation','start',{request_id:requestId,aux_stage:details.stage,round:details.round,aux_calls:auxCalls});},
        saveRecord:save,saveMarkdown,currentCandidate:incumbent?.rtl,previousAttempts:structuredClone(sessionHistory),onEvent:modelEvent}));
      operation.then(()=>{settled=true;},error=>{settled=true;if(stage==='regenerate_resample'&&error.code==='MODEL_CLEANUP_UNCONFIRMED')modelCleanupUnconfirmed=true;});
      const value=await Promise.race([operation,timeout]);
      const responseRecord=await save('response',{stage,request_id:requestId,result:value});
      if(role)sessionHistory.push({stage,request_id:requestId,status:'completed',candidate_sha256:candidateFields.candidate_sha256});
      emit(stage,'ok',{...candidateFields,request_id:requestId,model_role:role,duration_ms:Date.now()-started,response_record:responseRecord,
        usage:value?.usage??null,stop_reason:value?.stopReason??null});return value;
    } catch(error) {
      if(error.code==='MODEL_CLEANUP_UNCONFIRMED')modelCleanupUnconfirmed=true;
      if(role)sessionHistory.push({stage,request_id:requestId,status:'failed',reason:error.code??'OUTPUT_INVALID'});
      const failure=await save('error',{stage,request_id:requestId,code:error.code??'OUTPUT_INVALID',message:role?'Call failed; see code':String(error.message),usage:error.usage??null,stopReason:error.stopReason??null});
      emit(stage,'error',{...candidateFields,request_id:requestId,model_role:role,duration_ms:Date.now()-started,reason:error.code??'OUTPUT_INVALID',error_record:failure});throw error;
    } finally {
      if(stage==='repair_routed')lastRepairMs=Date.now()-started;
      if(['generate','regenerate','regenerate_resample','repair_routed','repair_compile'].includes(stage))lastAuthorMs=Date.now()-started;
      if(cfg.plannerPhase1&&role)emit(stage,'stream_summary',{request_id:requestId,model_role:role,...streamSummary});
      clearTimeout(timer);signal?.removeEventListener('abort',abortListener);abort.abort();
      if((role||cfg.verification.budgetSchedule&&stage==='prepare_checks')&&operation&&!settled) {
        let cleanupTimer;
        await Promise.race([operation.catch(()=>{}),new Promise(resolve=>{cleanupTimer=setTimeout(resolve,Math.max(1,Math.min(stage==='regenerate_resample'?5000:cfg.modelCleanupGraceMs,deadline-Date.now())));})]);clearTimeout(cleanupTimer);
        if(!settled){modelCleanupUnconfirmed=true;emit('model_cleanup','unconfirmed',{request_id:requestId,model_role:role,reason:'MODEL_CLEANUP_UNCONFIRMED'});}
      }
    }
  };
  const verification=async(base)=>{
    try {
      const result=await call('verify',null,cfg.toolTimeoutMs,{candidate_id:base.id,sha256:base.sha256,checker_set_sha256:checkerHash},ctx=>verifyCandidate(base,checkerSet,ctx,preparedTask));
      comparable(result,base.sha256,checkerSet);
      for(const c of result.checks) {
        invariant(c.evidence&&c.evidence.id&&c.evidence.summary,'CHECKER_UNCERTAIN','Check must reference saved evidence');
        invariant(!evidenceStore.has(c.evidence.id),'OUTPUT_INVALID','Evidence ID reused');
        evidenceStore.set(c.evidence.id,Object.freeze({...c.evidence,check_id:c.id,status:c.status}));
      }
      await save('verification',{candidate_id:base.id,...result});
      if(cfg.plannerPhase1)sessionHistory.push({stage:'verify',candidate_sha256:base.sha256,checks:result.checks.map(c=>({id:c.id,status:c.status,evidence_id:c.evidence?.id??null,
        summary:c.status==='fail'?c.evidence?.summary?.slice(0,400):null,summary_truncated:c.status==='fail'&&(c.evidence?.summary?.length??0)>400}))});
      return result;
    } catch(error) {
      // No code changes based on timeouts or unavailable EDA. Preserve the full
      // snapshot and represent absent checks as unknown, never a successful pass.
      emit('verify','degraded',{candidate_id:base.id,candidate_sha256:base.sha256,reason:error.code??'TOOL_INFRA_FAILURE'});
      return {candidate_sha256:base.sha256,checker_set_sha256:checkerHash,checks:checkerSet.map(c=>({...c,status:'unknown',evidence:null})),infrastructure_error:true};
    }
  };
  const retrieve=async(collection,query)=>{
    if(cfg.knowledge.mode==='off')return null;
    try{return await call(`retrieve_${collection}`,null,cfg.toolTimeoutMs,{collection},ctx=>knowledgeService.retrieve({collection,query,signal:ctx.signal}));}
    catch(error){emit(`retrieve_${collection}`,'unavailable',{reason:error.code??'KNOWLEDGE_UNAVAILABLE'});return null;}
  };
  const review=async(base,ev,repairContext=null,{verificationThinking,repairRoute}={})=>{
    if(repairContext&&ev.checks.some(c=>['compile','interface'].includes(c.stage)&&c.status==='fail')){
      emit('review_route','deferred',{candidate_id:base.id,reason:'current_compile_or_interface_failure',queued_issue_ids:repairContext.previous_issues?.map(i=>i.id)??[]});
      repairContext=null;
    }
    const testedWithoutFailure=cfg.verification.enabled&&ev.checks.some(c=>c.stage==='simulate'&&c.status==='pass');
    if(cfg.plannerPhase1&&!repairContext&&!ev.checks.some(c=>c.status==='fail')&&(testedWithoutFailure||plan?.difficulty==='simple'&&(!cfg.plannerNl2spec||plan?.timing_risk==='low'))){
      emit('review','skipped',{candidate_id:base.id,reason:testedWithoutFailure?'self_test_passed_no_observed_failure_or_repair_context':'simple_task_no_observed_failure'});return null;
    }
    if(!cfg.enablePostReview){emit('review','skipped',{candidate_id:base.id,reason:'disabled_ablation'});return null;}
    if(!cfg.auxModel){auxUnavailable=true;emit('review','skipped',{candidate_id:base.id,reason:'AUX_UNAVAILABLE'});return null;}
    const index=indexUnits(base.rtl);
    const evidence=ev.checks.filter(c=>c.evidence).map(c=>c.evidence);
    const knowledge=await retrieve('diagnosis',diagnosisQuery(task,base,evidence));
    const req=message('review_request',id('review'),task.id,{spec_text:task.spec,interface_text:task.interfaceText??'',constraints,
      candidate:{id:base.id,sha256:base.sha256,rtl:base.rtl},units:unitDirectory(index),evidence,coverage:'full',
      ...(knowledge?{knowledge}:{}),...(repairContext?{repair_context:repairContext}:{})});
    try {
      validateMessage(req,undefined,{evidenceStore});
      const response=await call('review','aux',cfg.reviewTimeoutMs,req,ctx=>adapters.review(req,{...ctx,...(verificationThinking?{verificationThinking}:{}),...(repairRoute?{repairRoute}:{}),...(cfg.harness.repairRouting?{repairFocus:repairFocus(ev)}:{}),observedChecks:ev.checks,selfTestScope:preparedTask.testbench?.coverage??null,selfTestAssurance:preparedTask.testbench?.assurance??null}));
      validateMessage(response.value,req);return {message:response.value,request:req,index};
    } catch(error){if(error.code==='AUX_UNAVAILABLE')auxUnavailable=true;
      emit('review','incomplete',{candidate_id:base.id,candidate_sha256:base.sha256,reason:error.code??'OUTPUT_INVALID',coverage:'unavailable'});return null;}
  };
  const publish=async(base,ev)=>{await onCandidate(base,ev);emit('publish','ok',{candidate_id:base.id,parent_id:base.parent_id,candidate_sha256:base.sha256,checks:ev?.checks??[]});};
  const saveCandidate=async(base)=>{
    await writeFile(path.join(directory,base.id+'.sv'),base.rtl,{flag:'wx',mode:0o600});
    await save('candidate',base);emit('snapshot','ok',{candidate_id:base.id,parent_id:base.parent_id,candidate_sha256:base.sha256});
  };
  try {
    knowledgeService=await loadKnowledge(cfg.knowledge);
    await save('config',{...cfg,mainModel:modelIdentity(cfg.mainModel),auxModel:modelIdentity(cfg.auxModel)});
    await save('task',{spec:task.spec,interfaceText:task.interfaceText??'',sha256:sha256(task.spec),rules:task.rules??[]});
    if(repairCheckpoint){
      invariant(cfg.harness.repairRouting&&repairCheckpoint.spec_sha256===sha256(task.spec)&&repairCheckpoint.checker_set_sha256===checkerHash&&repairCheckpoint.candidate_sha256===sha256(repairCheckpoint.rtl),'STALE_SNAPSHOT','Repair checkpoint must match original specification, candidate and frozen checkers');
      incumbent=snapshot(repairCheckpoint.rtl);plan=repairCheckpoint.plan??plan;
      invariant(!plan||plan.spec_sha256===sha256(task.spec),'STALE_SNAPSHOT','Checkpoint plan differs from original task');
      auxConstraints=plan?.constraints??[];adapters.setPlan?.(plan);singleAttempts=1;
      await saveCandidate(incumbent);await save('repair-checkpoint',{...repairCheckpoint,rtl:undefined,initial_generation_reused:true});
      emit('repair_checkpoint','loaded',{candidate_sha256:incumbent.sha256,planning_calls:0,initial_author_calls:0});
    } else if(cfg.plannerPhase1&&cfg.enableSpecAnalysis) {
      try {
        invariant(cfg.auxModel,'AUX_UNAVAILABLE');
        const planningEnd=Date.now()+cfg.analyzeTimeoutMs;
        let planningKnowledge=null;
        if(cfg.planningKnowledge.mode!=='off'){
          try{
            planningKnowledge=await call('retrieve_planning',null,Math.min(cfg.planningKnowledge.timeoutMs,planningEnd-Date.now()),{index_sha256:cfg.planningKnowledge.sha256,query_sha256:sha256(task.spec)},async ctx=>{
              const service=await loadPlanningKnowledge(cfg.planningKnowledge);return service.retrieve({spec:task.spec,signal:ctx.signal});
            });
          }catch(error){emit('retrieve_planning','unavailable',{reason:error.code??'KNOWLEDGE_UNAVAILABLE',fallback:'original_spec_only'});}
        }
        let feedback=null;
        for(let pass=0;pass<(!cfg.plannerCompact&&(cfg.plannerNl2spec||cfg.plannerPhase2)?2:1);pass++){
          const remaining=planningEnd-Date.now();
          invariant(remaining>=cfg.minStageMs,'BUDGET_EXHAUSTED','Shared planning budget exhausted');
          const response=await call(pass?'plan_retry':'plan','aux',remaining,{spec:task.spec,interfaceText:task.interfaceText??'',planning_knowledge:planningKnowledge,...(feedback?{validation_feedback:feedback}:{})},ctx=>adapters.plan(task,{...ctx,planningFeedback:feedback,planningKnowledge}));
          try {plan=parsePlanning(response.markdown,task,planningOptions);break;}
          catch(error){
            if(cfg.plannerCompact||!(cfg.plannerNl2spec||cfg.plannerPhase2)||pass!==0||!['PLAN_INVALID','PLAN_TEMPORAL_INVALID','PLAN_CONTENT_INVALID','PLAN_MODULE_INVALID'].includes(error.code))throw error;
            // Never echo raw rejected output into the next session. This is a
            // formatting/provenance correction, not a semantic oracle or vote.
            feedback=['PLAN_TEMPORAL_INVALID','PLAN_CONTENT_INVALID','PLAN_MODULE_INVALID'].includes(error.code)?error.message:'Invalid plan structure or source quotations. Follow all required headings and field formats; quote only the original task.';
            emit('plan','retry_requested',{reason:error.code,validation_feedback:feedback});
          }
        }
        if(cfg.plannerCompact&&plan.needs_architecture){
          try {
            const response=await call('plan_architecture','aux',Math.max(1,planningEnd-Date.now()),{semantic_plan_sha256:plan.sha256},ctx=>adapters.planArchitecture(task,plan,ctx));
            plan=attachCompactArchitecture(response.markdown,task,plan,{maxModules:cfg.modular.maxModules,registeredFeedback:cfg.modular.registeredFeedback});
          }catch(error){
            plan=renderCompactPlan({...unsplitPlan(plan,'architecture_unavailable:'+(error.code??'PLAN_MODULE_INVALID')),needs_architecture:false},task);
            emit('plan_architecture','degraded',{reason:error.code??'PLAN_MODULE_INVALID',semantic_plan_preserved:true});
          }
        }
        auxConstraints=plan.constraints;
        await saveMarkdown('plan',plan.markdown);
        if(plan.temporal)await save('temporal-contract',{spec_sha256:plan.spec_sha256,interface_sha256:plan.interface_sha256,plan_sha256:plan.sha256,...plan.temporal});
        emit('routing','selected',{difficulty:plan.difficulty,decomposition:plan.decomposition,physical_modules:plan.physical_modules,rejected_quotes:plan.rejected_quotes??[],...(plan.structural_routing?{structural_routing:plan.structural_routing,split_decision:plan.split_decision}:{}),...(plan.temporal?{timing_risk:plan.timing_risk,temporal_validation:plan.temporal.validation,temporal_routing_guard:plan.temporal.routing_guard}:{}),reason:plan.routing_guard??plan.reason});
      }catch(error){auxUnavailable=error.code==='AUX_UNAVAILABLE';auxConstraints=[];plan=fallbackPlanning(task,error.code??'PLAN_INVALID',planningOptions);await saveMarkdown('plan-fallback',plan.markdown);emit('plan','degraded',{reason:error.code??'PLAN_INVALID'});}
      adapters.setPlan?.(plan);
    } else if(cfg.enableSpecAnalysis) {
      const req=message('spec_request',id('spec'),task.id,{spec_text:task.spec,interface_text:task.interfaceText??'',rules:task.rules??[]});
      try {
        validateMessage(req);invariant(cfg.auxModel,'AUX_UNAVAILABLE');
        const response=await call('analyze','aux',cfg.analyzeTimeoutMs,req,ctx=>adapters.analyze(req,ctx));validateMessage(response.value,req);
        // Claims remain advisory, anchored to literal source quotes. Ready is not
        // a semantic proof and cannot alter task.spec or hard interface checks.
        if(response.value.payload.status==='ready')auxConstraints=response.value.payload.constraints;
        else emit('analyze','degraded',{reason:'aux_abstained'});
      } catch(error){auxUnavailable=error.code==='AUX_UNAVAILABLE';emit('analyze','degraded',{reason:error.code??'OUTPUT_INVALID'});}
    } else emit('analyze','skipped',{reason:'disabled_ablation'});
    const verificationTimeAvailable=!cfg.verification.budgetSchedule||deadline-Date.now()-cfg.verification.postReserveMs>=Math.max(10000,cfg.minStageMs);
    if(prepareChecks&&!repairCheckpoint&&!stopped()&&!verificationTimeAvailable)emit('prepare_checks','skipped',{reason:'downstream_reserve_preserved',post_reserve_ms:cfg.verification.postReserveMs});
    if(prepareChecks&&!repairCheckpoint&&!stopped()&&verificationTimeAvailable) {
      const verificationStartedAt=Date.now();
      let prepared,testMethod=null;
      try{prepared=await call('prepare_checks',null,cfg.verification.budgetSchedule?210000:cfg.toolTimeoutMs,null,ctx=>prepareChecks({...ctx,
        ...(cfg.verification.enabled?{requestTestPlan:async({task:checkTask,expected})=>{
          invariant(cfg.auxModel&&adapters.testPlan,'AUX_UNAVAILABLE','No 27B test planner available');
          let knowledge=null;
          if(cfg.verificationKnowledge.mode!=='off')try {
            knowledge=await call('retrieve_verification',null,cfg.verificationKnowledge.timeoutMs,{query_sha256:sha256(checkTask.spec)},async c=>{
              const service=await loadVerificationKnowledge(cfg.verificationKnowledge);
              return service.retrieve({spec:checkTask.spec,methods:eligibleMethods({task:checkTask,expected}),signal:AbortSignal.any([ctx.signal,c.signal])});
            });
          }catch(error){emit('retrieve_verification','unavailable',{reason:error.code??'KNOWLEDGE_UNAVAILABLE',fallback:'original_spec_only'});}
          const args={task:{spec:checkTask.spec},expected,knowledge};
          const response=await call('test_plan','aux',Math.min(cfg.verification.budgetSchedule?210000:cfg.verification.timeoutMs,ctx.deadline-Date.now()),args,c=>adapters.testPlan(args,{...c,...(cfg.verification.budgetSchedule?{verificationStartedAt}:{}),signal:AbortSignal.any([ctx.signal,c.signal])}));
          testMethod=response.taskSummary?.coverage?.method??null;
          return response.value;
        }}:{})}));}catch(error){
        if(!cfg.verification.budgetSchedule||signal?.aborted||stopped()||modelCleanupUnconfirmed||!['MODEL_TIMEOUT','BUDGET_EXHAUSTED','TOOL_INFRA_FAILURE'].includes(error.code))throw error;
        emit('prepare_checks','degraded',{reason:error.code,fallback:'original_checkers',post_reserve_ms:cfg.verification.postReserveMs});
      }
      if(prepared){preparedTask=prepared.task??preparedTask;checkerSet=structuredClone(prepared.checkers??checkerSet);checkerHash=checkerIdentity(checkerSet);}
      // CPU compiler summary, not the model's self-reported oracle type. This
      // task-only metadata changes neither the frozen plan nor checker hashes.
      if(prepared?.task?.testbench&&testMethod)preparedTask.testbench.generator={kind:'computed_method',method:testMethod};
    }
    constraints=mergeConstraints(task,[['template',preparedTask.behaviorConstraints??[]],['aux',auxConstraints]],cfg.plannerPhase2?'rtl2llm.v2':'rtl2llm.v1');
    await save('constraints',{spec_sha256:sha256(task.spec),constraints,template_enabled:Boolean(preparedTask.behaviorConstraints?.length)});
    if(cfg.plannerPhase2&&plan.physical_modules&&!repairCheckpoint&&!stopped()) {
      modular=await runModularProject({task,plan,constraints,cfg,adapters,deadline,stopped,verifyModule,verification,save,saveMarkdown,saveCandidate,publish,emit,
        selfTestScope:preparedTask.testbench?.coverage??null,selfTestAssurance:preparedTask.testbench?.assurance??null,
        remainingAuthorCalls:()=>cfg.modular.maxAuthorCalls-attempts,
        call:async(stage,role,cap,request,invoke)=>{if(role==='main'){invariant(attempts<cfg.modular.maxAuthorCalls,'MODEL_CALL_LIMIT');attempts++;}return call(stage,role,cap,request,invoke);},
        onIncumbent:(candidate,ev,currentPlan)=>{incumbent=candidate;incumbentEvidence=ev;plan=currentPlan;}});
      history.push(...modular.history);reason=modular.reason;
      modularHandled=!modular.allow_unsplit_fallback;
      if(!modularHandled){plan=unsplitPlan(plan,modular.reason);adapters.setPlan(plan);emit('routing','fallback',{physical_modules:false,reason:modular.reason,previous_main_calls:attempts});}
    }
    if(!modularHandled) {
    // All calls after the initial main request share the same two-attempt cap,
    // including invalid payloads, empty recovery, expansion and regeneration.
    while(!incumbent&&singleAttempts<=cfg.maxRepairAttempts&&!stopped()) {
      if(cfg.plannerPhase2&&attempts>=cfg.modular.maxAuthorCalls)break;
      const n=singleAttempts++;attempts++;
      try {
        const result=await call(n?'regenerate':'generate','main',cfg.mainTimeoutMs,{spec:task.spec,constraints,attempt:n},ctx=>adapters.generateComplete(task,constraints,ctx));
        incumbent=snapshot(result.rtl);await saveCandidate(incumbent);await publish(incumbent,null);
      } catch(error) {
        const retry=(cfg.retryNormalEmpty&&recoverableNormalEmpty(error))||
          (cfg.regenerateWithoutRtl&&['MODEL_TRUNCATED','OUTPUT_INVALID'].includes(error.code));
        if(!retry)throw error;
        emit('output_recovery','continue',{reason:error.code,attempt:n});
      }
    }
    invariant(incumbent,'OUTPUT_INVALID','No complete candidate');
    incumbentEvidence=await verification(incumbent);
    if(cfg.harness.repairRouting){
      const routedAuthor=async({base,evidence,route,diagnosis,compileOnly=false,lintOnly=false,artifactFeedback=null,authorBatch=false,authorSignal=null})=>{
          const reported=(diagnosis?.message.payload.issues??[]).filter(i=>i.category!=='checker');
          const issues=reported.slice(0,1),pending=reported.slice(1);
          if(diagnosis){recordReview(issueLedger,base,diagnosis.message);await save('issue-ledger',issueLedger);}
          const failed=evidence.checks.filter(c=>c.status==='fail'&&(!compileOnly||['compile','interface'].includes(c.stage))&&(!lintOnly||c.stage==='lint'));
          // Counterexample repair (opt-in): functional failures carry the first
          // mismatch window instead of the full observation table.
          const repairEvidence=cfg.harness.repairCex&&!compileOnly&&!lintOnly?failed.map(c=>c.stage==='simulate'?counterexampleEvidence(c.evidence,base.rtl)??c.evidence:c.evidence):failed.map(c=>c.evidence);
          const repairKnowledge=await retrieve('repair',repairQuery(task,base,issues,failed.map(c=>c.evidence)));
          if(pending.length)emit('repair_route','issues_deferred',{selected_issue_ids:issues.map(i=>i.id),pending_issue_ids:pending.map(i=>i.id),candidate_sha256:base.sha256,reason:'one_problem_per_author_session; recheck_pending_on_current_candidate'});
          const units=route.scope==='local'?route.unit_ids:[];
          const scope=units.length?'Only change these source units: '+units.join(', ')+'. Preserve every other source token; comments and whitespace may change.':'No safe source unit boundary is proven. Make the smallest evidenced change, preserving unrelated behavior. Do not redesign the circuit.';
          const t={...task,previousCandidate:base.rtl,repairEvidence,repairScope:scope,...(repairKnowledge?{repairKnowledge}:{}),
            regenerationReason:(lintOnly?'Fix ONLY the STATIC_LINT findings in repairEvidence. Each finding is a construct that compiles but does not behave as continuous hardware. Preserve every other line, port and intended behavior.':compileOnly?'Fix ONLY compiler/interface errors in this draft. Preserve intended functional edits.':issues.length?issues.map(i=>i.explanation+'\nRequired behavior: '+i.repair_goal+(i.code_locations?.length?'\nCurrent lines: '+i.code_locations.map(l=>l.start_line).join(', '):'')).join('\n'):(cfg.harness.repairCex?'The evidence is a counterexample: the last row marked FIRST MISMATCH is where the candidate output differs from the expected value. Find the cause in the candidate and fix it so the module matches the original specification.':'Use the first observed mismatch and original specification. Identify and fix its primary cause; no auxiliary causal diagnosis is claimed.'))+
              '\n'+scope+'\nSubmit one repair only. Do not self-test, reconsider the architecture or produce another draft. Harness will validate it. Previously passing observations must remain correct.'};
          const n=singleAttempts++;attempts++;
          const unit=units.length===1?indexUnits(base.rtl).units.find(u=>u.unit_id===units[0]&&['assign','always'].includes(u.kind)):null;
          const local=Boolean(unit&&adapters.generateRepairUnit);
          const response=await call(compileOnly?'repair_compile':lintOnly?'repair_lint':'repair_routed','main',cfg.mainTimeoutMs,{...t,attempt:n,parent_id:base.id,base_sha256:base.sha256,route,output:local?'one_source_unit':'complete_module',artifactFeedback},ctx=>{ctx={...ctx,...(authorBatch?{authorBatch:true}:{}),...(authorSignal?{signal:AbortSignal.any([ctx.signal,authorSignal])}:{})};return local?adapters.generateRepairUnit({task:t,base,unit,constraints},{...ctx,repairRoute:route,artifactFeedback}):adapters.generateComplete(t,constraints,{...ctx,currentCandidate:base.rtl,repairRoute:route,artifactFeedback});});
          if(local)await save('repair-unit-response',{base_sha256:base.sha256,unit_id:unit.unit_id,text:response.text});
          const assembled=local?applyLocalRepair(base,units,response.text):response;
          if(assembled.authorization)await save('repair-transaction',assembled.authorization);
          const candidate=snapshot(assembled.rtl,base);await saveCandidate(candidate);
          const before=portContract(base.rtl,task.top),after=portContract(candidate.rtl,task.top);
          if(before)invariant(after&&JSON.stringify(before)===JSON.stringify(after),'PATCH_SCOPE_VIOLATION','Repair changed checked interface');
          invariant(preservesRepairScope(base.rtl,candidate.rtl,units),'PATCH_SCOPE_VIOLATION','Repair changed read-only source units');
          return candidate;
        };
      let resampled=null;
      if(resamplePolicy.enabled){
        const canAuthor=()=>singleAttempts<=cfg.maxRepairAttempts&&(!cfg.plannerPhase2||attempts<cfg.modular.maxAuthorCalls);
        if(resamplePolicy.parallel===1&&compileFailure(incumbentEvidence)&&canAuthor()&&!stopped()){
          const parent=incumbent,old=incumbentEvidence;
          try{
            const candidate=await routedAuthor({base:parent,evidence:old,route:{scope:'unknown',unit_ids:[],failure_kind:'compile_interface'},compileOnly:true});
            const next=await verification(candidate),selection=selectRoutedCandidate(parent,candidate,old,next);
            emit('resample','compile_preflight',{candidate_sha256:candidate.sha256,...selection});
            if(selection.accepted){incumbent=candidate;incumbentEvidence=next;await publish(candidate,next);}
          }catch(error){emit('resample','compile_preflight_failed',{reason:error.code??'OUTPUT_INVALID'});if(error.code==='MODEL_CLEANUP_UNCONFIRMED')throw error;}
        }
        const batchCtx=()=>({deadline,cleanupDeadline:deadline,onEvent:e=>emit('resample','model_event',{event:e})});
        const parent=incumbent;
        resampled=await runResamples({base:parent,evidence:incumbentEvidence,...resamplePolicy,
          hasSelfTest:Boolean(preparedTask.testbench),initialSeed:adapters.initialAuthorSeed?.()??cfg.mainModel.extraBody?.seed??1000,
          canStart:()=>!stopped()&&deadline-Date.now()>=180000&&adapters.canResample?.()===true&&(!cfg.plannerPhase2||attempts<cfg.modular.maxAuthorCalls),
          beginBatch:()=>adapters.beginResampleBatch?.(batchCtx()),
          endBatch:async()=>{try{await adapters.endResampleBatch?.(batchCtx());}catch(error){modelCleanupUnconfirmed=true;throw error;}},
          poolFallback:cfg.mainModel.sharedPoolContext===32768,
          ...(canAuthor()?{compileRepair:(base,evidence,signal)=>routedAuthor({base,evidence,route:{scope:'unknown',unit_ids:[],failure_kind:'compile_interface'},compileOnly:true,authorBatch:true,authorSignal:signal})}:{}),
          generate:async({sample,seed,signal:resampleSignal})=>{
            attempts++;
            const response=await call('regenerate_resample','main',cfg.mainTimeoutMs,{sample,seed,parent_id:parent.id},ctx=>adapters.regenerateResample({seed},{...ctx,signal:AbortSignal.any([ctx.signal,resampleSignal])}));
            const candidate=snapshot(response.rtl,parent);await saveCandidate(candidate);return candidate;
          },verify:verification,vote:async eligible=>{invariant(voteCandidates,'TOOL_INFRA_FAILURE','CPU trajectory voter unavailable');return call('resample_vote',null,cfg.toolTimeoutMs,{candidates:eligible.map(e=>e.candidate.id)},ctx=>voteCandidates(eligible,ctx));},emit,
          accept:async(base,ev)=>{incumbent=base;incumbentEvidence=ev;await publish(base,ev);}});
        incumbent=resampled.candidate;incumbentEvidence=resampled.evidence;history.push(...resampled.history);
        await save('resample-selection',{version:RESAMPLE_VERSION,history:resampled.history,accepted:resampled.accepted});
      }
      if(resampled?.accepted)reason=resampled.reason;
      else {
      const routed=await runRoutedRepairs({base:incumbent,evidence:incumbentEvidence,task:preparedTask,plan,stopped,
        canAuthor:()=>singleAttempts<=cfg.maxRepairAttempts&&(!cfg.plannerPhase2||attempts<cfg.modular.maxAuthorCalls),
        diagnose:(base,ev,route)=>review(base,ev,null,{verificationThinking:repairPolicy(route).thinking,repairRoute:route}),verify:verification,emit,
        accept:async(base,ev)=>{incumbent=base;incumbentEvidence=ev;await publish(base,ev);},
        author:routedAuthor,cexFirst:Boolean(cfg.harness.repairCex),diagnosisFirst:cfg.harness.repairDiagnosisFirst,repairFallbacks:cfg.harness.repairFallbacks,
        // Diagnosis-first has no prior repair to time; reserve the latest observed 8B authoring call instead of the full cap.
        repairBudget:()=>({remainingMs:deadline-Date.now(),diagnosisMs:cfg.reviewTimeoutMs,authorCapMs:cfg.mainTimeoutMs,lastRepairMs:lastRepairMs??(cfg.harness.repairDiagnosisFirst?lastAuthorMs:null),
          verificationReserveMs:cfg.plannerPhase1?(cfg.plannerPhase2?cfg.modular.verificationReserveMs:90000):0,minStageMs:cfg.minStageMs})});
      incumbent=routed.candidate;incumbentEvidence=routed.evidence;reason=routed.reason;history.push(...routed.history);
      await save('repair-routing',{routes:routed.routes,history:routed.history,reason});
      }
    } else {
    incumbentReview=await review(incumbent,incumbentEvidence);
    let diagnosisBatches=incumbentReview?1:0;
    if(incumbentReview){recordReview(issueLedger,incumbent,incumbentReview.message);await save('issue-ledger',issueLedger);}
    while(singleAttempts<=cfg.maxRepairAttempts&&!stopped()) {
      if(cfg.plannerPhase2&&attempts>=cfg.modular.maxAuthorCalls){reason='MODEL_CALL_LIMIT';break;}
      if(incumbentEvidence.infrastructure_error){reason='TOOL_INFRA_FAILURE';break;}
      // A completed two-issue batch may expose a further failure. Begin one
      // bounded fresh diagnosis; repair review itself never searches for #3.
      if(cfg.harness.diagnosisV2&&incumbentReview?.message.payload.repair_assessments?.length&&
        !incumbentReview.message.payload.issues.length&&incumbentReview.message.payload.repair_assessments.every(a=>['resolved','prior_diagnosis_invalid'].includes(a.status))&&incumbentEvidence.checks.some(c=>c.status==='fail')){
        if(diagnosisBatches>=2){reason='DIAGNOSIS_BATCH_LIMIT';break;}
        diagnosisBatches++;incumbentReview=await review(incumbent,incumbentEvidence);
        emit('diagnosis_batch','start',{batch:diagnosisBatches,candidate_sha256:incumbent.sha256});
        if(incumbentReview){recordReview(issueLedger,incumbent,incumbentReview.message);await save('issue-ledger',issueLedger);}
      }
      const issues=incumbentReview?.message.payload.issues??[];
      if(cfg.verification.semanticReview){
        const route=routeSelfTestRepair(incumbentEvidence.checks,incumbentReview);
        emit('repair_route','selected',{candidate_id:incumbent.id,...route});
        if(!route.repair&&route.kind!=='no_confirmed_failure'){reason=route.kind==='checker_suspect'?'CHECKER_UNCERTAIN':route.kind==='diagnosis_uncertain'?'DIAGNOSIS_UNCERTAIN':route.kind;break;}
      }
      const suspect=new Set(issues.filter(i=>i.category==='checker').flatMap(i=>i.evidence_ids));
      const failed=incumbentEvidence.checks.filter(c=>c.status==='fail'&&!suspect.has(c.evidence?.id));
      if(!failed.length) {
        // A prose suspicion alone cannot justify overwriting a tool-passing
        // candidate. Persist it for directed validation/diagnostic data.
        reason=cfg.harness.continuity&&['not_run','inconclusive'].includes(functionalCoverage(incumbentEvidence.checks).status)?'FUNCTIONAL_VERIFICATION_UNAVAILABLE':issues.some(i=>i.category!=='checker')?'CHECKER_UNCERTAIN':'no_confirmed_failure';
        emit('decide','stopped',{candidate_id:incumbent.id,reason});break;
      }
      const selectedIssues=cfg.enableIssuePackages&&incumbentReview?selectIssueGroup(incumbentReview.message,incumbentReview.index,failed.map(c=>c.evidence.id),{firstOnly:cfg.harness.diagnosisV2}):issues.filter(i=>i.category!=='checker');
      const selectedIds=selectedIssues.map(i=>i.id);
      const targetChecks=cfg.enableIssuePackages&&selectedIssues.length
        ? failed.filter(c=>selectedIssues.some(i=>i.evidence_ids.includes(c.evidence.id))).map(c=>c.id)
        : failed.map(c=>c.id);
      const pendingIssues=issues.filter(i=>i.category!=='checker'&&!selectedIds.includes(i.id));
      const selectedReview=incumbentReview?{...incumbentReview.message,payload:{...incumbentReview.message.payload,issues:selectedIssues}}:null;
      const repairKnowledge=await retrieve('repair',repairQuery(task,incumbent,selectedIssues,failed.map(c=>c.evidence)));
      let req=null,local=false,expanded=singleAttempts>1;
      if(cfg.repairMode==='local_first'&&incumbentReview&&incumbentReview.message.payload.verdict!=='uncertain') {
        try {
          req=buildRepairPackage({base:incumbent,review:selectedReview,index:incumbentReview.index,spec:task.spec,interfaceText:task.interfaceText??'',taskId:task.id,
            constraints,knowledge:repairKnowledge,pendingIssues,evidence:incumbentReview.request.payload.evidence.filter(e=>!suspect.has(e.id)),expanded,maxBytes:cfg.maxContextBytes});local=true;
          emit('package','ok',{candidate_id:incumbent.id,request_id:req.request_id,package_id:req.payload.package_id,mode:req.payload.mode});
        } catch(error){emit('package','fallback',{candidate_id:incumbent.id,reason:error.code??'DEPENDENCY_UNRESOLVED'});}
      }
      const n=singleAttempts++;attempts++;let candidate;
      try {
        if(local) {
          const response=await call('repair','main',cfg.mainTimeoutMs,req,ctx=>adapters.generateReplacement(req,ctx));
          candidate=applyReplacement(incumbent,req,response.value);
          emit('apply','ok',{request_id:req.request_id,package_id:req.payload.package_id,parent_id:incumbent.id,candidate_id:candidate.id,
            base_sha256:incumbent.sha256,candidate_sha256:candidate.sha256,units:req.payload.editable_units.map(u=>({unit_id:u.unit_id,old_sha256:u.old_sha256,new_sha256:sha256(response.value.payload.replacements.find(r=>r.unit_id===u.unit_id).new_text)}))});
        } else {
          const active=cfg.harness.diagnosisV2?selectedIssues:issues.filter(i=>i.category!=='checker');
          const t={...task,previousCandidate:incumbent.rtl,repairEvidence:failed.map(c=>c.evidence),...(repairKnowledge?{repairKnowledge}:{}),regenerationReason:active.map(i=>i.explanation+(cfg.harness.enabled?'\nBehavioral repair goal: '+i.repair_goal:'')+(i.code_locations?.length?'\nCurrent code lines: '+i.code_locations.map(l=>l.start_line).join(', '):'')).join('\n')||'Tool-confirmed failure; auxiliary diagnosis unavailable'};
          if(cfg.harness.diagnosisV2)t.regenerationReason+='\nRepair only this selected problem. Do not redesign or fix queued problems in this session. Queued issue IDs: '+JSON.stringify(pendingIssues.map(i=>i.id));
          const response=await call('regenerate','main',cfg.mainTimeoutMs,{...t,attempt:n,parent_id:incumbent.id,base_sha256:incumbent.sha256},ctx=>adapters.generateComplete(t,constraints,ctx));candidate=snapshot(response.rtl,incumbent);
        }
        if(incumbentEvidence.checks.some(c=>c.stage==='interface'&&c.status==='pass')) {
          const before=portContract(incumbent.rtl,task.top),after=portContract(candidate.rtl,task.top);
          if(before)invariant(after&&JSON.stringify(before)===JSON.stringify(after),'PATCH_SCOPE_VIOLATION','Regeneration changed a previously checked interface or cannot prove it preserved');
        }
        await saveCandidate(candidate);
      } catch(error){emit('apply','rejected',{candidate_id:incumbent.id,reason:error.code??'OUTPUT_INVALID',attempt:n});continue;}
      let nextEvidence=await verification(candidate);
      // A failed repair draft is retained independently of the accepted
      // incumbent. Spend at most ONE already-budgeted author call fixing its
      // compiler errors before asking about the original functional defect.
      // Never reset the deadline or publish a compilation regression.
      if(nextEvidence.checks.some(c=>['compile','interface'].includes(c.stage)&&c.status==='fail')&&
        singleAttempts<=cfg.maxRepairAttempts&&!stopped()&&(!cfg.plannerPhase2||attempts<cfg.modular.maxAuthorCalls)){
        const draft=candidate,compileEvidence=nextEvidence.checks.filter(c=>['compile','interface'].includes(c.stage)&&c.status==='fail');
        emit('repair_route','compile_draft',{candidate_id:draft.id,accepted_candidate_id:incumbent.id,queued_issue_ids:selectedIds});
        const compilerReview=await review(draft,nextEvidence);
        const compilerIssues=(compilerReview?.message.payload.issues??[]).filter(i=>i.evidence_ids.some(id=>compileEvidence.some(c=>c.evidence?.id===id)));
        const taskForCompile={...task,previousCandidate:draft.rtl,repairEvidence:compileEvidence.map(c=>c.evidence),
          regenerationReason:'Fix ONLY the current compiler/interface errors in this draft. Preserve its intended functional change and the original interface. Do not redesign, self-test or address other functional issues.\n'+compilerIssues.map(i=>i.explanation+'\n'+i.repair_goal).join('\n')};
        const attempt=singleAttempts++;attempts++;
        try{
          const response=await call('repair_compile','main',cfg.mainTimeoutMs,{...taskForCompile,attempt,parent_id:draft.id,base_sha256:draft.sha256},ctx=>adapters.generateComplete(taskForCompile,constraints,ctx));
          const repaired=snapshot(response.rtl,draft);
          if(incumbentEvidence.checks.some(c=>c.stage==='interface'&&c.status==='pass')){
            const before=portContract(incumbent.rtl,task.top),after=portContract(repaired.rtl,task.top);
            if(before)invariant(after&&JSON.stringify(before)===JSON.stringify(after),'PATCH_SCOPE_VIOLATION','Compiler recovery changed a checked interface');
          }
          await saveCandidate(repaired);candidate=repaired;nextEvidence=await verification(candidate);
        }catch(error){emit('repair_compile','rejected',{candidate_id:draft.id,reason:error.code??'OUTPUT_INVALID',attempt});}
      }
      const repairContext=cfg.enableRepairReview&&incumbentReview&&selectedIds.length?repairReviewContext(incumbentReview.message,incumbent,selectedIds,cfg.harness.diagnosisV2?candidate:null):null;
      const nextReview=await review(candidate,nextEvidence,repairContext);
      let selection=selectCandidate(incumbent,candidate,incumbentEvidence,nextEvidence,targetChecks);
      if(selection.accepted&&repairContext&&(!nextReview||selectedIds.some(i=>!nextReview.message.payload.repair_assessments?.some(a=>a.issue_id===i&&a.status==='resolved'))))selection={accepted:false,reason:'repair_review_not_resolved'};
      history.push({candidate_id:candidate.id,parent_id:incumbent.id,...selection});
      if(cfg.plannerPhase1||cfg.harness.diagnosisV2)sessionHistory.push({stage:'select',candidate_sha256:candidate.sha256,previous_sha256:incumbent.sha256,accepted:selection.accepted,reason:selection.reason,
        ...(cfg.harness.diagnosisV2?{selected_repairs:selectedIssues.map(i=>({id:i.id,goal:i.repair_goal})),pending_issue_ids:nextReview?.message.payload.issues.map(i=>i.id)??[],note:'Current full candidate is carried separately; old locations are historical only. Acceptance requires both current tools and focused review.'}:{})});
      emit('select',selection.accepted?'accepted':'rejected',{candidate_id:candidate.id,parent_id:incumbent.id,candidate_sha256:candidate.sha256,reason:selection.reason});
      if(selection.accepted){
        for(const a of nextReview?.message.payload.repair_assessments??[]) {
          const old=issueLedger.find(i=>i.key===`${incumbent.sha256}:${a.issue_id}`);
          if(old){old.status=a.status==='still_present'?'stale_requires_recheck':a.status;old.assessed_on=candidate.sha256;old.assessment=a.reason;}
        }
        incumbent=candidate;incumbentEvidence=nextEvidence;incumbentReview=nextReview;
        if(nextReview)recordReview(issueLedger,incumbent,nextReview.message);
        await save('issue-ledger',issueLedger);await publish(incumbent,incumbentEvidence);
      }
    }
    if(reason==='complete'&&incumbentEvidence?.checks?.some(c=>c.status==='fail'))reason='REPAIR_ATTEMPT_LIMIT';
    }
    }
    if(stopped())reason='BUDGET_EXHAUSTED';
  } catch(error){reason=error.code??'OUTPUT_INVALID';emit('controller','error',{reason});}
  finally {if(modelCleanupUnconfirmed)reason=Date.now()>=deadline?'BUDGET_EXHAUSTED':'MODEL_CLEANUP_UNCONFIRMED';if(cfg.harness.continuity&&reason==='complete'&&incumbent&&!functionalCoverage(incumbentEvidence?.checks).executed)reason='FUNCTIONAL_VERIFICATION_UNAVAILABLE';emit('stopped','done',{candidate_id:incumbent?.id??null,candidate_sha256:incumbent?.sha256??null,reason,main_calls:attempts,aux_calls:auxCalls,aux_unavailable:auxUnavailable});traceSummary=await trace.flush();}
  const result={protocol:cfg.protocolVersion,run_id:trace.run_id,candidate:incumbent,evidence:incumbentEvidence,main_calls:attempts,aux_calls:auxCalls,repair_attempts:Math.max(0,singleAttempts-1)+(modular?.repair_calls??0),aux_unavailable:auxUnavailable,reason,history,issue_ledger:issueLedger,...(cfg.plannerPhase1?{planner:plan,session_history:sessionHistory}: {}),...(modular?{modular:{module_checks:modular.module_checks,contract_revisions:modular.contract_revisions,recovery_calls:modular.recovery_calls,reason:modular.reason}}:{})};
  if(cfg.harness.continuity)result.functional_coverage=functionalCoverage(incumbentEvidence?.checks);
  if(traceSummary.failures>0)result.trace_write_failures=traceSummary.failures;
  await save('result',result);return result;
}
