import { generateRtl, ModelGenerationError, measureModelContext } from '../model.mjs';
import { extractAuthorRtl } from './author-output.mjs';
import { reasoningGuidance, authorStageGuidance, AUTHOR_STAGE_POLICY_VERSION } from '../reasoning-guidance.mjs';
import { fitContext } from '../dual/clients.mjs';
import { adaptPayload, parsePayload, renderRequest, requestView } from '../dual/render.mjs';
import { invariant, sha256 } from '../dual/snapshot.mjs';
import { fallbackPlan, handoffMarkdown, planningRequest, sourceQuote } from './plan.mjs';
import { createEarlyHandoff,createLocalRepairHandoff } from './early-handoff.mjs';
import {applyLocalRepair} from '../dual/local-repair.mjs';
import { waitForInferenceIdle } from './inference-idle.mjs';
import {modularPlanningRequest} from '../modular/plan.mjs';
import {moduleHandoff, diagnosisRequest} from '../modular/handoff.mjs';
import {moduleContract, moduleHeader} from '../modular/contracts.mjs';
import {compactPlanningRequest,architectureRequest,sourceCatalog,parseCompactPlan,attachCompactArchitecture} from './compact.mjs';
import {createAuxiliaryHarness} from '../harness/auxiliary.mjs';
import {diagnosticRequest,diagnosticCatalog,expandDiagnosis} from '../harness/diagnosis.mjs';
import {loadDiagnosisKnowledge,diagnosisKnowledgeSection} from '../harness/diagnosis-knowledge.mjs';
import {diagnosisEvidenceBrief} from '../harness/diagnosis-evidence.mjs';
import {cexContext,cexDiagnosisRequest,parseCexDiagnosis,toDiagnosis,QUICK_SYSTEM,CEX_LIMITS,CEX_DIAGNOSIS_VERSION} from '../harness/diagnosis-cex.mjs';
import {controlledAuthor,authorControlGuidance} from './author-control.mjs';
import {fitObservationRequest} from '../harness/observation-excerpt.mjs';
import {verificationRequest} from '../verification/plan.mjs';
import {compactVerificationRequest,parseCompactVerification,expandCompactVerification,compactVerificationPolicy,verificationEffort,COMPACT_REVIEW_GUIDANCE} from '../verification/compact.mjs';
import {runVerificationTasks} from '../verification/tasks.mjs';

