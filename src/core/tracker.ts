import type { TrackerType } from './config.js';

const VALIDATORS: Record<Exclude<TrackerType, 'none'>, RegExp> = {
  github: /^(?:[\w.-]+\/[\w.-]+#)?\d+$/,
  linear: /^[A-Z][A-Z0-9]+-\d+$/i,
  jira: /^[A-Z][A-Z0-9]+-\d+$/,
  azure: /^\d+$/,
};

export function validateTrackerId(type: TrackerType, id: string): boolean {
  if (type === 'none') return true;
  const pattern = VALIDATORS[type];
  return pattern.test(id);
}

export function trackerIdForFilename(type: TrackerType, id: string): string {
  if (type === 'github') return id.replace(/^[\w.-]+\/[\w.-]+#/, '');
  return id;
}
