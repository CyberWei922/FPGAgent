import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { invariant, sha256 } from './snapshot.mjs';

export const KNOWLEDGE_VERSION='rtl2llm.knowledge.v1';
export const cardView=c=>({id:c.id,pattern_id:c.pattern_id,revision:c.revision,source:c.source,applies_when:c.applies_when,text:c.text});
export const cardHash=c=>sha256(JSON.stringify(cardView(c)));
const tokens=text=>new Set(text.toLowerCase().match(/[a-z_][a-z_0-9]*|[\u4e00-\u9fff]/g)??[]);
const norm=v=>Math.hypot(...v);
export function cosine(a,b) {
  invariant(Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.length>0&&a.every(Number.isFinite)&&b.every(Number.isFinite)&&norm(a)>0&&norm(b)>0,'OUTPUT_INVALID','Invalid embedding vector');
  return a.reduce((s,x,i)=>s+x*b[i],0)/(norm(a)*norm(b));
}
export function normalizeKnowledge(raw={mode:'off'}) {
  invariant(raw&&typeof raw==='object'&&!Array.isArray(raw),'OUTPUT_INVALID','Knowledge configuration must be an object');
  const c={mode:'off',path:'',sha256:'',endpoint:'http://127.0.0.1:18085',timeoutMs:5000,maxDocuments:3,maxChars:12000,minScore:0.35,...raw};
  invariant(['off','lexical','vector'].includes(c.mode),'OUTPUT_INVALID','Unknown knowledge mode');
  if(c.mode==='off')return c;
  invariant(typeof c.path==='string'&&c.path.startsWith('/')&&/^[a-f0-9]{64}$/.test(c.sha256),'OUTPUT_INVALID','Pin a local knowledge index by SHA256');
  const u=new URL(c.endpoint);
  invariant(u.protocol==='http:'&&['127.0.0.1','[::1]'].includes(u.hostname)&&!u.username&&!u.password&&!u.search&&!u.hash&&u.pathname==='/','OUTPUT_INVALID','Embedding requires numeric loopback origin');
  for(const k of ['timeoutMs','maxDocuments','maxChars'])invariant(Number.isSafeInteger(c[k])&&c[k]>0,'OUTPUT_INVALID',`Invalid knowledge ${k}`);
  invariant(c.maxDocuments<=8&&c.maxChars<=100000&&Number.isFinite(c.minScore)&&c.minScore>=0&&c.minScore<=1,'OUTPUT_INVALID','Invalid knowledge bounds');
  return {...c,endpoint:u.origin};
}

