import {performance} from 'node:perf_hooks';
import {parsePayload} from '../dual/render.mjs';
import {invariant} from '../dual/snapshot.mjs';

export const CALCULATOR_VERSION='rtl2llm.bits.v1';
export const CALCULATOR_LIMITS=Object.freeze({width:4096,batch:16,bytes:65536,responseBytes:24576,cache:256});
export const CALCULATOR_OPERATIONS=Object.freeze(Object.fromEntries([
  ...['normalize','not','popcount','parity','clog2'].map(op=>[op,['value']]),
  ...['and','or','xor','add','sub','mul','div','mod','compare'].map(op=>[op,['left','right']]),
  ...['shl','shr','sar'].map(op=>[op,['value','amount']]),
  ['bit',['value','offset']],['slice',['value','offset','length']],['declared_bit',['value','range','index']],
  ['resize',['value','to_width','extension']],['concat',['parts']],
]));
const fail=(ok,message)=>invariant(ok,'CALC_INVALID',message);
const keys=(o,names)=>fail(o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).length===names.length&&names.every(k=>Object.hasOwn(o,k)),'Missing/unknown calculation fields');
const natural=(v,max)=>{fail(Number.isSafeInteger(v)&&v>=0&&v<=max,'Invalid bounded index/count');return v;};
const width=v=>{natural(v,CALCULATOR_LIMITS.width);fail(v>0,'Width must be positive');return v;};
function integer(s){
  fail(typeof s==='string'&&s.length<=1240&&/^-?(?:0|[1-9][0-9]*|0x[0-9a-fA-F]+|0b[01]+)$/.test(s),'Use exact decimal/0x/0b strings; X/Z and expressions are unsupported');
  const negative=s.startsWith('-'),v=BigInt(negative?s.slice(1):s);
  return negative?-v:v;
}
const mask=w=>(1n<<BigInt(w))-1n;
function fixed(s,w,signed){const v=integer(s),lo=signed?-(1n<<BigInt(w-1)):0n;
  // Positive bit patterns may use the entire width even for signed interpretation.
  fail(v>=lo&&v<=mask(w),'Operand does not fit the declared width');return BigInt.asUintN(w,v);
}
const interpreted=(v,w,signed)=>signed?BigInt.asIntN(w,v):v;
function compute(r){
  keys(r,['id','op','width','signed','args','source_refs']);
  fail(Object.hasOwn(CALCULATOR_OPERATIONS,r.op),'Unsupported operation');
  keys(r.args,CALCULATOR_OPERATIONS[r.op]);
  fail(typeof r.id==='string'&&/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(r.id),'Invalid calculation id');
  fail(typeof r.signed==='boolean','signed must be explicit');const w=width(r.width),a=r.args;
  fail(Array.isArray(r.source_refs)&&r.source_refs.length<=8&&r.source_refs.every(s=>typeof s==='string'&&s.length<=80),'Invalid source references');
  let value,outWidth=w,arithmetic=null,flag=null;
  const unary=()=>{keys(a,['value']);return fixed(a.value,w,r.signed);};
  const binary=()=>{keys(a,['left','right']);return [fixed(a.left,w,r.signed),fixed(a.right,w,r.signed)];};
  switch(r.op){
    case 'normalize':value=unary();break;
    case 'concat':{
      keys(a,['parts']);fail(!r.signed&&Array.isArray(a.parts)&&a.parts.length>=2&&a.parts.length<=16,'concat needs 2..16 high-to-low unsigned parts');
      value=0n;let total=0;
      for(const p of a.parts){keys(p,['value','width']);const pw=width(p.width);total+=pw;fail(total<=w,'concat exceeds result width');value=(value<<BigInt(pw))|fixed(p.value,pw,false);}
      fail(total===w,'concat part widths must sum to result width');break;
    }
    case 'not':value=(~unary())&mask(w);break;
    case 'and':case 'or':case 'xor':{const [x,y]=binary();value=r.op==='and'?x&y:r.op==='or'?x|y:x^y;break;}
    case 'add':case 'sub':case 'mul':case 'div':case 'mod':{
      const b=binary().map(v=>interpreted(v,w,r.signed)),[x,y]=b;
      fail(!['div','mod'].includes(r.op)||y!==0n,'Division by zero');
      const v=r.op==='add'?x+y:r.op==='sub'?x-y:r.op==='mul'?x*y:r.op==='div'?x/y:x%y;
      value=BigInt.asUintN(w,v);arithmetic=v.toString();flag=interpreted(value,w,r.signed)!==v;break;
    }
    case 'shl':case 'shr':case 'sar':{
      keys(a,['value','amount']);const x=fixed(a.value,w,r.signed),n=natural(a.amount,CALCULATOR_LIMITS.width);
      fail(r.op!=='sar'||r.signed,'Arithmetic right shift requires signed=true');
      value=BigInt.asUintN(w,r.op==='shl'?x<<BigInt(n):r.op==='shr'?x>>BigInt(n):BigInt.asIntN(w,x)>>BigInt(n));break;
    }
    case 'bit':case 'slice':{
      keys(a,r.op==='bit'?['value','offset']:['value','offset','length']);const x=fixed(a.value,w,r.signed),offset=natural(a.offset,w-1);
      outWidth=r.op==='bit'?1:width(a.length);fail(offset+outWidth<=w,'Slice exceeds operand');value=(x>>BigInt(offset))&mask(outWidth);break;
    }
    case 'declared_bit':{
      keys(a,['value','range','index']);fail(Array.isArray(a.range)&&a.range.length===2,'Need declared [left,right] range');
      const [l,h]=a.range.map(n=>natural(n,65535)),i=natural(a.index,65535);
      fail(Math.abs(l-h)+1===w&&i>=Math.min(l,h)&&i<=Math.max(l,h),'Index/range does not match width');
      outWidth=1;value=(fixed(a.value,w,r.signed)>>BigInt(Math.abs(i-h)))&1n;break;
    }
    case 'resize':{
      keys(a,['value','to_width','extension']);outWidth=width(a.to_width);fail(['zero','sign'].includes(a.extension),'Explicit zero/sign extension required');
      value=BigInt.asUintN(outWidth,a.extension==='sign'?BigInt.asIntN(w,fixed(a.value,w,r.signed)):fixed(a.value,w,r.signed));break;
    }
    case 'popcount':case 'parity':{
      let x=unary(),n=0;while(x){x&=x-1n;n++;}outWidth=r.op==='parity'?1:Math.ceil(Math.log2(w+1));value=BigInt(r.op==='parity'?n%2:n);break;
    }
    case 'clog2':{
      const x=unary();outWidth=13;value=x<=1n?0n:BigInt((x-1n).toString(2).length);break;
    }
    case 'compare':{
      const [x,y]=binary().map(v=>interpreted(v,w,r.signed));return {comparison:x===y?'equal':x<y?'less':'greater',semantics:'declared-width signedness; exact integers'};
    }
    default:fail(false,'Unsupported operation');
  }
  return {width:outWidth,unsigned_decimal:value.toString(),signed_decimal:BigInt.asIntN(outWidth,value).toString(),hex:'0x'+value.toString(16).padStart(Math.ceil(outWidth/4),'0'),binary:'0b'+value.toString(2).padStart(outWidth,'0'),
    ...(arithmetic!==null?{exact_arithmetic:arithmetic,overflow:flag}:{}),semantics:'Fixed width; arithmetic wraps modulo 2^width; division truncates toward zero; offsets are LSB-based; declared_bit uses the declared right bound as LSB.'};
}

