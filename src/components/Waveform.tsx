import type { SignalSample } from '../types/contracts';

const CELL = 26;
const ROW = 24;
const LABEL_W = 64;

interface Row {
  label: string;
  width: number;
  read: (s: SignalSample) => number;
}

const ROWS: Row[] = [
  { label: 'rst_n', width: 1, read: (s) => s.inputs.rst_n },
  { label: 'key0', width: 1, read: (s) => s.inputs.key & 1 },
  { label: 'red', width: 1, read: (s) => (s.outputs.traffic >> 2) & 1 },
  { label: 'yellow', width: 1, read: (s) => (s.outputs.traffic >> 1) & 1 },
  { label: 'green', width: 1, read: (s) => s.outputs.traffic & 1 },
  { label: 'seg', width: 16, read: (s) => s.outputs.seg },
  { label: 'led', width: 8, read: (s) => s.outputs.led },
];

interface Props {
  title: string;
  samples: SignalSample[];
  failureCycle?: number;
}

export function Waveform({ title, samples, failureCycle }: Props) {
  const width = LABEL_W + samples.length * CELL;
  const height = ROWS.length * ROW + 16;
  const failureIndex = samples.findIndex((s) => s.cycle === failureCycle);

  return (
    <div className="p-3 text-xs">
      <div className="mb-1 text-slate-400">{title}</div>
      {samples.length === 0 ? (
        <div className="text-slate-600">暂无波形</div>
      ) : (
        <div className="overflow-x-auto">
          <svg width={width} height={height} fontFamily="monospace" fontSize={10}>
            {ROWS.map((row, r) => {
              const y0 = r * ROW + 4;
              const hi = y0 + 4;
              const lo = y0 + ROW - 6;
              let d = '';
              if (row.width === 1) {
                samples.forEach((s, i) => {
                  const y = row.read(s) ? hi : lo;
                  const x = LABEL_W + i * CELL;
                  d += `${i ? 'L' : 'M'}${x},${y} L${x + CELL},${y} `;
                });
              }
              return (
                <g key={row.label}>
                  <text x={0} y={y0 + 13} fill="#94a3b8">
                    {row.label}
                  </text>
                  {row.width === 1 ? (
                    <path d={d} fill="none" stroke="#22d3ee" strokeWidth={1.5} />
                  ) : (
                    samples.map((s, i) => {
                      const x = LABEL_W + i * CELL;
                      const v = row.read(s);
                      const changed = i === 0 || row.read(samples[i - 1]) !== v;
                      return (
                        <g key={i}>
                          <rect x={x} y={hi} width={CELL} height={lo - hi} fill="none" stroke="#475569" />
                          {changed && (
                            <text x={x + 2} y={y0 + 14} fill="#e2e8f0">
                              {v.toString(16).toUpperCase()}
                            </text>
                          )}
                        </g>
                      );
                    })
                  )}
                </g>
              );
            })}
            {samples.map((s, i) => (
              <text key={s.cycle} x={LABEL_W + i * CELL + 2} y={height - 2} fill="#475569">
                {s.cycle}
              </text>
            ))}
            {failureIndex >= 0 && (
              <rect
                x={LABEL_W + failureIndex * CELL}
                y={0}
                width={CELL}
                height={height - 12}
                fill="rgba(244,63,94,0.15)"
                stroke="#f43f5e"
                strokeWidth={2}
              />
            )}
          </svg>
        </div>
      )}
    </div>
  );
}
