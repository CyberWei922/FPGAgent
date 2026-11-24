import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {lstat, readFile} from 'node:fs/promises';
import {invariant} from '../dual/snapshot.mjs';
import {repairPolicy} from '../harness/repair-policy.mjs';

export const AUTHOR_CONTROL_VERSION='rtl-author-control-v3';
export const AUTHOR_CONTROL_ABI='f114f91';
export function normalizeAuthorControl(raw={}) {
  invariant(raw&&typeof raw==='object'&&!Array.isArray(raw),'OUTPUT_INVALID','authorControl must be an object');
  invariant(Object.keys(raw).every(k=>['enabled','dry','convergence','directory'].includes(k)),'OUTPUT_INVALID','Unknown authorControl option');
  const c={enabled:false,dry:true,convergence:true,directory:null,...raw};
  for(const key of ['enabled','dry','convergence'])invariant(typeof c[key]==='boolean','OUTPUT_INVALID','Invalid authorControl '+key);
  if(c.enabled)invariant(typeof c.directory==='string'&&path.isAbsolute(c.directory)&&path.normalize(c.directory)!=='/','OUTPUT_INVALID','Author control requires a private local receipt directory');
  return c;
}

// A bounded policy, not an estimate of true task difficulty. Unknown plans get
// the larger allowance. Repetition must still be observed at a prose boundary.
export function authorBudget(plan,maxTokens,repairRoute) {
  invariant(Number.isSafeInteger(maxTokens)&&maxTokens>=4096,'OUTPUT_INVALID','Author control needs at least 4096 output tokens');
  const difficulty=plan?.difficulty?.level??plan?.difficulty??plan?.complexity;
  const policy=repairRoute?repairPolicy(repairRoute):null;
  const highRisk=!policy&&plan?.timing_risk==='high';
  const simple=policy?policy.band==='simple':!highRisk&&['simple','easy','low'].includes(difficulty);
  const normal=policy?policy.band==='moderate':!highRisk&&['medium','moderate'].includes(difficulty);
  const reserve=maxTokens-2048;
  return {band:simple?'simple':normal?'moderate':'complex_or_unknown',
    soft:Math.min(simple?3072:normal?4096:6144,reserve),
    late:Math.min(simple?6144:normal?8192:10240,reserve),reserve};
}
export const authorControlGuidance = format =>
  'Regular reasoning only; do not use Deep Thinking. Perform only the assigned generation or evidence-driven repair. Implement the frozen plan in this conversation; do not reopen architecture selection, compare alternative designs, mentally simulate test cases, or produce a second draft in this response. Keep any implementation notes brief and in plain prose. Put every RTL fragment, including a draft inside reasoning, in a fenced code block. Do not mix inline RTL with prose. If a genuine plan/specification conflict prevents implementation, report it; do not silently redesign or assert that advisory notes are infallible. '+
  (format==='rtl'?'Submit one complete <answer> block with one SystemVerilog fence and closing </answer>, then stop.':'Return only the required complete JSON repair object after reasoning; no preliminary or trailing JSON.');

async function rows(file) {
  let info;try{info=await lstat(file);}catch(e){if(e.code==='ENOENT')return [];throw e;}
  invariant(info.isFile()&&!info.isSymbolicLink()&&info.size<=2_000_000,'AUTHOR_CONTROL_UNAVAILABLE','Invalid native receipt');
  const text=await readFile(file,'utf8');
  return text.split('\n').slice(0,-1).filter(Boolean).map(line=>JSON.parse(line));
}
export async function checkAuthorBackend(directory) {
  let info;try{info=await lstat(directory);}catch{invariant(false,'AUTHOR_CONTROL_UNAVAILABLE','Native author controller directory is unavailable');}
  invariant(info.isDirectory()&&!info.isSymbolicLink()&&(info.mode&0o022)===0&&info.uid===process.getuid?.(),'AUTHOR_CONTROL_UNAVAILABLE','Native author controller requires an owned private directory');
  const receipts=await rows(path.join(directory,'capabilities.jsonl'));
  const receipt=receipts.at(-1);
  invariant(receipt?.version===AUTHOR_CONTROL_VERSION&&receipt.abi===AUTHOR_CONTROL_ABI&&receipt.loaded===true&&receipt.phase_dry===true&&receipt.convergence===true&&Number.isSafeInteger(receipt.pid),'AUTHOR_CONTROL_UNAVAILABLE','Version-pinned native controller has not acknowledged loading');
  try{process.kill(receipt.pid,0);}catch{invariant(false,'AUTHOR_CONTROL_UNAVAILABLE','Native author controller process is not alive');}
  return receipt;
}

