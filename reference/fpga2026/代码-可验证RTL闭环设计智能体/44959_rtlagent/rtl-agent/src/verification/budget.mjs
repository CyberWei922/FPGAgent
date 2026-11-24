import {invariant} from '../dual/snapshot.mjs';

export const VERIFICATION_BUDGET_VERSION='verification-budget.v1';
// Approved 54-task cohort, nearest-rank p90: (134347 + 229373) * 1.2
// = 436464 ms; user-required floor 472000 ms. See H report / analyze.py.
export const VERIFICATION_POST_RESERVE_MS=472000;
export const VERIFICATION_BANDS=Object.freeze({
  simple:Object.freeze({maxTokens:4096,timeoutMs:120000}),
  normal:Object.freeze({maxTokens:6144,timeoutMs:150000}),
  hard:Object.freeze({maxTokens:8192,timeoutMs:210000}),
});
export const VERIFICATION_CALL_FLOOR=1536;
export function verificationTier(plan){
  if(plan?.difficulty==='complex'||plan?.timing_risk==='high')return 'hard';
  return plan?.difficulty==='simple'&&plan?.timing_risk==='low'?'simple':'normal';
}
const parameterError=error=>['TEST_PLAN_INVALID','TEST_METHOD_INVALID'].includes(error?.code);
export function canSecondCorrection({tier,corrections,error,remainingMs,remainingTokens,reserveReview}){
  return tier!=='simple'&&corrections===1&&parameterError(error)&&remainingMs>=45000&&remainingTokens>=VERIFICATION_CALL_FLOOR*(reserveReview?2:1);
}
// deadline is already clipped to taskDeadline minus the explicitly approved
// downstream reserve. This allocator can only shorten its own stage.
export function createVerificationBudget({plan,startedAt,deadline,maxTokens,reserveReview=false,now=Date.now}){
  invariant(Number.isFinite(deadline)&&Number.isFinite(startedAt)&&Number.isSafeInteger(maxTokens)&&maxTokens>=3072,'TEST_PLAN_INVALID','Invalid scheduled verification limits');
  const initialTier=verificationTier(plan),available=deadline-startedAt;
  const fit=tier=>{
    if(tier==='hard'&&available<VERIFICATION_BANDS.hard.timeoutMs)tier='normal';
    if(tier==='normal'&&available<VERIFICATION_BANDS.normal.timeoutMs)tier='simple';
    return tier;
  };
  let tier=fit(initialTier),outputTokens=0,escalated=false,reason=null;
  const total=()=>Math.min(maxTokens,VERIFICATION_BANDS[tier].maxTokens);
  const end=()=>Math.min(deadline,startedAt+VERIFICATION_BANDS[tier].timeoutMs);
  return {
    initialTier,get tier(){return tier;},get deadline(){return end();},get totalTokens(){return total();},get outputTokens(){return outputTokens;},
    snapshot(){return {version:VERIFICATION_BUDGET_VERSION,initial_tier:initialTier,tier,escalated,escalation_reason:reason,time_downgraded:tier!==initialTier&&!escalated,model_token_cap:maxTokens,total_tokens:total(),output_tokens:outputTokens,deadline:end(),remaining_ms:Math.max(0,end()-now())};},
    request(stage,{reserveSecond=false}={}){
      invariant(end()-now()>=10000,'TEST_PLAN_INVALID','Scheduled test-task deadline exhausted; downstream reserve preserved');
      let limit=total()-outputTokens;
      if(stage==='select_method')limit-=VERIFICATION_CALL_FLOOR*(reserveReview?2:1);
      if(stage==='correct_parameters')limit-=VERIFICATION_CALL_FLOOR*((reserveReview?1:0)+(reserveSecond?1:0));
      invariant(limit>=(stage==='select_method'?512:VERIFICATION_CALL_FLOOR),'MODEL_CALL_LIMIT','Scheduled call or review floor unavailable');
      return {maxTokens:limit,deadline:end()};
    },
    record(stage,result,limit,durationMs=0){
      const usage=result?.usage?.output??result?.usage?.outputTokens;
      // Missing server usage consumes the entire allowance, never a guessed
      // character/token conversion that could silently replenish the budget.
      const used=Number.isSafeInteger(usage)&&usage>=0?usage:limit;
      outputTokens+=used;
      if(stage==='select_method'&&(result?.code==='MODEL_TRUNCATED'||result?.stopReason==='length'||used>=limit*.8||durationMs>=VERIFICATION_BANDS[tier].timeoutMs*.7)){
        escalated=true;reason=result?.code==='MODEL_TRUNCATED'||result?.stopReason==='length'?'selection_truncated':used>=limit*.8?'selection_usage_80_percent':'selection_time_70_percent';tier=fit('hard');
      }
    },
  };
}