export function createCalculator(){
  const cache=new Map();
  return {handle(input,{allowedRefs=null,snapshot=null}={}){
    const start=performance.now();
    const text=typeof input==='string'?input:JSON.stringify(input);fail(Buffer.byteLength(text)<=CALCULATOR_LIMITS.bytes,'Calculation request too large');
    const request=parsePayload(text);keys(request,['version','requests']);fail(request.version===CALCULATOR_VERSION,'Unknown calculator version');
    fail(Array.isArray(request.requests)&&request.requests.length>0&&request.requests.length<=CALCULATOR_LIMITS.batch,'Need 1..16 calculations');
    fail(new Set(request.requests.map(r=>r?.id)).size===request.requests.length,'Duplicate calculation IDs');
    const results=request.requests.map(r=>{
      try {
        // Validate before every lookup, including a hit from an earlier stage.
        fail(r&&Array.isArray(r.source_refs)&&r.source_refs.length<=8&&r.source_refs.every(x=>typeof x==='string'&&x.length<=80)&&(!allowedRefs||r.source_refs.every(x=>allowedRefs.has(x))),'Unknown source reference');
        const key=JSON.stringify([CALCULATOR_VERSION,snapshot,r.op,r.width,r.signed,r.args]);
        // Schema and operands are checked on hits too; do not trust caller objects.
        keys(r,['id','op','width','signed','args','source_refs']);
        fail(typeof r.id==='string'&&/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(r.id),'Invalid calculation id');
        let result=cache.get(key),hit=Boolean(result);
        if(!result){result=compute(r);cache.set(key,result);if(cache.size>CALCULATOR_LIMITS.cache)cache.delete(cache.keys().next().value);}
        else {cache.delete(key);cache.set(key,result);}
        return {id:r.id,status:'ok',cache_hit:hit,result:structuredClone(result)};
      }catch(error){return {id:r?.id??null,status:'error',code:error.code??'CALC_INVALID',message:String(error.message).slice(0,200)};}
    });
    // Include serialization cost in the observed complete-request latency.
    let serialized=JSON.stringify({version:CALCULATOR_VERSION,snapshot,results});
    if(Buffer.byteLength(serialized)>CALCULATOR_LIMITS.responseBytes)serialized=JSON.stringify({version:CALCULATOR_VERSION,snapshot,results:request.requests.map(r=>({id:r.id,status:'error',code:'CALC_RESPONSE_TOO_LARGE',message:'Result batch exceeds 24KB. Request fewer operations or narrower values; no numbers were delivered.'}))});
    const output=JSON.parse(serialized);
    return {...output,elapsed_ms:performance.now()-start};
  },get cacheSize(){return cache.size;}};
}

