import {z} from 'zod';
export const DONT_CARE_SOURCE=/\bdon[’']?t[- ]care\b|\bunspecified\b|\bunconstrained\b|无关|未规定/i;

// A flat, topologically ordered AST avoids recursive decoder schemas and limits
// parsing before evaluation. References are input names or earlier node IDs.
const obj=s=>z.object(s).strict(),name=z.string().regex(/^[A-Za-z_]\w*$/).max(100);
const ref=z.string().regex(/^(?:\$[A-Za-z_]\w*|\$input\.[A-Za-z_]\w*|#[A-Za-z_]\w*)$/).max(108);
const width=z.number().int().min(1).max(4096),index=z.number().int().min(0).max(4096);
const sources=z.array(z.string().min(1).max(160)).min(1).max(8);
const unary=['not','lnot','reduce_and','reduce_or','reduce_xor','popcount'];
const binary=['and','or','xor','add','sub','mul','eq','ne','ult','ule','ugt','uge','slt','sle','sgt','sge','land','lor'];
const node=z.discriminatedUnion('op',[
  obj({id:name,op:z.literal('literal'),width,value:z.union([z.string().min(1).max(1240),z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)])}),
  obj({id:name,op:z.enum(unary),width:width.optional(),args:z.tuple([ref])}),
  obj({id:name,op:z.enum(binary),width:width.optional(),args:z.tuple([ref,ref])}),
  obj({id:name,op:z.enum(['shl','shr','sar']),width:width.optional(),args:z.tuple([ref,index])}),
  obj({id:name,op:z.literal('slice'),width:width.optional(),args:z.tuple([ref,index,width])}),
  obj({id:name,op:z.literal('resize'),width:width.optional(),args:z.tuple([ref,width,z.enum(['zero','sign'])])}),
  obj({id:name,op:z.literal('ite'),width:width.optional(),args:z.tuple([ref,ref,ref])}),
  obj({id:name,op:z.literal('concat'),width,args:z.array(ref).min(2).max(64)})
]);
export const EXPRESSION_NODES=z.array(node).max(128);
export const EXPRESSION_PARAMS=obj({nodes:EXPRESSION_NODES,outputs:z.array(obj({port:name,value:ref,care:obj({value:ref,sources}).nullable()})).min(1).max(8),domain:obj({condition:ref,sources}).nullable()});

const display=value=>value===undefined?'missing':JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():v)?.slice(0,80);
export const expressionIssue=(index,id,field,expected,actual)=>`node ${index} (${id??'unknown'}) ${field}: expected ${expected}; actual ${display(actual)}`;
export function expressionValidationMessage(error,value){
  return error.issues.slice(0,3).map(issue=>{
    const path=issue.path,position=path[0]==='params'&&path[1]==='nodes'&&typeof path[2]==='number'?2:typeof path[0]==='number'?0:-1;
    const index=position<0?'-':path[position],n=position<0?null:path.slice(0,position+1).reduce((v,k)=>v?.[k],value);
    const actual=path.reduce((v,k)=>v?.[k],value);
    return expressionIssue(index,n?.id,position<0?path.join('.')||'program':path.slice(position+1).join('.')||'node',issue.expected??issue.message,actual);
  }).join('; ');
}
export const EXPRESSION_DESCRIPTION=`Combinational compound/multiple-output expressions only; prefer a dedicated method when it fits. nodes is a topologically ordered AST: input refs use $portName, e.g. $p for the real input p; node refs use #earlierNode. No output/state/code refs. Each node has id and op. CPU infers operand width; omit width except literal and concat, whose width is required. An explicit width must equal the inferred operand width, NOT the one-bit comparison result or resize target. literal has value (a string containing an exact copied integer or known sized Verilog literal; safe nonnegative JSON integers also accepted; Boolean 0/1 and fill '0/'1 allowed), all other nodes have args. Unary ${unary.join('/')} take [ref]; binary ${binary.join('/')} take [left,right]; shl/shr/sar take [ref,constantAmount]; slice takes [ref,LSBoffset,length]; resize takes [ref,newWidth,"zero"|"sign"]; ite takes [oneBitCondition,then,else]; concat takes [highPart,...,lowPart]. Slice length, resize newWidth and concat total width are required. Operand widths must match, except one-bit ite condition; explicitly resize otherwise. Arithmetic wraps; comparisons/logical/reductions return one bit; popcount returns ceil(log2(width+1)). Signed ops slt/sle/sgt/sge/sar and sign resize use two's-complement; no implicit Verilog sizing/signedness. outputs lists EVERY output with value ref and care:null by default. A care mask may use {value:ref,sources:[source addresses explicitly specifying don't-care bits]}; 1 means compare. domain:null by default; only an EXPLICIT source legal-input restriction allows {condition:oneBitRef,sources:[addresses]}. Never exclude difficult inputs or mask specified behavior. CPU owns deterministic vectors, legal filtering, numeric expectations and coverage. Max 128 nodes, dependency depth 12, 8 outputs, 4096 input/output bits, 64 retained vectors. No procedural code, loops, arrays, arbitrary execution, model-selected stimuli or extra inference calls.
Synthetic example, not task data: inputs p and q are four bits; total is their four-bit modular sum and same indicates equality. S1 must actually cite that rule in the current source; replace ports/behavior/citations for the current task.
EXPRESSION_EXAMPLE={"method":"comb_expr","sources":["S1"],"params":{"nodes":[{"id":"sum","op":"add","args":["$p","$q"]},{"id":"eq","op":"eq","args":["$p","$q"]}],"outputs":[{"port":"total","value":"#sum","care":null},{"port":"same","value":"#eq","care":null}],"domain":null}}`;
