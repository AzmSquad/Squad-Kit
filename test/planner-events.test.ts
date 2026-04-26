import { describe, it, expect, vi } from 'vitest';
import { PlannerEventBus } from '../src/planner/events.js';

describe('PlannerEventBus', () => {
  it('subscribe returns an unsubscribe that removes the listener', () => {
    const bus = new PlannerEventBus();
    const fn = vi.fn();
    const off = bus.subscribe(fn);
    bus.emit({
      kind: 'started',
      runId: 'r1',
      provider: 'anthropic',
      model: 'm',
      cacheEnabled: true,
    });
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    bus.emit({
      kind: 'started',
      runId: 'r2',
      provider: 'anthropic',
      model: 'm',
      cacheEnabled: true,
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a throwing listener does not block other listeners', () => {
    const bus = new PlannerEventBus();
    const a = vi.fn(() => {
      throw new Error('boom');
    });
    const b = vi.fn();
    bus.subscribe(a);
    bus.subscribe(b);
    bus.emit({
      kind: 'started',
      runId: 'r',
      provider: 'anthropic',
      model: 'm',
      cacheEnabled: true,
    });
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('emit is synchronous', () => {
    const bus = new PlannerEventBus();
    const order: string[] = [];
    bus.subscribe(() => order.push('a'));
    bus.subscribe(() => order.push('b'));
    bus.emit({
      kind: 'started',
      runId: 'r',
      provider: 'anthropic',
      model: 'm',
      cacheEnabled: true,
    });
    expect(order).toEqual(['a', 'b']);
  });
});
