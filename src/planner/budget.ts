import type { BudgetConfig, Usage } from './types.js';

export class Budget {
  private reads = 0;
  private bytes = 0;
  private readonly startedAt = Date.now();
  private totalUsage: Usage = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };

  private maxFileReadsAllowed: number;
  private maxContextBytesAllowed: number;
  private maxWallSeconds: number;
  private maxCostUsdCeiling?: number;

  constructor(public readonly cfg: BudgetConfig) {
    this.maxFileReadsAllowed = cfg.maxFileReads;
    this.maxContextBytesAllowed = cfg.maxContextBytes;
    this.maxWallSeconds = cfg.maxDurationSeconds;
    this.maxCostUsdCeiling = cfg.maxCostUsd;
  }

  /** Add another slice of the original config limits (used when the user chooses to continue a planner session). */
  extendSession(): void {
    this.maxFileReadsAllowed += this.cfg.maxFileReads;
    this.maxContextBytesAllowed += this.cfg.maxContextBytes;
    this.maxWallSeconds += this.cfg.maxDurationSeconds;
    if (this.cfg.maxCostUsd !== undefined) {
      this.maxCostUsdCeiling = (this.maxCostUsdCeiling ?? 0) + this.cfg.maxCostUsd;
    }
  }

  canRead(nextFileBytes: number): { ok: boolean; reason?: string } {
    if (this.reads >= this.maxFileReadsAllowed) {
      return { ok: false, reason: `max file reads (${this.maxFileReadsAllowed}) reached` };
    }
    if (this.bytes + nextFileBytes > this.maxContextBytesAllowed) {
      return { ok: false, reason: `context budget (${this.maxContextBytesAllowed} bytes) would be exceeded` };
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
    return (Date.now() - this.startedAt) / 1000 > this.maxWallSeconds;
  }

  overCost(): boolean {
    if (this.maxCostUsdCeiling === undefined) return false;
    return (this.totalUsage.costUsd ?? 0) > this.maxCostUsdCeiling;
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
