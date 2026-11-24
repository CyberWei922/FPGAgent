import {invariant} from '../dual/snapshot.mjs';
import {newtypesEnabled} from './newtype-registry.mjs';

const check=(ok,message)=>invariant(ok,'TEST_PLAN_INVALID',message);
const compact=text=>text.replace(/\s+/g,' ').trim();
const mask=width=>(1n<<BigInt(width))-1n;
const word=name=>new RegExp('(?:^|[^A-Za-z0-9_])'+name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?:$|[^A-Za-z0-9_])','i');

function evidence(refs,address,label){
 const row=refs.find(ref=>ref.address===address);
 check(row,`${label}.source must exactly match one address from outer sources`);
 return compact(row.quote);
}
function namesIn(quote,names,label){
 check(names.every(name=>word(name).test(quote)),`${label}.source must directly name ${names.join(', ')}`);
}
function clockEvidence(quote,clock){
 namesIn(quote,[clock.port],'clock');
 const edge=clock.edge==='posedge'?/(?:posedge|positive|rising)\s*(?:clock\s*)?edge|rising\s+edge/i:/(?:negedge|negative|falling)\s*(?:clock\s*)?edge|falling\s+edge/i;
 check(edge.test(quote),'clock.source must directly specify the selected active edge');
}
const resetCycles=kind=>kind==='async'?0:kind==='unspecified'?2:1;