// The transport remains one normal streaming request. The native sampler owns
// same-context convergence; an SSE connection cannot accept an extra message.
export async function controlledAuthor({control,model,plan,format='rtl',render,ctx,generate,candidateGate}) {
  const backend=await checkAuthorBackend(control.directory);
  const id=randomUUID().replaceAll('-',''),budget=authorBudget(plan,model.maxTokens,ctx.repairRoute);
  const marker=`__RTL_AUTHOR_V1__:${id}:${format}:${budget.soft}:${budget.late}:${budget.reserve}:${control.dry?1:0}:${control.convergence?1:0}`;
  const controlledModel={...model,extraBody:{...model.extraBody,
    dry_multiplier:0.35,dry_base:1.4,dry_allowed_length:6,dry_penalty_last_n:512,
    dry_sequence_breakers:['\n',':','"','*',marker]}};
  const request={version:AUTHOR_CONTROL_VERSION,request_id:id,backend,budget,repair_policy:ctx.repairRoute?repairPolicy(ctx.repairRoute):null,original_difficulty:plan?.difficulty??null,format,dry:control.dry,convergence:control.convergence,
    semantics:'output_phase_not_hidden_cognition',weights_modified:false};
  await ctx.saveRecord?.('author-control-request',request);ctx.onEvent?.({type:'author_control_request',...request});
  const abort=new AbortController(),signal=AbortSignal.any([abort.signal,...(ctx.signal?[ctx.signal]:[])]);
  const file=path.join(control.directory,id+'.jsonl');
  let native=[],failure,firstModelEvent=false,reading=false;
  async function poll() {
    if(reading)return;reading=true;
    try {
      const next=await rows(file);
      for(const row of next.slice(native.length)) {
        invariant(row.version===AUTHOR_CONTROL_VERSION&&row.abi===AUTHOR_CONTROL_ABI&&row.request_id===id,'AUTHOR_CONTROL_UNAVAILABLE','Native receipt identity mismatch');
        invariant(!(row.dry_enabled&&row.phase!=='analysis'),'AUTHOR_CONTROL_UNAVAILABLE','DRY enabled outside prose analysis');
        ctx.onEvent?.({type:'author_control_native',...row});
      }
      native=next;
      if(firstModelEvent)invariant(native.some(r=>r.event==='initialized'),'AUTHOR_CONTROL_UNAVAILABLE','Backend silently ignored the author control marker');
    } catch(e){failure=e;abort.abort(e);} finally{reading=false;}
  }
  const timer=setInterval(()=>void poll(),100);timer.unref?.();
  let result,error;
  try {
    result=await generate({model:controlledModel,...render,
      signal,thinkingLevel:'medium',candidateGate,onEvent:e=>{
        if(['thinking_delta','text_delta'].includes(e.type))firstModelEvent=true;
        ctx.onEvent?.(e);
      }});
  } catch(e){error=e;} finally {
    clearInterval(timer);
    while(reading)await new Promise(resolve=>setTimeout(resolve,10));
    await poll();
    await ctx.saveRecord?.('author-control-result',{...request,native,acknowledged:native.some(r=>r.event==='initialized'),error:failure?.code??error?.code??null});
  }
  if(failure)throw failure;
  invariant(native.some(r=>r.event==='initialized'),'AUTHOR_CONTROL_UNAVAILABLE','No request-level sampler acknowledgement');
  if(error)throw error;
  return {...result,authorControl:{...request,native}};
}
