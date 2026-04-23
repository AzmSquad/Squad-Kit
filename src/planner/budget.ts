import type { BudgetConfig, Usage } from './types.js';

export class Budget {
  private reads = 0;
  private bytes = 0;
  private readonly startedAt = Date.now();
  private totalUsage: Usage = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };

  constructor(public readonly cfg: BudgetConfig) {}

  canRead(nextFileBytes: number): { ok: boolean; reason?: string } {
    if (this.reads >= this.cfg.maxFileReads) {
      return { ok: false, reason: `max file reads (${this.cfg.maxFileReads}) reached` };
    }
    if (this.bytes + nextFileBytes > this.cfg.maxContextBytes) {
      return { ok: false, reason: `context budget (${this.cfg.maxContextBytes} bytes) would be exceeded` };
    }
    return { ok: true };
  }

  recordRead(bytes: number): void {
    this.reads += 1;
    this.bytes += bytes;
  }

  recordUsage(u: Usage): void {
    this.totalUsage.inputTokens += u.inputTokens;
    this.totalUsage.outputTokens += u.outputTokens;
    if (u.costUsd !== undefined) this.totalUsage.costUsd = (this.totalUsage.costUsd ?? 0) + u.costUsd;
    this.totalUsage.cacheCreationTokens = (this.totalUsage.cacheCreationTokens ?? 0) + (u.cacheCreationTokens ?? 0);
    this.totalUsage.cacheReadTokens = (this.totalUsage.cacheReadTokens ?? 0) + (u.cacheReadTokens ?? 0);
  }

  timedOut(): boolean {
    return (Date.now() - this.startedAt) / 1000 > this.cfg.maxDurationSeconds;
  }

  overCost(): boolean {
    if (this.cfg.maxCostUsd === undefined) return false;
    return (this.totalUsage.costUsd ?? 0) > this.cfg.maxCostUsd;
  }

  snapshot() {
    return {
      reads: this.reads,
      bytes: this.bytes,
      elapsedMs: Date.now() - this.startedAt,
      usage: { ...this.totalUsage },
    };
  }
}
