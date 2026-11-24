import path from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { runtimeConfig } from './create-config.mjs';
import { normalizeDual } from '../../rtl-agent/src/dual/config.mjs';

// Explicit new role assignment. The legacy declaration/baseline stays intact.
export const PLANNER_AUTHOR_CONTEXT=24576, PLANNER_AUX_CONTEXT=20480;
export async function plannerRuntimeConfig(env=process.env) {
  if(env.AGENT_REPAIR_FALLBACKS!==undefined&&!['0','1'].includes(env.AGENT_REPAIR_FALLBACKS))throw new Error('AGENT_REPAIR_FALLBACKS must be 0 or 1');
  if(env.AGENT_REPAIR_DIAGNOSIS_FIRST!==undefined&&!['0','1'].includes(env.AGENT_REPAIR_DIAGNOSIS_FIRST))throw new Error('AGENT_REPAIR_DIAGNOSIS_FIRST must be 0 or 1');
  for(const key of ['AGENT_UNIFIED_HARNESS','AGENT_CALCULATOR','AGENT_REGISTERED_FEEDBACK','AGENT_HARNESS_CONTRACTS','AGENT_HARNESS_TRACE','AGENT_HARNESS_CONTINUITY','AGENT_DIAGNOSIS_V2','AGENT_DIAGNOSIS_EVIDENCE','AGENT_DIAGNOSIS_CEX','AGENT_REPAIR_CEX','AGENT_REPAIR_ROUTING','AGENT_RESAMPLE','AGENT_RESAMPLE_PREFETCH'])if(env[key]!==undefined&&!['0','1'].includes(env[key]))throw new Error(key+' must be 0 or 1');
  if(env.AGENT_RESAMPLE_PARALLEL!==undefined&&!/^[12]$/.test(env.AGENT_RESAMPLE_PARALLEL))throw new Error('AGENT_RESAMPLE_PARALLEL must be 1 or 2');
  if(env.AGENT_MAIN_PARALLEL!==undefined&&!/^[12]$/.test(env.AGENT_MAIN_PARALLEL))throw new Error('AGENT_MAIN_PARALLEL must be 1 or 2');
  if(env.AGENT_RESAMPLE==='1'&&env.AGENT_RESAMPLE_PARALLEL==='2'&&env.AGENT_MAIN_PARALLEL!=='2')throw new Error('Parallel resampling requires deployment parallel=2 (AGENT_MAIN_PARALLEL=2)');
  if(env.AGENT_MAIN_POOL_CONTEXT!==undefined&&!['32768','40960'].includes(env.AGENT_MAIN_POOL_CONTEXT))throw new Error('AGENT_MAIN_POOL_CONTEXT must be 32768 or 40960');
  if(env.AGENT_RESAMPLE_MAX!==undefined&&!/^[1-4]$/.test(env.AGENT_RESAMPLE_MAX))throw new Error('AGENT_RESAMPLE_MAX must be 1 to 4');
  if(env.AGENT_RESAMPLE==='1'&&env.AGENT_REPAIR_ROUTING!=='1')throw new Error('AGENT_RESAMPLE requires AGENT_REPAIR_ROUTING=1');
  if(env.AGENT_VERIFICATION!==undefined&&!['0','1'].includes(env.AGENT_VERIFICATION))throw new Error('AGENT_VERIFICATION must be 0 or 1');
  if(env.AGENT_VERIFICATION_COMPACT!==undefined&&!['0','1'].includes(env.AGENT_VERIFICATION_COMPACT))throw new Error('AGENT_VERIFICATION_COMPACT must be 0 or 1');
  if(env.AGENT_VERIFICATION_TASKS!==undefined&&!['0','1'].includes(env.AGENT_VERIFICATION_TASKS))throw new Error('AGENT_VERIFICATION_TASKS must be 0 or 1');
  if(env.AGENT_VERIFICATION_STRUCTURED!==undefined&&!['0','1'].includes(env.AGENT_VERIFICATION_STRUCTURED))throw new Error('AGENT_VERIFICATION_STRUCTURED must be 0 or 1');
  if(env.AGENT_VERIFICATION_SEMANTIC_REVIEW!==undefined&&!['0','1'].includes(env.AGENT_VERIFICATION_SEMANTIC_REVIEW))throw new Error('AGENT_VERIFICATION_SEMANTIC_REVIEW must be 0 or 1');
  if(env.AGENT_VERIFICATION_EXPRESSIONS!==undefined&&!['0','1'].includes(env.AGENT_VERIFICATION_EXPRESSIONS))throw new Error('AGENT_VERIFICATION_EXPRESSIONS must be 0 or 1');
  if(env.AGENT_VERIFICATION_BODY_RESERVE!==undefined&&!['0','1'].includes(env.AGENT_VERIFICATION_BODY_RESERVE))throw new Error('AGENT_VERIFICATION_BODY_RESERVE must be 0 or 1');
  if(env.AGENT_VERIFICATION_BUDGET_SCHEDULE!==undefined&&!['0','1'].includes(env.AGENT_VERIFICATION_BUDGET_SCHEDULE))throw new Error('AGENT_VERIFICATION_BUDGET_SCHEDULE must be 0 or 1');
  if(env.AGENT_VERIFICATION_POST_RESERVE_MS!==undefined&&!/^[1-9]\d*$/.test(env.AGENT_VERIFICATION_POST_RESERVE_MS))throw new Error('AGENT_VERIFICATION_POST_RESERVE_MS must be a positive integer');
  if(env.AGENT_VERIFICATION_RAG!==undefined&&!['off','vector'].includes(env.AGENT_VERIFICATION_RAG))throw new Error('AGENT_VERIFICATION_RAG must be off or vector');
  if(env.AGENT_DIAGNOSIS_RAG!==undefined&&!['off','vector'].includes(env.AGENT_DIAGNOSIS_RAG))throw new Error('AGENT_DIAGNOSIS_RAG must be off or vector');
  if(env.AGENT_VERIFICATION==='1'&&env.AGENT_SELF_TEST==='off')throw new Error('Verification requires self-tests enabled');
  for(const key of ['AGENT_AUTHOR_CONTROL','AGENT_PHASE_DRY','AGENT_CONVERGENCE'])if(env[key]!==undefined&&!['0','1'].includes(env[key]))throw new Error(key+' must be 0 or 1');
  if(env.AGENT_GENERATION_ONLY!==undefined&&!['0','1'].includes(env.AGENT_GENERATION_ONLY))throw new Error('AGENT_GENERATION_ONLY must be 0 or 1');
  if(env.AGENT_EARLY_HANDOFF!==undefined&&!['0','1'].includes(env.AGENT_EARLY_HANDOFF))throw new Error('AGENT_EARLY_HANDOFF must be 0 or 1');
  if(env.AGENT_NL2SPEC!==undefined&&!['0','1'].includes(env.AGENT_NL2SPEC))throw new Error('AGENT_NL2SPEC must be 0 or 1');
  if(env.AGENT_COMPACT_PLANNER!==undefined&&!['0','1'].includes(env.AGENT_COMPACT_PLANNER))throw new Error('AGENT_COMPACT_PLANNER must be 0 or 1');
  if(env.AGENT_PLANNING_RAG!==undefined&&!['off','vector'].includes(env.AGENT_PLANNING_RAG))throw new Error('AGENT_PLANNING_RAG must be off or vector');
  for(const name of ['AGENT_RAG','AGENT_RTL_PRECHECK'])if(env[name]&&env[name]!=='off')throw new Error('Phase 1 does not enable '+name);
  if(env.AGENT_DIAGNOSTIC_ROLE==='1'||env.AGENT_SELF_TEST&&!['off','templates'].includes(env.AGENT_SELF_TEST))throw new Error('Phase 1 uses frozen template self-checks, not legacy model diagnostics');
  if(!env.PLANNER_CONFIG)throw new Error('PLANNER_CONFIG must identify the separately configured Qwen 27B');
  // Fixed author sampling policy; do not change the separate planner or official baseline.
  if(env.LLM_TEMPERATURE!==undefined&&Number(env.LLM_TEMPERATURE)!==1)throw new Error('Phase 1 requires author LLM_TEMPERATURE=1.0');
  const base=runtimeConfig({...env,AGENT_RAG:'off',AGENT_RTL_PRECHECK:'off',AGENT_DIAGNOSTIC_ROLE:'0',AGENT_SELF_TEST:env.AGENT_SELF_TEST??'templates',LLM_MAX_TOKENS:env.LLM_MAX_TOKENS??'12288',LLM_TEMPERATURE:'1.0',MAX_MODEL_LEN:env.MAX_MODEL_LEN??String(PLANNER_AUTHOR_CONTEXT)});
  const auxModel=JSON.parse(await readFile(path.resolve(env.PLANNER_CONFIG),'utf8'));
  // New Agent configurations keep the user's 0.8 policy even when an old
  // planner file contains 0.2. Historical studies must opt in explicitly;
  // never inherit author/baseline sampling or rewrite a frozen planner file.
  const plannerTemperature=env.PLANNER_TEMPERATURE??'0.8';
  const temperature=Number(plannerTemperature);
  if(!plannerTemperature.trim()||!Number.isFinite(temperature)||temperature<0||temperature>2)throw new Error('PLANNER_TEMPERATURE must be a number from 0 to 2');
  auxModel.temperature=temperature;
  // Sized from successfully transmitted requests (the 068 pre-send overflow was
  // omitted in that audit; oversized observation tables now use bounded excerpts).
  // Original 2026-10-26 audit of archived
  // captures): 27B max input ~11.4k + 6144 output -> 20480; 8B max input ~7.9k +
  // 12288 output -> 24576 (also > baseline prompt + 16384). The freed VRAM lets
  // a DSpark draft fit under the 32e9-byte guard. Override with PLANNER_CONTEXT.
  const plannerContext=Number(env.PLANNER_CONTEXT??PLANNER_AUX_CONTEXT);
  if(!Number.isSafeInteger(plannerContext)||plannerContext<=(auxModel.maxTokens??0)||plannerContext>32768)throw new Error('PLANNER_CONTEXT must exceed the planner maxTokens and be at most 32768');
  auxModel.contextWindow=plannerContext;
  const identity={path:env.MODEL_PATH??null,revision:env.MAIN_MODEL_REVISION??null,sha256:env.MAIN_MODEL_SHA256??null,quantization:'Q6_K'};
  const dual=normalizeDual({plannerPhase1:true,plannerCompact:env.AGENT_COMPACT_PLANNER==='1',authorGenerationOnly:env.AGENT_GENERATION_ONLY==='1',earlyHandoff:env.AGENT_EARLY_HANDOFF==='1',plannerNl2spec:env.AGENT_NL2SPEC==='1',protocolVersion:'rtl2llm.v2',mainModel:{...structuredClone(base.model),identity,...(env.AGENT_MAIN_PARALLEL==='2'?{deploymentParallel:2,...(env.AGENT_MAIN_POOL_CONTEXT==='32768'?{sharedPoolContext:32768}:{})}:{})},auxModel,
    enableSpecAnalysis:true,enablePostReview:true,enableIssuePackages:true,enableRepairReview:true,knowledge:{mode:'off'},
    harness:{enabled:env.AGENT_UNIFIED_HARNESS==='1',calculator:env.AGENT_CALCULATOR!=='0',contracts:env.AGENT_HARNESS_CONTRACTS==='1',trace:env.AGENT_HARNESS_TRACE==='1',continuity:env.AGENT_HARNESS_CONTINUITY==='1',diagnosisV2:env.AGENT_DIAGNOSIS_V2==='1',diagnosisEvidence:env.AGENT_DIAGNOSIS_EVIDENCE==='1',diagnosisCex:env.AGENT_DIAGNOSIS_CEX==='1',repairCex:env.AGENT_REPAIR_CEX==='1',repairRouting:env.AGENT_REPAIR_ROUTING==='1',...(env.AGENT_RESAMPLE==='1'?{resample:{enabled:true,max:Number(env.AGENT_RESAMPLE_MAX??2),parallel:Number(env.AGENT_RESAMPLE_PARALLEL??1),...(env.AGENT_RESAMPLE_PREFETCH==='1'?{prefetch:true}:{})}}:{})},
    authorControl:{enabled:env.AGENT_AUTHOR_CONTROL==='1',dry:env.AGENT_PHASE_DRY!=='0',convergence:env.AGENT_CONVERGENCE!=='0',directory:env.RTL_AUTHOR_CONTROL_DIR??null},
    verification:{enabled:env.AGENT_VERIFICATION==='1',compact:env.AGENT_VERIFICATION_COMPACT==='1',tasks:env.AGENT_VERIFICATION_TASKS==='1',structured:env.AGENT_VERIFICATION_STRUCTURED==='1',semanticReview:env.AGENT_VERIFICATION_SEMANTIC_REVIEW==='1',expressions:env.AGENT_VERIFICATION_EXPRESSIONS===undefined?env.AGENT_VERIFICATION_TASKS==='1':env.AGENT_VERIFICATION_EXPRESSIONS==='1',bodyReserve:env.AGENT_VERIFICATION_BODY_RESERVE==='1',budgetSchedule:env.AGENT_VERIFICATION_BUDGET_SCHEDULE==='1',postReserveMs:env.AGENT_VERIFICATION_POST_RESERVE_MS===undefined?null:Number(env.AGENT_VERIFICATION_POST_RESERVE_MS)},
    verificationKnowledge:env.AGENT_VERIFICATION_RAG==='vector'?{mode:'vector',path:path.resolve(env.VERIFICATION_KNOWLEDGE_INDEX??''),sha256:env.VERIFICATION_KNOWLEDGE_SHA256,endpoint:env.PLANNING_EMBEDDING_ENDPOINT??'http://127.0.0.1:18085'}:{mode:'off'},
    planningKnowledge:env.AGENT_PLANNING_RAG==='vector'?{mode:'vector',path:path.resolve(env.PLANNING_KNOWLEDGE_INDEX??''),sha256:env.PLANNING_KNOWLEDGE_SHA256,endpoint:env.PLANNING_EMBEDDING_ENDPOINT??'http://127.0.0.1:18085'}:{mode:'off'},
    diagnosisKnowledge:env.AGENT_DIAGNOSIS_RAG==='vector'?{mode:'vector',path:path.resolve(env.DIAGNOSIS_KNOWLEDGE_INDEX??''),sha256:env.DIAGNOSIS_KNOWLEDGE_SHA256,endpoint:env.PLANNING_EMBEDDING_ENDPOINT??'http://127.0.0.1:18085'}:{mode:'off'},
    repairMode:'local_first',maxRepairAttempts:env.AGENT_DIAGNOSIS_V2==='1'||env.AGENT_REPAIR_CEX==='1'?4:base.agent.maxRepairs,totalTimeoutMs:base.agent.totalTimeoutMs,
    analyzeTimeoutMs:180000,reviewTimeoutMs:150000,mainTimeoutMs:600000,toolTimeoutMs:180000,
    retryNormalEmpty:true,regenerateWithoutRtl:true},base.model);
  // Remains opt-in pending the user's offline replay acceptance. No call cap,
  // model setting or deadline changes accompany this routing-only switch.
  if(env.AGENT_REPAIR_FALLBACKS==='1'){
    if(!dual.harness.repairRouting||!dual.harness.repairCex)throw new Error('AGENT_REPAIR_FALLBACKS requires AGENT_REPAIR_ROUTING=1 and AGENT_REPAIR_CEX=1');
    dual.harness.repairFallbacks=true;
  }
  // 27B diagnoses each functional counterexample before the 8B repairs; the
  // counterexample-only 8B repair remains as the follow-up attempt.
  if(env.AGENT_REPAIR_DIAGNOSIS_FIRST==='1'){
    if(!dual.harness.repairRouting||!dual.harness.repairCex)throw new Error('AGENT_REPAIR_DIAGNOSIS_FIRST requires AGENT_REPAIR_ROUTING=1 and AGENT_REPAIR_CEX=1');
    dual.harness.repairDiagnosisFirst=true;
  }
  return {...base,workflowMode:'planner_v1',dual};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  if(process.argv.length!==3)throw new Error('Usage: create-planner-config.mjs <new-output.json>');
  const output=path.resolve(process.argv[2]);await mkdir(path.dirname(output),{recursive:true});
  await writeFile(output,JSON.stringify(await plannerRuntimeConfig(),null,2)+'\n',{mode:0o600,flag:'wx'});
}