export function createPlannerClients(config, generate = generateRtl) {
  let plan;
  let diagnosisService;
  const diagnosticKnowledge=async(task,checks,ctx)=>{
    if(!config.diagnosisKnowledge||config.diagnosisKnowledge.mode==='off')return null;
    try{
      // Lazy loading: no embedding work before an actual diagnosis. Failure
      // falls back to the existing evidence-based prompt, never a fake hit.
      diagnosisService??=loadDiagnosisKnowledge(config.diagnosisKnowledge);
      const service=await diagnosisService;
      const remaining=Math.min(service.config.timeoutMs,ctx.deadline-Date.now());
      invariant(remaining>0,'BUDGET_EXHAUSTED');
      const timer=AbortSignal.timeout(remaining),signal=ctx.signal?AbortSignal.any([ctx.signal,timer]):timer;
      const result=await service.retrieve({spec:task.spec,checks,signal,candidate:task.diagnosisCandidate});
      await ctx.saveRecord?.('diagnosis-knowledge',result);
      return result.knowledge;
    }catch(error){
      await ctx.saveRecord?.('diagnosis-knowledge-unavailable',{reason:error.code??error.name??'KNOWLEDGE_UNAVAILABLE',fallback:'original_sources_and_checks_only'});
      return null;
    }
  };
  const harness=createAuxiliaryHarness();
  const contextFor=task=>Object.fromEntries(sourceCatalog(task).map(r=>[r.id,r]));
  const aux=async(stage,render,ctx,task,validate,context=contextFor(task))=>harness.run({stage,render,ctx,context,
    identity:{spec_sha256:sha256(task.spec),interface_sha256:sha256(task.interfaceText??''),candidate_sha256:ctx.candidateSha256??null,contract_sha256:ctx.semanticPlan?.architecture?.sha256??null},
    calculatorEnabled:config.harness.calculator,contracts:config.harness.contracts,continuity:config.harness.continuity,recoverObject:config.harness.diagnosisV2&&['diagnose_failure','review_repair'].includes(stage),maxContinuations:config.harness.maxContinuations,validate,
    invoke:(r,c)=>invoke('planner',r,c,undefined,'json')});
  const invoke = async (role, render, ctx, candidateGate, format='rtl') => {
    const source = role === 'planner' ? config.auxModel : config.mainModel;
    invariant(source, 'AUX_UNAVAILABLE');
    const model = structuredClone(source);
    const thinkingLevel=model.reasoning?(ctx.verificationThinking??(role==='planner'&&(config.verification?.compact||config.harness?.enabled)?verificationEffort(ctx.semanticPlan??plan):'medium')):undefined;
    if(ctx.verificationPlan){
      model.maxTokens=Math.min(model.maxTokens,ctx.verificationScheduled?8192:config.verification.maxTokens,ctx.verificationMaxTokens??Infinity);
      // A correction/review shares the original output allowance. Preserve
      // thinking and automatic (-1) policy, but never send an invalid budget.
      if(model.reasoning&&model.reasoningBudget>=0)model.reasoningBudget=Math.min(model.reasoningBudget,model.maxTokens-1);
      // Opt-in experiment: keep thinking on, but leave nominally 3/4 of this
      // call's already bounded allowance for JSON and transition tokens. Never
      // increase a smaller configured thinking budget or the shared allowance.
      if((config.verification.bodyReserve||ctx.verificationScheduled)&&model.reasoning)model.reasoningBudget=Math.min(model.reasoningBudget>=0?model.reasoningBudget:Infinity,Math.floor(model.maxTokens/4));
    }
    if(ctx.verificationSchema)model.extraBody={...model.extraBody,response_format:{type:'json_schema',json_schema:{name:'test_method',strict:true,schema:ctx.verificationSchema}}};
    if(ctx.diagnosisTurn){
      model.maxTokens=Math.min(model.maxTokens,ctx.diagnosisTurn.maxTokens);
      // Counterexample diagnosis sets its own thinking budget explicitly; the
      // configured default (2048) must not silently cap it.
      if(model.reasoning)model.reasoningBudget=ctx.diagnosisTurn.overrideBudget?Math.min(ctx.diagnosisTurn.reasoningTokens,model.maxTokens-1):Math.min(ctx.diagnosisTurn.reasoningTokens,model.maxTokens-1,model.reasoningBudget>=0?model.reasoningBudget:Infinity);
    }
    const controlled=role==='author'&&config.authorControl?.enabled;
    // Save the actual system prompt as well as the MD handoff, including policy.
    if(controlled)render={...render,systemPrompt:render.systemPrompt+'\n\n'+authorControlGuidance(format)};
    model.requestTimeoutMs = Math.max(1, Math.min(source.requestTimeoutMs ?? 600000, ctx.deadline - Date.now(),ctx.diagnosisTurn?.timeoutMs??Infinity));
    // This Markdown is exactly the material loaded into the new conversation.
    let stored = await ctx.saveMarkdown?.(`${role}-handoff`, render.prompt);
    if (stored) render = {...render, prompt:stored.text};
    let measured;
    const capacity=async input=>{
      if(config.harness?.continuity){
        invariant(Buffer.byteLength(input.systemPrompt)+Buffer.byteLength(input.prompt)<=config.maxContextBytes,'CONTEXT_OVERFLOW','Input exceeds independent byte safety limit');
        measured=await measureModelContext({model,...input,thinkingLevel,signal:ctx.signal,deadline:ctx.deadline});
        fitContext(model,input,config.maxContextBytes,measured);
      }else fitContext(model,input,config.maxContextBytes);
    };
    if(ctx.observationSources?.length){
      const fitted=await fitObservationRequest(render,ctx.observationSources,capacity);
      if(fitted.records.length){
        render=fitted.render;stored=await ctx.saveMarkdown?.(`${role}-bounded-handoff`,render.prompt);
        await ctx.saveRecord?.('observation-excerpt',{observations:fitted.records});
        ctx.onEvent?.({type:'observation_excerpt',observations:fitted.records});
      }
    }else await capacity(render);
    if(measured)await ctx.saveRecord?.('context-budget',{role,...measured,outputReserve:model.maxTokens,framingReserve:256,contextWindow:model.contextWindow});
    await ctx.saveRecord?.('model-input', {...render, handoff:stored?.record ?? null, model:{id:model.id,maxTokens:model.maxTokens,reasoningBudget:model.reasoningBudget??null,contextWindow:model.contextWindow},thinking_level:thinkingLevel??null,repair_route:ctx.repairRoute??null,diagnosis_turn:ctx.diagnosisTurn??null});
    // Also guard a NEW task's planner/local-repair call against a request left
    // active by a prior task. A per-controller cancellation flag alone cannot.
    if(config.earlyHandoff&&!ctx.authorBatch)for(const service of [config.mainModel,config.auxModel].filter(Boolean))await waitForInferenceIdle(service,ctx);
    model.requestTimeoutMs=Math.max(1,Math.min(model.requestTimeoutMs,ctx.deadline-Date.now()));
    let result;
    try {
      result = controlled
        ? await controlledAuthor({control:config.authorControl,model,plan,format,render,ctx,generate,candidateGate})
        : await generate({model, ...render, signal:ctx.signal, thinkingLevel, onEvent:e=>ctx.onEvent?.(e),...(candidateGate?{candidateGate}:{})});
    } catch(error) {
      if(controlled&&!ctx.authorBatch)await waitForInferenceIdle(model,ctx);
      throw error;
    }
    if(!ctx.authorBatch&&result.stopReason==='handoff'&&candidateGate&&result.handoff?.client_stream_settled===true) {
      await ctx.saveRecord?.('handoff-candidate',result);
      const idle=await waitForInferenceIdle(model,ctx);
      ctx.onEvent?.({type:'handoff_cleanup',...idle});
      return {...result,handoff:{...result.handoff,backend_idle_confirmed:true,idle}};
    }
    if(ctx.authorBatch&&result.stopReason==='handoff'&&candidateGate&&result.handoff?.client_stream_settled)return result;
    if (result.stopReason !== 'stop') throw new ModelGenerationError(result.stopReason === 'length' ? 'MODEL_TRUNCATED' : 'OUTPUT_INVALID', 'Incomplete model response', result);
    return result;
  };
  // Counterexample diagnosis: one call with a larger thinking budget, plain
  // labelled answer, tolerant parse; one quick no-thinking retry only when no
  // CAUSE line could be read. Converted to the small diagnosis shape so the
  // existing validation and repair routing stay unchanged.
  const cexDiagnose=async(req,cx,ctx)=>{
    const p=req.payload,render=cexDiagnosisRequest({spec:p.spec_text,rtl:p.candidate.rtl,cex:cx.cex,interfaceText:p.interface_text??''});
    await ctx.saveRecord?.('diagnosis-cex-request',{version:CEX_DIAGNOSIS_VERSION,counterexample:cx.cex,prompt_bytes:Buffer.byteLength(render.prompt)});
    const turn=(maxTokens,reasoningTokens,limit)=>({maxTokens,reasoningTokens,overrideBudget:true,timeoutMs:Math.max(1,Math.min(limit,ctx.deadline-Date.now()-30000))});
    const ask=async(r,t,attempt)=>{
      try{const out=await invoke('planner',r,{...ctx,observationSources:undefined,candidateSha256:p.candidate.sha256,diagnosisTurn:t},undefined,'json');return out.text??'';}
      catch(error){
        // Only model-output failures are tolerated (their partial text may still
        // hold the labelled lines); configuration and harness errors propagate.
        if(ctx.signal?.aborted||!['MODEL_TRUNCATED','MODEL_TIMEOUT','MODEL_EMPTY','MODEL_REQUEST_FAILED','MODEL_UNEXPECTED_RESPONSE','OUTPUT_INVALID'].includes(error.code))throw error;
        await ctx.saveRecord?.('diagnosis-cex-model-error',{attempt,code:error.code??error.name,partial_chars:String(error.text??'').length});
        return String(error.text??'');
      }
    };
    let text=await ask(render,turn(CEX_LIMITS.maxTokens,CEX_LIMITS.thinking,CEX_LIMITS.timeoutMs),'full'),attempt='full';
    let parsed=parseCexDiagnosis(text,cx);
    if(!parsed.ok&&ctx.deadline-Date.now()>CEX_LIMITS.quickTimeoutMs+60000){
      attempt='quick';text=await ask({systemPrompt:QUICK_SYSTEM,prompt:render.prompt},turn(CEX_LIMITS.quickMaxTokens,0,CEX_LIMITS.quickTimeoutMs),'quick');
      parsed=parseCexDiagnosis(text,cx);
    }
    await ctx.saveRecord?.('diagnosis-cex-parse',{attempt,answer_chars:text.length,answer_tail:text.slice(-2000),...parsed});
    const {raw,simple}=toDiagnosis(parsed,cx);
    const value=expandDiagnosis(raw,req,{simple,checks:config.harness.continuity?ctx.observedChecks:undefined});
    await ctx.saveRecord?.('harness-response',{version:CEX_DIAGNOSIS_VERSION,status:'ready',attempt,payload:value});
    return {text:JSON.stringify(raw),value};
  };
  const packet = (task, role, extra={}) => handoffMarkdown({task,plan:plan??fallbackPlan(task,'not_available',{nl2spec:config.plannerNl2spec}),role,...extra});
  const protocolCall = async (req, ctx) => {
    let p=req.payload;const task={spec:p.spec_text,interfaceText:p.interface_text??''};
    const repair=req.kind==='repair_request';
    if(!repair)ctx={...ctx,observationSources:p.evidence.filter(e=>e.observation).map(e=>({evidence:e,rtl:p.candidate.rtl}))};
    if(!repair&&config.harness?.enabled){
      if(config.harness.diagnosisCex&&!p.repair_context){
        const cx=cexContext(req,ctx.observedChecks??[]);
        if(cx)return cexDiagnose(req,cx,ctx);
        await ctx.saveRecord?.('diagnosis-cex-skipped',{reason:'no_current_simulation_counterexample'});
      }
      const evidenceBrief=config.harness.diagnosisEvidence?diagnosisEvidenceBrief({rtl:p.candidate.rtl,checks:ctx.observedChecks}):null;
      if(evidenceBrief)await ctx.saveRecord?.('diagnosis-evidence-brief',evidenceBrief);
      const knowledge=await diagnosticKnowledge({...task,diagnosisCandidate:evidenceBrief?p.candidate.rtl:undefined},ctx.observedChecks??[],ctx);
      if(knowledge){req={...req,payload:{...p,knowledge}};p=req.payload;await ctx.saveRecord?.('diagnosis-enriched-request',{request:req});}
      const render=diagnosticRequest(req,{checks:ctx.observedChecks,simple:config.harness.diagnosisV2,compact:config.harness.contracts,selfTestScope:ctx.selfTestScope,selfTestAssurance:ctx.selfTestAssurance,evidenceBrief});
      render.prompt+=diagnosisKnowledgeSection(knowledge);
      if(ctx.repairFocus&&!evidenceBrief)render.prompt+='\n\n# Harness focus (observed facts, not a causal diagnosis)\n'+JSON.stringify(ctx.repairFocus)+'\nCompare the first mismatch with the preceding correct sample before inferring latency or pulse duration. Full history and original requirements are already supplied above. Reuse them; request context only if a specific required item is actually absent. Submit the first evidenced repair goal promptly; do not redesign, enumerate hypothetical faults or mentally run an entire test suite.';
      const result=await aux(p.repair_context?'review_repair':'diagnose_failure',render,{...ctx,candidateSha256:p.candidate.sha256},task,raw=>expandDiagnosis(raw,req,{simple:config.harness.diagnosisV2,checks:config.harness.continuity?ctx.observedChecks:undefined}),diagnosticCatalog(req,{simple:config.harness.diagnosisV2,compact:config.harness.contracts}));
      return result;
    }
    if(config.authorGenerationOnly&&repair)await ctx.saveRecord?.('author-stage',{policy:AUTHOR_STAGE_POLICY_VERSION,stage:'repair',target:'editable_units'});
    const candidate=repair ? ctx.currentCandidate : p.candidate.rtl;
    if(repair)invariant(typeof candidate==='string'&&sha256(candidate)===p.base_sha256,'STALE_SNAPSHOT','Repair handoff must carry the exact current full candidate');
    const handoff=packet(task,'repair',{constraints:p.constraints??[],candidate,evidence:p.evidence,
      authorStage:config.authorGenerationOnly&&repair?'repair':null,
      editScope:repair ? 'Only the editable_units in Protocol data; all other bytes are immutable.' : 'Diagnosis only. Do not output RTL or change tests.',
      dependencies:repair ? 'The complete current candidate is in the candidate section. Only Protocol data editable_units may change; every other byte is read-only. Preserve shared declarations, drivers/readers, state, reset and cycle ordering.' : 'Complete current candidate is included above.',previousAttempts:ctx.previousAttempts??[]});
    const rendered=renderRequest(req,{compactSchema:config.plannerCompact===true||config.verification?.compact===true,verificationGuidance:config.verification?.enabled===true});
    if(!repair&&config.verification?.compact)rendered.systemPrompt+='\n\n'+COMPACT_REVIEW_GUIDANCE;
    // One authoritative copy of the long immutable data, not duplicated full
    // chat history. Transaction identities and authorized unit bytes stay exact.
    const view=requestView(req);
    delete view.spec_text;delete view.interface_text;delete view.constraints;delete view.evidence;
    if(repair)delete view.readonly_context;else delete view.candidate.rtl;
    const prompt=handoff+'\n## Protocol data\n\nOriginal spec, interface, constraints, current evidence (including evidence IDs) and full candidate are the verbatim sections above. All candidate bytes outside editable_units are read-only.\n'+req.kind+'\nDATA_JSON:\n'+JSON.stringify(view);
    const result=await invoke(repair?'author':'planner',{...rendered,prompt,systemPrompt:rendered.systemPrompt+(config.authorGenerationOnly&&repair?'\n\n'+authorStageGuidance('repair'):'')},ctx,undefined,'json');
    const payload=parsePayload(result.text);
    if(!repair&&Array.isArray(payload.issues))for(const issue of payload.issues) {
      if(Array.isArray(issue.requirement_quotes))for(const q of issue.requirement_quotes) {
        invariant(['spec','interface'].includes(q.source)&&typeof q.quote==='string','OUTPUT_INVALID');
        const original=sourceQuote(q.quote,q.source==='spec'?task.spec:task.interfaceText);
        invariant(original,'OUTPUT_INVALID','Review cites a requirement absent from the original task');q.quote=original;
      }
    }
    return {...result,value:adaptPayload(req,payload)};
  };
  return {
    setPlan(value){plan=value;},
    testPlan:async(args,ctx)=>{
      if(config.verification?.tasks)return runVerificationTasks({...args,expressions:config.verification.expressions,semanticPlan:ctx.semanticPlan??plan},ctx,{structured:config.verification.structured,semanticReview:config.verification.semanticReview,budgetSchedule:config.verification.budgetSchedule,maxTokens:Math.min(config.verification.budgetSchedule?8192:config.verification.maxTokens,config.auxModel.maxTokens),invoke:(r,c)=>invoke('planner',r,c,undefined,'json')});
      const compact=config.verification?.compact===true;
      if(compact)await ctx.saveRecord?.('verification-policy',compactVerificationPolicy(args.task,ctx.semanticPlan??plan));
      if(config.harness?.enabled){
        const result=await aux('plan_test',(compact?compactVerificationRequest:verificationRequest)(args),{...ctx,verificationPlan:true,expectedInterface:args.expected},args.task,raw=>compact?expandCompactVerification(raw,args.task):raw);
        await ctx.saveRecord?.('verification-model-output',result);return result;
      }
      const result=await invoke('planner',(compact?compactVerificationRequest:verificationRequest)(args),{...ctx,verificationPlan:true},undefined,'json');
      await ctx.saveRecord?.('verification-model-output',result);
      const raw=compact?parseCompactVerification(result.text):parsePayload(result.text);
      return {...result,value:compact?expandCompactVerification(raw,args.task):raw};
    },
    plan:async(task,ctx)=>{const request=(config.plannerCompact?compactPlanningRequest:config.plannerPhase2?modularPlanningRequest:planningRequest)(task,{nl2spec:config.plannerNl2spec,feedback:ctx.planningFeedback,physical:config.plannerPhase2,knowledge:ctx.planningKnowledge,splitDecision:config.harness?.enabled,registeredFeedback:config.modular?.registeredFeedback,contracts:config.harness?.contracts});
      if(ctx.contractRevision)request.prompt+='\n\n## Contract revision (observed failure, not an oracle)\n\n'+JSON.stringify(ctx.contractRevision);
      const result=config.harness?.enabled?await aux('plan_semantics',request,ctx,task,raw=>parseCompactPlan(JSON.stringify(raw),task,{physical:config.plannerPhase2,splitDecision:true,contracts:config.harness.contracts})):await invoke('planner',request,ctx);return {...result,markdown:result.text};},
    planArchitecture:async(task,semanticPlan,ctx)=>{
      const render=architectureRequest(task,semanticPlan,{feedback:ctx.planningFeedback,registeredFeedback:config.modular?.registeredFeedback});
      const result=config.harness?.enabled?await aux('plan_architecture',render,{...ctx,semanticPlan},task,raw=>attachCompactArchitecture(JSON.stringify(raw),task,semanticPlan,{maxModules:config.modular.maxModules,registeredFeedback:config.modular.registeredFeedback})):await invoke('planner',render,ctx);
      return {...result,markdown:result.text};
    },
    generateModule:async(args,ctx)=>{
      const {task,plan:modulePlan,name}=args;
      const hasCandidate=Boolean(args.project?.modules.find(m=>m.name===name)?.rtl??args.sources?.[name]);
      const authorStage=config.authorGenerationOnly?(hasCandidate?'repair':'generate'):null;
      if(authorStage)await ctx.saveRecord?.('author-stage',{policy:AUTHOR_STAGE_POLICY_VERSION,stage:authorStage,target:name});
      const render={systemPrompt:'You are SiliconMind, the sole RTL author. This is one fresh module conversation, not the entire project. Original specification overrides advisory planning. Return one <answer> block with one SystemVerilog fence containing ONLY the requested complete module. Preserve the frozen interface and exact clock/reset/cycle behavior. No extra module, external files, macros, simulation control or commentary. Leaf modules may not instantiate other modules. The top may contain only the specified wires and named-port instances; all behavior belongs in the leaves. Think internally, complete this bounded task, then submit for tool verification.',
        prompt:moduleHandoff({...args,authorStage,previousAttempts:ctx.previousAttempts??[]})};
      if(authorStage)render.systemPrompt+='\n\n'+authorStageGuidance(authorStage);
      if(modulePlan.architecture.path_mode)render.systemPrompt+='\nFrozen paths lists CURRENT-CYCLE input dependencies for each output. An empty inputs list means only registered state may affect that output, not same-cycle data/control inputs. Do not add latency. Use ordinary assign/always/always_ff/always_comb blocks and explicit loop increments; avoid generate/functions with timing or unsupported macros. The harness checks declared paths against conservative source dependencies and Vivado checks the actual code.';
      const gateTask={...task,top:name,interfaceText:moduleHeader(moduleContract(modulePlan.architecture,name))};
      const gate=config.earlyHandoff?createEarlyHandoff(gateTask):undefined;
      const result=await invoke('author',render,ctx,gate??undefined);
      let extracted;try{extracted=extractAuthorRtl(result.text,name);}catch(error){throw new ModelGenerationError('OUTPUT_INVALID',error.message,result);}
      if(result.stopReason==='handoff')invariant(sha256(extracted.rtl)===result.handoff.candidate_sha256,'OUTPUT_INVALID','Module candidate changed before verification');
      return {...result,...extracted};
    },
    diagnoseModules:async(args,ctx)=>{
      const render=diagnosisRequest(args.task,args.plan,args.project,args.evidence,{compact:config.harness?.enabled,selfTestScope:ctx.selfTestScope,selfTestAssurance:ctx.selfTestAssurance});
      if(config.harness?.enabled){
        const {validateModuleDiagnosis}=await import('../modular/controller.mjs');
        render.prompt+=diagnosisKnowledgeSection(await diagnosticKnowledge(args.task,args.evidence,ctx));
        return aux('diagnose_failure',render,{...ctx,semanticPlan:args.plan,candidateSha256:args.project.sha256},args.task,raw=>validateModuleDiagnosis(raw,args.project,args.evidence.filter(c=>c.status==='fail'),true),{...contextFor(args.task),...Object.fromEntries(args.evidence.filter(c=>c.evidence).map(c=>[c.evidence.id,c.evidence]))});
      }
      const result=await invoke('planner',render,ctx);
      return {...result,value:parsePayload(result.text)};
    },
    review:protocolCall,
    generateReplacement:protocolCall,
    generateRepairUnit:async({task,base,unit,constraints},ctx)=>{
      const scope='Replace ONLY '+unit.unit_id+' ('+unit.kind+'). The full current module below is READ ONLY except for this unit. Submit the replacement unit alone; no module/header/endmodule, declarations or second assignment block. Keep its original driven signals. The harness copies all other bytes unchanged.';
      const render={systemPrompt:'You are SiliconMind, the sole RTL repair author. Follow the original requirements and the evidenced repair goal. Return one <answer> block with one SystemVerilog fence containing exactly ONE replacement source unit, then </answer> and stop. No extra draft, self-test or redesign. '+scope+'\n'+authorStageGuidance('repair'),
        prompt:packet(task,'repair',{authorStage:'repair',constraints,candidate:base.rtl,evidence:task.repairEvidence??[],editScope:scope,previousAttempts:ctx.previousAttempts??[]})+'\n\n## Current repair assignment\n'+task.regenerationReason+'\n\n## Authorized unit (replace, do not append)\n'+unit.old_text+(ctx.artifactFeedback?'\n\n## Artifact structure correction only\n'+ctx.artifactFeedback+'\nKeep the same functional goal. Do not start a new diagnosis.':'')};
      await ctx.saveRecord?.('author-stage',{policy:AUTHOR_STAGE_POLICY_VERSION,stage:'repair',target:unit.unit_id,output:'one_source_unit',base_sha256:base.sha256,repair_route:ctx.repairRoute});
      const gate=config.earlyHandoff?createLocalRepairHandoff(base,[unit.unit_id]):undefined;
      const result=await invoke('author',render,ctx,gate,'rtl');
      if(result.stopReason==='handoff')invariant(sha256(applyLocalRepair(base,[unit.unit_id],result.text).rtl)===result.handoff.candidate_sha256,'OUTPUT_INVALID','Captured replacement changed before verification');
      return result;
    },
    generateComplete:async(task,constraints,ctx)=>{
      const repairing=Boolean(task.previousCandidate);
      const previousFailures=(ctx.previousAttempts??[]).filter(a=>['generate','regenerate'].includes(a.stage)&&a.status==='failed');
      const recovering=previousFailures.length>0;
      const authorStage=config.authorGenerationOnly?(repairing?'repair':'generate'):null;
      if(authorStage)await ctx.saveRecord?.('author-stage',{policy:AUTHOR_STAGE_POLICY_VERSION,stage:authorStage,target:task.top});
      const handoff=packet(task,repairing||(recovering&&!authorStage)?'repair':'implementation',{authorStage,constraints,candidate:task.previousCandidate??'',evidence:task.repairEvidence??[],
        editScope:repairing?(task.repairScope??'Complete regeneration is authorized because a safe local transaction was unavailable. Preserve the top interface and exact timing.'):'Generate ONE complete top module. Logical blocks are internal responsibilities, not extra modules.',
        previousAttempts:ctx.previousAttempts??[]});
      const guidance=authorStage?authorStageGuidance(authorStage):reasoningGuidance({enabled:true,level:'medium',attempts:previousFailures.map(a=>({failureKind:a.reason}))});
      const render={systemPrompt:'You are SiliconMind, the sole RTL author. Generate synthesizable Verilog/SystemVerilog. The original specification outranks planner notes. Preserve exact ports, widths, signedness, reset, priorities and cycle latency. Think internally, then return exactly one <answer> block containing one SystemVerilog fence with one complete top module, followed by </answer>. No executable testbench, external files, simulation control, prose essay or questions. Phase 1 does not split into physical submodules. Handoff test proposals are not observed results. Use concise comments only; prioritize finishing the complete RTL.\n\n'+guidance,
        prompt:handoff+'\n## Advisory rules\n\n'+JSON.stringify(task.rules??[])+'\n\n## Current repair diagnosis\n\n'+(task.regenerationReason??(recovering?'No complete RTL is available. Previous output failed: '+previousFailures.at(-1).reason+'. This is an output-format/completion problem, not a demonstrated circuit defect. Produce the complete RTL now.':'none'))};
      const candidateGate=config.earlyHandoff?createEarlyHandoff(task):undefined;
      if(config.earlyHandoff&&!candidateGate)ctx.onEvent?.({type:'handoff_disabled',reason:'interface_unresolved'});
      const result=await invoke('author',render,ctx,candidateGate??undefined);
      let extracted;try{extracted=extractAuthorRtl(result.text,task.top);}catch(error){throw new ModelGenerationError('OUTPUT_INVALID',error.message,result);}
      if(result.stopReason==='handoff')invariant(sha256(extracted.rtl)===result.handoff.candidate_sha256,'OUTPUT_INVALID','Captured candidate changed before verification');
      return {...result,...extracted};
    },
  };
}
