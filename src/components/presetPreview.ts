import type { AgentBlueprint, BoardInputs, NetlistEdge, NetlistGraph, NetlistNode, SignalSample } from '../types/contracts';

export const QUICK_PROMPTS = [
  { kind: 'traffic', prompt: '做一个智能交通灯' },
  { kind: 'lock', prompt: '做一个四位密码锁' },
] as const;

export const LOCK_BLUEPRINT: AgentBlueprint = {
  title: '四位拨码密码锁',
  summary: '用 SW3 至 SW0 输入 1010，按 KEY0 确认。开锁后 LED0 亮，RST 重新锁定。',
  behaviors: ['将拨码输入与示例值比较：1010', '按下 KEY0 时更新锁状态', '按 RST 清除开锁状态'],
  pinMappings: [
    { port: 'sw[3:0]', role: '四位输入' },
    { port: 'key[0]', role: '确认' },
    { port: 'led[0]', role: '开锁指示' },
    { port: 'rst_n', role: '低电平复位' },
  ],
  mermaidFsm: '',
};

export function stepLockPreview(inputs: BoardInputs, previous?: SignalSample): { sample: SignalSample; netlist: NetlistGraph } {
  const value = inputs.sw & 15;
  const confirm = inputs.key & 1;
  const match = Number(value === 10);
  const pressed = confirm && !((previous?.inputs.key ?? 0) & 1);
  const unlocked = inputs.rst_n === 0 ? 0 : pressed ? match : (previous?.outputs.led ?? 0);
  const sample: SignalSample = {
    cycle: (previous?.cycle ?? -1) + 1,
    inputs,
    outputs: { led: unlocked, traffic: 0, seg: value },
    internals: { match },
  };
  const nodes: NetlistNode[] = [
    { id: 'switches', label: 'SW[3:0]', kind: 'INPUT', width: 4, level: 0, value, changed: value !== ((previous?.inputs.sw ?? 0) & 15) },
    { id: 'key0', label: 'KEY0', kind: 'INPUT', width: 1, level: 0, value: confirm, changed: confirm !== ((previous?.inputs.key ?? 0) & 1) },
    { id: 'compare', label: '匹配 1010', kind: 'CMP', width: 1, level: 1, value: match, changed: match !== (previous?.internals.match ?? 0) },
    { id: 'latch', label: '开锁状态', kind: 'DFF', width: 1, level: 2, value: unlocked, changed: unlocked !== (previous?.outputs.led ?? 0) },
    { id: 'unlock', label: 'LED0', kind: 'OUTPUT', width: 1, level: 3, value: unlocked, changed: unlocked !== (previous?.outputs.led ?? 0) },
  ];
  const edges: NetlistEdge[] = [
    ['switches', 'compare'], ['compare', 'latch'], ['key0', 'latch'], ['latch', 'unlock'],
  ].map(([from, to]) => {
    const source = nodes.find((node) => node.id === from)!;
    return { id: `${from}-${to}`, from, to, signalName: source.label, value: source.value, changed: source.changed };
  });
  const narration = unlocked ? '密码正确，LED0 亮。按 RST 重新锁定。' : '将 SW3 和 SW1 拨到 1，其余置 0，再按 KEY0 确认。';
  return { sample, netlist: { nodes, edges, maxLevel: 3, narration } };
}
