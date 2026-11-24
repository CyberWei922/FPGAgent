import { Maximize, Minus, Plus, Workflow } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { NetlistGraph } from '../types/contracts';
import { GateSymbol, signalValue } from './GateSymbol';
import { layoutSchematic, schematicTopology, type SchematicLayout } from './schematicLayout';

interface Offset { x: number; y: number }
interface Camera { zoom: number; offset: Offset }
interface Finger extends Offset { type: string }
interface Gesture { camera: Camera; center: Offset; distance: number }

const CENTER: Offset = { x: 0, y: 0 };
const FIT_CAMERA: Camera = { zoom: 100, offset: CENTER };
const MIN_ZOOM = 75;
const MAX_ZOOM = 500;
const RESISTANCE = .42;
const BOUNCE_LENGTH = 190;

function travel(viewport: number, fitted: number, zoom: number): number {
  return Math.max(0, fitted * (zoom / 100 - 1) / 2) + Math.min(48, viewport * .13);
}

function bounded(value: number, limit: number): number {
  return Math.max(-limit, Math.min(limit, value));
}

function rubberBand(value: number, limit: number): number {
  const edge = bounded(value, limit);
  const excess = value - edge;
  return edge + excess * RESISTANCE / (1 + Math.abs(excess) / BOUNCE_LENGTH);
}

function undoRubberBand(value: number, limit: number): number {
  const edge = bounded(value, limit);
  const excess = value - edge;
  return edge + excess / Math.max(.02, RESISTANCE - Math.abs(excess) / BOUNCE_LENGTH);
}

function anchorZoom(camera: Camera, requestedZoom: number, start: Offset, end: Offset = start): Camera {
  const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, requestedZoom));
  const ratio = zoom / camera.zoom;
  return {
    zoom,
    offset: { x: end.x + (camera.offset.x - start.x) * ratio, y: end.y + (camera.offset.y - start.y) * ratio },
  };
}

function localPoint(element: HTMLElement, point: Offset): Offset {
  const box = element.getBoundingClientRect();
  return { x: point.x - box.left - box.width / 2, y: point.y - box.top - box.height / 2 };
}

function gestureGeometry(element: HTMLElement, fingers: Map<number, Finger>) {
  const [first, second] = fingers.values();
  if (!first) return null;
  if (!second) return { center: localPoint(element, first), distance: 0 };
  const midpoint = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
  return { center: localPoint(element, midpoint), distance: Math.max(1, Math.hypot(second.x - first.x, second.y - first.y)) };
}

