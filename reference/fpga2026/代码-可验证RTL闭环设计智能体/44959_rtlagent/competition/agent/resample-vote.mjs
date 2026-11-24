import {createHash} from 'node:crypto';
// Stable content identity: competition request IDs are deliberately random.
export function voteSeedKey(prompt,interfaceText=''){return createHash('sha256').update(prompt+'\0'+interfaceText).digest('hex');}
export function randomBench(expected,task){
  if(expected.unresolved.length||expected.ports.some(p=>p.direction==='inout'||!p.width))throw Error('Unresolved differential interface');
  const ports=expected.ports,inputs=ports.filter(p=>p.direction==='input'),outputs=ports.filter(p=>p.direction==='output');
  if(!outputs.length)throw Error('No output for differential comparison');
  const clocks=inputs.filter(p=>p.width===1&&/^(?:clk|clock)$/i.test(p.name));
  const resets=inputs.filter(p=>p.width===1&&/(?:reset|rst|areset)/i.test(p.name));
  let rng=createHash('sha256').update(task+':'+26026).digest().readUInt32LE(0)||1;
  const next=()=>{rng^=rng<<13;rng^=rng>>>17;rng^=rng<<5;return rng>>>0;};
  const literal=p=>{let bits='';while(bits.length<p.width)bits+=(next()>>>0).toString(2).padStart(32,'0');return `${p.width}'b${bits.slice(0,p.width)}`;};
  const lines=['`timescale 1ns/1ps','module rtl_random_tb;','integer fd;'];
  for(const p of ports)lines.push(`${p.direction==='input'?'reg':'wire'} ${p.width>1?`[${p.width-1}:0] `:''}${p.name};`);
  lines.push(`${expected.top} dut (${ports.map(p=>`.${p.name}(${p.name})`).join(',')});`,'initial begin', 'fd=$fopen("random_trace.txt","w");');
  for(let i=0;i<256;i++){
    const asserted=i<4||i%47===0;
    for(const p of inputs){
      const isClock=clocks.includes(p),isReset=resets.includes(p),activeLow=/(?:_n|n|_b)$/.test(p.name);
      lines.push(`${p.name}=${isClock?"1'b0":isReset?`1'b${Number(asserted)!==Number(activeLow)?1:0}`:literal(p)};`);
    }
    lines.push('#2;');for(const p of clocks)lines.push(`${p.name}=1'b1;`);
    lines.push('#2;',`$fwrite(fd,"${i} ${outputs.map(p=>'%b').join(' ')}\\n",${outputs.map(p=>p.name).join(',')});`);
  }
  lines.push('$fclose(fd);','fd=$fopen("selftest_result.txt","w");','$fwrite(fd,"checks=1 failures=0\\n");','$fclose(fd);','$finish;','end','endmodule');
  return lines.join('\n')+'\n';
}

