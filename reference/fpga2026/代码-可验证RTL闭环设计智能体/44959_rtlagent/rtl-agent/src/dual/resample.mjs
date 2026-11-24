import {selectRoutedCandidate} from './repair-routing.mjs';
import {invariant} from './snapshot.mjs';
export const RESAMPLE_VERSION='hybrid-author-resample.v2';
export function normalizeResamplePolicy(raw,cfg){
  if(raw===undefined)return {enabled:false,max:2,parallel:1,prefetch:false};
  invariant(raw&&typeof raw==='object'&&!Array.isArray(raw)&&Object.keys(raw).every(k=>['enabled','max','parallel','prefetch'].includes(k)),'OUTPUT_INVALID','Invalid resample policy');
  const p={enabled:false,max:2,parallel:1,prefetch:false,...raw};
  invariant(typeof p.enabled==='boolean'&&typeof p.prefetch==='boolean'&&Number.isSafeInteger(p.max)&&p.max>=1&&p.max<=4&&[1,2].includes(p.parallel),'OUTPUT_INVALID','Invalid resample policy');
  invariant(!p.enabled||cfg.plannerPhase1&&cfg.harness.repairRouting,'OUTPUT_INVALID','Resampling requires planner and repair routing');
  invariant(!p.enabled||p.parallel!==2||cfg.mainModel?.deploymentParallel===2,'OUTPUT_INVALID','Parallel resampling requires a two-slot deployment');
  return p;
}
const passed=(ev,stage)=>{const c=ev?.checks?.filter(c=>c.stage===stage)??[];return c.length>0&&c.every(c=>c.status==='pass');};
export const infrastructure=ev=>ev?.infrastructure_error||ev?.checks?.some(c=>['error','timeout'].includes(c.status));
export const compileFailure=ev=>!infrastructure(ev)&&ev?.checks?.some(c=>['interface','compile'].includes(c.stage)&&c.status==='fail');
export function resamplePassed(ev,hasSelfTest=ev?.checks?.some(c=>c.stage==='simulate')){
  return !infrastructure(ev)&&['interface','compile',...(ev?.checks?.some(c=>c.stage==='lint')?['lint']:[]),...(hasSelfTest?['simulate']:[])].every(s=>passed(ev,s));
}
export const shouldResample=ev=>!infrastructure(ev)&&ev?.checks?.some(c=>['interface','compile','lint','simulate'].includes(c.stage)&&c.status==='fail');

