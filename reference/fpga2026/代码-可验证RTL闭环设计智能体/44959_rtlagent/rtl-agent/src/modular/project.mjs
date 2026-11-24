import {invariant,sha256,snapshot} from '../dual/snapshot.mjs';
import {checkModuleSource} from './contracts.mjs';

export function projectSnapshot(architecture,sources,parent=null) {
  const names=[architecture.top.name,...architecture.order];
  invariant(Object.keys(sources).length===names.length&&names.every(n=>Object.hasOwn(sources,n)),'PROJECT_INCOMPLETE');
  const modules=names.map(name=>{
    const rtl=sources[name];checkModuleSource(rtl,architecture,name);
    return Object.freeze({name,rtl,sha256:sha256(rtl)});
  });
  // Packaging only: model-written bytes are preserved, no synthesized behavior.
  const candidate=snapshot(modules.map(m=>m.rtl).join('\n'),parent);
  return Object.freeze({...candidate,architecture_sha256:architecture.sha256,modules:Object.freeze(modules)});
}
export function replaceModule(project,architecture,name,rtl,{baseSha256,contractSha256}={}) {
  invariant(project.sha256===baseSha256&&project.architecture_sha256===contractSha256&&architecture.sha256===contractSha256,'STALE_SNAPSHOT','Project/contract changed since repair request');
  invariant(project.modules.some(m=>m.name===name),'MODULE_UNKNOWN');
  const next=projectSnapshot(architecture,Object.fromEntries(project.modules.map(m=>[m.name,m.name===name?rtl:m.rtl])),project);
  invariant(next.sha256!==project.sha256,'NO_CHANGE');
  for(const m of project.modules)if(m.name!==name)invariant(next.modules.find(n=>n.name===m.name).sha256===m.sha256,'PATCH_SCOPE_VIOLATION');
  return next;
}
export function revisionImpact(before,after) {
  const changed=after.modules.filter(m=>JSON.stringify(m)!==JSON.stringify(before.modules.find(x=>x.name===m.name))).map(m=>m.name);
  // A changed common clock/reset/net contract invalidates all dependent leaf
  // evidence. First version safely rebuilds every leaf on any contract revision.
  return {changed_modules:changed,regenerate:[...after.order,after.top.name],policy:'all_modules_on_contract_revision',
    old_contract_sha256:before.sha256,new_contract_sha256:after.sha256};
}