function SchematicViewport({ layout, netlist }: { layout: SchematicLayout; netlist: NetlistGraph }) {
  const viewport = useRef<HTMLDivElement>(null);
  const world = useRef<HTMLDivElement>(null);
  const fingers = useRef(new Map<number, Finger>());
  const gesture = useRef<Gesture | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [camera, setCamera] = useState(FIT_CAMERA);
  const [moving, setMoving] = useState(false);
  const [spring, setSpring] = useState(false);
  const cameraRef = useRef(FIT_CAMERA);
  const springRef = useRef(false);
  const { zoom, offset: pan } = camera;

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    function measure() {
      const bounds = element!.getBoundingClientRect();
      setSize({ width: bounds.width, height: bounds.height });
    }
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const fit = Math.max(.02, Math.min((size.width - 32) / layout.width, (size.height - 58) / layout.height, 1.35));
  const fittedWidth = layout.width * fit;
  const fittedHeight = layout.height * fit;
  const drawing = { width: fittedWidth * zoom / 100, height: fittedHeight * zoom / 100 };
  const limitsAt = useCallback((atZoom: number) => ({
    x: travel(size.width, fittedWidth, atZoom),
    y: travel(size.height, fittedHeight, atZoom),
  }), [size.width, size.height, fittedWidth, fittedHeight]);

  const position = useCallback((next: Camera, animate = false) => {
    cameraRef.current = next;
    springRef.current = animate;
    setSpring(animate);
    setCamera(next);
  }, []);

  const visualCamera = useCallback((): Camera => {
    const current = cameraRef.current;
    const transform = springRef.current && world.current && getComputedStyle(world.current).transform;
    if (!transform || transform === 'none') return current;
    const matrix = new DOMMatrixReadOnly(transform);
    return { zoom: current.zoom, offset: { x: matrix.m41, y: matrix.m42 } };
  }, []);

  const constrain = useCallback((next: Camera, constrainAxis = bounded): Camera => {
    const limit = limitsAt(next.zoom);
    return { zoom: next.zoom, offset: { x: constrainAxis(next.offset.x, limit.x), y: constrainAxis(next.offset.y, limit.y) } };
  }, [limitsAt]);

  useLayoutEffect(() => {
    if (!fingers.current.size) position(constrain(cameraRef.current));
  }, [constrain, position]);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    function wheel(event: WheelEvent) {
      if (!event.deltaY || fingers.current.size) return;
      event.preventDefault();
      const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? size.height : 1;
      const delta = Math.max(-160, Math.min(160, event.deltaY * scale));
      const current = visualCamera();
      const point = localPoint(element!, { x: event.clientX, y: event.clientY });
      position(constrain(anchorZoom(current, current.zoom * Math.exp(-delta * .0025), point)));
    }
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [constrain, position, size.height, visualCamera]);

  function resetGesture(element: HTMLElement, current: Camera) {
    const contact = gestureGeometry(element, fingers.current);
    gesture.current = contact ? { ...contact, camera: constrain(current, undoRubberBand) } : null;
  }

  function begin(event: PointerEvent<HTMLDivElement>) {
    const active = fingers.current;
    if (event.button !== 0 || active.size >= 2 || active.has(event.pointerId)) return;
    if (active.size && (event.pointerType !== 'touch' || active.values().next().value?.type !== 'touch')) return;
    if (!active.size) event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    const current = visualCamera();
    active.set(event.pointerId, { x: event.clientX, y: event.clientY, type: event.pointerType });
    resetGesture(event.currentTarget, current);
    position(current);
    setMoving(true);
  }

  function move(event: PointerEvent<HTMLDivElement>) {
    const start = gesture.current;
    if (!start || !fingers.current.has(event.pointerId)) return;
    fingers.current.set(event.pointerId, { x: event.clientX, y: event.clientY, type: event.pointerType });
    const contact = gestureGeometry(event.currentTarget, fingers.current);
    if (!contact) return;
    const ratio = start.distance ? contact.distance / start.distance : 1;
    position(constrain(anchorZoom(start.camera, start.camera.zoom * ratio, start.center, contact.center), rubberBand));
  }

  function finish(event: PointerEvent<HTMLDivElement>) {
    if (!fingers.current.delete(event.pointerId)) return;
    const current = cameraRef.current;
    resetGesture(event.currentTarget, current);
    if (fingers.current.size) return;
    setMoving(false);
    const next = constrain(current);
    position(next, next.offset.x !== current.offset.x || next.offset.y !== current.offset.y);
  }

  function zoomBy(delta: number) {
    const current = visualCamera();
    position(constrain(anchorZoom(current, current.zoom + delta, CENTER)));
  }

  function fitToScreen() {
    position(FIT_CAMERA);
  }

  function keyboardPan(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 64 : 20;
    const directions: Record<string, Offset> = {
      ArrowLeft: { x: -step, y: 0 }, ArrowRight: { x: step, y: 0 },
      ArrowUp: { x: 0, y: -step }, ArrowDown: { x: 0, y: step },
    };
    if (event.key === 'Home') {
      event.preventDefault();
      fitToScreen();
    } else if (directions[event.key]) {
      event.preventDefault();
      const { x, y } = directions[event.key];
      const current = visualCamera();
      position(constrain({ zoom: current.zoom, offset: { x: current.offset.x + x, y: current.offset.y + y } }));
    }
  }

  const edgeById = new Map(netlist.edges.map((edge) => [edge.id, edge]));
  const nodeById = new Map(netlist.nodes.map((node) => [node.id, node]));
  return (
    <div className="gate-area">
      <div ref={viewport} className="gate-viewport" data-moving={moving} tabIndex={0} role="region" aria-label="门级图画布，可拖动、滚轮缩放或双指缩放"
        onPointerDown={begin} onPointerMove={move} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish} onKeyDown={keyboardPan}>
        <div ref={world} className="gate-world" data-spring={spring} style={{ transform: `translate(${pan.x}px, ${pan.y}px)` }}>
          <svg className="gate-chart" width={drawing.width} height={drawing.height} viewBox={`0 0 ${layout.width} ${layout.height}`} role="img" aria-label="电路门级网表">
            {layout.wires.map((wire) => {
              const edges = wire.edgeIds.flatMap((id) => edgeById.get(id) ?? []);
              const signal = edges[0];
              const high = (signal?.value ?? 0) > 0;
              return <g key={wire.id} className={high ? 'wire-high' : undefined} data-signal={signal?.signalName}>
                <path d={wire.path} className={`gate-wire${wire.width > 1 ? ' gate-bus' : ''}`}>
                  {signal && <title>{signal.signalName} = {signalValue(signal.value, wire.width)}</title>}
                </path>
                {high && edges.some((edge) => edge.changed) && <path d={wire.path} className="gate-wire wire-pulse" />}
                {wire.junctions.map(({ x, y }) => <circle className="gate-junction" key={`${x},${y}`} cx={x} cy={y} r={wire.width > 1 ? 3.4 : 2.8} />)}
              </g>;
            })}
            {layout.nodes.map((node) => <GateSymbol key={node.id} node={node} sample={nodeById.get(node.id)} />)}
          </svg>
        </div>
      </div>
      <div className="zoom-controls" role="group" aria-label="画布缩放">
        <button className="icon-button" aria-label="缩小" disabled={zoom <= MIN_ZOOM} onClick={() => zoomBy(-25)}><Minus size={15} /></button>
        <span>{Math.round(zoom)}%</span>
        <button className="icon-button" aria-label="放大" disabled={zoom >= MAX_ZOOM} onClick={() => zoomBy(25)}><Plus size={15} /></button>
        <button className="icon-button" aria-label="适合画布" title="适合画布" onClick={fitToScreen}><Maximize size={14} /></button>
      </div>
    </div>
  );
}

export function GateCanvas({ netlist, pending = false }: { netlist?: NetlistGraph; pending?: boolean }) {
  const topology = schematicTopology(netlist);
  const [rendered, setRendered] = useState<{ key: string; layout: SchematicLayout | null }>();

  useEffect(() => {
    if (!topology) return;
    let active = true;
    layoutSchematic(topology).then(
      (layout) => { if (active) setRendered({ key: topology, layout }); },
      () => { if (active) setRendered({ key: topology, layout: null }); },
    );
    return () => { active = false; };
  }, [topology]);

  const current = rendered?.key === topology ? rendered : undefined;
  if (!netlist || !current?.layout) {
    const message = current?.layout === null ? '门级图布局失败。板卡和波形仍可使用。'
      : topology ? '正在为电路布线…'
        : pending ? '正在准备电路和仿真数据…' : '电路通过编译后，这里会显示门级图。';
    return <div className="gate-blank" role="status"><Workflow size={34} strokeWidth={1.3} /><p>{message}</p></div>;
  }

  return (
    <>
      <SchematicViewport key={topology} layout={current.layout} netlist={netlist} />
      <div className="signal-caption"><span className="configured-dot" />{netlist.narration}</div>
    </>
  );
}