// One batch owns cancellation and backend quiescence. Never wait for all slots
// from inside either active request: that would wait on its concurrent peer.
export async function runAuthorBatch(jobs,{begin=async()=>{},end=async()=>{},emit=()=>{},canRetry=()=>false,poolFallback=false,concurrency=2}={}){
  const abort=new AbortController();let failed=false;
  await begin();
  let results;
  try{
    const run=async(job,index)=>{
      try{return {ok:true,candidate:await job(abort.signal),index};}
      catch(error){failed=true;abort.abort();return {ok:false,error,index};}
    };
    if(concurrency===1){results=[];for(let i=0;i<jobs.length;i++){if(failed){results.push({ok:false,error:{code:"PEER_REQUEST_FAILED"},index:i});break;}results.push(await run(jobs[i],i));}}
    else results=await Promise.all(jobs.map(run));
  }finally{abort.abort();await end();}
  // Shared-pool HTTP failures can include exhaustion; response text is withheld
  // by the model adapter. Retry only failed/cancelled requests once, serially.
  if(failed&&poolFallback&&results.some(r=>!r.ok&&['MODEL_REQUEST_FAILED','POOL_EXHAUSTED'].includes(r.error.code))&&canRetry()){
    emit('resample','pool_exhausted',{classification:'shared_pool_failure_possible',failed_samples:results.filter(r=>!r.ok).map(r=>r.index+1),retry:'once_serial'});
    for(let i=0;i<results.length;i++)if(!results[i].ok){
      if(!canRetry())break;
      const retryAbort=new AbortController();await begin();
      try{results[i]={ok:true,candidate:await jobs[i](retryAbort.signal),index:i,retried:true};}
      catch(error){results[i]={ok:false,error,index:i,retried:true};}
      finally{retryAbort.abort();await end();}
    }
  }
  return results;
}
export async function runResamples({base,evidence,max=2,parallel=1,initialSeed=1000,hasSelfTest,compileRepair,canStart,generate,verify,vote,accept,emit,beginBatch,endBatch,poolFallback=false}){
  let current=base,ev=evidence;const history=[];
  const finish=(accepted=false,reason)=>({candidate:current,evidence:ev,accepted,reason,history});
  if(!shouldResample(ev)||resamplePassed(ev,hasSelfTest))return finish();
  if(compileFailure(ev)&&parallel===1)return finish();
  for(let start=1;start<=max;start+=2){
    if(!canStart()){emit('resample','stopped',{reason:'less_than_180_seconds_or_unavailable',sample:start});break;}
    const repair=compileFailure(ev)&&parallel===2&&compileRepair;
    const entries=repair?[{sample:0,kind:'compile_repair'},{sample:start,kind:'resample'}]:Array.from({length:Math.min(2,max-start+1)},(_,i)=>({sample:start+i,kind:'resample'}));
    const parent=current,old=ev;
    const jobs=entries.map(e=>async signal=>{
      emit('resample','start',{version:RESAMPLE_VERSION,...e,seed:e.kind==='resample'?initialSeed+e.sample:null});
      return e.kind==='compile_repair'?compileRepair(parent,old,signal):generate({sample:e.sample,seed:initialSeed+e.sample,signal});
    });
    const t=Date.now();
    const responses=await runAuthorBatch(jobs,{begin:beginBatch,end:endBatch,emit,canRetry:canStart,poolFallback,concurrency:parallel});
    for(const r of responses)if(!r.ok&&r.error.code==='MODEL_CLEANUP_UNCONFIRMED')throw r.error;
    if(responses.some(r=>!r.ok)){
      for(const r of responses){const row={...entries[r.index],accepted:false,reason:r.ok?'peer_request_failed':r.error.code??'OUTPUT_INVALID',duration_ms:Date.now()-t};history.push(row);emit('resample','rejected',row);}
      break;
    }
    // The persistent EDA service accepts one operation at a time. Both model
    // responses finish first, then each verification uses two CPU threads.
    const verified=[];
    for(let i=0;i<responses.length;i++){
      const r=responses[i],at=Date.now(),next=await verify(r.candidate);
      verified.push({...entries[i],candidate:r.candidate,evidence:next,verification_ms:Date.now()-at,retried:r.retried??false});
    }
    const eligible=verified.filter(r=>resamplePassed(r.evidence,hasSelfTest));
    let chosen=null,reason=null,votes=[];
    if(eligible.length){
      if(repair){chosen=eligible[0];reason=chosen.kind==='compile_repair'?'compile_pair_passed_repair_priority':'compile_pair_only_resample_passed';}
      else if(hasSelfTest){chosen=eligible[0];reason='resample_self_test_passed';}
      else if(eligible.length===1){chosen=eligible[0];reason='resample_only_eligible';}
      else{
        votes=await vote(eligible);
        const comparable=eligible.filter(e=>votes.some(v=>v.candidate_id===e.candidate.id&&v.status==='pass'));
        chosen=comparable.sort((a,b)=>{
          const count=e=>{const h=votes.find(v=>v.candidate_id===e.candidate.id)?.trace_sha256;return votes.filter(v=>v.status==='pass'&&v.trace_sha256===h).length;};
          return count(b)-count(a)||a.sample-b.sample;
        })[0];reason='resample_trace_plurality';
      }
    }
    for(const r of verified){
      const row={sample:r.sample,kind:r.kind,seed:r.kind==='resample'?initialSeed+r.sample:null,candidate_id:r.candidate.id,parent_id:r.candidate.parent_id,candidate_sha256:r.candidate.sha256,duration_ms:Date.now()-t,verification_ms:r.verification_ms,retried:r.retried,checks:r.evidence.checks.map(c=>({id:c.id,stage:c.stage,status:c.status})),accepted:chosen===r,reason:chosen===r?reason:'not_selected',votes};
      history.push(row);emit('resample',row.accepted?'accepted':'rejected',row);
    }
    if(chosen){current=chosen.candidate;ev=chosen.evidence;await accept(current,ev);return finish(true,reason);}
    for(const r of verified){const selection=selectRoutedCandidate(current,r.candidate,ev,r.evidence);if(selection.accepted){current=r.candidate;ev=r.evidence;await accept(current,ev);}emit('resample','fallback_selection',{sample:r.sample,...selection});}
    if(verified.some(r=>infrastructure(r.evidence))||repair)break;
  }
  return finish();
}
