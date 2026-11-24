import path from 'node:path';
import { stat, readFile, writeFile, rename, open } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dualIdentityReady } from './config.mjs';
import { invariant } from './snapshot.mjs';

export const IDENTITY_CACHE_SCHEMA='rtl2llm.weight-identity-cache.v1';
export const SAMPLE_BYTES=64*1024*1024;

// The full content hash is computed once per weight file and recorded, keyed by
// path, inode, size and mtime. ctime is deliberately not part of the key: the
// cloud NFS mount refreshes ctime every few seconds without any byte change,
// which previously forced a 23 GB re-hash on every request (~26 s per task).
// Each probe still hashes the first and last SAMPLE_BYTES and compares them with
// the recorded sample digest, so an in-place rewrite with a restored mtime is
// still rejected in practice. Small files are sampled completely.
const contentKey=(file,info,sha)=>`${file}:${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${sha}`;

async function sampleDigest(file,size,signal) {
  const hash=createHash('sha256');
  const ranges=size<=2*SAMPLE_BYTES?[[0,size]]:[[0,SAMPLE_BYTES],[size-SAMPLE_BYTES,size]];
  const handle=await open(file,'r');
  try {
    for(const [start,end] of ranges) {
      let at=start;const chunk=Buffer.allocUnsafe(Math.min(16*1024*1024,Math.max(1,end-start)));
      while(at<end){signal?.throwIfAborted();const {bytesRead}=await handle.read(chunk,0,Math.min(chunk.length,end-at),at);if(!bytesRead)break;hash.update(chunk.subarray(0,bytesRead));at+=bytesRead;}
    }
  } finally {await handle.close();}
  return hash.digest('hex');
}

async function fullDigest(file,signal) {
  const hash=createHash('sha256');for await(const bytes of createReadStream(file,{signal}))hash.update(bytes);return hash.digest('hex');
}

async function loadCache(cacheFile,read) {
  if(!cacheFile)return new Map();
  try {
    const value=JSON.parse(await read(cacheFile,'utf8'));
    if(value?.schema!==IDENTITY_CACHE_SCHEMA||!Array.isArray(value.entries)||value.entries.length>16)return new Map();
    const ok=e=>e&&typeof e.key==='string'&&e.key.length<=4096&&/^[0-9a-f]{64}$/.test(e.sample_sha256??'');
    return new Map(value.entries.filter(ok).map(e=>[e.key,e.sample_sha256]));
  } catch {return new Map();}
}

async function storeCache(cacheFile,entries,write) {
  if(!cacheFile)return;
  // Best effort: a cache that cannot be written only costs another full hash.
  try {
    const tmp=`${cacheFile}.${randomUUID()}.tmp`;
    await write(tmp,JSON.stringify({schema:IDENTITY_CACHE_SCHEMA,entries:[...entries].slice(-16).map(([key,sample_sha256])=>({key,sample_sha256}))},null,2)+'\n',{mode:0o600,flag:'wx'});
    await rename(tmp,cacheFile);
  } catch {}
}

export function createDualProbe({statFile=stat,fetchModels=async (model,signal)=>{
  const r=await fetch(model.baseUrl.replace(/\/$/,'')+'/models',{signal:signal?AbortSignal.any([signal,AbortSignal.timeout(2000)]):AbortSignal.timeout(2000)});
  invariant(r.ok,'AUX_UNAVAILABLE');return (await r.json()).data?.map(m=>m.id)??[];
},cacheFile=null,readCache=readFile,writeCache=writeFile,sample=sampleDigest,fullHash=fullDigest}={}) {
  let verified=null;
  return async (config,{signal}={})=>{
    const c=config.dual??config,identity=dualIdentityReady(c);
    if(!identity.ready)return {...identity,dual_ready:false};
    try {
      verified??=await loadCache(cacheFile,readCache);
      for(const model of [c.mainModel,c.auxModel]) {
        signal?.throwIfAborted();
        const file=model.identity.path;invariant(path.isAbsolute(file),'AUX_UNAVAILABLE','Absolute local weight path required');
        const info=await statFile(file);invariant(info.isFile(),'AUX_UNAVAILABLE','Weight file unavailable');
        const key=contentKey(file,info,model.identity.sha256);
        if(verified.has(key)) {
          invariant(await sample(file,info.size,signal)===verified.get(key),'AUX_UNAVAILABLE','Weight sample changed since full verification');
        } else {
          const digest=await fullHash(file,signal);
          const after=await statFile(file);
          invariant(digest===model.identity.sha256&&after.isFile()&&contentKey(file,after,model.identity.sha256)===key,'AUX_UNAVAILABLE','Weight identity mismatch');
          verified.set(key,await sample(file,after.size,signal));
          await storeCache(cacheFile,verified,writeCache);
        }
        invariant((await fetchModels(model,signal)).includes(model.id),'AUX_UNAVAILABLE','Local served model unavailable or identity differs');
      }
      return {ready:true,dual_ready:true,reason:null};
    } catch(error){return {ready:false,dual_ready:false,reason:error.code??'AUX_UNAVAILABLE'};}
  };
}