// Direct numeric-loopback transport: no proxy, redirect, remote fallback or
// download. Uses the already deployed CPU EmbeddingGemma service API.
export function embedText(text,{endpoint,timeoutMs=5000,embedding,signal}) {
  const c=normalizeKnowledge({mode:'vector',path:'/identity-check',sha256:'0'.repeat(64),endpoint,timeoutMs});
  invariant(typeof text==='string'&&text.length>0,'OUTPUT_INVALID');
  return new Promise((resolve,reject)=>{
    const body=JSON.stringify({input:text,encoding_format:'float'});
    const req=http.request(c.endpoint+'/v1/embeddings',{method:'POST',signal,headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{
      const chunks=[];let bytes=0;
      res.on('data',chunk=>{bytes+=chunk.length;if(bytes>1048576){res.destroy(new Error('Embedding response too large'));return;}chunks.push(chunk);});
      res.on('error',reject);res.on('end',()=>{
        try {
          invariant(res.statusCode===200,'OUTPUT_INVALID','Embedding unavailable; redirects forbidden');
          const vector=JSON.parse(Buffer.concat(chunks).toString()).data?.[0]?.embedding;
          invariant(Array.isArray(vector)&&vector.length===embedding.dimension,'OUTPUT_INVALID','Embedding dimension differs from pinned index');
          cosine(vector,vector);resolve(vector);
        } catch(e){reject(e);}
      });
    });
    req.on('error',reject);req.setTimeout(c.timeoutMs,()=>req.destroy(new Error('Embedding timeout')));req.end(body);
  });
}

export async function loadKnowledge(raw, {embed=embedText}={}) {
  const config=normalizeKnowledge(raw);
  if(config.mode==='off')return {retrieve:async()=>null};
  const bytes=await readFile(config.path);invariant(sha256(bytes)===config.sha256,'OUTPUT_INVALID','Knowledge index changed');
  const index=JSON.parse(bytes);
  invariant(index.version===KNOWLEDGE_VERSION&&Array.isArray(index.cards)&&index.cards.length,'OUTPUT_INVALID','Invalid knowledge index');
  invariant(new Set(index.cards.map(c=>c.id)).size===index.cards.length,'OUTPUT_INVALID','Duplicate knowledge card ID');
  for(const c of index.cards) {
    invariant(['diagnosis','repair'].includes(c.collection)&&['id','pattern_id','revision','source','applies_when','text'].every(k=>typeof c[k]==='string'&&c[k].trim()),'OUTPUT_INVALID','Incomplete knowledge card');
    invariant(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(c.id)&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(c.pattern_id),'OUTPUT_INVALID','Invalid knowledge card ID');
    invariant(c.source.startsWith('project-authored:')||c.source.startsWith('official-documentation:'),'OUTPUT_INVALID','Unknown knowledge provenance');
  }
  if(config.mode==='vector') {
    const e=index.embedding;
    invariant(e&&typeof e.id==='string'&&/^[a-f0-9]{64}$/.test(e.sha256)&&Number.isSafeInteger(e.dimension)&&e.dimension>0&&typeof e.query_prefix==='string'&&typeof e.document_prefix==='string','OUTPUT_INVALID','Vector index needs pinned encoder identity and encoding prefixes');
    invariant(Array.isArray(index.vectors)&&index.vectors.length===index.cards.length,'OUTPUT_INVALID','Missing document vectors');
    index.vectors.forEach(v=>{invariant(v.length===e.dimension,'OUTPUT_INVALID');cosine(v,v);});
  }
  return {config,index,retrieve:async({collection,query,signal,selectedIds})=>{
    invariant(['diagnosis','repair'].includes(collection),'OUTPUT_INVALID','Unknown collection');
    signal?.throwIfAborted();
    let vector=null;
    if(config.mode==='vector'&&!selectedIds)vector=await embed(index.embedding.query_prefix+query,{...config,embedding:index.embedding,signal});
    const q=tokens(query);
    const ranked=index.cards.map((c,i)=>({c,i})).filter(({c})=>c.collection===collection).map(({c,i})=>{
      const terms=tokens([c.pattern_id,c.applies_when,c.text,...(c.terms??[])].join(' '));
      const overlap=[...q].filter(t=>terms.has(t)).length;
      const score=selectedIds?Number(selectedIds.includes(c.id)):vector?cosine(vector,index.vectors[i]):overlap/Math.sqrt(Math.max(1,q.size*terms.size));
      return {card:c,score};
    }).filter(x=>selectedIds?selectedIds.includes(x.card.id):x.score>=config.minScore&&x.score>0).sort((a,b)=>b.score-a.score||a.card.id.localeCompare(b.card.id));
    if(selectedIds)invariant(new Set(selectedIds).size===selectedIds.length&&ranked.length===selectedIds.length,'OUTPUT_INVALID','Unknown manual control card; developer evaluation only');
    const documents=[];let chars=0;
    for(const {card} of ranked) {
      const view=cardView(card),size=JSON.stringify(view).length;
      if(documents.length>=config.maxDocuments||chars+size>config.maxChars)continue;
      documents.push({...view,sha256:cardHash(card)});chars+=size;
    }
    return {collection,index_sha256:config.sha256,documents};
  }};
}

export function diagnosisQuery(task,base,evidence) {
  return `SystemVerilog behavioral review\nSpecification: ${task.spec}\nCurrent RTL: ${base.rtl}\nObserved checks: ${evidence.map(e=>e.summary).join('\n')}`;
}
export function repairQuery(task,base,issues,evidence) {
  return `SystemVerilog local repair\nSpecification: ${task.spec}\nCurrent RTL: ${base.rtl}\nDiagnoses and goals: ${issues.map(i=>i.explanation+' '+i.repair_goal).join('\n')}\nObserved checks: ${evidence.map(e=>e.summary).join('\n')}`;
}
