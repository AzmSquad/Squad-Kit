/**
 * Reads a Mermaid flowchart (`flowchart LR`, `graph TD`) into boxes and arrows, and places them in columns, so the
 * chat can draw a diagram in its own colors without a large drawing library. Other kinds of diagram return null and
 * show as text.
 */

export type Shape = 'box' | 'round' | 'decision';

export interface FlowNode {
  id: string;
  text: string;
  shape: Shape;
  /** The column (left to right) or row (top to bottom) it sits in. */
  rank: number;
  /** Its place inside that column or row. */
  slot: number;
}

export interface FlowEdge {
  from: string;
  to: string;
  label?: string;
  dashed?: boolean;
}

export interface Flowchart {
  across: boolean;
  nodes: FlowNode[];
  edges: FlowEdge[];
}

const HEAD = /^\s*(?:flowchart|graph)\s*(LR|RL|TD|TB|BT)?\s*;?\s*$/i;
const NODE = /^([A-Za-z0-9_؀-ۿ-]+)\s*(\[\[(.+?)\]\]|\(\[(.+?)\]\)|\(\((.+?)\)\)|\[(.+?)\]|\((.+?)\)|\{(.+?)\}|>(.+?)\])?/;
const LINK = /^\s*(-->|---|-\.->|-\.-|==>|===|--\s*(.+?)\s*-->|-\.\s*(.+?)\s*\.->|==\s*(.+?)\s*==>)\s*(?:\|(.+?)\|)?\s*/;

function clean(t: string): string {
  return t.replace(/^["']|["']$/g, '').replace(/<br\s*\/?>/gi, ' ').trim();
}

export function parseFlowchart(src: string): Flowchart | null {
  const lines = src.split('\n').map((l) => l.replace(/%%.*$/, '').trim()).filter(Boolean);
  const head = lines.shift()?.match(HEAD);
  if (!head) return null;
  const dir = (head[1] ?? 'TD').toUpperCase();
  const nodes = new Map<string, { id: string; text: string; shape: Shape }>();
  const edges: FlowEdge[] = [];
  const node = (raw: string): { id: string; rest: string } | null => {
    const m = raw.match(NODE);
    if (!m) return null;
    const id = m[1]!;
    const text = m[3] ?? m[4] ?? m[5] ?? m[6] ?? m[7] ?? m[8] ?? m[9];
    const shape: Shape = m[8] ? 'decision' : m[6] || m[3] ? 'box' : text ? 'round' : 'box';
    const had = nodes.get(id);
    if (!had || text) nodes.set(id, { id, text: clean(text ?? had?.text ?? id), shape: text ? shape : (had?.shape ?? shape) });
    return { id, rest: raw.slice(m[0].length) };
  };
  for (const line of lines) {
    if (/^(classDef|class|style|linkStyle|click|subgraph|end|direction)\b/.test(line)) continue;
    for (const stmt of line.split(';').map((s) => s.trim()).filter(Boolean)) {
      let cur = node(stmt);
      if (!cur) continue;
      let rest = cur.rest;
      for (;;) {
        const l = rest.match(LINK);
        if (!l) break;
        const next = node(rest.slice(l[0].length));
        if (!next) break;
        const label = clean(l[5] ?? l[2] ?? l[3] ?? l[4] ?? '');
        edges.push({ from: cur.id, to: next.id, ...(label ? { label } : {}), ...(l[1]!.includes('.') ? { dashed: true } : {}) });
        cur = next;
        rest = next.rest;
      }
    }
  }
  if (!nodes.size) return null;
  // Longest path from the starts, so every arrow points forward. Loops stop after one pass per node.
  const rank = new Map<string, number>([...nodes.keys()].map((k) => [k, 0]));
  for (let pass = 0; pass < nodes.size; pass += 1) {
    let moved = false;
    for (const e of edges) {
      if (e.from === e.to) continue;
      const want = (rank.get(e.from) ?? 0) + 1;
      if (want > (rank.get(e.to) ?? 0) && want < nodes.size) {
        rank.set(e.to, want);
        moved = true;
      }
    }
    if (!moved) break;
  }
  const slots = new Map<number, number>();
  const placed: FlowNode[] = [...nodes.values()].map((n) => {
    const r = rank.get(n.id) ?? 0;
    const slot = slots.get(r) ?? 0;
    slots.set(r, slot + 1);
    return { ...n, rank: r, slot };
  });
  const flip = dir === 'RL' || dir === 'BT';
  const max = Math.max(...placed.map((n) => n.rank));
  return { across: dir === 'LR' || dir === 'RL', nodes: flip ? placed.map((n) => ({ ...n, rank: max - n.rank })) : placed, edges };
}
