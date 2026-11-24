import {extractRtl} from '../workflow.mjs';
import {invariant} from '../dual/snapshot.mjs';

// SiliconMind can emit a draft answer and then a revised final answer. Never
// concatenate those modules. This only selects an explicit final answer wrapper;
// it does not rewrite code or choose a draft using test/oracle results.
export function extractAuthorRtl(text, top) {
  let fence=null,start=null,last=null,offset=0;
  for(const line of text.split(/(?<=\n)/)) {
    const trimmed=line.trim();
    const marker=/^(`{3,}|~{3,})(?:systemverilog|verilog|sv)?\s*$/i.exec(trimmed);
    if(marker) {
      if(!fence)fence=marker[1];
      else if(marker[1][0]===fence[0]&&marker[1].length>=fence.length)fence=null;
    }else if(!fence&&trimmed==='<answer>')start=offset+line.length;
    else if(!fence&&trimmed==='</answer>'&&start!==null){last={start,end:offset,after:offset+line.length};start=null;}
    offset+=line.length;
  }
  invariant(start===null,'OUTPUT_INVALID','Incomplete final answer wrapper');
  if(last)invariant(!text.slice(last.after).trim(),'OUTPUT_INVALID','Unexpected content after final answer');
  const rtl=extractRtl(last?text.slice(last.start,last.end):text,top);
  const executable=rtl.replace(/"(?:\\[\s\S]|[^"\\])*"|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,' ');
  invariant((executable.match(/\bmodule\b/g)??[]).length===1&&(executable.match(/\bendmodule\b/g)??[]).length===1,'OUTPUT_INVALID','Phase 1 requires one complete module');
  return {rtl,selection:last?'last_explicit_answer':'single_module_response'};
}
