import path from 'node:path';
import { mkdir, readdir, lstat, readFile, copyFile, cp, writeFile } from 'node:fs/promises';
import { sha256, invariant } from './snapshot.mjs';

async function copyRegular(source,destination,skipped) {
  await mkdir(destination,{recursive:true,mode:0o700});
  for(const name of await readdir(source)) {
    const from=path.join(source,name),to=path.join(destination,name),info=await lstat(from);
    if(info.isDirectory())await copyRegular(from,to,skipped);
    else if(info.isFile())await copyFile(from,to);
    else skipped.push({source:from,reason:'Non-regular tool artifact; not followed'});
  }
}
async function inventory(root,prefix='') {
  const result=[];
  for(const name of (await readdir(path.join(root,prefix))).sort()) {
    const relative=path.join(prefix,name),file=path.join(root,relative),info=await lstat(file);
    if(info.isDirectory())result.push(...await inventory(root,relative));
    else if(info.isFile())result.push({path:relative,bytes:info.size,sha256:sha256(await readFile(file))});
  }
  return result;
}
// Called only after MCP.close(), before deleting the owned workspace. The
// persistent copy survives the HTTP runner deleting its per-request output.
export async function archiveDualWork({workspace,sourceArchive,outputArchive,persistentRoot,cleanupConfirmed=true}) {
  invariant(path.isAbsolute(persistentRoot),'OUTPUT_INVALID','DUAL_EVIDENCE_ROOT must be absolute');
  const rel=path.relative(workspace,persistentRoot);
  invariant(rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel),'OUTPUT_INVALID','Evidence root must be outside the request workspace');
  await cp(sourceArchive,outputArchive,{recursive:true,errorOnExist:true,force:false});
  const eda=path.join(workspace,'.vivado-work'),skipped=[];
  try{await lstat(eda);await copyRegular(eda,path.join(outputArchive,'eda-runtime'),skipped);}catch(e){if(e.code!=='ENOENT')throw e;}
  const manifest={format:'rtl2llm.archive.v1',complete:cleanupConfirmed,
    mappings:[{source:path.join(workspace,path.basename(outputArchive)),archived:'.'},{source:eda,archived:'eda-runtime'}],skipped,
    files:await inventory(outputArchive)};
  await writeFile(path.join(outputArchive,'archive-index.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
  await mkdir(persistentRoot,{recursive:true,mode:0o700});
  const destination=path.join(persistentRoot,path.basename(outputArchive));
  await cp(outputArchive,destination,{recursive:true,errorOnExist:true,force:false});
  return {directory:destination,index_sha256:sha256(await readFile(path.join(destination,'archive-index.json'))),files:manifest.files.length,complete:cleanupConfirmed};
}
