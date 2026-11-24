// Counterexample diagnosis (opt-in, AGENT_DIAGNOSIS_CEX=1).
//
// The harness locates the first observed mismatch itself and hands the 27B a
// short counterexample window instead of the full observation table, so the
// model explains one failure rather than simulating hundreds of rows. The
// answer is four labelled lines of plain text, parsed tolerantly: analysis
// prose before the labels is allowed, over-long or self-correcting text is
// trimmed, unknown line IDs are dropped. Only a missing CAUSE is a failure.
// The result is converted into the existing small-diagnosis shape and passes
// through expandDiagnosis unchanged, so downstream repair is not affected.
import {sourceCatalog} from '../planner/compact.mjs';
import {invariant} from '../dual/snapshot.mjs';
import {diagnosticProse} from '../dual/contracts.mjs';
import {currentObservation} from './diagnosis-evidence.mjs';
import {diagnosticCatalog} from './diagnosis.mjs';

export const CEX_DIAGNOSIS_VERSION='rtl2llm.diagnosis-cex.v1';
export const CEX_LIMITS=Object.freeze({windowRows:8,ports:2,where:6,sources:4,cause:400,goal:400,
  thinking:3072,maxTokens:4096,quickMaxTokens:768,timeoutMs:150000,quickTimeoutMs:45000});

const value=(bits,width)=>{
  if(typeof bits!=='string')return '?';
  if(width===1)return bits;
  if(/[xz]/i.test(bits)||width<=8)return `${width}'b${bits}`;
  return `${width}'h${BigInt('0b'+bits).toString(16)}`;
};

// The first mismatch per failing output port (at most two ports), each with the
// preceding rows. Returns null when no complete current observation exists.
export function counterexample(evidence,rtl,{windowRows=CEX_LIMITS.windowRows,ports=CEX_LIMITS.ports}={}){
  const o=currentObservation(evidence,rtl);
  if(o.status!=='complete'||!o.trace.mismatches.length)return null;
  const t=o.trace,widths=Object.fromEntries(t.ports.map(p=>[p.name,p.width]));
  const ins=t.ports.filter(p=>p.direction==='input'&&p.name!==t.clock_port).map(p=>p.name);
  const firsts=[];
  for(const m of t.mismatches)if(!firsts.some(f=>f.port===m.port)&&firsts.length<ports)firsts.push(m);
  const windows=firsts.map(m=>{
    const lo=Math.max(0,m.step-windowRows+1);
    return {port:m.port,step:m.step,rows:t.rows.slice(lo,m.step+1).map(r=>({step:r.step,edge:r.edge,
      inputs:Object.fromEntries(ins.map(n=>[n,value(r.inputs[n],widths[n])])),
      expected:Object.fromEntries(Object.entries(r.expect).map(([k,v])=>[k,value(v,widths[k])])),
      ...(r.masks?{care:Object.fromEntries(Object.entries(r.masks).map(([k,v])=>[k,value(v,widths[k])]))}:{}),
      actual:Object.fromEntries(Object.keys(r.expect).map(k=>[k,value(r.actual[k],widths[k])])),
      first_mismatch:r.step===m.step})),omitted_before:lo};
  });
  return {version:CEX_DIAGNOSIS_VERSION,clock:t.clock_port,checks:t.checks,failures:t.failures,windows};
}

export function renderCounterexample(cex){
  return cex.windows.map((w,i)=>{
    const lines=w.rows.map(r=>{
      const io=o=>Object.entries(o).map(([k,v])=>`${k}=${v}`).join(' ');
      const checked=Object.keys(r.expected).length?` | expected: ${io(r.expected)} | actual: ${io(r.actual)}${r.care?' | care mask (1=compare, 0=unspecified): '+io(r.care):''}`:'';
      return `step ${r.step} ${r.edge}: inputs ${io(r.inputs)}${checked}${r.first_mismatch?'   <-- FIRST MISMATCH':''}`;
    });
    return `Counterexample ${i+1} (output ${w.port})${w.omitted_before?`, ${w.omitted_before} earlier steps omitted`:''}:\n`+lines.join('\n');
  }).join('\n\n');
}

const SYSTEM=`You are the diagnosis assistant of an RTL agent. A self-generated check failed. Explain why the candidate RTL produces the observed wrong output, using the original specification. You never write RTL, patches or tests.
Think as long as you need, then END your reply with exactly these four labelled lines (the harness reads only these lines):
VERDICT: rtl_bug | test_suspect | uncertain
WHERE: code line IDs that cause the wrong output, e.g. C12, C15
CAUSE: one or two plain sentences, the final conclusion only
FIX: the required corrected behavior in words, no code
Optionally add one more line: SOURCE: specification line IDs that define the behavior, e.g. S7
Use test_suspect only when the EXPECTED value contradicts the specification text. Rows show inputs applied at each step and outputs observed after it; on posedge rows, registers update from the inputs held at that edge.`;

