import { describe, it, expect } from 'vitest';
import { withIpv4First } from '../src/engine/claude.js';

describe('withIpv4First', () => {
  it('makes Node tools use IPv4 only, keeping other options', () => {
    expect(withIpv4First({ NODE_OPTIONS: '--max-old-space-size=4096' }).NODE_OPTIONS).toBe(
      '--max-old-space-size=4096 --dns-result-order=ipv4first --no-network-family-autoselection',
    );
  });

  it('does not add the options twice', () => {
    const once = withIpv4First({});
    expect(withIpv4First(once).NODE_OPTIONS).toBe(once.NODE_OPTIONS);
  });
});
