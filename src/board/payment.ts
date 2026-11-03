import { paymentChoice } from '../core/settings.js';
import { readAgent } from '../engine/agents.js';
import type { AiTool, Billing } from '../modules/ai-tool/types.js';
import { AI_TOOLS, aiTool } from '../modules/registry.js';
import type { BoardPaths } from './store.js';
import type { Payment } from './types.js';

/**
 * How the person pays for the AI that runs the squad. It decides what the Cost tab says: on a subscription the work
 * costs nothing extra, so the dollars are the value of the work at API prices; on an API key they are real money, with
 * budgets. The AI tool module finds out without running a model; the person's own answer in Settings wins.
 */

export interface PaymentInfo {
  payment: Payment;
  /** you: set in Settings. found: the AI tool said. guess: it could not tell, so squad-kit assumes a subscription. */
  from: 'you' | 'found' | 'guess';
  /** What the AI tool found, for Settings: "Claude Pro", "Anthropic API key". */
  found: Billing | null;
  /** The AI tool, for people: "Claude Code". */
  tool: string;
  /** Whose plan, for the words on the page: "Claude". */
  name: string;
}

/** A finding is kept for 10 minutes: a new login is seen soon, and no page waits on the tool twice a minute. */
const KEEP_MS = 10 * 60_000;
const found = new Map<string, { at: number; value: Promise<Billing | null> }>();

function detect(tool: AiTool, now: number): Promise<Billing | null> {
  const seen = found.get(tool.name);
  if (seen && now - seen.at < KEEP_MS) return seen.value;
  const value = (tool.billing?.() ?? Promise.resolve(null)).catch(() => null);
  found.set(tool.name, { at: now, value });
  return value;
}

/** Forget what was found, so the next look asks the tool again (after a new login, and in tests). */
export function forgetPayment(): void {
  found.clear();
}

/** The AI tool the Builder runs on: the one that does most of the work. */
function builderTool(bp: BoardPaths): AiTool | undefined {
  try {
    return aiTool(readAgent(bp, 'builder').tool);
  } catch {
    return AI_TOOLS[0];
  }
}

/** How the person pays: their own answer in Settings, else what the Builder's AI tool says, else a subscription. */
export async function howPaid(bp: BoardPaths, opts: { tool?: AiTool; now?: number } = {}): Promise<PaymentInfo> {
  const tool = opts.tool ?? builderTool(bp);
  const choice = paymentChoice();
  const billing = tool ? await detect(tool, opts.now ?? Date.now()) : null;
  const payment: Payment = choice ?? billing?.kind ?? 'subscription';
  return { payment, from: choice ? 'you' : billing ? 'found' : 'guess', found: billing, tool: tool?.label ?? 'AI tool', name: tool?.plan ?? tool?.label ?? 'AI' };
}
