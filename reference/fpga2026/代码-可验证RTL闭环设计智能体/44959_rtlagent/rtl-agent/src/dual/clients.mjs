import { checkOutputPolicy } from '../output-policy.mjs';
import { generateRtl } from '../model.mjs';
import { extractRtl } from '../workflow.mjs';
import { adaptPayload, parsePayload, renderRequest } from './render.mjs';
import { invariant } from './snapshot.mjs';
import { schemaFor } from './contracts.mjs';

export function fitContext(model,render,maxBytes,{inputTokens}={}) {
  // Conservative UTF-8 bytes upper-bound input tokens, with framing reserve.
  // Never silently truncate a spec/candidate or label a partial view full.
  const n=Buffer.byteLength(render.systemPrompt)+Buffer.byteLength(render.prompt);
  invariant(inputTokens===undefined||Number.isSafeInteger(inputTokens)&&inputTokens>0,'CONTEXT_OVERFLOW','Invalid token measurement');
  invariant(n<=maxBytes&&(inputTokens??n)+model.maxTokens+256<=model.contextWindow,'CONTEXT_OVERFLOW','Complete input does not fit context and output reserve; no truncation');
}
export function auxiliaryResponseFormat(request) {
  invariant(['spec_request','review_request'].includes(request.kind),'OUTPUT_INVALID','Auxiliary schema requires spec/review request');
  const schema=schemaFor(request.protocol);
  const definition=structuredClone(schema.$defs[request.kind==='spec_request'?'specResponse':'reviewResponse']);
  if(request.kind==='review_request') {
    delete definition.properties.candidate_sha256;
    definition.required=definition.required.filter(k=>k!=='candidate_sha256');
  }
  // Use the canonical nested OpenAI form. The observed backend silently ignored
  // type=json_schema with a top-level schema; real negative probes caught this.
  return {type:'json_schema',json_schema:{name:request.kind,strict:true,schema:{...definition,$defs:structuredClone(schema.$defs)}}};
}
export function createClients(config,generate=generateRtl) {
  const invoke=async(role,render,ctx,outputPolicy,responseFormat)=>{
    const source=role==='aux'?config.auxModel:config.mainModel;
    invariant(source,'AUX_UNAVAILABLE');
    fitContext(source,render,config.maxContextBytes);
    const model=structuredClone(source);if(responseFormat)model.extraBody={...model.extraBody,response_format:responseFormat};model.requestTimeoutMs=Math.max(1,Math.min(source.requestTimeoutMs??600000,ctx.deadline-Date.now()));
    await ctx.saveRecord?.('model-input',{...render,outputPolicy:outputPolicy??null,model:{id:model.id,contextWindow:model.contextWindow,maxTokens:model.maxTokens,temperature:model.temperature??null,topP:model.topP??null,reasoning:model.reasoning??false,reasoningBudget:model.reasoningBudget??null}});
    const result=await generate({model,...render,outputPolicy,signal:ctx.signal,thinkingLevel:model.reasoning?'medium':undefined,onEvent:e=>ctx.onEvent?.(e)});
    invariant(result.stopReason==='stop','OUTPUT_INVALID','Model did not complete normally');
    return result;
  };
  const auxiliary=async(req,ctx)=>{
    const result=await invoke('aux',renderRequest(req),ctx,undefined,config.constrainAuxJson?auxiliaryResponseFormat(req):undefined);
    return {...result,value:adaptPayload(req,parsePayload(result.text))};
  };
  return {
    analyze:auxiliary,review:auxiliary,
    generateComplete:async(task,constraints,ctx)=>{
      const render={systemPrompt:'Generate synthesizable Verilog/SystemVerilog. Preserve exact interface, timing, reset, widths and signedness. This is non-interactive. Return only the complete module(s) in one SystemVerilog fence; no testbench, external file access or simulation control. Original task overrides all advisory notes. You have no official testbench, reference or judge feedback.',
        prompt:JSON.stringify({spec:task.spec,interface:task.interfaceText??'',constraints,advisoryRules:task.rules??[],previousCandidate:task.previousCandidate??null,repairEvidence:task.repairEvidence??null,regenerationReason:task.regenerationReason??null,...(task.repairKnowledge?{advisoryRepairKnowledge:task.repairKnowledge}:{})})};
      const result=await invoke('main',render,ctx,{maxCommentChars:120});return {...result,rtl:extractRtl(result.text,task.top)};
    },
    generateReplacement:async(req,ctx)=>{const result=await invoke('main',renderRequest(req),ctx);const value=adaptPayload(req,parsePayload(result.text));
      invariant(!checkOutputPolicy(value.payload.replacements.map(r=>r.new_text).join('\n'),{maxCommentChars:120}),'OUTPUT_INVALID','Replacement exceeds existing comment budget');return {...result,value};},
  };
}
