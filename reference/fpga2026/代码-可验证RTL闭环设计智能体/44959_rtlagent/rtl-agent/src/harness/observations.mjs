import {z} from 'zod';
import {sha256,invariant} from '../dual/snapshot.mjs';

export const OBSERVATION_LIMIT=16*1024*1024;
const check=(ok,message)=>invariant(ok,'OBSERVATION_INVALID',message);
const port=z.object({name:z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),width:z.number().int().min(1).max(4096),direction:z.enum(['input','output'])}).strict();
const shape=z.object({version:z.literal('rtl_trace.v1'),file:z.literal('selftest_trace.txt'),plan_sha256:z.string().regex(/^[a-f0-9]{64}$/),clock_port:z.string().nullable(),ports:z.array(port).min(1).max(64),plan:z.object({steps:z.array(z.object({drive:z.record(z.string(),z.string()),expect:z.record(z.string(),z.string()),masks:z.record(z.string(),z.string()).optional(),because:z.array(z.string())}).strict()).min(2).max(4096),expectedChecks:z.number().int().min(1).max(512)}).passthrough()}).strict();
const definition=d=>({plan:d.plan,ports:d.ports,clock_port:d.clock_port});
// Zod and JSON round trips may reorder object keys. Identity is over content;
// array order (steps and ports) remains significant and must never be sorted.
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
const planHash=d=>sha256(JSON.stringify(canonical(definition(d))));
export function validateTraceDescriptor(value){
  const d=shape.parse(value);
  check(new Set(d.ports.map(p=>p.name)).size===d.ports.length,'Duplicate observation ports');
  check(d.clock_port===null||d.ports.some(p=>p.name===d.clock_port&&p.direction==='input'&&p.width===1),'Invalid clock observation');
  check(planHash(d)===d.plan_sha256,'Observation plan hash mismatch');
  for(const row of d.plan.steps)for(const [name,value] of Object.entries(row.masks??{})){
    const p=d.ports.find(p=>p.name===name&&p.direction==='output');
    check(p&&Object.hasOwn(row.expect,name),'Care mask has no expected output');
    check(literalBits(value,p.width).includes('1'),'Observation care mask must be nonzero');
  }
  check(d.plan.steps.length*(64+d.ports.reduce((n,p)=>n+p.width+1,0))<OBSERVATION_LIMIT,'Observation exceeds storage budget');
  return d;
}
export function traceDescriptor(plan,expected,clockPort=null){
  const d={version:'rtl_trace.v1',file:'selftest_trace.txt',clock_port:clockPort??null,ports:expected.ports.map(({name,width,direction})=>({name,width,direction})),plan:structuredClone(plan)};
  return validateTraceDescriptor({...d,plan_sha256:planHash(d)});
}
function literalBits(value,width){
  const m=/^(\d+)'h([0-9a-f]+)$/i.exec(value);
  check(m&&Number(m[1])===width,'Observation needs normalized known literals');
  const b=BigInt('0x'+m[2]).toString(2);check(b.length<=width,'Literal width overflow');return b.padStart(width,'0');
}
export function observationMatches(row,port){
  const actual=row.actual[port],expected=row.expect[port],mask=row.masks?.[port];
  return expected!==undefined&&actual?.length===expected.length&&[...expected].every((bit,i)=>mask?.[i]==='0'||actual[i]===bit);
}
function mismatchRows(rows){return rows.flatMap(r=>Object.entries(r.expect).filter(([k])=>!observationMatches(r,k)).map(([port,expected])=>({step:r.step,port,expected,actual:r.actual[port],...(r.masks?.[port]?{mask:r.masks[port]}:{})})));}
export function parseObservation(text,descriptor,{candidateSha256=null,benchSha256=null,checks,failures}={}){
  const d=validateTraceDescriptor(descriptor);
  check(typeof text==='string'&&Buffer.byteLength(text)<=OBSERVATION_LIMIT,'Observation too large');
  const lines=text.trimEnd().split(/\r?\n/);
  check(lines.shift()===`RTL_TRACE_V1 ${d.plan_sha256}`,'Wrong observation identity');
  const end=/^END\t(\d+)\t(\d+)\t(\d+)$/.exec(lines.pop()??'');
  check(end&&Number(end[1])===d.plan.steps.length&&lines.length===d.plan.steps.length,'Missing or extra observation rows');
  const inputs=d.ports.filter(p=>p.direction==='input'),outputs=d.ports.filter(p=>p.direction==='output');
  let driven={},previousClock=null,total=0;
  const rows=lines.map((line,i)=>{
    const cells=line.split('\t'),s=d.plan.steps[i];
    check(cells.length===d.ports.length+2&&cells[0]===String(i)&&cells[1]===String((i+1)*2),'Invalid observation index/time/columns');
    const values=Object.fromEntries(d.ports.map((p,j)=>{const bits=cells[j+2].toLowerCase();check(bits.length===p.width&&/^[01xz]+$/.test(bits),'Invalid four-state observation');return [p.name,bits];}));
    driven={...driven,...s.drive};
    const observedInputs=Object.fromEntries(inputs.map(p=>{check(values[p.name]===literalBits(driven[p.name],p.width),'Observed input differs from frozen drive');return [p.name,values[p.name]];}));
    check(Object.keys(s.expect).every(name=>outputs.some(p=>p.name===name)),'Unknown expected output');
    // The compact table is in declared-port order. Normalize maps to that
    // order before calculating mismatch rows and exact roundtrip evidence.
    const expect=Object.fromEntries(outputs.filter(p=>Object.hasOwn(s.expect,p.name)).map(p=>[p.name,literalBits(s.expect[p.name],p.width)]));
    const masks=Object.fromEntries(outputs.filter(p=>Object.hasOwn(s.masks??{},p.name)).map(p=>[p.name,literalBits(s.masks[p.name],p.width)]));
    total+=Object.keys(expect).length;
    const clock=d.clock_port?values[d.clock_port]:null;
    const edge=clock===null?'none':previousClock===null?'initial':clock===previousClock?'hold':clock==='1'?'posedge':'negedge';
    previousClock=clock;
    return {step:i,time_ns:(i+1)*2,edge,inputs:observedInputs,actual:Object.fromEntries(outputs.map(p=>[p.name,values[p.name]])),expect,...(Object.keys(masks).length?{masks}:{}),because:s.because};
  });
  const mismatches=mismatchRows(rows);
  check(total===d.plan.expectedChecks&&Number(end[2])===total&&Number(end[3])===mismatches.length,'Observation footer inconsistent with actual values');
  check((checks===undefined||checks===total)&&(failures===undefined||failures===mismatches.length),'Observation disagrees with completion result');
  return {version:'rtl_observation.v1',source:'self_generated_spec_vectors',complete:true,plan_sha256:d.plan_sha256,candidate_sha256:candidateSha256,bench_sha256:benchSha256,clock_port:d.clock_port,ports:d.ports,
    semantics:'Drive, wait 2 ns, observe then compare. Expected values are fallible hypotheses, not an official oracle. A mask bit of 1 is compared; 0 is source-declared don\'t-care. Without a mask every bit is compared. Edge labels describe input transitions, not proof of internal branch execution.',checks:total,failures:mismatches.length,mismatches,rows};
}
const encodeBits=b=>/^[01]+$/.test(b)?'0x'+BigInt('0b'+b).toString(16):'0b'+b;
const decodeBits=(s,w)=>{check(/^0x[0-9a-f]+$/.test(s)||/^0b[01xz]+$/.test(s),'Invalid compact bit value');const b=s.startsWith('0x')?BigInt(s).toString(2).padStart(w,'0'):s.slice(2);check(b.length===w,'Compact width mismatch');return b;};
export function compactObservation(trace){
  const {rows,mismatches,...metadata}=trace,ins=trace.ports.filter(p=>p.direction==='input'),outs=trace.ports.filter(p=>p.direction==='output');
  const masked=rows.some(r=>Object.keys(r.masks??{}).length);
  const columns=['step','time_ns','edge',...ins.map(p=>'in:'+p.name),...outs.map(p=>'actual:'+p.name),...outs.map(p=>'expect:'+p.name),...(masked?outs.map(p=>'mask:'+p.name):[]),'because'];
  const table=rows.map(r=>[r.step,r.time_ns,r.edge,...ins.map(p=>encodeBits(r.inputs[p.name])),...outs.map(p=>encodeBits(r.actual[p.name])),...outs.map(p=>Object.hasOwn(r.expect,p.name)?encodeBits(r.expect[p.name]):'-'),...(masked?outs.map(p=>Object.hasOwn(r.masks??{},p.name)?encodeBits(r.masks[p.name]):'-'):[]),r.because.join(',')||'-'].join('\t')).join('\n');
  return {format:masked?'rtl_observation_table.v2':'rtl_observation_table.v1',metadata,columns,table};
}
export function decodeObservation(view){
  check(['rtl_observation_table.v1','rtl_observation_table.v2'].includes(view?.format),'Unknown compact observation version');
  const masked=view.format==='rtl_observation_table.v2';
  const m=view.metadata,ins=m.ports.filter(p=>p.direction==='input'),outs=m.ports.filter(p=>p.direction==='output');
  const lines=view.table.split('\n');check(lines.length>=2&&lines.length<=4096,'Invalid compact row count');
  const rows=lines.map((line,index)=>{
    const c=line.split('\t');check(c.length===4+ins.length+(masked?3:2)*outs.length&&c[0]===String(index)&&c[1]===String((index+1)*2)&&['none','initial','hold','posedge','negedge'].includes(c[2]),'Invalid compact row');let j=3;
    const inputs=Object.fromEntries(ins.map(p=>[p.name,decodeBits(c[j++],p.width)]));
    const actual=Object.fromEntries(outs.map(p=>[p.name,decodeBits(c[j++],p.width)]));
    const expect=Object.fromEntries(outs.flatMap(p=>{const v=c[j++];return v==='-'?[]:[[p.name,decodeBits(v,p.width)]];}));
    const masks=masked?Object.fromEntries(outs.flatMap(p=>{const v=c[j++];if(v==='-')return [];const bits=decodeBits(v,p.width);check(Object.hasOwn(expect,p.name)&&/^[01]+$/.test(bits)&&bits.includes('1'),'Invalid compact care mask');return [[p.name,bits]];})):{};
    return {step:index,time_ns:Number(c[1]),edge:c[2],inputs,actual,expect,...(Object.keys(masks).length?{masks}:{}),because:c[j]==='-'?[]:c[j].split(',')};
  });
  const mismatches=mismatchRows(rows),trace={...m,mismatches,rows};check(JSON.stringify(compactObservation(trace).columns)===JSON.stringify(view.columns),'Wrong compact columns');
  check(mismatches.length===m.failures&&rows.reduce((n,r)=>n+Object.keys(r.expect).length,0)===m.checks,'Compact counts disagree');return trace;
}

