import fs from 'node:fs';
import path from 'node:path';

const STORY_FILE = /^(\d{2,})-story-.+\.md$/;

export interface SequenceScan {
  usedNumbers: number[];
  maxNumber: number;
  duplicates: number[];
  nextGlobal: number;
}

export function scanPlans(plansDir: string): SequenceScan {
  const used: number[] = [];
  const seen = new Map<number, number>();

  if (fs.existsSync(plansDir)) {
    for (const feature of fs.readdirSync(plansDir, { withFileTypes: true })) {
      if (!feature.isDirectory()) continue;
      const featureDir = path.join(plansDir, feature.name);
      for (const entry of fs.readdirSync(featureDir)) {
        const match = entry.match(STORY_FILE);
        if (!match) continue;
        const n = parseInt(match[1]!, 10);
        used.push(n);
        seen.set(n, (seen.get(n) ?? 0) + 1);
      }
    }
  }

  const duplicates = [...seen.entries()].filter(([, c]) => c > 1).map(([n]) => n);
  const maxNumber = used.length ? Math.max(...used) : 0;
  return { usedNumbers: used.sort((a, b) => a - b), maxNumber, duplicates, nextGlobal: maxNumber + 1 };
}

export function formatSequence(n: number): string {
  return String(n).padStart(2, '0');
}
