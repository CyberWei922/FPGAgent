import { readFileSync } from 'node:fs';
import { invariant, sha256, sliceBytes, utf8 } from './snapshot.mjs';
import schemaV2 from '../../../contracts/rtl2llm/v2.schema.mjs';
import { indexUnits } from './unit-index.mjs';
import {resolveLocations,relocateLocations} from '../harness/code-references.mjs';

export const PROTOCOL = 'rtl2llm.v1';
export const schema = JSON.parse(readFileSync(new URL('../../../contracts/rtl2llm/v1.schema.json', import.meta.url), 'utf8'));
export const schemas=Object.freeze({[PROTOCOL]:schema,'rtl2llm.v2':schemaV2});
export function schemaFor(protocol){invariant(Object.hasOwn(schemas,protocol),'OUTPUT_INVALID','Unknown protocol');return schemas[protocol];}
// Deliberately limited interpreter for the checked-in schema, not a general JSON
// Schema engine. Unknown validation keywords fail at startup instead of weakening
// the contract. Python Draft2020-12 tests cross-check all synthetic fixtures.
const supported = new Set(['$schema','$id','title','description','$defs','$ref','type','additionalProperties','required','properties','allOf','if','then','const','enum','pattern','minLength','maxLength','minimum','maximum','minItems','maxItems','uniqueItems','items','contains','not']);
function inspect(s) {
  for (const [k,v] of Object.entries(s)) {
    invariant(supported.has(k), 'OUTPUT_INVALID', `Unsupported schema keyword ${k}`);
    if (['properties','$defs'].includes(k)) Object.values(v).forEach(inspect);
    if (['items','if','then','not','contains'].includes(k)) inspect(v);
    if (k === 'allOf') v.forEach(inspect);
  }
}
Object.values(schemas).forEach(inspect);
function matches(v,s,root=schema) {
  if (s.$ref) return matches(v, s.$ref.split('/').slice(1).reduce((o,k)=>o[k],root),root);
  if (s.const !== undefined && v !== s.const) return false;
  if (s.enum && !s.enum.includes(v)) return false;
  if (s.type && !(s.type === 'object' ? v !== null && typeof v === 'object' && !Array.isArray(v)
    : s.type === 'array' ? Array.isArray(v) : s.type === 'integer' ? Number.isSafeInteger(v) : typeof v === s.type)) return false;
  if (typeof v === 'string') {
    const n = [...v].length;
    if (n < (s.minLength ?? 0) || n > (s.maxLength ?? Infinity) || (s.pattern && !new RegExp(s.pattern).test(v)) || !v.isWellFormed()) return false;
  }
  if (typeof v === 'number' && (v < (s.minimum ?? -Infinity) || v > (s.maximum ?? Infinity))) return false;
  if (Array.isArray(v)) {
    if (v.length < (s.minItems ?? 0) || v.length > (s.maxItems ?? Infinity)) return false;
    if (s.uniqueItems && new Set(v.map(x=>JSON.stringify(x))).size !== v.length) return false;
    if (s.items && !v.every(x=>matches(x,s.items,root))) return false;
    if (s.contains && !v.some(x=>matches(x,s.contains,root))) return false;
  }
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    if (s.required?.some(k=>!Object.hasOwn(v,k))) return false;
    if (s.additionalProperties === false && Object.keys(v).some(k=>!Object.hasOwn(s.properties ?? {},k))) return false;
    if (Object.entries(s.properties ?? {}).some(([k,x])=>Object.hasOwn(v,k) && !matches(v[k],x,root))) return false;
  }
  if (s.not && matches(v,s.not,root)) return false;
  if (s.allOf?.some(x=>!matches(v,x,root))) return false;
  if (s.if && matches(v,s.if,root) && s.then && !matches(v,s.then,root)) return false;
  return true;
}
export const envelope = (kind, request_id, task_id, payload, protocol=PROTOCOL) => ({protocol,kind,request_id,task_id,payload});
const unique = (a,key) => invariant(new Set(a.map(x=>x[key])).size === a.length,'OUTPUT_INVALID',`Duplicate ${key}`);
const quoted = (q,p) => invariant((q.source === 'spec' ? p.spec_text : p.interface_text).includes(q.quote), 'OUTPUT_INVALID', 'Fabricated source quote');
// Restrict diagnostic prose to its role. This is a conservative output gate,
// never a claim to recognize all possible code or semantic hallucinations.
export function prose(text) {
  // Inline signal expressions are not executable statements. Without this,
  // `reset=1` followed by a prose semicolon is mistaken for replacement code.
  // Semicolons, blocks and HDL statement keywords inside backticks stay visible.
  const inline=text.replace(/`([^`\n]+)`/g,(token,inside)=>/[;@]|\b(?:assign|module|endmodule|always(?:_ff|_comb|_latch)?|initial|begin|end)\b/.test(inside)?token:'[signal expression]');
  // A scalar condition introduced by prose is not an assignment statement:
  // "with flag=1; verify ..." or "feed a new flag=1 sample ...". Mask only
  // that atomic predicate, never its suffix, so a following real assignment
  // remains visible. This is a conservative lexical gate, not an HDL parser.
  // Do not rewrite the saved text, source quotations or model handoff.
  const view=inline.replace(/\b(?:with|when|while|where|if|unless|feed|drive|apply)\s+(?:(?:a|an|the|new|old|another)\s+)*[A-Za-z_]\w*(?:\[\d+(?::\d+)?\])?\s*(?:<=|=(?!=))\s*(?:\d+'[sS]?[bBoOdDhH][0-9a-fA-F_xXzZ?]+|'[01xXzZ]|\d+|[A-Za-z_]\w*)(?![\w'\[])(?=\s*(?:[;,.)]|[A-Za-z]|$))/gi,'[prose condition]');
  // A semicolon after an entire English sentence does not turn an inline
  // predicate into an HDL assignment. Only an expression-like RHS is a
  // statement candidate. Keep explicit HDL keywords and actual assignments
  // blocked; this lexical role gate is not a compiler/security proof.
  const assignments=[...view.matchAll(/\b\w+(?:\[[^\]]+\])?\s*(?:<=|=(?!=))([^;\n]*);/g)];
  const assignment=assignments.some(m=>{
    const rhs=m[1].replace(/\d+'[sS]?[bBoOdDhH][0-9a-fA-F_xXzZ?]+|'[01xXzZ]/g,'0');
    return !/(?:\b\w+|\])\s+[A-Za-z_]\w*/.test(rhs)&&!/[\u4e00-\u9fff]/.test(rhs);
  });
  invariant(!assignment&&!/```|(?:^|\n)\s*(?:diff |@@|[+-]\s*(?:assign|always|module))|\b(?:endmodule|endfunction)\b|\b(?:assign|module|always(?:_ff|_comb|_latch)?)\s+[^.!?\n]*[;@]/m.test(view), 'OUTPUT_INVALID', 'Auxiliary output must be prose, not replacement/test code');
}
// Diagnostics must be able to NAME an existing HDL process. Only mask a
// natural-language noun phrase ending in "block"/"process", never a bare
// header, procedural body, assignment, fence or any following suffix. The
// original diagnostic remains byte-for-byte intact in records and handoffs.
export function diagnosticProse(text) {
  const view=text.replace(/\b(the|an?|this|that|combinational|sequential)\s+`?(?:always(?:_ff)?\s*@\s*(?:\*|\(\s*\*\s*\)|\(\s*(?:posedge|negedge)\s+[A-Za-z_]\w*(?:\s+or\s+(?:posedge|negedge)\s+[A-Za-z_]\w*)*\s*\))|always_(?:comb|latch))`?\s+(?:block|process)\b/gi,'$1 HDL process');
  // Parenthesized lists of literal input bindings are diagnostic witnesses,
  // not procedural statements. Mask only >=2 single-bit bindings; preserve
  // every surrounding byte so an actual assignment/HDL suffix is still gated.
  const witness=view.replace(/\(\s*[A-Za-z_]\w*\s*=\s*[01]\s*(?:,\s*[A-Za-z_]\w*\s*=\s*[01]\s*)+\)/g,'[observed input tuple]');
  prose(witness);
}
export function validateMessage(message, request, { snapshot: base, review, evidenceStore } = {}) {
  const root=schemaFor(message?.protocol);
  invariant(matches(message,root,root), 'OUTPUT_INVALID', 'Schema validation failed');
  utf8(JSON.stringify(message));
  const p = message.payload;
  if (request) {
    validateMessage(request);
    invariant(message.protocol===request.protocol&&message.request_id === request.request_id && message.task_id === request.task_id && message.kind === request.kind.replace('_request','_response'), 'STALE_SNAPSHOT','Response identity mismatch');
  }
  if (message.kind === 'spec_request') unique(p.rules,'id');
  if (['spec_response','review_request'].includes(message.kind)) {
    unique(p.constraints,'id');
    const origin = message.kind === 'spec_response' ? request?.payload : p;
    invariant(origin, 'OUTPUT_INVALID','Source request required');
    p.constraints.forEach(c=>{quoted(c,origin); prose(c.claim);});
  }
  if (message.kind === 'spec_response') [...p.ambiguities,p.reason].forEach(prose);
  if (['review_request','repair_request'].includes(message.kind)) {
    unique(p.evidence,'id');
    if (evidenceStore) p.evidence.forEach(e=>invariant(evidenceStore.get(e.id)?.summary === e.summary && evidenceStore.get(e.id)?.source === e.source && evidenceStore.get(e.id)?.observation === e.observation, 'OUTPUT_INVALID','Evidence not in immutable store'));
  }
  if (message.kind === 'review_request') {
    invariant(sha256(p.candidate.rtl) === p.candidate.sha256, 'STALE_SNAPSHOT');
    unique(p.units,'unit_id'); checkRanges(p.candidate.rtl,p.units);
    if(p.repair_context) {
      const c=p.repair_context;
      invariant(sha256(c.previous_candidate.rtl)===c.previous_candidate.sha256&&c.previous_candidate.sha256!==p.candidate.sha256,'STALE_SNAPSHOT');
      unique(c.previous_issues,'id');
      const old=new Set(c.previous_issues.map(i=>i.id));
      invariant(c.target_issue_ids.length&&c.target_issue_ids.every(i=>old.has(i))&&c.pending_issue_ids.every(i=>old.has(i)),'OUTPUT_INVALID','Unknown previous issue');
      invariant(!c.target_issue_ids.some(i=>c.pending_issue_ids.includes(i))&&new Set([...c.target_issue_ids,...c.pending_issue_ids]).size===old.size,'OUTPUT_INVALID','Previous issues must be accounted for');
      const oldIndex=indexUnits(c.previous_candidate.rtl);
      c.previous_issues.forEach(i=>{
        i.requirement_quotes.forEach(q=>quoted(q,p));
        i.unit_ids.forEach(u=>invariant(oldIndex.ok&&oldIndex.units.some(x=>x.unit_id===u),'UNKNOWN_UNIT','Historical location not in historical snapshot'));
        for(const l of i.code_locations??[])invariant(resolveLocations(c.previous_candidate.rtl,['C'+l.start_line])[0].text_sha256===l.text_sha256&&l.start_line===l.end_line,'STALE_SNAPSHOT','Historical line reference does not match its historical candidate');
      });
      if(c.location_updates){
        unique(c.location_updates,'issue_id');
        invariant(c.location_updates.length===old.size&&c.location_updates.every(u=>old.has(u.issue_id)),'OUTPUT_INVALID','Every old issue needs a location update');
        for(const u of c.location_updates){
          const expected=relocateLocations(c.previous_candidate.rtl,p.candidate.rtl,c.previous_issues.find(i=>i.id===u.issue_id).code_locations);
          invariant(u.status===expected.status&&u.reason===expected.reason&&JSON.stringify(u.locations)===JSON.stringify(expected.locations),'STALE_SNAPSHOT','Location updates must be program-derived');
        }
      }
    }
  }
  if (message.kind === 'review_response') {
    invariant(request, 'OUTPUT_INVALID','Review request required');
    const r=request.payload;
    invariant(p.candidate_sha256 === r.candidate.sha256, 'STALE_SNAPSHOT'); unique(p.issues,'id');
    invariant(p.verdict !== 'no_issue_found' || r.coverage === 'full', 'OUTPUT_INVALID','Partial review cannot claim no issue');
    for (const issue of p.issues) {
      if(issue.code_locations)for(const loc of issue.code_locations){
        invariant(loc.start_line===loc.end_line,'OUTPUT_INVALID','Only explicit single-line references are supported');
        const actual=resolveLocations(r.candidate.rtl,['C'+loc.start_line])[0];
        invariant(actual.text_sha256===loc.text_sha256,'STALE_SNAPSHOT','Code reference does not match current candidate');
      }
      issue.requirement_quotes.forEach(q=>quoted(q,r));
      issue.unit_ids.forEach(u=>invariant(r.units.some(x=>x.unit_id === u),'UNKNOWN_UNIT'));
      issue.evidence_ids.forEach(e=>invariant(r.evidence.some(x=>x.id === e),'OUTPUT_INVALID','Unknown evidence'));
      invariant(issue.requirement_quotes.length || issue.evidence_ids.length, 'OUTPUT_INVALID','Issue needs source or evidence');
      [issue.explanation,issue.repair_goal].forEach(diagnosticProse);
    }
    p.limitations.forEach(diagnosticProse);
    const assessments=p.repair_assessments??[],previous=r.repair_context?.previous_issues??[];
    unique(assessments,'issue_id');
    invariant(assessments.length===previous.length,'OUTPUT_INVALID','Every historical issue needs a fresh assessment');
    for(const a of assessments) {
      invariant(previous.some(i=>i.id===a.issue_id),'OUTPUT_INVALID','Unknown repair assessment');diagnosticProse(a.reason);
      a.evidence_ids.forEach(i=>invariant(r.evidence.some(e=>e.id===i),'OUTPUT_INVALID','Historical evidence is not current evidence'));
      invariant(a.status!=='resolved'||a.evidence_ids.length,'OUTPUT_INVALID','Resolved requires current evidence; otherwise use uncertain');
      invariant(a.status!=='still_present'||p.issues.some(i=>i.id===a.issue_id),'OUTPUT_INVALID','Still-present issue must have current source/unit references');
      invariant(!['resolved','prior_diagnosis_invalid'].includes(a.status)||!p.issues.some(i=>i.id===a.issue_id),'OUTPUT_INVALID','Issue cannot be both resolved/invalid and currently present');
      invariant(p.verdict!=='no_issue_found'||!['still_present','uncertain'].includes(a.status),'OUTPUT_INVALID','Unresolved historical issue cannot receive clearance');
    }
  }
  if (message.kind === 'repair_request') {
    if(p.constraints){unique(p.constraints,'id');p.constraints.forEach(c=>{quoted(c,p);prose(c.claim);});}
    if(p.pending_issues){unique(p.pending_issues,'id');p.pending_issues.forEach(i=>{
      invariant(!p.issue_ids.includes(i.id),'OUTPUT_INVALID','Target issue also marked pending');
      i.requirement_quotes.forEach(q=>quoted(q,p));[i.explanation,i.repair_goal].forEach(diagnosticProse);
      if(base)i.unit_ids.forEach(u=>invariant(indexUnits(base.rtl).units.some(x=>x.unit_id===u),'UNKNOWN_UNIT'));
    });}
    unique(p.editable_units,'unit_id');
    if (base) {
      invariant(p.base_sha256 === base.sha256 && p.candidate_id === base.id && sha256(base.rtl) === base.sha256,'STALE_SNAPSHOT');
      checkRanges(base.rtl,p.editable_units);
      p.readonly_context.forEach(c=>invariant(base.rtl.includes(c.text) || p.interface_text.includes(c.text),'DEPENDENCY_UNRESOLVED','Read-only context not extracted from snapshot'));
    }
    if (review) {
      invariant(review.payload.candidate_sha256 === p.base_sha256,'STALE_SNAPSHOT');
      p.issue_ids.forEach(i=>invariant(review.payload.issues.some(x=>x.id===i),'OUTPUT_INVALID','Unknown issue'));
    }
  }
  if(p.knowledge) {
    invariant(p.knowledge.collection===(message.kind==='review_request'?'diagnosis':'repair'),'OUTPUT_INVALID','Wrong knowledge collection');
    unique(p.knowledge.documents,'id');
    p.knowledge.documents.forEach(d=>invariant(sha256(JSON.stringify({id:d.id,pattern_id:d.pattern_id,revision:d.revision,source:d.source,applies_when:d.applies_when,text:d.text}))===d.sha256,'OUTPUT_INVALID','Knowledge content hash mismatch'));
  }
  if (message.kind === 'repair_response') {
    invariant(request,'OUTPUT_INVALID','Repair request required');
    const r=request.payload;
    invariant(p.package_id===r.package_id && p.base_sha256===r.base_sha256,'STALE_SNAPSHOT');
    if (p.status==='replacement') {
      unique(p.replacements,'unit_id');
      invariant(p.replacements.length===r.editable_units.length,'UNKNOWN_UNIT','Missing replacement');
      p.replacements.forEach(x=>{const u=r.editable_units.find(y=>y.unit_id===x.unit_id); invariant(u,'UNKNOWN_UNIT'); invariant(x.old_sha256===u.old_sha256,'STALE_SNAPSHOT'); utf8(x.new_text);});
      invariant(p.replacements.some(x=>x.new_text!==r.editable_units.find(y=>y.unit_id===x.unit_id).old_text),'NO_CHANGE');
    }
  }
  return message;
}
export function checkRanges(rtl, units) {
  let end=-1;
  for (const u of [...units].sort((a,b)=>a.start_byte-b.start_byte)) {
    invariant(u.start_byte>=end,'OVERLAPPING_UNITS');
    const text=sliceBytes(rtl,u.start_byte,u.end_byte);
    invariant(sha256(text)===u.old_sha256 && (u.old_text===undefined || u.old_text===text),'STALE_SNAPSHOT');
    end=u.end_byte;
  }
}
