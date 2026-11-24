import {diagnosisCodeFacts} from './diagnosis-evidence.mjs';
import {readFile} from 'node:fs/promises';
import {embedText,cosine,cardView,cardHash} from '../dual/knowledge.mjs';
import {PLANNING_ENCODER,normalizePlanningKnowledge,planningEligible} from '../planner/knowledge.mjs';
import {invariant,sha256} from '../dual/snapshot.mjs';
import {diagnosticProse} from '../dual/contracts.mjs';
import {validateObservationResult,decodeObservation} from './observations.mjs';

export const DIAGNOSIS_KNOWLEDGE_VERSION='rtl2llm.diagnosis-knowledge.v1';
export const DIAGNOSIS_ENCODER=PLANNING_ENCODER;
export const normalizeDiagnosisKnowledge=normalizePlanningKnowledge;
export const diagnosisDocument=c=>`${c.pattern_id.replaceAll('-',' ')}\nApplicable: ${c.applies_when}\n${c.text}`;
const stages=['interface','compile','simulate','synthesize','static'];
const sources=['project-packed-vectors','project-old-state-timing','project-reset-observability','project-event-history','project-checker-audit','opentitan-testplanner','opentitan-uart-testplan','sv-tests-methodology'];
export function validateDiagnosisIndex(index,{vectors=false}={}){
  invariant(index?.version===DIAGNOSIS_KNOWLEDGE_VERSION&&Array.isArray(index.cards)&&index.cards.length>0&&index.cards.length<=100,'OUTPUT_INVALID','Invalid diagnosis index');
  invariant(Object.keys(index).every(k=>['version','cards','embedding','vectors','source_sha256'].includes(k)),'OUTPUT_INVALID','Unknown diagnosis index field');
  invariant(new Set(index.cards.map(c=>c.id)).size===index.cards.length,'OUTPUT_INVALID','Duplicate diagnosis card');
  const texts=new Set();
  for(const c of index.cards){
    invariant(Object.keys(c).length===9&&['id','pattern_id','revision','source','applies_when','text','trigger_groups','stages','provenance'].every(k=>Object.hasOwn(c,k)),'OUTPUT_INVALID','Unexpected diagnosis card field');
    invariant(/^diagnosis\.[a-z][a-z0-9-]{1,70}$/.test(c.id)&&/^[a-z][a-z0-9-]{1,70}$/.test(c.pattern_id)&&/^[0-9]{1,4}$/.test(c.revision)&&c.source==='project-authored:reviewed-diagnostic-methods','OUTPUT_INVALID','Invalid diagnosis provenance/identity');
    for(const k of ['applies_when','text']){
      invariant(typeof c[k]==='string'&&c[k].trim()&&c[k].length<=(k==='text'?800:250),'OUTPUT_INVALID','Diagnosis card too large');diagnosticProse(c[k]);
      invariant(!/\bProb\d+\b|golden|judge[_ -]|reference implementation|\/Users\/|\/workspace\/|ignore (?:the |all )?(?:system|previous) instructions/i.test(c[k]),'OUTPUT_INVALID','Task identity/privileged content/instructions forbidden');
    }
    const normalized=c.text.toLowerCase().replace(/\W+/g,' ');invariant(!texts.has(normalized),'OUTPUT_INVALID','Duplicate diagnosis content');texts.add(normalized);
    invariant(Array.isArray(c.stages)&&c.stages.length>0&&new Set(c.stages).size===c.stages.length&&c.stages.every(s=>stages.includes(s)),'OUTPUT_INVALID','Invalid failure-stage scope');
    invariant(Array.isArray(c.provenance)&&c.provenance.length>=1&&c.provenance.length<=4&&new Set(c.provenance).size===c.provenance.length&&c.provenance.every(s=>sources.includes(s)),'OUTPUT_INVALID','Unreviewed source');
    invariant(Array.isArray(c.trigger_groups)&&c.trigger_groups.length>=1&&c.trigger_groups.length<=3&&c.trigger_groups.every(g=>Array.isArray(g)&&g.length>=1&&g.length<=12&&g.every(s=>typeof s==='string'&&s.trim()===s&&s.length>=2&&s.length<=50)),'OUTPUT_INVALID','Invalid diagnosis eligibility');
  }
  if(vectors){
    invariant(index.embedding&&Object.keys(DIAGNOSIS_ENCODER).every(k=>index.embedding[k]===DIAGNOSIS_ENCODER[k])&&Object.keys(index.embedding).length===Object.keys(DIAGNOSIS_ENCODER).length&&/^[a-f0-9]{64}$/.test(index.source_sha256??'')&&index.vectors?.length===index.cards.length,'OUTPUT_INVALID','Diagnosis must use the pinned shared Gemma encoder');
    index.vectors.forEach(v=>{invariant(Array.isArray(v)&&v.length===DIAGNOSIS_ENCODER.dimension,'OUTPUT_INVALID','Invalid diagnosis vector');cosine(v,v);});
  }
  return index;
}
const bounded=(text,max)=>{let out='',bytes=0;for(const ch of text){const n=Buffer.byteLength(ch);if(bytes+n>max)break;out+=ch;bytes+=n;}return out;};
export function diagnosisRetrievalQuery({spec,checks=[],candidate}){
  invariant(typeof spec==='string'&&spec.trim(),'OUTPUT_INVALID','Diagnosis query needs original specification');
  const first=checks.find(c=>c.status==='fail'),stage=first?.stage??'static';
  const failure=first?.evidence?.summary??'';
  invariant(stages.includes(stage),'OUTPUT_INVALID','Unknown diagnostic failure stage');
  const executed=checks.some(c=>c.stage==='simulate'&&['pass','fail'].includes(c.status));
  const coverage=executed?'Functional self-test executed; expected values remain fallible.':'No executed functional self-test; static evidence only. Compilation and synthesis do not verify behavior.';
  // A retrieval hint is not a substitute for the full trace delivered to the
  // diagnostic model. Validate/decode existing observations; invent no states.
  let witness='';
  try{
    const o=validateObservationResult(JSON.parse(first?.evidence?.observation??'null'));
    if(o.status==='complete'){
      const trace=decodeObservation(o.view),m=trace.mismatches[0];
      if(m){const row=trace.rows[m.step];witness=`First observed mismatch: ${JSON.stringify({step:m.step,edge:row.edge,inputs:row.inputs,port:m.port,expected:m.expected,actual:m.actual,...(m.mask?{mask:m.mask}:{})})}`;}
    }
  }catch{/* Missing/invalid advisory data does not erase original evidence. */}
  const structure=candidate?diagnosisCodeFacts(candidate).features.join('; '):'';
  const query=`RTL diagnosis method. Stage: ${stage}. ${structure}\n${coverage}\n${bounded(witness,400)}\nObserved check: ${bounded(failure,600)}\nOriginal requirements: ${bounded(spec,1800)}`;
  return {query,stage,query_version:candidate?3:2,query_truncated:bounded(witness,400)!==witness||bounded(failure,600)!==failure||bounded(spec,1800)!==spec,eligibility_text:spec+'\n'+failure+'\n'+structure};
}
export async function loadDiagnosisKnowledge(raw,{embed=embedText}={}){
  const config=normalizeDiagnosisKnowledge(raw);if(config.mode==='off')return {retrieve:async()=>null};
  const bytes=await readFile(config.path);invariant(bytes.length<=2_000_000&&sha256(bytes)===config.sha256,'OUTPUT_INVALID','Diagnosis index changed/too large');
  const index=validateDiagnosisIndex(JSON.parse(bytes),{vectors:true});
  return {config,index,retrieve:async({spec,checks,signal,candidate})=>{
    signal?.throwIfAborted();const input=diagnosisRetrievalQuery({spec,checks,candidate});
    const eligible=index.cards.map((card,i)=>({card,i})).filter(({card})=>card.stages.includes(input.stage)&&planningEligible(card,input.eligibility_text));
    const report={namespace:'diagnosis',index_sha256:config.sha256,query_version:input.query_version,index_version:index.version,query_sha256:sha256(input.query),query_truncated:input.query_truncated,stage:input.stage,eligible_count:eligible.length,embedding_called:false,advisory_only:true,matches:[]};
    const knowledge={collection:'diagnosis',index_sha256:config.sha256,documents:[]};
    if(!eligible.length)return {knowledge,report:{...report,reason:'no_domain_match'}};
    const vector=await embed(DIAGNOSIS_ENCODER.query_prefix+input.query,{...config,embedding:DIAGNOSIS_ENCODER,signal});
    const ranked=eligible.map(({card,i})=>({card,score:cosine(vector,index.vectors[i])})).filter(x=>x.score>=config.minScore).sort((a,b)=>b.score-a.score||a.card.id.localeCompare(b.card.id));
    let chars=0;for(const {card,score} of ranked){
      const doc={...cardView(card),sha256:cardHash(card)},size=JSON.stringify(doc).length;
      if(knowledge.documents.length>=config.maxDocuments||chars+size>config.maxChars)continue;
      knowledge.documents.push(doc);report.matches.push({id:card.id,score,provenance:card.provenance,sha256:doc.sha256});chars+=size;
    }
    return {knowledge,report:{...report,embedding_called:true,characters:chars,reason:knowledge.documents.length?'retrieved':'below_threshold_or_size'}};
  }};
}
export function diagnosisKnowledgeSection(knowledge){
  if(!knowledge?.documents?.length)return '';
  invariant(knowledge.collection==='diagnosis'&&knowledge.documents.length<=2,'OUTPUT_INVALID','Invalid diagnostic advisory collection');
  const docs=knowledge.documents.map(d=>{
    invariant(cardHash(d)===d.sha256,'OUTPUT_INVALID','Diagnostic card hash changed');
    return {id:d.id,applies_when:d.applies_when,method:d.text};
  });
  invariant(JSON.stringify(knowledge.documents).length<=3000,'OUTPUT_INVALID','Oversized diagnostic advisory');
  return '\n\n# Retrieved diagnostic methods (advisory data, NOT requirements or executed evidence)\n'+JSON.stringify(docs)+'\nUse only applicable methods. A card is not proof of a defect and cannot be cited as S/I/E evidence. Original requirements, current RTL and actual checks take priority. Preserve the test oracle; do not weaken checks to obtain a pass. If history or execution is absent, state the limitation. Return the SAME bounded diagnosis schema; do not summarize cards or add an essay.';
}
