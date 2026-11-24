import {generateRtl,ModelGenerationError} from '../model.mjs';
import {createPlannerClients} from '../planner/clients.mjs';
import {controlledAuthor} from '../planner/author-control.mjs';
import {createEarlyHandoff} from '../planner/early-handoff.mjs';
import {extractAuthorRtl} from '../planner/author-output.mjs';
import {waitForInferenceIdle} from '../planner/inference-idle.mjs';
import {sha256,invariant} from './snapshot.mjs';

// Capture the real initial author's system/Markdown/model after context fitting.
// Replaying that input avoids rendering subsequent evidence/history into it.
export function createResamplePlannerClients(config,generate=generateRtl){
  let batch=false,plan,capturing=false,first=null,initialTask=null,firstPlan=null;
  const actualGenerate=async args=>{
    if(capturing&&!first){
      first={model:structuredClone(args.model),systemPrompt:args.systemPrompt,prompt:args.prompt,thinkingLevel:args.thinkingLevel};
      firstPlan=plan?structuredClone(plan):null;
    }
    return generate(args);
  };
  const clients=createPlannerClients(config,actualGenerate);
  const setPlan=clients.setPlan,generateComplete=clients.generateComplete;
  return {...clients,
    setPlan:value=>{plan=value;return setPlan?.(value);},
    generateComplete:async(task,constraints,ctx)=>{
      const isInitial=!first&&!task.previousCandidate;
      if(isInitial){capturing=true;initialTask=structuredClone(task);}
      try{return await generateComplete(task,constraints,ctx);}finally{if(isInitial)capturing=false;}
    },
    canResample:()=>first!==null,
    initialAuthorSeed:()=>first?.model.extraBody?.seed??1000,
    beginResampleBatch:async ctx=>{
      invariant(!batch,'OUTPUT_INVALID','Author batch already active');
      for(const service of [config.mainModel,config.auxModel].filter(Boolean))await waitForInferenceIdle(service,ctx);
      batch=true;
    },
    endResampleBatch:async ctx=>{
      try{const idle=await waitForInferenceIdle(config.mainModel,{deadline:Math.min(ctx.cleanupDeadline??ctx.deadline,Date.now()+5000)});ctx.onEvent?.({type:'resample_batch_cleanup',...idle});}
      finally{batch=false;}
    },
    regenerateResample:async({seed},ctx)=>{
      invariant(first&&initialTask,'OUTPUT_INVALID','Initial author request unavailable');
      const model=structuredClone(first.model);
      model.extraBody={...model.extraBody,seed};
      model.requestTimeoutMs=Math.max(1,Math.min(model.requestTimeoutMs??600000,ctx.deadline-Date.now()));
      const render={systemPrompt:first.systemPrompt,prompt:first.prompt};
      const stored=await ctx.saveMarkdown?.('author-handoff',render.prompt);
      if(stored)invariant(stored.text===render.prompt,'STALE_SNAPSHOT','Resample Markdown changed');
      await ctx.saveRecord?.('resample-input',{seed,system_sha256:sha256(render.systemPrompt),markdown_sha256:sha256(render.prompt),same_first_author_request:true});
      if(!batch)for(const service of [config.mainModel,config.auxModel].filter(Boolean))await waitForInferenceIdle(service,ctx);
      const candidateGate=createEarlyHandoff(initialTask);
      invariant(candidateGate,'OUTPUT_INVALID','Resample requires resolved top interface');
      let result;
      try{
        result=config.authorControl?.enabled
          ?await controlledAuthor({control:config.authorControl,model,plan:firstPlan,render,ctx,generate,candidateGate})
          :await generate({model,...render,signal:ctx.signal,thinkingLevel:first.thinkingLevel,candidateGate,onEvent:ctx.onEvent});
      }finally{
        // Independent cleanup signal: cancellation of the author must not cancel
        // the proof that the backend has stopped before the next model starts.
        if(!batch){const idle=await waitForInferenceIdle(model,{deadline:Math.min(ctx.cleanupDeadline??ctx.deadline,Date.now()+5000)});
        ctx.onEvent?.({type:'resample_cleanup',...idle});}
      }
      if(result.stopReason!=='stop'&&result.stopReason!=='handoff')throw new ModelGenerationError(result.stopReason==='length'?'MODEL_TRUNCATED':'OUTPUT_INVALID','Incomplete resample response',result);
      let extracted;
      try{extracted=extractAuthorRtl(result.text,initialTask.top);}catch(error){throw new ModelGenerationError('OUTPUT_INVALID',error.message,result);}
      if(result.stopReason==='handoff')invariant(sha256(extracted.rtl)===result.handoff?.candidate_sha256,'OUTPUT_INVALID','Captured resample changed before verification');
      return {...result,...extracted};
    }
  };
}