export function compileNewtypeOracle(method,p,{refs,port,emit,pattern,uncovered,calculations,setClock}){
 if(!['sync_memory','sync_fifo','valid_group','bounce_counter'].includes(method))return false;
 check(newtypesEnabled(),'New-type verification is disabled; set AGENT_VERIFICATION_NEWTYPES=1');
 if(method==='bounce_counter'){
  const clockQuote=evidence(refs,p.clock.source,'clock');clockEvidence(clockQuote,p.clock);
  const resetQuote=evidence(refs,p.reset.source,'reset');namesIn(resetQuote,[p.reset.port],'reset');
  check((p.reset.active===1?/(?:active[- ]high|when\s+\w+\s+is\s+high|assert(?:ed)?\s+high)/i:/(?:active[- ]low|when\s+\w+\s+is\s+low|assert(?:ed)?\s+low)/i).test(resetQuote),'reset.source must directly specify reset polarity');
  if(p.reset.kind!=='unspecified')check((p.reset.kind==='sync'?/\bsynchronous\b|on\s+(?:the\s+)?(?:rising|falling|active|clock)\s+edge/i:/\basynchronous\b|independent\s+of\s+(?:the\s+)?clock/i).test(resetQuote),'reset.source must directly specify sync/async reset');
  const rolesQuote=evidence(refs,p.roles.source,'roles');namesIn(rolesQuote,[p.roles.out],'roles');
  check(/count|counter|value|output/i.test(rolesQuote),'roles.source must directly identify the counter output');
  const rangeQuote=evidence(refs,p.range.source,'range');namesIn(rangeQuote,[p.roles.out],'range');
  for(const [label,value] of Object.entries(p.range))if(label!=='source')check(new RegExp('(?:^|[^0-9])'+value+'(?:[^0-9]|$)').test(rangeQuote),`range.source must directly contain ${label}=${value}`);
  check(/(?:low|minimum|min)[^.!?]*(?:high|maximum|max)|(?:range|between)[^.!?]*(?:inclusive)/i.test(rangeQuote)&&/(?:step|increment|decrement|changes?\s+by|moves?\s+by)/i.test(rangeQuote),'range.source must directly specify inclusive bounds and step');
  const endpointQuote=evidence(refs,p.endpoint.source,'endpoint');
  const endpointEvidence=p.endpoint.behavior==='reverse_immediately'?/(?:immediate|next\s+(?:active\s+)?edge|without\s+(?:an?\s+)?(?:extra\s+)?hold|no\s+(?:extra\s+)?(?:hold|pause))[^.!?]*(?:revers|move\s+away)|(?:revers|move\s+away)[^.!?]*(?:immediate|next\s+(?:active\s+)?edge|without\s+(?:an?\s+)?(?:extra\s+)?hold|no\s+(?:extra\s+)?(?:hold|pause))/i:/(?:hold|remain|stay|pause)[^.!?]*(?:one|1)[^.!?]*(?:edge|cycle)|(?:one|1)[^.!?]*(?:extra\s+)?(?:edge|cycle)[^.!?]*(?:hold|remain|stay|pause)/i;
  check(endpointEvidence.test(endpointQuote),'endpoint.source must directly specify immediate reversal or exactly one held edge');
  check(/(?:reset|clear)[^.!?]*(?:low|minimum|min|upward|up\s+direction)|(?:low|minimum|min|upward|up\s+direction)[^.!?]*(?:reset|clear)/i.test(resetQuote),'reset.source must directly specify low value/upward direction after reset');

  setClock({port:p.clock.port,edge:p.clock.edge});port(p.reset.port,'input',1);const out=port(p.roles.out,'output');
  const low=BigInt(p.range.low),high=BigInt(p.range.high),step=BigInt(p.range.step);check(low<high&&(high-low)%step===0n,'Bounce range must be increasing and exactly divisible by step');
  check(high<=mask(out.width),'Bounce range exceeds output width');const span=Number((high-low)/step);check(Number.isSafeInteger(span)&&span>=1&&span<=2000000,'Bounce traversal exceeds clock budget');
  const idle={[p.reset.port]:1-p.reset.active},active={[p.reset.port]:p.reset.active};
  const observe=(cycles,value)=>emit(idle,{[p.roles.out]:value},cycles);
  emit(active,{[p.roles.out]:low},resetCycles(p.reset.kind));
  observe(span,high);
  for(let traversal=0;traversal<2;traversal++){
   if(p.endpoint.behavior==='hold_one')observe(1,high);
   observe(1,high-step);
   observe(span-1,low);
   if(p.endpoint.behavior==='hold_one')observe(1,low);
   observe(1,low+step);
   if(traversal===0)observe(span-1,high);
  }
  if(p.reset.kind==='unspecified')uncovered.push('Reset sync/async timing is unspecified; reset is held only at startup and mid-activity reset timing is not checked.');
  else{emit(active,{[p.roles.out]:low},resetCycles(p.reset.kind));observe(1,low+step);}
  uncovered.push('Two continuous traversals and reset recovery are checked; intermediate values in batched long intervals are not individually observed. Enable, load, saturation, and non-divisible endpoint behavior are outside this method.');
  calculations.push({method:'source-declared-bounce-counter',oracle:'cpu_endpoint_model',candidate_read:false,low:p.range.low,high:p.range.high,step:p.range.step,endpoint:p.endpoint.behavior});
  return true;
 }
 if(method==='valid_group'){
  const clockQuote=evidence(refs,p.clock.source,'clock');clockEvidence(clockQuote,p.clock);
  const resetQuote=evidence(refs,p.reset.source,'reset');namesIn(resetQuote,[p.reset.port],'reset');
  check((p.reset.active===1?/(?:active[- ]high|when\s+\w+\s+is\s+high|assert(?:ed)?\s+high)/i:/(?:active[- ]low|when\s+\w+\s+is\s+low|assert(?:ed)?\s+low)/i).test(resetQuote),'reset.source must directly specify reset polarity');
  if(p.reset.kind!=='unspecified')check((p.reset.kind==='sync'?/\bsynchronous\b|on\s+(?:the\s+)?(?:rising|falling|active|clock)\s+edge/i:/\basynchronous\b|independent\s+of\s+(?:the\s+)?clock/i).test(resetQuote),'reset.source must directly specify sync/async reset');
  check(/(?:reset|clear|discard)[^.!?]*(?:partial|group|accumul|valid)|(?:partial|group|accumul|valid)[^.!?]*(?:reset|clear|discard)/i.test(resetQuote),'reset.source must directly specify clearing partial group state/result-valid');
  const rolesQuote=evidence(refs,p.roles.source,'roles');namesIn(rolesQuote,[p.roles.valid_in,p.roles.data_in,p.roles.out,p.roles.valid_out],'roles');
  check(/valid[^.!?]*(?:sample|input|data)|(?:sample|input|data)[^.!?]*valid/i.test(rolesQuote)&&/(?:pulse|one[- ](?:cycle|edge)|result\s+valid|output\s+valid)/i.test(rolesQuote),'roles.source must directly describe valid-qualified samples and a result-valid pulse');
  const groupQuote=evidence(refs,p.group.source,'group');
  check(new RegExp('(?:^|[^0-9])'+p.group.size+'(?:[^0-9]|$)').test(groupQuote)&&/(?:valid\s+(?:samples|inputs|items|values)|group\s+(?:of|size)|every\s+group)/i.test(groupQuote),'group.source must directly state the number of valid samples per group');
  if(p.group.operation==='sum')check(/\b(?:sum|add|accumulat)/i.test(groupQuote),'group.source must directly specify accumulation/sum');
  else{
   check(/concat|concatenat|pack/i.test(groupQuote),'group.source must directly specify concatenation');
   const order=p.group.operation==='concat_first_high'?/(?:first|earliest)[^.!?]*(?:most[- ]significant|high)|(?:most[- ]significant|high)[^.!?]*(?:first|earliest)/i:/(?:first|earliest)[^.!?]*(?:least[- ]significant|low)|(?:least[- ]significant|low)[^.!?]*(?:first|earliest)/i;
   check(order.test(groupQuote),'group.source must directly specify where the first sample is placed');
  }
  const timingQuote=evidence(refs,p.output_timing.source,'output_timing');namesIn(timingQuote,[p.roles.valid_in,p.roles.valid_out],'output_timing');
  const timingEvidence=p.output_timing.value==='same_edge'?/(?:same|completion|accepting)[^.!?]*(?:edge|cycle)[^.!?]*(?:last|final)|(?:last|final)[^.!?]*(?:sample|input)[^.!?]*(?:same|completion)[^.!?]*(?:edge|cycle)/i:/(?:one|next|following)[- ](?:edge|cycle)|one\s+(?:active\s+)?edge\s+later/i;
  check(timingEvidence.test(timingQuote),'output_timing.source must directly specify completion-edge or next-edge output timing');

  setClock({port:p.clock.port,edge:p.clock.edge});port(p.reset.port,'input',1);port(p.roles.valid_in,'input',1);
  const dataIn=port(p.roles.data_in,'input'),out=port(p.roles.out,'output');port(p.roles.valid_out,'output',1);
  if(p.group.operation==='sum'){
   const need=dataIn.width+Math.ceil(Math.log2(p.group.size));check(out.width>=need,'Sum output is too narrow for the full unsigned group sum');
  }else check(out.width===dataIn.width*p.group.size,'Concatenation output width must equal input width times group size');

  const resetActive=p.reset.active,resetIdle=1-resetActive,idle={[p.reset.port]:resetIdle,[p.roles.valid_in]:0,[p.roles.data_in]:0};
  let values=[],pending=null;
  const result=items=>p.group.operation==='sum'?items.reduce((sum,value)=>sum+value,0n):p.group.operation==='concat_first_high'?items.reduce((packed,value)=>(packed<<BigInt(dataIn.width))|value,0n):items.reduce((packed,value,index)=>packed|(value<<BigInt(index*dataIn.width)),0n);
  const step=(valid,value=0n)=>{
   let visible=p.output_timing.value==='next_edge'?pending:null;pending=null;
   if(valid){values.push(value&mask(dataIn.width));if(values.length===p.group.size){const completed=result(values)&mask(out.width);values=[];if(p.output_timing.value==='same_edge')visible=completed;else pending=completed;}}
   emit({...idle,[p.roles.valid_in]:Number(valid),[p.roles.data_in]:value},{[p.roles.valid_out]:Number(visible!==null),...(visible!==null?{[p.roles.out]:visible}:{})},1);
  };
  const reset=()=>{values=[];pending=null;emit({...idle,[p.reset.port]:resetActive},{[p.roles.valid_out]:0},resetCycles(p.reset.kind));};
  const value=index=>(pattern(dataIn.width,Boolean(index&1))^BigInt(index*0x13+1))&mask(dataIn.width);
  reset();step(true,value(0));step(false,value(9));for(let index=1;index<p.group.size;index++)step(true,value(index));if(pending!==null)step(false);
  for(let index=0;index<p.group.size*2;index++)step(true,value(index+17));if(pending!==null)step(false);
  if(p.reset.kind==='unspecified')uncovered.push('Reset sync/async timing is unspecified; reset is held only at startup and partial-group reset timing is not checked.');
  else{step(true,value(41));step(false);reset();for(let index=0;index<p.group.size;index++)step(true,value(index+53));if(pending!==null)step(false);}
  uncovered.push('Only deterministic groups, inserted valid gaps, back-to-back completion, and source-specified reset behavior are checked; arbitrary long streams remain untested.');
  calculations.push({method:'source-declared-valid-group',oracle:'cpu_group_model',candidate_read:false,size:p.group.size,operation:p.group.operation,output_timing:p.output_timing.value});
  return true;
 }
 if(method==='sync_fifo'){
  const clockQuote=evidence(refs,p.clock.source,'clock');clockEvidence(clockQuote,p.clock);
  const resetQuote=evidence(refs,p.reset.source,'reset');namesIn(resetQuote,[p.reset.port],'reset');
  check((p.reset.active===1?/(?:active[- ]high|when\s+\w+\s+is\s+high|assert(?:ed)?\s+high)/i:/(?:active[- ]low|when\s+\w+\s+is\s+low|assert(?:ed)?\s+low)/i).test(resetQuote),'reset.source must directly specify reset polarity');
  if(p.reset.kind!=='unspecified')check((p.reset.kind==='sync'?/\bsynchronous\b|on\s+(?:the\s+)?(?:rising|falling|active|clock)\s+edge/i:/\basynchronous\b|independent\s+of\s+(?:the\s+)?clock/i).test(resetQuote),'reset.source must directly specify sync/async reset');
  check(/(?:reset|clear)[^.!?]*(?:empty|queue|fifo)|(?:empty|queue|fifo)[^.!?]*(?:reset|clear)/i.test(resetQuote),'reset.source must directly specify an empty queue after reset');
  const roleNames=[p.roles.push,p.roles.pop,p.roles.data_in,p.roles.data_out,p.roles.full,p.roles.empty,...(p.roles.count?[p.roles.count]:[])];
  const rolesQuote=evidence(refs,p.roles.source,'roles');namesIn(rolesQuote,roleNames,'roles');
  check(/fifo|queue|first[- ]in|push|enqueue/i.test(rolesQuote)&&/pop|dequeue|read/i.test(rolesQuote),'roles.source must directly describe FIFO push/pop roles');
  const depthQuote=evidence(refs,p.depth.source,'depth');
  check(new RegExp('(?:^|[^0-9])'+p.depth.value+'(?:[^0-9]|$)').test(depthQuote)&&/(?:depth|entries|words|items|locations|capacity)/i.test(depthQuote),'depth.source must directly state the copied FIFO depth');
  const modeQuote=evidence(refs,p.read_mode.source,'read_mode');namesIn(modeQuote,[p.roles.data_out],'read_mode');
  const modeEvidence=p.read_mode.value==='show_ahead'?/(?:show[- ]ahead|first[- ]word[- ]fall[- ]through|combinational|continuous(?:ly)?)[^.!?]*(?:front|head|data|output)|(?:front|head|data|output)[^.!?]*(?:show[- ]ahead|first[- ]word[- ]fall[- ]through|combinational|continuous(?:ly)?)/i:/(?:registered|on\s+(?:a\s+)?successful\s+pop|after\s+(?:a\s+)?successful\s+pop|popped\s+(?:item|word|data))[^.!?]*(?:data|output)|(?:data|output)[^.!?]*(?:registered|on\s+(?:a\s+)?successful\s+pop|after\s+(?:a\s+)?successful\s+pop|popped\s+(?:item|word|data))/i;
  check(modeEvidence.test(modeQuote),'read_mode.source must directly specify show-ahead or registered-pop output timing');

  const boundarySpecified=p.boundary.overflow==='ignore'||p.boundary.underflow==='ignore';
  check(boundarySpecified===Boolean(p.boundary.source),'boundary.source must be null exactly when both boundary behaviors are unspecified');
  if(boundarySpecified){
   const boundaryQuote=evidence(refs,p.boundary.source,'boundary');
   if(p.boundary.overflow==='ignore')check(/(?:push|write|enqueue)[^.!?]*(?:full)[^.!?]*(?:ignore|no\s+(?:effect|change)|not\s+(?:accepted|written))|full[^.!?]*(?:push|write|enqueue)[^.!?]*(?:ignore|no\s+(?:effect|change)|not\s+(?:accepted|written))/i.test(boundaryQuote),'boundary.source must directly say a push while full is ignored');
   if(p.boundary.underflow==='ignore')check(/(?:pop|read|dequeue)[^.!?]*(?:empty)[^.!?]*(?:ignore|no\s+(?:effect|change)|not\s+(?:accepted|read))|empty[^.!?]*(?:pop|read|dequeue)[^.!?]*(?:ignore|no\s+(?:effect|change)|not\s+(?:accepted|read))/i.test(boundaryQuote),'boundary.source must directly say a pop while empty is ignored');
  }
  if(!boundarySpecified)uncovered.push('Overflow and underflow behavior is unspecified; push while full and pop while empty are not stimulated.');

  check((p.simultaneous.value==='both')===Boolean(p.simultaneous.source),'simultaneous.source must be present exactly when both operations are specified');
  if(p.simultaneous.value==='both'){
   const simultaneousQuote=evidence(refs,p.simultaneous.source,'simultaneous');
   check(/(?:simultaneous|same\s+(?:cycle|edge))[^.!?]*(?:push|write)[^.!?]*(?:pop|read)|(?:push|write)[^.!?]*(?:and|with)[^.!?]*(?:pop|read)[^.!?]*(?:both|simultaneous|same\s+(?:cycle|edge))/i.test(simultaneousQuote),'simultaneous.source must directly say legal push and pop both occur');
  }else uncovered.push('Simultaneous push/pop behavior is unspecified and is not stimulated.');

  setClock({port:p.clock.port,edge:p.clock.edge});port(p.reset.port,'input',1);port(p.roles.push,'input',1);port(p.roles.pop,'input',1);
  const dataIn=port(p.roles.data_in,'input'),dataOut=port(p.roles.data_out,'output',dataIn.width);port(p.roles.full,'output',1);port(p.roles.empty,'output',1);
  const countPort=p.roles.count===null?null:port(p.roles.count,'output');
  if(countPort)check((1n<<BigInt(countPort.width))>BigInt(p.depth.value),'FIFO count output cannot represent depth');
  check(dataIn.width<=512,'sync_fifo supports data widths up to 512');
  const resetActive=p.reset.active,resetIdle=1-resetActive,idle={[p.reset.port]:resetIdle,[p.roles.push]:0,[p.roles.pop]:0,[p.roles.data_in]:0};
  const queue=[],outputs=(data=null)=>({[p.roles.full]:Number(queue.length===p.depth.value),[p.roles.empty]:Number(queue.length===0),...(countPort?{[p.roles.count]:queue.length}:{}),...(data!==null?{[p.roles.data_out]:data}:{})});
  const reset=()=>{queue.length=0;emit({...idle,[p.reset.port]:resetActive},outputs(),resetCycles(p.reset.kind));};
  const pushValue=index=>(pattern(dataIn.width,Boolean(index&1))^BigInt(index*0x2b+5))&mask(dataIn.width);
  reset();
  for(let index=0;index<p.depth.value;index++){
   const value=pushValue(index);queue.push(value);emit({...idle,[p.roles.push]:1,[p.roles.data_in]:value},outputs(p.read_mode.value==='show_ahead'?queue[0]:null),1);
  }
  if(p.boundary.overflow==='ignore')emit({...idle,[p.roles.push]:1,[p.roles.data_in]:pushValue(p.depth.value+3)},outputs(p.read_mode.value==='show_ahead'?queue[0]:null),1);
  while(queue.length){
   const popped=queue.shift(),visible=p.read_mode.value==='registered'?popped:queue.length?queue[0]:null;
   emit({...idle,[p.roles.pop]:1},outputs(visible),1);
  }
  if(p.boundary.underflow==='ignore')emit({...idle,[p.roles.pop]:1},outputs(),1);
  for(let index=0;index<2;index++){
   const value=pushValue(index+11);queue.push(value);emit({...idle,[p.roles.push]:1,[p.roles.data_in]:value},outputs(p.read_mode.value==='show_ahead'?queue[0]:null),1);
   const popped=queue.shift();emit({...idle,[p.roles.pop]:1},outputs(p.read_mode.value==='registered'?popped:null),1);
  }
  for(let index=0;index<2;index++){const value=pushValue(index+15);queue.push(value);emit({...idle,[p.roles.push]:1,[p.roles.data_in]:value},outputs(p.read_mode.value==='show_ahead'?queue[0]:null),1);}
  if(p.simultaneous.value==='both'){
   const popped=queue.shift(),value=pushValue(19);queue.push(value);
   emit({...idle,[p.roles.push]:1,[p.roles.pop]:1,[p.roles.data_in]:value},outputs(p.read_mode.value==='registered'?popped:queue[0]),1);
  }
  if(p.reset.kind==='unspecified')uncovered.push('Reset sync/async timing is unspecified; reset is held only at startup and mid-traffic reset timing is not checked.');
  else reset();
  uncovered.push('Only one bounded fill/drain sequence, one short burst, and source-specified boundary cases are checked; arbitrary long traffic remains untested.');
  calculations.push({method:'source-declared-sync-fifo',oracle:'cpu_queue_model',candidate_read:false,depth:p.depth.value,read_mode:p.read_mode.value});
  return true;
 }
 const clockQuote=evidence(refs,p.clock.source,'clock');clockEvidence(clockQuote,p.clock);
 const writeQuote=evidence(refs,p.write.source,'write');namesIn(writeQuote,[p.write.enable,p.write.address,p.write.data],'write');
 check(/writ|stor|memory|ram/i.test(writeQuote),'write.source must directly describe the memory write');
 const readQuote=evidence(refs,p.read.source,'read');namesIn(readQuote,[p.read.address,p.read.data],'read');
 const latencyEvidence=p.read.latency===0?/(?:\basynchronous\b|\bcombinational\b|\bimmediate(?:ly)?\b|without\s+(?:a\s+)?clock|same\s+cycle)[^.!?]*(?:read|output)|(?:read|output)[^.!?]*(?:\basynchronous\b|\bcombinational\b|\bimmediate(?:ly)?\b|without\s+(?:a\s+)?clock|same\s+cycle)/i:/(?:\bsynchronous\b|\bregistered\b|one[- ]cycle|next\s+(?:clock\s+)?(?:cycle|edge)|following\s+(?:clock\s+)?(?:cycle|edge))[^.!?]*(?:read|output)|(?:read|output)[^.!?]*(?:\bsynchronous\b|\bregistered\b|one[- ]cycle|next\s+(?:clock\s+)?(?:cycle|edge)|following\s+(?:clock\s+)?(?:cycle|edge))/i;
 check(latencyEvidence.test(readQuote),'read.source must directly specify zero- or one-edge read latency');

 const clock={port:p.clock.port,edge:p.clock.edge};setClock(clock);
 port(p.write.enable,'input',1);
 const writeAddress=port(p.write.address,'input'),writeData=port(p.write.data,'input');
 const readAddress=port(p.read.address,'input',writeAddress.width),readData=port(p.read.data,'output',writeData.width);
 check(writeAddress.width<=12&&writeData.width<=512,'sync_memory supports address widths up to 12 and data widths up to 512');

 const collision=p.same_address.behavior;
 if(collision==='unspecified'){
  check(p.same_address.source===null,'Unspecified same-address behavior requires source=null');
  uncovered.push('Same-address read/write collision behavior is unspecified and is not asserted.');
 }else{
  check(p.read.latency===1,'Old/new same-address collision checking requires a registered read');
  const collisionQuote=evidence(refs,p.same_address.source,'same_address');
  namesIn(collisionQuote,[p.write.enable,p.write.address,p.read.address,p.read.data],'same_address');
  const policy=collision==='old'?/(?:old|previous|prior|before\s+the\s+write)/i:/(?:new|written|write\s+data|incoming|after\s+the\s+write)/i;
  check(/same\s*(?:address|location)|identical\s*(?:address|location)/i.test(collisionQuote)&&policy.test(collisionQuote),'same_address.source must directly specify old/new data for a same-address collision');
 }

 const count=Math.min(6,2**writeAddress.width),raw=[0,count-1,1,Math.max(0,count-2),2,3],addresses=[...new Set(raw.filter(value=>value<count))];
 const values=addresses.map((_,index)=>(pattern(writeData.width,Boolean(index&1))^BigInt(index*0x25+3))&mask(writeData.width));
 const idle={[p.write.enable]:0,[p.write.address]:0,[p.write.data]:0,[p.read.address]:0};
 for(let index=0;index<addresses.length;index++)emit({...idle,[p.write.enable]:1,[p.write.address]:addresses[index],[p.write.data]:values[index]},{},1);

 let observed=null;
 for(const index of addresses.map((_,i)=>i).reverse()){
  const drive={...idle,[p.read.address]:addresses[index]};
  if(p.read.latency===0)emit(drive,{[p.read.data]:values[index]},0);
  else{
   if(observed!==null)emit(drive,{[p.read.data]:observed},0);
   emit(drive,{[p.read.data]:values[index]},1);observed=values[index];
  }
 }
 if(collision!=='unspecified'){
  const index=0,oldValue=values[index],newValue=(~oldValue)&mask(writeData.width),drive={...idle,[p.write.enable]:1,[p.write.address]:addresses[index],[p.write.data]:newValue,[p.read.address]:addresses[index]};
  emit(drive,{[p.read.data]:collision==='old'?oldValue:newValue},1);
  emit({...idle,[p.read.address]:addresses[index]},{[p.read.data]:newValue},1);
 }
 uncovered.push('Only written locations are read; initialization, unwritten locations, multiple ports, byte enables, and reset behavior remain untested.');
 calculations.push({method:'source-declared-sync-memory',oracle:'cpu_memory_model',candidate_read:false,read_latency:p.read.latency,collision});
 return true;
}
