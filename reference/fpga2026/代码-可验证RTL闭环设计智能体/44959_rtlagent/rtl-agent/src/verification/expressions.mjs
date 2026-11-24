import {invariant,sha256} from '../dual/snapshot.mjs';
import {compileScenarioPlan} from './plan.mjs';
import {DONT_CARE_SOURCE,EXPRESSION_NODES,expressionIssue,expressionValidationMessage} from './expression-schema.mjs';

const check=(ok,msg)=>invariant(ok,'TEST_PLAN_INVALID',msg);
const mask=w=>(1n<<BigInt(w))-1n,hex=v=>'0x'+v.toString(16);
const DOMAIN_SOURCE=/\blegal\b|\bvalid\b|\bassum(?:e|ed|ing)\b|\bonly inputs?\b|\binput.*(?:restricted|range)\b|有效|合法|输入.*范围/i;

// This is a deliberately smaller language than Verilog: no X/Z, implicit
// truncation, unsized HDL defaults or context-dependent signed arithmetic.
export function expressionLiteral(text,w){
  check(typeof text==='string'&&text.length<=1240,'Bounded known literal required');
  const s=text.replace(/_/g,'').trim();
  if(s==="'0"||s==="'1")return s==="'1"?mask(w):0n;
  const m=/^(-?)(\d+)'s?([bodh])([0-9a-f]+)$/i.exec(s);let value;
  if(m){
    check(Number(m[2])===w,'Literal width must match node width');
    const radix=m[3].toLowerCase(),digits=m[4];
    check(({b:/^[01]+$/,o:/^[0-7]+$/,d:/^\d+$/,h:/^[\da-f]+$/i})[radix].test(digits),'Unknown/invalid literal digits');
    value=BigInt(({b:'0b',o:'0o',d:'',h:'0x'})[radix]+digits)*(m[1]?-1n:1n);
  }else{
    check(/^-?(?:\d+|0x[\da-f]+|0b[01]+|0o[0-7]+)$/i.test(s),'Known integer literal required');
    value=s.startsWith('-')?-BigInt(s.slice(1)):BigInt(s);
  }
  check(value>=-(1n<<BigInt(w-1))&&value<=mask(w),'Literal overflows node width');
  return BigInt.asUintN(w,value);
}

/** Pure bounded compiler. inputs: [{name, width}], nodes: ordered expression AST.
 * Returns an immutable program with nodes, types and per-evaluation CPU costs.
 * normalizedNodes/normalizations expose deterministic syntax-only changes;
 * callers can log them without changing this pure API or the input objects.
 * Source citations, output coverage, domain and care authorization belong to the
 * caller; this function validates numeric/structural semantics, not the spec.
 */
