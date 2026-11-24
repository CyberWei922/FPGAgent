import {z} from 'zod';

const name=z.string().regex(/^[A-Za-z_]\w*$/).max(100);
const source=z.string().min(1).max(160);
const obj=shape=>z.object(shape).strict();
const clock=obj({port:name,edge:z.enum(['posedge','negedge']),source});
const bit=z.union([z.literal(0),z.literal(1)]);

export const NEWTYPE_DEFINITIONS={
 sync_memory:{
  params:obj({
   clock,
   write:obj({enable:name,address:name,data:name,source}),
   read:obj({address:name,data:name,latency:z.union([z.literal(0),z.literal(1)]),source}),
   same_address:obj({behavior:z.enum(['old','new','unspecified']),source:source.nullable()})
  }),
  review:true,
  description:'Single-clock RAM with separate write/read addresses. Harness derives address/data widths and depth from ports, writes known asymmetric data, and checks reads. read.latency is 0 only for combinational/asynchronous read and 1 only for an edge-registered read. same_address is old/new only when the original task explicitly specifies the value observed by a registered read during a same-address write; otherwise use unspecified and source=null. Every source field must exactly equal one address already listed in outer sources and that source range must directly name the sibling ports/behavior. Do not guess reset, initialization, latency, collision policy, or memory contents.',
  focus:['write then read known addresses','zero versus one-edge read latency','source-specified same-address old/new data'],
  limits:['one clock and one write port','separate equal-width read/write addresses','unwritten locations and unspecified collisions are not checked']
 },
 sync_fifo:{
  params:obj({
   clock,
   reset:obj({port:name,active:bit,kind:z.enum(['sync','async','unspecified']),source}),
   roles:obj({push:name,pop:name,data_in:name,data_out:name,full:name,empty:name,count:name.nullable(),source}),
   depth:obj({value:z.number().int().min(2).max(32),source}),
   read_mode:obj({value:z.enum(['show_ahead','registered']),source}),
   boundary:obj({overflow:z.enum(['ignore','unspecified']),underflow:z.enum(['ignore','unspecified']),source:source.nullable()}),
   simultaneous:obj({value:z.enum(['both','unspecified']),source:source.nullable()})
  }),
  review:true,
  description:'Single-clock FIFO. Harness owns queue contents, pointers, fill/drain/bursty traffic, and full/empty/count expectations. depth.value must copy the explicit entry count. read_mode=show_ahead means data_out continuously shows the front item; registered means data_out changes to the popped item on a successful pop. boundary ignore is allowed only when the task explicitly says a push while full or pop while empty is ignored; otherwise unspecified prevents that operation. simultaneous=both only when the task explicitly says a legal simultaneous push and pop both occur; otherwise unspecified prevents the combination. Every source field must exactly equal one address in outer sources and directly support its sibling fields. Never infer depth, reset, output phase, boundary, or simultaneous behavior.',
  focus:['empty and full boundary transitions','FIFO data order','show-ahead versus pop-registered output','source-specified boundary and simultaneous operations'],
  limits:['one clock and one data lane','depth 2..32','unspecified overflow/underflow/simultaneous behavior is not stimulated']
 },
 valid_group:{
  params:obj({
   clock,
   reset:obj({port:name,active:bit,kind:z.enum(['sync','async','unspecified']),source}),
   roles:obj({valid_in:name,data_in:name,out:name,valid_out:name,source}),
   group:obj({size:z.number().int().min(2).max(16),operation:z.enum(['sum','concat_first_high','concat_first_low']),source}),
   output_timing:obj({value:z.enum(['same_edge','next_edge']),source})
  }),
  review:true,
  description:'Group only samples whose valid_in is high into fixed groups. Harness inserts valid gaps, back-to-back groups, and reset during a partial group. group.size copies the explicit number of valid samples. operation=sum computes their unsigned mathematical sum; concat_first_high puts the first sample in the most-significant lane, concat_first_low in the least-significant lane. output_timing=same_edge asserts valid_out with the result immediately after the edge accepting the last sample; next_edge asserts it one active edge later. valid_out is a one-edge result indication. Every source field must exactly equal an address in outer sources and directly support its sibling fields. Never infer size, operation/order, reset, or output phase.',
  focus:['valid gaps do not advance the group','first/last concatenation order or full-precision sum','completion-edge versus next-edge valid pulse','reset discards a partial group'],
  limits:['group size 2..16','one input lane and one result lane','sum requires a full-precision output; concatenation requires exact lane width']
 },
 bounce_counter:{
  params:obj({
   clock,
   reset:obj({port:name,active:bit,kind:z.enum(['sync','async','unspecified']),source}),
   roles:obj({out:name,source}),
   range:obj({low:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),high:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),step:z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),source}),
   endpoint:obj({behavior:z.enum(['reverse_immediately','hold_one']),source})
  }),
  review:true,
  description:'Autonomous up/down bounce counter over an inclusive source-declared low..high range. Reset establishes out=low and upward direction. step is the exact amount per active edge and must evenly divide high-low. reverse_immediately moves away from an endpoint on the very next active edge; hold_one keeps the endpoint value for exactly one extra active edge before moving away. Harness checks two continuous low-high-low traversals with endpoint observations, then reset during activity. Every source field must exactly equal an address in outer sources and directly support its sibling fields. Never infer range, step, reset direction, or endpoint dwell.',
  focus:['inclusive low and high values','up and down step size','immediate reversal versus one-edge endpoint hold','reset restores low and upward direction'],
  limits:['autonomous counter with no enable/load','nonnegative exactly divisible range','endpoint observations; batched long interiors']
 }
};

