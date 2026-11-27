import { localizeGateText, useI18n } from '../services/i18n';
import type { NetlistNode } from '../types/contracts';
import type { SchematicNode, SchematicPin } from './schematicLayout';

export function signalValue(value: number, width: number): string {
  return width <= 1 ? String(value) : `0x${value.toString(16).toUpperCase()}`;
}

export function GateSymbol({ node, sample }: { node: SchematicNode; sample?: NetlistNode }) {
  const { locale } = useI18n();
  const { width, height, bodyHeight, kind, pins } = node;
  const rawLabel = localizeGateText(node.label, locale);
  const operator = node.operator ? localizeGateText(node.operator, locale) : undefined;
  const left = 10;
  const right = width - 10;
  const top = 8;
  const bottom = top + bodyHeight;
  const center = top + bodyHeight / 2;
  const middle = width / 2;
  const hasSelect = pins.some((pin) => pin.side === 'SOUTH');
  const curved = kind === 'OR' || kind === 'XOR';
  const bow = 21;
  const textLimit = Math.floor(width / 6.1);
  const label = rawLabel.length > textLimit ? `${rawLabel.slice(0, textLimit - 1)}…` : rawLabel;
  const value = sample && sample.sampled !== false ? signalValue(sample.value, sample.width) : '–';
  let symbol;

  switch (kind) {
    case 'AND':
      symbol = <path className="gate-body" d={`M ${left} ${top} H ${middle} A ${right - middle} ${bodyHeight / 2} 0 0 1 ${middle} ${bottom} H ${left} Z`} />;
      break;
    case 'OR':
    case 'XOR': {
      const outline = `M ${left} ${top} Q ${right - 16} ${top} ${right} ${center} Q ${right - 16} ${bottom} ${left} ${bottom} Q ${left + bow} ${center} ${left} ${top} Z`;
      symbol = <>
        <path className="gate-body" d={outline} />
        {kind === 'XOR' && <path className="gate-detail" d={`M ${left - 5} ${top} Q ${left + bow - 5} ${center} ${left - 5} ${bottom}`} />}
      </>;
      break;
    }
    case 'NOT':
      symbol = <>
        <path className="gate-body" d={`M ${left} ${top} L ${right - 8} ${center} L ${left} ${bottom} Z`} />
        <circle className="gate-body" cx={right - 4} cy={center} r="4" />
      </>;
      break;
    case 'MUX':
      symbol = <>
        <path className="gate-body" d={`M ${left} ${top} L ${right} ${top + 8} V ${bottom - 8} L ${left} ${bottom} Z`} />
        <text className="gate-operator" x={middle} y={center} textAnchor="middle" dominantBaseline="central">MUX</text>
      </>;
      break;
    case 'INPUT':
    case 'OUTPUT':
    case 'CONST':
      symbol = <>
        <path className="gate-body" d={kind === 'OUTPUT'
          ? `M ${left} ${center} L ${left + 10} ${center - 12} H ${right} V ${center + 12} H ${left + 10} Z`
          : `M ${left} ${center - 12} H ${right - 10} L ${right} ${center} L ${right - 10} ${center + 12} H ${left} Z`} />
        <text className="gate-value" x={middle} y={center} textAnchor="middle" dominantBaseline="central">{kind === 'CONST' ? node.label : value}</text>
      </>;
      break;
    default:
      symbol = <>
        <rect className="gate-body" x={left} y={top} width={right - left} height={bodyHeight} rx="2" />
        <text className="gate-operator" x={middle} y={center} textAnchor="middle" dominantBaseline="central">{operator ?? kind}</text>
      </>;
  }

  function lead(pin: SchematicPin) {
    if (pin.side === 'SOUTH') return `M ${pin.x} ${pin.y} V ${bottom - 4}`;
    if (pin.side === 'EAST') return `M ${pin.x} ${pin.y} H ${right}`;
    const t = (pin.y - top) / bodyHeight;
    const contact = curved ? left + 2 * bow * t * (1 - t) : left;
    return `M ${pin.x} ${pin.y} H ${contact}`;
  }

  const title = kind === 'CONST' ? rawLabel : `${rawLabel} · ${kind}${value === '–' ? '' : ` = ${value}`}`;
  return (
    <g className={`gate-node${sample && sample.value > 0 ? ' high' : ''}`} data-gate-kind={kind} data-gate-id={node.id} transform={`translate(${node.x} ${node.y})`}>
      <title>{title}</title>
      {pins.map((pin) => <path key={pin.id} className="gate-lead" data-pin-id={pin.id} d={lead(pin)} />)}
      {symbol}
      {pins.map((pin) => pin.clock ? (
        <path key={pin.id} className="gate-detail" d={`M ${left} ${pin.y - 4} l 6 4 l -6 4`} />
      ) : pin.label ? (
        <text key={pin.id} className="gate-pin-label"
          x={pin.side === 'SOUTH' ? middle : pin.side === 'WEST' ? left + 4 : right - 4}
          y={pin.side === 'SOUTH' ? bottom - 11 : pin.y}
          dominantBaseline="central" textAnchor={pin.side === 'SOUTH' ? 'middle' : pin.side === 'WEST' ? 'start' : 'end'}>{pin.label}</text>
      ) : null)}
      {pins.filter((pin) => pin.activeLow).map((pin) => <circle key={pin.id} className="gate-body" cx={left - 3.5} cy={pin.y} r="3.5" />)}
      {kind !== 'CONST' && <text className="gate-name" x={hasSelect ? middle + 10 : middle} y={hasSelect ? height - 20 : height - 6} textAnchor={hasSelect ? 'start' : 'middle'}>{label}</text>}
    </g>
  );
}
