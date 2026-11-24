import {invariant, sha256} from '../dual/snapshot.mjs';
import {lex, portContract} from '../dual/unit-index.mjs';
import {planProse} from '../planner/prose.mjs';
import {diagnosticProse} from '../dual/contracts.mjs';
import {expectedInterface} from '../../../competition/agent/interface.mjs';
import {validatePaths,checkSourcePaths} from './paths.mjs';

export const MODULAR_VERSION = 'rtl2llm.modular.v1';
const reserved = new Set(('module endmodule input output inout wire reg logic signed unsigned assign always always_ff always_comb always_latch initial begin end if else case endcase function endfunction generate endgenerate parameter localparam integer for while repeat clocking interface package program __proto__ constructor prototype').split(' '));
const check = (ok, message) => invariant(ok, 'PLAN_MODULE_INVALID', message);
export function identifier(s) { return typeof s === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(s) && !reserved.has(s); }
export function exactKeys(value, keys) {
  check(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(k=>Object.hasOwn(value,k)), 'Missing or unknown contract fields');
}
export function boundedProse(value,{diagnostic=false}={}) {
  check(typeof value === 'string' && value.trim() && value.length <= 800 && !/[\u0000-\u001f]/.test(value), 'Contract prose must be one nonempty line, at most 800 characters');
  if(diagnostic)diagnosticProse(value);else planProse(value);
}
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
function freezeContract(value) {
  for(const child of Object.values(value))if(child&&typeof child==='object')freezeContract(child);
  return Object.freeze(value);
}
function shape(p) {
  check(identifier(p.name) && typeof p.signed === 'boolean', 'Invalid signal name or signedness');
  check(p.range === null || Array.isArray(p.range) && p.range.length === 2 && p.range.every(n=>Number.isSafeInteger(n)&&n>=0&&n<=65535), 'Use null for a scalar or two numeric range bounds');
}
export function topInterfaceSource(task) {
  // An explicit HDL declaration is an exact contract. A source port list only
  // fixes names/directions/widths: implementation conventions must NEVER become
  // invented original signedness/order requirements for an unsplit candidate.
  if(task.interfaceText?.trim()) {
    const top=portContract(task.interfaceText);
    check(top&&top.top===task.top&&!top.ports.some(p=>p.direction==='inout'),'Physical modules require a numeric ANSI interface without inout');
    return {contract:{name:top.top,ports:top.ports.map(p=>({...p,range:p.range?.map(Number)??null}))},
      provenance:{kind:'explicit_interface',interface_sha256:sha256(task.interfaceText),exact_fields:['name','direction','width','signedness','range_orientation','port_order']}};
  }
  const spec=task.spec??'';
  check(/All input and output ports are one bit unless otherwise\s+specified\./i.test(spec),'Prose interfaces need the explicit scalar convention');
  let parsed;try{parsed=expectedInterface(spec,'',task.top);}catch{check(false,'Ambiguous original prose interface');}
  const declarations=spec.split('\n').filter(line=>/^\s*-\s*(input|output|inout)\b/.test(line));
  check(parsed.top===task.top&&!parsed.unresolved.length&&parsed.ports.length>0&&parsed.ports.length<=32&&declarations.length===parsed.ports.length&&parsed.ports.every(p=>p.direction!=='inout'&&Number.isSafeInteger(p.width)&&p.width>0&&p.width<=65536),'Incomplete or unsupported original prose port list');
  const rangeSources={};
  const ports=parsed.ports.map(p=>{
    let range=p.width===1?null:[p.width-1,0];
    const escaped=p.name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const ranges=[...spec.matchAll(new RegExp('\\b'+escaped+'\\s*\\[\\s*(\\d+)\\s*:\\s*(\\d+)\\s*\\]','g'))]
      .map(m=>[Number(m[1]),Number(m[2])]).filter(r=>Math.abs(r[0]-r[1])+1===p.width);
    const unique=[...new Set(ranges.map(r=>JSON.stringify(r)))];
    check(unique.length<=1,'Conflicting full-width source ranges; keep the design whole');
    if(p.width>1&&unique.length)range=JSON.parse(unique[0]);
    rangeSources[p.name]=p.width===1?'scalar':unique.length?'source_full_width_literal':'descending_wiring_convention';
    return {name:p.name,direction:p.direction,signed:false,range};
  });
  return {contract:{name:parsed.top,ports},provenance:{kind:'prose_port_list',spec_sha256:sha256(spec),
    source_fields:['module_name','port_names','directions','bit_widths'],project_conventions:['port_order_from_list','unsigned_connection_representation'],range_sources:rangeSources,
    warning:'These are frozen wiring conventions ONLY for this physical project, not extra original behavioral requirements. Unsigned connections do not imply unsigned arithmetic. The original specification wins; unresolved meaning must use the whole-module path.'}};
}
export function topContract(task) {return topInterfaceSource(task).contract;}
export function validateArchitecture(raw, task, requirements, {maxModules=3,registeredFeedback=false}={}) {
  exactKeys(raw,['benefit','clock','reset','nets','modules','order']);
  boundedProse(raw.benefit);
  exactKeys(raw.clock,['port','edge']); exactKeys(raw.reset,['port','kind','active','priority']);
  const top=topContract(task), signals=new Map(top.ports.map(p=>[p.name,{...p,external:true}]));
  const input = name => signals.get(name)?.direction==='input' && signals.get(name).range===null;
  check(raw.clock.port===null ? raw.clock.edge===null : input(raw.clock.port)&&['posedge','negedge'].includes(raw.clock.edge), 'One explicit scalar input clock, or null for combinational designs');
  check(raw.reset.port===null ? raw.reset.kind==='none'&&raw.reset.active===null : input(raw.reset.port)&&raw.reset.port!==raw.clock.port&&raw.clock.port!==null&&['synchronous','asynchronous'].includes(raw.reset.kind)&&[0,1].includes(raw.reset.active), 'Invalid reset contract');
  boundedProse(raw.reset.priority);
  check(Array.isArray(raw.nets)&&raw.nets.length<=32,'At most 32 internal nets');
  for(const net of raw.nets) {
    exactKeys(net,['name','range','signed','timing']); shape(net); boundedProse(net.timing);
    check(!signals.has(net.name),'Duplicate/internal net shadows top port'); signals.set(net.name,{...net,external:false});
  }
  check(Array.isArray(raw.modules)&&raw.modules.length>=2&&raw.modules.length<=maxModules,'Physical plans require two or three leaf modules');
  const names=new Set(), refs=new Set(requirements.map(r=>r.id)), covered=new Set(), drivers=new Map(), readers=new Map();
  for(const m of raw.modules) {
    exactKeys(m,['name','purpose','requirements','kind','ports','timing','state_owner','session_goal','carry',...(registeredFeedback?['paths']:[])]);
    check(identifier(m.name)&&m.name!==top.name&&!names.has(m.name),'Invalid or duplicate module name'); names.add(m.name);
    for(const k of ['purpose','timing','state_owner','session_goal'])boundedProse(m[k]);
    check(['combinational','sequential'].includes(m.kind),'Unknown module kind');
    check(Array.isArray(m.requirements)&&m.requirements.length>0&&new Set(m.requirements).size===m.requirements.length&&m.requirements.every(r=>refs.has(r)), 'Modules must cite accepted R IDs');
    m.requirements.forEach(r=>covered.add(r));
    check(Array.isArray(m.carry)&&new Set(m.carry).size===m.carry.length&&m.carry.every(k=>['verification','previous_attempts'].includes(k)), 'Only optional verification/previous_attempts carry flags are selectable; safety context is mandatory');
    check(Array.isArray(m.ports)&&m.ports.length>=2&&m.ports.length<=32&&new Set(m.ports.map(p=>p.name)).size===m.ports.length,'Invalid module port set');
    for(const p of m.ports) {
      exactKeys(p,['name','direction','range','signed','net']); shape(p);
      check(['input','output'].includes(p.direction)&&identifier(p.net),'Only explicit input/output connections');
      const n=signals.get(p.net);check(n&&same(n.range,p.range)&&n.signed===p.signed,'Port/net ranges or signedness differ');
      if(p.direction==='output') {
        check(n.direction!=='input'&&!drivers.has(p.net),'Multiple drivers or module drives a top input'); drivers.set(p.net,m.name);
      } else { if(!readers.has(p.net))readers.set(p.net,[]); readers.get(p.net).push(m.name); }
    }
    check(m.ports.some(p=>p.direction==='input')&&m.ports.some(p=>p.direction==='output'),'Each leaf needs inputs and outputs');
    if(m.kind==='sequential') {
      check(raw.clock.port!==null&&m.ports.some(p=>p.direction==='input'&&p.net===raw.clock.port),'Sequential leaf must receive the global clock');
      if(raw.reset.port!==null)check(m.ports.some(p=>p.direction==='input'&&p.net===raw.reset.port),'Sequential leaf must receive the global reset');
    }
  }
  check([...refs].every(r=>covered.has(r)),'Every accepted requirement must have an owner (possibly multiple modules)');
  for(const n of signals.values()) {
    if(n.direction!=='input')check(drivers.has(n.name),'Undriven output/internal net');
    if(!n.external)check(readers.get(n.name)?.length,'Unused internal net');
  }
  check(Array.isArray(raw.order)&&raw.order.length===names.size&&new Set(raw.order).size===names.size&&raw.order.every(n=>names.has(n)),'Order must list each leaf once');
  // Conservative first-version boundary: inter-module feedback (even legitimate
  // registered feedback) uses the unsplit path. This is not a combinational-loop proof.
  if(registeredFeedback)validatePaths(raw.modules);
  else {
    const position=new Map(raw.order.map((n,i)=>[n,i]));
    for(const [net,consumers] of readers)for(const consumer of consumers) {
      const driver=drivers.get(net);
      if(driver)check(position.get(driver)<position.get(consumer),'Cross-module feedback or reversed dependency order: use one module');
    }
  }
  const architecture={version:registeredFeedback?'rtl2llm.modular.v2':MODULAR_VERSION,top,...structuredClone(raw),...(registeredFeedback?{path_mode:'port_combinational_v1'}:{}),semantic_verified:false};
  return freezeContract({...architecture,sha256:sha256(JSON.stringify(architecture))});
}

