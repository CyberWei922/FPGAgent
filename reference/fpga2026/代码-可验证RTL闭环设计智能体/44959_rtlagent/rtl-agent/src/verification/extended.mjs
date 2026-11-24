import {invariant} from '../dual/snapshot.mjs';
import {shiftEvidence} from './source-consistency.mjs';
import {compileSequentialOracle} from './sequential-oracles.mjs';
import {compileNewtypeOracle} from './newtype-oracles.mjs';
const check=(ok,msg)=>invariant(ok,'TEST_PLAN_INVALID',msg),mask=w=>(1n<<BigInt(w))-1n;
const supported=['packed_mux','priority_encoder','kmap','state_logic','shift_register','bcd_counter','grid_life','packet_collector','history_recovery','window_count'];
// Source-semantic interpreters, not a DUT interpreter. Candidate RTL is never read.
export function compileExtended(method,p,{task,expected,refs,port,emit,pattern,uncovered,calculations,timing,setClock}){
 if(compileNewtypeOracle(method,p,{task,expected,refs,port,emit,pattern,uncovered,calculations,timing,setClock}))return true;
 if(compileSequentialOracle(method,p,{task,expected,port,emit,pattern,uncovered,calculations,timing,setClock}))return true;
 if(!supported.includes(method))return false;
 if(method==='window_count'){
  port(p.start,'input',1);port(p.data,'input',1);port(p.out,'output',1);timing(false);
  const words=['zero','one','two','three','four','five'];check(p.ones<=p.window&&[p.ones,p.window].every(n=>new RegExp('\\b(?:'+n+'|'+words[n]+')\\b','i').test(task.spec)),'Window size and target count must copy explicit source constants');
  let active=false,samples=0,count=0;
  const step=(start,data,reset=false)=>{let out=0;if(reset){active=false;samples=0;count=0;}else if(!active){if(start)active=true;}else{count+=data;samples++;if(samples===p.window){out=Number(count===p.ones);samples=0;count=0;}}
   emit({[p.start]:start,[p.data]:data,[p.reset.port]:reset?Number(p.reset.active):1-Number(p.reset.active)},{[p.out]:out});};
  step(1,1,true);step(0,1);step(0,0);step(1,1);
  const patterns=p.window<=4?Array.from({length:2**p.window},(_,n)=>n):[0,31,1,2,4,8,16,3,7,15,21,10];
  for(const value of patterns)for(let i=0;i<p.window;i++)step((value+i)%2,(value>>(p.window-1-i))&1);
  step(0,1);step(1,1,true);step(0,1);step(1,0);for(let i=0;i<p.window;i++)step(0,Number(i<p.ones));
  uncovered.push('Fixed non-overlapping window counts only; arbitrary histories and unrelated protocols are untested.');
 }else if(method==='packed_mux'){
  const d=port(p.data,'input'),s=port(p.select,'input'),q=port(p.out,'output'),lanes=d.width/q.width;
  check(Number.isInteger(lanes)&&s.width<=12&&lanes===2**s.width,'Packed mux must populate the full selector domain');
  const selectors=lanes<=32?Array.from({length:lanes},(_,i)=>i):[...new Set([0,1,lanes-2,lanes-1,...Array.from({length:24},(_,i)=>Math.floor(i*(lanes-1)/23))])];
  for(const selected of selectors)for(const invert of [false,true]){let data=0n;const chosen=invert?(~pattern(q.width))&mask(q.width):pattern(q.width),other=(~chosen)&mask(q.width);for(let i=0;i<lanes;i++)data|=(i===selected?chosen:other)<<BigInt((p.order==='lsb_first'?i:lanes-1-i)*q.width);emit({[p.data]:data,[p.select]:selected},{[p.out]:chosen},0);}
  if(lanes>32)uncovered.push('Wide packed mux samples selector positions, not every lane.');
 }else if(method==='priority_encoder'){
  const d=port(p.data,'input'),q=port(p.out,'output');check(d.width<=256&&(1n<<BigInt(q.width))>=BigInt(d.width),'Priority index must fit; at most 256 input bits');const empty=BigInt(p.empty);check(empty<=mask(q.width),'Empty encoder output exceeds width');
  const positions=d.width<=32?Array.from({length:d.width},(_,i)=>i):[...new Set([0,d.width-1,...Array.from({length:30},(_,i)=>Math.floor(i*(d.width-1)/29))])];emit({[p.data]:0},{[p.out]:empty},0);
  for(const bit of positions){emit({[p.data]:1n<<BigInt(bit)},{[p.out]:bit},0);const other=p.priority==='lowest'?d.width-1:0;emit({[p.data]:(1n<<BigInt(bit))|(1n<<BigInt(other))},{[p.out]:p.priority==='lowest'?Math.min(bit,other):Math.max(bit,other)},0);}emit({[p.data]:mask(d.width)},{[p.out]:p.priority==='lowest'?0:d.width-1},0);
  if(d.width>32)uncovered.push('Wide priority encoder samples positions rather than checking every input bit.');
 }else if(method==='kmap'){
  const q=port(p.out,'output',1),byName=new Map(expected.ports.map(r=>[r.name,r]));
  const bits=[...p.col_bits,...p.row_bits].map(ref=>{const m=/^([A-Za-z_]\w*)(?:\[(\d+)\])?$/.exec(ref),r=byName.get(m?.[1]);check(r?.direction==='input'&&(m[2]!==undefined||r.width===1),'Kmap axes need valid source bit references');const bit=Number(m[2]??0);check(bit<r.width,'Kmap source axis exceeds declared bus width: '+ref);if(m[2]!==undefined)check(task.spec.includes(ref),'Kmap bus axis must be copied literally from the original source; never guess a renumbering: '+ref);return {port:r.name,bit};});
  check(new Set(bits.map(b=>b.port+':'+b.bit)).size===bits.length,'Kmap axis bits must be unique');for(const input of expected.ports.filter(r=>r.direction==='input')){check(bits.filter(b=>b.port===input.name).length===input.width,'Kmap axes must cover every input bit');port(input.name,'input');}
  const lines=task.spec.split('\n'),table=[];let labels=null;
  for(let i=0;i<lines.length;i++){const match=/^\s*([01]{1,2})\s*\|\s*([01dDxX])\s*\|\s*([01dDxX])\s*\|(?:\s*([01dDxX])\s*\|\s*([01dDxX])\s*\|)?\s*$/.exec(lines[i]);if(!match)continue;
   if(!labels){const header=lines.slice(Math.max(0,i-2),i).reverse().find(l=>(l.match(/(?<![\w\[])\b[01]{1,2}\b(?!\])/g)??[]).length===2**p.col_bits.length);labels=header?.match(/(?<![\w\[])\b[01]{1,2}\b(?!\])/g);}table.push({label:match[1],values:match.slice(2).filter(x=>x!==undefined)});}
  check(labels?.length===2**p.col_bits.length&&table.length===2**p.row_bits.length&&new Set(labels).size===labels.length&&new Set(table.map(r=>r.label)).size===table.length,'Need one complete unambiguous literal Kmap with explicit Gray labels');
  for(const row of table){check(row.values.length===labels.length&&row.label.length===p.row_bits.length,'Kmap dimensions do not match source');for(let c=0;c<labels.length;c++){if(!/^[01]$/.test(row.values[c]))continue;check(labels[c].length===p.col_bits.length,'Kmap column label width mismatch');const value=labels[c]+row.label,drive={};bits.forEach((b,i)=>{drive[b.port]=(drive[b.port]??0n)|(BigInt(value[i])<<BigInt(b.bit));});emit(drive,{[q.name]:Number(row.values[c])},0);}}
  uncovered.push('Source dont-care Kmap cells, if any, are intentionally not asserted.');
 }else if(method==='state_logic'){
  const state=port(p.state,'input'),event=port(p.event,'input',1);check(p.rows.length<=32&&(p.encoding==='onehot'?state.width>=p.rows.length:2**state.width>=p.rows.length),'Source encoding does not fit state port');check(p.next_outputs.length+p.state_outputs.length>0,'Need observable state logic');
  p.next_outputs.forEach(r=>{port(r.port,'output',r.bit===null?state.width:1);if(r.bit!==null)check(r.bit<state.width,'Projected state bit exceeds width');});p.state_outputs.forEach(n=>port(n,'output',1));
  p.ignored_inputs.forEach(n=>{check(/^(?:clk|clock)$/i.test(n)&&/combinational|output logic|next[- ]state logic/i.test(task.spec),'Only source-declared unused clock may be ignored');port(n,'input',1);});
  const code=i=>p.encoding==='onehot'?1n<<BigInt(i):BigInt(i);
  p.rows.forEach((row,i)=>{check(row.outputs.length===p.state_outputs.length&&row.next.every(n=>n<p.rows.length),'State row has wrong outputs or destination');for(let v=0;v<2;v++){const destination=code(row.next[v]),expect=Object.fromEntries(p.next_outputs.map(r=>[r.port,r.bit===null?destination:(destination>>BigInt(r.bit))&1n]));p.state_outputs.forEach((n,j)=>expect[n]=Number(row.outputs[j]));emit({[state.name]:code(i),[event.name]:v,...Object.fromEntries(p.ignored_inputs.map(n=>[n,0]))},expect,0);}});
  uncovered.push('Only legal source state encodings are checked; invalid/multiple-hot inputs remain unspecified.');
 }else if(method==='shift_register'){
  const q=p.out===null?null:port(p.out,'output'),read=p.read;check(Boolean(q)!==Boolean(read),'Use either whole storage output or serial-memory read');
  if(read){port(read.out,'output',1);read.address.forEach(n=>port(n,'input'));check(read.address.reduce((n,k)=>n+expected.ports.find(r=>r.name===k).width,0)===Math.log2(read.storage_bits),'Read address must span specified storage');}
  const w=p.storage?.bits??q?.width??read.storage_bits;timing(true,true);
  calculations.push(...shiftEvidence(p,task.spec,q?.width));
  if(read&&p.serial){const literal=new RegExp('\\b'+p.serial+'\\s*,?\\s*(?:which\\s+)?feeds\\s+(?:the\\s+)?input\\s+of\\s+([A-Za-z_]\\w*)\\s*\\[\\s*(\\d+)\\s*\\]','i').exec(task.spec);if(literal){const index=Number(literal[2]);check(index===0||index===w-1,'Explicit serial insertion must name a storage endpoint');const direction=index===0?'left':'right';check(p.modes.every(m=>m.direction===direction),'Explicit source insertion at '+literal[1]+'['+index+'] requires '+direction+' shift: higher bit indices mean left, lower indices mean right');calculations.push({operation:'source_literal_serial_insertion',quote:literal[0],index,direction});}}
  if(p.load){port(p.load.enable,'input',1);port(p.load.data,'input',w);}if(p.enable)port(p.enable,'input',1);if(p.serial)port(p.serial,'input',1);if(p.decrement)port(p.decrement,'input',1);
  if(p.select){const s=port(p.select,'input');check(s.width<=4&&p.modes.length===2**s.width,'Modes must fill selector domain');}else check(p.modes.length===1,'No selector requires one mode');
  check(p.modes.every(m=>m.amount<=w)&&(!p.serial||p.modes.every(m=>m.amount===1&&m.direction!=='arithmetic_right')),'Unsupported serial multi-bit/arithmetic shift');check(p.load||p.reset&&p.reset.value!=='unspecified'||p.serial&&w<=48,'Known state requires reset, load or complete serial overwrite');
  let state=0n,known=false;const idle={...(p.reset?{[p.reset.port]:1-Number(p.reset.active)}:{}),...(p.load?{[p.load.enable]:0}:{}),...(p.enable?{[p.enable]:0}:{}),...(p.serial?{[p.serial]:0}:{}),...(p.select?{[p.select]:0}:{}),...(p.decrement?{[p.decrement]:0}:{}),...(read?Object.fromEntries(read.address.map(n=>[n,0])):{})};
  const expectedValue=d=>q?{[p.out]:(state>>BigInt(p.storage?.tap??0))&mask(q.width)}:{[read.out]:(state>>BigInt(read.address.reduce((a,n)=>a*2**expected.ports.find(r=>r.name===n).width+Number(d[n]??0),0)))&1n};
  const step=(changes={},cycles=1)=>{const d={...idle,...changes};
   if(p.reset&&Number(d[p.reset.port])===Number(p.reset.active)&&p.reset.value!=='unspecified'){state=p.reset.value==='ones'?mask(w):0n;known=true;}
   else if(cycles>0){if(p.load&&d[p.load.enable]){state=BigInt(d[p.load.data]??0);known=true;}else if(!p.enable||d[p.enable]){const mode=p.modes[p.select?Number(d[p.select]):0],amount=BigInt(mode.amount),serial=p.serial?BigInt(d[p.serial]):0n;state=mode.direction==='left'?((state<<amount)|serial)&mask(w):mode.direction==='right'?(state>>amount)|(serial<<BigInt(w-1)):BigInt.asUintN(w,BigInt.asIntN(w,state)>>amount);}else if(p.decrement&&d[p.decrement])state=BigInt.asUintN(w,state-1n);}
   emit(d,known?expectedValue(d):{},cycles);
  };
  if(p.reset&&p.reset.value!=='unspecified')step({[p.reset.port]:Number(p.reset.active)},p.reset.kind==='async'?0:1);
  if(p.load)step({[p.load.enable]:1,[p.load.data]:pattern(w),...(p.enable?{[p.enable]:1}:{})});
  if(!known){for(let i=0;i<w;i++)step({...(p.enable?{[p.enable]:1}:{}),[p.serial]:0});known=true;step({},0);}
  for(let mode=0;mode<p.modes.length;mode++)for(let n=0;n<(p.storage?Math.min(32,w+3):Math.min(4,Math.max(2,w)));n++)step({...(p.enable?{[p.enable]:1}:{}),...(p.select?{[p.select]:mode}:{}),...(p.serial?{[p.serial]:n%2}:{})});
  if(p.enable)step();if(p.decrement){step({[p.decrement]:1});step({[p.decrement]:1});}
  if(read){const seed=(1n<<BigInt(w-1))|2n;for(let i=w-1;i>=0;i--)step({...(p.enable?{[p.enable]:1}:{}),[p.serial]:Number((seed>>BigInt(i))&1n)});}
  if(read)for(let address=0;address<Math.min(w,16);address++){let v=address;const d={};for(const n of [...read.address].reverse()){const rw=expected.ports.find(r=>r.name===n).width;d[n]=v%2**rw;v=Math.floor(v/2**rw);}step(d,0);}
  if(p.load)step({[p.load.enable]:1,[p.load.data]:pattern(w,true),...(p.enable?{[p.enable]:1}:{})});if(p.reset&&p.reset.value!=='unspecified')step({[p.reset.port]:Number(p.reset.active),...(p.load?{[p.load.enable]:1,[p.load.data]:mask(w)}:{})},p.reset.kind==='async'?0:1);
  uncovered.push('Bounded shift histories; unspecified startup and simultaneous shift/decrement priority are not asserted.');
 }else if(method==='bcd_counter'){
  const q=port(p.out,'output');check(q.width%4===0&&q.width<=24,'Need 1..6 packed BCD digits');const digits=q.width/4;if(p.enable)port(p.enable,'input',1);if(p.enables)port(p.enables,'output',digits-1);timing(false);let count=0;
  const outputs=()=>{let n=count,packed=0n,ena=0n;for(let d=0;d<digits;d++){packed|=BigInt(n%10)<<BigInt(4*d);n=Math.floor(n/10);if(d<digits-1&&count%10**(d+1)===10**(d+1)-1)ena|=1n<<BigInt(d);}return {[p.out]:packed,...(p.enables?{[p.enables]:ena}:{})};};emit({[p.reset.port]:Number(p.reset.active),...(p.enable?{[p.enable]:1}:{})},outputs(),p.reset.kind==='async'?0:1);
  const advance=edges=>{count=(count+edges)%10**digits;emit({[p.reset.port]:1-Number(p.reset.active),...(p.enable?{[p.enable]:1}:{})},outputs(),edges);};
  // Reset during activity, then observe both sides of every decimal carry.
  advance(7);count=0;emit({[p.reset.port]:Number(p.reset.active),...(p.enable?{[p.enable]:1}:{})},outputs(),p.reset.kind==='async'?0:1);
  let elapsed=0;const targets=[1,2,...Array.from({length:digits},(_,i)=>[10**(i+1)-2,10**(i+1)-1,10**(i+1),10**(i+1)+1]).flat()];
  for(const target of [...new Set(targets)].sort((a,b)=>a-b)){advance(target-elapsed);elapsed=target;if(p.enable)emit({[p.reset.port]:1-Number(p.reset.active),[p.enable]:0},outputs(),2);}
  count=0;emit({[p.reset.port]:Number(p.reset.active),...(p.enable?{[p.enable]:1}:{})},outputs(),p.reset.kind==='async'?0:1);advance(1);
  uncovered.push('Every decimal carry and full wrap are observed; constant-control batches do not check intervening outputs. Carry enables are observed before and after boundaries.');
 }else if(method==='history_recovery'){
  const q=port(p.out,'output');port(p.base,'input',q.width);port(p.append,'input',1);p.recover.forEach(n=>port(n,'input',1));port(p.advance,'input',1);p.other_inputs.forEach(n=>port(n,'input'));p.other_outputs.forEach(n=>port(n,'output'));timing(false);
  const side=Object.fromEntries(p.other_inputs.map(n=>[n,0])),off=Object.fromEntries(p.recover.map(n=>[n,0]));let state=0n;
  const step=(base,bit,{recover=true,advance=0,qualifiers=off,reset=false}={})=>{const controls=recover?Object.fromEntries(p.recover.map(n=>[n,1])):qualifiers;if(!reset&&p.recover.every(n=>Number(controls[n])===1))state=((base<<1n)|BigInt(bit))&mask(q.width);
   const drive={...side,...controls,[p.advance]:advance,[p.base]:base,[p.append]:bit,[p.reset.port]:reset?Number(p.reset.active):1-Number(p.reset.active)};
   emit(drive,{});
   // The prediction interface defines the history observation only while valid.
   // Query after the recovery/hold edge, without taking a speculative edge.
   if(!reset){emit({...drive,...off,[p.advance]:1},{[p.out]:state},0);emit({...drive,...off,[p.advance]:0},{},0);}};
  step(0n,0,{reset:true});
  for(const [base,bit]of [[pattern(q.width),0],[pattern(q.width,true),1],[0n,1],[mask(q.width),0]]){
   step(base,bit);step((~base)&mask(q.width),1-bit,{recover:false});
   for(const qualifier of p.recover)step(base,1-bit,{recover:false,qualifiers:{...Object.fromEntries(p.recover.map(n=>[n,1])),[qualifier]:0}});
   step((~base)&mask(q.width),1-bit,{advance:1});
  }
  uncovered.push('Only source-specified history recovery, inactive hold and recovery priority are checked. History is observed only on a valid prediction query with zero clock edges. Ordinary speculative updates, all side outputs, predictor table behavior and unspecified reset values remain untested.');
 }else if(method==='packet_collector'){
  const d=port(p.data,'input'),q=port(p.out,'output');port(p.done,'output',1);timing(false);
  const words=q.width/d.width;check(d.width<=32&&Number.isInteger(words)&&words>=2&&words<=8&&p.start_bit<d.width,'Need 2..8 whole packet words and a valid boundary bit');
  const boundary=1n<<BigInt(p.start_bit),setBoundary=(value,on)=>(value&~boundary)|(BigInt(on)<<BigInt(p.start_bit));let count=0,assembled=0n;
  const step=(value,reset=false)=>{let done=0;if(reset){count=0;assembled=0n;}else if(count||Number((value>>BigInt(p.start_bit))&1n)===Number(p.start_value)){assembled=((assembled<<BigInt(d.width))|value)&mask(q.width);count++;if(count===words){done=1;count=0;}}
   emit({[p.reset.port]:reset?Number(p.reset.active):1-Number(p.reset.active),[p.data]:value},{[p.done]:done,...(done?{[p.out]:assembled}:{})});};
  const invalid=setBoundary(pattern(d.width),1-Number(p.start_value));step(invalid,true);step(invalid);step(setBoundary(mask(d.width),1-Number(p.start_value)));
  const packet=offset=>Array.from({length:words},(_,i)=>setBoundary((pattern(d.width,Boolean(i%2))^BigInt(offset+i*3))&mask(d.width),i===0?Number(p.start_value):i%2));
  for(const offset of [0,7])for(const value of packet(offset))step(value);
  const interrupted=packet(13);step(interrupted[0]);step(invalid,true);step(invalid);for(const value of packet(19))step(value);step(invalid);
  uncovered.push('Output data is checked only on completed packets; arbitrary packet histories and unspecified reset data remain unchecked.');
 }else if(method==='grid_life'){
  const d=port(p.data,'input'),q=port(p.out,'output',d.width);port(p.load,'input',1);setClock(p.clock);const side=Math.sqrt(q.width);check(Number.isInteger(side)&&side>=3&&side<=32,'Life requires square 3..32 grid side');
  const evolve=state=>{let next=0n;const cell=(r,c)=>{if(p.boundary==='wrap'){r=(r+side)%side;c=(c+side)%side;}else if(r<0||c<0||r>=side||c>=side)return 0;return Number((state>>BigInt(r*side+c))&1n);};for(let r=0;r<side;r++)for(let c=0;c<side;c++){let n=0;for(let dr=-1;dr<=1;dr++)for(let dc=-1;dc<=1;dc++)if(dr||dc)n+=cell(r+dr,c+dc);if(n===3||n===2&&cell(r,c))next|=1n<<BigInt(r*side+c);}return next;};
  const seeds=[0n,mask(q.width),pattern(q.width),[0,side-1,q.width-side,q.width-1,1].reduce((n,i)=>n|(1n<<BigInt(i)),0n),7n<<BigInt(side+1)];for(let state of seeds){emit({[p.load]:1,[p.data]:state},{[p.out]:state});for(let n=0;n<3;n++){state=evolve(state);emit({[p.load]:0},{[p.out]:state});}}
  uncovered.push('Five deterministic seeds and short evolution; arbitrary grid histories remain unchecked.');
 }
 calculations.push({method:'source-declared-'+method,oracle:'cpu_semantic_interpreter',candidate_read:false});return true;
}
