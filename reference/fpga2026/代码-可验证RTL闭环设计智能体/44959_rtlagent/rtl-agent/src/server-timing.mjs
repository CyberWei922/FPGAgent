// Observe numeric llama.cpp metrics without changing the provider's streaming bytes.
const keys=['cache_n','prompt_n','prompt_ms','prompt_per_second','predicted_n','predicted_ms','predicted_per_second','draft_n','draft_n_accepted'];
export function numericServerTiming(value) {
  if(!value || typeof value!=='object' || Array.isArray(value))return null;
  const result=Object.fromEntries(keys.filter(k=>Number.isFinite(value[k])&&value[k]>=0).map(k=>[k,value[k]]));
  return Number.isFinite(result.prompt_ms)&&Number.isFinite(result.predicted_ms) ? result : null;
}
export function observeServerTiming(response,onTiming) {
  if(!response.body || !response.headers.get('content-type')?.includes('text/event-stream'))return response;
  const decoder=new TextDecoder();let pending='';
  const consume=chunk=>{
    pending+=decoder.decode(chunk,{stream:true});
    const lines=pending.split('\n');pending=lines.pop();
    for(const line of lines){
      if(!line.startsWith('data:'))continue;
      try{const timing=numericServerTiming(JSON.parse(line.slice(5).trim()).timings);if(timing)onTiming(timing);}catch{/* unrelated SSE event */}
    }
    if(pending.length>262144)pending='';
  };
  return new Response(response.body.pipeThrough(new TransformStream({transform(chunk,controller){consume(chunk);controller.enqueue(chunk);}})),
    {status:response.status,statusText:response.statusText,headers:response.headers});
}
