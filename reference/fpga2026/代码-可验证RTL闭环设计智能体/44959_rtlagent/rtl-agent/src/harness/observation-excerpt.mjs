import {currentObservation,readableObservation} from './diagnosis-evidence.mjs';

// Only derived request views are clipped. Immutable evidence/catalog files retain
// the full validated table and its original identity and comparison counts.
export function excerptObservations(render,sources,radius=16,tail=8){
  let prompt=render.prompt;const records=[];
  for(const {evidence,rtl} of sources??[]){
    const o=currentObservation(evidence,rtl);if(o.status!=='complete')continue;
    const lines=o.view.table.split('\n'),first=o.trace.mismatches[0]?.step??0;
    const keep=new Set([Math.max(0,first-1),first]);
    for(let i=Math.max(0,first-radius);i<=Math.min(lines.length-1,first+radius);i++)keep.add(i);
    for(let i=Math.max(0,lines.length-tail);i<lines.length;i++)keep.add(i);
    if(keep.size>=lines.length)continue;
    const indexes=[...keep].sort((a,b)=>a-b),summary={truncated:true,total_rows:lines.length,delivered_rows:indexes.length,total_mismatches:o.trace.failures,first_mismatch_step:first,retained_steps:indexes,notice:'TRUNCATED observation excerpt; omitted rows remain in the full evidence file. Expected values remain hypotheses.'};
    const table=indexes.map(i=>lines[i]).join('\n');
    const excerpt={status:'excerpt',...summary,metadata:{...o.view.metadata,complete:false},columns:o.view.columns,table};
    const raw=evidence.observation,readable=readableObservation(evidence,rtl);
    const alternatives=[[readable,JSON.stringify(summary)+'\n'+JSON.stringify(excerpt.metadata)+'\n'+o.view.columns.join('\t')+'\n'+table],[raw,JSON.stringify(excerpt)],[JSON.stringify(raw).slice(1,-1),JSON.stringify(JSON.stringify(excerpt)).slice(1,-1)]];
    let replaced=false;
    for(const [full,bounded] of alternatives)if(full&&prompt.includes(full)){prompt=prompt.replaceAll(full,bounded);replaced=true;}
    if(replaced)records.push(summary);
  }
  if(records.length)prompt=prompt.replaceAll('no omitted steps','bounded excerpt; omitted rows saved in evidence').replaceAll('complete_history_follows":true','complete_history_follows":false').replaceAll('Full history follows','Bounded history excerpt follows').replaceAll('The full table follows with every row','A truncated table excerpt follows').replaceAll('Full history and original requirements are already supplied above','A bounded history excerpt and original requirements are supplied above');
  return {render:{...render,prompt},records};
}
export async function fitObservationRequest(render,sources,check){
  try{await check(render);return {render,records:[]};}catch(e){if(e.code!=='CONTEXT_OVERFLOW')throw e;}
  for(const [radius,tail] of [[16,8],[8,4],[4,2],[1,0],[0,0]]){
    const out=excerptObservations(render,sources,radius,tail);
    if(!out.records.length)continue;
    try{await check(out.render);return out;}catch(e){if(e.code!=='CONTEXT_OVERFLOW')throw e;}
  }
  // Last check preserves the existing error type and forbids any HTTP call.
  const smallest=excerptObservations(render,sources,0,0);await check(smallest.render);return smallest;
}