export function cexDiagnosisRequest({spec,rtl,cex,interfaceText=''}){
  const sources=sourceCatalog({spec,interfaceText}).map(r=>`${r.id}: ${r.quote}`).join('\n');
  const code=rtl.split('\n').map((l,i)=>l.trim()?`C${i+1}: ${l}`:null).filter(Boolean).join('\n');
  return {systemPrompt:SYSTEM,
    prompt:`# Specification (numbered lines)\n${sources}\n\n# Candidate RTL (numbered lines)\n${code}\n\n# Observed failure\nThe self-check ran ${cex.checks} comparisons and ${cex.failures} failed. Only the first failure per output is shown.\n\n${renderCounterexample(cex)}\n\nExplain the FIRST MISMATCH, then end with the four labelled lines.`};
}

export const QUICK_SYSTEM=`Answer immediately without long analysis. Reply with exactly these labelled lines and nothing else:
VERDICT: rtl_bug | test_suspect | uncertain
WHERE: code line IDs, e.g. C12
CAUSE: one sentence
FIX: required behavior in words, no code
SOURCE: specification line IDs, e.g. S7`;

const HEDGE=/\b(?:wait|actually|hmm+|re-?check(?:ing)?|let me|on second thought|no,|hold on)\b|—\s*no\b/i;
// Keep the conclusion, drop thinking that leaked into the field.
export function cleanStatement(text,max){
  let s=String(text??'').replace(/\s+/g,' ').trim();
  if(!s)return '';
  const cut=s.search(HEDGE);
  if(cut>20)s=s.slice(0,cut).trim();
  // A boundary is end punctuation followed by whitespace and a capital, so
  // abbreviations such as "e.g.," or "i.e." do not split a sentence.
  const sentences=s.split(/(?<=[.!?])\s+(?=[A-Z])/);
  s=sentences.slice(0,2).join(' ').trim();
  if(s.length>max){s=s.slice(0,max);const last=s.lastIndexOf(' ');if(last>max*0.6)s=s.slice(0,last);s=s.trim()+'…';}
  return s;
}

const label=(text,name)=>{
  const re=new RegExp(`^[ \\t>*#-]*\\**${name}\\**\\s*[:：]\\s*(.+)$`,'gim');let m,last=null;
  while((m=re.exec(text)))last=m[1];
  return last?.replace(/\*+$/,'').trim()??null;
};
const ids=(text,prefix)=>[...new Set((text??'').toUpperCase().match(new RegExp(`\\b${prefix}[1-9]\\d*\\b`,'g'))??[])];

// Tolerant parse. Returns {ok,verdict,where,sources,cause,goal,notes}.
export function parseCexDiagnosis(text,{codeIds,sourceIds}){
  const notes=[],raw=String(text??'');
  const verdictText=(label(raw,'VERDICT')??'').toLowerCase();
  let cause=label(raw,'CAUSE'),goal=label(raw,'FIX')??label(raw,'GOAL');
  if(!cause){
    // A JSON-style answer is also acceptable: take the last object with a cause.
    for(const m of raw.matchAll(/"cause"\s*:\s*"((?:[^"\\]|\\.)*)"/g))cause=m[1];
    for(const m of raw.matchAll(/"(?:goal|fix)"\s*:\s*"((?:[^"\\]|\\.)*)"/g))goal=m[1];
    if(cause)notes.push('json_style_answer');
  }
  const verdict=/test_suspect|checker/.test(verdictText)?'checker_suspect':/uncertain/.test(verdictText)?'uncertain':
    /rtl_bug|issue|bug/.test(verdictText)?'issues_found':cause?'issues_found':'uncertain';
  if(!verdictText&&cause)notes.push('verdict_inferred');
  const cleanCause=cleanStatement(cause,CEX_LIMITS.cause),cleanGoal=cleanStatement(goal??'',CEX_LIMITS.goal);
  if(cause&&cleanCause.length<cause.trim().length)notes.push('cause_trimmed');
  const whereRaw=ids(label(raw,'WHERE'),'C'),where=whereRaw.filter(x=>codeIds.has(x)).slice(0,CEX_LIMITS.where);
  if(whereRaw.length>where.length)notes.push('unknown_or_extra_code_ids_dropped');
  const sources=ids(label(raw,'SOURCE'),'[SI]').filter(x=>sourceIds.has(x)).slice(0,CEX_LIMITS.sources);
  return {ok:Boolean(cleanCause),verdict:cleanCause?verdict:'uncertain',where,sources,cause:cleanCause,goal:cleanGoal||cleanCause,notes};
}