export const CALCULATOR_GUIDANCE=`calculate_batch is exact bounded arithmetic, not a simulator. Send {"status":"need_calculation","requests":[{"id":"c1","op":"bit","width":8,"signed":false,"args":{"value":"0x09","offset":3},"source_refs":["S1"]}]}. Allowed ops: normalize/not/popcount/parity/clog2 args {value}; and/or/xor/add/sub/mul/div/mod/compare {left,right}; shl/shr/sar {value,amount}; bit {value,offset}; slice {value,offset,length}; declared_bit {value,range:[left,right],index}; resize {value,to_width,extension:"zero"|"sign"}. Operands are exact decimal/0x/0b strings, width 1..4096, explicit signed boolean, offsets/counts integer numbers. Maximum 16 operations per batch. X/Z, expressions, scripts and guessing absent inputs are rejected. Results are returned ONLY when requested. A correct calculation does not establish the correct source signal or sample.`;
export const CONTRACT_CALCULATOR_GUIDANCE=`Exact CPU arithmetic, not a simulator. Return {"status":"need_calculation","requests":[{"id":"c1","op":"bit","width":8,"signed":false,"args":{"value":"0x09","offset":3},"source_refs":["S1"]}]}. No calculator version or snapshot is needed from you. Allowed operations and exact args: ${JSON.stringify(CALCULATOR_OPERATIONS)}. Maximum ${CALCULATOR_LIMITS.batch} operations, width 1..${CALCULATOR_LIMITS.width}. Operands decimal/0x/0b strings, explicit signed boolean, indexes/counts integer numbers. range is [left,right], extension is zero or sign; concat parts are [{value,width},...] high-to-low, widths sum to result width, signed=false. X/Z, expressions, scripts and absent operands are rejected. Results are delivered only when requested; choose the relevant operation from source semantics first.`;
