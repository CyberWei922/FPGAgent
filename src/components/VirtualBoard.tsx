import type { BoardInputs, BoardOutputs } from '../types/contracts';

interface Props {
  inputs: BoardInputs;
  outputs?: BoardOutputs;
  onInputsChange: (inputs: BoardInputs) => void;
}

const bit = (value: number, i: number) => (value >> i) & 1;
const range = (n: number) => Array.from({ length: n }, (_, i) => n - 1 - i);

export function VirtualBoard({ inputs, outputs, onInputsChange }: Props) {
  const out = outputs ?? { led: 0, traffic: 0, seg: 0 };
  const setKey = (i: number, pressed: boolean) =>
    onInputsChange({ ...inputs, key: pressed ? inputs.key | (1 << i) : inputs.key & ~(1 << i) });

  return (
    <div className="space-y-4 p-3 text-xs">
      <div className="flex items-center gap-4">
        <div className="flex flex-col gap-1 rounded-lg bg-slate-900 p-2">
          {[
            [2, '#ef4444'],
            [1, '#eab308'],
            [0, '#22c55e'],
          ].map(([i, color]) => (
            <span
              key={i}
              className="block h-6 w-6 rounded-full"
              style={{ background: bit(out.traffic, i as number) ? (color as string) : '#1e293b', boxShadow: bit(out.traffic, i as number) ? `0 0 12px ${color}` : undefined }}
            />
          ))}
        </div>
        <div className="flex gap-1 rounded bg-black px-2 py-1 font-mono text-3xl text-rose-500">
          {range(4).map((d) => (
            <span key={d} className="w-6 text-center">
              {((out.seg >> (d * 4)) & 0xf).toString(16).toUpperCase()}
            </span>
          ))}
        </div>
      </div>

      <div>
        <div className="mb-1 text-slate-400">LED[7:0]</div>
        <div className="flex gap-2">
          {range(8).map((i) => (
            <span
              key={i}
              className="h-3 w-3 rounded-full"
              style={{ background: bit(out.led, i) ? '#4ade80' : '#1e293b', boxShadow: bit(out.led, i) ? '0 0 8px #4ade80' : undefined }}
            />
          ))}
        </div>
      </div>

      <div>
        <div className="mb-1 text-slate-400">SW[7:0]</div>
        <div className="flex gap-1">
          {range(8).map((i) => (
            <button
              key={i}
              onClick={() => onInputsChange({ ...inputs, sw: inputs.sw ^ (1 << i) })}
              className={`h-8 w-5 rounded ${bit(inputs.sw, i) ? 'bg-cyan-500' : 'bg-slate-700'}`}
              title={`SW${i}`}
            />
          ))}
        </div>
      </div>

      <div className="flex items-end gap-2">
        {range(4).map((i) => (
          <button
            key={i}
            onPointerDown={() => setKey(i, true)}
            onPointerUp={() => setKey(i, false)}
            onPointerLeave={() => bit(inputs.key, i) && setKey(i, false)}
            className={`h-10 w-10 rounded-full border-2 ${bit(inputs.key, i) ? 'border-cyan-300 bg-cyan-700' : 'border-slate-600 bg-slate-800'}`}
          >
            K{i}
          </button>
        ))}
        <button
          onPointerDown={() => onInputsChange({ ...inputs, rst_n: 0 })}
          onPointerUp={() => onInputsChange({ ...inputs, rst_n: 1 })}
          onPointerLeave={() => inputs.rst_n === 0 && onInputsChange({ ...inputs, rst_n: 1 })}
          className={`ml-auto h-10 rounded px-3 ${inputs.rst_n === 0 ? 'bg-rose-500' : 'bg-rose-900'}`}
        >
          RST
        </button>
      </div>
    </div>
  );
}
