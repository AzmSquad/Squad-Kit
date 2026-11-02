import { describe, expect, it } from 'vitest';
import { parseFlowchart } from '../console-ui/src/lib/flowchart.js';

describe('a diagram written as text', () => {
  it('reads boxes, a decision and labelled arrows, and places them in columns', () => {
    const f = parseFlowchart(`flowchart LR
  A[Mawid sends a message] --> B{Test mode on?}
  B -->|yes| C(Save to Outbox)
  B -- no --> D[Send for real]
  %% a comment`)!;
    expect(f.across).toBe(true);
    expect(f.nodes.map((n) => [n.id, n.text, n.shape, n.rank, n.slot])).toEqual([
      ['A', 'Mawid sends a message', 'box', 0, 0],
      ['B', 'Test mode on?', 'decision', 1, 0],
      ['C', 'Save to Outbox', 'round', 2, 0],
      ['D', 'Send for real', 'box', 2, 1],
    ]);
    expect(f.edges).toEqual([
      { from: 'A', to: 'B' },
      { from: 'B', to: 'C', label: 'yes' },
      { from: 'B', to: 'D', label: 'no' },
    ]);
  });

  it('follows chains, keeps loops finite and runs top to bottom by default', () => {
    const f = parseFlowchart('graph\n  a --> b --> c\n  c -.-> a')!;
    expect(f.across).toBe(false);
    expect(f.nodes.map((n) => n.rank)).toEqual([0, 1, 2]);
    expect(f.edges.at(-1)).toEqual({ from: 'c', to: 'a', dashed: true });
  });

  it('leaves other kinds of diagram as text', () => {
    expect(parseFlowchart('sequenceDiagram\n  A->>B: hi')).toBeNull();
    expect(parseFlowchart('flowchart LR')).toBeNull();
  });
});
