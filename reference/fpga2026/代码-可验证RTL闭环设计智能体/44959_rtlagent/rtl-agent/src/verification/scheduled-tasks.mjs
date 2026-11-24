import {invariant} from '../dual/snapshot.mjs';
import {parseCompactVerification} from './compact.mjs';
import {testMethodRequest,compileTestMethod,reusableTestFacts,TEST_METHOD_ENVELOPE_SCHEMA} from './methods.mjs';
import {eligibleMethods} from './registry.mjs';
import {needsSemanticReview,semanticReviewRequest,applySemanticReview} from './workflow.mjs';
import {createVerificationBudget,canSecondCorrection,VERIFICATION_CALL_FLOOR} from './budget.mjs';

export async function runScheduledVerificationTasks(args,ctx,{invoke,maxTokens,structured,semanticReview,version}){
  const combEligible=eligibleMethods(args).includes('comb_expr');
  const reserveReview=semanticReview||combEligible;
  const budget=createVerificationBudget({plan:args.semanticPlan,startedAt:ctx.verificationStartedAt??Date.now(),deadline:ctx.deadline,maxTokens,reserveReview});
  let calls=0,corrections=0,result,raw,compiled;
  const saveBudget=()=>ctx.saveRecord?.('verification-budget-schedule',budget.snapshot());
  await saveBudget();
  await ctx.saveRecord?.('verification-plan-reuse',{accepted:Boolean(reusableTestFacts(args.semanticPlan,args.task)),structured});
  const ask=async(stage,request,{reserveSecond=false}={})=>{
    ctx.signal?.throwIfAborted();
    invariant(calls<(reserveReview?4:3),'MODEL_CALL_LIMIT','Scheduled test-task call limit');
    const allocation=budget.request(stage,{reserveSecond});
    if(stage==='select_method'&&combEligible)allocation.maxTokens=Math.min(3072,allocation.maxTokens);
    if(calls)await ctx.reserveAuxCall?.({stage:'plan_test_'+stage,round:calls});
    calls++;
    await ctx.saveRecord?.('verification-task-start',{version,stage,calls,deadline:allocation.deadline,output_reserve:allocation.maxTokens,thinking:'low',dry:false,...budget.snapshot()});
    const constrained=typeof structured==='object'?Boolean(structured[stage==='review_semantics'?'review':'selection']):structured;
    const started=Date.now();
    try{
      const response=await invoke(request,{...ctx,deadline:allocation.deadline,verificationPlan:true,verificationScheduled:true,verificationMaxTokens:allocation.maxTokens,verificationThinking:'low',...(constrained?{verificationSchema:request.schema??TEST_METHOD_ENVELOPE_SCHEMA}:{})});
      const durationMs=Date.now()-started;
      budget.record(stage,response,allocation.maxTokens,durationMs);await ctx.saveRecord?.('verification-task-output',{stage,...response,duration_ms:durationMs});await saveBudget();
      invariant(Date.now()<allocation.deadline&&!ctx.signal?.aborted,'TEST_PLAN_INVALID','Scheduled call returned after its deadline');
      return response;
    }catch(error){
      // invoke throws for length; account for the real partial response exactly
      // once and expose it only to the already authorized parameter correction.
      if(error.code==='MODEL_TRUNCATED'){
        budget.record(stage,error,allocation.maxTokens,Date.now()-started);
        await ctx.saveRecord?.('verification-task-output',{stage,code:error.code,stopReason:error.stopReason??'length',usage:error.usage??null,text:String(error.text??''),duration_ms:Date.now()-started});await saveBudget();
      }
      throw error;
    }
  };
  let failure;
  try{
    result=await ask('select_method',testMethodRequest(args));raw=parseCompactVerification(result.text);compiled=compileTestMethod(raw,args);
  }catch(error){
    if(error.code!=='MODEL_TRUNCATED'&&!['TEST_PLAN_INVALID','TEST_METHOD_UNSUPPORTED'].includes(error.code))throw error;
    failure=error;
    if(error.code==='MODEL_TRUNCATED')result={text:String(error.text??'')};
  }
  while(failure){
    ctx.signal?.throwIfAborted();
    await ctx.saveRecord?.('verification-task-rejected',{code:failure.code,message:failure.message,corrections});
    if(failure.code==='TEST_METHOD_UNSUPPORTED'){
      compiled={value:{schema_version:2,status:'unsupported',reason:'Unimplemented check method: '+String(raw?.method??'unknown').slice(0,100)},calculations:[],coverage:{kind:'unsupported',failure_class:'capability_gap',requested_method:String(raw?.method??'unknown').slice(0,100)}};
      break;
    }
    if(corrections&&(raw&&Object.hasOwn(raw,'reason')||!canSecondCorrection({tier:budget.tier,corrections,error:failure,remainingMs:budget.deadline-Date.now(),remainingTokens:budget.totalTokens-budget.outputTokens,reserveReview})))throw failure;
    const remaining=budget.totalTokens-budget.outputTokens;
    const reserveSecond=corrections===0&&budget.tier!=='simple'&&budget.deadline-Date.now()>=45000&&remaining>=VERIFICATION_CALL_FLOOR*(reserveReview?3:2);
    // Additional correction is permitted only after a completed parameter
    // error. Truncation/network/timeout on the first correction propagates.
    const request=testMethodRequest({...args,feedback:String(failure.message),draft:raw??String(result?.text??'').slice(0,4000)});
    result=await ask('correct_parameters',request,{reserveSecond});corrections++;
    try{raw=parseCompactVerification(result.text);compiled=compileTestMethod(raw,args);failure=null;}
    catch(error){failure=error;}
  }
  if(compiled.value.status==='ready'&&(raw.method==='comb_expr'||semanticReview&&needsSemanticReview(raw))){
    try{
      result=await ask('review_semantics',semanticReviewRequest(args,raw));
      invariant(Date.now()<budget.deadline&&!ctx.signal?.aborted,'TEST_PLAN_INVALID','Semantic review deadline exhausted');
      const review=parseCompactVerification(result.text);compiled=applySemanticReview(raw,review,args);
      await ctx.saveRecord?.('verification-semantic-review',review);
    }catch(error){
      ctx.signal?.throwIfAborted();
      await ctx.saveRecord?.('verification-semantic-review-unavailable',{code:error.code,message:error.message});
      compiled={value:{schema_version:2,status:'unsupported',reason:'High-risk semantic review unavailable: '+(error.code??'INVALID_REVIEW')},calculations:[],coverage:{kind:'unsupported',semantic_correctness:'unconfirmed'}};
    }
  }
  await ctx.saveRecord?.('verification-task-calculations',compiled.calculations);
  await ctx.saveRecord?.('verification-task-coverage',compiled.coverage??{kind:'unsupported'});
  return {...result,value:compiled.value,taskSummary:{version,calls,outputTokens:budget.outputTokens,coverage:compiled.coverage??null,budget:{...budget.snapshot(),corrections,second_correction:corrections===2}}};
}
