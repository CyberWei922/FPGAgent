import {setTimeout as pause} from 'node:timers/promises';
import {ModelGenerationError} from '../model.mjs';

// Official llama.cpp /slots monitoring only. A closed HTTP client is not proof
// of backend quiescence. This experiment requires its existing dedicated slot.
export async function waitForInferenceIdle(model,{signal,deadline,timeoutMs=5000,pollMs=100}={}) {
  const expected=model.deploymentParallel??1;
  if(![1,2].includes(expected))throw new ModelGenerationError('MODEL_CLEANUP_UNCONFIRMED','Invalid deployment slot count');
  const until=Math.min(deadline??Infinity,Date.now()+timeoutMs);
  const url=new URL('/slots',model.baseUrl);
  if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||!['http:','https:'].includes(url.protocol)||url.username||url.password)
    throw new ModelGenerationError('MODEL_CLEANUP_UNCONFIRMED','Local single-slot monitoring required.');
  const key=model.apiKeyEnv?process.env[model.apiKeyEnv]:model.apiKey;
  let consecutive=0,polls=0;
  while(Date.now()<until&&!signal?.aborted) {
    try {
      const timeout=AbortSignal.timeout(Math.max(1,Math.min(1000,until-Date.now())));
      const combined=signal?AbortSignal.any([signal,timeout]):timeout;
      const response=await fetch(url,{signal:combined,redirect:'error',headers:key?{Authorization:'Bearer '+key}:{}});
      if(!response.ok){await response.body?.cancel();throw new Error('Slots unavailable');}
      const slots=await response.json();polls++;
      if(!Array.isArray(slots)||slots.length!==expected||new Set(slots.map(s=>s.id)).size!==expected||slots.some(s=>!Number.isInteger(s.id)||typeof s.is_processing!=='boolean'))
        throw new Error('Dedicated single slot required');
      consecutive=slots.some(s=>s.is_processing)?0:consecutive+1;
      if(consecutive>=2)return {confirmed:true,scope:expected===1?'llama_single_slot_idle':'llama_all_slots_idle',polls};
    } catch {consecutive=0;}
    const remaining=until-Date.now();if(remaining<=0)break;
    try{await pause(Math.min(pollMs,remaining),undefined,{signal});}catch{break;}
  }
  throw new ModelGenerationError(signal?.aborted?'MODEL_ABORTED':'MODEL_CLEANUP_UNCONFIRMED',
    'Inference idle could not be confirmed; no subsequent model request is allowed.');
}
