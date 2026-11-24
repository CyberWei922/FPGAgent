import {invariant,sha256} from '../dual/snapshot.mjs';

// References identify immutable lines, never permission to edit a byte range.
export function codeCatalog(rtl){
  return Object.fromEntries(rtl.split('\n').map((text,i)=>['C'+(i+1),{start_line:i+1,end_line:i+1,text,text_sha256:sha256(text)}]));
}
export function resolveLocations(rtl,refs){
  const catalog=codeCatalog(rtl);
  invariant(Array.isArray(refs)&&refs.length<=12&&new Set(refs).size===refs.length,'AUX_PROTOCOL_INVALID','At most twelve unique code locations');
  return refs.map(ref=>{
    invariant(/^C[1-9]\d*$/.test(ref)&&catalog[ref]?.text.trim(),'AUX_PROTOCOL_INVALID','Unknown or empty current code location');
    const {text,...location}=catalog[ref];return location;
  });
}
export function relocateLocations(oldRtl,newRtl,locations=[]){
  if(!locations.length)return {status:'needs_recheck',locations:[],reason:'No line anchor; current semantic review must locate the issue.'};
  const old=oldRtl.split('\n'),next=newRtl.split('\n'),mapped=[];
  for(const location of locations){
    const text=old.slice(location.start_line-1,location.end_line).join('\n');
    invariant(sha256(text)===location.text_sha256,'STALE_SNAPSHOT','Historical code location no longer matches its origin');
    // A unique unchanged fragment gives a conservative relocation. Duplicate
    // fragments, changed bodies and deleted anchors require semantic recheck.
    const find=lines=>lines.flatMap((_,i)=>lines.slice(i,i+location.end_line-location.start_line+1).join('\n')===text?[i]:[]);
    const before=find(old),after=find(next);
    if(before.length!==1||after.length!==1)return {status:'needs_recheck',locations:[],reason:'Changed, missing or non-unique original fragment.'};
    mapped.push({...location,start_line:after[0]+1,end_line:after[0]+1+location.end_line-location.start_line});
  }
  return {status:'mapped_requires_review',locations:mapped,reason:'Unique unchanged text; applicability and dependencies still need current evidence review.'};
}
