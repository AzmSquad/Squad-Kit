import { describe, it, expect } from 'vitest';
import { featurePlace, storyPlace } from '../console-ui/src/lib/send-words.js';

/** The send dialog's words for where each level goes: under its epic, or linked to it where the tracker cannot nest it. */

const NESTS = { epic: 'Epic', feature: 'Feature', story: 'User Story', process: 'Agile' };
const counts = (storiesUnderEpic: number, features: number) => ({ storiesUnderEpic, features: { all: features, new: features, changed: 0, unchanged: 0 } });

describe('send dialog words', () => {
  it('a tracker that nests every level says "under", as before', () => {
    expect(featurePlace(NESTS)).toBe('under its epic');
    expect(storyPlace(NESTS, counts(0, 2))).toBe('under its feature');
    expect(storyPlace(NESTS, counts(2, 0))).toBe('under its epic');
    expect(storyPlace(NESTS, counts(2, 2))).toBe('under its feature or epic');
  });

  it('features linked to their epic, and stories straight under an epic linked to it, are said so', () => {
    expect(featurePlace({ ...NESTS, linked: ['feature'] })).toBe('linked to its epic');
    expect(storyPlace({ ...NESTS, linked: ['feature'] }, counts(2, 2))).toBe('under its feature or epic');
    expect(storyPlace({ ...NESTS, linked: ['story'] }, counts(2, 0))).toBe('linked to its epic');
    expect(storyPlace({ ...NESTS, linked: ['story'] }, counts(2, 2))).toBe('under its feature, or linked to its epic');
    expect(storyPlace({ ...NESTS, linked: ['story'] }, counts(0, 2))).toBe('under its feature');
  });
});
