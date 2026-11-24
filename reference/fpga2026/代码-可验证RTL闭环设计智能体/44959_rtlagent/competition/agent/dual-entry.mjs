import { RTL_LINT_RULES, runRtlLint, rtlLintFeedback } from '../../rtl-agent/src/rtl-lint.mjs';
import { portContract } from '../../rtl-agent/src/dual/unit-index.mjs';
import path from 'node:path';
import { mkdir, readFile, writeFile, cp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { runDual } from '../../rtl-agent/src/dual/controller.mjs';
import { checkerIdentity } from '../../rtl-agent/src/dual/evidence-policy.mjs';
import { createDualProbe } from '../../rtl-agent/src/dual/readiness.mjs';
import { id, invariant, sha256 } from '../../rtl-agent/src/dual/snapshot.mjs';
import {randomBench,voteSeedKey} from './resample-vote.mjs';
import { checkInterface } from './interface.mjs';
import { prepareSelfCheck, assertCheckerUnchanged, failureHistory } from '../../rtl-agent/src/self-check.mjs';
import { freezeTask } from '../../rtl-agent/src/task-snapshot.mjs';
import { loadSkillCatalog, selectSkills } from '../../rtl-agent/src/skills.mjs';
import { atomicWrite } from './main.mjs';

export async function runDualCompetition({config,task,prompt,interfaceText,expected,workspace,outputDir,mcp,record,signal,deadline,generate,persistentRoot,registerArchive=()=>{},onPublish=()=>{},identityCacheFile=null}) {
  invariant(config.agent.rag.mode==='off'&&config.agent.rtlPrecheck.mode==='off'&&!config.agent.selfCheck.diagnose&&['off','templates'].includes(config.agent.selfCheck.mode),'OUTPUT_INVALID','Dual v1 disables RAG/Slang/old diagnostic role');
  invariant(config.agent.rtlLint?.mode!=='slang'||config.dual?.harness?.repairRouting===true,'OUTPUT_INVALID','RTL lint requires harness.repairRouting');
  const directory=path.join(workspace,'dual-'+id('run'));await mkdir(directory);
  registerArchive({workspace,sourceArchive:directory,outputArchive:path.join(outputDir,path.basename(directory)),persistentRoot});
  // Full weight hashes are recorded once per service (see readiness.mjs); each
  // request re-checks file metadata and a head/tail sample instead of 23 GB.
  const identity=await createDualProbe({cacheFile:identityCacheFile})(config,{signal});
  record({tool:'dual_readiness',workflow_mode:config.workflowMode,dual_ready:identity.ready,reason:identity.reason});
  let selfCheck=null,frozenTask=task,taskPath=path.join(workspace,'dual-task.json');
  let selfTestStatus={status:config.agent.selfCheck.mode==='off'?'disabled':'unavailable',reason:'not_prepared',official_functional_verified:false};
  const baseCheckers=[{id:'interface',stage:'interface',version:'interface.mjs',identity:sha256(await readFile(new URL('./interface.mjs',import.meta.url)))},
    ...(config.agent.rtlLint?.mode==='slang'?[{id:'lint',stage:'lint',version:'rtl-lint.v1',rules:RTL_LINT_RULES,identity:sha256(await readFile(new URL('../../rtl-agent/src/rtl-lint.py',import.meta.url)))}]:[]),
    {id:'compile',stage:'compile',version:'configured_mcp',backend:mcp.metadata??null,config_sha256:sha256(JSON.stringify(config.vivado))},
    {id:'synthesize',stage:'synthesize',version:'configured_mcp',backend:mcp.metadata??null,config_sha256:sha256(JSON.stringify(config.vivado))}];
  // Select existing offline rules without a second main-model classifier. Rules
  // remain conditional/advisory and are frozen before the first aux request.
  const selected=config.skills.enabled?await selectSkills({catalog:await loadSkillCatalog(config.skills),task,config:{...config.skills,maxChars:3000},presentation:'summary'}):null;
  const rules=selected?.text?[{id:'offline.selected',text:selected.text,applies_when:'Only where compatible with explicit original specification; no task IDs or oracle lookup.'}]:[];
  await writeFile(path.join(directory,'rules.json'),JSON.stringify(selected??{},null,2));
  const result=await runDual({config:identity.ready?config:{...config,dual:{...config.dual,auxModel:null}},task:{...task,spec:prompt,interfaceText,rules},checkers:baseCheckers,directory,signal,deadline:deadline-Math.min(4500,Math.max(0,(deadline-Date.now())*.1)),generate,
    prepareChecks:async(ctx)=>{
      // Keep proven templates fast. Only the auxiliary planner can provide
      // missing test semantics; preparation never calls the RTL author.
      if(config.agent.selfCheck.mode!=='off') {
        const templateConfig=structuredClone(config);templateConfig.agent.selfCheck.mode='templates';templateConfig.agent.selfCheck.templateFastPath=true;
        selfCheck=await prepareSelfCheck({task,expected,config:templateConfig,workspace,check:a=>mcp.check(a),signal:ctx.signal,
          onRecord:e=>{record(e);if(e.tool==='self_test_unavailable')selfTestStatus={status:'unavailable',reason:e.reason,detail:e.detail??null,official_functional_verified:false};},planProvider:ctx.requestTestPlan});
      }
      if(selfCheck)selfTestStatus={status:'available',coverage:'partial',expected_values_validated:false,comparisons:selfCheck.plan.expectedChecks,uncovered:selfCheck.plan.coverage?.uncovered??['Finite template checks, not exhaustive functional verification.'],official_functional_verified:false};
      await writeFile(path.join(directory,'self-test-status.json'),JSON.stringify(selfTestStatus,null,2));
      if(selfCheck)await cp(selfCheck.directory,path.join(directory,'self-check-preparation'),{recursive:true});
      const candidateTask=selfCheck?.task??task;
      await writeFile(taskPath,JSON.stringify(candidateTask));
      frozenTask=await freezeTask({task:candidateTask,taskPath,workspaceRoot:workspace,runDir:directory});
      await writeFile(path.join(directory,'task.json'),JSON.stringify(frozenTask));
      const checkers=[...baseCheckers];
      if(selfCheck)checkers.push({id:'simulate',stage:'simulate',version:selfCheck.plan.source_schema_version===2?'frozen_spec_scenarios_v2':'frozen_spec_template',bench_sha256:selfCheck.benchSha256});
      return {task:frozenTask,checkers};
    },
    voteCandidates:async(eligible,ctx)=>{
      const bench=randomBench(expected,voteSeedKey(prompt,interfaceText)),rows=[];
      for(const {candidate} of eligible){
        const workDir=path.join(directory,'resample-vote',candidate.id);await mkdir(workDir,{recursive:true});
        const rtlPath=path.join(workDir,'candidate.sv'),tbPath=path.join(workDir,'random.sv');
        await writeFile(rtlPath,candidate.rtl,{flag:'wx'});await writeFile(tbPath,bench,{flag:'wx'});
        const voteTask={id:task.id,top:expected.top,stages:['compile','simulate'],testbench:{path:tbPath,top:'rtl_random_tb',resultFile:'selftest_result.txt',expectedChecks:1,origin:'self_generated_spec_vectors'}};
        const taskPath=path.join(workDir,'task.json');await writeFile(taskPath,JSON.stringify(voteTask),{flag:'wx'});
        const result=await mcp.check({rtlPath,task:voteTask,taskPath,config:{...config.vivado,maxThreads:2},workDir,signal:ctx.signal});
        await writeFile(path.join(workDir,'tool-result.json'),JSON.stringify(result,null,2));
        let trace=null;try{trace=await readFile(path.join(result.artifactDir,'random_trace.txt'),'utf8');}catch{}
        const valid=result.passed&&trace?.trim().split('\n').length===256;
        if(trace)await writeFile(path.join(workDir,'random_trace.txt'),trace,{flag:'wx'});
        rows.push({candidate_id:candidate.id,candidate_sha256:candidate.sha256,status:valid?'pass':'invalid',trace_sha256:valid?sha256(trace):null,bench_sha256:sha256(bench),rows:trace?.trim().split('\n').length??0,functional_oracle:false});
      }
      await writeFile(path.join(directory,'resample-votes-'+id('batch')+'.json'),JSON.stringify(rows,null,2));return rows;
    },
    verifyModule:async({name,rtl,architecture,sources},ctx)=>{
      const workDir=path.join(directory,'module-tools',id('check'));await mkdir(workDir,{recursive:true});
      // Leaf compilation gets only its own source. Integration compilation gets
      // the exact already-generated leaves. No dummy modules or oracle stubs.
      const source=name===architecture.top.name?[rtl,...architecture.order.map(n=>sources[n])].join('\n'):rtl;
      const rtlPath=path.join(workDir,'candidate.sv');await writeFile(rtlPath,source,{flag:'wx'});
      const moduleTask={id:task.id,top:name,spec:prompt,stages:['compile'],clockPeriodNs:task.clockPeriodNs};
      const moduleTaskPath=path.join(workDir,'task.json');await writeFile(moduleTaskPath,JSON.stringify(moduleTask),{flag:'wx'});
      const input={rtlPath,task:moduleTask,taskPath:moduleTaskPath,config:config.vivado,workDir,signal:ctx.signal};
      await writeFile(path.join(workDir,'tool-input.json'),JSON.stringify({...input,signal:undefined},null,2));
      const validation=await mcp.check(input);await writeFile(path.join(workDir,'tool-result.json'),JSON.stringify(validation,null,2));
      const stage=validation.stages?.find(s=>s.name==='compile');
      const status=stage?.status==='skipped'?'unknown':stage?.status??'unknown';
      const serialized=JSON.stringify(stage??{reason:'Module compile stage not executed'}),evidenceId=id('evidence');
      return {candidate_sha256:sha256(rtl),compiled_source_sha256:sha256(source),functional_verified:false,
        infrastructure_error:['error','timeout'].includes(status),checks:[{id:'compile',stage:'compile',status,evidence:{id:evidenceId,source:'compiler',
          summary:serialized.length>3200?serialized.slice(0,3200)+' [summary truncated; full tool-result.json saved]':serialized},record:{file:path.relative(directory,path.join(workDir,'tool-result.json')),path_scope:'run_directory',sha256:sha256(JSON.stringify(validation,null,2))}}]};
    },
    verifyCandidate:async(base,checkers,ctx)=>{
      const workDir=path.join(directory,'tools',base.id);await mkdir(workDir,{recursive:true});
      const rtlPath=path.join(workDir,'candidate.sv');await writeFile(rtlPath,base.rtl,{flag:'wx'});
      const iface=checkInterface(base.rtl,expected);
      if(interfaceText) {
        const wanted=portContract(interfaceText),actual=portContract(base.rtl);
        if(wanted&&actual&&JSON.stringify(wanted)!==JSON.stringify(actual)){iface.rc=1;iface.blocking=true;iface.excerpt+='; ANSI port order/signedness/range differs from explicit interface';}
        else if(wanted&&!actual){iface.rc=null;iface.excerpt+='; Full interface preservation cannot be proven';}
      }
      const executable=base.rtl.replace(/"(?:\\[\s\S]|[^"\\])*"|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,t=>t.startsWith('"')?'""':' ');
      const forbidden=/\$(?:readmem[bh]|writemem[bh]|sdf_annotate)\b/i.test(executable);
      let lint=null;
      if(checkers.some(c=>c.stage==='lint')){
        lint=await runRtlLint({rtl:base.rtl,top:task.top,workDir,options:config.agent.rtlLint,signal:ctx.signal});
        record({tool:'rtl_lint',status:lint.status,codes:lint.findings.map(f=>f.code),duration_ms:lint.durationMs,other_codes:lint.otherCodes});
      }
      let validation={stages:[]};
      if(!forbidden&&!iface.blocking) {
        if(selfCheck)await assertCheckerUnchanged(frozenTask.testbench.path,selfCheck.benchSha256);
        const input={rtlPath,task:frozenTask,taskPath:path.join(directory,'task.json'),config:config.vivado,workDir,signal:ctx.signal};
        await writeFile(path.join(workDir,'tool-input.json'),JSON.stringify({...input,signal:undefined},null,2));
        validation=await mcp.check(input);
      }
      const checks=[];
      for(const checker of checkers) {
        const stage=validation.stages.find(s=>s.name===checker.stage);
        // EDA skips later stages after a real failure. Keep that failure usable
        // and represent only the unexecuted stage as unknown in the dual contract.
        const status=checker.stage==='interface'?(iface.rc===0&&!forbidden?'pass':iface.blocking||forbidden?'fail':'unknown'):
          checker.stage==='lint'?(['pass','fail'].includes(lint?.status)?lint.status:'unknown'):
          (stage?.status==='skipped'?'unknown':stage?.status??'unknown');
        const full=checker.stage==='interface'?{...iface,forbidden}:checker.stage==='lint'?lint:stage??{status:'unknown',reason:'Stage not executed'};
        const evidenceId=id('evidence'),file=path.join(workDir,evidenceId+'.json');await writeFile(file,JSON.stringify(full,null,2));
        const source={interface:'interface_check',lint:'static_analysis',compile:'compiler',simulate:'self_test',synthesize:'synthesis'}[checker.stage];
        // Bounded summaries retain the full evidence file/hash and explicitly
        // label truncation; never claim a clipped diagnostic is full evidence.
        const trace=checker.stage==='simulate'&&validation.observation;
        const text=JSON.stringify(full),history=!trace&&config.dual?.verification?.enabled&&checker.stage==='simulate'&&status==='fail'&&selfCheck?failureHistory(selfCheck.plan,validation.feedback??text,{maxChars:2400}):null;
        const textLimit=history?1300:3200;
        const summary=checker.stage==='lint'?`lint: ${status}. ${status==='fail'?rtlLintFeedback(lint):lint?.reason}`:`${checker.id}: ${status}. ${text.length>textLimit?text.slice(0,textLimit)+' [summary truncated; full log saved]':text}`+(history?'\nFrozen input history (expected values are hypotheses): '+JSON.stringify(history):'');
        checks.push({id:checker.id,stage:checker.stage,status,evidence:{id:evidenceId,source,summary,...(trace?{observation:JSON.stringify(trace)}:{})},record:{file:path.relative(directory,file),path_scope:'run_directory',sha256:sha256(await readFile(file))}});
      }
      await writeFile(path.join(workDir,'tool-result.json'),JSON.stringify(validation,null,2));
      return {candidate_sha256:base.sha256,checker_set_sha256:checkerIdentity(checkers),checks,infrastructure_error:checks.some(c=>['error','timeout'].includes(c.status))};
    },
    onEvent:event=>record({tool:'dual',...event}),
    onCandidate:async base=>{await atomicWrite(path.join(outputDir,'solution.v'),base.rtl);onPublish(base);},
  });
  record({tool:'selection',workflow_mode:config.workflowMode,sha256:result.candidate?.sha256??null,checks:result.evidence?.checks??[],
    reason:result.reason,self_test:selfTestStatus,functional_coverage:result.functional_coverage??null,dual_ready:identity.ready,aux_unavailable:result.aux_unavailable,main_model_attempts:result.main_calls,aux_model_attempts:result.aux_calls,model_calls:result.main_calls+result.aux_calls,functional_verified:false});
  const response={solved:Boolean(result.candidate),workflow_mode:config.workflowMode,dual_ready:identity.ready,aux_unavailable:result.aux_unavailable,checks:result.evidence?.checks??[],reason:result.reason,self_test:selfTestStatus,functional_coverage:result.functional_coverage??null,functional_verified:false};
  return response;
}
