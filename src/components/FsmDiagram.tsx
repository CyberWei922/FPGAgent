import { Code2, GitBranch } from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';
import { useI18n } from '../services/i18n';
import {
  layoutFsm,
  layoutFsmWithElk,
  parseMermaidStateDiagram,
  resolveFsmLayoutMode,
  type FsmEdge,
  type FsmLayout,
  type FsmLayoutMode,
  type LayoutEdge,
  type LayoutNode,
  type ParsedFsm,
  type ResolvedFsmLayoutMode,
} from './fsmLayout';

export {
  layoutFsm,
  layoutFsmWithElk,
  parseMermaidStateDiagram,
  resolveFsmLayoutMode,
  type FsmEdge,
  type FsmLayout,
  type FsmLayoutMode,
  type LayoutEdge,
  type LayoutNode,
  type ParsedFsm,
  type ResolvedFsmLayoutMode,
};

const LAYOUT_OPTIONS: Array<{ value: FsmLayoutMode; zh: string; en: string }> = [
  { value: 'auto', zh: '自动', en: 'Auto' },
  { value: 'ring', zh: '环形', en: 'Ring' },
  { value: 'layered', zh: '分层', en: 'Layered' },
];

export function FsmDiagram({ source }: { source: string }) {
  const { L } = useI18n();
  const [showRaw, setShowRaw] = useState(false);
  const [layoutMode, setLayoutMode] = useState<FsmLayoutMode>('auto');
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [hoveredEdge, setHoveredEdge] = useState<string | null>(null);
  const [elkOverride, setElkOverride] = useState<{ key: string; layout: FsmLayout } | null>(null);

  const rawMarkerId = useId();
  const markerPrefix = `fsm-arrow-${rawMarkerId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const primaryMarkerId = `${markerPrefix}-primary`;
  const secondaryMarkerId = `${markerPrefix}-secondary`;
  const accentMarkerId = `${markerPrefix}-accent`;

  const parsed = useMemo(() => parseMermaidStateDiagram(source), [source]);
  const syncLayout = useMemo(
    () => (parsed ? layoutFsm(parsed, layoutMode) : null),
    [parsed, layoutMode],
  );

  const elkKey = parsed ? `${source}\0${layoutMode}` : '';
  const shouldUseElk = Boolean(
    parsed &&
      syncLayout &&
      syncLayout.mode === 'layered' &&
      parsed.nodes.length >= 7 &&
      typeof Worker !== 'undefined',
  );

  useEffect(() => {
    if (!shouldUseElk || !parsed) return;
    let active = true;
    layoutFsmWithElk(parsed)
      .then((next) => {
        if (active) setElkOverride({ key: elkKey, layout: next });
      })
      .catch(() => {
        // Keep synchronous layered fallback if ELK worker is unavailable.
      });
    return () => {
      active = false;
    };
  }, [shouldUseElk, parsed, elkKey]);

  const layout =
    shouldUseElk && elkOverride?.key === elkKey ? elkOverride.layout : syncLayout;

  if (!parsed || !layout || showRaw) {
    return (
      <div className="fsm-box">
        <div className="fsm-head">
          <span><GitBranch size={14} /> {L('状态转移图（FSM）', 'State Transition Diagram (FSM)')}</span>
          {parsed && (
            <button type="button" className="mini-action-btn" onClick={() => setShowRaw(false)}>
              {L('图形视图', 'Graph View')}
            </button>
          )}
        </div>
        <pre className="fsm-raw">{source}</pre>
      </div>
    );
  }

  const hasHover = hoveredNode !== null || hoveredEdge !== null;
  const activeEdgeObj = hoveredEdge ? layout.edges.find((e) => e.id === hoveredEdge) : undefined;

  const isEdgeHighlighted = (edge: LayoutEdge) => {
    if (hoveredEdge) return edge.id === hoveredEdge;
    if (hoveredNode) return edge.from === hoveredNode || edge.to === hoveredNode;
    return false;
  };

  const isNodeHighlighted = (nodeId: string) => {
    if (hoveredNode) return nodeId === hoveredNode;
    if (activeEdgeObj) return nodeId === activeEdgeObj.from || nodeId === activeEdgeObj.to;
    return false;
  };

  const scrollable = layout.width > 1200;

  return (
    <div className="fsm-box">
      <div className="fsm-head">
        <span>
          <GitBranch size={14} />{' '}
          {L(`状态转移图（${parsed.nodes.length} 个状态）`, `State Transition Diagram (${parsed.nodes.length} states)`)}
        </span>
        <div className="fsm-head-actions">
          {parsed.nodes.length >= 3 && (
            <div className="fsm-mode-switch" role="group" aria-label={L('状态图布局方式', 'FSM layout mode')}>
              {LAYOUT_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className={layoutMode === opt.value ? 'active' : undefined}
                  aria-pressed={layoutMode === opt.value}
                  onClick={() => setLayoutMode(opt.value)}
                >
                  {L(opt.zh, opt.en)}
                </button>
              ))}
            </div>
          )}
          <button type="button" className="mini-action-btn" onClick={() => setShowRaw(true)}>
            <Code2 size={12} /> {L('Mermaid 源码', 'Mermaid Source')}
          </button>
        </div>
      </div>
      <div className="fsm-canvas">
        <svg
          width={scrollable ? Math.round(layout.width * 0.9) : layout.width}
          height={scrollable ? Math.round(layout.height * 0.9) : layout.height}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          className={scrollable ? 'fsm-svg-scroll' : undefined}
          role="img"
          aria-label={L('有限状态机转移图', 'Finite state machine diagram')}
          onMouseLeave={() => {
            setHoveredNode(null);
            setHoveredEdge(null);
          }}
        >
          <defs>
            <marker
              id={primaryMarkerId}
              viewBox="0 0 10 10"
              refX="8.2"
              refY="5"
              markerWidth="6.5"
              markerHeight="6.5"
              orient="auto"
            >
              <path d="M 0 1.4 L 9.2 5 L 0 8.6 z" className="fsm-arrow-primary" />
            </marker>
            <marker
              id={secondaryMarkerId}
              viewBox="0 0 10 10"
              refX="8.2"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto"
            >
              <path d="M 0 1.6 L 9 5 L 0 8.4 z" className="fsm-arrow-secondary" />
            </marker>
            <marker
              id={accentMarkerId}
              viewBox="0 0 10 10"
              refX="8.2"
              refY="5"
              markerWidth="6.8"
              markerHeight="6.8"
              orient="auto"
            >
              <path d="M 0 1.3 L 9.2 5 L 0 8.7 z" className="fsm-arrow-accent" />
            </marker>
          </defs>

          {layout.startMarker && (
            <g className={`fsm-start${hasHover && !isNodeHighlighted(parsed.initial ?? '') ? ' dimmed' : ''}`}>
              <circle cx={layout.startMarker.cx} cy={layout.startMarker.cy} r="5" />
              <line
                x1={layout.startMarker.x1}
                y1={layout.startMarker.y1}
                x2={layout.startMarker.x2}
                y2={layout.startMarker.y2}
                markerEnd={`url(#${accentMarkerId})`}
              />
            </g>
          )}

          <g className="fsm-edges-paths">
            {layout.edges.map((edge) => {
              const highlighted = isEdgeHighlighted(edge);
              const dimmed = hasHover && !highlighted;
              const marker = highlighted
                ? accentMarkerId
                : edge.kind === 'primary'
                  ? primaryMarkerId
                  : secondaryMarkerId;
              return (
                <g
                  key={edge.id}
                  className={`fsm-edge-group${highlighted ? ' active' : ''}${dimmed ? ' dimmed' : ''}`}
                  onMouseEnter={() => setHoveredEdge(edge.id)}
                  onMouseLeave={() => setHoveredEdge(null)}
                >
                  <title>{edge.fullLabel ? `${edge.from} → ${edge.to}: ${edge.fullLabel}` : `${edge.from} → ${edge.to}`}</title>
                  <path d={edge.path} className="fsm-edge-hit" />
                  <path
                    d={edge.path}
                    className={`fsm-edge-path fsm-edge-${edge.kind}`}
                    markerEnd={`url(#${marker})`}
                  />
                </g>
              );
            })}
          </g>

          <g className="fsm-edges-labels">
            {layout.edges.map((edge) => {
              if (!edge.label) return null;
              const highlighted = isEdgeHighlighted(edge);
              const dimmed = hasHover && !highlighted;
              return (
                <g
                  key={edge.id}
                  className={`fsm-edge-label${highlighted ? ' active' : ''}${dimmed ? ' dimmed' : ''}`}
                  onMouseEnter={() => setHoveredEdge(edge.id)}
                  onMouseLeave={() => setHoveredEdge(null)}
                >
                  <title>{`${edge.from} → ${edge.to}: ${edge.fullLabel}`}</title>
                  <rect
                    x={edge.labelX - edge.pillWidth / 2}
                    y={edge.labelY - edge.pillHeight / 2}
                    width={edge.pillWidth}
                    height={edge.pillHeight}
                    rx="6"
                    className="fsm-label-bg"
                  />
                  <text
                    x={edge.labelX}
                    y={edge.labelY}
                    textAnchor="middle"
                    dominantBaseline="central"
                  >
                    {edge.label}
                  </text>
                </g>
              );
            })}
          </g>

          <g className="fsm-nodes">
            {layout.nodes.map((node) => {
              const highlighted = isNodeHighlighted(node.id);
              const dimmed = hasHover && !highlighted;
              return (
                <g
                  key={node.id}
                  className={`fsm-node${node.isInitial ? ' initial' : ''}${node.isTerminal ? ' terminal' : ''}${highlighted ? ' active' : ''}${dimmed ? ' dimmed' : ''}`}
                  transform={`translate(${node.x - node.width / 2} ${node.y - node.height / 2})`}
                  onMouseEnter={() => setHoveredNode(node.id)}
                  onMouseLeave={() => setHoveredNode(null)}
                >
                  <rect width={node.width} height={node.height} rx="10" />
                  {node.isTerminal && (
                    <rect
                      x="3.5"
                      y="3.5"
                      width={node.width - 7}
                      height={node.height - 7}
                      rx="7"
                      className="fsm-node-inner"
                    />
                  )}
                  <text
                    x={node.width / 2}
                    y={node.height / 2}
                    textAnchor="middle"
                    dominantBaseline="central"
                  >
                    {node.label}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>
      </div>
    </div>
  );
}
