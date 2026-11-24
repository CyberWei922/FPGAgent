import {invariant} from '../dual/snapshot.mjs';

// CPU-only oracles for declared source semantics. This never reads candidate RTL.
export function compileCombinational(method,p,{expected,port,emit,pattern,uncovered,calculations}){
  if(!['constant','adder','logic','addsub'].includes(method))return false;
  const check=(ok,msg)=>invariant(ok,'TEST_PLAN_INVALID',msg),mask=w=>(1n<<BigInt(w))-1n;
  if(method==='constant'){
    const q=port(p.out,'output');
    const value=p.value==='zero'?0n:p.value==='ones'?mask(q.width):BigInt(p.value);
    check(value>=0n&&value<=mask(q.width),'Constant exceeds output width');
    emit({},{[p.out]:value},0);emit({},{[p.out]:value},0);return true;
  }
  let inputs,out,calculate;
  if(method==='addsub'){
    const a=port(p.a,'input');port(p.b,'input',a.width);port(p.subtract,'input',1);port(p.out,'output',a.width);if(p.zero)port(p.zero,'output',1);
    inputs=[a,expected.ports.find(r=>r.name===p.b),expected.ports.find(r=>r.name===p.subtract)];
    calculate=v=>{const n=BigInt.asUintN(a.width,v[p.a]+(v[p.subtract]?-v[p.b]:v[p.b]));return {[p.out]:n,...(p.zero?{[p.zero]:Number(n===0n)}:{})};};
  }else if(method==='adder'){
    const a=port(p.a,'input'),b=port(p.b,'input',a.width),s=port(p.sum,'output',a.width);
    if(p.carry_in)port(p.carry_in,'input',1);
    if(p.carry_out)port(p.carry_out,'output',1);
    if(p.overflow)port(p.overflow,'output',1);
    inputs=[a,b,...(p.carry_in?[expected.ports.find(r=>r.name===p.carry_in)]:[])];
    calculate=v=>{
      const total=v[p.a]+v[p.b]+(p.carry_in?v[p.carry_in]:0n),result=total&mask(s.width),sign=1n<<BigInt(s.width-1);
      const signed=x=>(x&sign)?x-(1n<<BigInt(s.width)):x;
      const signedTotal=signed(v[p.a])+signed(v[p.b])+(p.carry_in?v[p.carry_in]:0n);
      return {[p.sum]:result,...(p.carry_out?{[p.carry_out]:total>>BigInt(s.width)}:{}),...(p.overflow?{[p.overflow]:Number(signedTotal< -sign||signedTotal>=sign)}:{})};
    };
  }else{
    check(new Set(p.inputs).size===p.inputs.length,'Logic inputs must be unique');
    inputs=p.inputs.map(n=>port(n,'input'));out=port(p.out,'output');
    const reduction=p.op.startsWith('reduce_'),compare=['eq','ne','lt_unsigned','gt_unsigned'].includes(p.op),unary=['copy','not'].includes(p.op)||reduction;
    check(unary?p.inputs.length===1:compare?p.inputs.length===2:p.inputs.length>=2,'Operation has wrong input arity');
    check(inputs.every(i=>i.width===inputs[0].width),'Logic operand widths must match');
    check(out.width===(reduction||compare?1:inputs[0].width),'Wrong logic result width');
    calculate=v=>{
      const xs=p.inputs.map(n=>v[n]),m=mask(inputs[0].width);let result;
      if(p.op==='copy')result=xs[0];
      else if(p.op==='not')result=(~xs[0])&m;
      else if(reduction){
        const n=xs[0],parity=()=>{let x=n,r=0n;while(x){r^=x&1n;x>>=1n;}return r;};
        result=p.op==='reduce_and'?BigInt(n===m):p.op==='reduce_or'?BigInt(n!==0n):parity();
        if(p.op==='reduce_xnor')result^=1n;
      }else if(compare)result=BigInt(p.op==='eq'?xs[0]===xs[1]:p.op==='ne'?xs[0]!==xs[1]:p.op==='lt_unsigned'?xs[0]<xs[1]:xs[0]>xs[1]);
      else if(['min_unsigned','max_unsigned'].includes(p.op))result=xs.reduce((a,b)=>p.op==='min_unsigned'?(a<b?a:b):(a>b?a:b));
      else{
        const op=({nand:'and',nor:'or',xnor:'xor'})[p.op]??p.op;
        result=xs.reduce((a,b)=>op==='and'?a&b:op==='or'?a|b:a^b);
        if(['nand','nor','xnor'].includes(p.op))result=(~result)&m;
      }
      return {[p.out]:result};
    };
  }
  const vectors=[],bits=inputs.reduce((n,i)=>n+i.width,0),add=v=>vectors.push(v);
  if(bits<=6){
    for(let n=0;n<2**bits;n++){
      let remainder=BigInt(n);const v={};
      for(const input of inputs){v[input.name]=remainder&mask(input.width);remainder>>=BigInt(input.width);}add(v);
    }
  }else{
    const fill=f=>Object.fromEntries(inputs.map((r,i)=>[r.name,f(r,i)]));
    add(fill(()=>0n));add(fill(r=>mask(r.width)));add(fill((r,i)=>pattern(r.width,!!(i%2))));
    add(fill((r,i)=>(~pattern(r.width,!!(i%2)))&mask(r.width)));
    if(method==='adder'){
      const w=inputs[0].width,m=mask(w),sign=1n<<BigInt(w-1);
      for(const [a,b]of [[0n,1n],[m,1n],[sign-1n,1n],[sign,sign],[sign,m],[sign-1n,sign-1n],[m,m],[sign-1n,sign]])
        for(const cin of p.carry_in?[0n,1n]:[0n])add({[p.a]:a,[p.b]:b,...(p.carry_in?{[p.carry_in]:cin}:{})});
    }else for(const r of inputs){
      for(const value of [1n,1n<<BigInt(r.width-1),mask(r.width)]){
        add({...fill(()=>0n),[r.name]:value});if(vectors.length>=80)break;
      }
      if(vectors.length>=80)break;
    }
    if(method==='logic'&&['min_unsigned','max_unsigned'].includes(p.op))for(const r of inputs)add({...fill(x=>p.op==='min_unsigned'?mask(x.width):0n),[r.name]:p.op==='min_unsigned'?1n:mask(r.width)});
    if(method==='addsub')for(const sub of [0n,1n])for(const [a,b]of [[0n,0n],[1n,1n],[0n,1n],[mask(inputs[0].width),1n]])add({[p.a]:a,[p.b]:b,[p.subtract]:sub});
    uncovered.push('Combinational input space exceeds six bits; only deterministic boundary and asymmetric samples are checked.');
  }
  for(const vector of vectors){
    const expect=calculate(vector);calculations.push({method:'source-declared-'+method,operation:p.op??'add',inputs:Object.fromEntries(Object.entries(vector).map(([n,v])=>[n,v.toString()])),expected:Object.fromEntries(Object.entries(expect).map(([n,v])=>[n,String(v)]))});
    emit(vector,expect,0);
  }
  return true;
}
