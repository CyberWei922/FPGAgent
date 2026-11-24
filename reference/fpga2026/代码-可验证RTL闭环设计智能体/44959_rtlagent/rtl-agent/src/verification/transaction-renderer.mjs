// The DUT controls only completion timing. Inputs and numerical expectations
// are frozen CPU values; no DUT data ever enters the oracle or future stimulus.
export function renderTransactionTestbench(plan,expected){
 const tx=plan.transaction,p=tx.params,t=p.timing,n=tx.samples.length,wait=tx.wait;
 if(![1,2].includes(tx.version)||n<2||n>64||wait<1||wait>128)throw Error('Invalid bounded transaction plan');
 const top=expected.top==='rtl_selfcheck_tb'?'rtl_selfcheck_tb_2':'rtl_selfcheck_tb';
 let prefix='__rtl_tx_';while(expected.ports.some(p=>p.name.startsWith(prefix)))prefix+='_';
 const v=name=>prefix+name,clk=p.clock.port,active=p.clock.edge==='posedge'?1:0,idle=1-active;
 const input=t.kind==='start_done'?t.start:t.input_valid;
 const output=t.kind==='start_done'?t.done:t.output_valid;
 const holdStart=t.kind==='start_done'&&tx.version>=2&&t.start_behavior!=='pulse';
 const lines=['`timescale 1ns/1ps',`module ${top};`];
 const add=(...s)=>lines.push(...s);
 for(const port of expected.ports)add(`${port.direction==='input'?'reg':'wire'} [${port.width-1}:0] ${port.name};`);
 add(`${expected.top} ${v('dut')}(${expected.ports.map(p=>`.${p.name}(${p.name})`).join(',')});`);
 for(const name of ['checks','failures','fd','sent','received','cycle','k','j','drain'])add(`integer ${v(name)} = 0;`);
 add(`integer ${v('accepted')} [0:${n-1}];`);
 for(const name of ['monitor','offer','event','due','protocol_bad','invalid_bad','last_known','previous_done','reported','cooldown'])add(`reg ${v(name)} = 0;`);
 for(const name of p.operands){const port=expected.ports.find(p=>p.name===name);add(`reg [${port.width-1}:0] ${v('input_'+name)} [0:${n-1}];`);}
 for(const {port:name} of p.outputs){const port=expected.ports.find(p=>p.name===name);add(`reg [${port.width-1}:0] ${v('expected_'+name)} [0:${n-1}];`,`reg [${port.width-1}:0] ${v('last_'+name)};`,`reg ${v('seen_'+name)} [0:${n-1}];`,`reg ${v('bad_'+name)} [0:${n-1}];`);}
 add(`task ${v('tick')}; begin`,`  #2; ${clk} = 1'b${active}; #2;`,`  if (${v('monitor')}) begin`,`    ${v('event')} = 0; ${v('due')} = 0;`);
 if(t.kind==='fixed'){
  add(`    if (${v('received')} < ${v('sent')}) ${v('due')} = (${v('cycle')} == ${v('accepted')}[${v('received')}] + ${t.cycles-1});`);
  if(output)add(`    if (${output} !== ${v('due')}) ${v('protocol_bad')} = 1;`,`    ${v('event')} = ${v('due')} && (${output} === 1'b1);`);
  else add(`    ${v('event')} = ${v('due')};`);
 }else{
  add(`    if (${output} !== 1'b0 && ${output} !== 1'b1) ${v('protocol_bad')} = 1;`);
  add(`    ${v('event')} = (${output} === 1'b1)${t.kind==='start_done'&&t.done_behavior==='held'?` && !${v('previous_done')}`:''};`);
 }
 add(`    if (${v('event')}) begin`,`      if (${v('received')} >= ${v('sent')}) ${v('protocol_bad')} = 1;`,`      else begin`);
 for(const {port:name} of p.outputs){
  add(`        ${v('seen_'+name)}[${v('received')}] = 1;`,`        if (${name} !== ${v('expected_'+name)}[${v('received')}]) begin`,`          ${v('bad_'+name)}[${v('received')}] = 1;`,`          if (!${v('reported')}) begin`,`            ${v('reported')} = 1;`,`            $display("RTL_SELFTEST_TRANSACTION_FAIL transaction=%0d cycle=%0d port=${name} expected=%h actual=%h", ${v('received')}, ${v('cycle')}, ${v('expected_'+name)}[${v('received')}], ${name});`,`          end`,`        end`,`        ${v('last_'+name)} = ${v('expected_'+name)}[${v('received')}];`);
 }
 add(`        ${v('received')} = ${v('received')} + 1; ${v('last_known')} = 1;`,`      end`,`    end`);
 if(p.invalid){
  // A held done remains valid, although it is not a new completion event.
  const invalid=output?`${output} === 1'b0`:`!${v('due')}`;
  for(const {port:name} of p.outputs)add(`    if ((${invalid})${p.invalid.kind==='hold'?` && ${v('last_known')}`:''} && ${name} !== ${p.invalid.kind==='hold'?v('last_'+name):"'0"}) ${v('invalid_bad')} = 1;`);
 }
 if(t.kind!=='fixed')add(`    if (${v('received')} < ${v('sent')} && ${v('cycle')} - ${v('accepted')}[${v('received')}] > ${wait}) ${v('protocol_bad')} = 1;`);
 if(t.kind==='start_done'&&t.done_behavior==='held')add(`    ${v('previous_done')} = (${output} === 1'b1);`);
 add(`  end`,`  ${clk} = 1'b${idle};`,`end endtask`,`initial begin`);
 for(const port of expected.ports.filter(p=>p.direction==='input'))add(`  ${port.name} = '0;`);
 add(`  ${clk} = 1'b${idle};`);
 tx.samples.forEach((s,i)=>{
  for(const [name,value] of Object.entries(s.drive))add(`  ${v('input_'+name)}[${i}] = ${value};`);
  for(const [name,value] of Object.entries(s.expect))add(`  ${v('expected_'+name)}[${i}] = ${value}; ${v('seen_'+name)}[${i}] = 0; ${v('bad_'+name)}[${i}] = 0;`);
 });
 add(`  ${p.reset.port} = 1'b${p.reset.active}; repeat (2) ${v('tick')};`,`  ${p.reset.port} = 1'b${1-p.reset.active};`);
 if(p.reset.kind==='unspecified'){
  add(`  ${p.reset.port} = 1'b${1-p.reset.active}; ${v('tick')}; ${v('monitor')} = 1;`);
 }else{
 for(const name of p.operands)add(`  ${name} = ${v('input_'+name)}[${n-1}];`);
 if(input)add(`  ${input} = 1;`);
 add(`  ${v('tick')};`);
 if(input)add(`  ${input} = 0;`);
 add(`  ${p.reset.port} = 1'b${p.reset.active}; repeat (2) ${v('tick')};`,`  ${p.reset.port} = 1'b${1-p.reset.active}; ${v('monitor')} = 1;`);
 // Valid/done designs must not emit the cancelled probe after reset. A
 // free-running fixed-latency interface has no observable empty queue.
 if(input)add(`  repeat (${wait+1}) begin ${v('tick')}; ${v('cycle')} = ${v('cycle')} + 1; end`);
 }
 add(`  ${v('cycle')} = 0;`,`  begin : ${v('bounded_run')}`,`  for (${v('k')} = 0; ${v('k')} < ${(n+2)*(wait+3)}; ${v('k')} = ${v('k')} + 1) begin`);
 const canOffer=t.kind==='start_done'?`${v('received')} == ${v('sent')} && !${v('cooldown')}${t.busy?` && (${t.busy} === 1'b0)`:''}`:input?`(${v('sent')} < 8 || (${v('cycle')} % 4) != 2)`:'1';
 add(`    ${v('offer')} = (${v('sent')} < ${n}) && (${canOffer});`);
 if(input)add(`    ${input} = ${v('offer')}${holdStart?` || (${v('sent')} > ${v('received')})`:''};`);
 for(const name of p.operands)add(`    ${name} = ${v('input_'+name)}[${v('offer')} ? ${v('sent')} : ${holdStart?`(${v('sent')} > ${v('received')}) ? ${v('sent')} - 1 : `:''}((${v('cycle')} + 7) % ${n})];`);
 add(`    if (${v('offer')}) begin ${v('accepted')}[${v('sent')}] = ${v('cycle')}; ${v('sent')} = ${v('sent')} + 1; end`,`    ${v('tick')}; ${v('cycle')} = ${v('cycle')} + 1;`);
 if(t.kind==='start_done')add(`    ${v('cooldown')} = ${v('event')};`);
 add(`    if (${v('sent')} == ${n}) ${v('drain')} = ${v('drain')} + 1;`,`    if (${v('received')} == ${n} && ${v('drain')} > ${wait+2}) disable ${v('bounded_run')};`,`  end`,`  end`);
 const check=(condition,label)=>add(`  ${v('checks')} = ${v('checks')} + 1;`,`  if (!(${condition})) begin ${v('failures')} = ${v('failures')} + 1; $display("RTL_SELFTEST_FAIL ${label}"); end`);
 for(let i=0;i<n;i++)for(const {port:name} of p.outputs)check(`${v('seen_'+name)}[${i}] && !${v('bad_'+name)}[${i}]`,`transaction=${i} port=${name} missing_or_wrong_result`);
 check(`${v('sent')} == ${n} && ${v('received')} == ${n}`,'transaction_count_not_equal_to_accepted_inputs');
 check(`!${v('protocol_bad')}`,'unexpected_unknown_early_late_or_extra_completion');
 if(p.invalid)check(`!${v('invalid_bad')}`,'specified_invalid_data_rule');
 add(`  ${v('fd')} = $fopen("selftest_result.txt", "w");`,`  if (${v('fd')} == 0) $fatal(1, "Self-check result file missing");`,`  $fwrite(${v('fd')}, "checks=%0d failures=%0d\\n", ${v('checks')}, ${v('failures')});`,`  $fclose(${v('fd')});`,`  $display("RTL_SELFTEST_COMPLETE checks=%0d failures=%0d", ${v('checks')}, ${v('failures')});`,`  $finish;`,`end`,`endmodule`,'');
 return {top,source:lines.join('\n')};
}

export function negativeTransactionRtl(plan,expected){
 const tx=plan.transaction,first=tx.params.outputs[0].port,w=expected.ports.find(p=>p.name===first).width;
 const expectedBits=BigInt('0x'+tx.samples[0].expect[first].split("'h")[1]),wrong=`${w}'h${(expectedBits^1n).toString(16)}`;
 return `module ${expected.top}(${expected.ports.map(p=>`${p.direction} wire [${p.width-1}:0] ${p.name}`).join(',')});\n`+expected.ports.filter(p=>p.direction==='output').map(p=>`assign ${p.name} = ${p.name===first?wrong:"'0"};`).join('\n')+'\nendmodule\n';
}
