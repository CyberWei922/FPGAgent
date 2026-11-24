import {invariant,sha256} from '../dual/snapshot.mjs';
import {temporalMarkdown} from '../planner/temporal-contract.mjs';
import {moduleContract,moduleHeader,topInterfaceSource} from './contracts.mjs';

export function sharedMarkdown(task,plan) {
  invariant(plan.spec_sha256===sha256(task.spec)&&plan.interface_sha256===sha256(task.interfaceText??''),'STALE_SNAPSHOT');
  const a=plan.architecture;invariant(a,'PLAN_MODULE_INVALID');
  return `# Shared project contract\n\nContract SHA256: ${a.sha256}\nOriginal specification overrides ALL advisory notes. Source matches and structural validation are not semantic proof. No hidden tests/reference/judge data.\n\n## original_spec\n\n${task.spec}\n\n## interface\n\n${task.interfaceText}\n\n## timing\n\n${plan.temporal?temporalMarkdown(plan.temporal):plan.sections.Timing}\n\n## global_contract\n\n${JSON.stringify({clock:a.clock,reset:a.reset,nets:a.nets,modules:a.modules.map(m=>({name:m.name,purpose:m.purpose})),order:a.order},null,2)}\n\n## ambiguities\n\n${plan.sections.Ambiguities}\n`;
}
export function moduleHandoff({task,plan,name,constraints=[],project=null,sources={},evidence=[],diagnosis='',previousAttempts=[],authorStage=null}) {
  const a=plan.architecture,m=moduleContract(a,name),top=name===a.top.name;
  if(project)invariant(project.architecture_sha256===a.sha256,'STALE_SNAPSHOT');
  const local=project?.modules.find(m=>m.name===name)?.rtl??sources[name]??'';
  const connected=new Set(m.ports.map(p=>p.net).filter(Boolean));
  const neighbors=a.modules.filter(n=>n.name!==name&&(top||n.ports.some(p=>connected.has(p.net))));
  const reqIds=new Set(top?plan.constraints.map(r=>r.id):m.requirements);
  // Planner requirements below come from the CURRENT contract version. Never
  // reintroduce old auxiliary claims after a contract revision, or duplicate them.
  const required=constraints.filter(c=>!c.id?.startsWith('aux.'));
  const selectedRequirements=plan.constraints.filter(r=>reqIds.has(r.id));
  const body=[sharedMarkdown(task,plan),'## top_interface_provenance\n\n'+JSON.stringify(topInterfaceSource(task).provenance)+'\nOriginal arithmetic meaning remains authoritative; project connection types are not new functional requirements.',`# Current session — ${top?'integration':local?'repair':'implementation'}\n\nTarget module: ${name}\nProject SHA256: ${project?.sha256??'not assembled'}\nTarget SHA256: ${local?sha256(local):'none'}\nGoal: ${top?'Connect each frozen leaf exactly once without introducing behavior or latency.':m.session_goal}`,
    `## module_contract\n\n${JSON.stringify(m,null,2)}`,
    `## requirements\n\n${JSON.stringify({source_requirements:selectedRequirements,additional_constraints:required},null,2)}`,
    `## neighbor_contracts\n\n${JSON.stringify(neighbors.map(n=>({name:n.name,ports:n.ports,timing:n.timing,state_owner:n.state_owner,...(n.paths?{paths:n.paths}:{})})),null,2)}`];
  if(top)body.push('## existing_module_interfaces\n\n'+a.order.map(n=>moduleHeader(moduleContract(a,n))+'\nSource SHA256: '+sha256(project?.modules.find(m=>m.name===n)?.rtl??sources[n]??'')).join('\n\n'));
  if(local)body.push('## current_code (verbatim)\n\n'+local);
  if(local||evidence.length||diagnosis)body.push('## evidence\n\n'+JSON.stringify(evidence,null,2),'## diagnosis (advisory)\n\n'+(diagnosis||'Use only observed failures; do not invent a failure.'));
  if(!authorStage&&(top||m.carry.includes('verification')))body.push('## verification_proposals\n\n'+plan.sections.Verification+'\nProposals are not executed checks.');
  if(local||top||m.carry.includes('previous_attempts'))body.push('## previous_attempts\n\n'+JSON.stringify(previousAttempts,null,2));
  body.push(`## edit_scope\n\nReturn only ONE complete module named ${name}. All other modules and ALL interfaces are read-only. No prior chat is implicit. Do not read/write tests. If a contract seems wrong, preserve it for this request; only the planner can authorize a versioned revision.\n\n## final_reminder\n\nPreserve port order, ranges, signedness, clock/reset, cycle latency and simultaneous-event priority. Finish the requested module; tool checks follow your submission. No extra modules or unrequested pipeline/handshake.`);
  return body.join('\n\n')+'\n';
}
export function diagnosisRequest(task,plan,project,evidence,{compact=false,selfTestScope=null,selfTestAssurance=null}={}) {
  const checkerScope=selfTestScope||selfTestAssurance?'\n## self_test_scope_and_assurance (advisory, not proof)\n\n'+JSON.stringify({scope:selfTestScope,assurance:selfTestAssurance})+'\nCheck the oracle against the original specification. Partial self-test passes do not prove untested behavior; a reviewed checker may still be wrong.\n':'';
  return {systemPrompt:`You are the 27B diagnostician, never the RTL author. Return one JSON object only, no code. Required keys: action, target, evidence_ids, reason${compact?', goal, preserve':''}. action is repair_module, revise_contract, or stop. target is an existing module name for repair_module, otherwise null. evidence_ids must cite observed FAILED checks supplied below; do not invent failures. reason is concise prose (max 800 characters) grounded in the original task. A suspect/insufficient checker requires stop, not code changes. revise_contract is for an incorrect module boundary/temporal contract, not an RTL implementation bug.${compact?' goal is one short required behavioral correction, preserve is an array of at most four short invariants. For stop state the obstacle in goal. Trace the first failure and same-cycle assignments/overwrites; do not explain the entire design.':''}`,
    prompt:sharedMarkdown(task,plan)+'\n## full_architecture\n\n'+JSON.stringify(plan.architecture)+'\n## current_project (verbatim)\n\n'+project.rtl+checkerScope+'\n## observed_checks\n\n'+JSON.stringify(evidence)+'\nProject SHA256: '+project.sha256};
}
