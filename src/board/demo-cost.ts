import type { AgentUsage, ModelLevel } from '../modules/ai-tool/types.js';
import { aiTool } from '../modules/registry.js';
import { readAgent } from '../engine/agents.js';
import { DEFAULT_QUALITY, standardLevel } from '../engine/levels.js';
import type { BoardPaths } from './store.js';
import type { AgentName, Quality, Ticket, TimedStep } from './types.js';
import { addRun, addToMonth } from './usage.js';

/**
 * The sample squad counts what each of its steps would use, the way the live squad counts what its AI tool reports,
 * so the sample board's Cost tab and the averages per Quality setting have something real-looking to show.
 */

/** One sample step on the strongest model. Lighter levels use the same tokens at a lower price. */
const SAMPLE: Partial<Record<TimedStep, { input: number; cached: number; output: number; usd: number }>> = {
  questions: { input: 182_000, cached: 151_000, output: 3_100, usd: 0.46 },
  spec: { input: 96_000, cached: 88_000, output: 2_400, usd: 0.21 },
  design: { input: 248_000, cached: 205_000, output: 6_200, usd: 0.61 },
  build: { input: 1_420_000, cached: 1_290_000, output: 21_000, usd: 1.34 },
  fix: { input: 380_000, cached: 340_000, output: 5_800, usd: 0.41 },
  review: { input: 410_000, cached: 352_000, output: 3_900, usd: 0.47 },
  proof: { input: 133_000, cached: 101_000, output: 2_200, usd: 0.36 },
};

const PRICE: Record<ModelLevel, number> = { strongest: 1, balanced: 0.6, fast: 0.08 };

/** What one sample step uses, at the level the Quality setting gives it, and the key it is counted under. */
export function sampleUsage(bp: BoardPaths, t: Pick<Ticket, 'track'>, who: AgentName, step: TimedStep, quality: Quality, scale = 1) {
  const s = SAMPLE[step];
  if (!s) return null;
  const level = standardLevel({ role: who, step, quality, express: t.track === 'express' }).level ?? 'balanced';
  const tool = aiTool(readAgent(bp, who).tool);
  const usage: AgentUsage = {
    inputTokens: Math.round(s.input * scale),
    cachedTokens: Math.round(s.cached * scale),
    outputTokens: Math.round(s.output * scale),
    costUsd: Math.round(s.usd * PRICE[level] * scale * 100) / 100,
  };
  return { key: { role: who, step, level, model: tool?.modelFor(level) ?? '' }, usage };
}

/** A sample step ended: it is counted on the ticket and in the month, like a live run. */
export function countSampleStep(bp: BoardPaths, t: Ticket, who: AgentName | 'squad', step: TimedStep, quality: Quality | undefined, at = Date.now(), size = 1): void {
  if (who === 'squad') return;
  // Each run a little different, as real runs are.
  const scale = size * (0.8 + ((Number(t.id.replace(/\D/g, '')) * 7 + (t.history?.length ?? 0) * 13) % 9) / 20);
  const run = sampleUsage(bp, t, who, step, quality ?? DEFAULT_QUALITY, scale);
  if (!run) return;
  t.usage = addRun(t.usage, run.key, run.usage);
  t.quality = quality ?? DEFAULT_QUALITY;
  addToMonth(bp, run.usage, at);
}

/** A seeded sample ticket's past steps, counted as if the sample squad had run them. */
export function countSampleHistory(bp: BoardPaths, t: Ticket, size = 1): void {
  const runs = t.history ?? [];
  const quality = t.quality;
  t.history = [];
  for (const h of runs) {
    countSampleStep(bp, t, h.who, h.step, quality, Date.parse(h.to), size);
    t.history.push(h);
  }
}
