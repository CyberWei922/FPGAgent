import path from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { runtimeConfig } from './create-config.mjs';
import { normalizeDual } from '../../rtl-agent/src/dual/config.mjs';

// This is a configuration generator for already prepared local services. It
// never starts servers, downloads weights, or changes the legacy declaration.
export async function dualRuntimeConfig(env=process.env) {
  if ((env.AGENT_RAG && env.AGENT_RAG !== 'off') || (env.AGENT_RTL_PRECHECK && env.AGENT_RTL_PRECHECK !== 'off') || env.AGENT_DIAGNOSTIC_ROLE === '1' || (env.AGENT_SELF_TEST && !['off','templates'].includes(env.AGENT_SELF_TEST))) throw new Error('Dual v1 requires RAG/Slang/legacy diagnostic off and self-test off/templates');
  const base=runtimeConfig({...env,AGENT_RAG:'off',AGENT_RTL_PRECHECK:'off',AGENT_DIAGNOSTIC_ROLE:'0',AGENT_SELF_TEST:env.AGENT_SELF_TEST??'templates'});
  const identity={path:env.MODEL_PATH??null,revision:env.MAIN_MODEL_REVISION??null,sha256:env.MAIN_MODEL_SHA256??null,quantization:'UD-Q4_K_M'};
  const aux=env.DUAL_AUX_CONFIG?JSON.parse(await readFile(path.resolve(env.DUAL_AUX_CONFIG),'utf8')):null;
  const bool=(name,fallback)=>{if(env[name]===undefined)return fallback;if(!['0','1'].includes(env[name]))throw new Error(`${name} must be 0 or 1`);return env[name]==='1';};
  const protocolVersion=env.DUAL_PROTOCOL??'rtl2llm.v1',v2=protocolVersion==='rtl2llm.v2';
  const knowledge=env.DUAL_KNOWLEDGE_CONFIG?JSON.parse(await readFile(path.resolve(env.DUAL_KNOWLEDGE_CONFIG),'utf8')):{mode:'off'};
  const dual=normalizeDual({mainModel:{...structuredClone(base.model),identity},auxModel:aux,
    protocolVersion,knowledge,enableIssuePackages:bool('DUAL_ISSUE_PACKAGES',v2),enableRepairReview:bool('DUAL_REPAIR_REVIEW',v2),
    enableSpecAnalysis:bool('DUAL_SPEC_ANALYSIS',!v2),enablePostReview:bool('DUAL_POST_REVIEW',true),repairMode:env.DUAL_REPAIR_MODE??'local_first',
    maxRepairAttempts:base.agent.maxRepairs,totalTimeoutMs:base.agent.totalTimeoutMs,retryNormalEmpty:true,regenerateWithoutRtl:false},base.model);
  return {...base,workflowMode:'dual_v1',dual};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  if(process.argv.length!==3)throw new Error('Usage: create-dual-config.mjs <private-output.json>');
  const output=path.resolve(process.argv[2]);await mkdir(path.dirname(output),{recursive:true});
  await writeFile(output,JSON.stringify(await dualRuntimeConfig(),null,2)+'\n',{mode:0o600,flag:'wx'});
}
