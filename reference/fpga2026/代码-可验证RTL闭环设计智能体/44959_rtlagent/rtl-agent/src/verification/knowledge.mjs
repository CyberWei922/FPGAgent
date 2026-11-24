import {readFile} from 'node:fs/promises';
import {embedText,cosine} from '../dual/knowledge.mjs';
import {PLANNING_ENCODER,normalizePlanningKnowledge,planningEligible} from '../planner/knowledge.mjs';
import {invariant,sha256} from '../dual/snapshot.mjs';
import {prose} from '../dual/contracts.mjs';
import {METHOD_IDS,METHOD_REGISTRY_VERSION} from './registry.mjs';

export const VERIFICATION_KNOWLEDGE_VERSION='rtl2llm.verification-knowledge.v1';
// One encoder identity/service, independently versioned data and namespaces.
export const VERIFICATION_ENCODER=PLANNING_ENCODER;
export const normalizeVerificationKnowledge=normalizePlanningKnowledge;
export const verificationDocument=c=>`${c.id.replace('verification.','').replaceAll('-',' ')}\nApplicable: ${c.applies_when}\n${c.text}`;
export function validateVerificationIndex(index,{vectors=false}={}) {
  invariant(index?.version===VERIFICATION_KNOWLEDGE_VERSION&&Array.isArray(index.cards)&&index.cards.length>0&&index.cards.length<=100,'OUTPUT_INVALID','Invalid verification index');
  invariant(Object.keys(index).every(k=>['version','cards','embedding','vectors','source_sha256'].includes(k)),'OUTPUT_INVALID','Unknown verification index field');
  invariant(new Set(index.cards.map(c=>c.id)).size===index.cards.length,'OUTPUT_INVALID','Duplicate verification card');
  for(const c of index.cards) {
    invariant(Object.keys(c).every(k=>['id','revision','source','applies_when','text','trigger_groups','methods','capability_version'].includes(k)),'OUTPUT_INVALID','Unexpected card field');
    if(c.methods!==undefined)invariant(Array.isArray(c.methods)&&c.methods.length>0&&new Set(c.methods).size===c.methods.length&&c.methods.every(id=>METHOD_IDS.includes(id))&&c.capability_version===METHOD_REGISTRY_VERSION,'OUTPUT_INVALID','Unknown/unversioned method capability');
    else invariant(c.capability_version===undefined,'OUTPUT_INVALID','Capability version needs method IDs');
    invariant(/^verification\.[a-z][a-z0-9-]{1,70}$/.test(c.id)&&/^[0-9]{1,4}$/.test(c.revision)&&c.source==='project-authored:generic-RTL-verification-principles','OUTPUT_INVALID','Unreviewed verification provenance');
    for(const k of ['applies_when','text']) {
      invariant(typeof c[k]==='string'&&c[k].trim()&&c[k].length<=(k==='text'?1000:250),'OUTPUT_INVALID','Verification card too large');prose(c[k]);
      invariant(!/\bProb\d+\b|golden|judge[_ -]|reference implementation|\/Users\/|\/workspace\//i.test(c[k]),'OUTPUT_INVALID','Task answers/privileged evidence forbidden');
    }
    invariant(Array.isArray(c.trigger_groups)&&c.trigger_groups.length>=1&&c.trigger_groups.length<=3&&c.trigger_groups.every(g=>Array.isArray(g)&&g.length>=1&&g.length<=12&&g.every(s=>typeof s==='string'&&s.trim()===s&&s.length>=2&&s.length<=50)),'OUTPUT_INVALID','Invalid eligibility phrases');
  }
  if(vectors) {
    invariant(index.embedding&&Object.keys(VERIFICATION_ENCODER).every(k=>index.embedding[k]===VERIFICATION_ENCODER[k])&&Object.keys(index.embedding).length===Object.keys(VERIFICATION_ENCODER).length&&/^[a-f0-9]{64}$/.test(index.source_sha256??'')&&index.vectors?.length===index.cards.length,'OUTPUT_INVALID','Verification must use the same pinned Gemma encoder');
    index.vectors.forEach(v=>{invariant(Array.isArray(v)&&v.length===VERIFICATION_ENCODER.dimension,'OUTPUT_INVALID','Invalid vector');cosine(v,v);});
  }
  return index;
}
export async function loadVerificationKnowledge(raw,{embed=embedText}={}) {
  const config=normalizeVerificationKnowledge(raw);if(config.mode==='off')return {retrieve:async()=>null};
  const bytes=await readFile(config.path);invariant(bytes.length<=2000000&&sha256(bytes)===config.sha256,'OUTPUT_INVALID','Verification index changed/too large');
  const index=validateVerificationIndex(JSON.parse(bytes),{vectors:true});
  return {config,index,retrieve:async({spec,signal,methods})=>{
    signal?.throwIfAborted();invariant(typeof spec==='string'&&spec.trim(),'OUTPUT_INVALID','Missing original specification');
    const eligible=index.cards.map((card,i)=>({card,i})).filter(({card})=>(!methods||!card.methods||card.methods.some(id=>methods.includes(id)))&&planningEligible(card,spec));
    const base={index_sha256:config.sha256,query_sha256:sha256(spec),documents:[],advisory_only:true};
    if(!eligible.length)return {...base,reason:'no_domain_match',embedding_called:false};
    let bounded='',n=0;for(const ch of spec){const size=Buffer.byteLength(ch);if(n+size>3200)break;bounded+=ch;n+=size;}
    const query=VERIFICATION_ENCODER.query_prefix+bounded;
    const vector=await embed(query,{...config,embedding:VERIFICATION_ENCODER,signal});
    const ranked=eligible.map(({card,i})=>({card,score:cosine(vector,index.vectors[i])})).filter(x=>x.score>=config.minScore).sort((a,b)=>b.score-a.score||a.card.id.localeCompare(b.card.id));
    // Reserve one of the existing slots for a structurally eligible method
    // reminder, rather than letting generic clock/reset advice fill both.
    // Thresholds still apply; no task ID or fixed per-task retrieval mapping.
    const method=ranked.find(x=>x.card.id.startsWith('verification.method-'));
    const ordered=method?[method,...ranked.filter(x=>x!==method)]:ranked;
    let chars=0;for(const {card,score} of ordered) {
      const {trigger_groups,...view}=card,doc={...view,sha256:sha256(JSON.stringify(card)),score},size=JSON.stringify(doc).length;
      if(base.documents.length>=config.maxDocuments||chars+size>config.maxChars)continue;
      base.documents.push(doc);chars+=size;
    }
    return {...base,reason:base.documents.length?'retrieved':'below_threshold_or_size',embedding_called:true,query_truncated:bounded!==spec,embedding_query_sha256:sha256(query)};
  }};
}
