import {validateObservationResult,decodeObservation,observationMatches} from './observations.mjs';
import {sha256} from '../dual/snapshot.mjs';

// Lexical facts only: this is neither an HDL evaluator nor a dependency parser.
// Mask comments and strings without moving code locations.
const mask=rtl=>rtl.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"/g,s=>s.replace(/[^\n]/g,' '));
export function diagnosisCodeFacts(rtl){
  const code=mask(rtl),features=[];
  if(/\bfunction\b/.test(code))features.push('function declarations present');
  if(/\balways\s*@\s*(?:\*|\(\s*\*\s*\))/.test(code))features.push('wildcard combinational sensitivity present');
  if(/\balways_comb\b/.test(code))features.push('always_comb present');
  if(/\bposedge\b|\bnegedge\b/.test(code))features.push('edge-triggered process present');
  if(/\bassign\b/.test(code))features.push('continuous assignment present');
  const literals=[];let total=0;
  for(const m of code.matchAll(/\b(\d{1,4})'([sS]?)([bBoOdDhH])([0-9a-fA-F_xXzZ?]+)/g)){
    const width=Number(m[1]),digits=m[4].replaceAll('_',''),radix={b:2,o:8,d:10,h:16}[m[3].toLowerCase()];
    if(width<1||width>4096||!digits||[...digits].some(c=>!Number.isInteger(parseInt(c,radix))))continue;
    let value=0n;for(const c of digits)value=value*BigInt(radix)+BigInt(parseInt(c,radix));
    const modulus=1n<<BigInt(width),bits=value%modulus;total++;
    if(literals.length>=12)continue;
    literals.push({where:'C'+((code.slice(0,m.index).match(/\n/g)?.length??0)+1),literal:m[0],width,bit_pattern_decimal:String(bits),...(m[2]?{signed_decimal:String(bits>=modulus/2n?bits-modulus:bits)}:{}),truncated:value!==bits});
  }
  return {kind:'lexical_only',features,literals,literals_total:total,literals_omitted:Math.max(0,total-literals.length),limitation:'Literal bit patterns only; not expression widths, arithmetic results, branch execution or internal state. State encodings and numeric counts are different.'};
}
export function currentObservation(evidence,rtl){
  try{
    const result=validateObservationResult(JSON.parse(evidence?.observation??'null'));
    if(result.status!=='complete')return {status:'unavailable',reason:'incomplete_observation'};
    if(result.view.metadata.candidate_sha256!==sha256(rtl))return {status:'unavailable',reason:'stale_candidate'};
    return {status:'complete',view:result.view,trace:decodeObservation(result.view)};
  }catch{return {status:'unavailable',reason:'missing_or_invalid_observation'};}
}
export function diagnosisEvidenceBrief({rtl,checks=[]}){
  const first=checks.find(c=>c.status==='fail'),observation=currentObservation(first?.evidence,rtl);
  const out={version:'rtl2llm.diagnosis-evidence.v1',candidate_sha256:sha256(rtl),check_id:first?.id??null,stage:first?.stage??null,code_facts:diagnosisCodeFacts(rtl),observation:{status:observation.status}};
  if(observation.status!=='complete'){out.observation.reason=observation.reason;return out;}
  const {trace}=observation,m=trace.mismatches[0],row=m?trace.rows[m.step]:null;
  const previous=m?trace.rows.slice(0,m.step).findLast(r=>observationMatches(r,m.port)):null;
  const edges=m?trace.rows.slice(0,m.step+1).filter(r=>r.edge==='posedge'||r.edge==='negedge').slice(-4):[];
  out.observation={status:'complete',rows:trace.rows.length,checks:trace.checks,failures:trace.failures,plan_sha256:trace.plan_sha256,bench_sha256:trace.bench_sha256,semantics:trace.semantics,first_mismatch:m?{...m,row}:null,previous_correct_sample:previous,recent_edge_samples:edges,limitation:'Focus samples are not the complete causal history. The full table follows with every row; because labels refer to test constraints, not RTL C lines. Expected values remain fallible.'};
  return out;
}
export function readableObservation(evidence,rtl){
  const o=currentObservation(evidence,rtl);
  if(o.status!=='complete')return evidence?.observation??'';
  return JSON.stringify(o.view.metadata)+'\n'+o.view.columns.join('\t')+'\n'+o.view.table;
}
export function diagnosisEvidenceSection(brief){
  return '\n\n# Harness evidence brief (observed and lexical facts; NOT a diagnosis)\n'+JSON.stringify(brief)+'\nUse the first mismatch and preceding correct sample to test ONE causal hypothesis against original S/I requirements and current code. A source literal\'s numeric value is not a state label. Do not infer a new initialization requirement from startup unknowns or treat a lexical feature as proof. If the hypothesis does not explain the observed transition, reject it. Submit the first confirmed issue in the existing schema; do not mentally replay the whole test suite. Full history follows; fetch context only for a specifically absent item.';
}