const hash=z.string().regex(/^[a-f0-9]{64}$/);
const compactShape=z.object({format:z.enum(['rtl_observation_table.v1','rtl_observation_table.v2']),metadata:z.object({version:z.literal('rtl_observation.v1'),source:z.literal('self_generated_spec_vectors'),complete:z.literal(true),plan_sha256:hash,candidate_sha256:hash,bench_sha256:hash,clock_port:z.string().nullable(),ports:z.array(port).min(1).max(64),semantics:z.string().min(1).max(1000),checks:z.number().int().min(1).max(512),failures:z.number().int().min(0).max(512)}).strict(),columns:z.array(z.string().max(100)).min(4).max(196),table:z.string().min(1).max(OBSERVATION_LIMIT)}).strict();
export function validateObservationResult(value){
  if(value?.status==='incomplete'){
    z.object({status:z.literal('incomplete'),code:z.literal('OBSERVATION_INVALID'),reason:z.string().max(300)}).strict().parse(value);return value;
  }
  z.object({status:z.literal('complete'),view:compactShape}).strict().parse(value);
  const m=value.view.metadata;
  check(new Set(m.ports.map(p=>p.name)).size===m.ports.length,'Duplicate compact ports');
  check(m.clock_port===null||m.ports.some(p=>p.name===m.clock_port&&p.direction==='input'&&p.width===1),'Invalid compact clock');
  decodeObservation(value.view);return value; // Validate without stripping data.
}
