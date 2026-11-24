import { checkRanges, validateMessage } from './contracts.mjs';
import { invariant, sha256, snapshot } from './snapshot.mjs';
import { indexUnits } from './unit-index.mjs';

export function applyReplacement(base,request,response) {
  validateMessage(request,undefined,{snapshot:base});validateMessage(response,request);
  invariant(response.payload.status==='replacement','OUTPUT_INVALID','Model declined replacement');
  const before=indexUnits(base.rtl);invariant(before.ok,'DEPENDENCY_UNRESOLVED');
  const units=request.payload.editable_units;
  checkRanges(base.rtl,units);
  for(const u of units) invariant(before.units.some(v=>v.unit_id===u.unit_id&&v.kind===u.kind&&v.start_byte===u.start_byte&&v.end_byte===u.end_byte&&v.old_sha256===u.old_sha256),'PATCH_SCOPE_VIOLATION','Authorization is not an indexed unit');
  const bytes=Buffer.from(base.rtl),chunks=[];let cursor=0;
  for(const u of [...units].sort((a,b)=>a.start_byte-b.start_byte)) {
    const replacement=response.payload.replacements.find(r=>r.unit_id===u.unit_id);
    // Parse the replacement in isolation inside the exact original header. A
    // second unit, module escape or preprocessor construct fails closed.
    const parsed=indexUnits(`${before.header}\n${replacement.new_text}\nendmodule`,{resolve:false});
    invariant(parsed.ok&&parsed.units.length===1&&parsed.units[0].kind===u.kind,'PATCH_SCOPE_VIOLATION','Replacement escapes authorized syntax unit');
    chunks.push(bytes.subarray(cursor,u.start_byte),Buffer.from(replacement.new_text));cursor=u.end_byte;
  }
  chunks.push(bytes.subarray(cursor));
  const rtl=Buffer.concat(chunks).toString('utf8');
  const after=indexUnits(rtl);invariant(after.ok,'PATCH_SCOPE_VIOLATION',after.error?.message);
  invariant(before.header===after.header && before.top===after.top,'PATCH_SCOPE_VIOLATION','Interface changed');
  // New identifiers require a declarations transaction. Even then no new driver
  // may silently attach to an unchanged block; full complement is revalidated.
  const oldNames=new Set(before.units.flatMap(u=>u.identifiers));
  const headerNames=new Set(before.header.match(/[A-Za-z_][A-Za-z0-9_$]*/g));
  const fresh=after.units.flatMap(u=>u.identifiers).filter(n=>!oldNames.has(n)&&!headerNames.has(n));
  invariant(!fresh.length || units.some(u=>u.kind==='declarations'),'PATCH_SCOPE_VIOLATION','New identifier without declarations authorization');
  invariant(sha256(rtl)!==base.sha256,'NO_CHANGE');
  // Construction copies each complement directly from the original Buffer;
  // no search/replace or string normalization touches unauthorized bytes.
  return snapshot(rtl,base);
}