// Text passed into the existing prose gate; code fragments are reduced, never rejected outright.
export function proseSafe(text){
  const attempt=s=>{try{diagnosticProse(s);return true;}catch{return false;}};
  if(attempt(text))return text;
  let s=text.replace(/`[^`]*`/g,m=>m.replace(/[;@]/g,' ').replace(/\b(?:assign|module|endmodule|always(?:_ff|_comb|_latch)?|initial|begin|end)\b/g,''));
  s=s.replace(/;/g,',');
  if(attempt(s))return s;
  s=s.replace(/[A-Za-z_]\w*(?:\[[^\]]*\])?\s*<?=\s*[^,.]*/g,'(assignment)').replace(/\s+/g,' ').trim();
  return attempt(s)?s:'See the code locations cited for the wrong output.';
}

const STOP=new Set(['the','a','an','is','are','to','of','and','or','when','it','in','on','be','that','this','with','for','not','should','must','its','at','as','by']);
const words=s=>new Set(String(s).toLowerCase().match(/[a-z_][a-z0-9_]*/g)?.filter(w=>!STOP.has(w))??[]);
// A source line is required downstream; pick the closest spec line when the model gave none.
export function fallbackSource(catalogRows,text){
  const w=words(text);let best=null,score=-1;
  for(const r of catalogRows){const n=[...words(r.quote)].filter(x=>w.has(x)).length;if(n>score){score=n;best=r.id;}}
  return best;
}

// Raw diagnosis for expandDiagnosis. Returns {raw,simple}: a normal finding uses
// the small (where/refs) shape; a checker suspicion uses the full shape with
// category "checker": the protocol requires a checker_suspect verdict to carry
// at least one checker-category issue (and issues_found at least one other).
export function toDiagnosis(parsed,{evidenceKey,catalogRows}){
  invariant(parsed.ok,'AUX_PROTOCOL_INVALID','No usable CAUSE line');
  const sources=parsed.sources.length?parsed.sources:[fallbackSource(catalogRows,parsed.cause+' '+parsed.goal)].filter(Boolean);
  if(parsed.verdict==='uncertain')return {simple:true,raw:{verdict:'uncertain',issues:[],limitations:[proseSafe(parsed.cause).slice(0,300)],assessments:[]}};
  if(parsed.verdict==='checker_suspect')return {simple:false,raw:{verdict:'checker_suspect',issues:[{target:'whole',category:'checker',sources,evidence:[evidenceKey],
    cause:proseSafe(parsed.cause),goal:proseSafe(parsed.goal),preserve:[]}],limitations:[],assessments:[]}};
  const where=parsed.where.length?parsed.where:['whole'];
  return {simple:true,raw:{verdict:'issues_found',issues:[{where,refs:[...sources,evidenceKey],cause:proseSafe(parsed.cause),goal:proseSafe(parsed.goal)}],limitations:[],assessments:[]}};
}

// Compact repair evidence for the 8B: the same id/source, the counterexample
// text as summary, no observation table. Null when no current counterexample.
export function counterexampleEvidence(evidence,rtl,{maxChars=6000}={}){
  const cex=counterexample(evidence,rtl,{windowRows:6});
  if(!cex)return null;
  let text=`Self-check: ${cex.failures} of ${cex.checks} comparisons failed. First failure per output:\n`+renderCounterexample(cex);
  if(text.length>maxChars)text=text.slice(0,maxChars)+'\n[truncated]';
  return {id:evidence.id,source:evidence.source,summary:text};
}

export function cexContext(req,checks){
  const p=req.payload,first=checks.find(c=>c.status==='fail');
  if(!first||first.stage!=='simulate')return null;
  const cex=counterexample(first.evidence,p.candidate.rtl);
  if(!cex)return null;
  const catalog=diagnosticCatalog(req,{simple:true});
  const evidenceKey=Object.keys(catalog).find(k=>/^E\d+$/.test(k)&&catalog[k].id===first.evidence?.id);
  if(!evidenceKey)return null;
  const catalogRows=sourceCatalog({spec:p.spec_text,interfaceText:p.interface_text??''});
  return {cex,evidenceKey,catalogRows,codeIds:new Set(p.candidate.rtl.split('\n').map((l,i)=>l.trim()?'C'+(i+1):null).filter(Boolean)),
    sourceIds:new Set(catalogRows.map(r=>r.id))};
}