export function validateExpressionProgram(nodes,inputs){
  const parsed=EXPRESSION_NODES.safeParse(nodes);
  check(parsed.success,parsed.success?'':expressionValidationMessage(parsed.error,nodes));
  check(Array.isArray(inputs)&&inputs.every(p=>p&&typeof p.name==='string'&&/^[A-Za-z_]\w*$/.test(p.name)&&p.name.length<=100&&Number.isInteger(p.width)&&p.width>=1&&p.width<=4096),'Expression inputs require bounded names and widths');
  check(new Set(inputs.map(p=>p.name)).size===inputs.length,'Duplicate expression input');
  check(inputs.reduce((n,p)=>n+p.width,0)<=4096,'Expression interface exceeds bit budget');
  const byRef=new Map(inputs.map(p=>['$'+p.name,{width:p.width,depth:0}])),program=[],normalizedNodes=[],normalizations=[];
  for(const [index,n] of parsed.data.entries()){
    const require=(ok,field,expected,actual)=>check(ok,expressionIssue(index,n.id,field,expected,actual));
    require(!byRef.has('#'+n.id),'id','unique node ID',n.id);
    if(n.op==='literal'){
      if(typeof n.value==='number'){
        normalizations.push({kind:'literal_value',index,id:n.id,field:'value',from:n.value,to:String(n.value)});n.value=String(n.value);
      }
      let value;
      try{value=expressionLiteral(n.value,n.width);}catch(error){require(false,'value',`known literal fitting width ${n.width} (${error.message})`,n.value);}
      normalizedNodes.push({...n});
      byRef.set('#'+n.id,{width:n.width,depth:1});program.push({...n,value});continue;
    }
    n.args=n.args.map((a,i)=>normalizeInputReference(a,byRef,normalizations,{index,id:n.id,field:'args.'+i}));
    const refs=n.args.filter(a=>typeof a==='string'&&/^[#$]/.test(a));
    const children=refs.map((r,i)=>{require(byRef.has(r),'args.'+i,'declared input or earlier node reference',r);return byRef.get(r);});
    const depth=1+Math.max(0,...children.map(c=>c.depth));require(depth<=12,'depth','at most 12',depth);
    const inferred=n.op==='concat'?children.reduce((sum,c)=>sum+c.width,0):children[n.op==='ite'?1:0].width;
    if(n.width===undefined){
      normalizations.push({kind:'operand_width',index,id:n.id,field:'width',from:null,to:inferred});n.width=inferred;
    }
    require(n.width===inferred,'width',inferred,n.width);
    const w=n.width,a=n.args;
    if(n.op!=='concat')children.forEach((c,i)=>require(c.width===(n.op==='ite'&&i===0?1:w),'args.'+i,`width ${n.op==='ite'&&i===0?1:w}; explicit resize required for different widths`,c.width));
    let resultWidth=w;
    if(['eq','ne','ult','ule','ugt','uge','slt','sle','sgt','sge','land','lor','lnot','reduce_and','reduce_or','reduce_xor'].includes(n.op))resultWidth=1;
    if(n.op==='popcount')resultWidth=Math.ceil(Math.log2(w+1));
    if(n.op==='slice'){require(a[1]+a[2]<=w,'args.1/args.2',`slice end at most operand width ${w}`,a[1]+a[2]);resultWidth=a[2];}
    if(n.op==='resize')resultWidth=a[1];
    normalizedNodes.push({...n});
    byRef.set('#'+n.id,{width:resultWidth,depth});program.push({...n,resultWidth});
  }
  const workUnits=program.reduce((sum,n)=>sum+(['popcount','reduce_xor'].includes(n.op)?n.width:n.op==='mul'?Math.ceil(n.width*n.width/64):Math.ceil(n.width/32)),0);
  check(workUnits<=16000000,'Expression CPU bit-work budget exceeded');
  const freezeNodes=list=>Object.freeze(list.map(n=>Object.freeze({...n,...(n.args?{args:Object.freeze([...n.args])}:{})})));
  return Object.freeze({nodes:freezeNodes(program),normalizedNodes:freezeNodes(normalizedNodes),normalizations:Object.freeze(normalizations.map(n=>Object.freeze({...n}))),
    inputs:Object.freeze(inputs.map(({name,width})=>Object.freeze({name,width}))),
    types:Object.freeze(Object.fromEntries([...byRef].map(([ref,type])=>[ref,Object.freeze({...type})]))),
    operations:program.length,workUnits});
}

// Exact port names win. Only these two common aliases of a real input are
// accepted; no suffix search, edit-distance guessing, or output/state aliases.
function normalizeInputReference(ref,types,normalizations,location){
  const has=key=>types instanceof Map?types.has(key):Object.hasOwn(types,key);
  if(typeof ref!=='string'||has(ref))return ref;
  const alias=/^\$input[._]([A-Za-z_]\w*)$/.exec(ref),canonical=alias?'$'+alias[1]:null;
  if(!canonical||!has(canonical))return ref;
  normalizations.push({kind:'input_reference',...location,from:ref,to:canonical});return canonical;
}

/** Pure evaluation of a validated program. values is {portName: unsignedBigInt}.
 * Returns a fresh Map keyed by "$portName" and "#nodeId", with BigInt values.
 * No counters/state persist across calls. Batch callers enforce aggregate CPU
 * limits using program.operations/workUnits (the method compiler does so below).
 */
export function evaluateExpressionProgram(program,values){
    const env=new Map(program.inputs.map(i=>{
      const value=values?.[i.name];
      check(Object.hasOwn(values??{},i.name)&&typeof value==='bigint'&&value>=0n&&value<=mask(i.width),'Expression input '+i.name+' requires an in-range unsigned BigInt');
      return ['$'+i.name,value];
    }));
    check(program.operations<=600000&&program.workUnits<=16000000,'Expression CPU budget exceeded');
    for(const n of program.nodes){
      if(n.op==='literal'){env.set('#'+n.id,n.value);continue;}
      const [x,y,z]=n.args.map(a=>typeof a==='string'&&/^[#$]/.test(a)?env.get(a):a),w=n.width;
      const signed=v=>BigInt.asIntN(w,v),boolean=v=>BigInt(Boolean(v));let v;
      switch(n.op){
        case 'not':v=~x;break;case 'lnot':v=boolean(x===0n);break;
        case 'and':v=x&y;break;case 'or':v=x|y;break;case 'xor':v=x^y;break;
        case 'add':v=x+y;break;case 'sub':v=x-y;break;case 'mul':v=x*y;break;
        case 'eq':v=boolean(x===y);break;case 'ne':v=boolean(x!==y);break;
        case 'ult':v=boolean(x<y);break;case 'ule':v=boolean(x<=y);break;case 'ugt':v=boolean(x>y);break;case 'uge':v=boolean(x>=y);break;
        case 'slt':v=boolean(signed(x)<signed(y));break;case 'sle':v=boolean(signed(x)<=signed(y));break;case 'sgt':v=boolean(signed(x)>signed(y));break;case 'sge':v=boolean(signed(x)>=signed(y));break;
        case 'land':v=boolean(x!==0n&&y!==0n);break;case 'lor':v=boolean(x!==0n||y!==0n);break;
        case 'shl':v=x<<BigInt(y);break;case 'shr':v=x>>BigInt(y);break;case 'sar':v=signed(x)>>BigInt(y);break;
        case 'slice':v=x>>BigInt(y);break;case 'resize':v=z==='sign'?signed(x):x;break;
        case 'ite':v=x?y:z;break;
        case 'concat':v=n.args.reduce((acc,ref)=>(acc<<BigInt(program.types[ref].width))|env.get(ref),0n);break;
        case 'reduce_and':v=boolean(x===mask(w));break;case 'reduce_or':v=boolean(x!==0n);break;
        case 'reduce_xor':case 'popcount':{let count=0n,bits=x;while(bits){bits&=bits-1n;count++;}v=n.op==='popcount'?count:count&1n;break;}
        default:check(false,'Unknown expression operation');
      }
      env.set('#'+n.id,BigInt.asUintN(n.resultWidth,v));
    }
    return env;
}

export function compileExpressionMethod(raw,{task,expected,resolveSources}){
  const p=structuredClone(raw.params),inputs=expected.ports.filter(p=>p.direction==='input'),outputs=expected.ports.filter(p=>p.direction==='output');
  check(inputs.reduce((n,p)=>n+p.width,0)<=4096&&outputs.reduce((n,p)=>n+p.width,0)<=4096,'Expression interface exceeds bit budget');
  check(p.outputs.length===outputs.length&&new Set(p.outputs.map(p=>p.port)).size===outputs.length&&p.outputs.every(r=>outputs.some(p=>p.name===r.port)),'Expression must declare every output exactly once');
  const refs=resolveSources([...new Set([...raw.sources,...(p.domain?.sources??[]),...p.outputs.flatMap(o=>o.care?.sources??[])])],task);
  const sourceText=refs.map(r=>r.quote).join('\n');
  const sourceTokens=sourceText.match(/(?<![\w'])-?(?:\d+'[sS]?[bBoOdDhH][\da-fA-F_]+|0[xX][\da-fA-F_]+|0[bB][01_]+|\d+)(?![\w'])/g)??[];
  const constraints=refs.map((r,i)=>({id:'C'+(i+1),quote:r.quote,claim:'Source behavior for the combinational expression, legal input domain or care mask.'}));
  const cite=(sources,pattern,kind)=>{
    const cited=resolveSources(sources,task);check(cited.some(r=>pattern.test(r.quote)),kind+' needs an explicit original-source restriction');
  };
  if(p.domain)cite(p.domain.sources,DOMAIN_SOURCE,'Legal input domain');
  for(const o of p.outputs)if(o.care)cite(o.care.sources,DONT_CARE_SOURCE,'Care mask');
  const compiled=validateExpressionProgram(p.nodes,inputs),program=compiled.nodes,normalizations=[...compiled.normalizations];
  for(const [index,n] of compiled.normalizedNodes.entries())if(n.op==='literal'){
    const value=expressionLiteral(n.value,n.width),structural=["'0","'1",'0','1'].includes(n.value);
    check(structural||sourceTokens.some(s=>{try{return expressionLiteral(s,n.width)===value;}catch{return false;}}),expressionIssue(index,n.id,'value','literal copied from a cited source constant or structural 0/1',n.value));
  }
  const getRef=(ref,w,field)=>{
    const normalized=normalizeInputReference(ref,compiled.types,normalizations,{index:'-',id:'result',field});
    check(compiled.types[normalized]?.width===w,expressionIssue('-','result',field,`reference of width ${w}`,{ref,width:compiled.types[normalized]?.width??'unknown'}));return normalized;
  };
  if(p.domain)p.domain.condition=getRef(p.domain.condition,1,'domain.condition');
  for(const [i,o] of p.outputs.entries()){
    const w=outputs.find(x=>x.name===o.port).width;o.value=getRef(o.value,w,`outputs.${i}.value`);if(o.care)o.care.value=getRef(o.care.value,w,`outputs.${i}.care.value`);
  }
  let operations=0,workUnits=0;
  const evaluate=values=>{
    operations+=compiled.operations;workUnits+=compiled.workUnits;
    check(operations<=600000,'Expression CPU operation budget exceeded');
    check(workUnits<=16000000,'Expression CPU bit-work budget exceeded');
    return evaluateExpressionProgram(compiled,values);
  };
  const bits=inputs.reduce((n,p)=>n+p.width,0),exhaustive=bits<=6,pool=new Set(),all=mask(bits);let randomStart=0,poolLimit=3072;
  // Reserve space for the fixed-seed lane even with many source constants/ports.
  const add=v=>{if(pool.size<poolLimit)pool.add(BigInt.asUintN(bits,v));};
  if(exhaustive)for(let i=0;i<2**bits;i++)add(BigInt(i));
  else{
    add(0n);add(all);let alternating=0n;for(let b=0;b<bits;b+=2)alternating|=1n<<BigInt(b);add(alternating);add(all^alternating);
    const offsets=[];let offset=0;for(const i of inputs){offsets.push(offset);offset+=i.width;}
    for(let mode=0;mode<8;mode++)inputs.forEach((i,j)=>{
      const m=mask(i.width),sign=1n<<BigInt(i.width-1),v=[1n,sign,m,m-1n,sign-1n,(sign+1n)&m,0n,m][mode];add(v<<BigInt(offsets[j]));add(all^(v<<BigInt(offsets[j])));
    });
    for(const n of program.filter(n=>n.op==='literal'))inputs.forEach((i,j)=>{if(i.width===n.width)for(const v of [n.value-1n,n.value,n.value+1n])add((v&mask(i.width))<<BigInt(offsets[j]));});
    for(let i=0;i<Math.min(bits,128);i++){const b=Math.floor(i*(bits-1)/Math.max(1,Math.min(bits,128)-1));add(1n<<BigInt(b));add(all^(1n<<BigInt(b)));}
    randomStart=pool.size;poolLimit=4096;
    let seed=0x5eedc027;const next=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return BigInt(seed>>>0);};
    for(let i=0;i<1024;i++){let v=0n;for(let b=0;b<bits;b+=32)v=(v<<32n)|next();add(v&all);}
  }
  // Interleave random and directed candidates so a long boundary list cannot
  // consume the retained-vector cap before any fixed-seed sample is exercised.
  const candidates=[...pool],ordered=exhaustive?candidates:[];
  if(!exhaustive)for(let i=0;i<Math.max(randomStart,candidates.length-randomStart);i++){
    if(i<randomStart)ordered.push(candidates[i]);if(i+randomStart<candidates.length)ordered.push(candidates[i+randomStart]);
  }
  const steps=[],checked=new Set(),because=constraints.map(c=>c.id);let excluded=0,masked=0,evaluated=0;
  for(const vector of ordered){
    let packed=vector;const drive={};for(const i of inputs){drive[i.name]=packed&mask(i.width);packed>>=BigInt(i.width);}
    const env=evaluate(drive);evaluated++;
    if(p.domain&&env.get(p.domain.condition)===0n){excluded++;continue;}
    const expect={};
    for(const o of p.outputs){
      const w=outputs.find(x=>x.name===o.port).width,care=o.care?env.get(o.care.value):mask(w);
      if(care!==mask(w))masked++;
      if(care===0n)continue;
      checked.add(o.port);expect[o.port]=o.care?{value:hex(env.get(o.value)),mask:hex(care)}:hex(env.get(o.value));
    }
    if(Object.keys(expect).length)steps.push({drive:Object.fromEntries(Object.entries(drive).map(([k,v])=>[k,hex(v)])),cycles:0,expect,because});
    if(!exhaustive&&steps.length===64)break;
  }
  check(steps.length&&checked.size===outputs.length,'Need meaningful observable comparisons for every output within the bounded legal sample');
  // Constant or singleton domains still need two observations for trace framing.
  if(steps.length===1)steps.push(structuredClone(steps[0]));
  const uncovered=['Expression interpretation and legal/care restrictions are source-cited hypotheses, not a correctness proof.',...(exhaustive?[]:['Input space exceeds six bits; deterministic boundary and fixed-seed samples are partial, not exhaustive.']),...(p.domain?['Inputs outside the declared source-backed legal domain are excluded.']:[]),...(masked?['Source-declared don\'t-care bits are excluded from comparisons.']:[])];
  const value={schema_version:2,status:'ready',clock:null,constraints,scenarios:[{id:'T1',description:'CPU-evaluated combinational expression samples',steps}],uncovered};
  const normalized=compileScenarioPlan(value,{spec:task.spec,expected});
  return {value,calculations:[{method:'bounded_expression_ast',version:2,source_sha256:sha256(task.spec),source_refs:refs.map(r=>r.address),nodes:compiled.normalizedNodes,normalizations,operations,work_units:workUnits}],coverage:{kind:exhaustive?'exhaustive_declared_domain':'boundary_and_fixed_seed',method:'comb_expr',semantic_correctness:'unproven',exhaustive,input_bits:bits,seed:exhaustive?null:0x5eedc027,candidates_evaluated:evaluated,excluded_inputs:excluded,masked_output_samples:masked,vectors:steps.length,comparisons:normalized.expectedChecks,unchecked_outputs:[]}};
}
