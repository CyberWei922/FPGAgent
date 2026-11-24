import {lex,portContract} from '../dual/unit-index.mjs';
import {invariant} from '../dual/snapshot.mjs';

const check=(ok,message)=>invariant(ok,'MODULE_PATH_UNPROVEN',message);
const id=s=>/^[A-Za-z_][A-Za-z0-9_$]*$/.test(s??'');
// Conservative structural dependency check, NOT simulation or synthesis. All
// identifiers in a combinational block influence all its destinations. Edge
// blocks cut paths, including RHS/conditions. Unsupported syntax fails closed.
export function sourcePaths(rtl){
  const contract=portContract(rtl);check(contract,'Unresolved ANSI interface');
  const t=lex(rtl).map(x=>x.value);let i=t.indexOf(';')+1;const units=[];
  const group=(open,close)=>{check(t[i++]===open,'Expected group');let depth=1;while(i<t.length&&depth){if(t[i]===open)depth++;if(t[i]===close)depth--;i++;}check(!depth,'Unclosed group');};
  const semi=()=>{while(i<t.length&&t[i]!==';'){if(t[i]==='(')group('(',')');else if(t[i]==='[')group('[',']');else if(t[i]==='{')group('{','}');else {check(!['endmodule','end','endcase'].includes(t[i]),'Missing semicolon');i++;}}check(t[i++]===';','Missing semicolon');};
  const statement=()=>{
    if(t[i]==='begin'){i++;if(t[i]===':'){i++;check(id(t[i++]),'Invalid block label');}while(t[i]!=='end'){check(i<t.length,'Unclosed block');statement();}i++;return;}
    if(t[i]==='if'){i++;group('(',')');statement();if(t[i]==='else'){i++;statement();}return;}
    if(['for','while','repeat'].includes(t[i])){i++;group('(',')');statement();return;}
    if(['case','casez','casex'].includes(t[i])){i++;group('(',')');while(t[i]!=='endcase'){check(i<t.length,'Unclosed case');while(t[i]!==':'){check(i<t.length&&![';','endcase'].includes(t[i]),'Invalid case selector');i++;}i++;statement();}i++;return;}
    check(!['@','#','wait','forever','fork','disable','return'].includes(t[i]),'Unsupported procedural control');semi();
  };
  while(t[i]!=='endmodule'){
    check(i<t.length,'Missing endmodule');const start=i;let sequential=false,skip=false;
    if(['always','always_ff','always_comb'].includes(t[i])){
      const kind=t[i++];if(kind!=='always_comb'){check(t[i++]==='@','Missing sensitivity');const s=i;if(t[i]==='*')i++;else group('(',')');sequential=t.slice(s,i).some(x=>['posedge','negedge'].includes(x));}statement();
    }else if(t[i]==='assign'){i++;semi();}
    else if(['wire','logic','reg','integer','localparam','parameter','genvar'].includes(t[i])){skip=['localparam','parameter','genvar'].includes(t[i]);semi();}
    else if(t[i]==='function'){
      // Function call arguments occur at each caller; free variable reads also
      // must reach the function symbol. ANSI and old-style inputs are allowed.
      i++;while(t[i]!=='endfunction'){check(i<t.length&&!['module','endmodule'].includes(t[i]),'Unclosed function');i++;}i++;
    }else check(false,'Unsupported module item: '+t[i]);
    const words=t.slice(start,i);if(skip)continue;
    const writes=new Set();
    for(let j=0;j<words.length;j++)if(['=','<='].includes(words[j])){
      let k=j-1;
      if(words[k]===']'){let d=1;k--;while(k>=0&&d){if(words[k]===']')d++;if(words[k]==='[')d--;k--;}check(!d,'Unclosed destination select');}
      if(words[k]==='}'){
        let d=1;k--;while(k>=0&&d){if(words[k]==='}')d++;if(words[k]==='{')d--;if(d&&id(words[k]))writes.add(words[k]);k--;}check(!d,'Unclosed destination concatenation');
      }else {check(id(words[k]),'Unresolved assignment destination');writes.add(words[k]);}
    }
    check(!words.some((w,j)=>['+','-'].includes(w)&&words[j+1]===w),'Use explicit loop increments for dependency audit');
    units.push({sequential,writes:[...writes],reads:[...new Set(words.filter(id))]});
  }
  check(i===t.length-1,'Extra modules/trailing tokens');
  const graph=new Map(),clocked=new Set();
  for(const u of units)for(const w of u.writes){
    if(u.sequential){check(!graph.has(w),'Mixed combinational/sequential driver');clocked.add(w);}
    else {check(!clocked.has(w),'Mixed combinational/sequential driver');if(!graph.has(w))graph.set(w,new Set());for(const r of u.reads)if(r!==w)graph.get(w).add(r);}
  }
  const inputs=new Set(contract.ports.filter(p=>p.direction==='input').map(p=>p.name));
  return contract.ports.filter(p=>p.direction==='output').map(p=>{
    check(graph.has(p.name)||clocked.has(p.name),'Output has no proven assignment');
    const seen=new Set(),found=new Set(),visit=n=>{if(seen.has(n))return;seen.add(n);if(inputs.has(n))found.add(n);if(!clocked.has(n))for(const x of graph.get(n)??[])visit(x);};visit(p.name);
    return {output:p.name,inputs:[...found].sort()};
  });
}

export function validatePaths(modules){
  const graph=new Map();
  for(const m of modules){
    const outputs=m.ports.filter(p=>p.direction==='output'),inputs=m.ports.filter(p=>p.direction==='input');
    check(Array.isArray(m.paths)&&m.paths.length===outputs.length&&new Set(m.paths.map(p=>p.output)).size===outputs.length,'Each output requires exactly one current-cycle path declaration');
    for(const p of m.paths){
      check(p&&Object.keys(p).length===2&&Object.hasOwn(p,'inputs')&&outputs.some(x=>x.name===p.output)&&Array.isArray(p.inputs)&&new Set(p.inputs).size===p.inputs.length&&p.inputs.every(n=>inputs.some(x=>x.name===n)),'Invalid port-level dependency declaration');
      const out=outputs.find(x=>x.name===p.output).net;
      for(const n of p.inputs){const input=inputs.find(x=>x.name===n).net;if(!graph.has(input))graph.set(input,new Set());graph.get(input).add(out);}
    }
  }
  const active=new Set(),done=new Set(),visit=n=>{check(!active.has(n),'Current-cycle combinational feedback: revise boundary or keep whole');if(done.has(n))return;active.add(n);for(const v of graph.get(n)??[])visit(v);active.delete(n);done.add(n);};
  for(const n of graph.keys())visit(n);
}
export function checkSourcePaths(rtl,module){
  const actual=sourcePaths(rtl);
  for(const p of actual){const declared=module.paths.find(x=>x.output===p.output);check(declared&&p.inputs.every(n=>declared.inputs.includes(n)),'Code has an undeclared current-cycle input/output path for '+p.output);}
  return actual;
}