export function moduleContract(architecture, name) {
  if(name===architecture.top.name)return architecture.top;
  const m=architecture.modules.find(m=>m.name===name);
  invariant(m,'MODULE_UNKNOWN'); return m;
}
export function moduleHeader(contract) {
  // Interface scaffolding only, used in prompts/stream gates, never submitted as RTL.
  return `module ${contract.name}(${contract.ports.map(p=>`${p.direction} ${p.signed?'signed ':''}${p.range?`[${p.range[0]}:${p.range[1]}] `:''}${p.name}`).join(', ')});`;
}
export function checkModuleSource(rtl, architecture, name) {
  const wanted=moduleContract(architecture,name), actual=portContract(rtl);
  invariant(actual && actual.top===name && same(actual.ports,wanted.ports.map(({name,direction,signed,range})=>({name,direction,signed,range:range?.map(String)??null}))), 'MODULE_INTERFACE_MISMATCH','Module interface changed or cannot be resolved');
  const tokens=lex(rtl), t=tokens.map(t=>t.value), headerEnd=t.indexOf(';');
  invariant(t[0]==='module'&&t.at(-1)==='endmodule'&&t.filter(x=>x==='module').length===1&&t.filter(x=>x==='endmodule').length===1,'MODULE_SOURCE_INVALID','Exactly one complete module is required');
  const body=t.slice(headerEnd+1,-1);
  if(name===architecture.top.name)checkTopBody(body,architecture);
  else {
    invariant(!body.some(x=>['.','initial','force','release','defparam','interface','package','program','task'].includes(x)), 'MODULE_SOURCE_INVALID','Leaf uses hierarchy, simulation controls or unsupported source');
    // Instances cannot silently introduce a new dependency. Ordinary arithmetic,
    // arrays and procedural blocks still require the actual compiler to validate.
    for(let i=0;i<body.length-2;i++)invariant(!(identifier(body[i])&&identifier(body[i+1])&&body[i+2]==='('),'MODULE_SOURCE_INVALID','Leaf cannot instantiate another module');
    for(let i=0;i<body.length;i++)if(body[i]==='@') {
      let event=[];
      if(body[i+1]==='*')continue;
      invariant(body[i+1]==='(','MODULE_SOURCE_INVALID','Unsupported sensitivity list');
      let j=i+2;while(j<body.length&&body[j]!==')')event.push(body[j++]);
      invariant(j<body.length,'MODULE_SOURCE_INVALID','Unclosed sensitivity list');
      if(architecture.path_mode&&event.some(x=>['posedge','negedge'].includes(x))) {
        invariant(event.every((x,k)=>['posedge','negedge'].includes(x)?k===0||['or',','].includes(event[k-1]):['or',','].includes(x)?k>0&&identifier(event[k-1]):identifier(x)&&['posedge','negedge'].includes(event[k-1])),'MODULE_SOURCE_INVALID','Edge process must not contain a level-sensitive event');
      }
      for(let k=0;k<event.length;k++)if(['posedge','negedge'].includes(event[k])) {
        const p=wanted.ports.find(p=>p.name===event[k+1]&&p.direction==='input');
        const clock=p?.net===architecture.clock.port&&event[k]===architecture.clock.edge;
        const reset=architecture.reset.port!==null&&p?.net===architecture.reset.port&&architecture.reset.kind==='asynchronous'&&event[k]===(architecture.reset.active?'posedge':'negedge');
        invariant(wanted.kind==='sequential'&&(clock||reset),'MODULE_SOURCE_INVALID','Undeclared clock/reset edge or generated clock');
      }
    }
    if(architecture.path_mode)checkSourcePaths(rtl,wanted);
  }
  return {status:'pass',scope:'bounded_structure_and_interface_only',functional_verified:false};
}
function checkTopBody(t,a) {
  let i=0;const declared=new Set(),instances=new Set(),instanceNames=new Set();
  const take=x=>{invariant(t[i++]===x,'MODULE_WIRING_MISMATCH','Top must contain only declared nets and exact named-port instances');};
  while(i<t.length) {
    if(['wire','logic'].includes(t[i])) {
      i++;let signed=false,range=null;
      if(['signed','unsigned'].includes(t[i]))signed=t[i++]==='signed';
      if(t[i]==='['){i++;range=[Number(t[i++])];take(':');range.push(Number(t[i++]));take(']');}
      do {
        const name=t[i++],n=a.nets.find(n=>n.name===name);
        invariant(n&&!declared.has(name)&&same(n.range,range)&&n.signed===signed,'MODULE_WIRING_MISMATCH','Unexpected net declaration');declared.add(name);
        if(t[i]!==',')break;i++;
      }while(i<t.length);take(';');
    } else {
      const name=t[i++],m=a.modules.find(m=>m.name===name),instance=t[i++];
      invariant(m&&!instances.has(name)&&identifier(instance)&&!instanceNames.has(instance)&&!a.top.ports.some(p=>p.name===instance)&&!a.nets.some(p=>p.name===instance),'MODULE_WIRING_MISMATCH','Unknown/duplicate module instance');
      instances.add(name);instanceNames.add(instance);take('(');const ports=new Set();
      do {
        take('.');const port=t[i++],p=m.ports.find(p=>p.name===port);take('(');const net=t[i++];take(')');
        invariant(p&&!ports.has(port)&&p.net===net,'MODULE_WIRING_MISMATCH','Connection differs from frozen contract');ports.add(port);
        if(t[i]!==',')break;i++;
      }while(i<t.length);take(')');take(';');
      invariant(ports.size===m.ports.length,'MODULE_WIRING_MISMATCH','Missing instance port');
    }
  }
  invariant(declared.size===a.nets.length&&instances.size===a.modules.length,'MODULE_WIRING_MISMATCH','Missing nets or instances');
}
