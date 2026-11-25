import { describe, expect, it } from 'vitest';
import { PRESETS } from '../src/agent/presets';
import {
  layoutFsm,
  parseMermaidStateDiagram,
  type FsmLayout,
  type FsmLayoutMode,
} from '../src/components/FsmDiagram';

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function boxesOverlap(a: Box, b: Box): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function assertCleanLayout(layout: FsmLayout, context: string) {
  const nodeBoxes: Box[] = layout.nodes.map((n) => ({
    left: n.x - n.width / 2,
    right: n.x + n.width / 2,
    top: n.y - n.height / 2,
    bottom: n.y + n.height / 2,
  }));

  for (let i = 0; i < nodeBoxes.length; i++) {
    expect(nodeBoxes[i].left, `${context} node[${i}] left`).toBeGreaterThanOrEqual(0);
    expect(nodeBoxes[i].right, `${context} node[${i}] right`).toBeLessThanOrEqual(layout.width);
    expect(nodeBoxes[i].top, `${context} node[${i}] top`).toBeGreaterThanOrEqual(0);
    expect(nodeBoxes[i].bottom, `${context} node[${i}] bottom`).toBeLessThanOrEqual(layout.height);
    for (let j = i + 1; j < nodeBoxes.length; j++) {
      expect(boxesOverlap(nodeBoxes[i], nodeBoxes[j]), `${context} node overlap ${i}/${j}`).toBe(false);
    }
  }

  const labelBoxes: Array<{ id: string; box: Box }> = layout.edges
    .filter((e) => e.label && e.pillWidth > 0)
    .map((e) => ({
      id: `${e.from}->${e.to}(${e.label})`,
      box: {
        left: e.labelX - e.pillWidth / 2,
        right: e.labelX + e.pillWidth / 2,
        top: e.labelY - e.pillHeight / 2,
        bottom: e.labelY + e.pillHeight / 2,
      },
    }));

  const startBox: Box | undefined = layout.startMarker
    ? {
        left: Math.min(layout.startMarker.cx - 5, layout.startMarker.x2),
        right: Math.max(layout.startMarker.cx + 5, layout.startMarker.x2),
        top: Math.min(layout.startMarker.cy - 5, layout.startMarker.y2),
        bottom: Math.max(layout.startMarker.cy + 5, layout.startMarker.y2),
      }
    : undefined;

  for (let i = 0; i < labelBoxes.length; i++) {
    const a = labelBoxes[i];
    expect(a.box.left, `${context} ${a.id} left`).toBeGreaterThanOrEqual(0);
    expect(a.box.right, `${context} ${a.id} right`).toBeLessThanOrEqual(layout.width);
    expect(a.box.top, `${context} ${a.id} top`).toBeGreaterThanOrEqual(0);
    expect(a.box.bottom, `${context} ${a.id} bottom`).toBeLessThanOrEqual(layout.height);

    for (const nodeBox of nodeBoxes) {
      expect(boxesOverlap(a.box, nodeBox), `${context} ${a.id} overlaps node`).toBe(false);
    }
    if (startBox) {
      expect(boxesOverlap(a.box, startBox), `${context} ${a.id} overlaps startMarker`).toBe(false);
    }
    for (let j = i + 1; j < labelBoxes.length; j++) {
      const b = labelBoxes[j];
      expect(boxesOverlap(a.box, b.box), `${context} ${a.id} overlaps ${b.id}`).toBe(false);
    }
  }
}

describe('FsmDiagram topology-adaptive layout & curved routing', () => {
  it('merges duplicate parallel edges between the same state pair', () => {
    const parsed = parseMermaidStateDiagram(`stateDiagram-v2
      [*] --> RED
      RED --> GREEN: timer==1
      GREEN --> YELLOW: timer==1
      YELLOW --> RED: timer==1
      GREEN --> RED: KEY0
      YELLOW --> RED: KEY0`);

    expect(parsed).not.toBeNull();
    expect(parsed!.nodes).toEqual(['RED', 'GREEN', 'YELLOW']);
    const yellowToRed = parsed!.edges.filter((e) => e.from === 'YELLOW' && e.to === 'RED');
    expect(yellowToRed).toHaveLength(1);
    expect(yellowToRed[0].label).toBe('timer==1 / KEY0');

    const layout = layoutFsm(parsed!, 'auto');
    expect(layout.mode).toBe('ring');
    // 3 cyclic states form a 2D triangle rather than a single horizontal line.
    const distinctYs = new Set(layout.nodes.map((n) => Math.round(n.y)));
    expect(distinctYs.size).toBeGreaterThanOrEqual(2);
    assertCleanLayout(layout, 'traffic-auto');
  });

  it('supports state aliases, acyclic layered skip-edges, and terminal states', () => {
    const parsed = parseMermaidStateDiagram(`stateDiagram-v2
      state "等待" as S0
      [*] --> S0
      S0 --> S1: start
      S1 --> S2: step
      S0 --> S2: fast_skip
      S2 --> [*]`);

    expect(parsed).not.toBeNull();
    expect(parsed!.nodeLabels.S0).toBe('等待');
    expect(parsed!.terminals).toEqual(['S2']);

    const layout = layoutFsm(parsed!, 'auto');
    expect(layout.mode).toBe('layered');
    const skipEdge = layout.edges.find((e) => e.from === 'S0' && e.to === 'S2');
    expect(skipEdge).toBeDefined();
    assertCleanLayout(layout, 'acyclic-dag');
  });

  it('auto-selects layered layout for complex >=7-state branching FSMs without overlaps', () => {
    const parsed = parseMermaidStateDiagram(`stateDiagram-v2
      [*] --> IDLE
      IDLE --> FETCH: start
      FETCH --> DECODE: ready
      DECODE --> ALU: op==0
      DECODE --> MEM: op==1
      DECODE --> BRANCH: op==2
      ALU --> WB: done
      MEM --> WB: ack
      BRANCH --> FETCH: taken
      WB --> IDLE: commit`);

    expect(parsed).not.toBeNull();
    const layout = layoutFsm(parsed!, 'auto');
    expect(layout.mode).toBe('layered');
    assertCleanLayout(layout, 'cpu-7-state-auto');

    const ringLayout = layoutFsm(parsed!, 'ring');
    expect(ringLayout.mode).toBe('ring');
    assertCleanLayout(ringLayout, 'cpu-7-state-ring');
  });

  const modes: FsmLayoutMode[] = ['auto', 'ring', 'layered'];

  for (const preset of PRESETS) {
    for (const mode of modes) {
      it(`renders "${preset.name}" (${mode}) without overlapping labels, nodes, or out-of-bounds elements`, () => {
        const parsed = parseMermaidStateDiagram(preset.blueprint.mermaidFsm);
        expect(parsed).not.toBeNull();
        const layout = layoutFsm(parsed!, mode);

        if (mode === 'auto' && parsed!.nodes.length >= 3 && parsed!.nodes.length <= 6) {
          expect(layout.mode).toBe('ring');
          const distinctYs = new Set(layout.nodes.map((n) => Math.round(n.y)));
          expect(distinctYs.size).toBeGreaterThanOrEqual(2);
        }

        assertCleanLayout(layout, `${preset.name}:${mode}`);
      });
    }
  }
});
