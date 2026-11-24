import { invariant } from './snapshot.mjs';
import { normalizeKnowledge } from './knowledge.mjs';
import {normalizePlanningKnowledge} from '../planner/knowledge.mjs';
import {normalizeAuthorControl} from '../planner/author-control.mjs';
import {normalizeVerificationKnowledge} from '../verification/knowledge.mjs';
import {VERIFICATION_POST_RESERVE_MS} from '../verification/budget.mjs';
import {normalizeDiagnosisKnowledge} from '../harness/diagnosis-knowledge.mjs';

export function localModel(model) {
  invariant(model&&typeof model==='object'&&!model.mock,'AUX_UNAVAILABLE','Model configuration unavailable');
  let u;try{u=new URL(model.baseUrl);}catch{invariant(false,'AUX_UNAVAILABLE','Invalid model endpoint');}
  invariant(['http:','https:'].includes(u.protocol)&&['localhost','127.0.0.1','[::1]'].includes(u.hostname)&&!u.username&&!u.password&&!u.search&&!u.hash,'OUTPUT_INVALID','Only local inference is allowed; no external API fallback');
  invariant(typeof model.id==='string'&&model.id.trim()&&Number.isSafeInteger(model.contextWindow)&&Number.isSafeInteger(model.maxTokens)&&model.maxTokens>0&&model.contextWindow>model.maxTokens,'OUTPUT_INVALID','Invalid model limits');
  return model;
}
export function normalizeDual(raw={},mainModel) {
  invariant(raw&&typeof raw==='object'&&!Array.isArray(raw),'OUTPUT_INVALID','dual must be an object');
  const cfg={enableSpecAnalysis:true,enablePostReview:true,constrainAuxJson:false,repairMode:'local_first',maxRepairAttempts:2,totalTimeoutMs:900000,
    analyzeTimeoutMs:45000,reviewTimeoutMs:60000,mainTimeoutMs:600000,toolTimeoutMs:180000,modelCleanupGraceMs:250,minStageMs:50,maxContextBytes:120000,
    mainModel:structuredClone(mainModel),auxModel:null,protocolVersion:'rtl2llm.v1',knowledge:{mode:'off'},enableIssuePackages:false,enableRepairReview:false,plannerPhase1:false,plannerPhase2:false,earlyHandoff:false,plannerNl2spec:false,plannerCompact:false,authorGenerationOnly:false,...structuredClone(raw)};
  invariant(['rtl2llm.v1','rtl2llm.v2'].includes(cfg.protocolVersion),'OUTPUT_INVALID','Unknown dual protocol');
  invariant(cfg.protocolVersion==='rtl2llm.v2'||(!cfg.enableIssuePackages&&!cfg.enableRepairReview&&(cfg.knowledge?.mode??'off')==='off'),'OUTPUT_INVALID','New features require explicit v2 protocol');
  cfg.knowledge=normalizeKnowledge(cfg.knowledge);
  cfg.planningKnowledge=normalizePlanningKnowledge(cfg.planningKnowledge);
  cfg.verificationKnowledge=normalizeVerificationKnowledge(cfg.verificationKnowledge);
  cfg.diagnosisKnowledge=normalizeDiagnosisKnowledge(cfg.diagnosisKnowledge);
  cfg.verification={enabled:false,compact:false,tasks:false,structured:false,semanticReview:false,expressions:cfg.verification?.tasks===true,bodyReserve:false,budgetSchedule:false,postReserveMs:null,timeoutMs:120000,maxTokens:4096,...cfg.verification};
  if(cfg.verification.budgetSchedule&&cfg.verification.postReserveMs===null)cfg.verification.postReserveMs=VERIFICATION_POST_RESERVE_MS;
  const structured=cfg.verification.structured;
  const formatPolicy=typeof structured==='boolean'||structured&&Object.keys(structured).length===2&&['selection','review'].every(k=>typeof structured[k]==='boolean');
  invariant(Object.keys(cfg.verification).every(k=>['enabled','compact','tasks','structured','semanticReview','expressions','bodyReserve','budgetSchedule','postReserveMs','timeoutMs','maxTokens'].includes(k))&&['enabled','compact','tasks','semanticReview','expressions','bodyReserve','budgetSchedule'].every(k=>typeof cfg.verification[k]==='boolean')&&formatPolicy&&Number.isSafeInteger(cfg.verification.timeoutMs)&&cfg.verification.timeoutMs>=1000&&cfg.verification.timeoutMs<=150000&&Number.isSafeInteger(cfg.verification.maxTokens)&&cfg.verification.maxTokens>=512&&cfg.verification.maxTokens<=8192,'OUTPUT_INVALID','Invalid verification policy');
  invariant(cfg.verification.postReserveMs===null||Number.isSafeInteger(cfg.verification.postReserveMs)&&cfg.verification.postReserveMs>0&&cfg.verification.postReserveMs<cfg.totalTimeoutMs,'OUTPUT_INVALID','Invalid downstream verification reserve');
  invariant(!cfg.verification.budgetSchedule||cfg.verification.tasks,'OUTPUT_INVALID','Budget schedule requires test methods');
  invariant(!cfg.verification.bodyReserve||cfg.verification.tasks,'OUTPUT_INVALID','Body reserve requires test methods');
  invariant(!cfg.verification.expressions||cfg.verification.tasks,'OUTPUT_INVALID','Expressions require test methods');
  invariant(!cfg.verification.semanticReview||cfg.verification.tasks,'OUTPUT_INVALID','Semantic review requires test methods');
  invariant(!cfg.verification.structured||cfg.verification.tasks,'OUTPUT_INVALID','Structured test methods require test tasks and backend compatibility evidence');
  invariant(!cfg.verification.tasks||cfg.verification.compact&&cfg.harness?.calculator!==false&&Math.min(cfg.verification.maxTokens,cfg.auxModel?.maxTokens??0)>=3072,'OUTPUT_INVALID','Test tasks require compact verification, calculator and at least 3072 shared output tokens');
  invariant(!cfg.verification.compact||cfg.verification.enabled&&cfg.auxModel?.reasoning===true&&cfg.auxModel?.thinking?.format==='qwen-template-graded'&&cfg.auxModel?.thinking?.capability==='graded'&&cfg.auxModel?.thinking?.effortMap?.low==='low'&&cfg.auxModel?.thinking?.effortMap?.medium==='medium','OUTPUT_INVALID','Compact verification requires explicitly configured graded Qwen thinking (low/medium), not binary enable_thinking');
  invariant(!cfg.verification.enabled||cfg.plannerPhase1,'OUTPUT_INVALID','Auxiliary self-test requires the explicit 27B planner role');
  invariant(cfg.verificationKnowledge.mode==='off'||cfg.verification.enabled,'OUTPUT_INVALID','Verification RAG requires auxiliary self-tests');
  if(cfg.verificationKnowledge.mode==='vector'&&cfg.planningKnowledge.mode==='vector')invariant(cfg.verificationKnowledge.endpoint===cfg.planningKnowledge.endpoint&&cfg.verificationKnowledge.path!==cfg.planningKnowledge.path,'OUTPUT_INVALID','Separate knowledge stores must share one embedding service');
  cfg.authorControl=normalizeAuthorControl(cfg.authorControl);
  cfg.harness={enabled:false,calculator:true,contracts:false,trace:false,continuity:false,diagnosisV2:false,diagnosisEvidence:false,diagnosisCex:false,repairCex:false,repairRouting:false,repairFallbacks:false,repairDiagnosisFirst:false,maxAuxCalls:16,maxContinuations:2,...cfg.harness};
  invariant(Object.keys(cfg.harness).every(k=>['enabled','calculator','contracts','trace','continuity','diagnosisV2','diagnosisEvidence','diagnosisCex','repairCex','repairRouting','repairFallbacks','repairDiagnosisFirst','resample','maxAuxCalls','maxContinuations'].includes(k))&&['enabled','calculator','contracts','trace','continuity','diagnosisV2','diagnosisEvidence','repairRouting','repairFallbacks','repairDiagnosisFirst'].every(k=>typeof cfg.harness[k]==='boolean')&&Number.isSafeInteger(cfg.harness.maxAuxCalls)&&cfg.harness.maxAuxCalls>=1&&cfg.harness.maxAuxCalls<=24&&Number.isSafeInteger(cfg.harness.maxContinuations)&&cfg.harness.maxContinuations>=0&&cfg.harness.maxContinuations<=2,'OUTPUT_INVALID','Invalid harness policy');
  invariant(!cfg.harness.repairCex||cfg.harness.repairRouting,'OUTPUT_INVALID','Counterexample repair requires harness repair routing');
  invariant(!cfg.harness.repairFallbacks||cfg.harness.repairCex&&cfg.harness.repairRouting,'OUTPUT_INVALID','Repair fallbacks require the existing counterexample repair route');
  invariant(!cfg.harness.repairDiagnosisFirst||cfg.harness.repairCex&&cfg.harness.repairRouting,'OUTPUT_INVALID','Diagnosis-first repair requires the existing counterexample repair route');
  invariant(!cfg.harness.diagnosisCex||cfg.harness.enabled&&cfg.harness.contracts&&cfg.harness.continuity,'OUTPUT_INVALID','Counterexample diagnosis requires the unified harness with contracts and continuity');
  invariant(!cfg.harness.diagnosisEvidence||cfg.harness.diagnosisV2&&cfg.harness.contracts,'OUTPUT_INVALID','Diagnosis evidence requires compact small diagnosis');
  invariant(!cfg.harness.diagnosisV2||cfg.protocolVersion==='rtl2llm.v2'&&cfg.harness.enabled&&cfg.harness.continuity&&cfg.enableIssuePackages&&cfg.enableRepairReview,'OUTPUT_INVALID','Small diagnosis requires v2 harness continuity and reviewed issue packages');
  invariant(!cfg.harness.trace||cfg.harness.enabled&&cfg.verification.enabled,'OUTPUT_INVALID','Trace requires unified harness and self verification');
  invariant(!cfg.harness.continuity||cfg.harness.contracts,'OUTPUT_INVALID','Continuity requires explicit harness contracts');
  invariant(!cfg.harness.contracts||cfg.harness.enabled&&cfg.harness.calculator&&cfg.verification.compact,'OUTPUT_INVALID','Harness contracts require unified harness, calculator and compact verification');
  invariant(!cfg.harness.enabled||cfg.plannerPhase1&&cfg.plannerCompact&&cfg.auxModel?.reasoning===true&&cfg.auxModel?.thinking?.format==='qwen-template-graded'&&cfg.auxModel?.thinking?.effortMap?.low==='low'&&cfg.auxModel?.thinking?.effortMap?.medium==='medium','OUTPUT_INVALID','Unified harness requires compact planning and explicit low/medium auxiliary thinking');
  invariant(cfg.diagnosisKnowledge.mode==='off'||cfg.harness.enabled&&cfg.enablePostReview,'OUTPUT_INVALID','Diagnosis RAG requires unified diagnostic harness');
  const stores=[cfg.planningKnowledge,cfg.verificationKnowledge,cfg.diagnosisKnowledge].filter(k=>k.mode==='vector');
  invariant(new Set(stores.map(k=>k.path)).size===stores.length&&new Set(stores.map(k=>k.endpoint)).size<=1,'OUTPUT_INVALID','Independent knowledge namespaces must share one encoder endpoint, not an index path');
  if(cfg.authorControl.enabled)invariant(cfg.plannerPhase1&&cfg.authorGenerationOnly&&cfg.earlyHandoff&&cfg.mainModel?.reasoning===true&&cfg.mainModel?.temperature===1,'OUTPUT_INVALID','Author control requires planner, generation-only stages, strict early handoff, temperature 1.0 and thinking on');
  invariant(cfg.planningKnowledge.mode==='off'||cfg.plannerCompact&&cfg.plannerPhase1,'OUTPUT_INVALID','Planning RAG requires the compact planner');
  invariant(!cfg.mock&&!cfg.rag&&!cfg.dspark&&!cfg.streaming&&!cfg.concurrent,'OUTPUT_INVALID','Unsupported dual v1 feature/mock configuration');
  invariant(['local_first','full_only'].includes(cfg.repairMode),'OUTPUT_INVALID','Unknown repair mode');
  for(const k of ['enableSpecAnalysis','enablePostReview','enableIssuePackages','enableRepairReview','constrainAuxJson','plannerPhase1','plannerPhase2','earlyHandoff','plannerNl2spec','plannerCompact','authorGenerationOnly'])invariant(typeof cfg[k]==='boolean','OUTPUT_INVALID',k);
  invariant(!cfg.plannerCompact||(cfg.plannerPhase1&&cfg.enableSpecAnalysis),'OUTPUT_INVALID','Compact planning requires the explicit planner workflow');
  if(cfg.authorGenerationOnly)invariant(cfg.plannerPhase1&&cfg.mainModel?.temperature===1&&cfg.mainModel?.reasoning===true,'OUTPUT_INVALID','Author stage policy requires planner, temperature 1.0 and thinking enabled');
  invariant(!cfg.earlyHandoff||cfg.plannerPhase1,'OUTPUT_INVALID','Early handoff requires explicit planner phase 1');
  invariant(!cfg.plannerNl2spec||(cfg.plannerPhase1&&cfg.enableSpecAnalysis),'OUTPUT_INVALID','NL2SPEC adaptation requires explicit planner phase 1 and specification planning');
  if(cfg.plannerPhase1)invariant(cfg.protocolVersion==='rtl2llm.v2'&&cfg.knowledge.mode==='off'&&!cfg.constrainAuxJson,'OUTPUT_INVALID','Phase 1 uses independent role knowledge, not legacy dual RAG');
  invariant(!cfg.plannerPhase2||(cfg.plannerPhase1&&cfg.enableSpecAnalysis),'OUTPUT_INVALID','Phase 2 requires the planner foundation and specification analysis');
  if(cfg.plannerPhase2) {
    invariant(cfg.modular===undefined||cfg.modular&&typeof cfg.modular==='object'&&!Array.isArray(cfg.modular),'OUTPUT_INVALID','modular must be an object');
    const modularKeys=['maxModules','maxAuthorCalls','maxContractRevisions','minGenerationMs','verificationReserveMs','moduleCheckMs','registeredFeedback'];
    invariant(Object.keys(cfg.modular??{}).every(k=>modularKeys.includes(k)),'OUTPUT_INVALID','Unknown modular configuration field');
    cfg.modular={maxModules:3,maxAuthorCalls:12,maxContractRevisions:1,minGenerationMs:60000,verificationReserveMs:90000,moduleCheckMs:20000,registeredFeedback:false,...cfg.modular};
    invariant(typeof cfg.modular.registeredFeedback==='boolean'&&(!cfg.modular.registeredFeedback||cfg.harness.enabled),'OUTPUT_INVALID','Registered feedback requires unified harness');
    for(const [k,lo,hi] of [['maxModules',2,3],['maxAuthorCalls',3,12],['maxContractRevisions',0,1],['minGenerationMs',1000,180000],['verificationReserveMs',1000,180000],['moduleCheckMs',1000,60000]])invariant(Number.isSafeInteger(cfg.modular[k])&&cfg.modular[k]>=lo&&cfg.modular[k]<=hi,'OUTPUT_INVALID',`Invalid modular ${k}`);
    invariant(cfg.mainModel?.temperature===1,'OUTPUT_INVALID','Phase 2 keeps author temperature 1.0');
  }
  for(const k of ['analyzeTimeoutMs','reviewTimeoutMs','mainTimeoutMs','toolTimeoutMs','modelCleanupGraceMs','minStageMs','maxContextBytes','totalTimeoutMs'])invariant(Number.isSafeInteger(cfg[k])&&cfg[k]>0&&cfg[k]<=2147483647,'OUTPUT_INVALID',k);
  invariant(Number.isSafeInteger(cfg.maxRepairAttempts)&&cfg.maxRepairAttempts>=0&&cfg.maxRepairAttempts<=(cfg.harness.diagnosisV2||cfg.harness.repairCex?4:2),'OUTPUT_INVALID','At most two post-initial main attempts, or four with explicit small diagnosis');
  localModel(cfg.mainModel);if(cfg.auxModel)localModel(cfg.auxModel);
  invariant(!cfg.constrainAuxJson||!cfg.auxModel?.reasoning,'OUTPUT_INVALID','Auxiliary schema decoding is validated only with non-thinking output');
  return cfg;
}
export const modelIdentity = model => model ? {id:model.id,contextWindow:model.contextWindow,maxTokens:model.maxTokens,reasoning:model.reasoning??false,
  reasoningBudget:model.reasoningBudget??null,thinking:model.thinking??null,temperature:model.temperature??null,topP:model.topP??null,identity:model.identity??null} : null;
