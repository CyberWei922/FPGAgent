import type { SignalSample } from '../types/contracts';

const LABEL = 43;
const CELL = 20;
const ROW = 24;

interface Channel {
  label: string;
  read: (sample: SignalSample) => number;
  bus?: boolean;
  clock?: boolean;
}

export function Waveform({ title, samples, failureCycle, ledFocus = false }: {
  title: string;
  samples: SignalSample[];
  failureCycle?: number;
  ledFocus?: boolean;
}) {
  const channels: Channel[] = [
    { label: 'CLK', read: () => 1, clock: true },
    { label: 'KEY0', read: (sample) => sample.inputs.key & 1 },
    { label: ledFocus ? 'LED0' : 'RED', read: (sample) => ledFocus ? sample.outputs.led & 1 : (sample.outputs.traffic >> 2) & 1 },
    { label: 'SEG', read: (sample) => sample.outputs.seg, bus: true },
  ];
  const width = LABEL + Math.max(10, samples.length) * CELL + 10;
  const height = channels.length * ROW + 25;
  const failureIndex = samples.findIndex((sample) => sample.cycle === failureCycle);
  return (
    <section className="instrument-section waveform-section">
      <div className="section-heading"><h2>{title}</h2>{samples.length > 0 && <span className="instrument-meta">周期 {samples.at(-1)?.cycle}</span>}</div>
      <div className="waveform-frame" tabIndex={samples.length > 10 ? 0 : undefined}>
        {samples.length === 0 ? <p className="instrument-empty">等待仿真采样</p> : (
          <svg style={{ minWidth: `${width}px` }} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${title}，${samples.length} 个采样周期`}>
            {Array.from({ length: Math.max(10, samples.length) + 1 }, (_, index) => <line className="wave-grid" key={index} x1={LABEL + index * CELL} x2={LABEL + index * CELL} y1="9" y2={height - 17} />)}
            {channels.map((channel, row) => {
              const high = row * ROW + 11;
              const low = high + 12;
              return <g key={channel.label}>
                <text x="7" y={high + 9}>{channel.label}</text>
                <line className="wave-grid" x1={LABEL} x2={width - 10} y1={low + 3} y2={low + 3} />
                {channel.bus ? samples.map((sample, index) => {
                  const x = LABEL + index * CELL;
                  const value = channel.read(sample);
                  return <g key={sample.cycle}>
                    <rect className="wave-bus" x={x} y={high} width={CELL} height={12} />
                    {(index === 0 || channel.read(samples[index - 1]) !== value) && (
                      <text x={x + CELL / 2} y={high + 9} textAnchor="middle">{value.toString(16).toUpperCase()}</text>
                    )}
                  </g>;
                }) : <path className="wave-trace" d={samples.map((sample, index) => {
                  const x = LABEL + index * CELL;
                  if (channel.clock) return `${index ? 'L' : 'M'} ${x} ${low} h ${CELL / 2} V ${high} h ${CELL / 2} V ${low}`;
                  const y = channel.read(sample) ? high : low;
                  return `${index ? `H ${x} V ${y}` : `M ${x} ${y}`} H ${x + CELL}`;
                }).join(' ')} />}
              </g>;
            })}
            {samples.map((sample, index) => (index === 0 || index % 2 === 0 || index === failureIndex) && (
              <text key={sample.cycle} className={index === failureIndex ? 'wave-failed-label' : undefined} x={LABEL + index * CELL + 2} y={height - 4}>{sample.cycle}</text>
            ))}
            {failureIndex >= 0 && <rect className="wave-failure" x={LABEL + failureIndex * CELL} y="3" width={CELL} height={height - 15} />}
          </svg>
        )}
      </div>
    </section>
  );
}
