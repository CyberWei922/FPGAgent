import {createHash} from 'node:crypto';
import {extractRtl} from '../workflow.mjs';
import {portContract} from '../dual/unit-index.mjs';
import {applyLocalRepair} from '../dual/local-repair.mjs';
import {expectedInterface, checkInterface} from '../../../competition/agent/interface.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');

// A bounded lexical gate, NOT a compiler or a functional correctness check.
// In particular, tags/fences inside RTL comments or strings cannot end a draft.
function lexicalView(code) {
  let out='', mode='code';
  for(let i=0;i<code.length;i++) {
    const c=code[i], n=code[i+1];
    if(mode==='line') { if(c==='\n'){mode='code';out+='\n';} else out+=' '; }
    else if(mode==='block') { if(c==='*'&&n==='/'){out+='  ';i++;mode='code';} else out+=c==='\n'?'\n':' '; }
    else if(mode==='string') { if(c==='\\'){out+='  ';i++;} else {out+=' ';if(c==='"')mode='code';} }
    else if(c==='/'&&n==='/'){out+='  ';i++;mode='line';}
    else if(c==='/'&&n==='*'){out+='  ';i++;mode='block';}
    else if(c==='"'){out+=' ';mode='string';}
    else out+=c;
  }
  return {text:out,closed:mode==='code'||mode==='line'};
}

function completeStructure(raw, top) {
  const {text,closed}=lexicalView(raw);
  if(!closed||text.includes('...')||/[`\\]/.test(text))return false;
  const tokens=text.match(/[A-Za-z_$][\w$]*|[^\s]/g)??[];
  if(tokens[0]!=='module'||tokens[1]!==top||tokens.at(-1)!=='endmodule')return false;
  const ends={module:'endmodule',begin:'end',case:'endcase',casex:'endcase',casez:'endcase',
    generate:'endgenerate',function:'endfunction',task:'endtask','(':')','[':']','{':'}'};
  const closing=new Set(Object.values(ends)),stack=[];let modules=0;
  for(const token of tokens) {
    if(token==='module')modules++;
    if(Object.hasOwn(ends,token))stack.push(ends[token]);
    else if(closing.has(token)&&stack.pop()!==token)return false;
  }
  return modules===1&&stack.length===0;
}

export function createEarlyHandoff(task, options={}) {
  let expected,exact;
  try {
    expected=expectedInterface(task.spec,task.interfaceText??'',task.top);
    if(expected.top!==task.top||!expected.ports.length||expected.unresolved.length)return null;
    exact=task.interfaceText?.trim()?portContract(task.interfaceText):null;
    if(task.interfaceText?.trim()&&!exact)return null;
  } catch {return null;}
  const inspect=raw=>{
    if(!completeStructure(raw,task.top))return null;
    try {
      const rtl=extractRtl(raw,task.top),actual=portContract(rtl);
      if(!actual||checkInterface(rtl,expected).rc!==0)return null;
      if(exact&&JSON.stringify(actual)!==JSON.stringify(exact))return null;
      // The supported natural-language port-list form has unsigned [N-1:0] ports.
      if(!exact&&actual.ports.some(p=>p.signed||p.range&&p.range[1]!=='0'))return null;
      return {code:rtl,metadata:{candidate_sha256:sha(rtl),rtl_chars:rtl.length}};
    } catch {return null;}
  };
  return createFencedAnswerGate(inspect,options);
}

// Share the existing stream boundary/cancellation semantics with full modules.
// A unit is eligible only after reassembly against this exact base has passed
// every structural authorization check. Compilation/behavior remain downstream.
export function createLocalRepairHandoff(base,unitIds,options={}) {
  const inspect=raw=>{
    try {
      const {rtl,authorization}=applyLocalRepair(base,unitIds,'<answer>\n```systemverilog\n'+raw+'```\n</answer>');
      return {code:raw,metadata:{candidate_sha256:sha(rtl),replacement_sha256:authorization.new_sha256,
        base_sha256:base.sha256,unit_id:authorization.unit_id,rtl_chars:rtl.length}};
    } catch {return null;}
  };
  return createFencedAnswerGate(inspect,{...options,policy:'first_complete_local_answer_v1'});
}

function createFencedAnswerGate(inspect,{maxChars=262144,maxLineChars=32768,policy='first_complete_answer_v1'}={}) {
  let pending='',received=0,offset=0,thinking=0,fence=null,answer=null,selected=null,disabled=false;
  let rejected=0;
  const line = value => {
    const start=offset;offset+=value.length;const trimmed=value.trim();
    const mark=/^(`{3,}|~{3,})(systemverilog|verilog|sv)?\s*$/i.exec(trimmed);
    if(fence) {
      if(mark&&!mark[2]&&mark[1][0]===fence.marker[0]&&mark[1].length>=fence.marker.length&&lexicalView(fence.code).closed) {
        if(answer)answer.blocks.push(inspect(fence.code));
        fence=null;
      } else fence.code+=value;
      return;
    }
    if(thinking||/^<\s*(?:think|thinking)\s*>/i.test(trimmed)) {
      for(const tag of trimmed.matchAll(/<\s*(\/?)\s*(?:think|thinking)\s*>/gi))thinking=Math.max(0,thinking+(tag[1]?-1:1));
      return;
    }
    if(/^<\s*\/\s*(?:think|thinking)\s*>$/i.test(trimmed)){thinking=Math.max(0,thinking-1);return;}
    if(mark){fence={marker:mark[1],code:''};return;}
    if(trimmed==='<answer>'){answer={start,blocks:[],extra:false};return;}
    if(trimmed==='</answer>'&&answer) {
      const a=answer;answer=null;
      if(a.blocks.length!==1||!a.blocks[0]||a.extra){rejected++;return;}
      const {code,metadata}=a.blocks[0];
      selected={text:'<answer>\n```systemverilog\n'+code+'```\n</answer>\n',
        metadata:{policy,...metadata,
          content_start:a.start,content_end:offset,received_content_chars:received,rejected_wrappers:rejected,
          functional_verified:false}};
    } else if(answer&&trimmed)answer.extra=true;
  };
  return {
    push(delta) {
      if(disabled||selected)return selected;
      received+=delta.length;
      if(received>maxChars){disabled=true;pending='';fence=null;answer=null;return null;}
      pending+=delta;
      let i;
      while(!selected&&(i=pending.indexOf('\n'))>=0){const value=pending.slice(0,i+1);pending=pending.slice(i+1);if(value.length>maxLineChars){disabled=true;break;}line(value);}
      if(pending.length>maxLineChars)disabled=true;
      if(disabled){pending='';fence=null;answer=null;}
      return selected;
    },
    // Only a proven natural end may flush an unterminated line. Never infer EOS
    // from a temporary gap between network packets.
    finish(){if(!disabled&&!selected&&pending){line(pending);pending='';}return selected;},
  };
}
