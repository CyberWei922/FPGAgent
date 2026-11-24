import type { NetlistNode } from '../types/contracts';
import type { SchematicNode } from './schematicLayout';

export function signalValue(value: number, width: number): string {
  return width <= 1 ? String(value) : `0x${value.toString(16).toUpperCase()}`;
}

export function GateSymbol({ node, sample }: { node: SchematicNode; sample?: NetlistNode }) {
  const { width, height, bodyHeight, kind, pins } = node;
  const left = 15;
  const right = width - 15;
  const top = 8;
  const bottom = top + bodyHeight;
  const center = top + bodyHeight / 2;
  const middle = width / 2;
  const outline = `M ${left} ${top} Q ${right - 22} ${top} ${right} ${center} Q ${right - 22} ${bottom} ${left} ${bottom} Q ${left + 24} ${center} ${left} ${top} Z`;
  const fill = 'gate-body';
  const labelFit = Math.floor(width / 6.4);
  const label = node.label.length > labelFit ? `${node.label.slice(0, labelFit - 1)}…` : node.label;
  const value = sample ? signalValue(sample.value, sample.width) : '–';
  let symbol;
  switch (kind) {
    case 'AND':
      symbol = <path className={fill} d={`M ${left} ${top} H ${middle} A ${right - middle} ${bodyHeight / 2} 0 0 1 ${middle} ${bottom} H ${left} Z`} />;
      break;
    case 'OR':
    case 'XOR':
      symbol = <>
        <path className={fill} d={outline} />
        {kind === 'XOR' && <path className="gate-detail" d={`M ${left - 6} ${top} Q ${left + 18} ${center} ${left - 6} ${bottom}`} />}
      </>;
      break;
    case 'NOT':
      symbol = <>
        <path className={fill} d={`M ${left} ${top} L ${right - 10} ${center} L ${left} ${bottom} Z`} />
        <circle className={fill} cx={right - 5} cy={center} r="5" />
      </>;
      break;
    case 'MUX':
      symbol = <>
        <path className={fill} d={`M ${left} ${top} L ${right} ${top + 10} V ${bottom - 10} L ${left} ${bottom} Z`} />
        <text className="gate-operator" x={middle} y={center} textAnchor="middle" dominantBaseline="central">MUX</text>
      </>;
      break;
    case 'INPUT':
    case 'OUTPUT':
      symbol = <>
        <path className={fill} d={kind === 'INPUT'
          ? `M ${left} ${center - 13} H ${right - 13} L ${right} ${center} L ${right - 13} ${center + 13} H ${left} Z`
          : `M ${left} ${center} L ${left + 13} ${center - 13} H ${right} V ${center + 13} H ${left + 13} Z`} />
        <text className="gate-value" x={middle} y={center} textAnchor="middle" dominantBaseline="central">{value}</text>
      </>;
      break;
    default:
      symbol = <>
        <rect className={fill} x={left} y={top} width={right - left} height={bodyHeight} rx="2" />
        <text className="gate-operator" x={middle} y={center} textAnchor="middle" dominantBaseline="central">
          {kind === 'ADD' ? '+' : kind}
        </text>
        {pins.map((pin) => pin.clock ? (
          <path key={pin.id} className="gate-detail" d={`M ${left} ${pin.y - 4} l 6 4 l -6 4`} />
        ) : pin.label ? (
          <text key={pin.id} className="gate-pin-label" x={pin.side === 'WEST' ? left + 5 : right - 5} y={pin.y} dominantBaseline="central" textAnchor={pin.side === 'WEST' ? 'start' : 'end'}>{pin.label}</text>
        ) : null)}
      </>;
  }

  const start = kind === 'OR' || kind === 'XOR' || kind === 'OUTPUT' ? left + 13 : left;
  const isTerminal = kind === 'INPUT' || kind === 'OUTPUT';
  return (
    <g className={`gate-node${sample && sample.value > 0 ? ' high' : ''}`} data-gate-kind={kind} transform={`translate(${node.x} ${node.y})`}>
      <title>{node.label} · {kind} = {value}</title>
      {pins.map((pin) => <path key={pin.id} className="gate-lead" d={`M ${pin.x} ${pin.y} H ${pin.side === 'WEST' ? start : right - 3}`} />)}
      {symbol}
      {pins.filter((pin) => pin.activeLow).map((pin) => <circle key={pin.id} className={fill} cx={left - 4} cy={pin.y} r="4" />)}
      <text className="gate-name" x={middle} y={height - 6} textAnchor="middle">{label}</text>
      {!isTerminal && <text className="gate-value gate-readout" x={right} y={top - 1} textAnchor="end">{value}</text>}
    </g>
  );
}
