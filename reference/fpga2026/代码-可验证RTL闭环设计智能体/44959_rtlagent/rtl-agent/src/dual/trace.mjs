import path from 'node:path';
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { id, sha256 } from './snapshot.mjs';

export async function createTrace({directory,taskId,deadline,protocol='rtl2llm.v1',onEvent=()=>{},append=appendFile}) {
  await mkdir(directory,{recursive:true});
  const run_id=id('run'),started=Date.now();let queue=Promise.resolve(),traceWriteFailures=0,lastTraceWriteError=null;
  const emit=(stage,status,fields={})=>{
    const event={protocol,run_id,task_id:taskId,event_id:id('event'),stage,request_id:null,candidate_id:null,parent_id:null,
      candidate_sha256:null,model_role:null,status,reason:null,elapsed_ms:Date.now()-started,remaining_ms:Math.max(0,deadline-Date.now()),queue_ms:null,...fields};
    queue=queue.then(()=>append(path.join(directory,'events.jsonl'),JSON.stringify(event)+'\n'))
      .catch(error=>{traceWriteFailures++;lastTraceWriteError=error?.code??'WRITE_FAILED';});
    // Observers cannot mutate controller input/decisions or prolong a call.
    try{Promise.resolve(onEvent(structuredClone(event))).catch(()=>{});}catch{}
    return event;
  };
  const save=async(name,value)=>{
    const file=path.join(directory,`${id(name)}.json`),text=JSON.stringify(value,null,2)+'\n';
    await writeFile(file,text,{flag:'wx',mode:0o600});return {file:path.relative(directory,file),path_scope:'run_directory',sha256:sha256(text)};
  };
  return {run_id,emit,save,flush:async()=>{await queue;return {failures:traceWriteFailures,lastError:lastTraceWriteError};}};
}
