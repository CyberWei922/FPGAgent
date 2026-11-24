import {invariant} from '../dual/snapshot.mjs';
import {compileBoundedUpdate} from './bounded-update.mjs';
import {compileSequenceOracle} from './sequence-oracles.mjs';
const check=(ok,message)=>invariant(ok,'TEST_PLAN_INVALID',message),mask=w=>(1n<<BigInt(w))-1n;
// Selected interpreters adapted from C 86b8384; no C budgets or fallback.
export function compileSequentialOracle(method,p,c){
 if(compileSequenceOracle(method,p,c))return true;
 if(!['priority_update_v2','controlled_counter_v2','framed_stream_v2','lfsr_v2','rotate_v2'].includes(method))return false;
 const {port,emit,pattern,uncovered,calculations,timing}=c;
 const integer=(v,w)=>{const n=BigInt(v);check(n>=0n&&n<=mask(w),'Source value does not fit its declared width');return n;};
 if(method==='priority_update_v2'){
  if(p.operation==='boolean_table'){
   compileBoundedUpdate(p,c);return true;
  }
  const q=port(p.out,'output');timing(false);
  if(p.load){port(p.load.enable,'input',1);port(p.load.data,'input',q.width);}
  if(p.enable)port(p.enable,'input',1);if(p.serial)port(p.serial,'input',1);
  const actions=[...(p.reset?['reset']:[]),...(p.load?['load']:[]),'update'];
  check(p.priority.length===actions.length&&new Set(p.priority).size===actions.length&&actions.every(x=>p.priority.includes(x)),'Priority must list each available action once');
  check(p.reset||p.load,'Known state requires reset or parallel load');
  check(!p.reset||p.reset.kind!=='async'||p.priority[0]==='reset','Asynchronous reset must dominate edge-triggered actions');
  check(!p.serial||['left','right'].includes(p.operation),'Serial insertion applies only to single-bit shifts');
  check(p.operation!=='galois_right'||p.taps.length>0&&new Set(p.taps).size===p.taps.length&&p.taps.every(t=>t<=q.width)&&p.taps.includes(q.width),'Galois taps must be unique one-based positions including the top bit');
  check(p.operation==='galois_right'||p.taps.length===0,'Taps are exclusive to Galois feedback');
  const resetValue=integer(p.reset_value,q.width);let state=0n,known=false;
  const idle={...(p.reset?{[p.reset.port]:1-Number(p.reset.active)}:{}),...(p.load?{[p.load.enable]:0,[p.load.data]:0}:{}),...(p.enable?{[p.enable]:0}:{}),...(p.serial?{[p.serial]:0}:{})};
  const step=(changes={},cycles=1)=>{const d={...idle,...changes};
   const selected=p.priority.find(a=>a==='reset'?Number(d[p.reset.port])===Number(p.reset.active)&&(cycles>0||p.reset.kind==='async'):a==='load'?cycles>0&&Number(d[p.load.enable])===1:cycles>0&&(!p.enable||Number(d[p.enable])===1));
   if(selected==='reset'){state=resetValue;known=true;}
   else if(selected==='load'&&cycles){state=BigInt(d[p.load.data]);known=true;}
   else if(selected==='update'&&known){
    const serial=p.serial?BigInt(d[p.serial]):0n;
    state=p.operation==='left'?((state<<1n)|serial)&mask(q.width):p.operation==='right'?(state>>1n)|(serial<<BigInt(q.width-1)):
     p.operation==='rotate_left'?((state<<1n)|(state>>BigInt(q.width-1)))&mask(q.width):p.operation==='rotate_right'?(state>>1n)|((state&1n)<<BigInt(q.width-1)):
     (state>>1n)^((state&1n)?p.taps.reduce((m,t)=>m|(1n<<BigInt(t-1)),0n):0n);
   }
   emit(d,known?{[p.out]:state}:{},cycles);
  };
  const seed=()=>{
   if(p.reset)step({[p.reset.port]:Number(p.reset.active)},p.reset.kind==='async'?0:1);
   if(p.load)step({[p.load.enable]:1,[p.load.data]:pattern(q.width)});
   check(known,'Declared priority prevents reset/load from establishing known state');
  };
  seed();for(let i=0;i<8;i++)step({...(p.enable?{[p.enable]:1}:{}),...(p.serial?{[p.serial]:i%2}:{})});
  const controls=[...(p.reset?[p.reset.port]:[]),...(p.load?[p.load.enable]:[]),...(p.enable?[p.enable]:[])];
  for(let bits=0;bits<2**controls.length;bits++){
   seed();const d=Object.fromEntries(controls.map((name,i)=>[name,(bits>>i)&1]));
   if(p.reset)d[p.reset.port]=d[p.reset.port]?Number(p.reset.active):1-Number(p.reset.active);
   if(p.load)d[p.load.data]=pattern(q.width,true);if(p.serial)d[p.serial]=1;
   step(d);if(p.reset?.kind==='async'&&d[p.reset.port]===Number(p.reset.active))step(d,0);
  }
  uncovered.push('All reset/load/update control combinations and short update histories; arbitrary histories remain unproven.');
 }else if(method==='controlled_counter_v2'){
  check(p.out!==null||p.terminal!==null,'Need an observable count or terminal flag');
  const q=p.out===null?null:port(p.out,'output'),w=q?.width??p.width;
  check(w===p.width&&w<=256,'Counter width must agree with the count output');timing(false);
  if(p.terminal)port(p.terminal,'output',1);if(p.load){port(p.load.enable,'input',1);if(p.load.data)port(p.load.data,'input',w);}
  if(p.enable)port(p.enable,'input',1);if(p.up)port(p.up,'input',1);
  check(p.reset||p.load,'A hidden/no-reset counter needs a load to establish state');
  const low=integer(p.low,w),high=p.high==='width_max'?mask(w):integer(p.high,w),seed=integer(p.reset_value,w);
  check(low<high&&(!p.reset||seed>=low&&seed<=high),'Counter range/reset is inconsistent');
  const constant=p.load&&Object.hasOwn(p.load,'value')?integer(p.load.value,w):null;
  check(constant===null||constant>=low&&constant<=high,'Constant load exceeds counter range');
  let state=seed,known=false;
  const idle={...(p.reset?{[p.reset.port]:1-Number(p.reset.active)}:{}),...(p.load?{[p.load.enable]:0,...(p.load.data?{[p.load.data]:0}:{})}:{}),...(p.enable?{[p.enable]:1}:{}),...(p.up?{[p.up]:1}:{})};
  const step=(changes={},cycles=1)=>{const d={...idle,...changes};
   if(p.reset&&Number(d[p.reset.port])===Number(p.reset.active)&&(cycles>0||p.reset.kind==='async')){state=seed;known=true;}
   else if(cycles>0){if(p.load&&d[p.load.enable]){state=constant??BigInt(d[p.load.data]);known=true;}
    else if(known&&(!p.enable||d[p.enable])){
     const up=p.up?Boolean(d[p.up]):p.direction==='up',delta=BigInt(cycles),span=high-low+1n;
     const next=state+(up?delta:-delta);
     state=p.behavior==='wrap'?low+((next-low)%span+span)%span:next<low?low:next>high?high:next;
    }}
   emit(d,known?{...(q?{[p.out]:state}:{}),...(p.terminal?{[p.terminal]:Number(state===(p.terminal_at==='low'?low:high))}:{})}:{},cycles);
  };
  if(p.reset)step({[p.reset.port]:Number(p.reset.active)},p.reset.kind==='async'?0:1);
  if(p.load&&constant===null)for(const value of [...new Set([low,low+1n,high-1n,high])]){
   step({[p.load.enable]:1,[p.load.data]:value});for(let n=0;n<3;n++)step();
   if(p.enable)step({[p.enable]:0});
  }
  if(constant!==null){
   step({[p.load.enable]:1});
   step();step({[p.load.enable]:1}); // Reload while active, not just at terminal.
   const distance=p.up||p.direction==='up'?high-constant:constant-low;
   if(distance<=999990n){if(distance>1n)step({},Number(distance-1n));step();step();step();}
   else{for(let n=0;n<8;n++)step();uncovered.push('Constant-load terminal exceeds the bounded edge budget.');}
   if(p.enable)step({[p.enable]:0});step({[p.load.enable]:1});step();
  }
  if(!p.load){const n=high-low<=32n?Number(high-low)+3:8;for(let i=0;i<n;i++){step();if(p.enable&&[0,n-2].includes(i))step({[p.enable]:0});}}
  if(p.up){for(const up of [0,1]){for(let i=0;i<Number(high-low<=16n?high-low+2n:5n);i++){step({[p.up]:up});if(p.enable&&i===0)step({[p.up]:up,[p.enable]:0});}if(p.enable)step({[p.up]:up,[p.enable]:0});}}
  if(p.reset)step({[p.reset.port]:Number(p.reset.active),...(p.load?{[p.load.enable]:1,...(p.load.data?{[p.load.data]:high}:{})}:{})},1);
  if(high-low>32n&&!p.load)uncovered.push('Large range without load: terminal behavior may be unreachable within the bounded prefix.');
  uncovered.push('Counter priority is reset > load > enabled count > hold; terminal flag observes settled current count.');
 }else if(method==='rotate_v2'){
  const q=port(p.out,'output'),sel=port(p.select,'input');timing(false);
  check(sel.width<=3&&p.left!==p.right&&Math.max(p.left,p.right)<2**sel.width,'Rotation selector codes must be distinct and fit');
  if(p.load){port(p.load.enable,'input',1);port(p.load.data,'input',q.width);}
  check(p.reset||p.load,'Rotation needs reset or full load to establish state');
  const seed=integer(p.reset_value,q.width);let state=0n,known=false;
  const idle={...(p.reset?{[p.reset.port]:1-p.reset.active}:{}),...(p.load?{[p.load.enable]:0,[p.load.data]:0}:{}),[p.select]:0};
  const step=(changes={},cycles=1)=>{const d={...idle,...changes};
   if(p.reset&&d[p.reset.port]===p.reset.active&&(cycles||p.reset.kind==='async')){state=seed;known=true;}
   else if(cycles){if(p.load&&d[p.load.enable]){state=BigInt(d[p.load.data]);known=true;}
    else if(known&&d[p.select]===p.left)state=((state<<1n)|(state>>BigInt(q.width-1)))&mask(q.width);
    else if(known&&d[p.select]===p.right)state=(state>>1n)|((state&1n)<<BigInt(q.width-1));}
   emit(d,known?{[p.out]:state}:{},cycles);
  };
  if(p.reset)step({[p.reset.port]:p.reset.active},p.reset.kind==='async'?0:1);
  if(p.load)step({[p.load.enable]:1,[p.load.data]:pattern(q.width)});
  for(const mode of Array.from({length:2**sel.width},(_,i)=>i)){
   if(p.load)step({[p.load.enable]:1,[p.load.data]:pattern(q.width,true),[p.select]:mode});
   for(let i=0;i<5;i++)step({[p.select]:mode});
  }
  for(let i=0;i<8;i++)step({[p.select]:i%2?p.left:p.right});
  if(p.reset)step({[p.reset.port]:p.reset.active,[p.select]:p.left,...(p.load?{[p.load.enable]:1,[p.load.data]:mask(q.width)}:{})});
  uncovered.push('Explicit left/right selector codes, all other codes hold. Reset overrides full load, which overrides rotation. Bounded bidirectional histories only.');
 }else if(method==='framed_stream_v2'){
  const d=port(p.data,'input');port(p.done,'output',1);const q=p.out===null?null:port(p.out,'output');timing(false);check(p.reset,'Framing needs specified reset');
  check(p.mode==='serial'?d.width===1&&(!q||q.width===p.length):p.start_bit<d.width&&(!q||q.width===d.width*p.length),'Frame interface/length mismatch');
  check(p.mode!=='serial'||p.stop!==null,'Serial framing needs a specified stop bit');
  check(p.mode==='serial'?p.start_bit===0:p.stop===null,'Serial start_bit is zero; packet stop must be null');
  let count=0,word=0n,phase='idle';
  const step=(value,reset=false)=>{let done=0;if(reset){count=0;word=0n;phase='idle';}
   else if(p.mode==='packet'){
    if(count||Number((value>>BigInt(p.start_bit))&1n)===Number(p.start)){
     word=p.order==='lsb_first'?word|(value<<BigInt(count*d.width)):((word<<BigInt(d.width))|value)&mask(d.width*p.length);
     count++;if(count===p.length){done=1;count=0;}
    }
   }else if(phase==='idle'){if(Number(value)===Number(p.start)){phase='data';count=0;word=0n;}}
   else if(phase==='data'){
    word=p.order==='lsb_first'?word|(value<<BigInt(count)):((word<<1n)|value)&mask(p.length);
    count++;if(count===p.length)phase='stop';
   }else if(phase==='stop'){if(Number(value)===Number(p.stop)){done=1;phase='idle';}else phase='resync';}
   else if(Number(value)===Number(p.stop))phase='idle';
   emit({[p.data]:value,[p.reset.port]:reset?Number(p.reset.active):1-Number(p.reset.active)},
    {[p.done]:done,...(done&&q?{[p.out]:word}:{})},reset&&p.reset.kind==='async'?0:1);
   if(p.mode==='packet'&&done)word=0n;
  };
  const invalid=p.mode==='serial'?BigInt(1-Number(p.start)):BigInt(1-Number(p.start))<<BigInt(p.start_bit);
  const frame=(offset=0,bad=false)=>{
   if(p.mode==='serial'){
    step(BigInt(p.start));for(let i=0;i<p.length;i++)step(BigInt((i+offset)%2));step(BigInt(bad?1-Number(p.stop):p.stop));
   }else for(let i=0;i<p.length;i++){
    let v=(pattern(d.width,Boolean(i%2))^BigInt(offset+i))&mask(d.width);
    if(i===0)v=(v&~(1n<<BigInt(p.start_bit)))|(BigInt(p.start)<<BigInt(p.start_bit));step(v);
   }
  };
  step(invalid,true);step(invalid);frame();frame(1);
  if(p.mode==='serial'){frame(0,true);step(BigInt(1-Number(p.stop)));step(BigInt(p.stop));frame(1);}
  step(BigInt(p.mode==='serial'?p.start:BigInt(p.start)<<BigInt(p.start_bit)));step(invalid,true);step(invalid);frame(1);
  uncovered.push('Fixed-length frames; data is checked only when done. No baud division, parity, ready/valid or arbitrary stalls.');
 }else if(method==='lfsr_v2'){
    const q=port(p.out,'output');check(q.width<=256,'LFSR width exceeds bound');timing(false);
    if(p.load){port(p.load.enable,'input',1);port(p.load.data,'input',q.width);}if(p.enable)port(p.enable,'input',1);
    const taps=p.taps.map(t=>t-(p.tap_numbering==='one_based'?1:0));
    check(taps.every(t=>t>=0&&t<q.width)&&new Set(taps).size===taps.length,'Invalid/duplicate source taps');
    const actions=[...(p.reset?['reset']:[]),...(p.load?['load']:[]),'update'];
    check(p.priority.length===actions.length&&new Set(p.priority).size===actions.length&&actions.every(a=>p.priority.includes(a)),'Priority must list each action exactly once');
    check(p.reset||p.load,'LFSR requires source reset or parallel load');
    check(!p.reset||p.reset.kind!=='async'||p.priority[0]==='reset','Async reset must dominate');
    const seed=BigInt(p.seed);check(seed>=0n&&seed<=mask(q.width),'Seed does not fit output');let state=0n,known=false;
    const idle={...(p.reset?{[p.reset.port]:1-p.reset.active}:{}),...(p.load?{[p.load.enable]:0,[p.load.data]:0}:{}),...(p.enable?{[p.enable]:0}:{})};
    const step=(changes={},cycles=1)=>{
      const d={...idle,...changes},action=p.priority.find(a=>a==='reset'?d[p.reset.port]===p.reset.active&&(cycles>0||p.reset.kind==='async'):a==='load'?cycles>0&&d[p.load.enable]===1:cycles>0&&(!p.enable||d[p.enable]===1));
      if(action==='reset'){state=seed;known=true;}
      else if(action==='load'){state=BigInt(d[p.load.data]);known=true;}
      else if(action==='update'&&known){
        const old=state,shifted=p.direction==='left'?(old<<1n)&mask(q.width):old>>1n;
        if(p.form==='fibonacci'){
          let feedback=0n;for(const t of taps)feedback^=(old>>BigInt(t))&1n;
          state=shifted|(feedback<<BigInt(p.direction==='left'?0:q.width-1));
        }else{const feedback=(old>>BigInt(p.direction==='left'?q.width-1:0))&1n;state=shifted;for(const t of taps)state^=feedback<<BigInt(t);}
      }
      emit(d,known?{[p.out]:state}:{},cycles);
    };
    const initialize=()=>{
      if(p.reset)step({[p.reset.port]:p.reset.active},p.reset.kind==='async'?0:1);
      if(p.load)step({[p.load.enable]:1,[p.load.data]:pattern(q.width)});
      check(known,'Declared priority prevents reset/load from establishing state');
    };
    initialize();for(let n=0;n<Math.min(q.width+3,24);n++)step(p.enable?{[p.enable]:1}:{});
    const controls=[...(p.reset?[p.reset.port]:[]),...(p.load?[p.load.enable]:[]),...(p.enable?[p.enable]:[])];
    for(let bits=0;bits<2**controls.length;bits++){
      initialize();const d=Object.fromEntries(controls.map((n,i)=>[n,(bits>>i)&1]));
      if(p.reset)d[p.reset.port]=d[p.reset.port]?p.reset.active:1-p.reset.active;
      if(p.load)d[p.load.data]=pattern(q.width,true);step(d);
      if(p.reset?.kind==='async')step({[p.reset.port]:p.reset.active},0);
    }
    uncovered.push('Source tap equations, both conflicting controls and enabled/held histories; bounded prefix, not maximal-period proof.');
 }
 calculations.push({method,oracle:'cpu_semantic_interpreter_d',candidate_read:false});return true;
}

