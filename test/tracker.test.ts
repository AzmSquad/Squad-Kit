import { describe, it, expect } from 'vitest';
import { validateTrackerId, trackerIdForFilename } from '../src/core/tracker.js';

describe('validateTrackerId', () => {
  it('accepts anything when tracker type is none', () => {
    expect(validateTrackerId('none', '')).toBe(true);
    expect(validateTrackerId('none', 'whatever')).toBe(true);
  });

  it('validates github ids (bare number or org/repo#n)', () => {
    expect(validateTrackerId('github', '123')).toBe(true);
    expect(validateTrackerId('github', 'my-org/my-repo#42')).toBe(true);
    expect(validateTrackerId('github', 'abc')).toBe(false);
  });

  it('validates linear ids', () => {
    expect(validateTrackerId('linear', 'ENG-123')).toBe(true);
    expect(validateTrackerId('linear', 'BUG-1')).toBe(true);
    expect(validateTrackerId('linear', '123')).toBe(false);
  });

  it('validates jira ids', () => {
    expect(validateTrackerId('jira', 'PROJ-1234')).toBe(true);
    expect(validateTrackerId('jira', 'proj-1')).toBe(false);
  });

  it('validates azure numeric ids', () => {
    expect(validateTrackerId('azure', '843806')).toBe(true);
    expect(validateTrackerId('azure', 'abc')).toBe(false);
  });
});

describe('trackerIdForFilename', () => {
  it('strips github org/repo prefix', () => {
    expect(trackerIdForFilename('github', 'my-org/my-repo#42')).toBe('42');
    expect(trackerIdForFilename('github', '42')).toBe('42');
  });
  it('leaves other types alone', () => {
    expect(trackerIdForFilename('linear', 'ENG-123')).toBe('ENG-123');
    expect(trackerIdForFilename('azure', '843806')).toBe('843806');
  });
});
