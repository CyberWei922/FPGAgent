import { envelope, validateMessage } from './contracts.mjs';
import { invariant } from './snapshot.mjs';

// Template claims use the same literal-source and diagnostic-role checks as
// auxiliary claims, but remain independent of whether auxiliary analysis runs.
export function mergeConstraints(task, groups, protocol='rtl2llm.v1') {
  const constraints=[];
  for(const [namespace,items] of groups) {
    invariant(Array.isArray(items),'OUTPUT_INVALID','Constraints must be an array');
    for(const c of items) {
      const source=c.source??'spec';
      if(constraints.some(x=>x.source===source&&x.quote===c.quote&&x.claim===c.claim))continue;
      constraints.push({id:`${namespace}.${c.id}`,source,quote:c.quote,claim:c.claim});
    }
  }
  if(constraints.length) {
    const request=envelope('spec_request','constraints.check',task.id,{spec_text:task.spec,interface_text:task.interfaceText??'',rules:[]},protocol);
    validateMessage(envelope('spec_response',request.request_id,task.id,{status:'ready',constraints,ambiguities:[],reason:''},protocol),request);
  }
  return constraints;
}
