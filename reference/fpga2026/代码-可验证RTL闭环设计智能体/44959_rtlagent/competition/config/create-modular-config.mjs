import path from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {plannerRuntimeConfig} from './create-planner-config.mjs';
import {normalizeDual} from '../../rtl-agent/src/dual/config.mjs';

// Explicit stage-2 entry. Existing phase-1 configurations and frozen experiments
// do not silently acquire physical modules or different planner limits.
export async function modularRuntimeConfig(env=process.env) {
  const base=await plannerRuntimeConfig({...env,AGENT_NL2SPEC:env.AGENT_NL2SPEC??'1'});
  const dual=normalizeDual({...base.dual,plannerPhase2:true,modular:{registeredFeedback:env.AGENT_REGISTERED_FEEDBACK==='1'}},base.model);
  return {...base,workflowMode:'planner_v2',dual};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  if(process.argv.length!==3)throw new Error('Usage: create-modular-config.mjs <new-output.json>');
  const output=path.resolve(process.argv[2]);await mkdir(path.dirname(output),{recursive:true});
  await writeFile(output,JSON.stringify(await modularRuntimeConfig(),null,2)+'\n',{mode:0o600,flag:'wx'});
}