export function requireSharedMain(config) {
  const a=config.model,b=config.dual.mainModel;
  const sort=value=>Array.isArray(value)?value.map(sort):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,sort(value[k])])):value;
  const canonical=value=>JSON.stringify(sort(value));
  for(const key of ['id','contextWindow','reasoningBudget','thinking','extraBody'])invariant(canonical(a[key])===canonical(b[key]),'OUTPUT_INVALID',`Dual main/baseline ${key} differs`);
  invariant((a.reasoning??false)===(b.reasoning??false)&&a.baseUrl.replace(/\/$/,'')===b.baseUrl.replace(/\/$/,''),'OUTPUT_INVALID','Dual main/baseline endpoint or thinking differs');
}
export function dualIdentityReady(config) {
  const c=config.dual??config;
  for(const [role,m] of [['main',c.mainModel],['aux',c.auxModel]]) {
    if(!m)return {ready:false,reason:'AUX_UNAVAILABLE'};
    try{localModel(m);}catch(e){return {ready:false,reason:e.code};}
    if(!m.identity?.revision||!/^[a-f0-9]{64}$/.test(m.identity?.sha256??'')||!m.identity?.path)return {ready:false,reason:`${role}_identity_unverified`};
  }
  if(c.plannerPhase1){
    if(c.mainModel.identity.quantization!=='Q6_K'||c.auxModel.identity.quantization!=='UD-Q4_K_M')return {ready:false,reason:'phase1_requires_8b_Q6_author_and_27b_Q4_planner'};
  }else if(!/^Q6_K(?:_.*)?$/.test(c.auxModel.identity.quantization??''))return {ready:false,reason:'aux_requires_Q6_K'};
  return {ready:true,reason:null};
}
