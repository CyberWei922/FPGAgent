// Summaries describe observations only. They do not consume fixture labels or
// classify an unobserved internal state as the root cause.
export function summarizeCounterexample(trace) {
  if (!trace || trace.schema !== 'prob154-v1') return null;
  const first = trace.samples.find(row => row.sample === trace.firstSample && row.mismatch);
  if (!first) return null;
  const known = value => /^[0-9a-f]+$/i.test(value);
  const dataKnown = known(first.expectedData) && known(first.actualData);
  const doneKnown = /^[01]$/.test(first.expectedDone) && /^[01]$/.test(first.actualDone);
  const doneDiff = doneKnown && first.expectedDone !== first.actualDone;
  const dataDiff = dataKnown && first.expectedData.toLowerCase() !== first.actualData.toLowerCase();
  const facts = [`首错：检查点 ${first.sample}，${first.timePs} ps。`,
    `done 期望=${first.expectedDone}、实际=${first.actualDone}；数据期望=${first.expectedData}、实际=${first.actualData}。`];
  if (doneDiff) {
    facts.push(first.expectedDone === '1' ? '完成信号应有效但未有效。' : '完成信号不应有效却有效。');
    if (dataKnown && !dataDiff) facts.push('此检查点数据一致，优先检查完成信号与状态转换的时序关系。');
    else facts.push('可先检查完成信号的生成条件；单个检查点不能证明提前或延后几拍。');
  }
  if (dataDiff) {
    facts.push('此检查点数据不同，可检查采集顺序、拼接和位宽。');
    if (first.expectedData.match(/../g).reverse().join('').toLowerCase() === first.actualData.toLowerCase()) {
      facts.push('实际值恰为期望值的三字节逆序；这是字节顺序线索，不是根因证明。');
    }
  }
  if (!dataKnown || !doneKnown) facts.push('部分信号含 X/Z，不据字符串不同断定该信号出错；以原测试台判定为准。');
  if (trace.samples.some(row => row.sample <= first.sample && row.reset === '1')) {
    facts.push('首错及其之前的窗口中出现 reset=1，可检查复位后的状态与输出；尚不能断定复位是根因。');
  }
  if (!trace.complete) facts.push('后续上下文未收齐。');
  facts.push('记录来自原测试台双沿检查点，不等于完整时钟周期。');
  return facts.join(' ');
}

export function parseCounterexample(log) {
  const lines = log.split(/\r?\n/).map(x => x.trim());
  const headers = lines.filter(x => x.startsWith('RTL_CE_BEGIN '));
  if (headers.length !== 1) return null;
  const h = /^RTL_CE_BEGIN schema=prob154-v1 first_sample=(\d+) before=([0-4]) after_requested=4$/.exec(headers[0]);
  if (!h) return null;
  const rows = lines.filter(x => x.startsWith('RTL_CE '));
  if (!rows.length || rows.length > 9) return null;
  const samples = [];
  const pattern = /^RTL_CE sample=(\d+) time_ps=(\d+) clk=([01xz]) reset=([01xz]) in=([0-9a-fxz]{2}) expected_done=([01xz]) actual_done=([01xz]) expected_data=([0-9a-fxz]{6}) actual_data=([0-9a-fxz]{6}) mismatch=([01])$/i;
  for (const line of rows) {
    const m = pattern.exec(line);
    if (!m) return null;
    const [sample,timePs] = [Number(m[1]),Number(m[2])];
    if (![sample,timePs].every(Number.isSafeInteger) || sample < 1 || (samples.length && (sample !== samples.at(-1).sample + 1 || timePs < samples.at(-1).timePs))) return null;
    samples.push({sample,timePs,clk:m[3],reset:m[4],input:m[5],expectedDone:m[6],actualDone:m[7],expectedData:m[8],actualData:m[9],mismatch:m[10] === '1'});
  }
  const firstSample = Number(h[1]), before = Number(h[2]);
  if (!Number.isSafeInteger(firstSample) || samples[before]?.sample !== firstSample || !samples[before]?.mismatch || samples.slice(0,before).some(x=>x.mismatch) || samples.length > before + 5) return null;
  return {schema:'prob154-v1',firstSample,sampling:'Original checker, both clock edges; time in ps; not a post-NBA waveform.',complete:samples.length === before+5 && lines.includes('RTL_CE_END'),samples};
}