export function registerNewtypeMethods(definitions){
 Object.assign(definitions,NEWTYPE_DEFINITIONS);
}

export const newtypesEnabled=()=>process.env.AGENT_VERIFICATION_NEWTYPES==='1';

const normalized=name=>name.toLowerCase().replace(/[^a-z0-9]/g,'');
const isClock=p=>p.direction==='input'&&p.width===1&&/^(?:clk|clock|.*clock)$/.test(normalized(p.name));
const isWriteEnable=p=>p.direction==='input'&&p.width===1&&/^(?:we|wen|wren|writeen|writeenable)$/.test(normalized(p.name));
const isWriteAddress=p=>p.direction==='input'&&/(?:waddr|wraddr|writeaddr|writeaddress)/.test(normalized(p.name));
const isReadAddress=p=>p.direction==='input'&&/(?:raddr|rdaddr|readaddr|readaddress)/.test(normalized(p.name));
const isWriteData=p=>p.direction==='input'&&/(?:wdata|wrdata|writedata|datain|din)/.test(normalized(p.name));
const isReadData=p=>p.direction==='output'&&/(?:rdata|rddata|readdata|dataout|dout|q)/.test(normalized(p.name));
const isReset=p=>p.direction==='input'&&p.width===1&&/^(?:rst|reset|resetn|rstn)$/.test(normalized(p.name));
const isPush=p=>p.direction==='input'&&p.width===1&&/^(?:push|write|wr|wen|wren|writeenable)$/.test(normalized(p.name));
const isPop=p=>p.direction==='input'&&p.width===1&&/^(?:pop|read|rd|ren|rden|readenable)$/.test(normalized(p.name));
const isFifoDataIn=p=>p.direction==='input'&&/(?:datain|din|wdata|wrdata)/.test(normalized(p.name));
const isFifoDataOut=p=>p.direction==='output'&&/(?:dataout|dout|rdata|rddata)/.test(normalized(p.name));
const isFull=p=>p.direction==='output'&&p.width===1&&normalized(p.name)==='full';
const isEmpty=p=>p.direction==='output'&&p.width===1&&normalized(p.name)==='empty';
const isCount=p=>p.direction==='output'&&/(?:count|level|used|occupancy)/.test(normalized(p.name));
const isValidIn=p=>p.direction==='input'&&p.width===1&&/(?:validin|invalid|datavalid|inputvalid|ivalid)/.test(normalized(p.name));
const isValidOut=p=>p.direction==='output'&&p.width===1&&/(?:validout|outvalid|resultvalid|outputvalid|ovalid|done)/.test(normalized(p.name));
const isGroupDataIn=p=>p.direction==='input'&&/^(?:datain|inputdata|din|samplein|valuein)$/.test(normalized(p.name));
const isGroupDataOut=p=>p.direction==='output'&&/^(?:dataout|outputdata|dout|result|resultdata|sum|sumout|groupout|groupdataout)$/.test(normalized(p.name));
const isCounterOut=p=>p.direction==='output'&&/^(?:count|counter|countout|value|q|out)$/.test(normalized(p.name));

// Eligibility uses only resolved interface structure and conventional port-role
// names. Task titles, benchmark IDs, and prose keywords never open this menu.
export function newtypeMethodEligible(id,{expected}){
 if(!Object.hasOwn(NEWTYPE_DEFINITIONS,id))return null;
 if(!newtypesEnabled())return false;
 const ports=expected.ports??[];
 if(id==='sync_memory'){
  if(ports.length!==6)return false;
  const clockPorts=ports.filter(isClock),writeEnables=ports.filter(isWriteEnable),writeAddresses=ports.filter(isWriteAddress),readAddresses=ports.filter(isReadAddress),writeData=ports.filter(isWriteData),readData=ports.filter(isReadData);
  return [clockPorts,writeEnables,writeAddresses,readAddresses,writeData,readData].every(rows=>rows.length===1)
   &&writeAddresses[0].width===readAddresses[0].width&&writeData[0].width===readData[0].width;
 }
 if(id==='sync_fifo'){
  if(ports.length!==8&&ports.length!==9)return false;
  const groups=[ports.filter(isClock),ports.filter(isReset),ports.filter(isPush),ports.filter(isPop),ports.filter(isFifoDataIn),ports.filter(isFifoDataOut),ports.filter(isFull),ports.filter(isEmpty)];
  if(!groups.every(rows=>rows.length===1)||groups[4][0].width!==groups[5][0].width)return false;
  const remaining=ports.filter(port=>!groups.flat().includes(port));
  return remaining.length===0||remaining.length===1&&isCount(remaining[0]);
 }
 if(id==='valid_group'){
  if(ports.length!==6)return false;
  const groups=[ports.filter(isClock),ports.filter(isReset),ports.filter(isValidIn),ports.filter(isGroupDataIn),ports.filter(isValidOut),ports.filter(isGroupDataOut)];
  return groups.every(rows=>rows.length===1)&&new Set(groups.flat()).size===6;
 }
 if(id==='bounce_counter')return ports.length===3&&ports.filter(isClock).length===1&&ports.filter(isReset).length===1&&ports.filter(isCounterOut).length===1;
 return false;
}
