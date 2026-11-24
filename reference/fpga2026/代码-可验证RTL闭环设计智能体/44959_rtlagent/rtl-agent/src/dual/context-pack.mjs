import { envelope, validateMessage } from './contracts.mjs';
import { id, invariant, sha256 } from './snapshot.mjs';

export function buildRepairPackage({base,review,index,spec,interfaceText='',taskId,constraints=[],evidence=[],expanded=false,maxBytes=100000,knowledge,pendingIssues=[]}) {
  invariant(index.ok && index.sha256===base.sha256,'DEPENDENCY_UNRESOLVED',index.error?.message);
  invariant(review.payload.candidate_sha256===base.sha256,'STALE_SNAPSHOT');
  const issues=review.payload.issues.filter(i=>i.category!=='checker');
  invariant(issues.length&&!issues.some(i=>['global','unknown'].includes(i.scope)),'DEPENDENCY_UNRESOLVED','Global or unknown diagnosis');
  const ids=new Set(issues.flatMap(i=>i.unit_ids));
  invariant(ids.size,'DEPENDENCY_UNRESOLVED','No safe edit location');
  if(expanded) {
    const related=new Set(index.units.filter(u=>ids.has(u.unit_id)).flatMap(u=>u.identifiers));
    for(const u of index.units) if(u.identifiers.some(n=>related.has(n)))ids.add(u.unit_id);
  }
  invariant(ids.size<=8,'DEPENDENCY_UNRESOLVED','More than 8 associated units');
  const units=[...ids].map(i=>{const u=index.units.find(u=>u.unit_id===i);invariant(u,'UNKNOWN_UNIT');return u;});
  // Include every untouched byte, including inter-unit comments. This explicitly
  // preserves cross-cycle read/write relationships without claiming a minimal
  // semantic slice. Failure to fit sends the controller to whole regeneration.
  const bytes=Buffer.from(base.rtl);let start=0;const readonly_context=[];
  for(const u of [...units].sort((a,b)=>a.start_byte-b.start_byte)) {
    if(start<u.start_byte)readonly_context.push({text:bytes.subarray(start,u.start_byte).toString(),reason:'Unmodified original source: declarations, readers/writers, states, clock/reset and ordering; preserve exactly.'});
    start=u.end_byte;
  }
  if(start<bytes.length)readonly_context.push({text:bytes.subarray(start).toString(),reason:'Unmodified remainder of original candidate including module boundary.'});
  const p={package_id:id('package'),candidate_id:base.id,base_sha256:base.sha256,mode:expanded?'expanded':'local',spec_text:spec,interface_text:interfaceText,
    issue_ids:issues.map(i=>i.id),diagnosis:issues.map(i=>`${i.explanation} Goal: ${i.repair_goal}`).join('\n'),evidence,
    editable_units:units.map(({unit_id,kind,start_byte,end_byte,old_sha256,old_text})=>({unit_id,kind,start_byte,end_byte,old_sha256,old_text})),
    readonly_context,must_preserve:['Preserve the top-level ports, widths, signedness and specified timing.','Every byte outside editable units must remain unchanged. Do not modify checker/test code.','Do not add or remove signals unless their declarations and every affected driver/reader are authorized in this transaction.',...constraints.map(c=>`Specification-derived advisory constraint ${c.id}: ${c.claim} Source (${c.source}): ${c.quote}`)]};
  if(review.protocol==='rtl2llm.v2')Object.assign(p,{constraints,pending_issues:pendingIssues,...(knowledge?{knowledge}:{})});
  const req=envelope('repair_request',id('repair'),taskId,p,review.protocol);
  validateMessage(req,undefined,{snapshot:base,review});
  invariant(Buffer.byteLength(JSON.stringify(req))<=maxBytes,'CONTEXT_OVERFLOW','Complete dependency context does not fit; no truncation');
  return req;
}
