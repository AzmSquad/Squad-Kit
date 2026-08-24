import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MetricsBar } from '~/components/generate/MetricsBar';
import type { GenerateRunState } from '~/hooks/useGenerateRun';

const base: GenerateRunState = {
  phase: 'streaming',
  runId: 'r',
  startedAtMs: Date.now(),
  feature: '',
  storyId: '',
  mode: 'api',
  runtime: null,
  stages: {
    scout: { phase: 'idle' },
    draft: { phase: 'idle' },
    validation: { phase: 'idle' },
  },
  tokens: { input: 200, output: 100, sum: 300, ceiling: 9000, perTurn: [] },
  cacheHitPct: null,
  cacheHitPctPerTurn: [],
  budget: { caps: null, fileReadsCompleted: 0, contextBytesApprox: 0 },
  tools: [],
  thinking: { blocks: [] },
  scout: { selected: null, reasoning: null },
  validation: [],
  assistantMd: '',
  planFile: null,
  rateLimit: null,
  multiTab: { count: 2 },
  activities: [],
  turn: 0,
  error: null,
  errorCode: null,
  auth: null,
};

describe('MetricsBar', () => {
  it('shows multi-tab badge when peers counted', () => {
    render(<MetricsBar state={base} elapsedSec={3} onCancel={() => {}} />);
    expect(screen.getByTestId('multi-tab-badge')).toHaveTextContent('+2');
  });

  it('shows token percentages from ceiling', () => {
    render(<MetricsBar state={base} elapsedSec={0} onCancel={() => {}} />);
    expect(screen.getByText('200')).toBeTruthy();
    expect(screen.getByText('100')).toBeTruthy();
  });
});
