import {readFile} from 'node:fs/promises';
import {embedText,cosine} from '../dual/knowledge.mjs';
import {invariant,sha256} from '../dual/snapshot.mjs';
import {prose} from '../dual/contracts.mjs';

export const PLANNING_KNOWLEDGE_VERSION='rtl2llm.planning-knowledge.v1';
export const PLANNING_ENCODER=Object.freeze({id:'embeddinggemma-300M-Q8_0',sha256:'b5ce9d77a3fc4b3b39ccb5643c36777911cc4eb46a66962eadfa3f5f60490d63',dimension:768,query_prefix:'task: search result | query: ',document_prefix:''});
export const planningCardView=c=>({id:c.id,revision:c.revision,source:c.source,applies_when:c.applies_when,text:c.text});
export function normalizePlanningKnowledge(raw={mode:'off'}) {
  invariant(raw&&typeof raw==='object'&&!Array.isArray(raw),'OUTPUT_INVALID','Planning knowledge configuration must be an object');
  const allowed=['mode','path','sha256','endpoint','timeoutMs','maxDocuments','maxChars','minScore'];
  invariant(Object.keys(raw).every(k=>allowed.includes(k)),'OUTPUT_INVALID','Unknown planning knowledge configuration');
  const c={mode:'off',path:'',sha256:'',endpoint:'http://127.0.0.1:18085',timeoutMs:3000,maxDocuments:2,maxChars:2600,minScore:0.35,...raw};
  invariant(['off','vector'].includes(c.mode),'OUTPUT_INVALID','Planning knowledge supports off or pinned local vector retrieval');
  if(c.mode==='off')return c;
  invariant(typeof c.path==='string'&&c.path.startsWith('/')&&/^[a-f0-9]{64}$/.test(c.sha256),'OUTPUT_INVALID','Pin a local planning index');
  let u;try{u=new URL(c.endpoint);}catch{invariant(false,'OUTPUT_INVALID','Invalid planning embedding endpoint');}
  invariant(u.protocol==='http:'&&['127.0.0.1','[::1]'].includes(u.hostname)&&!u.username&&!u.password&&!u.search&&!u.hash&&u.pathname==='/','OUTPUT_INVALID','Planning embedding requires numeric loopback origin');
  invariant(Number.isSafeInteger(c.timeoutMs)&&c.timeoutMs>0&&c.timeoutMs<=5000&&Number.isSafeInteger(c.maxDocuments)&&c.maxDocuments>0&&c.maxDocuments<=2&&Number.isSafeInteger(c.maxChars)&&c.maxChars>=800&&c.maxChars<=3000&&Number.isFinite(c.minScore)&&c.minScore>=0&&c.minScore<=1,'OUTPUT_INVALID','Invalid planning retrieval bounds');
  return {...c,endpoint:u.origin};
}
export function validatePlanningIndex(index,{vectors=false}={}) {
  invariant(index?.version===PLANNING_KNOWLEDGE_VERSION&&Array.isArray(index.cards)&&index.cards.length>0&&index.cards.length<=100,'OUTPUT_INVALID','Invalid planning index');
  invariant(Object.keys(index).every(k=>['version','cards','embedding','vectors','source_sha256'].includes(k)),'OUTPUT_INVALID','Unknown planning index field');
  invariant(new Set(index.cards.map(c=>c.id)).size===index.cards.length,'OUTPUT_INVALID','Duplicate planning card');
  for(const c of index.cards){
    invariant(Object.keys(c).every(k=>['id','revision','source','applies_when','text','trigger_groups'].includes(k)),'OUTPUT_INVALID','Unknown planning card field');
    invariant(/^planning\.[a-z][a-z0-9-]{1,70}$/.test(c.id)&&/^[0-9]{1,4}$/.test(c.revision),'OUTPUT_INVALID','Invalid planning card identity');
    invariant(c.source==='project-authored:generic-RTL-planning-principles','OUTPUT_INVALID','Unreviewed planning provenance');
    for(const k of ['applies_when','text']){
      invariant(typeof c[k]==='string'&&c[k].trim()&&c[k].length<=(k==='text'?1000:250),'OUTPUT_INVALID','Planning card too large');prose(c[k]);
      invariant(!/\bProb\d+\b|golden|testbench|judge[_ -]|reference implementation|\/Users\/|\/workspace\//i.test(c[k]),'OUTPUT_INVALID','Question identity or privileged evidence is forbidden in planning knowledge');
    }
    invariant(Array.isArray(c.trigger_groups)&&c.trigger_groups.length>=1&&c.trigger_groups.length<=3&&c.trigger_groups.every(g=>Array.isArray(g)&&g.length>=1&&g.length<=12&&g.every(s=>typeof s==='string'&&s.trim()===s&&s.length>=(/[\u4e00-\u9fff]/.test(s)?1:2)&&s.length<=50)),'OUTPUT_INVALID','Invalid domain eligibility phrases');
  }
  if(vectors){
    invariant(index.embedding&&Object.keys(PLANNING_ENCODER).every(k=>index.embedding[k]===PLANNING_ENCODER[k])&&Object.keys(index.embedding).length===Object.keys(PLANNING_ENCODER).length,'OUTPUT_INVALID','Planning encoder differs from pinned ROSS Gemma');
    invariant(/^[a-f0-9]{64}$/.test(index.source_sha256??'')&&Array.isArray(index.vectors)&&index.vectors.length===index.cards.length,'OUTPUT_INVALID','Missing planning vectors or source hash');
    for(const v of index.vectors){invariant(Array.isArray(v)&&v.length===PLANNING_ENCODER.dimension,'OUTPUT_INVALID','Invalid planning vector dimension');cosine(v,v);}
  }
  return index;
}
// Eligibility only narrows retrieval. It never labels task difficulty or adds a
// requirement; the semantic planner must decide if a retrieved reminder applies.
export function planningEligible(card,spec){
  const text=spec.toLowerCase();
  return card.trigger_groups.every(group=>group.some(term=>{
    const s=term.toLowerCase();if(/[\u4e00-\u9fff]/.test(s))return text.includes(s);
    const escaped=s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    return new RegExp('(?:^|[^a-z0-9_])'+escaped+'(?:$|[^a-z0-9_])','i').test(text);
  }));
}
export const planningDocument=c=>`${c.id.replace('planning.','').replaceAll('-',' ')}\nApplicable: ${c.applies_when}\n${c.text}`;
export async function loadPlanningKnowledge(raw,{embed=embedText}={}) {
  const config=normalizePlanningKnowledge(raw);if(config.mode==='off')return {retrieve:async()=>null};
  const bytes=await readFile(config.path);invariant(bytes.length<=2_000_000&&sha256(bytes)===config.sha256,'OUTPUT_INVALID','Planning knowledge index changed or too large');
  const index=validatePlanningIndex(JSON.parse(bytes),{vectors:true});
  return {config,index,retrieve:async({spec,signal})=>{
    signal?.throwIfAborted();invariant(typeof spec==='string'&&spec.trim(),'OUTPUT_INVALID','Planning query needs original specification');
    const eligible=index.cards.map((card,i)=>({card,i})).filter(({card})=>planningEligible(card,spec));
    const base={index_sha256:config.sha256,query_sha256:sha256(spec),documents:[],advisory_only:true};
    if(!eligible.length)return {...base,reason:'no_domain_match',embedding_called:false};
    // 3200 UTF-8 bytes is deliberately below the encoder's 2048-token context
    // for these English prompts. Record truncation; do not truncate the spec
    // seen by the planner or the eligibility check. Keep codepoint boundaries.
    let bounded='',n=0;for(const ch of spec){const size=Buffer.byteLength(ch);if(n+size>3200)break;bounded+=ch;n+=size;}
    const query=PLANNING_ENCODER.query_prefix+bounded;
    const vector=await embed(query,{...config,embedding:PLANNING_ENCODER,signal});
    const ranked=eligible.map(({card,i})=>({card,score:cosine(vector,index.vectors[i])})).filter(x=>x.score>=config.minScore).sort((a,b)=>b.score-a.score||a.card.id.localeCompare(b.card.id));
    let chars=0;for(const {card,score} of ranked){
      const view=planningCardView(card),doc={...view,sha256:sha256(JSON.stringify(card)),score};const size=JSON.stringify(doc).length;
      if(base.documents.length>=config.maxDocuments||chars+size>config.maxChars)continue;
      base.documents.push(doc);chars+=size;
    }
    return {...base,reason:base.documents.length?'retrieved':'below_threshold_or_size',embedding_called:true,query_truncated:bounded!==spec,embedding_query_sha256:sha256(query)};
  }};
}
